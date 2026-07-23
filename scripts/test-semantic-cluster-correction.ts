import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertSemanticClusterCorrectionVersionsCurrent,
  deriveSemanticClusterCorrectionRetractions,
  SemanticClusterCorrectionError,
  type SemanticClusterCorrectionAuthorization,
} from "../lib/semantic-cluster-correction";
import type {
  BriefRecord,
  DailyBrief,
  EvidenceCitation,
  Headline,
  SourceEvidence,
  SourceLink,
} from "../lib/types";

const date = "2099-07-23";
const generatedAt = "2099-07-23T01:00:00.000Z";
const snapshotId = "11111111-1111-4111-8111-111111111111";
const payloadHash = "a".repeat(64);
const eventVersionId = "22222222-2222-4222-8222-222222222222";

function evidence(
  id: string,
  versionId: string | undefined,
  sourceDocumentId: string,
): SourceEvidence {
  return {
    id,
    versionId,
    sourceDocumentId,
    sourceDocumentVersionId: `${sourceDocumentId}-version`,
    anchorKey: `feed:${id}`,
    quoteOriginal: `Exact quote for ${id}`,
    locator: { kind: "unavailable", reasonCode: "legacy_metadata_only" },
    locatorHash: "b".repeat(64),
    locatorStatus: "exact",
    directness: "direct",
    captureScope: "rss_entry",
    extractionMethod: "test",
    extractorVersion: "test/v1",
    capturedAt: generatedAt,
  };
}

function source(
  name: string,
  role: SourceLink["role"],
  documentId: string,
  evidenceItems: SourceEvidence[],
): SourceLink {
  return {
    name,
    type: role === "social_signal" ? "Reddit" : "News",
    role,
    url: `https://sources.example/${documentId}`,
    canonicalUrl: `https://sources.example/${documentId}`,
    sourceDocumentId: documentId,
    sourceDocumentVersionId: `${documentId}-version`,
    sourceObservationId: `${documentId}-observation`,
    evidence: evidenceItems,
  };
}

function citation(item: SourceEvidence, relation: EvidenceCitation["relation"]): EvidenceCitation {
  return { ...item, relation, confidence: 1, order: 0 };
}

const primaryEvidence = evidence("evi-primary", "ev-primary-v1", "doc-primary");
const removedEvidenceOne = evidence("evi-wrong-one", "ev-wrong-one-v1", "doc-wrong");
const removedEvidenceTwo = evidence("evi-wrong-two", "ev-wrong-two-v1", "doc-wrong");
const removedSocialEvidence = evidence("evi-social", "ev-social-v1", "doc-social");
const retainedEvidence = evidence("evi-retained", "ev-retained-v1", "doc-retained");

const publishedHeadline: Headline = {
  id: "evt-primary",
  rank: 1,
  ticker: "TSLA",
  title: "Tesla earnings",
  summary: "Published summary",
  marketImpact: "Published impact",
  category: "Earnings",
  impact: 5,
  confidence: 90,
  mentions: 4,
  sentiment: "neutral",
  sources: [
    source("Primary News", "primary", "doc-primary", [primaryEvidence]),
    source("Wrong News", "corroborating", "doc-wrong", [removedEvidenceOne, removedEvidenceTwo]),
    source("Wrong Social", "social_signal", "doc-social", [removedSocialEvidence]),
    source("Retained News", "corroborating", "doc-retained", [retainedEvidence]),
  ],
  claims: [{
    id: "claim-summary",
    claimKey: "summary",
    type: "summary",
    ordinal: 0,
    statement: "Published summary",
    statementHash: "c".repeat(64),
    language: "en",
    verificationStatus: "supported",
    citations: [
      citation(primaryEvidence, "supports"),
      { ...citation(removedEvidenceOne, "supports"), order: 1 },
      { ...citation(removedEvidenceTwo, "context"), order: 2 },
      { ...citation(removedSocialEvidence, "supports"), order: 3 },
      { ...citation(retainedEvidence, "supports"), order: 4 },
    ],
    generator: "deterministic",
    generatorVersion: "test/v1",
  }],
};

