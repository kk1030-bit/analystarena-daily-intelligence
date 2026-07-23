import assert from "node:assert/strict";
import { demoBrief } from "../lib/demo-data";
import {
  aliasesForHeadline,
  createStableEventIdentity,
  headlineOwnsAlias,
  mergeRetainedEvidence,
  semanticMatchConfidence,
} from "../lib/event-versioning";
import { ensureRawStoryIdentity } from "../lib/source-identity";
import {
  createEvidenceCitation,
  createHeadlineClaim,
  createSourceEvidence,
  validateHeadlineEvidence,
} from "../lib/source-evidence";
import type { DailyBrief, Headline, RawStory, SourceLink } from "../lib/types";

delete process.env.DATABASE_URL;

const {
  getBrief,
  getPublishedPdf,
  listBriefSnapshots,
  listEventVersions,
  persistBriefObservation,
  publishBrief,
  saveDraft,
  StaleBriefRevisionError,
  updateDraft,
} = await import("../lib/db");

const date = "2098-07-21";

function source(
  url: string,
  originalTitle: string,
  description: string,
  type: RawStory["sourceType"] = "News",
  sourceName = "Test Wire",
): SourceLink {
  const story = ensureRawStoryIdentity({
    id: url,
    title: originalTitle,
    originalTitle,
    description,
    originalDescription: description,
    url,
    publishedAt: `${date}T01:00:00.000Z`,
    collectedAt: `${date}T01:05:00.000Z`,
    source: sourceName,
    sourceType: type,
    timestampKind: "published",
  });
  return {
    name: story.source,
    type: story.sourceType,
    url: story.url,
    sourceDocumentId: story.sourceDocumentId,
    nativeId: story.nativeId,
    canonicalUrl: story.canonicalUrl,
    originalTitle: story.originalTitle,
    contentHash: story.contentHash,
    publishedAt: story.publishedAt,
    collectedAt: story.collectedAt,
    timestampKind: story.timestampKind,
  };
}

const wire = source(
  "https://wire.example.com/NVDA/blackwell?utm_source=mail&edition=us",
  "NVIDIA Blackwell demand exceeds expectations",
  "Customers increased Blackwell orders and NVIDIA raised production plans.",
);
const sec = source(
  "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/nvda-20260721.htm",
  "NVIDIA files updated production outlook",
  "The filing adds quantified production and customer concentration information.",
  "Official",
  "SEC",
);
const secondWire = source(
  "https://another.example.com/technology/blackwell-orders-rise",
  "Blackwell orders rise as NVIDIA expands production",
  "NVIDIA suppliers report stronger Blackwell orders and additional production capacity.",
  "News",
  "Second Wire",
);
const unrelatedPrimary = source(
  "https://identity.example.com/portfolio-allocation",
  "Portfolio allocation policy changes for retirement accounts",
  "A retirement portfolio changed its long-term allocation policy.",
  "News",
  "Identity Wire",
);

function headline(overrides: Partial<Headline> = {}): Headline {
  return {
    ...structuredClone(demoBrief.headlines[0]),
    id: "temporary-primary-id",
    rank: 1,
    ticker: "NVDA",
    title: "英伟达 Blackwell 需求超过预期",
    summary: "客户增加订单，公司扩大生产计划。",
    keyPoints: ["Blackwell 订单增加", "产能计划上调"],
    publishedAt: `${date}T01:00:00.000Z`,
    newsTimeSource: "Test Wire",
    timestampKind: "published",
    marketImpact: "需求与产能同步上调，可能影响收入预期。",
    marketDirection: "bullish",
    directionConfidence: 78,
    directionRationale: "订单增长可能提高未来收入。",
    equityImpacts: [],
    category: "Semiconductor",
    impact: 5,
    confidence: 82,
    mentions: 2,
    rankingScore: 92,
    freshnessScore: 96,
    crossSourceCount: 1,
    sentiment: "positive",
    sources: [wire],
    ...overrides,
  };
}

const primaryOnlyIdentity = headline({
  ticker: "PORT",
  title: "退休投资组合调整长期配置",
  summary: "这是一项独立的投资组合配置变化。",
  keyPoints: ["配置政策调整"],
  sources: [
    { ...unrelatedPrimary, role: "primary" },
    { ...secondWire, role: "corroborating" },
  ],
});
const unrelatedClusterWithSharedCorroboration = headline({
  ticker: "NVDA",
  title: "英伟达供应商报告 Blackwell 订单增加",
  summary: "供应商报告新的订单变化。",
  keyPoints: ["供应商订单增加"],
  sources: [
    { ...secondWire, role: "primary" },
    { ...unrelatedPrimary, role: "corroborating" },
  ],
});
const primaryAliases = aliasesForHeadline(primaryOnlyIdentity);
assert.equal(
  primaryAliases.some((alias) =>
    alias.type === "document" && alias.key === unrelatedPrimary.sourceDocumentId),
  true,
);
assert.equal(
  primaryAliases.some((alias) =>
    alias.type === "document" && alias.key === secondWire.sourceDocumentId),
  false,
  "a corroborating roundup source must not become a permanent event alias",
);
assert.equal(
  headlineOwnsAlias(primaryOnlyIdentity, {
    type: "document",
    key: secondWire.sourceDocumentId!,
  }),
  false,
);
assert.equal(
  semanticMatchConfidence(primaryOnlyIdentity, unrelatedClusterWithSharedCorroboration),
  0,
  "shared corroborating documents must not make unrelated primary events a semantic match",
);
assert.notEqual(
  createStableEventIdentity(primaryOnlyIdentity).id,
  createStableEventIdentity(unrelatedClusterWithSharedCorroboration).id,
);

