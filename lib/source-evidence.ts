import { createHash } from "node:crypto";
import { parseStrictSourceTimestamp } from "./source-time";
import type {
  ClaimType,
  ClaimVerificationStatus,
  EvidenceCitation,
  EvidenceDirectness,
  EvidenceLocator,
  EvidenceLocatorStatus,
  EvidenceSupportRelation,
  Headline,
  HeadlineClaim,
  RawStory,
  SourceCapture,
  SourceCaptureScope,
  SourceEvidence,
} from "./types";
import { canonicalizeSourceUrl, deriveSourceIdentity } from "./source-identity";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const FEED_FIELDS = new Set(["title", "description", "summary", "content"]);
const UNAVAILABLE_REASONS = new Set([
  "body_not_collected",
  "source_not_resolved",
  "content_not_extracted",
  "legacy_metadata_only",
  "unsupported_content_type",
  "collection_failed",
]);
const LOCATOR_STATUSES = new Set<EvidenceLocatorStatus>(["exact", "derived", "unavailable"]);
const DIRECTNESS_VALUES = new Set<EvidenceDirectness>(["direct", "indirect", "derived", "unavailable"]);
const SUPPORT_RELATIONS = new Set<EvidenceSupportRelation>(["supports", "contradicts", "context"]);
const CLAIM_TYPES = new Set<ClaimType>([
  "title", "summary", "important_information", "market_impact", "direction_rationale", "equity_impact",
]);
const VERIFICATION_STATUSES = new Set<ClaimVerificationStatus>([
  "supported", "partially_supported", "pending_confirmation", "legacy_unverified",
]);
const CLAIM_GENERATORS = new Set<HeadlineClaim["generator"]>([
  "collector", "deterministic", "ai", "review", "legacy",
]);
export const MANUAL_REVIEW_GENERATOR_VERSION = "review-console/manual-semantic-confirmation/v1";
const CAPTURE_SCOPES = new Set<SourceCaptureScope>([
  "rss_entry", "atom_entry", "detail_page", "reddit_post", "x_post", "pdf", "legacy_metadata",
]);

export type SourceEvidenceErrorCode =
  | "INVALID_EVIDENCE_ID"
  | "INVALID_QUOTE_HASH"
  | "INVALID_LOCATOR_HASH"
  | "INVALID_SOURCE_DOCUMENT_ID"
  | "INVALID_ANCHOR_KEY"
  | "INVALID_CAPTURED_AT"
  | "INVALID_CAPTURE_SCOPE"
  | "INVALID_EXTRACTION_METADATA"
  | "INVALID_LOCATOR"
  | "INVALID_LOCATOR_URL"
  | "LOCATOR_SCOPE_MISMATCH"
  | "LOCATOR_STATUS_MISMATCH"
  | "QUOTE_REQUIRED"
  | "QUOTE_NOT_ALLOWED"
  | "QUOTE_LOCATOR_MISMATCH"
  | "EVIDENCE_CAPTURE_MISMATCH"
  | "EVIDENCE_SOURCE_IDENTITY_MISMATCH"
  | "INVALID_CITATION"
  | "INVALID_CLAIM";

export class SourceEvidenceValidationError extends TypeError {
  readonly code: SourceEvidenceErrorCode;

  constructor(code: SourceEvidenceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SourceEvidenceValidationError";
    this.code = code;
  }
}