function brief(headlines: Headline[]): DailyBrief {
  return {
    date,
    generatedAt,
    mode: "live",
    aiEnabled: false,
    stats: {
      candidates: headlines.length,
      consolidatedEvents: headlines.length,
      topStories: headlines.length,
      sourcesOnline: 1,
    },
    headlines,
    marketHeat: [],
    socialBuzz: { reddit: [], x: [] },
    watchlist: [],
  };
}

const publishedBrief = brief([publishedHeadline]);
publishedBrief.status = "published";
publishedBrief.snapshot = {
  id: snapshotId,
  runId: "33333333-3333-4333-8333-333333333333",
  stream: "publish",
  batchKey: "published",
  sequenceNumber: 1,
  payloadHash,
  persistedAt: generatedAt,
  events: [{
    eventId: publishedHeadline.id,
    eventVersionId,
    rank: 1,
    impact: 5,
    confidence: 90,
    mentions: 4,
    matchMethod: "existing_id",
    matchConfidence: 1,
  }],
};
const published: BriefRecord = {
  id: "44444444-4444-4444-8444-444444444444",
  date,
  status: "published",
  brief: publishedBrief,
  createdAt: generatedAt,
  updatedAt: generatedAt,
  publishedAt: generatedAt,
  hasPdf: true,
};
const liveHeadline: Headline = {
  ...structuredClone(publishedHeadline),
  id: "collector-local-id",
  sources: [
    source("Primary News", "primary", "doc-primary", []),
    // The source remains in the corrected cluster. Its evidence omission must
    // not be interpreted as an administrator-authorized retraction.
    source("Retained News", "corroborating", "doc-retained", []),
  ],
  claims: [],
};
const live = brief([liveHeadline]);
const authorization: SemanticClusterCorrectionAuthorization = {
  confirmed: true,
  reason: "管理员逐项确认旧聚类包含与 primary event 无关的来源",
  expectedPublishedBriefId: published.id,
  expectedPublishedSnapshotId: snapshotId,
  expectedPublishedPayloadHash: payloadHash,
};

const requests = deriveSemanticClusterCorrectionRetractions(published, live, authorization);
assert.equal(requests.length, 3);
assert.deepEqual(
  requests.map((request) => [
    request.eventId,
    request.fromEventVersionId,
    request.evidenceItemId,
    request.evidenceVersionId,
    request.claimKey,
    request.citationRelation,
  ]),
  [
    ["evt-primary", eventVersionId, "evi-social", "ev-social-v1", undefined, undefined],
    ["evt-primary", eventVersionId, "evi-wrong-one", "ev-wrong-one-v1", undefined, undefined],
    ["evt-primary", eventVersionId, "evi-wrong-two", "ev-wrong-two-v1", undefined, undefined],
  ],
  "source removal must create exact evidence-scoped requests against the published event version",
);
assert.ok(requests.every((request) => request.reasonCode === "review_rejected"));
assert.ok(requests.every((request) => request.reasonNote.includes("管理员逐项确认")));
assert.ok(
  !requests.some((request) =>
    request.evidenceItemId === primaryEvidence.id
    || request.evidenceItemId === retainedEvidence.id),
  "primary evidence and a still-present corroborating source must never be auto-retracted",
);
assert.deepEqual(
  deriveSemanticClusterCorrectionRetractions(published, live, authorization),
  requests,
  "the pure derivation and stable request IDs must be deterministic",
);
assert.doesNotThrow(() => assertSemanticClusterCorrectionVersionsCurrent(
  requests,
  new Map([[publishedHeadline.id, eventVersionId]]),
));
assert.throws(
  () => assertSemanticClusterCorrectionVersionsCurrent(
    requests,
    new Map([[publishedHeadline.id, "newer-event-version"]]),
  ),
  (error) => error instanceof SemanticClusterCorrectionError && error.code === "STALE_EVENT_VERSION",
);
assert.throws(
  () => assertSemanticClusterCorrectionVersionsCurrent([], new Map()),
  (error) => error instanceof SemanticClusterCorrectionError && error.code === "CORRECTION_NO_RETRACTIONS",
);

