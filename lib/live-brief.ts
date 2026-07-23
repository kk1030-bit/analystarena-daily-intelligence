import {
  getBriefByDate,
  getLatestPublished,
  persistBriefObservation,
  saveDraft,
  storageMode,
  type PersistBriefOptions,
} from "./db";
import { buildLiveBrief, type BuildBriefOptions } from "./pipeline";
import type { DailyBrief } from "./types";

export type LiveBriefFallback = "none" | "draft" | "published";

export interface LiveBriefResult {
  brief: DailyBrief;
  fallback: LiveBriefFallback;
  errorCode?: "LIVE_BRIEF_COLLECTION_FAILED";
}

declare global {
  var __analystArenaLiveBriefCache: Map<string, LiveBriefCacheEntry> | undefined;
}

interface LiveBriefCacheEntry {
  promise: Promise<LiveBriefResult>;
  expiresAt: number;
}

const liveCache = globalThis.__analystArenaLiveBriefCache ?? new Map<string, LiveBriefCacheEntry>();
globalThis.__analystArenaLiveBriefCache = liveCache;

const TEN_MINUTES_MS = 600_000;
// A public manual refresh can bypass the ten-minute dashboard snapshot, but all
// callers share one collection per two-minute window. The key is derived only
// from server time and uses a fixed slot ring, so callers cannot create
// unbounded cache entries or amplify upstream collector traffic.
export const MANUAL_REFRESH_WINDOW_MS = 120_000;
// Include the current bucket plus enough previous buckets to keep links stable
// for the full ten-minute interval between dashboard refreshes.
const MANUAL_CONTEXT_BUCKETS = Math.ceil(TEN_MINUTES_MS / MANUAL_REFRESH_WINDOW_MS) + 1;
const MANUAL_CACHE_SLOTS = MANUAL_CONTEXT_BUCKETS;
const MANUAL_SNAPSHOT_TTL_SECONDS = TEN_MINUTES_MS / 1_000;
export const STALE_LIVE_BRIEF_WARNING = "实时采集暂时失败，当前显示数据库中最近可用的日报。";

function mergeWarnings(...warnings: Array<string | undefined>): string | undefined {
  const unique = [...new Set(warnings.map((warning) => warning?.trim()).filter((warning): warning is string => Boolean(warning)))];
  return unique.join(" ") || undefined;
}

export function hotSearchBatchKey(now = Date.now()): string {
  return String(Math.floor(now / TEN_MINUTES_MS));
}

export function manualRefreshBatchKey(now = Date.now()): string {
  return String(Math.floor(now / MANUAL_REFRESH_WINDOW_MS));
}

export function manualRefreshContextKey(now = Date.now()): string {
  return `manual:${manualRefreshBatchKey(now)}`;
}

export function normalizeHotSearchBatchKey(value?: string): string {
  const current = Number(hotSearchBatchKey());
  if (!value || !/^\d{1,16}$/.test(value)) return String(current);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return String(current);
  const bucket = numeric >= 100_000_000_000 ? Math.floor(numeric / TEN_MINUTES_MS) : numeric;
  // Public routes may only address the active or immediately previous batch.
  // This keeps shared deep links useful without letting arbitrary query values
  // create unbounded cache keys and trigger repeated collection work.
  return bucket === current || bucket === current - 1 ? String(bucket) : String(current);
}

function normalizeManualRefreshBatchKey(value?: string): string {
  const current = Number(manualRefreshBatchKey());
  if (!value || !/^\d{1,16}$/.test(value)) return String(current);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return String(current);
  const bucket = numeric >= 100_000_000_000 ? Math.floor(numeric / MANUAL_REFRESH_WINDOW_MS) : numeric;
  return bucket <= current && bucket >= current - (MANUAL_CONTEXT_BUCKETS - 1) ? String(bucket) : String(current);
}

export interface LiveBriefContext {
  kind: "shared" | "manual";
  batchKey: string;
  contextKey: string;
}

export function normalizeLiveBriefContext(value?: string): LiveBriefContext {
  const manualMatch = value?.match(/^manual:(\d{1,16})$/);
  if (manualMatch) {
    const batchKey = normalizeManualRefreshBatchKey(manualMatch[1]);
    return { kind: "manual", batchKey, contextKey: `manual:${batchKey}` };
  }
  const batchKey = normalizeHotSearchBatchKey(value);
  return { kind: "shared", batchKey, contextKey: batchKey };
}

