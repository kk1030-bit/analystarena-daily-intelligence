import { unstable_cache } from "next/cache";
import { buildLiveBrief } from "./pipeline";
import type { DailyBrief } from "./types";

declare global {
  var __analystArenaLiveBriefInflight: Map<string, Promise<DailyBrief>> | undefined;
  var __analystArenaLastLiveBrief: DailyBrief | undefined;
}

const inflight = globalThis.__analystArenaLiveBriefInflight ?? new Map<string, Promise<DailyBrief>>();
globalThis.__analystArenaLiveBriefInflight = inflight;

export const STALE_LIVE_BRIEF_WARNING = "本轮实时来源或翻译暂时不可用，当前保留上一份完整简体中文快照。";

export function hotSearchBatchKey(now = Date.now()): string {
  return String(Math.floor(now / 600_000));
}

export function normalizeHotSearchBatchKey(value?: string): string {
  const current = Number(hotSearchBatchKey());
  if (!value || !/^\d{1,16}$/.test(value)) return String(current);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return String(current);
  const bucket = numeric >= 100_000_000_000 ? Math.floor(numeric / 600_000) : numeric;
  // Public routes may only address the active or immediately previous batch.
  // This keeps shared deep links useful without letting arbitrary query values
  // create unbounded cache keys and trigger repeated collection work.
  return bucket === current || bucket === current - 1 ? String(bucket) : String(current);
}

export function getCachedHotSearchBrief(batchKey?: string): Promise<DailyBrief> {
  const safeBatchKey = normalizeHotSearchBatchKey(batchKey);
  const existing = inflight.get(safeBatchKey);
  if (existing) return existing;

  // Two alternating slots cap persistent cache growth while each slot is still
  // older than the ten-minute revalidation window when it is reused.
  const cacheSlot = String(Number(safeBatchKey) % 2);
  const request = unstable_cache(
    async () => {
      try {
        return await buildLiveBrief({ useAi: false, useBrowserCollectors: false });
      } catch (error) {
        const previous = globalThis.__analystArenaLastLiveBrief;
        if (!previous) throw error;
        return {
          ...structuredClone(previous),
          warning: STALE_LIVE_BRIEF_WARNING,
        };
      }
    },
    ["analystarena-hot-search-v3-zh-cn", cacheSlot],
    { revalidate: 600 },
  )()
    .then((brief) => {
      if (brief.warning !== STALE_LIVE_BRIEF_WARNING) {
        globalThis.__analystArenaLastLiveBrief = structuredClone(brief);
      }
      return brief;
    })
    .finally(() => {
      inflight.delete(safeBatchKey);
    });
  inflight.set(safeBatchKey, request);
  return request;
}
