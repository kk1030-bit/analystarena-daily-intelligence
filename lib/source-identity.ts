import { createHash } from "node:crypto";
import type { RawStory, SourceType } from "./types";

const GENERIC_TRACKING_PARAMS = new Set([
  "_hsenc",
  "_hsmi",
  "dclid",
  "fbclid",
  "gclid",
  "gbraid",
  "hsctatracking",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "rb_clickid",
  "scid",
  "si",
  "spm",
  "ttclid",
  "twclid",
  "vero_conv",
  "vero_id",
  "wbraid",
  "wickedid",
  "yclid",
]);

const X_TRACKING_PARAMS = new Set(["s", "t"]);
const REDDIT_TRACKING_PARAMS = new Set([
  "$deep_link",
  "correlation_id",
  "rdt_cid",
  "ref_campaign",
  "ref_content",
  "ref_source",
  "share_id",
]);

type NativeIdentityKind = "x-status" | "reddit-post" | "sec-accession" | "feed-native";

export interface SourceIdentityInput {
  url: string;
  sourceType: SourceType;
  source: string;
  nativeId?: string;
  feedNamespace?: string;
}

export interface SourceIdentity {
  sourceDocumentId: string;
  nativeId?: string;
  canonicalUrl: string;
  aliasKeys: string[];
}

interface NativeIdentity {
  kind: NativeIdentityKind;
  value: string;
  namespace?: string;
}

/** Returns the lowercase, 64-character SHA-256 digest of the exact input bytes. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hashes source content without lossy whitespace or case normalization. */
export function hashSourceContent(content: string | Uint8Array): string {
  return sha256Hex(content);
}

function normalizedHostname(hostname: string): string {
  const host = hostname.toLowerCase();

  if (["twitter.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com"].includes(host)) {
    return "x.com";
  }

  if (["x.com", "www.x.com", "mobile.x.com", "m.x.com"].includes(host)) {
    return "x.com";
  }

  if (["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(host)) {
    return "www.reddit.com";
  }

  return host;
}

function isTrackingParam(name: string, hostname: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith("utm_") || GENERIC_TRACKING_PARAMS.has(lowerName)) return true;
  if (hostname === "x.com" && X_TRACKING_PARAMS.has(lowerName)) return true;
  if (hostname === "www.reddit.com" && REDDIT_TRACKING_PARAMS.has(lowerName)) return true;
  return false;
}

/**
 * Produces an identity-safe URL. Only scheme and host are case-normalized.
 * Path case and non-tracking query parameters are intentionally preserved,
 * because either may change the resource selected by the publisher.
 */
export function canonicalizeSourceUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TypeError(`Invalid source URL: ${input}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Source URL must use HTTP or HTTPS: ${input}`);
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = normalizedHostname(url.hostname);
  url.hash = "";
  url.username = "";
  url.password = "";

  const retainedParams = [...url.searchParams.entries()].filter(
    ([name]) => !isTrackingParam(name, url.hostname),
  );
  retainedParams.sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? -1 : 1;
  });
  url.search = "";
  for (const [name, value] of retainedParams) url.searchParams.append(name, value);

  return url.toString();
}

function extractXStatusId(url: URL): string | undefined {
  if (normalizedHostname(url.hostname) !== "x.com") return undefined;
  return url.pathname.match(/\/(?:status|statuses)\/(\d+)(?:\/|$)/i)?.[1];
}

function extractRedditPostId(url: URL): string | undefined {
  const host = normalizedHostname(url.hostname);
  if (host === "redd.it") return url.pathname.match(/^\/([a-z0-9]+)(?:\/|$)/i)?.[1]?.toLowerCase();
  if (host !== "www.reddit.com") return undefined;
  return url.pathname
    .match(/\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i)?.[1]
    ?.toLowerCase();
}