type JsonPrimitive = string | number | boolean | null;
type CanonicalJson = JsonPrimitive | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalizeJsonValue(value: unknown, seen: Set<object>): CanonicalJson | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") throw new TypeError("Canonical JSON does not support bigint values");
  if (typeof value !== "object") throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  if (seen.has(value)) throw new TypeError("Canonical JSON does not support cyclic objects");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalizeJsonValue(item, seen) ?? null);
    const record = value as Record<string, unknown>;
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(record).sort()) {
      const item = canonicalizeJsonValue(record[key], seen);
      if (item !== undefined) result[key] = item;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Recursively sorted, platform-independent JSON. Array order is preserved. */
export function canonicalEvidenceJson(value: unknown): string {
  const canonical = canonicalizeJsonValue(value, new Set());
  if (canonical === undefined) throw new TypeError("The canonical JSON root cannot be undefined");
  return JSON.stringify(canonical);
}

/** SHA-256 of exact UTF-8 bytes; no whitespace or Unicode normalization. */
export function sha256ExactUtf8(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function fail(code: SourceEvidenceErrorCode, message: string): never {
  throw new SourceEvidenceValidationError(code, message);
}

function requiredText(
  value: unknown,
  field: string,
  code: SourceEvidenceErrorCode = "INVALID_LOCATOR",
): string {
  if (typeof value !== "string" || !value.trim()) fail(code, `${field} must be a non-empty string`);
  return value.trim();
}

function httpUrl(value: unknown, field: string): string {
  const raw = requiredText(value, field, "INVALID_LOCATOR_URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("INVALID_LOCATOR_URL", `${field} is not an absolute URL`);
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) fail("INVALID_LOCATOR_URL", `${field} must use HTTP or HTTPS`);
  if (!parsed.hostname || parsed.username || parsed.password) {
    fail("INVALID_LOCATOR_URL", `${field} must have a host and must not contain credentials`);
  }
  return parsed.toString();
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) fail("INVALID_LOCATOR", `${field} must be a non-negative integer`);
  return Number(value);
}

export function evidenceItemId(sourceDocumentId: string, anchorKey: string): string {
  const documentId = requiredText(sourceDocumentId, "sourceDocumentId", "INVALID_SOURCE_DOCUMENT_ID");
  const anchor = requiredText(anchorKey, "anchorKey", "INVALID_ANCHOR_KEY");
  return `evi_${sha256ExactUtf8(canonicalEvidenceJson(["source-evidence-item", 1, documentId, anchor]))}`;
}

export function normalizeEvidenceLocator(locator: EvidenceLocator): EvidenceLocator {
  if (!locator || typeof locator !== "object") fail("INVALID_LOCATOR", "locator must be an object");
  switch (locator.kind) {
    case "feed_field":
      if (!FEED_FIELDS.has(locator.field)) fail("INVALID_LOCATOR", `Unsupported feed field: ${String(locator.field)}`);
      return {
        kind: "feed_field",
        feedUrl: httpUrl(locator.feedUrl, "locator.feedUrl"),
        ...(locator.entryId === undefined ? {} : { entryId: requiredText(locator.entryId, "locator.entryId") }),
        field: locator.field,
        fieldPath: requiredText(locator.fieldPath, "locator.fieldPath"),
      };
    case "html_text_quote": {
      const exact = locator.textQuote?.exact;
      if (typeof exact !== "string" || !exact.length) fail("INVALID_LOCATOR", "locator.textQuote.exact must not be empty");
      if (locator.blockIndexBasis !== undefined && locator.blockIndex === undefined) {
        fail("INVALID_LOCATOR", "blockIndexBasis requires blockIndex");
      }
      if (locator.blockIndex !== undefined && locator.blockIndexBasis !== "normalized_content_blocks") {
        fail("INVALID_LOCATOR", "blockIndex requires normalized_content_blocks basis");
      }
      return {
        kind: "html_text_quote",
        pageUrl: httpUrl(locator.pageUrl, "locator.pageUrl"),
        ...(locator.selector === undefined ? {} : { selector: requiredText(locator.selector, "locator.selector") }),
        ...(locator.contentRootSelector === undefined ? {} : {
          contentRootSelector: requiredText(locator.contentRootSelector, "locator.contentRootSelector"),
        }),
        textQuote: {
          exact,
          ...(locator.textQuote.prefix === undefined ? {} : { prefix: locator.textQuote.prefix }),
          ...(locator.textQuote.suffix === undefined ? {} : { suffix: locator.textQuote.suffix }),
        },
        ...(locator.blockIndex === undefined ? {} : {
          blockIndex: nonNegativeInteger(locator.blockIndex, "locator.blockIndex"),
          blockIndexBasis: "normalized_content_blocks" as const,
        }),
      };
    }
    case "reddit_post_field":
      if (locator.field !== "title" && locator.field !== "body") {
        fail("INVALID_LOCATOR", `Unsupported Reddit field: ${String((locator as { field?: unknown }).field)}`);
      }
      return {
        kind: "reddit_post_field",
        postId: requiredText(locator.postId, "locator.postId"),
        field: locator.field,
      };
    case "x_post_field": {
      if (locator.field !== "text") {
        fail("INVALID_LOCATOR", `Unsupported X field: ${String((locator as { field?: unknown }).field)}`);
      }
      const statusId = requiredText(locator.statusId, "locator.statusId");
      if (!/^\d+$/.test(statusId)) fail("INVALID_LOCATOR", "locator.statusId must contain only digits");
      return { kind: "x_post_field", statusId, field: "text" };
    }
    case "pdf_text": {
      const pageNumber = nonNegativeInteger(locator.pageNumber, "locator.pageNumber");
      if (pageNumber < 1) fail("INVALID_LOCATOR", "locator.pageNumber is one-based and must be at least 1");
      const startOffset = locator.startOffset === undefined
        ? undefined : nonNegativeInteger(locator.startOffset, "locator.startOffset");
      const endOffset = locator.endOffset === undefined
        ? undefined : nonNegativeInteger(locator.endOffset, "locator.endOffset");
      if (startOffset === undefined && endOffset !== undefined) fail("INVALID_LOCATOR", "endOffset requires startOffset");
      if (startOffset !== undefined && endOffset !== undefined && endOffset < startOffset) {
        fail("INVALID_LOCATOR", "endOffset must not precede startOffset");
      }
      return {
        kind: "pdf_text",
        pdfUrl: httpUrl(locator.pdfUrl, "locator.pdfUrl"),
        pageNumber,
        ...(startOffset === undefined ? {} : { startOffset }),
        ...(endOffset === undefined ? {} : { endOffset }),
      };
    }
    case "unavailable":
      if (!UNAVAILABLE_REASONS.has(locator.reasonCode)) {
        fail("INVALID_LOCATOR", `Unsupported unavailable reason: ${String(locator.reasonCode)}`);
      }
      return {
        kind: "unavailable",
        reasonCode: locator.reasonCode,
        ...(locator.detail === undefined ? {} : { detail: requiredText(locator.detail, "locator.detail") }),
      };
    default:
      return fail("INVALID_LOCATOR", `Unsupported locator kind: ${String((locator as { kind?: unknown }).kind)}`);
  }
}

export function evidenceLocatorHash(locator: EvidenceLocator): string {
  return sha256ExactUtf8(canonicalEvidenceJson(normalizeEvidenceLocator(locator)));
}

function expectedScopeForLocator(locator: EvidenceLocator): SourceCaptureScope[] | undefined {
  switch (locator.kind) {
    case "feed_field": return ["rss_entry", "atom_entry"];
    case "html_text_quote": return ["detail_page"];
    case "reddit_post_field": return ["reddit_post"];
    case "x_post_field": return ["x_post"];
    case "pdf_text": return ["pdf"];
    case "unavailable": return undefined;
  }
}

function normalizedCapturedAt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_CAPTURED_AT", "capturedAt is required");
  const parsed = parseStrictSourceTimestamp(value);
  if (!parsed) {
    fail(
      "INVALID_CAPTURED_AT",
      "capturedAt must contain an explicit timezone and a valid calendar timestamp",
    );
  }
  return parsed;
}

export type SourceEvidenceDraft = Omit<SourceEvidence, "id" | "quoteHash" | "locatorHash"> & {
  id?: string;
  quoteHash?: string;
  locatorHash?: string;
};

