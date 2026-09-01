import type { RawStory, SourceCapture, SourceEvidence } from "../types";
import {
  assertEvidenceBoundToSourceCapture,
  normalizeSourceEvidence,
  sha256ExactUtf8,
} from "../source-evidence";
import { ensureRawStoryIdentity } from "../source-identity";
import {
  assertPublishedAtRawConsistency,
  requireStrictSourceTimestamp,
} from "../source-time";

const MAX_REMOTE_STORIES = 120;
const MAX_DETAIL_STORIES = 48;
const MAX_CAPTURE_BYTES = 512_000;
const SHA256 = /^[0-9a-f]{64}$/;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new TypeError(`${field} must be a${allowEmpty ? "" : " non-empty"} string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : text(value, field, maxLength, true);
}

function exactHttpUrl(value: unknown, field: string): string {
  const raw = text(value, field, 1_500);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`${field} must be an absolute HTTP(S) URL`);
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)
    || !parsed.hostname || parsed.username || parsed.password) {
    throw new TypeError(`${field} must be an absolute HTTP(S) URL without credentials`);
  }
  return raw;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireStrictSourceTimestamp(text(value, field, 100), field);
}

function originalTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireStrictSourceTimestamp(text(value, field, 100), field);
}

function sha256(value: unknown, field: string): string {
  const digest = text(value, field, 64);
  if (!SHA256.test(digest)) throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  return digest;
}

function remoteCapture(value: unknown, sourceType: "Reddit" | "X"): SourceCapture {
  const input = record(value, "story.capture");
  const expectedScope = sourceType === "Reddit" ? "reddit_post" : "x_post";
  if (input.scope !== expectedScope) throw new TypeError(`story.capture.scope must be ${expectedScope}`);
  if (input.backfillQuality !== "native") throw new TypeError("Remote social captures must be native, not legacy metadata");
  if (input.capturedArtifactEncoding !== "utf8") {
    throw new TypeError("story.capture.capturedArtifactEncoding must be utf8");
  }
  const capturedArtifact = text(input.capturedArtifact, "story.capture.capturedArtifact", MAX_CAPTURE_BYTES, true);
  const capturedArtifactSizeBytes = Buffer.byteLength(capturedArtifact, "utf8");
  if (capturedArtifactSizeBytes > MAX_CAPTURE_BYTES) {
    throw new TypeError(`story.capture.capturedArtifact must be at most ${MAX_CAPTURE_BYTES} UTF-8 bytes`);
  }
  if (input.capturedArtifactSizeBytes !== capturedArtifactSizeBytes) {
    throw new TypeError("story.capture.capturedArtifactSizeBytes does not match the exact UTF-8 bytes");
  }
  const capturedContentHash = sha256(input.capturedContentHash, "story.capture.capturedContentHash");
  if (capturedContentHash !== sha256ExactUtf8(capturedArtifact)) {
    throw new TypeError("story.capture.capturedContentHash does not match the exact UTF-8 artifact");
  }
  const originalPublishedAt = originalTimestamp(input.originalPublishedAt, "story.capture.originalPublishedAt");
  const rawUrl = exactHttpUrl(input.rawUrl, "story.capture.rawUrl");
  return {
    rawUrl,
    ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: exactHttpUrl(input.canonicalUrl, "story.capture.canonicalUrl") }),
    ...(input.finalUrl === undefined ? {} : { finalUrl: exactHttpUrl(input.finalUrl, "story.capture.finalUrl") }),
    ...(input.mimeType === undefined ? {} : { mimeType: text(input.mimeType, "story.capture.mimeType", 120) }),
    ...(input.httpStatus === undefined ? {} : {
      httpStatus: Number.isInteger(input.httpStatus) && Number(input.httpStatus) >= 100 && Number(input.httpStatus) <= 599
        ? Number(input.httpStatus)
        : (() => { throw new TypeError("story.capture.httpStatus must be an HTTP status code"); })(),
    }),
    originalPublishedAt,
    ...(input.publishedAtRaw === undefined ? {} : { publishedAtRaw: text(input.publishedAtRaw, "story.capture.publishedAtRaw", 300, true) }),
    ...(input.publishedAtField === undefined ? {} : { publishedAtField: text(input.publishedAtField, "story.capture.publishedAtField", 120) }),
    ...(input.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: optionalTimestamp(input.sourceUpdatedAt, "story.capture.sourceUpdatedAt")! }),
    collectedAt: requireStrictSourceTimestamp(text(input.collectedAt, "story.capture.collectedAt", 100), "story.capture.collectedAt"),
    scope: expectedScope,
    capturedContentHash,
    capturedArtifact,
    capturedArtifactEncoding: "utf8",
    capturedArtifactSizeBytes,
    ...(input.capturedTextHash === undefined ? {} : { capturedTextHash: sha256(input.capturedTextHash, "story.capture.capturedTextHash") }),
    extractionMethod: text(input.extractionMethod, "story.capture.extractionMethod", 160),
    extractorVersion: text(input.extractorVersion, "story.capture.extractorVersion", 160),
    backfillQuality: "native",
  };
}

/**
 * Validates a byte-bound full-text article capture produced by the crawl4ai
 * detail collector. The evidence quotes inside it are later re-verified as
 * exact substrings of this artifact by assertEvidenceBoundToSourceCapture.
 */
function remoteDetailCapture(value: unknown): SourceCapture {
  const input = record(value, "story.capture");
  if (input.scope !== "detail_page") throw new TypeError("story.capture.scope must be detail_page");
  if (input.backfillQuality !== "native") throw new TypeError("Remote detail captures must be native, not legacy metadata");
  if (input.capturedArtifactEncoding !== "utf8") {
    throw new TypeError("story.capture.capturedArtifactEncoding must be utf8");
  }
  const capturedArtifact = text(input.capturedArtifact, "story.capture.capturedArtifact", MAX_CAPTURE_BYTES, true);
  const capturedArtifactSizeBytes = Buffer.byteLength(capturedArtifact, "utf8");
  if (capturedArtifactSizeBytes > MAX_CAPTURE_BYTES) {
    throw new TypeError(`story.capture.capturedArtifact must be at most ${MAX_CAPTURE_BYTES} UTF-8 bytes`);
  }
  if (input.capturedArtifactSizeBytes !== capturedArtifactSizeBytes) {
    throw new TypeError("story.capture.capturedArtifactSizeBytes does not match the exact UTF-8 bytes");
  }
  const capturedContentHash = sha256(input.capturedContentHash, "story.capture.capturedContentHash");
  if (capturedContentHash !== sha256ExactUtf8(capturedArtifact)) {
    throw new TypeError("story.capture.capturedContentHash does not match the exact UTF-8 artifact");
  }
  const originalPublishedAt = originalTimestamp(input.originalPublishedAt, "story.capture.originalPublishedAt");
  const rawUrl = exactHttpUrl(input.rawUrl, "story.capture.rawUrl");
  return {
    rawUrl,
    ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: exactHttpUrl(input.canonicalUrl, "story.capture.canonicalUrl") }),
    ...(input.finalUrl === undefined ? {} : { finalUrl: exactHttpUrl(input.finalUrl, "story.capture.finalUrl") }),
    ...(input.feedUrl === undefined ? {} : { feedUrl: exactHttpUrl(input.feedUrl, "story.capture.feedUrl") }),
    ...(input.mimeType === undefined ? {} : { mimeType: text(input.mimeType, "story.capture.mimeType", 120) }),
    ...(input.httpStatus === undefined ? {} : {
      httpStatus: Number.isInteger(input.httpStatus) && Number(input.httpStatus) >= 100 && Number(input.httpStatus) <= 599
        ? Number(input.httpStatus)
        : (() => { throw new TypeError("story.capture.httpStatus must be an HTTP status code"); })(),
    }),
    originalPublishedAt,
    ...(input.publishedAtRaw === undefined ? {} : { publishedAtRaw: text(input.publishedAtRaw, "story.capture.publishedAtRaw", 300, true) }),
    ...(input.publishedAtField === undefined ? {} : { publishedAtField: text(input.publishedAtField, "story.capture.publishedAtField", 120) }),
    ...(input.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: optionalTimestamp(input.sourceUpdatedAt, "story.capture.sourceUpdatedAt")! }),
    collectedAt: requireStrictSourceTimestamp(text(input.collectedAt, "story.capture.collectedAt", 100), "story.capture.collectedAt"),
    scope: "detail_page",
    capturedContentHash,
    capturedArtifact,
    capturedArtifactEncoding: "utf8",
    capturedArtifactSizeBytes,
    ...(input.capturedTextHash === undefined ? {} : { capturedTextHash: sha256(input.capturedTextHash, "story.capture.capturedTextHash") }),
    extractionMethod: text(input.extractionMethod, "story.capture.extractionMethod", 160),
    extractorVersion: text(input.extractorVersion, "story.capture.extractorVersion", 160),
    backfillQuality: "native",
  };
}

function remoteEvidence(value: unknown): SourceEvidence[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new TypeError("Remote stories must include between one and eight evidence items");
  }
  return value.map((item) => normalizeSourceEvidence(record(item, "story.evidence[]") as unknown as SourceEvidence));
}

/**
 * Accepts only the native, byte-bound records produced by our trusted GitHub
 * Actions collectors: Reddit/X social posts and crawl4ai full-text article
 * pages. Invalid records fail closed instead of being silently downgraded to
 * unverifiable legacy metadata.
 */
export function safeRemoteStories(value: unknown): RawStory[] {
  if (!Array.isArray(value)) return [];
  let detailStories = 0;
  return value.slice(0, MAX_REMOTE_STORIES).map((unknownStory, index) => {
    const input = record(unknownStory, `stories[${index}]`);
    if (input.sourceType !== "Reddit" && input.sourceType !== "X"
      && input.sourceType !== "News" && input.sourceType !== "Official") {
      throw new TypeError(`stories[${index}].sourceType must be Reddit, X, News or Official`);
    }
    const sourceType = input.sourceType;
    let capture: SourceCapture;
    if (sourceType === "Reddit" || sourceType === "X") {
      capture = remoteCapture(input.capture, sourceType);
    } else {
      detailStories += 1;
      if (detailStories > MAX_DETAIL_STORIES) {
        throw new TypeError(`stories[${index}] exceeds the limit of ${MAX_DETAIL_STORIES} detail-page stories per batch`);
      }
      capture = remoteDetailCapture(input.capture);
    }
    const url = exactHttpUrl(input.url, `stories[${index}].url`);
    if (capture.rawUrl !== url) throw new TypeError(`stories[${index}] capture rawUrl must exactly match story.url`);

    const collectedAt = requireStrictSourceTimestamp(
      text(input.collectedAt, `stories[${index}].collectedAt`, 100),
      `stories[${index}].collectedAt`,
    );
    const firstCollectedAt = requireStrictSourceTimestamp(
      text(input.firstCollectedAt, `stories[${index}].firstCollectedAt`, 100),
      `stories[${index}].firstCollectedAt`,
    );
    const lastCollectedAt = requireStrictSourceTimestamp(
      text(input.lastCollectedAt, `stories[${index}].lastCollectedAt`, 100),
      `stories[${index}].lastCollectedAt`,
    );
    if (collectedAt !== lastCollectedAt || capture.collectedAt !== lastCollectedAt || firstCollectedAt > lastCollectedAt) {
      throw new TypeError(`stories[${index}] collection timestamps do not identify one ordered observation`);
    }

    const timestampKind = input.timestampKind;
    if (timestampKind !== "published" && timestampKind !== "collected") {
      throw new TypeError(`stories[${index}].timestampKind must be published or collected`);
    }
    const publishedAt = requireStrictSourceTimestamp(
      text(input.publishedAt, `stories[${index}].publishedAt`, 100),
      `stories[${index}].publishedAt`,
    );
    const originalPublishedAt = originalTimestamp(input.originalPublishedAt, `stories[${index}].originalPublishedAt`);
    if (capture.originalPublishedAt !== originalPublishedAt) {
      throw new TypeError(`stories[${index}] story/capture originalPublishedAt values differ`);
    }
    if (timestampKind === "published" ? (!originalPublishedAt || publishedAt !== originalPublishedAt)
      : (originalPublishedAt !== null || publishedAt !== lastCollectedAt)) {
      throw new TypeError(`stories[${index}] publication timestamp semantics are inconsistent`);
    }
    const publishedAtRaw = optionalText(input.publishedAtRaw, `stories[${index}].publishedAtRaw`, 300);
    const capturePublishedAtRaw = capture.publishedAtRaw;
    if (publishedAtRaw !== undefined && capturePublishedAtRaw !== undefined && publishedAtRaw !== capturePublishedAtRaw) {
      throw new TypeError(`stories[${index}] story/capture publishedAtRaw values differ`);
    }
    assertPublishedAtRawConsistency(capturePublishedAtRaw ?? publishedAtRaw, originalPublishedAt, timestampKind);

    const suppliedSourceDocumentId = text(input.sourceDocumentId, `stories[${index}].sourceDocumentId`, 200);
    const suppliedCanonicalUrl = exactHttpUrl(input.canonicalUrl, `stories[${index}].canonicalUrl`);
    const evidence = remoteEvidence(input.evidence);
    const story = ensureRawStoryIdentity({
      id: text(input.id, `stories[${index}].id`, 1_500),
      sourceDocumentId: suppliedSourceDocumentId,
      ...(input.nativeId === undefined ? {} : { nativeId: text(input.nativeId, `stories[${index}].nativeId`, 300) }),
      ...(input.feedNamespace === undefined ? {} : { feedNamespace: text(input.feedNamespace, `stories[${index}].feedNamespace`, 500) }),
      canonicalUrl: suppliedCanonicalUrl,
      title: text(input.title, `stories[${index}].title`, 10_000),
      originalTitle: text(input.originalTitle, `stories[${index}].originalTitle`, 10_000, true),
      description: text(input.description, `stories[${index}].description`, 50_000, true),
      originalDescription: text(input.originalDescription, `stories[${index}].originalDescription`, 50_000, true),
      url,
      publishedAt,
      originalPublishedAt,
      ...(publishedAtRaw === undefined ? {} : { publishedAtRaw }),
      ...(input.publishedAtField === undefined ? {} : { publishedAtField: text(input.publishedAtField, `stories[${index}].publishedAtField`, 120) }),
      source: text(input.source, `stories[${index}].source`, 160),
      sourceType,
      engagement: Math.max(0, Math.min(1_000_000_000, Number(input.engagement) || 0)),
      collectedAt,
      firstCollectedAt,
      lastCollectedAt,
      timestampKind,
      capture,
      evidence,
    });
    if (story.sourceDocumentId !== suppliedSourceDocumentId || story.canonicalUrl !== suppliedCanonicalUrl) {
      throw new TypeError(`stories[${index}] supplied source identity is not canonical`);
    }
    if (capture.canonicalUrl !== suppliedCanonicalUrl) {
      throw new TypeError(`stories[${index}] capture canonicalUrl does not match the source identity`);
    }
    if (input.contentHash !== undefined && input.contentHash !== story.contentHash) {
      throw new TypeError(`stories[${index}].contentHash does not match the native captured bytes`);
    }
    assertEvidenceBoundToSourceCapture(story, story.capture!);
    return story;
  });
}
