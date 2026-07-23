import { canonicalizeSourceUrl } from "./source-identity";
import { canonicalEvidenceJson, sha256ExactUtf8 } from "./source-evidence";
import type {
  BriefRecord,
  DailyBrief,
  EvidenceRetractionRequest,
  Headline,
  SourceLink,
} from "./types";

export interface SemanticClusterCorrectionAuthorization {
  confirmed: boolean;
  reason: string;
  expectedPublishedBriefId: string;
  expectedPublishedSnapshotId: string;
  expectedPublishedPayloadHash: string;
}

export type SemanticClusterCorrectionErrorCode =
  | "CORRECTION_CONFIRMATION_REQUIRED"
  | "CORRECTION_REASON_REQUIRED"
  | "PUBLISHED_AUTHORITY_REQUIRED"
  | "STALE_PUBLISHED_BRIEF"
  | "STALE_PUBLISHED_SNAPSHOT"
  | "STALE_PUBLISHED_PAYLOAD"
  | "CORRECTION_DATE_MISMATCH"
  | "PRIMARY_SOURCE_REQUIRED"
  | "AMBIGUOUS_PRIMARY_SOURCE"
  | "DUPLICATE_PRIMARY_MATCH"
  | "PUBLISHED_EVENT_VERSION_REQUIRED"
  | "UNVERSIONED_SECONDARY_EVIDENCE"
  | "CORRECTION_NO_RETRACTIONS"
  | "STALE_EVENT_VERSION";

export class SemanticClusterCorrectionError extends Error {
  constructor(
    readonly code: SemanticClusterCorrectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SemanticClusterCorrectionError";
  }
}

function fail(code: SemanticClusterCorrectionErrorCode, message: string): never {
  throw new SemanticClusterCorrectionError(code, message);
}

function sourceIdentityKeys(source: SourceLink): Set<string> {
  const keys = new Set<string>();
  if (source.sourceDocumentId?.trim()) keys.add(`document:${source.sourceDocumentId.trim()}`);
  try {
    keys.add(`url:${canonicalizeSourceUrl(source.canonicalUrl || source.url)}`);
  } catch {
    // A versioned document identity remains sufficient. Invalid URLs without a
    // document ID deliberately produce no identity key and therefore no match.
  }
  return keys;
}

function sameSourceIdentity(left: SourceLink, right: SourceLink): boolean {
  const leftKeys = sourceIdentityKeys(left);
  const rightKeys = sourceIdentityKeys(right);
  return [...leftKeys].some((key) => rightKeys.has(key));
}

function exactPrimary(headline: Headline, context: string): SourceLink {
  const primary = headline.sources.filter((source) => source.role === "primary");
  if (!primary.length) {
    fail("PRIMARY_SOURCE_REQUIRED", `${context} 缺少明确 primary source，禁止推测事件身份`);
  }
  if (primary.length !== 1) {
    fail("AMBIGUOUS_PRIMARY_SOURCE", `${context} 存在 ${primary.length} 个 primary sources，禁止自动更正`);
  }
  if (!sourceIdentityKeys(primary[0]).size) {
    fail("PRIMARY_SOURCE_REQUIRED", `${context} 的 primary source 缺少可验证的文件或网址身份`);
  }
  return primary[0];
}

function validateAuthority(
  published: BriefRecord,
  live: DailyBrief,
  authorization: SemanticClusterCorrectionAuthorization,
): { snapshotId: string; payloadHash: string; reason: string } {
  if (authorization.confirmed !== true) {
    fail("CORRECTION_CONFIRMATION_REQUIRED", "必须明确确认本次语义聚类证据更正");
  }
  const reason = authorization.reason?.trim();
  if (!reason) fail("CORRECTION_REASON_REQUIRED", "语义聚类证据更正必须填写明确原因");
  if (published.status !== "published") {
    fail("PUBLISHED_AUTHORITY_REQUIRED", "更正基线必须是当前正式发布的日报");
  }
  const snapshotId = published.brief.snapshot?.id;
  const payloadHash = published.brief.snapshot?.payloadHash;
  if (!snapshotId || !payloadHash) {
    fail("PUBLISHED_AUTHORITY_REQUIRED", "当前正式日报缺少不可变快照或 payload hash");
  }
  if (authorization.expectedPublishedBriefId !== published.id) {
    fail("STALE_PUBLISHED_BRIEF", "预期正式日报 ID 已过期，请重新读取当前正式日报");
  }
  if (authorization.expectedPublishedSnapshotId !== snapshotId) {
    fail("STALE_PUBLISHED_SNAPSHOT", "预期正式日报快照已过期，请重新确认");
  }
  if (authorization.expectedPublishedPayloadHash !== payloadHash) {
    fail("STALE_PUBLISHED_PAYLOAD", "预期正式日报内容哈希已过期，请重新确认");
  }
  if (live.date !== published.date) {
    fail(
      "CORRECTION_DATE_MISMATCH",
      `本次 live brief 日期 ${live.date} 与正式日报日期 ${published.date} 不一致`,
    );
  }
  return { snapshotId, payloadHash, reason };
}

/**
 * Derives only evidence-level retractions required to split sources that were
 * incorrectly attached to an already-published event.
 *
 * The function is intentionally pure and fail-closed:
 * - event identity is established only by one exact primary source;
 * - primary evidence is never selected;
 * - a secondary source is eligible only when the new live event no longer
 *   contains that exact source identity;
 * - every request names one immutable evidence item/version from the exact
 *   published event version.
 */