/** Validates evidence and treats caller-supplied IDs/hashes as assertions. */
export function createSourceEvidence(input: SourceEvidenceDraft): SourceEvidence {
  const sourceDocumentId = requiredText(input.sourceDocumentId, "sourceDocumentId", "INVALID_SOURCE_DOCUMENT_ID");
  const anchorKey = requiredText(input.anchorKey, "anchorKey", "INVALID_ANCHOR_KEY");
  if (!CAPTURE_SCOPES.has(input.captureScope)) fail("INVALID_CAPTURE_SCOPE", "captureScope is unsupported");
  if (!LOCATOR_STATUSES.has(input.locatorStatus)) fail("LOCATOR_STATUS_MISMATCH", "locatorStatus is unsupported");
  if (!DIRECTNESS_VALUES.has(input.directness)) fail("LOCATOR_STATUS_MISMATCH", "directness is unsupported");
  const locator = normalizeEvidenceLocator(input.locator);
  const expectedScopes = expectedScopeForLocator(locator);
  if (expectedScopes && !expectedScopes.includes(input.captureScope)) {
    fail("LOCATOR_SCOPE_MISMATCH", `${locator.kind} is incompatible with ${input.captureScope}`);
  }
  const unavailable = locator.kind === "unavailable";
  if (unavailable && (input.locatorStatus !== "unavailable" || input.directness !== "unavailable")) {
    fail("LOCATOR_STATUS_MISMATCH", "an unavailable locator requires unavailable status and directness");
  }
  if (!unavailable && (input.locatorStatus === "unavailable" || input.directness === "unavailable")) {
    fail("LOCATOR_STATUS_MISMATCH", "available evidence cannot use unavailable status or directness");
  }
  const quoteOriginal = input.quoteOriginal;
  if (unavailable) {
    if (quoteOriginal !== undefined || input.quoteHash !== undefined
      || input.quoteZhCn !== undefined || input.quoteLanguage !== undefined) {
      fail("QUOTE_NOT_ALLOWED", "unavailable evidence must not contain quote text, translation, language, or hash");
    }
  } else if (typeof quoteOriginal !== "string" || !quoteOriginal.length) {
    fail("QUOTE_REQUIRED", "available evidence requires the exact source quote");
  }
  if (locator.kind === "html_text_quote" && quoteOriginal !== locator.textQuote.exact) {
    fail("QUOTE_LOCATOR_MISMATCH", "quoteOriginal must exactly equal locator.textQuote.exact");
  }
  const id = evidenceItemId(sourceDocumentId, anchorKey);
  if (input.id !== undefined && input.id !== id) {
    fail("INVALID_EVIDENCE_ID", "evidence id does not match sourceDocumentId and anchorKey");
  }
  const quoteHash = quoteOriginal === undefined ? undefined : sha256ExactUtf8(quoteOriginal);
  if (input.quoteHash !== undefined && input.quoteHash !== quoteHash) {
    fail("INVALID_QUOTE_HASH", "quoteHash does not match the exact UTF-8 quote bytes");
  }
  const locatorHash = evidenceLocatorHash(locator);
  if (input.locatorHash !== undefined && input.locatorHash !== locatorHash) {
    fail("INVALID_LOCATOR_HASH", "locatorHash does not match the canonical locator");
  }
  const extractionMethod = requiredText(input.extractionMethod, "extractionMethod", "INVALID_EXTRACTION_METADATA");
  const extractorVersion = requiredText(input.extractorVersion, "extractorVersion", "INVALID_EXTRACTION_METADATA");
  return {
    id,
    ...(input.versionId === undefined ? {} : { versionId: requiredText(input.versionId, "versionId") }),
    sourceDocumentId,
    ...(input.sourceDocumentVersionId === undefined ? {} : {
      sourceDocumentVersionId: requiredText(input.sourceDocumentVersionId, "sourceDocumentVersionId"),
    }),
    anchorKey,
    ...(quoteOriginal === undefined ? {} : { quoteOriginal }),
    ...(quoteHash === undefined ? {} : { quoteHash }),
    ...(input.quoteLanguage === undefined ? {} : { quoteLanguage: requiredText(input.quoteLanguage, "quoteLanguage") }),
    ...(input.quoteZhCn === undefined ? {} : { quoteZhCn: input.quoteZhCn }),
    locator,
    locatorHash,
    locatorStatus: input.locatorStatus,
    directness: input.directness,
    captureScope: input.captureScope,
    extractionMethod,
    extractorVersion,
    capturedAt: normalizedCapturedAt(input.capturedAt),
  };
}

export function normalizeSourceEvidence(input: SourceEvidence): SourceEvidence {
  return createSourceEvidence(input);
}

function sameHttpUrl(left: string, right: string): boolean {
  try {
    return canonicalizeSourceUrl(left) === canonicalizeSourceUrl(right);
  } catch {
    return false;
  }
}

function captureMismatch(message: string): never {
  return fail("EVIDENCE_CAPTURE_MISMATCH", message);
}

function identityMismatch(message: string): never {
  return fail("EVIDENCE_SOURCE_IDENTITY_MISMATCH", message);
}

function capturedJson(artifact: string, scope: SourceCaptureScope): unknown {
  try {
    return JSON.parse(artifact) as unknown;
  } catch {
    return captureMismatch(`${scope} capturedArtifact must be valid JSON for field-level verification`);
  }
}

interface FeedEntryCaptureArtifact {
  schema: "feed-entry-capture/v1";
  feedKind: "rss" | "atom";
  nativeId: string | null;
  url: string;
  titleRaw: string;
  descriptionRaw: string;
  descriptionField: "description" | "summary" | "content";
  publishedAtRaw: string | null;
  publishedAtField: string | null;
  sourceUpdatedAtRaw: string | null;
}

function feedArtifact(value: unknown): FeedEntryCaptureArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return captureMismatch("feed capturedArtifact must be a feed-entry-capture/v1 object");
  }
  const item = value as Record<string, unknown>;
  if (item.schema !== "feed-entry-capture/v1"
    || (item.feedKind !== "rss" && item.feedKind !== "atom")
    || (item.nativeId !== null && typeof item.nativeId !== "string")
    || typeof item.url !== "string"
    || typeof item.titleRaw !== "string"
    || typeof item.descriptionRaw !== "string"
    || !["description", "summary", "content"].includes(String(item.descriptionField))
    || (item.publishedAtRaw !== null && typeof item.publishedAtRaw !== "string")
    || (item.publishedAtField !== null && typeof item.publishedAtField !== "string")
    || (item.sourceUpdatedAtRaw !== null && typeof item.sourceUpdatedAtRaw !== "string")) {
    return captureMismatch("feed capturedArtifact has an invalid or incomplete feed-entry-capture/v1 shape");
  }
  return item as unknown as FeedEntryCaptureArtifact;
}

interface SocialCaptureArtifact {
  scope: "reddit_post" | "x_post";
  rawUrl: string;
  nativeId: string | null;
  publishedAtRaw: string | null;
  publishedAtField: string | null;
  originalPublishedAt: string | null;
  fields: Map<string, string>;
}

function socialArtifact(value: unknown): SocialCaptureArtifact {
  if (!Array.isArray(value) || value.length < 8
    || value[0] !== "social-capture" || value[1] !== 2
    || (value[2] !== "reddit_post" && value[2] !== "x_post")
    || typeof value[3] !== "string"
    || (value[4] !== null && typeof value[4] !== "string")
    || (value[5] !== null && typeof value[5] !== "string")
    || (value[6] !== null && typeof value[6] !== "string")
    || (value[7] !== null && typeof value[7] !== "string")) {
    return captureMismatch("social capturedArtifact has an invalid or incomplete social-capture/v2 shape");
  }
  const fields = new Map<string, string>();
  for (const pair of value.slice(8)) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      return captureMismatch("social capturedArtifact contains an invalid captured field");
    }
    if (fields.has(pair[0])) return captureMismatch(`social capturedArtifact repeats field ${pair[0]}`);
    fields.set(pair[0], pair[1]);
  }
  return {
    scope: value[2],
    rawUrl: value[3],
    nativeId: value[4],
    publishedAtRaw: value[5],
    publishedAtField: value[6],
    originalPublishedAt: value[7],
    fields,
  };
}