// A legacy URL-derived source id and the current native/feed-derived id can
// identify the same canonical document. Alias intersection must replace the
// legacy projection in place while retaining genuinely different URLs.
const legacyWire: SourceLink = {
  ...structuredClone(wire),
  sourceDocumentId: "sd_legacy_url_identity",
  sourceDocumentVersionId: undefined,
  sourceObservationId: undefined,
};
const currentWire: SourceLink = {
  ...structuredClone(wire),
  sourceDocumentId: "sd_current_feed_identity",
  sourceDocumentVersionId: "00000000-0000-4000-8000-000000000001",
  sourceObservationId: "obs_current_feed_identity",
};
const retainedEvidence = createSourceEvidence({
  sourceDocumentId: currentWire.sourceDocumentId!,
  sourceDocumentVersionId: currentWire.sourceDocumentVersionId!,
  versionId: "10000000-0000-4000-8000-000000000001",
  anchorKey: "test:description",
  quoteOriginal: "Customers increased Blackwell orders.",
  locator: {
    kind: "feed_field",
    feedUrl: "https://wire.example.com/feed.xml",
    entryId: "nvda-blackwell",
    field: "description",
    fieldPath: "/rss/channel/item/description",
  },
  locatorStatus: "exact",
  directness: "direct",
  captureScope: "rss_entry",
  extractionMethod: "test-fixture",
  extractorVersion: "v1",
  capturedAt: `${date}T01:05:00.000Z`,
});
const emptyEvidenceMerged = mergeRetainedEvidence(
  headline({ sources: [{ ...currentWire, evidence: [retainedEvidence] }] }),
  headline({ sources: [{ ...currentWire, evidence: [] }] }),
);
assert.equal(
  emptyEvidenceMerged.sources[0].evidence?.[0].versionId,
  retainedEvidence.versionId,
  "an empty collector evidence projection must retain the exact prior evidence version",
);
const aliasMerged = mergeRetainedEvidence(
  headline({ sources: [legacyWire, currentWire, secondWire] }),
  headline({ sources: [{ ...currentWire, url: `${wire.url}&utm_campaign=recapture` }] }),
);
assert.deepEqual(
  aliasMerged.sources.map((item) => item.sourceDocumentId),
  [currentWire.sourceDocumentId, secondWire.sourceDocumentId],
  "matching document-id or canonical-URL aliases must merge in the previous source slot",
);
assert.equal(aliasMerged.sources[0].url, `${wire.url}&utm_campaign=recapture`);
assert.notEqual(
  aliasMerged.sources[0].canonicalUrl,
  aliasMerged.sources[1].canonicalUrl,
  "different canonical URLs must remain separate sources",
);
const reverseAliasMerged = mergeRetainedEvidence(
  headline({ sources: [currentWire, legacyWire, secondWire] }),
  headline({ sources: [] }),
);
assert.deepEqual(
  reverseAliasMerged.sources.map((item) => item.sourceDocumentId),
  [currentWire.sourceDocumentId, secondWire.sourceDocumentId],
  "an unversioned legacy alias must not overwrite an already observation-bound source",
);
assert.equal(reverseAliasMerged.sources[0].sourceDocumentVersionId, currentWire.sourceDocumentVersionId);
assert.equal(reverseAliasMerged.sources[0].sourceObservationId, currentWire.sourceObservationId);

const legacyEvidence = createSourceEvidence({
  sourceDocumentId: legacyWire.sourceDocumentId!,
  sourceDocumentVersionId: "00000000-0000-4000-8000-000000000004",
  versionId: "10000000-0000-4000-8000-000000000004",
  anchorKey: retainedEvidence.anchorKey,
  quoteOriginal: retainedEvidence.quoteOriginal,
  locator: retainedEvidence.locator,
  locatorStatus: retainedEvidence.locatorStatus,
  directness: retainedEvidence.directness,
  captureScope: retainedEvidence.captureScope,
  extractionMethod: retainedEvidence.extractionMethod,
  extractorVersion: "legacy-v1",
  capturedAt: `${date}T01:04:00.000Z`,
});
const evidenceAliasMerged = mergeRetainedEvidence(
  headline({
    sources: [{
      ...legacyWire,
      sourceDocumentVersionId: legacyEvidence.sourceDocumentVersionId,
      sourceObservationId: "obs_legacy_url_identity",
      evidence: [legacyEvidence],
    }],
    claims: [],
  }),
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [],
  }),
);
assert.deepEqual(
  evidenceAliasMerged.sources[0].evidence?.map((evidence) => evidence.sourceDocumentId),
  [currentWire.sourceDocumentId],
  "a canonical-URL identity migration must not attach legacy evidence to the current parent source",
);
assert.deepEqual(validateHeadlineEvidence(evidenceAliasMerged).issues, []);

// A rediscovered assertion can add a new citation while retaining immutable
// prior evidence. Each input projection numbers its first citation as zero;
// the merged claim must normalize those ordinals before integrity validation.
const newerEvidence = createSourceEvidence({
  sourceDocumentId: secondWire.sourceDocumentId!,
  sourceDocumentVersionId: "00000000-0000-4000-8000-000000000002",
  versionId: "10000000-0000-4000-8000-000000000002",
  anchorKey: "test:second-wire-description",
  quoteOriginal: "Suppliers reported additional Blackwell production capacity.",
  locator: {
    kind: "feed_field",
    feedUrl: "https://another.example.com/feed.xml",
    entryId: "blackwell-orders-rise",
    field: "description",
    fieldPath: "/rss/channel/item/description",
  },
  locatorStatus: "exact",
  directness: "direct",
  captureScope: "rss_entry",
  extractionMethod: "test-fixture",
  extractorVersion: "v1",
  capturedAt: `${date}T01:06:00.000Z`,
});
const assertion = "Blackwell 订单增加";
const retainedClaim = createHeadlineClaim({
  claimKey: "important_information:0",
  type: "important_information",
  ordinal: 3,
  statement: assertion,
  originalStatement: assertion,
  language: "zh-CN",
  verificationStatus: "supported",
  citations: [createEvidenceCitation(retainedEvidence, { order: 0 })],
  generator: "deterministic",
  generatorVersion: "test/v1",
});
const incomingClaim = createHeadlineClaim({
  claimKey: retainedClaim.claimKey,
  type: retainedClaim.type,
  ordinal: retainedClaim.ordinal,
  statement: assertion,
  originalStatement: assertion,
  language: "zh-CN",
  verificationStatus: "supported",
  citations: [createEvidenceCitation(newerEvidence, { order: 0 })],
  generator: "deterministic",
  generatorVersion: "test/v1",
});
const citationOrderMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [retainedClaim],
  }),
  headline({
    sources: [
      { ...currentWire, evidence: [retainedEvidence] },
      { ...secondWire, evidence: [newerEvidence] },
    ],
    claims: [incomingClaim],
  }),
);
assert.deepEqual(
  citationOrderMerged.claims?.[0].citations.map((citation) => citation.order),
  [0, 1],
  "merged current and retained citations must have contiguous claim-local order",
);
assert.deepEqual(
  validateHeadlineEvidence(citationOrderMerged).issues,
  [],
  "retained evidence must remain publishable after citation-order normalization",
);