function extractSecAccession(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  if (host !== "sec.gov" && !host.endsWith(".sec.gov")) return undefined;

  let searchable = `${url.pathname}${url.search}`;
  try {
    searchable = decodeURIComponent(searchable);
  } catch {
    // A malformed escape elsewhere in the URL must not hide a valid accession.
  }

  const hyphenated = searchable.match(/(?:^|\D)(\d{10})-(\d{2})-(\d{6})(?:\D|$)/);
  if (hyphenated) return `${hyphenated[1]}-${hyphenated[2]}-${hyphenated[3]}`;

  const compact = searchable.match(/(?:^|\D)(\d{10})(\d{2})(\d{6})(?:\D|$)/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return undefined;
}

function deriveNativeIdentity(
  url: URL,
  nativeId: string | undefined,
  feedNamespace: string | undefined,
  source: string,
): NativeIdentity | undefined {
  const xStatusId = extractXStatusId(url);
  if (xStatusId) return { kind: "x-status", value: xStatusId };

  const redditPostId = extractRedditPostId(url);
  if (redditPostId) return { kind: "reddit-post", value: redditPostId };

  const secAccession = extractSecAccession(url);
  if (secAccession) return { kind: "sec-accession", value: secAccession };

  const explicitNativeId = nativeId?.trim();
  if (!explicitNativeId) return undefined;
  return {
    kind: "feed-native",
    value: explicitNativeId,
    namespace: feedNamespace?.trim() || source.trim() || "unknown-feed",
  };
}

function nativeAliasKey(identity: NativeIdentity): string {
  switch (identity.kind) {
    case "x-status":
      return `x:status:${identity.value}`;
    case "reddit-post":
      return `reddit:post:${identity.value}`;
    case "sec-accession":
      return `sec:accession:${identity.value}`;
    case "feed-native":
      return `feed:${identity.namespace}:${identity.value}`;
  }
}

/**
 * Derives a stable document ID from a publisher-native identifier when one is
 * available, otherwise from the canonical URL. Display labels never determine
 * identity; changing a source name therefore cannot fork the same document.
 */
export function deriveSourceIdentity(input: SourceIdentityInput): SourceIdentity {
  const canonicalUrl = canonicalizeSourceUrl(input.url);
  const parsedUrl = new URL(canonicalUrl);
  const nativeIdentity = deriveNativeIdentity(
    parsedUrl,
    input.nativeId,
    input.feedNamespace,
    input.source,
  );
  const urlAlias = `url:${canonicalUrl}`;
  const aliasKeys = nativeIdentity ? [nativeAliasKey(nativeIdentity), urlAlias] : [urlAlias];
  const identityMaterial = nativeIdentity
    ? ["source-document", 1, nativeIdentity.kind, nativeIdentity.namespace ?? "", nativeIdentity.value]
    : ["source-document", 1, "canonical-url", canonicalUrl];

  return {
    sourceDocumentId: `sd_${sha256Hex(JSON.stringify(identityMaterial))}`,
    nativeId: nativeIdentity?.value,
    canonicalUrl,
    aliasKeys: [...new Set(aliasKeys)],
  };
}

function collectedAtBounds(story: RawStory): {
  firstCollectedAt?: string;
  lastCollectedAt?: string;
} {
  const values = [story.firstCollectedAt, story.collectedAt, story.lastCollectedAt]
    .filter((value): value is string => Boolean(value?.trim()));
  if (!values.length) return {};

  const chronological = [...values].sort((left, right) => {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return {
    firstCollectedAt: chronological[0],
    lastCollectedAt: chronological.at(-1),
  };
}

/**
 * Enriches a collected story without destroying its raw text or raw URL.
 * The document ID is publisher-native where possible, so translated titles,
 * tracking parameters, or a changed Reddit/X display slug cannot fork it.
 */
export function ensureRawStoryIdentity(story: RawStory): RawStory {
  const identity = deriveSourceIdentity({
    url: story.url,
    sourceType: story.sourceType,
    source: story.source,
    nativeId: story.nativeId,
    feedNamespace: story.feedNamespace,
  });
  const originalTitle = story.originalTitle ?? story.title;
  const originalDescription = story.originalDescription ?? story.description;
  const collectedBounds = collectedAtBounds(story);
  // A collector-provided capture hash represents the exact scope it claims to
  // have captured (feed entry, social post, detail page, or PDF). Falling back
  // to the legacy title/description material keeps old callers compatible, but
  // must never be described as a full-page hash.
  const contentHash = story.capture?.capturedContentHash ?? hashSourceContent(JSON.stringify([
    "source-content",
    1,
    "legacy_title_description",
    originalTitle,
    originalDescription,
  ]));
  const evidence = story.evidence?.map((item) => ({
    ...item,
    sourceDocumentId: identity.sourceDocumentId,
  }));

  return {
    ...story,
    id: identity.sourceDocumentId,
    sourceDocumentId: identity.sourceDocumentId,
    nativeId: identity.nativeId,
    canonicalUrl: identity.canonicalUrl,
    originalTitle,
    originalDescription,
    originalPublishedAt: story.originalPublishedAt !== undefined
      ? story.originalPublishedAt
      : story.timestampKind === "collected" ? null : story.publishedAt,
    capture: story.capture ? {
      ...story.capture,
      canonicalUrl: identity.canonicalUrl,
    } : undefined,
    evidence,
    ...collectedBounds,
    contentHash,
  };
}