function assertCaptureIdentity(story: RawStory, capture: SourceCapture): void {
  if (!story.sourceDocumentId || !story.canonicalUrl) {
    identityMismatch("sourceDocumentId and canonicalUrl are required before evidence verification");
  }
  const identity = deriveSourceIdentity({
    url: capture.rawUrl,
    sourceType: story.sourceType,
    source: story.source,
    nativeId: story.nativeId,
    feedNamespace: story.feedNamespace,
  });
  if (identity.sourceDocumentId !== story.sourceDocumentId) {
    identityMismatch("capture rawUrl/native identity does not derive the story sourceDocumentId");
  }
  if (!capture.canonicalUrl || !sameHttpUrl(capture.canonicalUrl, story.canonicalUrl)) {
    identityMismatch("capture canonicalUrl does not match the story canonicalUrl");
  }
}

function assertEvidenceMetadataBinding(evidence: SourceEvidence, story: RawStory, capture: SourceCapture): void {
  if (evidence.sourceDocumentId !== story.sourceDocumentId) {
    identityMismatch(`evidence ${evidence.anchorKey} belongs to a different source document`);
  }
  if (evidence.captureScope !== capture.scope) {
    captureMismatch(`evidence ${evidence.anchorKey} captureScope does not match its source capture`);
  }
  if (evidence.extractionMethod !== capture.extractionMethod
    || evidence.extractorVersion !== capture.extractorVersion) {
    captureMismatch(`evidence ${evidence.anchorKey} extractor metadata does not match its source capture`);
  }
  if (normalizedCapturedAt(evidence.capturedAt) !== normalizedCapturedAt(capture.collectedAt)) {
    captureMismatch(`evidence ${evidence.anchorKey} capturedAt does not match its source observation`);
  }
}

function assertFeedEvidenceBinding(
  evidence: SourceEvidence,
  story: RawStory,
  capture: SourceCapture,
  artifact: FeedEntryCaptureArtifact,
): void {
  if (capture.scope !== (artifact.feedKind === "rss" ? "rss_entry" : "atom_entry")) {
    captureMismatch("feed artifact kind does not match capture scope");
  }
  if (!capture.feedUrl || !sameHttpUrl(capture.feedUrl, evidence.locator.kind === "feed_field"
    ? evidence.locator.feedUrl : capture.feedUrl)) {
    captureMismatch(`evidence ${evidence.anchorKey} feedUrl does not match its source capture`);
  }
  if (artifact.url !== capture.rawUrl || !sameHttpUrl(artifact.url, story.canonicalUrl!)) {
    identityMismatch("feed artifact URL does not match the capture and canonical source identity");
  }
  const artifactNativeId = artifact.nativeId ?? undefined;
  const exactNativeIdMatch = artifactNativeId === story.nativeId;
  // Reddit's Atom feed preserves the fullname form (`t3_<post-id>`) while
  // canonical source identity intentionally stores the URL-derived post ID
  // without the thing-type prefix. Accept only that provable, Reddit-specific
  // equivalence; every other feed/native-ID mismatch remains fail-closed.
  const redditAtomFullnameMatch = capture.scope === "atom_entry"
    && story.sourceType === "Reddit"
    && Boolean(artifactNativeId)
    && Boolean(story.nativeId)
    && artifactNativeId!.toLowerCase() === `t3_${story.nativeId!.toLowerCase()}`
    && (() => {
      const artifactIdentity = deriveSourceIdentity({
        url: artifact.url,
        sourceType: story.sourceType,
        source: story.source,
        nativeId: artifactNativeId,
        feedNamespace: story.feedNamespace,
      });
      return artifactIdentity.nativeId === story.nativeId
        && artifactIdentity.sourceDocumentId === story.sourceDocumentId;
    })();
  if (!exactNativeIdMatch && !redditAtomFullnameMatch) {
    identityMismatch("feed artifact nativeId does not match the source identity");
  }
  const captureRawTime = capture.publishedAtRaw ?? null;
  const captureRawField = capture.publishedAtField ?? null;
  if (artifact.publishedAtRaw !== captureRawTime || artifact.publishedAtField !== captureRawField) {
    captureMismatch("feed artifact publication metadata does not match its source capture");
  }
  if (evidence.locator.kind === "unavailable") return;
  if (evidence.locator.kind !== "feed_field") {
    captureMismatch(`feed evidence ${evidence.anchorKey} must use a feed_field locator`);
  }
  const expectedEntryId = artifact.nativeId || story.canonicalUrl!;
  if (evidence.locator.entryId !== expectedEntryId) {
    identityMismatch(`feed locator for ${evidence.anchorKey} does not identify the captured entry`);
  }
  const expectedField = evidence.locator.field === "title" ? "title" : artifact.descriptionField;
  if (evidence.locator.field !== expectedField) {
    captureMismatch(`feed locator for ${evidence.anchorKey} does not identify the captured field`);
  }
  const expectedPath = artifact.feedKind === "rss"
    ? evidence.locator.field === "title"
      ? "/rss/channel/item/title"
      : `/rss/channel/item/${artifact.descriptionField === "content" ? "content:encoded" : "description"}`
    : evidence.locator.field === "title"
      ? "/feed/entry/title"
      : `/feed/entry/${artifact.descriptionField}`;
  if (evidence.locator.fieldPath !== expectedPath) {
    captureMismatch(`feed locator path for ${evidence.anchorKey} does not match the captured field path`);
  }
  const capturedQuote = evidence.locator.field === "title" ? artifact.titleRaw : artifact.descriptionRaw;
  if (evidence.quoteOriginal !== capturedQuote) {
    captureMismatch(`evidence quote for ${evidence.anchorKey} is not the exact captured feed field`);
  }
}

function assertSocialEvidenceBinding(
  evidence: SourceEvidence,
  story: RawStory,
  capture: SourceCapture,
  artifact: SocialCaptureArtifact,
): void {
  if (capture.scope !== artifact.scope || artifact.rawUrl !== capture.rawUrl) {
    captureMismatch("social artifact scope/rawUrl does not match its source capture");
  }
  if (!sameHttpUrl(artifact.rawUrl, story.canonicalUrl!)) {
    identityMismatch("social artifact URL does not match the canonical source identity");
  }
  if (artifact.nativeId !== (story.nativeId ?? null)) {
    identityMismatch("social artifact nativeId does not match the source identity");
  }
  if (artifact.publishedAtRaw !== (capture.publishedAtRaw ?? null)
    || artifact.publishedAtField !== (capture.publishedAtField ?? null)
    || artifact.originalPublishedAt !== (capture.originalPublishedAt ?? null)) {
    captureMismatch("social artifact publication metadata does not match its source capture");
  }
  if (evidence.locator.kind === "unavailable") return;
  if (artifact.scope === "reddit_post") {
    if (evidence.locator.kind !== "reddit_post_field") {
      captureMismatch(`Reddit evidence ${evidence.anchorKey} must use a reddit_post_field locator`);
    }
    if (evidence.locator.postId !== artifact.nativeId) {
      identityMismatch(`Reddit locator for ${evidence.anchorKey} does not identify the captured post`);
    }
    if (evidence.quoteOriginal !== artifact.fields.get(evidence.locator.field)) {
      captureMismatch(`evidence quote for ${evidence.anchorKey} is not the exact captured Reddit field`);
    }
  } else {
    if (evidence.locator.kind !== "x_post_field") {
      captureMismatch(`X evidence ${evidence.anchorKey} must use an x_post_field locator`);
    }
    if (evidence.locator.statusId !== artifact.nativeId) {
      identityMismatch(`X locator for ${evidence.anchorKey} does not identify the captured status`);
    }
    if (evidence.quoteOriginal !== artifact.fields.get("text")) {
      captureMismatch(`evidence quote for ${evidence.anchorKey} is not the exact captured X field`);
    }
  }
}

