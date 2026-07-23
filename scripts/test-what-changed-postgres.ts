import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { demoBrief } from "../lib/demo-data";
import { parseFeedDocument, type FeedDefinition } from "../lib/pipeline";
import {
  createEvidenceCitation,
  createHeadlineClaim,
} from "../lib/source-evidence";
import {
  compareSnapshotEvent,
  projectWhatChanged,
} from "../lib/what-changed";
import type {
  BriefSnapshotEventRecord,
  DailyBrief,
  EvidenceRetractionRequest,
  Headline,
  HeadlineClaim,
  RawStory,
  SnapshotEventChange,
  SourceEvidence,
  SourceLink,
} from "../lib/types";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the PostgreSQL What Changed test");
}

const raw = new Pool({ connectionString: process.env.DATABASE_URL });
const preMigrationTables = await raw.query<{ count: string }>(`
  SELECT COUNT(*)::text AS count
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
`);
assert.equal(
  Number(preMigrationTables.rows[0]?.count ?? 0),
  0,
  "the What Changed PostgreSQL test requires an isolated empty database",
);

const db = await import("../lib/db");
assert.equal((await db.databaseHealth()).ok, true);
assert.equal(
  (await raw.query(`
    SELECT 1 FROM schema_migrations
    WHERE id = '20260723_what_changed.sql'
  `)).rowCount,
  1,
  "the empty database must run the 7/23 migration through the real migration ledger",
);

const dayOne = "2095-07-22";
const dayTwo = "2095-07-23";
const feed: FeedDefinition = {
  name: "What Changed Test Wire",
  url: "https://what-changed.example/feed.xml",
  type: "News",
};

function feedXml(body: string): string {
  return [
    '<?xml version="1.0"?>',
    "<rss><channel><item>",
    "<guid>what-changed-guidance-event</guid>",
    "<title>Issuer updates revenue guidance</title>",
    "<link>https://what-changed.example/events/guidance</link>",
    "<pubDate>Sat, 22 Jul 2095 01:02:03 GMT</pubDate>",
    `<description>${body}</description>`,
    "</item></channel></rss>",
  ].join("");
}

function rawStory(body: string, collectedAt: string): RawStory {
  const story = parseFeedDocument(feed, feedXml(body), {
    collectedAt,
    mimeType: "application/rss+xml",
    httpStatus: 200,
  })[0];
  assert.ok(story, "the exact feed fixture must produce one source story");
  return story;
}

function requireEvidence(story: RawStory, anchor: "title" | "description"): SourceEvidence {
  const evidence = story.evidence?.find((item) => item.anchorKey === `feed:${anchor}`);
  assert.ok(evidence?.versionId, `${anchor} evidence must have an immutable evidence version`);
  assert.ok(
    evidence.sourceDocumentVersionId,
    `${anchor} evidence must have an immutable source-document version`,
  );
  return evidence;
}

function sourceLink(story: RawStory): SourceLink {
  assert.ok(story.sourceDocumentId);
  assert.ok(story.sourceDocumentVersionId);
  assert.ok(story.sourceObservationId);
  return {
    name: story.source,
    type: story.sourceType,
    role: "primary",
    url: story.url,
    sourceDocumentId: story.sourceDocumentId,
    sourceDocumentVersionId: story.sourceDocumentVersionId,
    sourceObservationId: story.sourceObservationId,
    nativeId: story.nativeId,
    feedNamespace: story.feedNamespace,
    canonicalUrl: story.canonicalUrl,
    originalTitle: story.originalTitle,
    contentHash: story.contentHash,
    publishedAt: story.publishedAt,
    originalPublishedAt: story.originalPublishedAt,
    publishedAtRaw: story.publishedAtRaw,
    publishedAtField: story.publishedAtField,
    sourceUpdatedAt: story.sourceUpdatedAt,
    collectedAt: story.collectedAt,
    timestampKind: story.timestampKind,
    capture: story.capture,
    evidence: story.evidence,
  };
}

function claim(
  claimKey: string,
  type: HeadlineClaim["type"],
  ordinal: number,
  statement: string,
  evidence: SourceEvidence,
): HeadlineClaim {
  return createHeadlineClaim({
    claimKey,
    type,
    ordinal,
    statement,
    originalStatement: statement,
    language: "en",
    verificationStatus: "supported",
    citations: [createEvidenceCitation(evidence)],
    generator: "deterministic",
    generatorVersion: "what-changed-postgres-test/v1",
  });
}

function headline(
  story: RawStory,
  body: string,
  direction: NonNullable<Headline["marketDirection"]>,
  id: string,
): Headline {
  const titleEvidence = requireEvidence(story, "title");
  const bodyEvidence = requireEvidence(story, "description");
  const keyPoint = "The issuer changed its FY2095 revenue guidance.";
  const marketImpact = "The revised guidance can change forward revenue expectations.";
  const directionRationale = direction === "bullish"
    ? "The supported guidance is potentially favorable for forward revenue expectations."
    : "The supported revision now indicates downside risk to forward revenue expectations.";
  const claims = [
    claim("title", "title", 0, story.title, titleEvidence),
    claim("summary", "summary", 1, body, bodyEvidence),
    claim("important_information:0", "important_information", 2, keyPoint, bodyEvidence),
    claim("market_impact", "market_impact", 3, marketImpact, bodyEvidence),
    claim("direction_rationale", "direction_rationale", 4, directionRationale, bodyEvidence),
  ];
  return {
    ...structuredClone(demoBrief.headlines[0]),
    id,
    rank: 1,
    ticker: "TEST",
    title: story.title,
    summary: body,
    keyPoints: [keyPoint],
    publishedAt: story.publishedAt,
    newsTimeSource: story.source,
    timestampKind: story.timestampKind,
    marketImpact,
    marketDirection: direction,
    directionConfidence: 88,
    directionRationale,
    equityImpacts: [],
    category: "Earnings",
    impact: 5,
    confidence: 92,
    mentions: 1,
    rankingScore: 90,
    freshnessScore: 90,
    crossSourceCount: 1,
    sentiment: direction === "bullish" ? "positive" : "negative",
    sources: [sourceLink(story)],
    claims,
    whatChanged: undefined,
  };
}

function brief(date: string, generatedAt: string, item: Headline): DailyBrief {
  return {
    ...structuredClone(demoBrief),
    id: undefined,
    date,
    generatedAt,
    mode: "live",
    status: "draft",
    publishedAt: undefined,
    storageMode: undefined,
    snapshot: undefined,
    headlines: [item],
    stats: {
      ...demoBrief.stats,
      candidates: 1,
      consolidatedEvents: 1,
      topStories: 1,
      sourcesOnline: 1,
    },
    socialBuzz: { reddit: [], x: [] },
  };
}

function changeKinds(item: Headline, baseline: "investor" | "operational" | "latestVersion") {
  return item.whatChanged?.[baseline].items.map((change) => change.kind) ?? [];
}

const bodyV1 = "For FY2095, revenue guidance was USD 10bn.";
const persistedStoryV1 = (
  await db.saveSourceStories([rawStory(bodyV1, `${dayOne}T02:00:00.000Z`)])
).stories[0];
const draftOne = await db.saveDraft(
  brief(
    dayOne,
    `${dayOne}T03:00:00.000Z`,
    headline(persistedStoryV1, bodyV1, "bullish", "temporary-what-changed-event"),
  ),
  {
    stream: "manual",
    batchKey: "what-changed-postgres-day-1-draft",
    observedAt: `${dayOne}T03:00:00.000Z`,
  },
);
assert.deepEqual(
  await db.verifyBriefEvidenceAuthority(draftOne.brief),
  [],
  "the first exact source/evidence/claim snapshot must match PostgreSQL authority",
);
const eventId = draftOne.brief.headlines[0].id;
const versionOne = (await db.listEventVersions(eventId))[0];
assert.ok(versionOne);
assert.equal(versionOne.comparison?.status, "first_seen");
assert.deepEqual(changeKinds(draftOne.brief.headlines[0], "latestVersion"), ["first_seen"]);

const publishedOne = await db.publishBrief(
  draftOne.id,
  draftOne.brief,
  Buffer.from("what-changed-day-one-pdf"),
  {
    stream: "publish",
    batchKey: "what-changed-postgres-day-1-publish",
    observedAt: `${dayOne}T03:10:00.000Z`,
  },
);
assert.equal(publishedOne.status, "published");
assert.deepEqual(await db.verifyBriefEvidenceAuthority(publishedOne.brief), []);
const publishedOneSnapshotId = publishedOne.brief.snapshot?.id;
assert.ok(publishedOneSnapshotId);

const bodyV2 = "For FY2095, revenue guidance was USD 12bn.";
const persistedStoryV2 = (
  await db.saveSourceStories([rawStory(bodyV2, `${dayTwo}T02:00:00.000Z`)])
).stories[0];
const draftTwo = await db.saveDraft(
  brief(
    dayTwo,
    `${dayTwo}T03:00:00.000Z`,
    headline(persistedStoryV2, bodyV2, "bearish", eventId),
  ),
  {
    stream: "manual",
    batchKey: "what-changed-postgres-day-2-draft",
    observedAt: `${dayTwo}T03:00:00.000Z`,
  },
);
assert.equal(
  draftTwo.date,
  dayTwo,
  "a PostgreSQL DATE must retain its Beijing/Taipei calendar day instead of shifting through UTC",
);
assert.deepEqual(await db.verifyBriefEvidenceAuthority(draftTwo.brief), []);
let eventVersions = await db.listEventVersions(eventId);
assert.equal(eventVersions.length, 2);
const versionTwo = eventVersions[1];
assert.equal(versionTwo.previousVersionId, versionOne.id);
assert.equal(versionTwo.comparison?.status, "changed");
assert.equal(
  versionTwo.comparison?.items.some((item) => item.kind === "numeric_changed"),
  true,
);
assert.equal(
  versionTwo.comparison?.items.some((item) => item.kind === "direction_changed"),
  true,
);
const draftTwoWhatChanged = draftTwo.brief.headlines[0].whatChanged;
assert.ok(draftTwoWhatChanged);
assert.equal(draftTwoWhatChanged.investor.baselineSnapshotId, publishedOneSnapshotId);
assert.equal(draftTwoWhatChanged.investor.baselineEventVersionId, versionOne.id);
assert.equal(draftTwoWhatChanged.investor.currentEventVersionId, versionTwo.id);
assert.equal(changeKinds(draftTwo.brief.headlines[0], "investor").includes("numeric_changed"), true);

const reviewerHash = "a".repeat(64);
const reviewedTwo = await db.updateDraft(draftTwo.id, draftTwo.brief, {
  stream: "review",
  batchKey: "what-changed-postgres-day-2-review",
  observedAt: `${dayTwo}T03:10:00.000Z`,
  expectedSnapshotId: draftTwo.brief.snapshot?.id,
  actor: {
    type: "admin",
    idHash: reviewerHash,
    reason: "Reviewed the exact What Changed projection without editing event material",
    requestId: "what-changed-review-request",
  },
});
eventVersions = await db.listEventVersions(eventId);
assert.equal(eventVersions.length, 2, "a review-only snapshot must reuse v2");
const reviewedHeadline = reviewedTwo.brief.headlines[0];
assert.equal(reviewedHeadline.whatChanged?.investor.baselineEventVersionId, versionOne.id);
assert.equal(reviewedHeadline.whatChanged?.investor.currentEventVersionId, versionTwo.id);
assert.equal(changeKinds(reviewedHeadline, "investor").includes("numeric_changed"), true);
assert.equal(reviewedHeadline.whatChanged?.operational.baselineEventVersionId, versionTwo.id);
assert.equal(reviewedHeadline.whatChanged?.operational.currentEventVersionId, versionTwo.id);
assert.equal(changeKinds(reviewedHeadline, "operational").includes("numeric_changed"), false);
assert.deepEqual(await db.verifyBriefEvidenceAuthority(reviewedTwo.brief), []);

const publishedTwo = await db.publishBrief(
  reviewedTwo.id,
  reviewedTwo.brief,
  Buffer.from("what-changed-day-two-pdf"),
  {
    stream: "publish",
    batchKey: "what-changed-postgres-day-2-publish",
    observedAt: `${dayTwo}T03:20:00.000Z`,
    actor: {
      type: "admin",
      idHash: reviewerHash,
      reason: "Publish the reviewed What Changed snapshot",
      requestId: "what-changed-publish-request",
    },
  },
);
assert.equal(publishedTwo.status, "published");
assert.deepEqual(await db.verifyBriefEvidenceAuthority(publishedTwo.brief), []);
const publishedTwoHeadline = publishedTwo.brief.headlines[0];
assert.equal(
  publishedTwoHeadline.whatChanged?.investor.baselineEventVersionId,
  versionOne.id,
  "publishing S3 must retain the investor v1 baseline",
);
assert.equal(
  publishedTwoHeadline.whatChanged?.investor.currentEventVersionId,
  versionTwo.id,
  "publishing S3 must retain the investor v1→v2 endpoint",
);
assert.equal(changeKinds(publishedTwoHeadline, "investor").includes("numeric_changed"), true);
assert.equal(publishedTwoHeadline.whatChanged?.operational.baselineEventVersionId, versionTwo.id);
assert.equal(changeKinds(publishedTwoHeadline, "operational").includes("numeric_changed"), false);