const contextualRetainedClaim = createHeadlineClaim({
  ...retainedClaim,
  verificationStatus: "pending_confirmation",
  citations: [createEvidenceCitation(retainedEvidence, {
    relation: "context",
    order: 0,
  })],
});
const supportingIncomingClaim = createHeadlineClaim({
  ...retainedClaim,
  citations: [createEvidenceCitation(retainedEvidence, {
    relation: "supports",
    order: 0,
  })],
});
const relationAwareMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [contextualRetainedClaim],
  }),
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [supportingIncomingClaim],
  }),
);
assert.deepEqual(
  relationAwareMerged.claims?.[0].citations.map((citation) => ({
    relation: citation.relation,
    order: citation.order,
  })),
  [
    { relation: "supports", order: 0 },
    { relation: "context", order: 1 },
  ],
  "retaining one evidence relationship must not silently erase a different relation",
);
assert.deepEqual(validateHeadlineEvidence(relationAwareMerged).issues, []);

const contradictoryRetainedClaim = createHeadlineClaim({
  ...retainedClaim,
  verificationStatus: "pending_confirmation",
  citations: [createEvidenceCitation(retainedEvidence, {
    relation: "contradicts",
    order: 0,
  })],
});
const contradictionAwareMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [contradictoryRetainedClaim],
  }),
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [supportingIncomingClaim],
  }),
);
assert.equal(
  contradictionAwareMerged.claims?.[0].verificationStatus,
  "partially_supported",
  "active retained contradiction must prevent a merged claim from remaining fully supported",
);
assert.deepEqual(validateHeadlineEvidence(contradictionAwareMerged).issues, []);

const revisedEvidence = createSourceEvidence({
  sourceDocumentId: currentWire.sourceDocumentId!,
  sourceDocumentVersionId: "00000000-0000-4000-8000-000000000003",
  versionId: "10000000-0000-4000-8000-000000000003",
  anchorKey: retainedEvidence.anchorKey,
  quoteOriginal: "Customers increased Blackwell orders and revised their delivery schedule.",
  locator: retainedEvidence.locator,
  locatorStatus: retainedEvidence.locatorStatus,
  directness: retainedEvidence.directness,
  captureScope: retainedEvidence.captureScope,
  extractionMethod: retainedEvidence.extractionMethod,
  extractorVersion: "v2",
  capturedAt: `${date}T01:07:00.000Z`,
});
assert.equal(revisedEvidence.id, retainedEvidence.id);
const unsupportedIncomingClaim = createHeadlineClaim({
  ...retainedClaim,
  verificationStatus: "pending_confirmation",
  citations: [],
});
const revisedEvidenceMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [retainedClaim],
  }),
  headline({
    sources: [{
      ...currentWire,
      sourceDocumentVersionId: revisedEvidence.sourceDocumentVersionId,
      evidence: [revisedEvidence],
    }],
    claims: [unsupportedIncomingClaim],
  }),
);
assert.deepEqual(
  revisedEvidenceMerged.claims?.[0].citations,
  [],
  "a prior citation must not dangle after its exact source evidence version is superseded",
);
assert.equal(
  revisedEvidenceMerged.claims?.[0].verificationStatus,
  "pending_confirmation",
  "a claim without remaining publishable support must be downgraded",
);
assert.deepEqual(validateHeadlineEvidence(revisedEvidenceMerged).issues, []);

const recapturedAt = `${date}T01:15:00.000Z`;
const emptyRecaptureMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [],
  }),
  headline({
    sources: [{
      ...currentWire,
      sourceObservationId: "obs_current_feed_identity_recaptured",
      collectedAt: recapturedAt,
      evidence: [],
    }],
    claims: [],
  }),
);
assert.equal(
  emptyRecaptureMerged.sources[0].sourceObservationId,
  currentWire.sourceObservationId,
  "an empty recapture must retain the entire last verified source observation",
);
assert.equal(emptyRecaptureMerged.sources[0].collectedAt, currentWire.collectedAt);
assert.equal(emptyRecaptureMerged.sources[0].evidence?.[0].versionId, retainedEvidence.versionId);
assert.deepEqual(validateHeadlineEvidence(emptyRecaptureMerged).issues, []);