export function deriveSemanticClusterCorrectionRetractions(
  published: BriefRecord,
  live: DailyBrief,
  authorization: SemanticClusterCorrectionAuthorization,
): EvidenceRetractionRequest[] {
  const authority = validateAuthority(published, live, authorization);
  const publishedEvents = new Map(
    published.brief.snapshot?.events.map((event) => [event.eventId, event]) ?? [],
  );
  const publishedByPrimary = published.brief.headlines.map((headline, index) => ({
    headline,
    primary: exactPrimary(headline, `正式日报第 ${index + 1} 则头条`),
  }));
  const matchedPublishedEvents = new Set<string>();
  const requests: EvidenceRetractionRequest[] = [];
  const requestTargets = new Set<string>();

  for (const [liveIndex, liveHeadline] of live.headlines.entries()) {
    const livePrimary = exactPrimary(liveHeadline, `live brief 第 ${liveIndex + 1} 则头条`);
    const matches = publishedByPrimary.filter(({ primary }) =>
      sameSourceIdentity(primary, livePrimary));
    if (matches.length > 1) {
      fail(
        "AMBIGUOUS_PRIMARY_SOURCE",
        `live brief 头条 ${liveHeadline.id} 同时匹配多个正式事件`,
      );
    }
    if (!matches.length) continue;

    const publishedHeadline = matches[0].headline;
    if (matchedPublishedEvents.has(publishedHeadline.id)) {
      fail(
        "DUPLICATE_PRIMARY_MATCH",
        `多个 live brief 头条重复匹配正式事件 ${publishedHeadline.id}`,
      );
    }
    matchedPublishedEvents.add(publishedHeadline.id);
    const snapshotEvent = publishedEvents.get(publishedHeadline.id);
    if (!snapshotEvent?.eventVersionId) {
      fail(
        "PUBLISHED_EVENT_VERSION_REQUIRED",
        `正式事件 ${publishedHeadline.id} 缺少精确 event version`,
      );
    }

    const liveSources = liveHeadline.sources;
    const removedSecondarySources = publishedHeadline.sources.filter((source) =>
      (source.role === "corroborating" || source.role === "social_signal")
      && !liveSources.some((candidate) => sameSourceIdentity(source, candidate)));

    for (const source of removedSecondarySources) {
      for (const evidence of source.evidence ?? []) {
        if (!evidence.versionId) {
          fail(
            "UNVERSIONED_SECONDARY_EVIDENCE",
            `正式事件 ${publishedHeadline.id} 的旧次要来源 ${source.name} 含有无法精确定位版本的证据`,
          );
        }
        const target = [
          publishedHeadline.id,
          snapshotEvent.eventVersionId,
          evidence.id,
          evidence.versionId,
        ].join("\u0000");
        if (requestTargets.has(target)) continue;
        requestTargets.add(target);
        const requestId = `scr_${sha256ExactUtf8(canonicalEvidenceJson([
          "semantic-cluster-correction",
          1,
          published.id,
          authority.snapshotId,
          authority.payloadHash,
          ...target.split("\u0000"),
        ]))}`;
        requests.push({
          requestId,
          eventId: publishedHeadline.id,
          fromEventVersionId: snapshotEvent.eventVersionId,
          evidenceItemId: evidence.id,
          evidenceVersionId: evidence.versionId,
          reasonCode: "review_rejected",
          reasonNote: `${authority.reason.slice(0, 300)}（管理员确认旧${source.role === "social_signal" ? "社交信号" : "佐证"}来源「${source.name}」不属于当前 primary source 对应事件；精确撤下证据 ${evidence.id} / ${evidence.versionId}。）`,
        });
      }
    }
  }

  return requests.sort((left, right) =>
    left.eventId.localeCompare(right.eventId)
    || left.evidenceItemId.localeCompare(right.evidenceItemId)
    || left.evidenceVersionId.localeCompare(right.evidenceVersionId));
}

/**
 * Revalidates the event-version authority immediately before persistence.
 * `saveDraft` performs the same exact predecessor check transactionally; this
 * earlier guard produces a stable, actionable error instead of attempting a
 * stale administrator correction.
 */
export function assertSemanticClusterCorrectionVersionsCurrent(
  requests: EvidenceRetractionRequest[],
  latestVersionIdByEvent: ReadonlyMap<string, string | undefined>,
): void {
  if (!requests.length) {
    fail(
      "CORRECTION_NO_RETRACTIONS",
      "本次 live brief 没有可精确撤下的旧次要来源证据，未建立更正草稿",
    );
  }
  const expectedByEvent = new Map<string, string>();
  for (const request of requests) {
    const existing = expectedByEvent.get(request.eventId);
    if (existing && existing !== request.fromEventVersionId) {
      fail(
        "STALE_EVENT_VERSION",
        `事件 ${request.eventId} 的更正请求包含不一致的 predecessor versions`,
      );
    }
    expectedByEvent.set(request.eventId, request.fromEventVersionId);
  }
  for (const [eventId, expectedVersionId] of expectedByEvent) {
    const latestVersionId = latestVersionIdByEvent.get(eventId);
    if (!latestVersionId || latestVersionId !== expectedVersionId) {
      fail(
        "STALE_EVENT_VERSION",
        `事件 ${eventId} 的 latest version 已不是正式快照版本 ${expectedVersionId}，请重新采集并确认`,
      );
    }
  }
}
