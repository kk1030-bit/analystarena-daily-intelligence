import { createHash } from "node:crypto";
import type { EventRecord, Headline, SourceLink } from "./types";
import { canonicalizeSourceUrl } from "./source-identity";

export const EVENT_VERSION_SCHEMA = "event-version/v2";
export const EVENT_IDENTITY_SCHEMA = "event-identity/v1";
export const EVENT_SEMANTIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const genericTickers = new Set([
  "AI",
  "ETF",
  "FOMC",
  "MARKET",
  "MACRO",
  "CRYPTO",
  "EARNINGS",
  "OTHER",
]);

const identityStopWords = new Set([
  "about", "after", "again", "amid", "before", "from", "into", "latest", "market", "markets",
  "more", "new", "news", "over", "report", "reports", "says", "shares", "stock", "stocks", "that",
  "their", "this", "update", "updated", "with", "will", "would",
  "今日", "最新", "市場", "新闻", "新聞", "消息", "表示", "公司", "相关", "相關", "更新",
]);

export interface EventVersionMaterial {
  versionHash: string;
  evidenceHash: string;
  stateHash: string;
  presentationHash: string;
  payload: Record<string, unknown>;
}

export interface SemanticEventCandidate {
  event: EventRecord;
  headline: Headline;
}

export interface SemanticEventMatch {
  candidate?: SemanticEventCandidate;
  confidence: number;
  ambiguous: boolean;
  runnerUpConfidence?: number;
}

export interface EventAlias {
  type: "document" | "url" | "legacy";
  key: string;
  canonicalUrl?: string;
}

function isDocumentLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return false;
    if (/\/(?:search|news|newsroom|newsevents|press-releases?|hot|latest)$/i.test(path)) return false;
    if (/^\/r\/[^/]+$/i.test(path)) return false;
    if ((url.hostname === "x.com" || url.hostname.endsWith(".reddit.com")) && !/\/(?:status|comments)\//i.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function stableHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, " ");
}

export function identityTokens(value: string): Set<string> {
  const normalized = normalizeText(value);
  const result = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []) {
    const clean = token.replace(/^[._-]+|[._-]+$/g, "");
    if (clean.length >= 2 && !identityStopWords.has(clean)) result.add(clean);
  }
  for (const sequence of normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    if (sequence.length <= 8 && !identityStopWords.has(sequence)) result.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const bigram = sequence.slice(index, index + 2);
      if (!identityStopWords.has(bigram)) result.add(bigram);
    }
  }
  return result;
}

function overlap(left: Set<string>, right: Set<string>): { shared: number; containment: number; jaccard: number } {
  if (!left.size || !right.size) return { shared: 0, containment: 0, jaccard: 0 };
  const shared = [...left].filter((token) => right.has(token)).length;
  return {
    shared,
    containment: shared / Math.min(left.size, right.size),
    jaccard: shared / new Set([...left, ...right]).size,
  };
}

function validTime(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function specificTicker(value: string): boolean {
  const ticker = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) && !genericTickers.has(ticker);
}