const recapturedEvidence = createSourceEvidence({
  sourceDocumentId: currentWire.sourceDocumentId!,
  sourceDocumentVersionId: currentWire.sourceDocumentVersionId!,
  versionId: "10000000-0000-4000-8000-000000000005",
  anchorKey: "test:recaptured-supplier-detail",
  quoteOriginal: "A later observation added a supplier delivery detail.",
  locator: retainedEvidence.locator,
  locatorStatus: retainedEvidence.locatorStatus,
  directness: retainedEvidence.directness,
  captureScope: retainedEvidence.captureScope,
  extractionMethod: retainedEvidence.extractionMethod,
  extractorVersion: "recapture-v1",
  capturedAt: recapturedAt,
});
const partialRecaptureMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [],
  }),
  headline({
    sources: [{
      ...currentWire,
      sourceObservationId: "obs_current_feed_identity_recaptured",
      collectedAt: recapturedAt,
      evidence: [recapturedEvidence],
    }],
    claims: [],
  }),
);
assert.deepEqual(
  partialRecaptureMerged.sources[0].evidence?.map((evidence) => evidence.versionId),
  [recapturedEvidence.versionId],
  "a non-empty later observation must not mix omitted evidence from an earlier capture",
);
assert.deepEqual(validateHeadlineEvidence(partialRecaptureMerged).issues, []);

const stalePreferredClaim = createHeadlineClaim({
  ...retainedClaim,
  citations: [createEvidenceCitation(revisedEvidence, { order: 0 })],
});
const stalePreferredMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [retainedClaim],
  }),
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [stalePreferredClaim],
  }),
);
assert.equal(
  stalePreferredMerged.claims?.[0].citations[0].versionId,
  retainedEvidence.versionId,
  "an unavailable preferred citation must not shadow valid retained support",
);
assert.deepEqual(validateHeadlineEvidence(stalePreferredMerged).issues, []);

const indirectEvidence = createSourceEvidence({
  sourceDocumentId: currentWire.sourceDocumentId!,
  sourceDocumentVersionId: currentWire.sourceDocumentVersionId!,
  versionId: "10000000-0000-4000-8000-000000000006",
  anchorKey: "test:indirect-guidance",
  quoteOriginal: "A supplier said the order trend could imply stronger demand.",
  locator: retainedEvidence.locator,
  locatorStatus: "exact",
  directness: "indirect",
  captureScope: retainedEvidence.captureScope,
  extractionMethod: retainedEvidence.extractionMethod,
  extractorVersion: "indirect-v1",
  capturedAt: retainedEvidence.capturedAt,
});
const revisedDirectEvidence = createSourceEvidence({
  sourceDocumentId: currentWire.sourceDocumentId!,
  sourceDocumentVersionId: revisedEvidence.sourceDocumentVersionId!,
  versionId: "10000000-0000-4000-8000-000000000007",
  anchorKey: indirectEvidence.anchorKey,
  quoteOriginal: "The company directly confirmed stronger demand.",
  locator: retainedEvidence.locator,
  locatorStatus: "exact",
  directness: "direct",
  captureScope: retainedEvidence.captureScope,
  extractionMethod: retainedEvidence.extractionMethod,
  extractorVersion: "direct-v2",
  capturedAt: revisedEvidence.capturedAt,
});
assert.equal(revisedDirectEvidence.id, indirectEvidence.id);
const partiallyRetainedClaim = createHeadlineClaim({
  ...retainedClaim,
  verificationStatus: "partially_supported",
  citations: [createEvidenceCitation(indirectEvidence, { order: 0 })],
});
const unavailableDirectClaim = createHeadlineClaim({
  ...retainedClaim,
  verificationStatus: "supported",
  citations: [createEvidenceCitation(revisedDirectEvidence, { order: 0 })],
});
const indirectFallbackMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [indirectEvidence] }],
    claims: [partiallyRetainedClaim],
  }),
  headline({
    sources: [{ ...currentWire, evidence: [indirectEvidence] }],
    claims: [unavailableDirectClaim],
  }),
);
assert.equal(indirectFallbackMerged.claims?.[0].citations[0].versionId, indirectEvidence.versionId);
assert.equal(
  indirectFallbackMerged.claims?.[0].verificationStatus,
  "partially_supported",
  "supported must downgrade when only indirect support remains",
);
assert.deepEqual(validateHeadlineEvidence(indirectFallbackMerged).issues, []);

const changedAssertion = "Blackwell 订单增速仍有待确认";
const changedAssertionClaim = createHeadlineClaim({
  ...retainedClaim,
  statement: changedAssertion,
  originalStatement: changedAssertion,
  statementHash: undefined,
  verificationStatus: "supported",
  citations: [createEvidenceCitation(revisedEvidence, { order: 0 })],
});
const changedAssertionMerged = mergeRetainedEvidence(
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [retainedClaim],
  }),
  headline({
    sources: [{ ...currentWire, evidence: [retainedEvidence] }],
    claims: [changedAssertionClaim],
  }),
);
assert.deepEqual(changedAssertionMerged.claims?.[0].citations, []);
assert.equal(changedAssertionMerged.claims?.[0].verificationStatus, "pending_confirmation");
assert.deepEqual(
  validateHeadlineEvidence(changedAssertionMerged).issues,
  [],
  "changed assertions must also discard dangling citations and normalize verification",
);

function brief(generatedAt: string, item: Headline): DailyBrief {
  return {
    ...structuredClone(demoBrief),
    id: undefined,
    date,
    generatedAt,
    status: "draft",
    publishedAt: undefined,
    snapshot: undefined,
    headlines: [item],
    stats: { ...demoBrief.stats, topStories: 1, consolidatedEvents: 1 },
    socialBuzz: { reddit: [], x: [] },
  };
}

const firstBrief = brief(`${date}T01:10:00.000Z`, headline());
const firstRecord = await saveDraft(firstBrief, { stream: "shared", batchKey: "event-version-test-1" });
const eventId = firstRecord.brief.headlines[0].id;
assert.match(eventId, /^evt_[a-f0-9]{32}$/);
assert.equal(firstRecord.brief.headlines[0].whatChanged?.status, "first_seen");
assert.equal(firstRecord.brief.headlines[0].whatChanged?.operational.presence, "first_seen");
assert.equal(firstRecord.brief.headlines[0].whatChanged?.investor.presence, "first_seen");
assert.equal(
  firstRecord.brief.headlines[0].whatChanged?.items.every((item) => item.kind === "first_seen"),
  true,
  "a first observation must not manufacture evidence, direction, number, or rank deltas",
);
let snapshots = await listBriefSnapshots(date);
assert.equal(snapshots.length, 1);
assert.equal(snapshots[0].previousSnapshotId, undefined);
let versions = await listEventVersions(eventId);
assert.equal(versions.length, 1);
assert.equal(versions[0].versionNumber, 1);
assert.equal(versions[0].previousVersionId, undefined);