function exactTextQuoteOccurs(artifact: string, exact: string, prefix?: string, suffix?: string): boolean {
  let from = 0;
  while (from <= artifact.length) {
    const index = artifact.indexOf(exact, from);
    if (index < 0) return false;
    const prefixMatches = prefix === undefined || artifact.slice(Math.max(0, index - prefix.length), index) === prefix;
    const suffixMatches = suffix === undefined
      || artifact.slice(index + exact.length, index + exact.length + suffix.length) === suffix;
    if (prefixMatches && suffixMatches) return true;
    from = index + Math.max(1, exact.length);
  }
  return false;
}

interface PdfTextCaptureArtifact {
  schema: "pdf-text-capture/v1";
  url: string;
  pages: Array<{ pageNumber: number; text: string }>;
}

function pdfArtifact(value: unknown): PdfTextCaptureArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return captureMismatch("PDF capturedArtifact must be a pdf-text-capture/v1 object");
  }
  const item = value as Record<string, unknown>;
  if (item.schema !== "pdf-text-capture/v1"
    || typeof item.url !== "string"
    || !Array.isArray(item.pages)
    || item.pages.some((page) => !page
      || typeof page !== "object"
      || Array.isArray(page)
      || !Number.isInteger((page as Record<string, unknown>).pageNumber)
      || Number((page as Record<string, unknown>).pageNumber) < 1
      || typeof (page as Record<string, unknown>).text !== "string")) {
    return captureMismatch("PDF capturedArtifact has an invalid pdf-text-capture/v1 shape");
  }
  const pages = item.pages as Array<{ pageNumber: number; text: string }>;
  if (new Set(pages.map((page) => page.pageNumber)).size !== pages.length) {
    return captureMismatch("PDF capturedArtifact repeats a page number");
  }
  return item as unknown as PdfTextCaptureArtifact;
}

function assertDocumentTextEvidenceBinding(
  evidence: SourceEvidence,
  story: RawStory,
  capture: SourceCapture,
  artifact: string,
): void {
  if (evidence.locator.kind === "unavailable") return;
  if (capture.scope === "detail_page") {
    if (evidence.locator.kind !== "html_text_quote") {
      captureMismatch(`HTML evidence ${evidence.anchorKey} must use an html_text_quote locator`);
    }
    if (!sameHttpUrl(evidence.locator.pageUrl, story.canonicalUrl!)) {
      identityMismatch(`HTML locator for ${evidence.anchorKey} does not identify the captured page`);
    }
    if (evidence.locator.selector !== undefined
      || evidence.locator.contentRootSelector !== undefined
      || evidence.locator.blockIndex !== undefined) {
      captureMismatch(
        `HTML structural locator for ${evidence.anchorKey} is not proven by the visible-text capture; use an exact TextQuote locator`,
      );
    }
    if (evidence.quoteOriginal !== evidence.locator.textQuote.exact
      || !exactTextQuoteOccurs(
        artifact,
        evidence.locator.textQuote.exact,
        evidence.locator.textQuote.prefix,
        evidence.locator.textQuote.suffix,
      )) {
      captureMismatch(`HTML quote for ${evidence.anchorKey} is not present at its claimed capture context`);
    }
    return;
  }
  if (capture.scope === "pdf") {
    const locator = evidence.locator;
    if (locator.kind !== "pdf_text") {
      captureMismatch(`PDF evidence ${evidence.anchorKey} must use a pdf_text locator`);
    }
    const capturedPdf = pdfArtifact(capturedJson(artifact, capture.scope));
    if (!sameHttpUrl(locator.pdfUrl, story.canonicalUrl!)
      || !sameHttpUrl(capturedPdf.url, story.canonicalUrl!)) {
      identityMismatch(`PDF locator for ${evidence.anchorKey} does not identify the captured document`);
    }
    const pageNumber = locator.pageNumber;
    const page = capturedPdf.pages.find((item) => item.pageNumber === pageNumber);
    if (!page) captureMismatch(`PDF locator for ${evidence.anchorKey} identifies a page absent from the capture`);
    if (locator.startOffset !== undefined) {
      const end = locator.endOffset ?? locator.startOffset + (evidence.quoteOriginal?.length ?? 0);
      if (page.text.slice(locator.startOffset, end) !== evidence.quoteOriginal) {
        captureMismatch(`PDF quote for ${evidence.anchorKey} does not match its captured offsets`);
      }
    } else if (!evidence.quoteOriginal || !page.text.includes(evidence.quoteOriginal)) {
      captureMismatch(`PDF quote for ${evidence.anchorKey} is not present on its claimed captured page`);
    }
  }
}

/**
 * Fail-closed binding check between evidence assertions and the immutable bytes
 * actually captured for a source. This must run before source/evidence rows are
 * persisted; evidence that is internally self-consistent is not sufficient.
 */
export function assertEvidenceBoundToSourceCapture(story: RawStory, capture: SourceCapture): void {
  assertCaptureIdentity(story, capture);
  const evidenceItems = story.evidence ?? [];
  if (!evidenceItems.length) return;
  if (capture.capturedArtifact === undefined) {
    captureMismatch("source evidence cannot be verified without capturedArtifact bytes");
  }
  const artifact = capture.capturedArtifact;
  const feed = capture.scope === "rss_entry" || capture.scope === "atom_entry"
    ? feedArtifact(capturedJson(artifact, capture.scope)) : undefined;
  const social = capture.scope === "reddit_post" || capture.scope === "x_post"
    ? socialArtifact(capturedJson(artifact, capture.scope)) : undefined;
  for (const rawEvidence of evidenceItems) {
    const evidence = normalizeSourceEvidence(rawEvidence);
    assertEvidenceMetadataBinding(evidence, story, capture);
    if (feed) assertFeedEvidenceBinding(evidence, story, capture, feed);
    else if (social) assertSocialEvidenceBinding(evidence, story, capture, social);
    else if (capture.scope === "detail_page" || capture.scope === "pdf") {
      assertDocumentTextEvidenceBinding(evidence, story, capture, artifact);
    } else if (capture.scope === "legacy_metadata" && evidence.locator.kind !== "unavailable") {
      captureMismatch("legacy metadata cannot support exact evidence without preserved source bytes");
    }
  }
}