export function semanticMatchConfidence(incoming: Headline, existing: Headline): number {
  const incomingTime = validTime(incoming.publishedAt);
  const existingTime = validTime(existing.publishedAt);
  if (incomingTime !== undefined && existingTime !== undefined
    && Math.abs(incomingTime - existingTime) > EVENT_SEMANTIC_WINDOW_MS) return 0;

  const incomingOriginalTitles = incoming.sources.map((source) => source.originalTitle ?? "").filter(Boolean).join(" ");
  const existingOriginalTitles = existing.sources.map((source) => source.originalTitle ?? "").filter(Boolean).join(" ");
  const incomingIdentityTitle = incomingOriginalTitles || incoming.title;
  const existingIdentityTitle = existingOriginalTitles || existing.title;
  const title = overlap(identityTokens(incomingIdentityTitle), identityTokens(existingIdentityTitle));
  const incomingBody = `${incomingIdentityTitle} ${incoming.summary} ${(incoming.keyPoints ?? []).join(" ")}`;
  const existingBody = `${existingIdentityTitle} ${existing.summary} ${(existing.keyPoints ?? []).join(" ")}`;
  const body = overlap(identityTokens(incomingBody), identityTokens(existingBody));
  const incomingTicker = incoming.ticker.trim().toUpperCase();
  const existingTicker = existing.ticker.trim().toUpperCase();
  const sameSpecificTicker = incomingTicker === existingTicker && specificTicker(incomingTicker);
  const sameGenericTicker = incomingTicker === existingTicker && !sameSpecificTicker;
  const sameCategory = incoming.category === existing.category;
  const timeScore = incomingTime === undefined || existingTime === undefined
    ? 0
    : Math.max(0, 1 - Math.abs(incomingTime - existingTime) / EVENT_SEMANTIC_WINDOW_MS);

  const score = title.containment * 0.32
    + title.jaccard * 0.16
    + body.containment * 0.2
    + body.jaccard * 0.08
    + (sameSpecificTicker ? 0.14 : sameGenericTicker ? 0.03 : 0)
    + (sameCategory ? 0.06 : 0)
    + timeScore * 0.04;

  const hasSharedIdentity = title.shared >= 2
    || (sameSpecificTicker && (title.shared >= 1 || body.shared >= 3))
    || title.containment >= 0.62
    || body.containment >= 0.62;
  if (!hasSharedIdentity) return 0;
  return Math.max(0, Math.min(1, score));
}

export function findSemanticEvent(
  incoming: Headline,
  candidates: SemanticEventCandidate[],
): SemanticEventMatch {
  const scored = candidates
    .map((candidate) => ({ candidate, confidence: semanticMatchConfidence(incoming, candidate.headline) }))
    .filter((item) => item.confidence >= 0.58)
    .sort((left, right) => right.confidence - left.confidence);
  const best = scored[0];
  const runnerUp = scored[1];
  if (!best) return { confidence: 0, ambiguous: false };
  const ambiguous = Boolean(runnerUp && best.confidence - runnerUp.confidence < 0.12);
  return {
    candidate: ambiguous ? undefined : best.candidate,
    confidence: best.confidence,
    ambiguous,
    runnerUpConfidence: runnerUp?.confidence,
  };
}

export function aliasesForHeadline(headline: Headline): EventAlias[] {
  const aliases: EventAlias[] = [];
  for (const source of headline.sources) {
    const canonicalUrl = source.canonicalUrl || canonicalizeSourceUrl(source.url);
    const strongDocumentIdentity = Boolean(source.nativeId) || isDocumentLikeUrl(canonicalUrl);
    if (source.sourceDocumentId && strongDocumentIdentity) {
      aliases.push({ type: "document", key: source.sourceDocumentId, canonicalUrl });
    }
    if (canonicalUrl && strongDocumentIdentity) aliases.push({ type: "url", key: sha256(canonicalUrl), canonicalUrl });
  }
  if (headline.id && !headline.id.startsWith("evt_")) aliases.push({ type: "legacy", key: headline.id });
  return aliases.filter((alias, index, all) =>
    all.findIndex((candidate) => candidate.type === alias.type && candidate.key === alias.key) === index);
}