// Replaying one idempotency key returns the original immutable snapshot.
const replay = await Promise.all([
  saveDraft(firstBrief, { stream: "shared", batchKey: "event-version-test-1" }),
  saveDraft(firstBrief, { stream: "shared", batchKey: "event-version-test-1" }),
]);
assert.equal(replay[0].brief.snapshot?.id, firstRecord.brief.snapshot?.id);
assert.equal(replay[1].brief.snapshot?.id, firstRecord.brief.snapshot?.id);
assert.equal((await listBriefSnapshots(date)).length, 1);

// Translation, temporary upstream ID, rank, and freshness may change without
// forking the event or manufacturing a substantive event version.
const translatedBrief = brief(`${date}T01:20:00.000Z`, headline({
  id: "different-primary-after-translation",
  rank: 2,
  title: "NVIDIA Blackwell demand is above forecasts",
  summary: "A differently worded display summary.",
  rankingScore: 70,
  freshnessScore: 80,
  sources: [{ ...wire, url: "https://wire.example.com/NVDA/blackwell?edition=us&utm_campaign=again" }],
}));
const translatedRecord = await saveDraft(translatedBrief, { stream: "shared", batchKey: "event-version-test-2" });
assert.equal(translatedRecord.brief.headlines[0].id, eventId);
assert.equal(translatedRecord.brief.headlines[0].whatChanged?.operational.status, "changed");
assert.equal(translatedRecord.brief.headlines[0].whatChanged?.status, "changed");
assert.deepEqual(
  translatedRecord.brief.headlines[0].whatChanged?.items.map((item) => item.kind),
  ["rank_down"],
  "reusing v1 may report the real rank movement but must not repeat its intrinsic first-seen marker",
);
versions = await listEventVersions(eventId);
assert.equal(versions.length, 1, "presentation/rank changes must not create an event-state version");
snapshots = await listBriefSnapshots(date);
assert.equal(snapshots.length, 2);
assert.equal(snapshots[0].previousSnapshotId, snapshots[1].id);
assert.equal(snapshots[0].events[0].rank, 2);
assert.equal(snapshots[1].brief.headlines[0].title, firstBrief.headlines[0].title, "old snapshot payload must remain unchanged");

// New evidence and a changed market judgment create exactly one chained v2.
const evidenceBrief = brief(`${date}T01:30:00.000Z`, headline({
  id: "official-source-now-primary",
  sources: [
    { ...sec, role: "primary" },
    { ...wire, role: "corroborating" },
  ],
  crossSourceCount: 2,
  marketDirection: "bearish",
  directionRationale: "New concentration data introduces downside risk.",
}));
const evidenceRecord = await saveDraft(evidenceBrief, { stream: "shared", batchKey: "event-version-test-3" });
assert.equal(evidenceRecord.brief.headlines[0].id, eventId, "primary-source change must not fork the event");
assert.equal(evidenceRecord.brief.headlines[0].whatChanged?.operational.status, "changed");
assert.ok(
  evidenceRecord.brief.headlines[0].whatChanged?.operational.items.some((item) =>
    item.kind === "direction_changed"),
  "the exact v1→v2 direction transition must be retained",
);
versions = await listEventVersions(eventId);
assert.equal(versions.length, 2);
assert.equal(versions[1].versionNumber, 2);
assert.equal(versions[1].previousVersionId, versions[0].id);

// A temporary collector miss does not erase previously confirmed evidence.
const partialBrief = brief(`${date}T01:40:00.000Z`, headline({
  id: "only-sec-returned-this-time",
  sources: [{ ...sec, role: "primary" }],
  crossSourceCount: 1,
  marketDirection: "bearish",
}));
const partialRecord = await saveDraft(partialBrief, { stream: "shared", batchKey: "event-version-test-4" });
assert.equal(partialRecord.brief.headlines[0].id, eventId);
assert.equal(partialRecord.brief.headlines[0].sources.length, 2, "historical evidence must be retained");
assert.equal((await listEventVersions(eventId)).length, 2);
assert.equal(partialRecord.brief.headlines[0].whatChanged?.operational.status, "unchanged");
assert.equal(
  partialRecord.brief.headlines[0].whatChanged?.operational.items.length,
  0,
  "reusing v2 must not replay its earlier evidence or direction changes",
);

// No shared URL: a high-confidence original-language match still reuses the
// permanent event ID; the new source becomes evidence v3.
const semanticBrief = brief(`${date}T01:50:00.000Z`, headline({
  id: "new-source-only",
  sources: [secondWire],
  crossSourceCount: 1,
  title: "英伟达扩大 Blackwell 生产",
  marketDirection: "bearish",
}));
const semanticRecord = await saveDraft(semanticBrief, { stream: "shared", batchKey: "event-version-test-5" });
assert.equal(semanticRecord.brief.headlines[0].id, eventId);
versions = await listEventVersions(eventId);
assert.equal(versions.length, 3);
assert.equal(versions[2].previousVersionId, versions[1].id);