/** Stable source-version material; capture time and translations are excluded. */
export function evidenceVersionMaterialHash(input: SourceEvidence): string {
  const evidence = normalizeSourceEvidence(input);
  return sha256ExactUtf8(canonicalEvidenceJson({
    schema: "source-evidence-version/v1",
    sourceDocumentId: evidence.sourceDocumentId,
    sourceDocumentVersionId: evidence.sourceDocumentVersionId,
    anchorKey: evidence.anchorKey,
    quoteHash: evidence.quoteHash,
    locatorHash: evidence.locatorHash,
    locatorStatus: evidence.locatorStatus,
    directness: evidence.directness,
    captureScope: evidence.captureScope,
    extractionMethod: evidence.extractionMethod,
    extractorVersion: evidence.extractorVersion,
  }));
}

export const sourceEvidenceSignature = evidenceVersionMaterialHash;

export interface EvidenceCitationOptions {
  relation?: EvidenceSupportRelation;
  confidence?: number;
  order?: number;
}

export function createEvidenceCitation(
  evidenceInput: SourceEvidence,
  options: EvidenceCitationOptions = {},
): EvidenceCitation {
  const evidence = normalizeSourceEvidence(evidenceInput);
  const relation = options.relation ?? "supports";
  const confidence = options.confidence ?? 1;
  const order = options.order ?? 0;
  if (!SUPPORT_RELATIONS.has(relation)) fail("INVALID_CITATION", `Unsupported relation: ${String(relation)}`);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail("INVALID_CITATION", "citation confidence must be between 0 and 1");
  }
  if (!Number.isInteger(order) || order < 0) fail("INVALID_CITATION", "citation order must be a non-negative integer");
  if (relation === "supports"
    && (evidence.locatorStatus === "unavailable" || evidence.directness === "unavailable")) {
    fail("INVALID_CITATION", "unavailable evidence cannot be labelled as supporting a claim");
  }
  return { ...evidence, locator: structuredClone(evidence.locator), relation, confidence, order };
}

export type HeadlineClaimDraft = Omit<HeadlineClaim, "id" | "statementHash" | "citations"> & {
  id?: string;
  statementHash?: string;
  citations?: EvidenceCitation[];
};

export function claimId(claimKey: string): string {
  const key = requiredText(claimKey, "claimKey", "INVALID_CLAIM");
  return `clm_${sha256ExactUtf8(canonicalEvidenceJson(["headline-claim", 1, key]))}`;
}

export function claimStatementHash(statement: string): string {
  if (typeof statement !== "string" || !statement.trim()) fail("INVALID_CLAIM", "statement must be non-empty");
  return sha256ExactUtf8(statement);
}

export function createHeadlineClaim(input: HeadlineClaimDraft): HeadlineClaim {
  const claimKey = requiredText(input.claimKey, "claimKey", "INVALID_CLAIM");
  const id = claimId(claimKey);
  if (input.id !== undefined && input.id !== id) fail("INVALID_CLAIM", "claim id does not match claimKey");
  if (!CLAIM_TYPES.has(input.type)) fail("INVALID_CLAIM", `Unsupported claim type: ${String(input.type)}`);
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) fail("INVALID_CLAIM", "claim ordinal must be non-negative");
  if (!VERIFICATION_STATUSES.has(input.verificationStatus)) {
    fail("INVALID_CLAIM", `Unsupported verification status: ${String(input.verificationStatus)}`);
  }
  if (!CLAIM_GENERATORS.has(input.generator)) {
    fail("INVALID_CLAIM", `Unsupported claim generator: ${String(input.generator)}`);
  }
  if (typeof input.statement !== "string" || !input.statement.trim()) {
    fail("INVALID_CLAIM", "statement must be a non-empty string");
  }
  if (input.originalStatement !== undefined
    && (typeof input.originalStatement !== "string" || !input.originalStatement.trim())) {
    fail("INVALID_CLAIM", "originalStatement must be a non-empty string when present");
  }
  // `originalStatement` is the evidence-bearing assertion. `statement` may be
  // its localized display form; translating it must not fork evidence identity.
  const statementHash = claimStatementHash(input.originalStatement ?? input.statement);
  if (input.statementHash !== undefined && input.statementHash !== statementHash) {
    fail("INVALID_CLAIM", "statementHash does not match the exact original assertion bytes");
  }
  const citations = (input.citations ?? []).map((citation) => createEvidenceCitation(citation, citation));
  if (citations.some((citation, index) => citation.order !== index)) {
    fail("INVALID_CLAIM", "citation order must be contiguous and match its array position");
  }
  const hasAvailableSupport = citations.some((citation) => citation.relation === "supports"
    && citation.confidence > 0
    && citation.locatorStatus !== "unavailable"
    && citation.directness !== "unavailable");
  const hasDirectExactSupport = citations.some((citation) => citation.relation === "supports"
    && citation.confidence > 0
    && citation.locatorStatus === "exact"
    && citation.directness === "direct");
  const hasActiveContradiction = citations.some((citation) => citation.relation === "contradicts"
    && citation.confidence > 0
    && citation.locatorStatus !== "unavailable"
    && citation.directness !== "unavailable");
  if ((input.verificationStatus === "supported" || input.verificationStatus === "partially_supported")
    && !hasAvailableSupport) {
    fail("INVALID_CLAIM", `${input.verificationStatus} claims require at least one available supporting citation`);
  }
  if (input.verificationStatus === "supported" && !hasDirectExactSupport) {
    fail("INVALID_CLAIM", "supported claims require at least one direct, exact supporting citation");
  }
  if (input.verificationStatus === "supported" && hasActiveContradiction) {
    fail("INVALID_CLAIM", "a claim with active contradictory evidence cannot be marked supported");
  }
  if (input.generator === "ai" && input.verificationStatus !== "pending_confirmation") {
    fail(
      "INVALID_CLAIM",
      "AI-generated claims require independent semantic verification and must remain pending confirmation",
    );
  }
  if (input.generator === "review"
    && (input.verificationStatus === "supported" || input.verificationStatus === "partially_supported")
    && input.generatorVersion !== MANUAL_REVIEW_GENERATOR_VERSION) {
    fail(
      "INVALID_CLAIM",
      `publishable review claims must use ${MANUAL_REVIEW_GENERATOR_VERSION}`,
    );
  }
  return {
    id,
    claimKey,
    type: input.type,
    ordinal: input.ordinal,
    statement: input.statement,
    ...(input.originalStatement === undefined ? {} : { originalStatement: input.originalStatement }),
    statementHash,
    language: requiredText(input.language, "language", "INVALID_CLAIM"),
    verificationStatus: input.verificationStatus,
    citations,
    generator: input.generator,
    generatorVersion: requiredText(input.generatorVersion, "generatorVersion", "INVALID_CLAIM"),
  };
}