function expectCorrectionError(
  mutate: (value: SemanticClusterCorrectionAuthorization) => void,
  code: SemanticClusterCorrectionError["code"],
): void {
  const candidate = structuredClone(authorization);
  mutate(candidate);
  assert.throws(
    () => deriveSemanticClusterCorrectionRetractions(published, live, candidate),
    (error) => error instanceof SemanticClusterCorrectionError && error.code === code,
  );
}

expectCorrectionError((candidate) => { candidate.confirmed = false; }, "CORRECTION_CONFIRMATION_REQUIRED");
expectCorrectionError((candidate) => { candidate.reason = "   "; }, "CORRECTION_REASON_REQUIRED");
expectCorrectionError((candidate) => { candidate.expectedPublishedBriefId = "stale"; }, "STALE_PUBLISHED_BRIEF");
expectCorrectionError((candidate) => { candidate.expectedPublishedSnapshotId = "stale"; }, "STALE_PUBLISHED_SNAPSHOT");
expectCorrectionError((candidate) => { candidate.expectedPublishedPayloadHash = "stale"; }, "STALE_PUBLISHED_PAYLOAD");

const wrongDateLive = structuredClone(live);
wrongDateLive.date = "2099-07-24";
assert.throws(
  () => deriveSemanticClusterCorrectionRetractions(published, wrongDateLive, authorization),
  (error) => error instanceof SemanticClusterCorrectionError && error.code === "CORRECTION_DATE_MISMATCH",
);

const mismatchedPrimaryLive = structuredClone(live);
mismatchedPrimaryLive.headlines[0].sources[0] = source("Other Primary", "primary", "doc-other", []);
assert.deepEqual(
  deriveSemanticClusterCorrectionRetractions(published, mismatchedPrimaryLive, authorization),
  [],
  "a different primary source must not authorize any old-event retraction",
);

const ambiguousPrimaryLive = structuredClone(live);
ambiguousPrimaryLive.headlines[0].sources.push(source("Second Primary", "primary", "doc-other", []));
assert.throws(
  () => deriveSemanticClusterCorrectionRetractions(published, ambiguousPrimaryLive, authorization),
  (error) => error instanceof SemanticClusterCorrectionError && error.code === "AMBIGUOUS_PRIMARY_SOURCE",
);

const duplicatePrimaryLive = brief([
  structuredClone(liveHeadline),
  { ...structuredClone(liveHeadline), id: "second-collector-id", rank: 2 },
]);
assert.throws(
  () => deriveSemanticClusterCorrectionRetractions(published, duplicatePrimaryLive, authorization),
  (error) => error instanceof SemanticClusterCorrectionError && error.code === "DUPLICATE_PRIMARY_MATCH",
);

const unversionedPublished = structuredClone(published);
unversionedPublished.brief.headlines[0].sources[1].evidence = [
  evidence("evi-unversioned", undefined, "doc-wrong"),
];
assert.throws(
  () => deriveSemanticClusterCorrectionRetractions(unversionedPublished, live, authorization),
  (error) => error instanceof SemanticClusterCorrectionError && error.code === "UNVERSIONED_SECONDARY_EVIDENCE",
);

const generateRouteSource = await readFile(
  new URL("../app/api/briefs/generate/route.ts", import.meta.url),
  "utf8",
);
const cronRouteSource = await readFile(
  new URL("../app/api/cron/daily/route.ts", import.meta.url),
  "utf8",
);
assert.match(generateRouteSource, /adminAuditActor/);
assert.match(generateRouteSource, /deriveSemanticClusterCorrectionRetractions/);
assert.match(generateRouteSource, /listEventVersions/);
assert.match(generateRouteSource, /assertSemanticClusterCorrectionVersionsCurrent/);
assert.match(generateRouteSource, /evidenceRetractions/);
assert.match(generateRouteSource, /safeRemoteStories/);
assert.doesNotMatch(
  cronRouteSource,
  /semanticClusterCorrection|deriveSemanticClusterCorrectionRetractions|evidenceRetractions/,
  "cron must never acquire administrator evidence-retraction authority",
);

console.log("semantic cluster correction authorization tests passed");