// A -> B -> A is a real chronological transition and must create v5, even
// when the final content hash was seen earlier in the chain.
const neutralBrief = brief(`${date}T02:00:00.000Z`, headline({
  id: eventId,
  sources: [
    { ...wire, role: "corroborating" },
    { ...sec, role: "corroborating" },
    { ...secondWire, role: "primary" },
  ],
  crossSourceCount: 2,
  marketDirection: "neutral",
  directionConfidence: 60,
}));
await saveDraft(neutralBrief, { stream: "shared", batchKey: "event-version-test-6" });
const bearishAgainBrief = brief(`${date}T02:10:00.000Z`, headline({
  id: eventId,
  sources: [
    { ...wire, role: "corroborating" },
    { ...sec, role: "corroborating" },
    { ...secondWire, role: "primary" },
  ],
  crossSourceCount: 2,
  marketDirection: "bearish",
}));
await saveDraft(bearishAgainBrief, { stream: "shared", batchKey: "event-version-test-7" });
versions = await listEventVersions(eventId);
assert.equal(versions.length, 5);
assert.equal(versions[4].contentHash, versions[2].contentHash);
assert.equal(versions[4].previousVersionId, versions[3].id);

// Same ticker/category alone is insufficient: an unrelated event must remain separate.
const unrelatedSource = source(
  "https://wire.example.com/NVDA/office-lease",
  "NVIDIA board approves a new office lease",
  "The board approved an office lease unrelated to Blackwell demand or production.",
);
const unrelated = brief(`${date}T02:20:00.000Z`, headline({
  id: "unrelated-nvidia-event",
  title: "英伟达批准新的办公室租约",
  summary: "董事会批准办公室租约。",
  keyPoints: ["办公室租约获批"],
  sources: [unrelatedSource],
  marketDirection: "neutral",
  directionConfidence: 40,
}));
const unrelatedRecord = await saveDraft(unrelated, { stream: "shared", batchKey: "event-version-test-8" });
assert.notEqual(unrelatedRecord.brief.headlines[0].id, eventId);

// A source that has ever been a primary identity remains permanently bound to
// its original event, even if a later version demotes it to corroborating.
const staleSharedSource = source(
  "https://identity.example.com/shared-roundup-document",
  "Shared roundup document about one market theme",
  "The roundup mentions several unrelated market themes.",
  "News",
  "Identity Wire",
);
const replacementIdentitySource = source(
  "https://identity.example.com/replacement-primary-document",
  "Replacement primary document about a separate policy decision",
  "The primary event is now a separate policy decision.",
  "News",
  "Identity Wire",
);
const staleAliasSeed = brief(`${date}T02:21:00.000Z`, headline({
  id: "stale-alias-seed",
  ticker: "ALIASA",
  category: "Other",
  title: "共享综述的原始事件",
  summary: "原始事件使用共享综述作为主来源。",
  keyPoints: ["共享综述为主来源"],
  sources: [{ ...staleSharedSource, role: "primary" }],
  claims: [],
}));
const staleAliasSeedRecord = await saveDraft(staleAliasSeed, {
  stream: "shared",
  batchKey: "event-version-stale-alias-seed",
});
const staleAliasEventId = staleAliasSeedRecord.brief.headlines[0].id;
await saveDraft(brief(`${date}T02:22:00.000Z`, headline({
  id: staleAliasEventId,
  ticker: "ALIASA",
  category: "Other",
  title: "独立政策决定成为新的主事件",
  summary: "该事件现在由独立政策文件定义。",
  keyPoints: ["独立政策文件为主来源"],
  sources: [
    { ...replacementIdentitySource, role: "primary" },
    { ...staleSharedSource, role: "corroborating" },
  ],
  claims: [],
})), {
  stream: "shared",
  batchKey: "event-version-stale-alias-owner-update",
});
const demotedPrimaryVersion = (await listEventVersions(staleAliasEventId)).at(-1);
assert.deepEqual(
  demotedPrimaryVersion?.headline.sources
    .filter((item) => item.role === "primary")
    .map((item) => item.sourceDocumentId),
  [replacementIdentitySource.sourceDocumentId],
  "current observation must have exactly its declared primary source",
);
assert.equal(
  demotedPrimaryVersion?.headline.sources
    .find((item) => item.sourceDocumentId === staleSharedSource.sourceDocumentId)
    ?.role,
  "corroborating",
  "retained historical evidence must not retain a stale primary role",
);
const staleAliasReuseRecord = await saveDraft(brief(`${date}T02:23:00.000Z`, headline({
  id: "stale-secondary-alias-new-event",
  ticker: "ALIASB",
  category: "Other",
  title: "共享综述现在作为另一个事件的主来源",
  summary: "这是由共享文档定义的另一项独立事件。",
  keyPoints: ["共享文档成为新事件主来源"],
  sources: [{ ...staleSharedSource, role: "primary" }],
  claims: [],
})), {
  stream: "shared",
  batchKey: "event-version-stale-alias-reuse",
});
assert.equal(
  staleAliasReuseRecord.brief.headlines[0].id,
  staleAliasEventId,
  "a former primary alias must remain protected after it becomes corroborating",
);
assert.equal(staleAliasReuseRecord.brief.snapshot?.events[0].matchMethod, "source_alias");

// A source that belongs to another event but appears only as corroboration in
// an unrelated incoming headline is not sufficient to merge the two events.
const secondaryOnlyRecord = await saveDraft(brief(`${date}T02:24:00.000Z`, {
  ...structuredClone(primaryOnlyIdentity),
  id: "secondary-alias-must-not-decide",
}), {
  stream: "shared",
  batchKey: "event-version-secondary-alias-isolation",
});
assert.notEqual(
  secondaryOnlyRecord.brief.headlines[0].id,
  eventId,
  "an unrelated historical-primary source used only as corroboration must not decide identity",
);
assert.equal(secondaryOnlyRecord.brief.snapshot?.events[0].matchMethod, "new");