const storedComparisons = await raw.query<{
  current_version_id: string;
  previous_version_id: string | null;
  status: string;
}>(`
  SELECT current_version_id, previous_version_id, status
  FROM event_version_comparisons
  WHERE event_id = $1
  ORDER BY compared_at
`, [eventId]);
assert.deepEqual(
  storedComparisons.rows,
  [
    {
      current_version_id: versionOne.id,
      previous_version_id: null,
      status: "first_seen",
    },
    {
      current_version_id: versionTwo.id,
      previous_version_id: versionOne.id,
      status: "changed",
    },
  ],
);
const numericFacts = await raw.query<{
  event_version_id: string;
  value_canonical: string;
  comparison_status: string;
  evidence_count: number;
}>(`
  SELECT
    fact.event_version_id,
    fact.value_canonical,
    fact.comparison_status,
    COUNT(binding.evidence_version_id)::integer AS evidence_count
  FROM event_version_numeric_facts AS fact
  LEFT JOIN event_version_numeric_fact_evidence AS binding
    ON binding.event_id = fact.event_id
   AND binding.event_version_id = fact.event_version_id
   AND binding.fact_key = fact.fact_key
  WHERE fact.event_id = $1
  GROUP BY
    fact.event_version_id, fact.value_canonical, fact.comparison_status,
    fact.created_at
  ORDER BY fact.created_at
`, [eventId]);
assert.deepEqual(
  numericFacts.rows.map((row) => ({
    eventVersionId: row.event_version_id,
    value: row.value_canonical,
    status: row.comparison_status,
    evidenceCount: row.evidence_count,
  })),
  [
    {
      eventVersionId: versionOne.id,
      value: "10000000000",
      status: "comparable",
      evidenceCount: 1,
    },
    {
      eventVersionId: versionTwo.id,
      value: "12000000000",
      status: "comparable",
      evidenceCount: 1,
    },
  ],
  "numeric facts must preserve exact normalized values and exact evidence bindings for v1 and v2",
);

const publishedTwoSnapshotId = publishedTwo.brief.snapshot?.id;
assert.ok(publishedTwoSnapshotId);
const baselineRows = await raw.query<{
  baseline_kind: string;
  baseline_snapshot_id: string | null;
  baseline_event_version_id: string | null;
  current_event_version_id: string;
}>(`
  SELECT baseline_kind, baseline_snapshot_id, baseline_event_version_id,
         current_event_version_id
  FROM brief_snapshot_event_changes
  WHERE current_snapshot_id = $1 AND event_id = $2
  ORDER BY baseline_kind
`, [publishedTwoSnapshotId, eventId]);
assert.equal(baselineRows.rowCount, 2, "every snapshot event must persist both comparison baselines");
const investorRow = baselineRows.rows.find((row) => row.baseline_kind === "previous_published");
const operationalRow = baselineRows.rows.find((row) => row.baseline_kind === "previous_observation");
assert.equal(investorRow?.baseline_snapshot_id, publishedOneSnapshotId);
assert.equal(investorRow?.baseline_event_version_id, versionOne.id);
assert.equal(investorRow?.current_event_version_id, versionTwo.id);
assert.equal(operationalRow?.baseline_event_version_id, versionTwo.id);
assert.equal(operationalRow?.current_event_version_id, versionTwo.id);

const forgedWhatChanged = structuredClone(publishedTwo.brief);
assert.ok(forgedWhatChanged.headlines[0].whatChanged);
forgedWhatChanged.headlines[0].whatChanged!.summary = "伪造的变化摘要";
const forgedIssues = await db.verifyBriefEvidenceAuthority(forgedWhatChanged);
assert.equal(
  forgedIssues.some((issue) => issue.code === "WHAT_CHANGED_AUTHORITY_MISMATCH"),
  true,
  "a client cannot replace the normalized PostgreSQL What Changed projection",
);

const bodyEvidenceV2 = requireEvidence(persistedStoryV2, "description");
const claimScopedAttack = structuredClone(publishedTwoHeadline);
delete claimScopedAttack.whatChanged;
claimScopedAttack.claims = claimScopedAttack.claims?.filter(
  (item) => item.claimKey !== "market_impact",
);
const versionsBeforeClaimScopeAttack = (await db.listEventVersions(eventId)).length;
await assert.rejects(
  () => db.persistBriefObservation(
    brief(dayTwo, `${dayTwo}T03:25:00.000Z`, claimScopedAttack),
    {
      stream: "review",
      batchKey: "what-changed-claim-scope-attack",
      observedAt: `${dayTwo}T03:25:00.000Z`,
      actor: {
        type: "admin",
        idHash: reviewerHash,
        reason: "Adversarial attempt to use a summary retraction for another claim",
        requestId: "what-changed-claim-scope-attack-actor",
      },
      evidenceRetractions: [{
        requestId: "what-changed-claim-scope-attack",
        eventId,
        fromEventVersionId: versionTwo.id,
        evidenceItemId: bodyEvidenceV2.id,
        evidenceVersionId: bodyEvidenceV2.versionId!,
        claimKey: "summary",
        citationRelation: "supports",
        reasonCode: "review_rejected",
        reasonNote: "This request is intentionally scoped only to the summary claim.",
      }],
    },
  ),
  (error: unknown) => (
    error instanceof db.EvidenceIntegrityError
    && error.issues.some((issue) => issue.code === "UNAUTHORIZED_EVIDENCE_REMOVAL")
  ),
  "a claim-A retraction must not authorize a claim-B or global evidence removal",
);
assert.equal(
  (await db.listEventVersions(eventId)).length,
  versionsBeforeClaimScopeAttack,
  "a cross-claim retraction attack must leave the immutable event chain unchanged",
);

const temporarilyMissingHeadline = structuredClone(publishedTwoHeadline);
delete temporarilyMissingHeadline.whatChanged;
temporarilyMissingHeadline.sources = temporarilyMissingHeadline.sources.map((source) => ({
  ...source,
  evidence: [],
}));
const temporaryMiss = await db.persistBriefObservation(
  brief(
    dayTwo,
    `${dayTwo}T03:30:00.000Z`,
    temporarilyMissingHeadline,
  ),
  {
    stream: "cron",
    batchKey: "what-changed-postgres-temporary-source-miss",
    observedAt: `${dayTwo}T03:30:00.000Z`,
  },
);
eventVersions = await db.listEventVersions(eventId);
assert.equal(
  eventVersions.length,
  2,
  "a temporary collection miss must retain exact historical evidence and reuse v2",
);
assert.equal(
  temporaryMiss.brief.headlines[0].whatChanged?.latestVersion.currentVersionId,
  versionTwo.id,
);
assert.equal(
  temporaryMiss.brief.headlines[0].whatChanged?.latestVersion.items.some(
    (item) => item.kind === "evidence_removed",
  ),
  false,
  "a temporary collection miss must not manufacture an evidence removal",
);

const retraction: EvidenceRetractionRequest = {
  requestId: "what-changed-explicit-retraction",
  eventId,
  fromEventVersionId: versionTwo.id,
  evidenceItemId: bodyEvidenceV2.id,
  evidenceVersionId: bodyEvidenceV2.versionId!,
  reasonCode: "source_retracted",
  reasonNote: "The source withdrew this exact guidance paragraph.",
};
const retractionHeadline = structuredClone(publishedTwoHeadline);
delete retractionHeadline.whatChanged;
const retractionSnapshot = await db.persistBriefObservation(
  brief(
    dayTwo,
    `${dayTwo}T03:40:00.000Z`,
    retractionHeadline,
  ),
  {
    stream: "review",
    batchKey: "what-changed-postgres-explicit-retraction",
    observedAt: `${dayTwo}T03:40:00.000Z`,
    actor: {
      type: "admin",
      idHash: reviewerHash,
      reason: "Retract an exact source paragraph after source withdrawal",
      requestId: "what-changed-retraction-actor-request",
    },
    evidenceRetractions: [retraction],
  },
);
eventVersions = await db.listEventVersions(eventId);
assert.equal(eventVersions.length, 3);
const versionThree = eventVersions[2];
assert.equal(versionThree.previousVersionId, versionTwo.id);
assert.equal(
  versionThree.comparison?.items.some((item) => item.kind === "evidence_removed"),
  true,
);
assert.equal(
  versionThree.comparison?.items.some((item) => item.kind === "claim_support_removed"),
  true,
);
assert.equal(
  retractionSnapshot.brief.headlines[0].whatChanged?.latestVersion.currentVersionId,
  versionThree.id,
);
const storedRetraction = await raw.query<{
  from_event_version_id: string;
  to_event_version_id: string;
  evidence_version_id: string;
  actor_id_hash: string;
}>(`
  SELECT from_event_version_id, to_event_version_id, evidence_version_id,
         actor_id_hash
  FROM evidence_retraction_requests
  WHERE request_id = $1
`, [retraction.requestId]);
assert.deepEqual(storedRetraction.rows[0], {
  from_event_version_id: versionTwo.id,
  to_event_version_id: versionThree.id,
  evidence_version_id: bodyEvidenceV2.versionId!,
  actor_id_hash: reviewerHash,
});

const firstRetractionBindings = await raw.query<{
  kind: string;
  request_id: string;
  evidence_version_id: string;
}>(`
  SELECT item.kind, binding.request_id, binding.evidence_version_id
  FROM event_version_change_item_retractions AS binding
  JOIN event_version_change_items AS item
    ON item.event_id = binding.event_id
   AND item.current_version_id = binding.current_version_id
   AND item.algorithm_version = binding.algorithm_version
   AND item.item_id = binding.item_id
  WHERE binding.event_id = $1
    AND binding.current_version_id = $2
  ORDER BY item.kind
`, [eventId, versionThree.id]);
const versionThreeRemovalItems = versionThree.comparison?.items.filter((item) =>
  item.kind === "evidence_removed" || item.kind === "claim_support_removed") ?? [];
assert.equal(firstRetractionBindings.rows.length, versionThreeRemovalItems.length);
assert.equal(
  firstRetractionBindings.rows.some((row) => row.kind === "evidence_removed"),
  true,
);
assert.equal(
  firstRetractionBindings.rows.some((row) => row.kind === "claim_support_removed"),
  true,
);
assert.equal(
  firstRetractionBindings.rows.every((row) =>
    row.request_id === retraction.requestId
    && row.evidence_version_id === bodyEvidenceV2.versionId!
    && (row.kind === "evidence_removed" || row.kind === "claim_support_removed")),
  true,
  "every evidence/support removal must be bound to the exact explicit retraction request",
);

const bodyV4 = "For FY2095, revenue guidance was USD 13bn.";
const persistedStoryV4 = (
  await db.saveSourceStories([rawStory(bodyV4, `${dayTwo}T03:45:00.000Z`)])
).stories[0];
const titleEvidenceV2 = requireEvidence(persistedStoryV2, "title");
const titleEvidenceV4 = requireEvidence(persistedStoryV4, "title");
const bodyEvidenceV4 = requireEvidence(persistedStoryV4, "description");
const replacementHeadline = headline(persistedStoryV4, bodyV4, "bearish", eventId);

const versionsBeforeBadReplacement = (await db.listEventVersions(eventId)).length;
await assert.rejects(
  () => db.persistBriefObservation(
    brief(dayTwo, `${dayTwo}T03:45:00.000Z`, replacementHeadline),
    {
      stream: "review",
      batchKey: "what-changed-postgres-invalid-replacement-support",
      observedAt: `${dayTwo}T03:45:00.000Z`,
      actor: {
        type: "admin",
        idHash: reviewerHash,
        reason: "Adversarial invalid replacement-support attempt",
        requestId: "what-changed-invalid-replacement-actor",
      },
      evidenceRetractions: [{
        requestId: "what-changed-invalid-replacement",
        eventId,
        fromEventVersionId: versionThree.id,
        evidenceItemId: titleEvidenceV2.id,
        evidenceVersionId: titleEvidenceV2.versionId!,
        claimKey: "title",
        citationRelation: "supports",
        reasonCode: "superseded",
        reasonNote: "Attempt to bind the title claim to unrelated body evidence.",
        replacementEvidenceVersionId: bodyEvidenceV4.versionId!,
      }],
    },
  ),
  (error: unknown) => (
    error instanceof db.EvidenceIntegrityError
    && error.issues.some((issue) =>
      issue.code === "RETRACTION_REPLACEMENT_SUPPORT_MISSING")
  ),
  "a replacement must be exact support for the same claim, not merely evidence present in the target version",
);
assert.equal(
  (await db.listEventVersions(eventId)).length,
  versionsBeforeBadReplacement,
  "an invalid replacement-support request must leave the immutable version chain unchanged",
);

