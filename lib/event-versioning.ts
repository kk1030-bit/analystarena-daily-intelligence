import { createHash } from "node:crypto";
import type { EvidenceCitation, EventRecord, Headline, SourceEvidence, SourceLink } from "./types";
import { canonicalizeSourceUrl } from "./source-identity";

export const EVENT_VERSION_SCHEMA = "event-version/v2";
export const EVENT_IDENTITY_SCHEMA = "event-identity/v1";
export const EVENT_SEMANTIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
// A source that used to be primary may become corroborating after an official
// document arrives. It is useful as a continuity hint, but must never decide
// identity by itself: the current and previous event still need meaningful
// semantic overlap. This threshold is deliberately below the general
// semantic-only threshold (0.58) because the historical primary is additional
// evidence, while remaining high enough to reject a merely shared roundup.
export const EVENT_PRIMARY_TRANSITION_MIN_CONFIDENCE = 0.35;

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

export function eventIdentitySources(headline: Headline): SourceLink[] {
  const primary = headline.sources.filter((source) => source.role === "primary");
  // New evidence-bound briefs always declare a primary source. Limit the
  // fallback for historical/legacy payloads to their first source; treating
  // every corroborating document as a permanent event alias lets one roundup
  // article incorrectly merge otherwise unrelated clusters over time.
  return primary.length ? primary : headline.sources.slice(0, 1);
}