function sourceIdentityForVersion(source: SourceLink): Record<string, unknown> {
  const canonicalUrl = source.canonicalUrl || canonicalizeSourceUrl(source.url);
  return {
    sourceDocumentId: source.sourceDocumentId,
    sourceDocumentVersionId: source.sourceDocumentVersionId,
    contentHash: source.contentHash,
    canonicalUrl,
    type: source.type,
    role: source.role,
    timestampKind: source.timestampKind,
    originalPublishedAt: source.originalPublishedAt,
    evidence: [...(source.evidence ?? [])]
      .map((item) => ({
        id: item.id,
        versionId: item.versionId,
        sourceDocumentVersionId: item.sourceDocumentVersionId,
        anchorKey: item.anchorKey,
        quoteHash: item.quoteHash,
        locatorHash: item.locatorHash,
        locatorStatus: item.locatorStatus,
        directness: item.directness,
        captureScope: item.captureScope,
        extractionMethod: item.extractionMethod,
        extractorVersion: item.extractorVersion,
      }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  };
}

function sortedSourceIdentities(sources: SourceLink[]): Array<Record<string, unknown>> {
  return sources
    .map(sourceIdentityForVersion)
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function structuredEquityState(headline: Headline): unknown[] {
  return [...(headline.equityImpacts ?? [])]
    .map((item) => ({
      symbol: item.symbol,
      providerSymbol: item.providerSymbol,
      direction: item.direction,
      relation: item.relation,
      mappingConfidence: item.mappingConfidence,
      directionConfidence: item.directionConfidence,
      evidence: item.evidence.map((evidence) => ({ basis: evidence.basis, weight: evidence.weight })),
      engineVersion: item.engineVersion,
      reviewStatus: item.reviewStatus,
    }))
    .sort((left, right) => `${left.symbol}:${left.direction}`.localeCompare(`${right.symbol}:${right.direction}`));
}

export function eventVersionMaterial(headline: Headline): EventVersionMaterial {
  const evidence = {
    schema: "event-evidence/v2",
    sources: sortedSourceIdentities(headline.sources),
    claims: [...(headline.claims ?? [])]
      .map((claim) => ({
        id: claim.id,
        claimKey: claim.claimKey,
        type: claim.type,
        ordinal: claim.ordinal,
        // `statementHash` is the hash of the untranslated assertion. The
        // localized display sentence is deliberately excluded so a pure
        // translation never creates a false evidence revision.
        statementHash: claim.statementHash,
        verificationStatus: claim.verificationStatus,
        generator: claim.generator,
        generatorVersion: claim.generatorVersion,
        citations: [...claim.citations]
          .map((citation) => ({
            evidenceId: citation.id,
            evidenceVersionId: citation.versionId,
            sourceDocumentId: citation.sourceDocumentId,
            sourceDocumentVersionId: citation.sourceDocumentVersionId,
            quoteHash: citation.quoteHash,
            locatorHash: citation.locatorHash,
            relation: citation.relation,
            directness: citation.directness,
            confidence: citation.confidence,
            order: citation.order,
          }))
          .sort((left, right) => left.order - right.order || canonicalJson(left).localeCompare(canonicalJson(right))),
      }))
      .sort((left, right) => left.ordinal - right.ordinal || left.claimKey.localeCompare(right.claimKey)),
  };
  const state = {
    schema: "event-state/v1",
    ticker: headline.ticker.trim().toUpperCase(),
    category: headline.category,
    marketDirection: headline.marketDirection,
    directionConfidence: headline.directionConfidence,
    impact: headline.impact,
    confidence: headline.confidence,
    sentiment: headline.sentiment,
    equityImpacts: structuredEquityState(headline),
  };
  const presentation = {
    title: headline.title,
    summary: headline.summary,
    keyPoints: headline.keyPoints ?? [],
    marketImpact: headline.marketImpact,
    directionRationale: headline.directionRationale,
    equityNarrative: (headline.equityImpacts ?? []).map((item) => ({
      symbol: item.symbol,
      mechanism: item.mechanism,
      assumptions: item.assumptions,
      counterCase: item.counterCase,
    })),
  };
  const evidenceHash = stableHash(evidence);
  const stateHash = stableHash(state);
  const presentationHash = stableHash(presentation);
  const versionHash = stableHash({ schema: EVENT_VERSION_SCHEMA, evidenceHash, stateHash });
  return {
    versionHash,
    evidenceHash,
    stateHash,
    presentationHash,
    payload: { evidence, state, presentation, headline },
  };
}

export function mergeRetainedEvidence(previous: Headline | undefined, incoming: Headline): Headline {
  if (!previous) return structuredClone(incoming);
  const isManagedPageClaim = (claimKey: string) => claimKey === "title"
    || claimKey === "summary"
    || claimKey === "market_impact"
    || claimKey === "direction_rationale"
    || /^important_information:\d+$/.test(claimKey);
  const sources = [...previous.sources, ...incoming.sources].reduce<SourceLink[]>((result, source) => {
    const documentId = source.sourceDocumentId?.trim() || undefined;
    const canonicalUrl = canonicalizeSourceUrl(source.canonicalUrl || source.url);
    const existingIndex = result.findIndex((candidate) => {
      const candidateDocumentId = candidate.sourceDocumentId?.trim() || undefined;
      const candidateCanonicalUrl = canonicalizeSourceUrl(candidate.canonicalUrl || candidate.url);
      // Source identities can migrate from a legacy URL-derived document id
      // to a native/feed id. Treat either matching alias as the same source so
      // the current version replaces the legacy projection in its old slot.
      return Boolean(documentId && candidateDocumentId && documentId === candidateDocumentId)
        || canonicalUrl === candidateCanonicalUrl;
    });
    if (existingIndex === -1) result.push(structuredClone(source));
    else {
      const retained = result[existingIndex];
      const next = structuredClone(source);
      const retainedHasObservationAuthority = Boolean(
        retained.sourceDocumentId && retained.sourceDocumentVersionId && retained.sourceObservationId,
      );
      const nextHasObservationAuthority = Boolean(
        next.sourceDocumentId && next.sourceDocumentVersionId && next.sourceObservationId,
      );
      // Never let an unversioned legacy alias overwrite a source already
      // bound to an immutable version and collection observation. When both
      // are equally authoritative, the later (incoming) observation wins.
      const preferred = retainedHasObservationAuthority && !nextHasObservationAuthority ? retained : next;
      const fallback = preferred === retained ? next : retained;
      result[existingIndex] = {
        ...fallback,
        ...preferred,
        evidence: preferred.evidence ?? fallback.evidence,
        capture: preferred.capture ?? fallback.capture,
      };
    }
    return result;
  }, []);
  // Preserve the source order recorded by the previous event version. Source
  // order is deliberately excluded from the event-version hash, so sorting a
  // reused projection here could make its displayed ordinals disagree with
  // the immutable `event_version_sources` rows. Existing sources retain their
  // authoritative positions; genuinely new sources are appended in the order
  // first observed for the new version.
  return {
    ...structuredClone(incoming),
    sources,
    claims: [
      ...(previous.claims ?? []).filter((claim) => {
        if ((incoming.claims ?? []).some((candidate) => candidate.claimKey === claim.claimKey)) return false;
        // When the incoming revision has an explicit claim projection, absence
        // of a page-field claim means the corresponding field was removed. Do
        // not resurrect stale evidence from the previous event version.
        return incoming.claims === undefined || !isManagedPageClaim(claim.claimKey);
      }),
      ...(incoming.claims ?? []),
    ].map((claim) => structuredClone(claim)).sort((left, right) => left.ordinal - right.ordinal || left.claimKey.localeCompare(right.claimKey)),
    crossSourceCount: new Set(sources.map((source) => source.type)).size,
  };
}

export function stableEventSeed(headline: Headline): string {
  const documentIds = headline.sources.map((source) => source.sourceDocumentId).filter((value): value is string => Boolean(value)).sort();
  const canonicalUrls = headline.sources
    .map((source) => source.canonicalUrl || canonicalizeSourceUrl(source.url))
    .filter((value): value is string => Boolean(value))
    .sort();
  const titleTokens = [...identityTokens(headline.sources.map((source) => source.originalTitle ?? "").join(" ") || headline.title)]
    .sort()
    .slice(0, 16);
  const publishedDate = headline.publishedAt?.slice(0, 10) ?? "unknown-date";
  return canonicalJson({
    schema: EVENT_IDENTITY_SCHEMA,
    strongestSource: documentIds[0] ?? canonicalUrls[0],
    ticker: headline.ticker.trim().toUpperCase(),
    category: headline.category,
    publishedDate,
    titleTokens,
  });
}

export function createStableEventIdentity(headline: Headline): { id: string; stableKey: string } {
  const stableKey = sha256(stableEventSeed(headline));
  return { id: `evt_${stableKey.slice(0, 32)}`, stableKey };
}

export function briefPayloadHash(headlines: Headline[], rest: Record<string, unknown>): string {
  return stableHash({
    schema: "brief-snapshot/v1",
    headlines: headlines.map((headline) => ({
      id: headline.id,
      rank: headline.rank,
      rankingScore: headline.rankingScore,
      freshnessScore: headline.freshnessScore,
      mentions: headline.mentions,
      crossSourceCount: headline.crossSourceCount,
      eventVersion: eventVersionMaterial(headline).versionHash,
    })),
    ...rest,
  });
}