const replacementRequest: EvidenceRetractionRequest = {
  requestId: "what-changed-valid-replacement",
  eventId,
  fromEventVersionId: versionThree.id,
  evidenceItemId: titleEvidenceV2.id,
  evidenceVersionId: titleEvidenceV2.versionId!,
  claimKey: "title",
  citationRelation: "supports",
  reasonCode: "superseded",
  reasonNote: "The new source-document version replaces the exact title support.",
  replacementEvidenceVersionId: titleEvidenceV4.versionId!,
};
const replacementSnapshot = await db.persistBriefObservation(
  brief(dayTwo, `${dayTwo}T03:50:00.000Z`, replacementHeadline),
  {
    stream: "review",
    batchKey: "what-changed-postgres-valid-replacement-support",
    observedAt: `${dayTwo}T03:50:00.000Z`,
    actor: {
      type: "admin",
      idHash: reviewerHash,
      reason: "Replace exact title support with the new source revision",
      requestId: "what-changed-valid-replacement-actor",
    },
    evidenceRetractions: [replacementRequest],
  },
);
eventVersions = await db.listEventVersions(eventId);
assert.equal(eventVersions.length, 4);
const versionFour = eventVersions[3];
assert.equal(versionFour.previousVersionId, versionThree.id);
assert.equal(
  replacementSnapshot.brief.headlines[0].whatChanged?.latestVersion.currentVersionId,
  versionFour.id,
);
const exactReplacement = await raw.query<{
  replacement_evidence_version_id: string;
  target_evidence_count: number;
  target_claim_support_count: number;
}>(`
  SELECT
    request.replacement_evidence_version_id,
    (
      SELECT COUNT(*)::integer
      FROM event_version_evidence AS evidence
      WHERE evidence.event_id = request.event_id
        AND evidence.event_version_id = request.to_event_version_id
        AND evidence.evidence_version_id = request.replacement_evidence_version_id
    ) AS target_evidence_count,
    (
      SELECT COUNT(*)::integer
      FROM claim_evidence_links AS support
      WHERE support.event_id = request.event_id
        AND support.event_version_id = request.to_event_version_id
        AND support.claim_key = request.claim_key
        AND support.evidence_version_id = request.replacement_evidence_version_id
        AND support.relation = 'supports'
    ) AS target_claim_support_count
  FROM evidence_retraction_requests AS request
  WHERE request.request_id = $1
`, [replacementRequest.requestId]);
assert.deepEqual(exactReplacement.rows[0], {
  replacement_evidence_version_id: titleEvidenceV4.versionId!,
  target_evidence_count: 1,
  target_claim_support_count: 1,
});

const replacementBindings = await raw.query<{
  kind: string;
  request_id: string;
  evidence_version_id: string;
}>(`
  SELECT item.kind, binding.request_id, binding.evidence_version_id
  FROM event_version_change_item_retractions AS binding
  JOIN event_version_change_items AS item
    ON item.event_id = binding.event_id
   AND item.current_version_id = binding.current_version_id
   AND item.algorithm_version = binding.algorithm_version
   AND item.item_id = binding.item_id
  WHERE binding.event_id = $1
    AND binding.current_version_id = $2
    AND binding.request_id = $3
  ORDER BY item.kind
`, [eventId, versionFour.id, replacementRequest.requestId]);
assert.equal(
  replacementBindings.rows.length >= 1,
  true,
  "the valid replacement request must bind every removal it authorizes",
);
assert.equal(
  replacementBindings.rows.some((row) => row.kind === "evidence_revised"),
  false,
  "a claim-scoped request must not authorize a global evidence revision",
);
assert.equal(
  replacementBindings.rows.some((row) => row.kind === "claim_support_changed"),
  true,
  "same-claim replacement support must be audited as an exact support revision",
);
assert.equal(
  replacementBindings.rows.every((row) =>
    row.request_id === replacementRequest.requestId
    && row.evidence_version_id === titleEvidenceV2.versionId!
    && (row.kind === "claim_support_removed" || row.kind === "claim_support_changed")),
  true,
);

const publicationAudit = await raw.query<{
  brief_id: string;
  snapshot_id: string;
  snapshot_payload_hash: string;
  authoritative_snapshot_payload_hash: string;
  pdf_sha256: string;
  actor_type: string;
  actor_id_hash: string | null;
  action_reason: string | null;
  request_id: string | null;
  published_at: string | Date;
}>(`
  SELECT audit.brief_id, audit.snapshot_id, audit.snapshot_payload_hash,
         snapshot.payload_hash AS authoritative_snapshot_payload_hash,
         audit.pdf_sha256, audit.actor_type, audit.actor_id_hash,
         audit.action_reason, audit.request_id, audit.published_at
  FROM brief_publication_audits AS audit
  JOIN brief_snapshots AS snapshot ON snapshot.id = audit.snapshot_id
  WHERE audit.brief_id = $1
`, [publishedTwo.id]);
assert.equal(publicationAudit.rowCount, 1);
assert.deepEqual(
  {
    briefId: publicationAudit.rows[0].brief_id,
    snapshotId: publicationAudit.rows[0].snapshot_id,
    snapshotPayloadHash: publicationAudit.rows[0].snapshot_payload_hash,
    authoritativeSnapshotPayloadHash:
      publicationAudit.rows[0].authoritative_snapshot_payload_hash,
    pdfSha256: publicationAudit.rows[0].pdf_sha256,
    actorType: publicationAudit.rows[0].actor_type,
    actorIdHash: publicationAudit.rows[0].actor_id_hash,
    actionReason: publicationAudit.rows[0].action_reason,
    requestId: publicationAudit.rows[0].request_id,
    publishedAt: new Date(publicationAudit.rows[0].published_at).toISOString(),
  },
  {
    briefId: publishedTwo.id,
    snapshotId: publishedTwoSnapshotId,
    snapshotPayloadHash: publicationAudit.rows[0].authoritative_snapshot_payload_hash,
    authoritativeSnapshotPayloadHash:
      publicationAudit.rows[0].authoritative_snapshot_payload_hash,
    pdfSha256: createHash("sha256")
      .update(Buffer.from("what-changed-day-two-pdf"))
      .digest("hex"),
    actorType: "admin",
    actorIdHash: reviewerHash,
    actionReason: "Publish the reviewed What Changed snapshot",
    requestId: "what-changed-publish-request",
    publishedAt: publishedTwo.publishedAt,
  },
  "publication audit must freeze the exact snapshot hash, PDF hash and pseudonymous actor",
);