export function semanticMatchConfidence(incoming: Headline, existing: Headline): number {
  const incomingTime = validTime(incoming.publishedAt);
  const existingTime = validTime(existing.publishedAt);
  if (incomingTime !== undefined && existingTime !== undefined
    && Math.abs(incomingTime - existingTime) > EVENT_SEMANTIC_WINDOW_MS) return 0;

  const incomingOriginalTitles = eventIdentitySources(incoming)
    .map((source) => source.originalTitle ?? "")
    .filter(Boolean)
    .join(" ");
  const existingOriginalTitles = eventIdentitySources(existing)
    .map((source) => source.originalTitle ?? "")
    .filter(Boolean)
    .join(" ");
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

function aliasesFromSources(
  headline: Headline,
  sources: SourceLink[],
): EventAlias[] {
  const aliases: EventAlias[] = [];
  for (const source of sources) {
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

export function aliasesForHeadline(headline: Headline): EventAlias[] {
  return aliasesFromSources(headline, eventIdentitySources(headline));
}

export function aliasesForMatching(headline: Headline): EventAlias[] {
  // A previous primary source may become corroborating after a stronger
  // official document arrives. Consider every incoming source while looking
  // up candidates, then require the candidate's latest version to own that
  // alias as a primary identity before accepting it.
  return aliasesFromSources(headline, headline.sources);
}

export function headlineOwnsAlias(headline: Headline, alias: EventAlias): boolean {
  if (alias.type === "legacy") return headline.id === alias.key;
  return aliasesForHeadline(headline).some((candidate) =>
    candidate.type === alias.type && candidate.key === alias.key);
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
  const normalizeSourceRoles = (headline: Headline): Headline => {
    const hasDeclaredPrimary = headline.sources.some((source) => source.role === "primary");
    return {
      ...structuredClone(headline),
      sources: headline.sources.map((source, index) => ({
        ...structuredClone(source),
        role: !hasDeclaredPrimary && index === 0
          ? "primary"
          : source.role ?? "corroborating",
      })),
    };
  };
  if (!previous) return normalizeSourceRoles(incoming);
  const evidenceIdentity = (item: { sourceDocumentId?: string; id: string }) =>
    `${item.sourceDocumentId ?? ""}\u0000${item.id}`;
  const evidenceVersionIdentity = (
    item: Pick<SourceEvidence, "sourceDocumentId" | "sourceDocumentVersionId" | "id" | "versionId">,
  ) => [
    item.sourceDocumentId,
    item.sourceDocumentVersionId ?? "",
    item.id,
    item.versionId ?? "",
  ].join("\u0000");
  const mergeEvidence = <T extends { sourceDocumentId?: string; id: string }>(
    preferred: T[] | undefined,
    fallback: T[] | undefined,
  ): T[] | undefined => {
    if (!preferred?.length) return fallback?.map((item) => structuredClone(item));
    const preferredIds = new Set(preferred.map(evidenceIdentity));
    return [
      ...preferred.map((item) => structuredClone(item)),
      ...(fallback ?? [])
        .filter((item) => !preferredIds.has(evidenceIdentity(item)))
        .map((item) => structuredClone(item)),
    ];
  };
  const mergeCitations = (
    preferred: EvidenceCitation[] | undefined,
    fallback: EvidenceCitation[] | undefined,
    availableEvidenceVersions: ReadonlySet<string>,
  ): EvidenceCitation[] => {
    const availablePreferred = (preferred ?? []).filter((item) =>
      availableEvidenceVersions.has(evidenceVersionIdentity(item)));
    const availableFallback = (fallback ?? []).filter((item) =>
      availableEvidenceVersions.has(evidenceVersionIdentity(item)));
    if (!availablePreferred.length) {
      return availableFallback.map((item) => structuredClone(item));
    }
    // A claim can intentionally bind the same immutable evidence as support,
    // contradiction, and/or context. Relation is therefore part of citation
    // identity. Within one relation, the current evidence version supersedes
    // the retained version of the same anchor.
    const citationIdentity = (item: EvidenceCitation) =>
      `${evidenceIdentity(item)}\u0000${item.relation}`;
    const preferredIds = new Set(availablePreferred.map(citationIdentity));
    return [
      ...availablePreferred.map((item) => structuredClone(item)),
      ...availableFallback
        .filter((item) => !preferredIds.has(citationIdentity(item)))
        .map((item) => structuredClone(item)),
    ];
  };
  const isManagedPageClaim = (claimKey: string) => claimKey === "title"
    || claimKey === "summary"
    || claimKey === "market_impact"
    || claimKey === "direction_rationale"
    || /^important_information:\d+$/.test(claimKey);
  const sameSourceIdentity = (left: SourceLink, right: SourceLink): boolean => {
    const leftDocumentId = left.sourceDocumentId?.trim() || undefined;
    const rightDocumentId = right.sourceDocumentId?.trim() || undefined;
    const leftCanonicalUrl = canonicalizeSourceUrl(left.canonicalUrl || left.url);
    const rightCanonicalUrl = canonicalizeSourceUrl(right.canonicalUrl || right.url);
    return Boolean(leftDocumentId && rightDocumentId && leftDocumentId === rightDocumentId)
      || leftCanonicalUrl === rightCanonicalUrl;
  };
  const mergedSources = [...previous.sources, ...incoming.sources].reduce<SourceLink[]>((result, source) => {
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
      const observationKey = (candidate: SourceLink) =>
        candidate.sourceObservationId
        ?? candidate.capture?.collectedAt
        ?? candidate.collectedAt
        ?? "";
      const observationsDiffer = observationKey(preferred) !== observationKey(fallback);
      const preferredEvidenceIds = new Set(
        (preferred.evidence ?? []).map(evidenceIdentity),
      );
      const omitsFallbackEvidence = (fallback.evidence ?? []).some((evidence) =>
        !preferredEvidenceIds.has(evidenceIdentity(evidence)));
      // Absence from a later scrape is not proof that a publisher retracted
      // evidence. If the later observation omits any previously verified
      // anchor, retain the entire prior projection rather than manufacturing a
      // removal or mixing capture metadata across observations. A reviewed
      // EvidenceRetractionRequest remains the only removal authority.
      const retainFallbackProjection = observationsDiffer
        && preferred.sourceDocumentId === fallback.sourceDocumentId
        && omitsFallbackEvidence
        && Boolean(fallback.evidence?.length)
        && Boolean(
          fallback.sourceDocumentId
          && fallback.sourceDocumentVersionId
          && fallback.sourceObservationId,
        );
      const selected = retainFallbackProjection ? fallback : preferred;
      const alternate = selected === preferred ? fallback : preferred;
      const sameObservationProjection = selected.sourceDocumentId === alternate.sourceDocumentId
        && selected.sourceDocumentVersionId === alternate.sourceDocumentVersionId
        && observationKey(selected) === observationKey(alternate);
      const mergedEvidence = (
        sameObservationProjection
          ? mergeEvidence(selected.evidence, alternate.evidence)
          : selected.evidence?.map((evidence) => structuredClone(evidence))
      )
        ?.filter((evidence) =>
          evidence.sourceDocumentId === selected.sourceDocumentId
          && evidence.sourceDocumentVersionId === selected.sourceDocumentVersionId);
      result[existingIndex] = {
        ...alternate,
        ...selected,
        // A collector may rediscover the same source while temporarily
        // failing to extract its evidence. Both `undefined` and an empty
        // projection mean "no new evidence observed", not authorization to
        // erase immutable evidence. Explicit removals are applied later from
        // an audited EvidenceRetractionRequest.
        // Evidence from the exact same immutable observation can be merged.
        // Across observations, an incomplete projection cannot erase an
        // earlier verified anchor; explicit audited retraction is required.
        // A canonical-URL alias can migrate to a different document identity.
        // Never attach evidence or a capture from that old parent to the new
        // SourceLink; any resulting removal remains subject to the explicit
        // evidence-retraction gate.
        evidence: mergedEvidence,
        capture: selected.capture
          ?? (sameObservationProjection ? alternate.capture : undefined),
      };
    }
    return result;
  }, []);
  const incomingHasDeclaredPrimary = incoming.sources.some((source) => source.role === "primary");
  const incomingSourceRoles = incoming.sources.map((source, index) => ({
    source,
    role: !incomingHasDeclaredPrimary && index === 0
      ? "primary"
      : source.role ?? "corroborating",
  }));
  const sources = mergedSources.map((source) => {
    const current = incomingSourceRoles.find((candidate) =>
      sameSourceIdentity(candidate.source, source));
    if (current) return { ...source, role: current.role };
    // Evidence retained from an earlier observation remains auditable, but it
    // cannot keep controlling current event identity after the collector has
    // selected another primary source.
    return source.role === "primary"
      ? { ...source, role: "corroborating" as const }
      : source;
  });
  // Preserve the source order recorded by the previous event version. Source
  // order is deliberately excluded from the event-version hash, so sorting a
  // reused projection here could make its displayed ordinals disagree with
  // the immutable `event_version_sources` rows. Existing sources retain their
  // authoritative positions; genuinely new sources are appended in the order
  // first observed for the new version.
  const availableEvidenceVersions = new Set(
    sources.flatMap((source) =>
      (source.evidence ?? []).map((evidence) => evidenceVersionIdentity(evidence))),
  );
  const normalizeClaimEvidence = (
    claim: NonNullable<Headline["claims"]>[number],
  ): NonNullable<Headline["claims"]>[number] => {
    const citations = claim.citations
      .filter((citation) =>
        availableEvidenceVersions.has(evidenceVersionIdentity(citation)))
      .map((citation, order) => ({ ...structuredClone(citation), order }));
    const hasAvailableSupport = citations.some((citation) =>
      citation.relation === "supports"
      && citation.confidence > 0
      && citation.locatorStatus !== "unavailable"
      && citation.directness !== "unavailable");
    const hasDirectExactSupport = citations.some((citation) =>
      citation.relation === "supports"
      && citation.confidence > 0
      && citation.locatorStatus === "exact"
      && citation.directness === "direct");
    const hasActiveContradiction = citations.some((citation) =>
      citation.relation === "contradicts"
      && citation.confidence > 0
      && citation.locatorStatus !== "unavailable"
      && citation.directness !== "unavailable");
    let verificationStatus = claim.verificationStatus;
    if (
      (verificationStatus === "supported" || verificationStatus === "partially_supported")
      && !hasAvailableSupport
    ) {
      verificationStatus = "pending_confirmation";
    } else if (
      verificationStatus === "supported"
      && (!hasDirectExactSupport || hasActiveContradiction)
    ) {
      verificationStatus = "partially_supported";
    }
    return {
      ...structuredClone(claim),
      citations,
      verificationStatus,
    };
  };
  const claims = [
    ...(previous.claims ?? []).filter((claim) => {
      if ((incoming.claims ?? []).some((candidate) => candidate.claimKey === claim.claimKey)) return false;
      // When the incoming revision has an explicit claim projection, absence
      // of a page-field claim means the corresponding field was removed. Do
      // not resurrect stale evidence from the previous event version.
      return incoming.claims === undefined || !isManagedPageClaim(claim.claimKey);
    }),
    ...(incoming.claims ?? []).map((claim) => {
      const prior = previous.claims?.find((candidate) =>
        candidate.claimKey === claim.claimKey);
      const sameAssertion = prior
        && prior.type === claim.type
        && prior.statement === claim.statement
        && prior.originalStatement === claim.originalStatement;
      if (!prior || !sameAssertion) return claim;
      // A claim can retain earlier relationships only for the exact same
      // assertion. Filter unavailable preferred citations before relation
      // de-duplication so a stale current projection cannot shadow valid
      // immutable support from the selected source observation.
      return {
        ...claim,
        citations: mergeCitations(
          claim.citations,
          prior.citations,
          availableEvidenceVersions,
        ),
      };
    }),
  ]
    // Normalization also applies to changed/new assertions and unmanaged
    // retained claims; source authority resolution may have discarded an
    // incoming or historical evidence version in either branch.
    .map((claim) => normalizeClaimEvidence(claim))
    .sort((left, right) =>
      left.ordinal - right.ordinal || left.claimKey.localeCompare(right.claimKey));
  return {
    ...structuredClone(incoming),
    sources,
    claims,
    crossSourceCount: new Set(sources.map((source) => source.type)).size,
  };
}

export function stableEventSeed(headline: Headline): string {
  const identitySources = eventIdentitySources(headline);
  const documentIds = identitySources.map((source) => source.sourceDocumentId).filter((value): value is string => Boolean(value)).sort();
  const canonicalUrls = identitySources
    .map((source) => source.canonicalUrl || canonicalizeSourceUrl(source.url))
    .filter((value): value is string => Boolean(value))
    .sort();
  const titleTokens = [...identityTokens(identitySources.map((source) => source.originalTitle ?? "").join(" ") || headline.title)]
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