export type HeadlineEvidenceIssueCode =
  | "SOURCE_EVIDENCE_INVALID"
  | "SOURCE_EVIDENCE_SOURCE_DOCUMENT_MISMATCH"
  | "SOURCE_EVIDENCE_SOURCE_VERSION_MISMATCH"
  | "CLAIM_INVALID"
  | "CLAIM_ID_MISMATCH"
  | "CLAIM_STATEMENT_HASH_MISMATCH"
  | "SUPPORTED_CLAIM_WITHOUT_CITATION"
  | "SUPPORTED_CLAIM_WITHOUT_AVAILABLE_SUPPORT"
  | "SUPPORTED_CLAIM_WITHOUT_DIRECT_EXACT_SUPPORT"
  | "SUPPORTED_CLAIM_WITH_CONTRADICTION"
  | "AI_CLAIM_UNVERIFIED"
  | "REVIEW_CONFIRMATION_INVALID"
  | "CITATION_INVALID"
  | "CITATION_EVIDENCE_NOT_FOUND"
  | "CITATION_EVIDENCE_AMBIGUOUS"
  | "CITATION_QUOTE_MISMATCH"
  | "CITATION_QUOTE_HASH_MISMATCH"
  | "CITATION_LOCATOR_MISMATCH"
  | "CITATION_LOCATOR_HASH_MISMATCH"
  | "CITATION_SOURCE_DOCUMENT_MISMATCH"
  | "CITATION_SOURCE_VERSION_MISMATCH"
  | "CITATION_VERSION_MISMATCH"
  | "CITATION_ANCHOR_MISMATCH"
  | "CITATION_PROVENANCE_MISMATCH";

export interface HeadlineEvidenceIssue {
  code: HeadlineEvidenceIssueCode;
  message: string;
  headlineId: string;
  sourceIndex?: number;
  evidenceIndex?: number;
  claimId?: string;
  citationIndex?: number;
}

export interface HeadlineEvidenceValidation {
  valid: boolean;
  issues: HeadlineEvidenceIssue[];
}

function issue(
  headline: Headline,
  code: HeadlineEvidenceIssueCode,
  message: string,
  location: Omit<HeadlineEvidenceIssue, "code" | "message" | "headlineId"> = {},
): HeadlineEvidenceIssue {
  return { code, message, headlineId: headline.id, ...location };
}

/**
 * Verifies that every citation is an exact projection of evidence attached to
 * the headline's sources. It also detects review edits made without rebuilding
 * a claim's statement hash and evidence links.
 */