// Candidate state must be refreshed inside a multi-headline transaction. The
// second headline resembles the first event's pre-batch version but not the
// new version written by headline one; a stale candidate would resolve it back
// to the already-used event and abort the batch.
const batchOldPrimary = source(
  "https://identity.example.com/batch-old-blackwell",
  "NVIDIA Blackwell capacity update expands supplier orders",
  "Blackwell supplier orders expanded after a capacity update.",
  "News",
  "Identity Wire",
);
const batchPolicyPrimary = source(
  "https://identity.example.com/batch-new-policy",
  "Federal retirement filing policy changes next quarter",
  "A federal retirement filing policy changes next quarter.",
  "News",
  "Identity Wire",
);
const batchNvidiaPrimary = source(
  "https://identity.example.com/batch-nvidia-followup",
  "NVIDIA Blackwell capacity update expands supplier orders again",
  "Blackwell supplier orders expanded again after a capacity update.",
  "News",
  "Identity Wire",
);
const batchSeedRecord = await saveDraft(brief(`${date}T02:25:00.000Z`, headline({
  id: "same-batch-candidate-seed",
  ticker: "NVDA",
  category: "Semiconductor",
  title: "英伟达 Blackwell 产能更新推动供应商订单",
  summary: "供应商订单因 Blackwell 产能更新而增加。",
  keyPoints: ["Blackwell 供应商订单增加"],
  sources: [{ ...batchOldPrimary, role: "primary" }],
  claims: [],
})), {
  stream: "shared",
  batchKey: "event-version-same-batch-seed",
});
const batchSeedEventId = batchSeedRecord.brief.headlines[0].id;
const batchUpdatedHeadline = headline({
  id: batchSeedEventId,
  rank: 1,
  ticker: "POLICY",
  category: "Macro",
  title: "联邦退休申报政策将在下季度调整",
  summary: "这是一项与半导体无关的申报政策调整。",
  keyPoints: ["退休申报政策调整"],
  sources: [
    { ...batchPolicyPrimary, role: "primary" },
    { ...batchOldPrimary, role: "corroborating" },
  ],
  claims: [],
});
const batchSecondHeadline = headline({
  id: "same-batch-secondary-transition",
  rank: 2,
  ticker: "NVDA",
  category: "Semiconductor",
  title: "英伟达 Blackwell 供应商订单再次增加",
  summary: "供应商订单在产能更新后再次增加。",
  keyPoints: ["Blackwell 供应商订单再次增加"],
  sources: [
    { ...batchNvidiaPrimary, role: "primary" },
    { ...batchPolicyPrimary, role: "corroborating" },
  ],
  claims: [],
});
const sameBatchRecord = await persistBriefObservation({
  ...brief(`${date}T02:26:00.000Z`, batchUpdatedHeadline),
  headlines: [batchUpdatedHeadline, batchSecondHeadline],
  stats: { ...demoBrief.stats, topStories: 2, consolidatedEvents: 2 },
}, {
  stream: "manual",
  batchKey: "event-version-same-batch-candidate-refresh",
});
assert.notEqual(sameBatchRecord.brief.headlines[1].id, batchSeedEventId);
assert.equal(sameBatchRecord.events[1].matchMethod, "new");

// Pre-7/23 processes may still hold collector-local legacy aliases in memory.
// Reusing or truncating such an id must not override durable source identity.
const aliasMemoryForRegression = (
  globalThis as typeof globalThis & {
    __analystArenaEventAliasMemory?: Map<string, {
      type: "document" | "url" | "legacy";
      key: string;
      eventId: string;
      canonicalUrl?: string;
      firstSeenAt: string;
      lastSeenAt: string;
      primaryEver: boolean;
      resolutionEligible?: boolean;
    }>;
  }
).__analystArenaEventAliasMemory;
assert.ok(aliasMemoryForRegression);
aliasMemoryForRegression.set("legacy:reused-collector-local-id", {
  type: "legacy",
  key: "reused-collector-local-id",
  eventId,
  firstSeenAt: `${date}T01:00:00.000Z`,
  lastSeenAt: `${date}T02:26:00.000Z`,
  primaryEver: true,
  resolutionEligible: false,
});
const reusedLegacySource = source(
  "https://identity.example.com/reused-legacy-municipal-bond",
  "Independent municipal bond covenant update",
  "A municipal bond covenant changed independently of the Blackwell event.",
  "News",
  "Identity Wire",
);
const reusedLegacyRecord = await saveDraft(brief(`${date}T02:27:00.000Z`, headline({
  id: "reused-collector-local-id",
  ticker: "MUNI",
  category: "Macro",
  title: "市政债券契约出现独立调整",
  summary: "重复的采集器本地编号不能把无关事件合并。",
  keyPoints: ["本地编号不具权威性"],
  sources: [{ ...reusedLegacySource, role: "primary" }],
  claims: [],
})), {
  stream: "shared",
  batchKey: "event-version-reused-legacy-id",
});
assert.notEqual(reusedLegacyRecord.brief.headlines[0].id, eventId);
assert.equal(reusedLegacyRecord.brief.snapshot?.events[0].matchMethod, "new");

const unresolvedAliasSource = source(
  "https://identity.example.com/unresolved-protected-alias",
  "Independent insurance reserve methodology update",
  "An insurer changed reserve methodology independently of the Blackwell event.",
  "News",
  "Identity Wire",
);
const unresolvedAliasHeadline = headline({
  id: eventId,
  ticker: "INSURE",
  category: "Other",
  title: "保险准备金方法出现独立调整",
  summary: "无法证明归属的旧别名不得自动合并或转移。",
  keyPoints: ["未知别名需要人工来源审查"],
  sources: [{ ...unresolvedAliasSource, role: "primary" }],
  claims: [],
});
const unresolvedUrlAlias = aliasesForHeadline(unresolvedAliasHeadline)
  .find((alias) => alias.type === "url");