async function getPersistentFallback(): Promise<LiveBriefResult | null> {
  // Production fallback must survive process restarts and instance changes.
  // Do not silently substitute the development-only in-memory database or an
  // unreviewed draft on an anonymous investor-facing preview.
  if (storageMode() !== "postgres") return null;

  const published = await getLatestPublished().catch(() => null);
  if (!published) return null;
  return {
    brief: {
      ...structuredClone(published.brief),
      warning: mergeWarnings(published.brief.warning, STALE_LIVE_BRIEF_WARNING),
    },
    fallback: "published",
    errorCode: "LIVE_BRIEF_COLLECTION_FAILED",
  };
}

export async function buildFreshLiveBrief(
  options: BuildBriefOptions = { useAi: false, useBrowserCollectors: false },
  persistence: PersistBriefOptions = { stream: "unspecified" },
): Promise<LiveBriefResult> {
  try {
    let brief = await buildLiveBrief({ ...options, strictTranslation: false });
    try {
      const existing = await getBriefByDate(brief.date);
      if (!existing || existing.status === "draft") {
        const saved = await saveDraft(brief, persistence);
        brief = saved.brief;
      } else {
        const snapshot = await persistBriefObservation(brief, persistence);
        brief = {
          ...snapshot.brief,
          warning: mergeWarnings(snapshot.brief.warning, "今日正式日报已经发布；本次市场刷新已另存为不可变快照，不会改写已发布内容。"),
        };
      }
    } catch (error) {
      console.error("Unable to persist live brief snapshot", error);
      throw error;
    }
    return { brief, fallback: "none" };
  } catch (error) {
    const persisted = await getPersistentFallback();
    if (persisted) return persisted;
    throw error;
  }
}

function getCachedResult(
  kind: "shared" | "manual",
  batchKey: string,
  ttlSeconds: number,
): Promise<LiveBriefResult> {
  const requestKey = `${kind}:${batchKey}`;
  const now = Date.now();
  const existing = liveCache.get(requestKey);
  if (existing && existing.expiresAt > now) return existing.promise;
  if (existing) liveCache.delete(requestKey);

  // Exact batch keys prevent an expired cache slot from returning old content
  // under a new batch label. The map only retains addressable public contexts.
  const request = buildFreshLiveBrief(
    { useAi: false, useBrowserCollectors: false },
    { stream: kind, batchKey: `${kind}:${batchKey}` },
  );
  const cacheEntry: LiveBriefCacheEntry = { promise: request, expiresAt: Number.POSITIVE_INFINITY };
  liveCache.set(requestKey, cacheEntry);

  const limit = kind === "manual" ? MANUAL_CACHE_SLOTS : 2;
  const family = [...liveCache.keys()]
    .filter((key) => key.startsWith(`${kind}:`))
    .sort((left, right) => Number(right.slice(right.indexOf(":") + 1)) - Number(left.slice(left.indexOf(":") + 1)));
  for (const staleKey of family.slice(limit)) liveCache.delete(staleKey);

  void request.then(
    () => {
      if (liveCache.get(requestKey) === cacheEntry) cacheEntry.expiresAt = Date.now() + ttlSeconds * 1_000;
    },
    () => {
      if (liveCache.get(requestKey) === cacheEntry) liveCache.delete(requestKey);
    },
  );
  return request;
}

export function getCachedHotSearchResult(batchKey?: string): Promise<LiveBriefResult> {
  const safeBatchKey = normalizeHotSearchBatchKey(batchKey);
  return getCachedResult("shared", safeBatchKey, TEN_MINUTES_MS / 1_000);
}

export async function getCachedHotSearchBrief(batchKey?: string): Promise<DailyBrief> {
  return (await getCachedHotSearchResult(batchKey)).brief;
}

export function getForcedHotSearchResult(now = Date.now()): Promise<LiveBriefResult> {
  return getCachedResult("manual", manualRefreshBatchKey(now), MANUAL_SNAPSHOT_TTL_SECONDS);
}

export function getLiveBriefContextResult(value?: string): Promise<LiveBriefResult> {
  const context = normalizeLiveBriefContext(value);
  return getCachedResult(
    context.kind,
    context.batchKey,
    context.kind === "manual" ? MANUAL_SNAPSHOT_TTL_SECONDS : TEN_MINUTES_MS / 1_000,
  );
}

export async function getLiveBriefContextBrief(value?: string): Promise<DailyBrief> {
  return (await getLiveBriefContextResult(value)).brief;
}