export function validateHeadlineEvidence(headline: Headline): HeadlineEvidenceValidation {
  const issues: HeadlineEvidenceIssue[] = [];
  const byId = new Map<string, SourceEvidence[]>();

  headline.sources.forEach((source, sourceIndex) => {
    (source.evidence ?? []).forEach((rawEvidence, evidenceIndex) => {
      let evidence: SourceEvidence;
      try {
        evidence = normalizeSourceEvidence(rawEvidence);
      } catch (error) {
        issues.push(issue(
          headline,
          "SOURCE_EVIDENCE_INVALID",
          error instanceof Error ? error.message : "Source evidence is invalid",
          { sourceIndex, evidenceIndex },
        ));
        return;
      }
      if (source.sourceDocumentId !== undefined && source.sourceDocumentId !== evidence.sourceDocumentId) {
        issues.push(issue(
          headline,
          "SOURCE_EVIDENCE_SOURCE_DOCUMENT_MISMATCH",
          "Evidence sourceDocumentId does not match its parent source",
          { sourceIndex, evidenceIndex },
        ));
      }
      if (source.sourceDocumentVersionId !== undefined
        && source.sourceDocumentVersionId !== evidence.sourceDocumentVersionId) {
        issues.push(issue(
          headline,
          "SOURCE_EVIDENCE_SOURCE_VERSION_MISMATCH",
          "Evidence sourceDocumentVersionId does not match its parent source",
          { sourceIndex, evidenceIndex },
        ));
      }
      byId.set(evidence.id, [...(byId.get(evidence.id) ?? []), evidence]);
    });
  });

  for (const claim of headline.claims ?? []) {
    const claimLocation = { claimId: claim.id };
    let expectedClaimId: string | undefined;
    try {
      expectedClaimId = claimId(claim.claimKey);
    } catch (error) {
      issues.push(issue(
        headline,
        "CLAIM_INVALID",
        error instanceof Error ? error.message : "Claim identity is invalid",
        claimLocation,
      ));
    }
    if (expectedClaimId !== undefined && claim.id !== expectedClaimId) {
      issues.push(issue(headline, "CLAIM_ID_MISMATCH", "Claim id does not match claimKey", claimLocation));
    }
    if (typeof claim.statement !== "string" || !claim.statement.trim()) {
      issues.push(issue(headline, "CLAIM_INVALID", "Claim statement must be a non-empty string", claimLocation));
    } else if (claim.originalStatement !== undefined
      && (typeof claim.originalStatement !== "string" || !claim.originalStatement.trim())) {
      issues.push(issue(headline, "CLAIM_INVALID", "Claim originalStatement must be non-empty when present", claimLocation));
    } else if (claim.statementHash !== sha256ExactUtf8(claim.originalStatement ?? claim.statement)) {
      issues.push(issue(
        headline,
        "CLAIM_STATEMENT_HASH_MISMATCH",
        "Claim original assertion changed without rebuilding statementHash and citations",
        claimLocation,
      ));
    }
    if (!CLAIM_TYPES.has(claim.type)
      || !VERIFICATION_STATUSES.has(claim.verificationStatus)
      || !CLAIM_GENERATORS.has(claim.generator)
      || !Number.isInteger(claim.ordinal)
      || claim.ordinal < 0
      || typeof claim.language !== "string"
      || !claim.language.trim()
      || typeof claim.generatorVersion !== "string"
      || !claim.generatorVersion.trim()) {
      issues.push(issue(headline, "CLAIM_INVALID", "Claim metadata is invalid", claimLocation));
    }
    const citations = Array.isArray(claim.citations) ? claim.citations : [];
    if (!Array.isArray(claim.citations)) {
      issues.push(issue(headline, "CLAIM_INVALID", "Claim citations must be an array", claimLocation));
    }
    if (citations.some((citation, index) => citation?.order !== index)) {
      issues.push(issue(
        headline,
        "CLAIM_INVALID",
        "Claim citation order must be contiguous and match its array position",
        claimLocation,
      ));
    }
    if ((claim.verificationStatus === "supported" || claim.verificationStatus === "partially_supported")
      && !citations.length) {
      issues.push(issue(
        headline,
        "SUPPORTED_CLAIM_WITHOUT_CITATION",
        `${claim.verificationStatus} claim has no citation`,
        claimLocation,
      ));
    }
    if ((claim.verificationStatus === "supported" || claim.verificationStatus === "partially_supported")
      && !citations.some((citation) => citation.relation === "supports"
        && citation.confidence > 0
        && citation.locatorStatus !== "unavailable"
        && citation.directness !== "unavailable")) {
      issues.push(issue(
        headline,
        "SUPPORTED_CLAIM_WITHOUT_AVAILABLE_SUPPORT",
        `${claim.verificationStatus} claim has no available supports citation`,
        claimLocation,
      ));
    }
    if (claim.verificationStatus === "supported"
      && !citations.some((citation) => citation.relation === "supports"
        && citation.confidence > 0
        && citation.locatorStatus === "exact"
        && citation.directness === "direct")) {
      issues.push(issue(
        headline,
        "SUPPORTED_CLAIM_WITHOUT_DIRECT_EXACT_SUPPORT",
        "supported claim has no direct, exact supports citation",
        claimLocation,
      ));
    }
    if (claim.verificationStatus === "supported"
      && citations.some((citation) => citation.relation === "contradicts"
        && citation.confidence > 0
        && citation.locatorStatus !== "unavailable"
        && citation.directness !== "unavailable")) {
      issues.push(issue(
        headline,
        "SUPPORTED_CLAIM_WITH_CONTRADICTION",
        "claim has active contradictory evidence and must be partially supported or pending",
        claimLocation,
      ));
    }
    if (claim.generator === "ai" && claim.verificationStatus !== "pending_confirmation") {
      issues.push(issue(
        headline,
        "AI_CLAIM_UNVERIFIED",
        "AI-generated claim is publishable without independent semantic verification",
        claimLocation,
      ));
    }
    if (claim.generator === "review"
      && (claim.verificationStatus === "supported" || claim.verificationStatus === "partially_supported")
      && claim.generatorVersion !== MANUAL_REVIEW_GENERATOR_VERSION) {
      issues.push(issue(
        headline,
        "REVIEW_CONFIRMATION_INVALID",
        "publishable review claim does not carry the manual semantic confirmation generator version",
        claimLocation,
      ));
    }

    citations.forEach((rawCitation, citationIndex) => {
      const location = { claimId: claim.id, citationIndex };
      let citation: EvidenceCitation;
      try {
        citation = createEvidenceCitation(rawCitation, rawCitation);
      } catch (error) {
        issues.push(issue(
          headline,
          "CITATION_INVALID",
          error instanceof Error ? error.message : "Citation is invalid",
          location,
        ));
        return;
      }
      const candidates = byId.get(citation.id) ?? [];
      if (!candidates.length) {
        issues.push(issue(
          headline,
          "CITATION_EVIDENCE_NOT_FOUND",
          `Citation ${citation.id} is not attached to any source`,
          location,
        ));
        return;
      }
      const exactCandidates = candidates.filter((candidate) =>
        sourceEvidenceSignature(candidate) === sourceEvidenceSignature(citation)
        && candidate.id === citation.id
        && candidate.versionId === citation.versionId
        && candidate.sourceDocumentId === citation.sourceDocumentId
        && candidate.sourceDocumentVersionId === citation.sourceDocumentVersionId
        && candidate.anchorKey === citation.anchorKey
        && candidate.quoteOriginal === citation.quoteOriginal
        && candidate.quoteHash === citation.quoteHash
        && candidate.quoteLanguage === citation.quoteLanguage
        && candidate.quoteZhCn === citation.quoteZhCn
        && canonicalEvidenceJson(candidate.locator) === canonicalEvidenceJson(citation.locator)
        && candidate.locatorHash === citation.locatorHash
        && candidate.locatorStatus === citation.locatorStatus
        && candidate.directness === citation.directness
        && candidate.captureScope === citation.captureScope
        && candidate.extractionMethod === citation.extractionMethod
        && candidate.extractorVersion === citation.extractorVersion
        && candidate.capturedAt === citation.capturedAt);
      // The same immutable projection can legitimately be retained on two
      // merged source links; that is duplication, not evidentiary ambiguity.
      if (exactCandidates.length >= 1) return;

      const expected = candidates.find((candidate) =>
        candidate.sourceDocumentVersionId === citation.sourceDocumentVersionId
        && candidate.versionId === citation.versionId) ?? candidates[0];
      if (citation.sourceDocumentId !== expected.sourceDocumentId) {
        issues.push(issue(headline, "CITATION_SOURCE_DOCUMENT_MISMATCH", "Citation sourceDocumentId differs from evidence", location));
      }
      if (citation.sourceDocumentVersionId !== expected.sourceDocumentVersionId) {
        issues.push(issue(headline, "CITATION_SOURCE_VERSION_MISMATCH", "Citation source document version differs from evidence", location));
      }
      if (citation.versionId !== expected.versionId) {
        issues.push(issue(headline, "CITATION_VERSION_MISMATCH", "Citation evidence version differs from evidence", location));
      }
      if (citation.anchorKey !== expected.anchorKey) {
        issues.push(issue(headline, "CITATION_ANCHOR_MISMATCH", "Citation anchorKey differs from evidence", location));
      }
      if (citation.quoteOriginal !== expected.quoteOriginal) {
        issues.push(issue(headline, "CITATION_QUOTE_MISMATCH", "Citation quote differs from source evidence", location));
      }
      if (citation.quoteHash !== expected.quoteHash) {
        issues.push(issue(headline, "CITATION_QUOTE_HASH_MISMATCH", "Citation quoteHash differs from source evidence", location));
      }
      if (canonicalEvidenceJson(citation.locator) !== canonicalEvidenceJson(expected.locator)) {
        issues.push(issue(headline, "CITATION_LOCATOR_MISMATCH", "Citation locator differs from source evidence", location));
      }
      if (citation.locatorHash !== expected.locatorHash) {
        issues.push(issue(headline, "CITATION_LOCATOR_HASH_MISMATCH", "Citation locatorHash differs from source evidence", location));
      }
      if (citation.captureScope !== expected.captureScope
        || citation.locatorStatus !== expected.locatorStatus
        || citation.directness !== expected.directness
        || citation.quoteLanguage !== expected.quoteLanguage
        || citation.quoteZhCn !== expected.quoteZhCn
        || citation.extractionMethod !== expected.extractionMethod
        || citation.extractorVersion !== expected.extractorVersion
        || citation.capturedAt !== expected.capturedAt) {
        issues.push(issue(headline, "CITATION_PROVENANCE_MISMATCH", "Citation capture provenance differs from evidence", location));
      }
    });
  }

  return { valid: issues.length === 0, issues };
}