assert.ok(unresolvedUrlAlias?.canonicalUrl);
aliasMemoryForRegression.set(`url:${unresolvedUrlAlias.key}`, {
  type: "url",
  key: unresolvedUrlAlias.key,
  eventId,
  canonicalUrl: unresolvedUrlAlias.canonicalUrl,
  firstSeenAt: `${date}T01:00:00.000Z`,
  lastSeenAt: `${date}T02:27:00.000Z`,
  primaryEver: true,
  resolutionEligible: false,
});
const unresolvedVersionCountBeforeConflict = (await listEventVersions(eventId)).length;
await assert.rejects(
  () => saveDraft(brief(`${date}T02:28:00.000Z`, unresolvedAliasHeadline), {
    stream: "shared",
    batchKey: "event-version-unresolved-alias-return",
  }),
  /protected but not resolution-eligible; manual provenance review is required/,
  "an unresolved primary alias must fail before an explicit event id can append to its old event",
);
assert.equal(
  (await listEventVersions(eventId)).length,
  unresolvedVersionCountBeforeConflict,
  "the provenance conflict must leave the explicitly addressed old event unchanged",
);

// If a later headline in the same batch points at two established events, the
// entire batch rolls back, including an event inserted earlier in that batch.
const newTeslaSource = source(
  "https://wire.example.com/TSLA/battery-line",
  "Tesla opens a new battery production line",
  "Tesla started a separate battery production line.",
);
const newTeslaHeadline = headline({
  id: "new-event-before-conflict",
  rank: 1,
  ticker: "TSLA",
  title: "特斯拉启用新的电池产线",
  summary: "新的电池产线开始运作。",
  keyPoints: ["新产线启用"],
  category: "Other",
  sources: [newTeslaSource],
  marketDirection: "neutral",
});
const conflictingHeadline = headline({
  id: "conflicting-aliases",
  rank: 2,
  sources: [
    { ...sec, role: "primary" },
    { ...unrelatedSource, role: "primary" },
  ],
});
const conflictBrief = {
  ...brief(`${date}T02:30:00.000Z`, newTeslaHeadline),
  headlines: [newTeslaHeadline, conflictingHeadline],
  stats: { ...demoBrief.stats, topStories: 2, consolidatedEvents: 2 },
};
const newTeslaEventId = createStableEventIdentity(newTeslaHeadline).id;
const snapshotCountBeforeConflict = (await listBriefSnapshots(date)).length;
await assert.rejects(
  () => persistBriefObservation(conflictBrief, { stream: "manual", batchKey: "event-version-conflict" }),
  /multiple existing events/,
);
assert.equal((await listBriefSnapshots(date)).length, snapshotCountBeforeConflict);
assert.equal((await listEventVersions(newTeslaEventId)).length, 0, "failed batch must roll back earlier event writes");

// Optimistic review locking stops a stale editor from overwriting a newer refresh.
await assert.rejects(
  () => updateDraft(firstRecord.id, firstRecord.brief, {
    stream: "review",
    batchKey: "event-version-stale-review",
    expectedSnapshotId: firstRecord.brief.snapshot?.id,
  }),
  (error: unknown) => error instanceof StaleBriefRevisionError,
);

// A reused idempotency key with different material content is rejected.
await assert.rejects(
  () => persistBriefObservation(evidenceBrief, { stream: "shared", batchKey: "event-version-test-8" }),
  /reused with different brief content/,
);

// Publishing promotes the exact reviewed snapshot. It must neither ingest the
// submitted payload again nor follow an event head that advances after review.
const reviewed = await getBrief(firstRecord.id);
assert.ok(reviewed?.brief.snapshot?.id);
const reviewedSnapshotId = reviewed.brief.snapshot.id;
const reviewedEvent = reviewed.brief.snapshot.events[0];
const snapshotsBeforeAdvance = (await listBriefSnapshots(date)).length;
const tampered = {
  ...structuredClone(reviewed.brief),
  headlines: reviewed.brief.headlines.map((item, index) =>
    index === 0 ? { ...item, summary: `${item.summary} tampered after review` } : item),
};
await assert.rejects(
  () => publishBrief(reviewed.id, tampered, Buffer.from("tampered-pdf")),
  (error: unknown) => error instanceof StaleBriefRevisionError,
);
assert.equal((await listBriefSnapshots(date)).length, snapshotsBeforeAdvance);

const reviewedHeadline = reviewed.brief.headlines[0];
await persistBriefObservation({
  ...structuredClone(reviewed.brief),
  id: undefined,
  status: "draft",
  storageMode: undefined,
  snapshot: undefined,
  generatedAt: `${date}T02:40:00.000Z`,
  headlines: [{
    ...reviewedHeadline,
    marketDirection: reviewedHeadline.marketDirection === "bearish" ? "bullish" : "bearish",
  }],
}, {
  stream: "shared",
  batchKey: "event-version-between-review-and-publish",
});
const snapshotsAfterAdvance = (await listBriefSnapshots(date)).length;
assert.equal(snapshotsAfterAdvance, snapshotsBeforeAdvance + 1);
assert.notEqual(
  (await listEventVersions(reviewedEvent.eventId)).at(-1)?.id,
  reviewedEvent.eventVersionId,
  "fixture must advance the event head after the reviewed snapshot",
);

const published = await publishBrief(reviewed.id, {
  ...structuredClone(reviewed.brief),
  id: "caller-metadata-is-ignored",
  status: "published",
  publishedAt: `${date}T02:45:00.000Z`,
  storageMode: "postgres",
}, Buffer.from("reviewed-snapshot-pdf"));
assert.equal(published.status, "published");
assert.equal(published.brief.snapshot?.id, reviewedSnapshotId);
assert.equal(published.brief.snapshot?.events[0].eventVersionId, reviewedEvent.eventVersionId);
assert.equal(published.brief.headlines[0].marketDirection, reviewedHeadline.marketDirection);
assert.equal((await listBriefSnapshots(date)).length, snapshotsAfterAdvance, "publish must not create a snapshot");
assert.equal((await getPublishedPdf(reviewed.id))?.pdf.toString(), "reviewed-snapshot-pdf");

console.log("event identity, immutable snapshot, and version-chain tests passed");