async function immutableContentCounts(): Promise<{
  snapshots: number;
  versions: number;
  comparisons: number;
  dailyBriefs: number;
}> {
  const result = await raw.query<{
    snapshots: number;
    versions: number;
    comparisons: number;
    daily_briefs: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
      (SELECT COUNT(*)::integer FROM event_versions) AS versions,
      (SELECT COUNT(*)::integer FROM event_version_comparisons) AS comparisons,
      (SELECT COUNT(*)::integer FROM daily_briefs) AS daily_briefs
  `);
  return {
    snapshots: result.rows[0].snapshots,
    versions: result.rows[0].versions,
    comparisons: result.rows[0].comparisons,
    dailyBriefs: result.rows[0].daily_briefs,
  };
}

const beforeReverseEvent = await immutableContentCounts();
await assert.rejects(
  () => db.persistBriefObservation(
    brief(
      "2095-07-24",
      "2095-07-24T03:00:00.000Z",
      headline(persistedStoryV4, bodyV4, "bullish", eventId),
    ),
    {
      stream: "cron",
      batchKey: "what-changed-postgres-reverse-event-time",
      observedAt: `${dayTwo}T03:49:59.000Z`,
    },
  ),
  (error: unknown) => (
    error instanceof db.EvidenceIntegrityError
    && error.issues.some((issue) => issue.code === "EVENT_OBSERVATION_TIME_REGRESSION")
  ),
  "an event-material change observed before its immutable predecessor must fail closed",
);
assert.deepEqual(
  await immutableContentCounts(),
  beforeReverseEvent,
  "a reversed event observation must not append a snapshot, event version or daily brief",
);

const beforeReverseSnapshot = await immutableContentCounts();
const unchangedReplacementHeadline = structuredClone(replacementSnapshot.brief.headlines[0]);
delete unchangedReplacementHeadline.whatChanged;
await assert.rejects(
  () => db.persistBriefObservation(
    brief(dayTwo, `${dayTwo}T03:49:59.000Z`, unchangedReplacementHeadline),
    {
      stream: "cron",
      batchKey: "what-changed-postgres-reverse-snapshot-time",
      observedAt: `${dayTwo}T03:55:00.000Z`,
    },
  ),
  (error: unknown) => (
    error instanceof db.EvidenceIntegrityError
    && error.issues.some((issue) => issue.code === "SNAPSHOT_GENERATED_TIME_REGRESSION")
  ),
  "a same-date snapshot generated before its immediate predecessor must fail closed",
);
assert.deepEqual(
  await immutableContentCounts(),
  beforeReverseSnapshot,
  "a reversed snapshot timestamp must leave the immutable snapshot chain unchanged",
);

function snapshotEvent(
  savedBrief: DailyBrief,
  targetEventId: string,
): BriefSnapshotEventRecord {
  const snapshotId = savedBrief.snapshot?.id;
  const event = savedBrief.snapshot?.events.find((candidate) =>
    candidate.eventId === targetEventId);
  assert.ok(snapshotId && event, `snapshot event ${targetEventId} must exist`);
  return { ...event, snapshotId };
}

async function createPublishedUnchangedDay(
  date: string,
  requestSuffix: string,
): Promise<Awaited<ReturnType<typeof db.publishBrief>>> {
  const item = structuredClone(replacementSnapshot.brief.headlines[0]);
  delete item.whatChanged;
  const saved = await db.saveDraft(
    brief(date, `${date}T03:00:00.000Z`, item),
    {
      stream: "manual",
      batchKey: `what-changed-${requestSuffix}-draft`,
      observedAt: `${date}T03:00:00.000Z`,
    },
  );
  return db.publishBrief(
    saved.id,
    saved.brief,
    Buffer.from(`what-changed-${requestSuffix}-pdf`),
    {
      stream: "publish",
      batchKey: `what-changed-${requestSuffix}-publish`,
      observedAt: `${date}T03:05:00.000Z`,
      actor: {
        type: "admin",
        idHash: reviewerHash,
        reason: `Publish unchanged ${requestSuffix} baseline fixture`,
        requestId: `what-changed-${requestSuffix}-publish-request`,
      },
    },
  );
}

const dayThree = "2095-07-24";
const dayFour = "2095-07-25";
const dayFive = "2095-07-26";
const daySix = "2095-07-27";
const daySeven = "2095-07-28";
const publishedThree = await createPublishedUnchangedDay(dayThree, "day-three");
const publishedFour = await createPublishedUnchangedDay(dayFour, "day-four");
assert.equal(
  publishedThree.brief.snapshot?.events[0].eventVersionId,
  versionFour.id,
);
assert.equal(
  publishedFour.brief.snapshot?.events[0].eventVersionId,
  versionFour.id,
);

async function observeUnchanged(
  date: string,
  generatedAt: string,
  batchKey: string,
  observedAt = generatedAt,
) {
  const item = structuredClone(replacementSnapshot.brief.headlines[0]);
  delete item.whatChanged;
  return db.persistBriefObservation(brief(date, generatedAt, item), {
    stream: "cron",
    batchKey,
    observedAt,
  });
}

const dayFiveOne = await observeUnchanged(
  dayFive,
  `${dayFive}T03:00:00.000Z`,
  "what-changed-day-five-observation-1",
);
const dayFiveTwo = await observeUnchanged(
  dayFive,
  `${dayFive}T03:10:00.000Z`,
  "what-changed-day-five-observation-2",
);
const dayFiveThree = await observeUnchanged(
  dayFive,
  `${dayFive}T03:20:00.000Z`,
  "what-changed-day-five-observation-3",
);
assert.deepEqual(await db.verifyBriefEvidenceAuthority(dayFiveThree.brief), []);
assert.equal(
  dayFiveThree.brief.headlines[0].whatChanged?.operational.baselineSnapshotId,
  dayFiveTwo.brief.snapshot?.id,
  "the operational baseline must be the immediately preceding same-date observation",
);
assert.equal(
  dayFiveThree.brief.headlines[0].whatChanged?.investor.baselineSnapshotId,
  publishedFour.brief.snapshot?.id,
  "the investor baseline must be the immediately preceding published date",
);

async function replaceStoredSnapshotChange(
  snapshotId: string,
  change: SnapshotEventChange,
  historicalObservation?: BriefSnapshotEventRecord,
): Promise<void> {
  await raw.query(`
    ALTER TABLE brief_snapshot_event_changes
    DISABLE TRIGGER brief_snapshot_event_changes_immutable
  `);
  try {
    const result = await raw.query(`
      UPDATE brief_snapshot_event_changes
      SET baseline_snapshot_id = $4,
          baseline_event_id = $5,
          baseline_event_version_id = $6,
          historical_observation_snapshot_id = $7,
          historical_observation_event_id = $8,
          historical_observation_event_version_id = $9,
          presence = $10,
          previous_rank = $11,
          current_rank = $12,
          rank_delta = $13,
          rank_movement = $14,
          status = $15,
          input_hash = $16,
          result_hash = $17,
          summary = $18,
          compared_at = $19
      WHERE current_snapshot_id = $1
        AND event_id = $2
        AND baseline_kind = $3
    `, [
      snapshotId,
      change.eventId,
      change.baselineKind,
      change.baselineSnapshotId ?? null,
      change.baselineEventVersionId ? change.eventId : null,
      change.baselineEventVersionId ?? null,
      historicalObservation?.snapshotId ?? null,
      historicalObservation?.eventId ?? null,
      historicalObservation?.eventVersionId ?? null,
      change.presence,
      change.previousRank ?? null,
      change.currentRank,
      change.rankDelta ?? null,
      change.rankMovement,
      change.status,
      change.inputHash,
      change.resultHash,
      change.summary,
      change.comparedAt,
    ]);
    assert.equal(result.rowCount, 1);
  } finally {
    await raw.query(`
      ALTER TABLE brief_snapshot_event_changes
      ENABLE TRIGGER brief_snapshot_event_changes_immutable
    `);
  }
}

async function expectSemanticBaselineForgeryRejected(
  sourceBrief: DailyBrief,
  baselineKind: "previous_observation" | "previous_published",
  forgedChange: SnapshotEventChange,
  forgedHistorical: BriefSnapshotEventRecord | undefined,
  originalHistorical: BriefSnapshotEventRecord | undefined,
  label: string,
): Promise<void> {
  const snapshotId = sourceBrief.snapshot?.id;
  const originalWhatChanged = sourceBrief.headlines[0].whatChanged;
  assert.ok(snapshotId && originalWhatChanged);
  const originalChange = baselineKind === "previous_observation"
    ? originalWhatChanged.operational
    : originalWhatChanged.investor;
  assert.deepEqual(
    forgedChange.items,
    originalChange.items,
    `${label}: adversarial endpoint must retain identical human-visible change items`,
  );
  assert.equal(
    forgedChange.resultHash,
    originalChange.resultHash,
    `${label}: semantic endpoint attack must remain result-hash consistent`,
  );

  await replaceStoredSnapshotChange(snapshotId, forgedChange, forgedHistorical);
  try {
    const forgedBrief = structuredClone(sourceBrief);
    forgedBrief.headlines[0].whatChanged = projectWhatChanged({
      investor: baselineKind === "previous_published"
        ? forgedChange
        : originalWhatChanged.investor,
      operational: baselineKind === "previous_observation"
        ? forgedChange
        : originalWhatChanged.operational,
      latestVersion: originalWhatChanged.latestVersion,
    });
    const issues = await db.verifyBriefEvidenceAuthority(forgedBrief);
    assert.equal(
      issues.some((issue) => issue.code === "WHAT_CHANGED_INTERNAL_INTEGRITY_INVALID"),
      true,
      `${label}: authority must independently reselect the endpoint instead of trusting stored IDs`,
    );
  } finally {
    await replaceStoredSnapshotChange(snapshotId, originalChange, originalHistorical);
  }
}

const dayFiveCurrentEvent = snapshotEvent(dayFiveThree.brief, eventId);
const wrongOperationalEvent = snapshotEvent(dayFiveOne.brief, eventId);
const originalOperational = dayFiveThree.brief.headlines[0].whatChanged?.operational;
assert.ok(originalOperational);
const forgedOperational = compareSnapshotEvent({
  baselineKind: "previous_observation",
  baselineSnapshotId: dayFiveOne.brief.snapshot?.id,
  baselineEvent: wrongOperationalEvent,
  current: dayFiveCurrentEvent,
  currentSnapshotId: dayFiveThree.brief.snapshot!.id,
  comparedAt: originalOperational.comparedAt,
  isFirstSeen: false,
  legacyUnverified: false,
});
await expectSemanticBaselineForgeryRejected(
  dayFiveThree.brief,
  "previous_observation",
  forgedOperational,
  undefined,
  undefined,
  "wrong operational baseline",
);

const wrongPublishedEvent = snapshotEvent(publishedThree.brief, eventId);
const originalInvestor = dayFiveThree.brief.headlines[0].whatChanged?.investor;
assert.ok(originalInvestor);
const forgedInvestor = compareSnapshotEvent({
  baselineKind: "previous_published",
  baselineSnapshotId: publishedThree.brief.snapshot?.id,
  baselineEvent: wrongPublishedEvent,
  current: dayFiveCurrentEvent,
  currentSnapshotId: dayFiveThree.brief.snapshot!.id,
  comparedAt: originalInvestor.comparedAt,
  isFirstSeen: false,
  legacyUnverified: false,
});
await expectSemanticBaselineForgeryRejected(
  dayFiveThree.brief,
  "previous_published",
  forgedInvestor,
  undefined,
  undefined,
  "wrong previous-published baseline",
);

const futureObservation = await observeUnchanged(
  daySeven,
  `${daySeven}T03:00:00.000Z`,
  "what-changed-future-observation",
);
const boundedBackfill = await observeUnchanged(
  daySix,
  `${daySix}T03:00:00.000Z`,
  "what-changed-bounded-backfill",
  `${daySeven}T03:10:00.000Z`,
);
const boundedOperational = boundedBackfill.brief.headlines[0].whatChanged?.operational;
assert.ok(boundedOperational);
assert.equal(
  boundedOperational.historicalObservationSnapshotId,
  dayFiveThree.brief.snapshot?.id,
  "historical observation must be the latest event observation before the current date/sequence boundary",
);
assert.notEqual(
  boundedOperational.historicalObservationSnapshotId,
  futureObservation.brief.snapshot?.id,
  "a later-dated snapshot must never become a historical observation for a backfilled snapshot",
);
const boundedCurrentEvent = snapshotEvent(boundedBackfill.brief, eventId);
const correctHistoricalEvent = snapshotEvent(dayFiveThree.brief, eventId);
const forgedFutureHistoricalEvent = snapshotEvent(futureObservation.brief, eventId);
const forgedHistorical = compareSnapshotEvent({
  baselineKind: "previous_observation",
  baselineSnapshotId: undefined,
  baselineEvent: undefined,
  historicalObservation: forgedFutureHistoricalEvent,
  current: boundedCurrentEvent,
  currentSnapshotId: boundedBackfill.brief.snapshot!.id,
  comparedAt: boundedOperational.comparedAt,
  isFirstSeen: false,
  legacyUnverified: false,
});
await expectSemanticBaselineForgeryRejected(
  boundedBackfill.brief,
  "previous_observation",
  forgedHistorical,
  forgedFutureHistoricalEvent,
  correctHistoricalEvent,
  "future historical-observation endpoint",
);

// The snapshot payload hash covers the complete reviewed report, not only the
// event-version material. A report-level presentation edit must create a new
// snapshot/hash while reusing the exact immutable event version.
const dayEight = "2095-07-29";
const unchangedReplacementForLaterDays = structuredClone(
  replacementSnapshot.brief.headlines[0],
);
delete unchangedReplacementForLaterDays.whatChanged;
const hashDraftOne = await db.saveDraft(
  brief(dayEight, `${dayEight}T03:00:00.000Z`, unchangedReplacementForLaterDays),
  {
    stream: "manual",
    batchKey: "what-changed-complete-payload-hash-1",
    observedAt: `${dayEight}T03:00:00.000Z`,
  },
);
const hashDraftTwo = await db.updateDraft(hashDraftOne.id, {
  ...structuredClone(hashDraftOne.brief),
  stats: {
    ...hashDraftOne.brief.stats,
    candidates: hashDraftOne.brief.stats.candidates + 1,
  },
}, {
  stream: "review",
  batchKey: "what-changed-complete-payload-hash-2",
  observedAt: `${dayEight}T03:01:00.000Z`,
  expectedSnapshotId: hashDraftOne.brief.snapshot?.id,
});
assert.notEqual(hashDraftTwo.brief.snapshot?.id, hashDraftOne.brief.snapshot?.id);
assert.notEqual(
  hashDraftTwo.brief.snapshot?.payloadHash,
  hashDraftOne.brief.snapshot?.payloadHash,
  "a report-level presentation-only edit must change the complete snapshot payload hash",
);
assert.equal(
  hashDraftTwo.brief.snapshot?.events[0].eventVersionId,
  hashDraftOne.brief.snapshot?.events[0].eventVersionId,
  "a report-level presentation-only edit must not manufacture an event version",
);

async function expectPublicationAuditRejected(
  values: {
    briefId: string;
    snapshotId: string;
    snapshotPayloadHash: string;
    pdfSha256: string;
    publishedAt: string;
  },
  label: string,
): Promise<void> {
  const error = await raw.query(`
    INSERT INTO brief_publication_audits (
      brief_id, snapshot_id, snapshot_payload_hash, pdf_sha256,
      actor_type, published_at
    ) VALUES ($1, $2, $3, $4, 'system', $5)
  `, [
    values.briefId,
    values.snapshotId,
    values.snapshotPayloadHash,
    values.pdfSha256,
    values.publishedAt,
  ]).then(() => undefined, (value: { code?: string }) => value);
  assert.equal(error?.code, "23514", label);
}

const auditSnapshotId = hashDraftTwo.brief.snapshot!.id;
const auditSnapshotHash = hashDraftTwo.brief.snapshot!.payloadHash;
const auditPdf = Buffer.from("direct-publication-audit-fixture");
const auditPdfHash = createHash("sha256").update(auditPdf).digest("hex");
const auditPublishedAt = `${dayEight}T03:05:00.000Z`;
await expectPublicationAuditRejected({
  briefId: hashDraftTwo.id,
  snapshotId: auditSnapshotId,
  snapshotPayloadHash: auditSnapshotHash,
  pdfSha256: auditPdfHash,
  publishedAt: auditPublishedAt,
}, "a publication audit must reject a daily brief that is still a draft");

const unauditedPromotionError = await raw.query(`
  UPDATE daily_briefs
  SET status = 'published', pdf_data = $2, published_at = $3, updated_at = $3
  WHERE id = $1
`, [hashDraftTwo.id, auditPdf, auditPublishedAt])
  .then(() => undefined, (value: { code?: string }) => value);
assert.equal(
  unauditedPromotionError?.code,
  "23514",
  "a draft-to-published transition without an exact audit in the same transaction must roll back",
);
assert.equal(
  (await raw.query<{ status: string }>(
    "SELECT status FROM daily_briefs WHERE id = $1",
    [hashDraftTwo.id],
  )).rows[0].status,
  "draft",
  "failed unaudited publication must leave the daily brief as a draft",
);

const draftAuthority = (await raw.query<{
  brief_date: string;
  payload: DailyBrief;
  current_snapshot_id: string;
}>(`
  SELECT brief_date::text, payload, current_snapshot_id
  FROM daily_briefs
  WHERE id = $1
`, [hashDraftTwo.id])).rows[0];
assert.ok(draftAuthority, "the direct-insert adversarial test requires the authoritative draft");
const unauditedInsertClient = await raw.connect();
let unauditedInsertError: { code?: string } | undefined;
try {
  await unauditedInsertClient.query("BEGIN");
  await unauditedInsertClient.query(
    "DELETE FROM daily_briefs WHERE id = $1",
    [hashDraftTwo.id],
  );
  await unauditedInsertClient.query(`
    INSERT INTO daily_briefs (
      id, brief_date, status, payload, current_snapshot_id,
      pdf_data, published_at, updated_at
    ) VALUES ($1, $2, 'published', $3::jsonb, $4, $5, $6, $6)
  `, [
    hashDraftTwo.id,
    draftAuthority.brief_date,
    JSON.stringify({
      ...draftAuthority.payload,
      status: "published",
      publishedAt: auditPublishedAt,
    }),
    draftAuthority.current_snapshot_id,
    auditPdf,
    auditPublishedAt,
  ]);
  await unauditedInsertClient.query("COMMIT");
} catch (error) {
  unauditedInsertError = error as { code?: string };
  await unauditedInsertClient.query("ROLLBACK").catch(() => undefined);
} finally {
  unauditedInsertClient.release();
}
assert.equal(
  unauditedInsertError?.code,
  "23514",
  "directly inserting a published daily brief without an exact audit must roll back",
);
assert.equal(
  (await raw.query<{ status: string }>(
    "SELECT status FROM daily_briefs WHERE id = $1",
    [hashDraftTwo.id],
  )).rows[0].status,
  "draft",
  "failed unaudited INSERT must restore the original authoritative draft",
);

await expectPublicationAuditRejected({
  briefId: hashDraftTwo.id,
  snapshotId: dayFiveThree.brief.snapshot!.id,
  snapshotPayloadHash: auditSnapshotHash,
  pdfSha256: auditPdfHash,
  publishedAt: auditPublishedAt,
}, "a publication audit must reject a snapshot unrelated to the daily brief");
await expectPublicationAuditRejected({
  briefId: hashDraftTwo.id,
  snapshotId: auditSnapshotId,
  snapshotPayloadHash: "0".repeat(64),
  pdfSha256: auditPdfHash,
  publishedAt: auditPublishedAt,
}, "a publication audit must reject a forged snapshot payload hash");
await expectPublicationAuditRejected({
  briefId: hashDraftTwo.id,
  snapshotId: auditSnapshotId,
  snapshotPayloadHash: auditSnapshotHash,
  pdfSha256: "0".repeat(64),
  publishedAt: auditPublishedAt,
}, "a publication audit must reject a PDF hash that does not match stored PDF bytes");
const directPublicationClient = await raw.connect();
try {
  await directPublicationClient.query("BEGIN");
  await directPublicationClient.query(`
    UPDATE daily_briefs
    SET status = 'published', pdf_data = $2, published_at = $3, updated_at = $3
    WHERE id = $1
  `, [hashDraftTwo.id, auditPdf, auditPublishedAt]);
  await directPublicationClient.query(`
    INSERT INTO brief_publication_audits (
      brief_id, snapshot_id, snapshot_payload_hash, pdf_sha256,
      actor_type, published_at
    ) VALUES ($1, $2, $3, $4, 'system', $5)
  `, [
    hashDraftTwo.id,
    auditSnapshotId,
    auditSnapshotHash,
    auditPdfHash,
    auditPublishedAt,
  ]);
  await directPublicationClient.query("COMMIT");
} catch (error) {
  await directPublicationClient.query("ROLLBACK");
  throw error;
} finally {
  directPublicationClient.release();
}
const publishedPayloadMutationError = await raw.query(`
  UPDATE daily_briefs
  SET payload = jsonb_set(payload, '{stats,candidates}', '999999'::jsonb)
  WHERE id = $1
`, [hashDraftTwo.id]).then(() => undefined, (value: { code?: string }) => value);
assert.equal(
  publishedPayloadMutationError?.code,
  "23514",
  "an audited published report cannot diverge from its immutable snapshot payload",
);
const publishedPdfMutationError = await raw.query(`
  UPDATE daily_briefs
  SET pdf_data = $2
  WHERE id = $1
`, [hashDraftTwo.id, Buffer.from("tampered-pdf")])
  .then(() => undefined, (value: { code?: string }) => value);
assert.equal(
  publishedPdfMutationError?.code,
  "23514",
  "an audited published report cannot replace the PDF bytes frozen by its publication audit",
);

// A reviewed day-D snapshot freezes the previous-published endpoint. If an
// intervening day D-1 report is published before day D, publication must fail
// and force a rebuild/review rather than silently comparing against stale data.
const dayNine = "2095-07-30";
const dayTen = "2095-07-31";
const staleBaselineDraft = await db.saveDraft(
  brief(dayTen, `${dayTen}T03:00:00.000Z`, unchangedReplacementForLaterDays),
  {
    stream: "manual",
    batchKey: "what-changed-published-baseline-toctou-current",
    observedAt: `${dayTen}T03:00:00.000Z`,
  },
);
assert.equal(
  staleBaselineDraft.brief.headlines[0].whatChanged?.investor.baselineSnapshotId,
  auditSnapshotId,
);
const interveningDraft = await db.saveDraft(
  brief(dayNine, `${dayNine}T03:00:00.000Z`, unchangedReplacementForLaterDays),
  {
    stream: "manual",
    batchKey: "what-changed-published-baseline-toctou-intervening",
    observedAt: `${dayNine}T03:00:00.000Z`,
  },
);
const interveningPublished = await db.publishBrief(
  interveningDraft.id,
  interveningDraft.brief,
  Buffer.from("what-changed-intervening-published-pdf"),
  {
    stream: "publish",
    batchKey: "what-changed-published-baseline-toctou-intervening-publish",
    actor: {
      type: "admin",
      idHash: reviewerHash,
      reason: "Publish intervening previous-day baseline fixture",
      requestId: "what-changed-published-baseline-toctou-intervening-request",
    },
  },
);
assert.equal(interveningPublished.status, "published");
await assert.rejects(
  () => db.publishBrief(
    staleBaselineDraft.id,
    staleBaselineDraft.brief,
    Buffer.from("what-changed-stale-baseline-pdf"),
    {
      stream: "publish",
      batchKey: "what-changed-published-baseline-toctou-current-publish",
      actor: {
        type: "admin",
        idHash: reviewerHash,
        reason: "Adversarial stale previous-published endpoint attempt",
        requestId: "what-changed-published-baseline-toctou-current-request",
      },
    },
  ),
  (error: unknown) => error instanceof db.StaleBriefRevisionError,
  "publishing must revalidate the previous-published baseline under the publication lock",
);
assert.equal((await db.getBrief(staleBaselineDraft.id))?.status, "draft");

// A later backfill must not retroactively rewrite the frozen baseline of an
// already-published report. Published verification is evaluated as of the
// exact publication-audit timestamp, not against future archive additions.
const backfillDate = "2095-08-01";
const alreadyPublishedDate = "2095-08-02";
const alreadyPublishedDraft = await db.saveDraft(
  brief(
    alreadyPublishedDate,
    `${alreadyPublishedDate}T03:00:00.000Z`,
    unchangedReplacementForLaterDays,
  ),
  {
    stream: "manual",
    batchKey: "what-changed-as-of-already-published-draft",
    observedAt: `${alreadyPublishedDate}T03:00:00.000Z`,
  },
);
assert.equal(
  alreadyPublishedDraft.brief.headlines[0].whatChanged?.investor.baselineSnapshotId,
  interveningPublished.brief.snapshot?.id,
);
const alreadyPublished = await db.publishBrief(
  alreadyPublishedDraft.id,
  alreadyPublishedDraft.brief,
  Buffer.from("what-changed-as-of-already-published-pdf"),
  {
    stream: "publish",
    batchKey: "what-changed-as-of-already-published",
    actor: {
      type: "admin",
      idHash: reviewerHash,
      reason: "Freeze the report before a historical backfill is published",
      requestId: "what-changed-as-of-already-published-request",
    },
  },
);
const laterBackfillDraft = await db.saveDraft(
  brief(
    backfillDate,
    `${backfillDate}T03:00:00.000Z`,
    unchangedReplacementForLaterDays,
  ),
  {
    stream: "manual",
    batchKey: "what-changed-as-of-later-backfill-draft",
    observedAt: `${alreadyPublishedDate}T03:10:00.000Z`,
  },
);
const laterBackfill = await db.publishBrief(
  laterBackfillDraft.id,
  laterBackfillDraft.brief,
  Buffer.from("what-changed-as-of-later-backfill-pdf"),
  {
    stream: "publish",
    batchKey: "what-changed-as-of-later-backfill",
    actor: {
      type: "admin",
      idHash: reviewerHash,
      reason: "Publish an older report after the newer report was frozen",
      requestId: "what-changed-as-of-later-backfill-request",
    },
  },
);
assert.ok(
  Date.parse(laterBackfill.publishedAt!)
    > Date.parse(alreadyPublished.publishedAt!),
  "the serialized publication clock must advance even for immediate consecutive publications",
);
assert.deepEqual(
  await db.verifyBriefEvidenceAuthority(alreadyPublished.brief),
  [],
  "a later backfill must not change an already-published previous-published baseline",
);

// Even an otherwise exact direct-SQL publication must not be able to backdate
// its audit below an already-frozen report. The database, rather than only the
// application publisher, owns this global visibility boundary.
const backdatedDraftDate = "2095-08-03";
const backdatedDraft = await db.saveDraft(
  brief(
    backdatedDraftDate,
    `${backdatedDraftDate}T03:00:00.000Z`,
    unchangedReplacementForLaterDays,
  ),
  {
    stream: "manual",
    batchKey: "what-changed-backdated-publication-draft",
    observedAt: `${backdatedDraftDate}T03:00:00.000Z`,
  },
);
const backdatedPdf = Buffer.from("what-changed-backdated-publication-pdf");
const backdatedPdfHash = createHash("sha256").update(backdatedPdf).digest("hex");
const backdatedPublishedAt = new Date(
  Date.parse(alreadyPublished.publishedAt!) - 1_000,
).toISOString();
const backdatedPublicationClient = await raw.connect();
let backdatedPublicationError: { code?: string } | undefined;
try {
  await backdatedPublicationClient.query("BEGIN");
  await backdatedPublicationClient.query(`
    UPDATE daily_briefs
    SET status = 'published', pdf_data = $2, published_at = $3, updated_at = $3
    WHERE id = $1
  `, [backdatedDraft.id, backdatedPdf, backdatedPublishedAt]);
  await backdatedPublicationClient.query(`
    INSERT INTO brief_publication_audits (
      brief_id, snapshot_id, snapshot_payload_hash, pdf_sha256,
      actor_type, published_at
    ) VALUES ($1, $2, $3, $4, 'system', $5)
  `, [
    backdatedDraft.id,
    backdatedDraft.brief.snapshot!.id,
    backdatedDraft.brief.snapshot!.payloadHash,
    backdatedPdfHash,
    backdatedPublishedAt,
  ]);
  await backdatedPublicationClient.query("COMMIT");
} catch (error) {
  backdatedPublicationError = error as { code?: string };
  await backdatedPublicationClient.query("ROLLBACK").catch(() => undefined);
} finally {
  backdatedPublicationClient.release();
}
assert.equal(
  backdatedPublicationError?.code,
  "23514",
  "the database must reject a distinct but regressive exact publication timestamp",
);
assert.equal(
  (await db.getBrief(backdatedDraft.id))?.status,
  "draft",
  "a rejected backdated publication must leave the report as a draft",
);
assert.equal(
  (await raw.query(
    "SELECT 1 FROM brief_publication_audits WHERE brief_id = $1",
    [backdatedDraft.id],
  )).rowCount,
  0,
  "a rejected backdated publication must not leave an orphan audit",
);

async function expectImmutable(
  updateSql: string,
  deleteSql: string,
  parameters: unknown[],
  label: string,
): Promise<void> {
  const updateError = await raw.query(updateSql, parameters)
    .then(() => undefined, (error: { code?: string }) => error);
  assert.equal(updateError?.code, "55000", `${label} UPDATE must be rejected as immutable`);
  const deleteError = await raw.query(deleteSql, parameters)
    .then(() => undefined, (error: { code?: string }) => error);
  assert.equal(deleteError?.code, "55000", `${label} DELETE must be rejected as immutable`);
}

await expectImmutable(
  `UPDATE event_version_comparisons SET summary = summary
   WHERE event_id = $1 AND current_version_id = $2`,
  `DELETE FROM event_version_comparisons
   WHERE event_id = $1 AND current_version_id = $2`,
  [eventId, versionTwo.id],
  "event_version_comparisons",
);
await expectImmutable(
  `UPDATE event_version_change_items SET summary = summary
   WHERE event_id = $1 AND current_version_id = $2`,
  `DELETE FROM event_version_change_items
   WHERE event_id = $1 AND current_version_id = $2`,
  [eventId, versionTwo.id],
  "event_version_change_items",
);
await expectImmutable(
  `UPDATE event_version_numeric_facts SET original_text = original_text
   WHERE event_id = $1 AND event_version_id = $2`,
  `DELETE FROM event_version_numeric_facts
   WHERE event_id = $1 AND event_version_id = $2`,
  [eventId, versionTwo.id],
  "event_version_numeric_facts",
);
await expectImmutable(
  `UPDATE event_version_numeric_fact_evidence SET relation = relation
   WHERE event_id = $1 AND event_version_id = $2`,
  `DELETE FROM event_version_numeric_fact_evidence
   WHERE event_id = $1 AND event_version_id = $2`,
  [eventId, versionTwo.id],
  "event_version_numeric_fact_evidence",
);
await expectImmutable(
  `UPDATE evidence_retraction_requests SET reason_note = reason_note
   WHERE request_id = $1`,
  `DELETE FROM evidence_retraction_requests WHERE request_id = $1`,
  [retraction.requestId],
  "evidence_retraction_requests",
);
await expectImmutable(
  `UPDATE event_version_change_item_retractions SET created_at = created_at
   WHERE request_id = $1`,
  `DELETE FROM event_version_change_item_retractions WHERE request_id = $1`,
  [retraction.requestId],
  "event_version_change_item_retractions",
);
await expectImmutable(
  `UPDATE brief_publication_audits SET pdf_sha256 = pdf_sha256
   WHERE brief_id = $1`,
  `DELETE FROM brief_publication_audits WHERE brief_id = $1`,
  [publishedTwo.id],
  "brief_publication_audits",
);
await expectImmutable(
  `UPDATE brief_snapshot_event_changes SET summary = summary
   WHERE current_snapshot_id = $1 AND event_id = $2`,
  `DELETE FROM brief_snapshot_event_changes
   WHERE current_snapshot_id = $1 AND event_id = $2`,
  [publishedTwoSnapshotId, eventId],
  "brief_snapshot_event_changes",
);
await expectImmutable(
  `UPDATE brief_snapshot_event_change_items SET summary = summary
   WHERE current_snapshot_id = $1 AND event_id = $2`,
  `DELETE FROM brief_snapshot_event_change_items
   WHERE current_snapshot_id = $1 AND event_id = $2`,
  [publishedTwoSnapshotId, eventId],
  "brief_snapshot_event_change_items",
);

const unboundRemovalError = await raw.query(`
  INSERT INTO event_version_change_items (
    event_id, current_version_id, algorithm_version, item_id, ordinal,
    kind, subject_key, reason_code, summary, before_value, after_value,
    evidence_version_ids, change_hash
  )
  SELECT comparison.event_id, comparison.current_version_id,
         comparison.algorithm_version, 'adversarial-unbound-removal',
         COALESCE((
           SELECT MAX(existing.ordinal) + 1
           FROM event_version_change_items AS existing
           WHERE existing.event_id = comparison.event_id
             AND existing.current_version_id = comparison.current_version_id
             AND existing.algorithm_version = comparison.algorithm_version
         ), 1),
         'evidence_removed', 'evidence:adversarial',
         'UNBOUND_RETRACTION', 'Adversarial unbound removal',
         '{}'::jsonb, NULL::jsonb, ARRAY[$3::uuid], $4
  FROM event_version_comparisons AS comparison
  WHERE comparison.event_id = $1
    AND comparison.current_version_id = $2
`, [
  eventId,
  versionFour.id,
  titleEvidenceV2.versionId!,
  "f".repeat(64),
]).then(() => undefined, (error: { code?: string }) => error);
assert.equal(
  unboundRemovalError?.code,
  "23514",
  "a removal change item without an exact retraction binding must fail at commit",
);
assert.equal(
  (await raw.query(`
    SELECT 1 FROM event_version_change_items
    WHERE event_id = $1 AND current_version_id = $2
      AND item_id = 'adversarial-unbound-removal'
  `, [eventId, versionFour.id])).rowCount,
  0,
);

const titleReplacementItem = await raw.query<{ item_id: string }>(`
  SELECT item_id
  FROM event_version_change_items
  WHERE event_id = $1
    AND current_version_id = $2
    AND kind = 'claim_support_changed'
    AND $3::uuid = ANY(evidence_version_ids)
    AND COALESCE(before_value->>'claimKey', after_value->>'claimKey') = 'title'
  LIMIT 1
`, [eventId, versionFour.id, titleEvidenceV2.versionId!]);
assert.equal(titleReplacementItem.rowCount, 1);

const noBindingRequestId = "what-changed-adversarial-request-without-binding";
const noBindingRequestError = await raw.query(`
  INSERT INTO evidence_retraction_requests (
    request_id, request_hash, event_id, from_event_version_id,
    to_event_version_id, evidence_item_id, evidence_version_id,
    claim_id, claim_key, citation_relation, reason_code, reason_note,
    replacement_evidence_version_id, actor_type, actor_id_hash,
    applied_run_id, requested_at
  )
  SELECT
    $2, $3, event_id, from_event_version_id,
    to_event_version_id, evidence_item_id, evidence_version_id,
    claim_id, claim_key, citation_relation, reason_code,
    'Adversarial request without a binding',
    replacement_evidence_version_id, actor_type, actor_id_hash,
    applied_run_id, requested_at
  FROM evidence_retraction_requests
  WHERE request_id = $1
`, [
  replacementRequest.requestId,
  noBindingRequestId,
  "1".repeat(64),
]).then(() => undefined, (error: { code?: string }) => error);
assert.equal(
  noBindingRequestError?.code,
  "23514",
  "every retraction request must have at least one exact compliant change-item binding",
);
assert.equal(
  (await raw.query(
    "SELECT 1 FROM evidence_retraction_requests WHERE request_id = $1",
    [noBindingRequestId],
  )).rowCount,
  0,
);

const globalEvidenceRevisionItem = await raw.query<{ item_id: string }>(`
  SELECT item_id
  FROM event_version_change_items
  WHERE event_id = $1
    AND current_version_id = $2
    AND kind = 'evidence_revised'
    AND $3::uuid = ANY(evidence_version_ids)
  LIMIT 1
`, [eventId, versionFour.id, titleEvidenceV2.versionId!]);
assert.equal(globalEvidenceRevisionItem.rowCount, 1);
const claimToGlobalBindingError = await raw.query(`
  INSERT INTO event_version_change_item_retractions (
    event_id, current_version_id, algorithm_version,
    item_id, request_id, evidence_version_id
  ) VALUES ($1, $2, 'what-changed/v1', $3, $4, $5)
`, [
  eventId,
  versionFour.id,
  globalEvidenceRevisionItem.rows[0].item_id,
  replacementRequest.requestId,
  titleEvidenceV2.versionId!,
]).then(() => undefined, (error: { code?: string }) => error);
assert.equal(
  claimToGlobalBindingError?.code,
  "23514",
  "a claim-scoped retraction must not bind a global evidence change item",
);

const wrongClaimReplacementRequestId =
  "what-changed-adversarial-wrong-claim-replacement";
const wrongClaimClient = await raw.connect();
let wrongClaimReplacementError: { code?: string } | undefined;
try {
  await wrongClaimClient.query("BEGIN");
  await wrongClaimClient.query(`
    INSERT INTO evidence_retraction_requests (
      request_id, request_hash, event_id, from_event_version_id,
      to_event_version_id, evidence_item_id, evidence_version_id,
      claim_id, claim_key, citation_relation, reason_code, reason_note,
      replacement_evidence_version_id, actor_type, actor_id_hash,
      applied_run_id, requested_at
    )
    SELECT
      $2, $3, event_id, from_event_version_id,
      to_event_version_id, evidence_item_id, evidence_version_id,
      claim_id, claim_key, citation_relation, reason_code,
      'Adversarial replacement that is present but does not support the same claim',
      $4, actor_type, actor_id_hash, applied_run_id, requested_at
    FROM evidence_retraction_requests
    WHERE request_id = $1
  `, [
    replacementRequest.requestId,
    wrongClaimReplacementRequestId,
    "2".repeat(64),
    bodyEvidenceV4.versionId!,
  ]);
  await wrongClaimClient.query(`
    INSERT INTO event_version_change_item_retractions (
      event_id, current_version_id, algorithm_version,
      item_id, request_id, evidence_version_id
    ) VALUES ($1, $2, 'what-changed/v1', $3, $4, $5)
  `, [
    eventId,
    versionFour.id,
    titleReplacementItem.rows[0].item_id,
    wrongClaimReplacementRequestId,
    titleEvidenceV2.versionId!,
  ]);
  await wrongClaimClient.query("COMMIT");
} catch (error) {
  wrongClaimReplacementError = error as { code?: string };
  await wrongClaimClient.query("ROLLBACK");
} finally {
  wrongClaimClient.release();
}
assert.equal(
  wrongClaimReplacementError?.code,
  "23514",
  "replacement evidence must support the exact same claim in the target event version",
);
assert.equal(
  (await raw.query(
    "SELECT 1 FROM evidence_retraction_requests WHERE request_id = $1",
    [wrongClaimReplacementRequestId],
  )).rowCount,
  0,
);

const brokenVersionId = randomUUID();
const brokenChainError = await raw.query(`
  INSERT INTO event_versions (
    id, event_id, version_number, previous_version_id,
    content_hash, evidence_hash, state_hash, presentation_hash,
    observed_at, run_id, payload
  )
  SELECT
    $1, event_id, version_number + 2, id,
    $2, $3, $4, $5,
    observed_at + INTERVAL '1 minute', run_id, payload
  FROM event_versions
  WHERE event_id = $6 AND id = $7
`, [
  brokenVersionId,
  "1".repeat(64),
  "2".repeat(64),
  "3".repeat(64),
  "4".repeat(64),
  eventId,
  versionThree.id,
]).then(() => undefined, (error: { code?: string }) => error);
assert.equal(
  brokenChainError?.code,
  "23514",
  "a non-adjacent event version must fail the database chain trigger",
);
assert.equal(
  (await raw.query(`SELECT 1 FROM event_versions WHERE id = $1`, [brokenVersionId])).rowCount,
  0,
);

// Full persistence regression for non-support relationships. The current
// reviewed claim contains both a context relationship to an already-supported
// evidence item and a contradiction that the reviewer explicitly converts to
// support. Retractions must remove only the named old relation, retain the new
// support, and bind every removal to an immutable change item.
const relationDate = "2095-08-03";
const relationSeedHeadline = structuredClone(replacementSnapshot.brief.headlines[0]);
delete relationSeedHeadline.whatChanged;
const relationSeedTitle = relationSeedHeadline.claims?.find((claim) =>
  claim.claimKey === "title");
assert.ok(relationSeedTitle);
relationSeedHeadline.claims = relationSeedHeadline.claims?.map((claim) =>
  claim.claimKey === "title"
    ? createHeadlineClaim({
        ...claim,
        verificationStatus: "partially_supported",
        citations: [
          ...claim.citations.map((citation, order) => ({ ...citation, order })),
          createEvidenceCitation(titleEvidenceV4, {
            relation: "context",
            confidence: 1,
            order: claim.citations.length,
          }),
          createEvidenceCitation(bodyEvidenceV4, {
            relation: "contradicts",
            confidence: 1,
            order: claim.citations.length + 1,
          }),
        ],
      })
    : claim);
const relationSeed = await db.saveDraft(
  brief(
    relationDate,
    `${relationDate}T03:00:00.000Z`,
    relationSeedHeadline,
  ),
  {
    stream: "review",
    batchKey: "what-changed-claim-relation-seed",
    observedAt: `${relationDate}T03:00:00.000Z`,
    actor: {
      type: "admin",
      idHash: reviewerHash,
      reason: "Seed exact context and contradiction relationships",
      requestId: "what-changed-claim-relation-seed-actor",
    },
  },
);
const relationSeedVersionId = relationSeed.brief.snapshot?.events[0].eventVersionId;
assert.ok(relationSeedVersionId);

const relationConvertedHeadline = structuredClone(relationSeed.brief.headlines[0]);
delete relationConvertedHeadline.whatChanged;
relationConvertedHeadline.claims = relationConvertedHeadline.claims?.map((claim) => {
  if (claim.claimKey !== "title") return claim;
  const retained = claim.citations.filter((citation) =>
    !(citation.id === titleEvidenceV4.id && citation.relation === "context")
    && !(citation.id === bodyEvidenceV4.id && citation.relation === "contradicts"));
  return createHeadlineClaim({
    ...claim,
    verificationStatus: "supported",
    citations: [
      ...retained,
      createEvidenceCitation(bodyEvidenceV4, {
        relation: "supports",
        confidence: 1,
        order: retained.length,
      }),
    ].map((citation, order) => ({ ...citation, order })),
  });
});
const relationConvertedBrief = structuredClone(relationSeed.brief);
relationConvertedBrief.generatedAt = `${relationDate}T03:10:00.000Z`;
relationConvertedBrief.headlines = [relationConvertedHeadline];
const contextRetractionId = "what-changed-context-relation-retraction";
const contradictionRetractionId = "what-changed-contradiction-relation-retraction";
const relationConverted = await db.updateDraft(
  relationSeed.id,
  relationConvertedBrief,
  {
    stream: "review",
    batchKey: "what-changed-claim-relation-conversion",
    observedAt: `${relationDate}T03:10:00.000Z`,
    expectedSnapshotId: relationSeed.brief.snapshot?.id,
    actor: {
      type: "admin",
      idHash: reviewerHash,
      reason: "Remove exact old relations and explicitly rebind one item as support",
      requestId: "what-changed-claim-relation-conversion-actor",
    },
    evidenceRetractions: [
      {
        requestId: contextRetractionId,
        eventId,
        fromEventVersionId: relationSeedVersionId,
        evidenceItemId: titleEvidenceV4.id,
        evidenceVersionId: titleEvidenceV4.versionId!,
        claimKey: "title",
        citationRelation: "context",
        reasonCode: "review_rejected",
        reasonNote: "The reviewer removed the old context relationship without changing the existing support.",
      },
      {
        requestId: contradictionRetractionId,
        eventId,
        fromEventVersionId: relationSeedVersionId,
        evidenceItemId: bodyEvidenceV4.id,
        evidenceVersionId: bodyEvidenceV4.versionId!,
        claimKey: "title",
        citationRelation: "contradicts",
        reasonCode: "review_rejected",
        reasonNote: "The reviewer explicitly converted the old contradiction into a new support relationship.",
      },
    ],
  },
);
const relationConvertedVersionId =
  relationConverted.brief.snapshot?.events[0].eventVersionId;
assert.ok(relationConvertedVersionId);
const relationItems =
  relationConverted.brief.headlines[0].whatChanged?.latestVersion.items ?? [];
assert.equal(
  relationItems.filter((item) => item.kind === "claim_relation_removed").length,
  2,
);
assert.equal(
  relationItems.some((item) =>
    item.kind === "claim_support_added"
    && item.evidenceVersionIds.includes(bodyEvidenceV4.versionId!)),
  true,
  "an explicit contradiction-to-support conversion must preserve the new support",
);
const persistedConvertedTitleRelations = await raw.query<{
  evidence_version_id: string;
  relation: string;
}>(`
  SELECT evidence_version_id, relation
  FROM claim_evidence_links
  WHERE event_id = $1
    AND event_version_id = $2
    AND claim_key = 'title'
  ORDER BY evidence_version_id, relation
`, [eventId, relationConvertedVersionId]);
assert.equal(
  persistedConvertedTitleRelations.rows.some((row) =>
    row.evidence_version_id === bodyEvidenceV4.versionId
    && row.relation === "supports"),
  true,
);
assert.equal(
  persistedConvertedTitleRelations.rows.some((row) =>
    row.relation === "context" || row.relation === "contradicts"),
  false,
);
const relationRetractionAuthority = await raw.query<{
  request_id: string;
  citation_relation: string;
  kind: string;
}>(`
  SELECT request.request_id, request.citation_relation, item.kind
  FROM evidence_retraction_requests AS request
  JOIN event_version_change_item_retractions AS binding
    ON binding.request_id = request.request_id
   AND binding.event_id = request.event_id
   AND binding.current_version_id = request.to_event_version_id
   AND binding.evidence_version_id = request.evidence_version_id
  JOIN event_version_change_items AS item
    ON item.event_id = binding.event_id
   AND item.current_version_id = binding.current_version_id
   AND item.algorithm_version = binding.algorithm_version
   AND item.item_id = binding.item_id
  WHERE request.request_id = ANY($1::text[])
  ORDER BY request.request_id
`, [[contextRetractionId, contradictionRetractionId]]);
assert.deepEqual(
  relationRetractionAuthority.rows,
  [
    {
      request_id: contextRetractionId,
      citation_relation: "context",
      kind: "claim_relation_removed",
    },
    {
      request_id: contradictionRetractionId,
      citation_relation: "contradicts",
      kind: "claim_relation_removed",
    },
  ],
);

// Existing published reports from before publication-audit rollout have no
// exact audit row. They remain readable but every UPDATE and DELETE must fail.
const legacyPublishedDate = "2095-08-04";
const legacyPublishedDraft = await db.saveDraft(
  brief(
    legacyPublishedDate,
    `${legacyPublishedDate}T03:00:00.000Z`,
    relationConvertedHeadline,
  ),
  {
    stream: "manual",
    batchKey: "what-changed-legacy-published-fixture",
    observedAt: `${legacyPublishedDate}T03:00:00.000Z`,
  },
);
await raw.query(`
  ALTER TABLE daily_briefs
  DISABLE TRIGGER daily_briefs_require_publication_audit
`);
try {
  await raw.query(`
    UPDATE daily_briefs
    SET status = 'published',
        payload = jsonb_set(payload, '{status}', '"published"'::jsonb),
        pdf_data = $2,
        published_at = $3,
        updated_at = $3
    WHERE id = $1
  `, [
    legacyPublishedDraft.id,
    Buffer.from("legacy-published-without-audit"),
    `${legacyPublishedDate}T03:05:00.000Z`,
  ]);
} finally {
  await raw.query(`
    ALTER TABLE daily_briefs
    ENABLE TRIGGER daily_briefs_require_publication_audit
  `);
}
assert.equal(
  (await raw.query(
    "SELECT 1 FROM brief_publication_audits WHERE brief_id = $1",
    [legacyPublishedDraft.id],
  )).rowCount,
  0,
);
const legacyPublishedUpdateError = await raw.query(
  "UPDATE daily_briefs SET payload = payload WHERE id = $1",
  [legacyPublishedDraft.id],
).then(() => undefined, (error: { code?: string }) => error);
assert.equal(
  legacyPublishedUpdateError?.code,
  "23514",
  "a legacy published report without an audit must reject every UPDATE",
);
const legacyPublishedDeleteError = await raw.query(
  "DELETE FROM daily_briefs WHERE id = $1",
  [legacyPublishedDraft.id],
).then(() => undefined, (error: { code?: string }) => error);
assert.equal(
  legacyPublishedDeleteError?.code,
  "23514",
  "a legacy published report without an audit must reject DELETE",
);

// Migration backfill must prefer the exact payload snapshot when an older
// legacy fallback snapshot also matches the same daily-brief row.
const pointerDate = "2095-08-05";
const pointerDraft = await db.saveDraft(
  brief(pointerDate, `${pointerDate}T03:00:00.000Z`, relationConvertedHeadline),
  {
    stream: "manual",
    batchKey: "what-changed-pointer-precedence-fixture",
    observedAt: `${pointerDate}T03:00:00.000Z`,
  },
);
const exactPointerSnapshotId = pointerDraft.brief.snapshot?.id;
assert.ok(exactPointerSnapshotId);
await raw.query(`
  INSERT INTO collection_runs (
    id, stream, batch_key, status, brief_date,
    input_hash, started_at, completed_at
  ) VALUES ($1, 'legacy', $2, 'success', $3, $4, $5, $5)
`, [
  pointerDraft.id,
  `legacy-pointer-fixture:${pointerDraft.id}`,
  pointerDate,
  "legacy-pointer-fixture",
  `${pointerDate}T03:10:00.000Z`,
]);
await raw.query(`
  INSERT INTO brief_snapshots (
    id, run_id, stream, batch_key, sequence_number, brief_date,
    generated_at, previous_snapshot_id, payload_hash, payload
  ) VALUES (
    $1, $1, 'legacy', $2, 2, $3, $4, $5, $6, $7::jsonb
  )
`, [
  pointerDraft.id,
  `daily-brief:${pointerDraft.id}`,
  pointerDate,
  `${pointerDate}T03:10:00.000Z`,
  exactPointerSnapshotId,
  "a".repeat(64),
  JSON.stringify(pointerDraft.brief),
]);
await raw.query(
  "UPDATE daily_briefs SET current_snapshot_id = $2 WHERE id = $1",
  [pointerDraft.id, pointerDraft.id],
);
const migrationSql = await readFile(
  new URL("../db/migrations/20260723_what_changed.sql", import.meta.url),
  "utf8",
);
await raw.query(migrationSql);
assert.equal(
  (await raw.query<{ current_snapshot_id: string }>(
    "SELECT current_snapshot_id FROM daily_briefs WHERE id = $1",
    [pointerDraft.id],
  )).rows[0].current_snapshot_id,
  exactPointerSnapshotId,
  "the exact payload snapshot must win over the legacy fallback deterministically",
);

// Snapshot creation and publication share one transaction-scoped visibility
// lock. This is the dangerous interleaving: an older snapshot is fully
// inserted but still uncommitted while a newer report tries to establish or
// publish its comparison boundary.
async function settledWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

const visibilitySeedRunId = randomUUID();
const visibilitySeedSnapshotId = randomUUID();
const visibilitySeedClient = await raw.connect();
let visibilityDraftPromise:
  | ReturnType<typeof db.saveDraft>
  | undefined;
try {
  await visibilitySeedClient.query("BEGIN");
  await visibilitySeedClient.query(`
    INSERT INTO collection_runs (
      id, stream, batch_key, status, brief_date,
      input_hash, started_at, completed_at
    ) VALUES (
      $1, 'manual', $2, 'success', DATE '2197-01-01',
      'visibility-seed-fixture', clock_timestamp(), clock_timestamp()
    )
  `, [visibilitySeedRunId, `visibility-seed:${visibilitySeedRunId}`]);
  await visibilitySeedClient.query(`
    INSERT INTO brief_snapshots (
      id, run_id, stream, batch_key, sequence_number, brief_date,
      generated_at, previous_snapshot_id, payload_hash, payload
    ) VALUES (
      $1, $2, 'manual', $3, 1, DATE '2197-01-01',
      TIMESTAMPTZ '2197-01-01 03:00:00+00', NULL, $4, '{}'::jsonb
    )
  `, [
    visibilitySeedSnapshotId,
    visibilitySeedRunId,
    `visibility-seed-snapshot:${visibilitySeedSnapshotId}`,
    "d".repeat(64),
  ]);
  await visibilitySeedClient.query(`
    INSERT INTO brief_snapshot_events (
      snapshot_id, event_id, event_version_id, rank, ranking_score,
      freshness_score, impact, confidence, mentions, cross_source_count,
      match_method, match_confidence
    ) VALUES ($1, $2, $3, 1, 90, 90, 5, 92, 1, 1, 'existing_id', 1)
  `, [visibilitySeedSnapshotId, eventId, relationConvertedVersionId]);

  visibilityDraftPromise = db.saveDraft(
    brief(
      "2197-01-02",
      "2197-01-02T03:00:00.000Z",
      relationConvertedHeadline,
    ),
    {
      stream: "manual",
      batchKey: "what-changed-visibility-linearization-draft",
      observedAt: "2197-01-02T03:00:00.000Z",
    },
  );
  assert.equal(
    await settledWithin(visibilityDraftPromise, 75),
    false,
    "draft comparison must wait for a fully inserted but uncommitted historical snapshot",
  );
  await visibilitySeedClient.query("COMMIT");
} catch (error) {
  await visibilitySeedClient.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  visibilitySeedClient.release();
}
assert.ok(visibilityDraftPromise);
const visibilityDraft = await visibilityDraftPromise;
assert.equal(
  visibilityDraft.brief.headlines[0].whatChanged?.operational
    .historicalObservationSnapshotId,
  visibilitySeedSnapshotId,
  "the draft must include the historical snapshot that became visible before its own boundary",
);

const visibilityLateRunId = randomUUID();
const visibilityLateSnapshotId = randomUUID();
const visibilityLateClient = await raw.connect();
let visibilityPublishPromise:
  | ReturnType<typeof db.publishBrief>
  | undefined;
try {
  await visibilityLateClient.query("BEGIN");
  await visibilityLateClient.query(`
    INSERT INTO collection_runs (
      id, stream, batch_key, status, brief_date,
      input_hash, started_at, completed_at
    ) VALUES (
      $1, 'manual', $2, 'success', DATE '2197-01-01',
      'visibility-late-fixture', clock_timestamp(), clock_timestamp()
    )
  `, [visibilityLateRunId, `visibility-late:${visibilityLateRunId}`]);
  await visibilityLateClient.query(`
    INSERT INTO brief_snapshots (
      id, run_id, stream, batch_key, sequence_number, brief_date,
      generated_at, previous_snapshot_id, payload_hash, payload
    ) VALUES (
      $1, $2, 'manual', $3, 2, DATE '2197-01-01',
      TIMESTAMPTZ '2197-01-01 04:00:00+00', $4, $5, '{}'::jsonb
    )
  `, [
    visibilityLateSnapshotId,
    visibilityLateRunId,
    `visibility-late-snapshot:${visibilityLateSnapshotId}`,
    visibilitySeedSnapshotId,
    "e".repeat(64),
  ]);
  await visibilityLateClient.query(`
    INSERT INTO brief_snapshot_events (
      snapshot_id, event_id, event_version_id, rank, ranking_score,
      freshness_score, impact, confidence, mentions, cross_source_count,
      match_method, match_confidence
    ) VALUES ($1, $2, $3, 1, 90, 90, 5, 92, 1, 1, 'existing_id', 1)
  `, [visibilityLateSnapshotId, eventId, relationConvertedVersionId]);

  visibilityPublishPromise = db.publishBrief(
    visibilityDraft.id,
    visibilityDraft.brief,
    Buffer.from("what-changed-visibility-linearization-pdf"),
    {
      stream: "publish",
      batchKey: "what-changed-visibility-linearization-publish",
      actor: {
        type: "admin",
        idHash: reviewerHash,
        reason: "Verify commit-linear snapshot visibility before publication",
        requestId: "what-changed-visibility-linearization-request",
      },
    },
  );
  assert.equal(
    await settledWithin(visibilityPublishPromise, 75),
    false,
    "publication must wait for a fully inserted but uncommitted snapshot",
  );
  await visibilityLateClient.query("COMMIT");
} catch (error) {
  await visibilityLateClient.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  visibilityLateClient.release();
}
assert.ok(visibilityPublishPromise);
const visibilityPublished = await visibilityPublishPromise;
assert.equal(visibilityPublished.status, "published");
assert.equal(
  visibilityPublished.brief.headlines[0].whatChanged?.operational
    .historicalObservationSnapshotId,
  visibilitySeedSnapshotId,
  "a snapshot committed after the reviewed boundary must not be retroactively selected",
);
assert.deepEqual(
  await db.verifyBriefEvidenceAuthority(visibilityPublished.brief),
  [],
  "the published comparison must remain exactly recomputable after the late snapshot commits",
);

// PostgreSQL NOW() is the transaction-start time. A slow backfill transaction
// that begins first but inserts last must receive the later visibility
// timestamp, otherwise it can be retroactively selected by an already-frozen
// snapshot. This interleaving fails with DEFAULT NOW() and passes only with
// statement-time clock_timestamp().
const slowSnapshotClient = await raw.connect();
const fastSnapshotClient = await raw.connect();
const slowRunId = randomUUID();
const fastRunId = randomUUID();
const slowSnapshotId = randomUUID();
const fastSnapshotId = randomUUID();
try {
  await slowSnapshotClient.query("BEGIN");
  await slowSnapshotClient.query("SELECT NOW()");
  await fastSnapshotClient.query("BEGIN");
  await fastSnapshotClient.query(`
    INSERT INTO collection_runs (
      id, stream, batch_key, status, brief_date,
      input_hash, started_at, completed_at
    ) VALUES ($1, 'manual', $2, 'success', DATE '2196-01-02',
      'fast-visibility-fixture', clock_timestamp(), clock_timestamp())
  `, [fastRunId, `fast-visibility:${fastRunId}`]);
  await fastSnapshotClient.query(`
    INSERT INTO brief_snapshots (
      id, run_id, stream, batch_key, sequence_number, brief_date,
      generated_at, previous_snapshot_id, payload_hash, payload, created_at
    ) VALUES (
      $1, $2, 'manual', $3, 1, DATE '2196-01-02',
      TIMESTAMPTZ '2196-01-02 03:00:00+00', NULL, $4, '{}'::jsonb,
      TIMESTAMPTZ '1900-01-01 00:00:00+00'
    )
  `, [
    fastSnapshotId,
    fastRunId,
    `fast-visibility-snapshot:${fastSnapshotId}`,
    "b".repeat(64),
  ]);
  await fastSnapshotClient.query("COMMIT");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await slowSnapshotClient.query(`
    INSERT INTO collection_runs (
      id, stream, batch_key, status, brief_date,
      input_hash, started_at, completed_at
    ) VALUES ($1, 'manual', $2, 'success', DATE '2196-01-01',
      'slow-visibility-fixture', clock_timestamp(), clock_timestamp())
  `, [slowRunId, `slow-visibility:${slowRunId}`]);
  await slowSnapshotClient.query(`
    INSERT INTO brief_snapshots (
      id, run_id, stream, batch_key, sequence_number, brief_date,
      generated_at, previous_snapshot_id, payload_hash, payload, created_at
    ) VALUES (
      $1, $2, 'manual', $3, 1, DATE '2196-01-01',
      TIMESTAMPTZ '2196-01-01 03:00:00+00', NULL, $4, '{}'::jsonb,
      TIMESTAMPTZ '1900-01-01 00:00:00+00'
    )
  `, [
    slowSnapshotId,
    slowRunId,
    `slow-visibility-snapshot:${slowSnapshotId}`,
    "c".repeat(64),
  ]);
  await slowSnapshotClient.query("COMMIT");
} catch (error) {
  await slowSnapshotClient.query("ROLLBACK").catch(() => undefined);
  await fastSnapshotClient.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  slowSnapshotClient.release();
  fastSnapshotClient.release();
}
const visibilityOrder = await raw.query<{
  id: string;
  created_at: string | Date;
}>(`
  SELECT id, created_at
  FROM brief_snapshots
  WHERE id = ANY($1::uuid[])
`, [[slowSnapshotId, fastSnapshotId]]);
const createdAtBySnapshot = new Map(visibilityOrder.rows.map((row) => [
  row.id,
  new Date(row.created_at).valueOf(),
]));
assert.ok(
  createdAtBySnapshot.get(slowSnapshotId)!
    > createdAtBySnapshot.get(fastSnapshotId)!,
  "the snapshot inserted after the fast commit must have the later visibility boundary even though its transaction began first",
);

// A wall clock can move backward. Simulate an existing future visibility
// boundary, then prove the normal trigger advances past it instead of trusting
// the current clock or the caller-supplied timestamp.
const futureClockRunId = randomUUID();
const futureClockSnapshotId = randomUUID();
const recoveredClockRunId = randomUUID();
const recoveredClockSnapshotId = randomUUID();
await raw.query(`
  INSERT INTO collection_runs (
    id, stream, batch_key, status, brief_date,
    input_hash, started_at, completed_at
  ) VALUES
    ($1, 'manual', $2, 'success', DATE '2299-01-01',
      'future-clock-fixture', clock_timestamp(), clock_timestamp()),
    ($3, 'manual', $4, 'success', DATE '2299-01-02',
      'recovered-clock-fixture', clock_timestamp(), clock_timestamp())
`, [
  futureClockRunId,
  `future-clock:${futureClockRunId}`,
  recoveredClockRunId,
  `recovered-clock:${recoveredClockRunId}`,
]);
await raw.query(`
  ALTER TABLE brief_snapshots
  DISABLE TRIGGER brief_snapshots_stamp_created_at
`);
try {
  await raw.query(`
    INSERT INTO brief_snapshots (
      id, run_id, stream, batch_key, sequence_number, brief_date,
      generated_at, previous_snapshot_id, payload_hash, payload, created_at
    ) VALUES (
      $1, $2, 'manual', $3, 1, DATE '2299-01-01',
      TIMESTAMPTZ '2299-01-01 03:00:00+00', NULL, $4, '{}'::jsonb,
      TIMESTAMPTZ '2299-01-01 03:00:00+00'
    )
  `, [
    futureClockSnapshotId,
    futureClockRunId,
    `future-clock-snapshot:${futureClockSnapshotId}`,
    "8".repeat(64),
  ]);
} finally {
  await raw.query(`
    ALTER TABLE brief_snapshots
    ENABLE TRIGGER brief_snapshots_stamp_created_at
  `);
}
await raw.query(`
  INSERT INTO brief_snapshots (
    id, run_id, stream, batch_key, sequence_number, brief_date,
    generated_at, previous_snapshot_id, payload_hash, payload, created_at
  ) VALUES (
    $1, $2, 'manual', $3, 1, DATE '2299-01-02',
    TIMESTAMPTZ '2299-01-02 03:00:00+00', NULL, $4, '{}'::jsonb,
    TIMESTAMPTZ '1900-01-01 00:00:00+00'
  )
`, [
  recoveredClockSnapshotId,
  recoveredClockRunId,
  `recovered-clock-snapshot:${recoveredClockSnapshotId}`,
  "9".repeat(64),
]);
const monotonicSnapshotClock = await raw.query<{ strictly_increasing: boolean }>(`
  SELECT (
    SELECT created_at FROM brief_snapshots WHERE id = $2
  ) > (
    SELECT created_at FROM brief_snapshots WHERE id = $1
  ) AS strictly_increasing
`, [futureClockSnapshotId, recoveredClockSnapshotId]);
assert.equal(
  monotonicSnapshotClock.rows[0].strictly_increasing,
  true,
  "the serialized snapshot clock must remain strictly monotonic across wall-clock rollback",
);

const auditTables = [
  "comparison_algorithms",
  "event_version_comparisons",
  "event_version_change_items",
  "event_version_numeric_facts",
  "event_version_numeric_fact_evidence",
  "evidence_retraction_requests",
  "event_version_change_item_retractions",
  "brief_publication_audits",
  "brief_snapshot_event_changes",
  "brief_snapshot_event_change_items",
] as const;

async function auditCounts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of auditTables) {
    const count = await raw.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
    result[table] = Number(count.rows[0]?.count ?? 0);
  }
  return result;
}

// The raw concurrency fixtures intentionally insert only the minimum snapshot
// authority. One convergent migration pass repairs their derived comparison
// rows; the following pass must then be a strict no-op.
await raw.query(migrationSql);
const beforeDirectRerun = await auditCounts();
await raw.query(migrationSql);
assert.deepEqual(
  await auditCounts(),
  beforeDirectRerun,
  "directly rerunning the 7/23 migration must not duplicate or rewrite audit history",
);

const authoritativeAlgorithm = await raw.query<{
  implementation_hash: string;
  config: Record<string, unknown>;
}>(`
  SELECT implementation_hash, config
  FROM comparison_algorithms
  WHERE version = 'what-changed/v1'
`);
assert.equal(authoritativeAlgorithm.rowCount, 1);

async function expectTamperedAlgorithmMigrationRejected(
  column: "implementation_hash" | "config",
  sqlValue: string,
  parameter: string,
): Promise<void> {
  await raw.query(`
    ALTER TABLE comparison_algorithms
    DISABLE TRIGGER comparison_algorithms_immutable
  `);
  try {
    await raw.query(
      `UPDATE comparison_algorithms SET ${column} = ${sqlValue}
       WHERE version = 'what-changed/v1'`,
      [parameter],
    );
  } finally {
    await raw.query(`
      ALTER TABLE comparison_algorithms
      ENABLE TRIGGER comparison_algorithms_immutable
    `);
  }

  const rerunError = await raw.query(migrationSql)
    .then(() => undefined, (error: { code?: string }) => error);
  assert.equal(
    rerunError?.code,
    "23514",
    `migration rerun must reject a tampered comparison-algorithm ${column}`,
  );

  await raw.query(`
    ALTER TABLE comparison_algorithms
    DISABLE TRIGGER comparison_algorithms_immutable
  `);
  try {
    await raw.query(`
      UPDATE comparison_algorithms
      SET implementation_hash = $1, config = $2::jsonb
      WHERE version = 'what-changed/v1'
    `, [
      authoritativeAlgorithm.rows[0].implementation_hash,
      JSON.stringify(authoritativeAlgorithm.rows[0].config),
    ]);
  } finally {
    await raw.query(`
      ALTER TABLE comparison_algorithms
      ENABLE TRIGGER comparison_algorithms_immutable
    `);
  }
}

await expectTamperedAlgorithmMigrationRejected(
  "implementation_hash",
  "$1",
  "0".repeat(64),
);
await expectTamperedAlgorithmMigrationRejected(
  "config",
  "$1::jsonb",
  JSON.stringify({ schema: "tampered" }),
);
await raw.query(migrationSql);
assert.deepEqual(
  await auditCounts(),
  beforeDirectRerun,
  "restoring the exact registry must make the migration convergent again",
);

globalThis.__analystArenaSchemaReady = undefined;
assert.equal((await db.databaseHealth()).ok, true);
assert.deepEqual(
  await auditCounts(),
  beforeDirectRerun,
  "process-local schema reinitialization must respect the migration ledger",
);

await raw.end();
console.log(
  "PostgreSQL What Changed temporal, dual-baseline authority, publication, retraction, immutability, chain, and rerun tests passed",
);
