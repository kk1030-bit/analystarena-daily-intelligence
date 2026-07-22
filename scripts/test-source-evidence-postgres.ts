import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { demoBrief } from "../lib/demo-data";
import {
  createEvidenceCitation,
  createHeadlineClaim,
  evidenceLocatorHash,
  sha256ExactUtf8,
} from "../lib/source-evidence";
import { parseFeedDocument, type FeedDefinition } from "../lib/pipeline";
import type { DailyBrief, Headline, HeadlineClaim, RawStory, SourceLink } from "../lib/types";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the PostgreSQL evidence test");
const raw = new Pool({ connectionString: process.env.DATABASE_URL });

// Simulate a database that already recorded an earlier 7/22 draft. The final
// v2 migration must still run through the real filename ledger and upgrade the
// draft provenance table instead of being skipped forever.
await raw.query(`
  CREATE TABLE daily_briefs (
    id UUID PRIMARY KEY,
    brief_date DATE NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
    payload JSONB NOT NULL,
    pdf_data BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
  )
`);
const eventHistorySql = await readFile(new URL("../db/migrations/20260721_event_history.sql", import.meta.url), "utf8");
await raw.query(eventHistorySql);
await raw.query(`
  CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await raw.query(`
  INSERT INTO schema_migrations (id) VALUES
    ('20260721_event_history.sql'),
    ('20260722_source_evidence.sql')
`);
await raw.query(`
  CREATE TABLE source_version_provenance (
    source_document_version_id UUID PRIMARY KEY,
    source_document_id TEXT NOT NULL,
    native_id TEXT,
    source_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    timestamp_kind TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    raw_url TEXT,
    final_url TEXT,
    feed_url TEXT,
    mime_type TEXT,
    http_status INTEGER,
    original_published_at TIMESTAMPTZ,
    published_at_raw TEXT,
    published_at_field TEXT,
    source_updated_at TIMESTAMPTZ,
    collected_at TIMESTAMPTZ NOT NULL,
    capture_scope TEXT NOT NULL,
    captured_content_hash TEXT NOT NULL,
    extraction_method TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    backfill_quality TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_document_id, source_document_version_id)
  )
`);
const db = await import("../lib/db");
assert.equal((await db.databaseHealth()).ok, true);
assert.equal(
  (await raw.query(`SELECT 1 FROM schema_migrations WHERE id = '20260722_source_evidence_v2.sql'`)).rowCount,
  1,
  "the finalized migration filename must run even when the earlier draft filename is in the ledger",
);
const upgradedArtifactColumns = await raw.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'source_version_provenance'
    AND column_name IN (
      'captured_artifact', 'captured_artifact_encoding',
      'captured_artifact_size_bytes', 'captured_text_hash'
    )
`);
assert.equal(upgradedArtifactColumns.rowCount, 4, "the v2 migration must add finalized artifact columns to a draft table");

const feed: FeedDefinition = { name: "Evidence Test Wire", url: "https://evidence.example/feed.xml", type: "News" };
const date = "2096-07-22";
function xml(body: string): string {
  return `<?xml version="1.0"?><rss><channel><item><guid>evidence-item-1</guid>`
    + `<title>Evidence-linked earnings update</title><link>https://evidence.example/items/1</link>`
    + `<pubDate>Sun, 22 Jul 2096 01:02:03 GMT</pubDate><description>${body}</description>`
    + `</item></channel></rss>`;
}
function story(body: string, collectedAt: string): RawStory {
  return parseFeedDocument(feed, xml(body), { collectedAt, mimeType: "application/rss+xml", httpStatus: 200 })[0];
}

const a1 = story("Revenue rose 12 percent.", `${date}T02:00:00.000Z`);
const b = story("Revenue rose 14 percent after a correction.", `${date}T03:10:00.000Z`);
const a2 = story("Revenue rose 12 percent.", `${date}T03:20:00.000Z`);
const first = await db.saveSourceStories([a1]);
const firstStory = first.stories[0];
assert.ok(firstStory.sourceDocumentVersionId);
assert.ok(firstStory.evidence?.every((item) => item.versionId));

const forgedQuote = structuredClone(a1);
forgedQuote.evidence![1].quoteOriginal = "Revenue rose 99 percent (forged).";
forgedQuote.evidence![1].quoteHash = sha256ExactUtf8(forgedQuote.evidence![1].quoteOriginal!);
await assert.rejects(
  db.saveSourceStories([forgedQuote]),
  /not the exact captured feed field/,
  "a self-consistent forged quote/hash must be rejected before PostgreSQL persistence",
);

const forgedLocatorStory = structuredClone(a1);
const forgedLocator = forgedLocatorStory.evidence![0].locator;
assert.equal(forgedLocator.kind, "feed_field");
if (forgedLocator.kind === "feed_field") forgedLocator.entryId = "forged-entry-id";
forgedLocatorStory.evidence![0].locatorHash = evidenceLocatorHash(forgedLocator);
await assert.rejects(
  db.saveSourceStories([forgedLocatorStory]),
  /does not identify the captured entry/,
  "a self-consistent forged locator/hash must be rejected before PostgreSQL persistence",
);

await assert.rejects(
  db.saveSourceStories([{
    ...a1,
    publishedAtRaw: "Sun, 22 Jul 2096 02:02:03 GMT",
    capture: { ...a1.capture!, publishedAtRaw: "Sun, 22 Jul 2096 02:02:03 GMT" },
  }]),
  /must exactly match originalPublishedAt/,
  "raw publisher time cannot disagree with the canonical publication instant",
);
await assert.rejects(
  db.saveSourceStories([{
    ...a1,
    publishedAtRaw: "2096-07-22T01:02:03",
    capture: { ...a1.capture!, publishedAtRaw: "2096-07-22T01:02:03" },
  }]),
  /cannot be classified as a published timestamp/,
  "unparseable raw publisher time cannot retain timestampKind=published",
);
assert.equal(
  Number((await raw.query(
    "SELECT COUNT(*) AS count FROM source_document_versions WHERE source_document_id = $1",
    [a1.sourceDocumentId],
  )).rows[0].count),
  1,
  "failed preflight assertions must not create source versions",
);

await assert.rejects(
  db.saveSourceStories([{
    ...a1,
    firstCollectedAt: `${date}T02:01:00`,
    collectedAt: `${date}T02:01:00`,
    lastCollectedAt: `${date}T02:01:00`,
    capture: { ...a1.capture!, collectedAt: `${date}T02:01:00` },
  }]),
  /explicit timezone/,
);
await assert.rejects(
  db.saveSourceStories([{
    ...a1,
    capture: {
      ...a1.capture!,
      capturedArtifact: `${a1.capture!.capturedArtifact}\nforged`,
      capturedArtifactSizeBytes: Buffer.byteLength(`${a1.capture!.capturedArtifact}\nforged`, "utf8"),
    },
  }]),
  /artifact hash mismatch/,
);
await assert.rejects(
  db.saveSourceStories([{
    ...a1,
    originalPublishedAt: null,
    capture: { ...a1.capture!, originalPublishedAt: null },
  }]),
  /must exactly match originalPublishedAt/,
);
await assert.rejects(
  db.saveSourceStories([{
    ...a1,
    timestampKind: "collected",
  }]),
  /Collected source time requires a null original publication timestamp/,
);

const legacyCollectedAt = `${date}T02:15:00.000Z`;
const legacyStory = parseFeedDocument(feed, [
  `<?xml version="1.0"?><rss><channel><item><guid>legacy-unknown-time</guid>`,
  `<title>Legacy unknown publication time</title>`,
  `<link>https://evidence.example/items/legacy-unknown-time</link>`,
  `<description>Only collection time is known.</description></item></channel></rss>`,
].join(""), { collectedAt: legacyCollectedAt, mimeType: "application/rss+xml", httpStatus: 200 })[0];
assert.equal(legacyStory.timestampKind, "collected");
await raw.query(`ALTER TABLE source_documents DROP CONSTRAINT source_documents_time_consistency_ck`);
await raw.query(`
  INSERT INTO source_documents (
    id, native_id, canonical_url, source_name, source_type,
    published_at, timestamp_kind, first_collected_at, last_collected_at,
    original_published_at
  ) VALUES ($1, $2, $3, $4, $5, $6, 'published', $6, $6, NULL)
`, [
  legacyStory.sourceDocumentId,
  legacyStory.nativeId ?? null,
  legacyStory.canonicalUrl,
  legacyStory.source,
  legacyStory.sourceType,
  `${date}T00:00:00.000Z`,
]);
await raw.query(`
  ALTER TABLE source_documents
  ADD CONSTRAINT source_documents_time_consistency_ck CHECK (
    (
      timestamp_kind = 'published'
      AND original_published_at IS NOT NULL
      AND published_at = original_published_at
    )
    OR (
      timestamp_kind = 'collected'
      AND original_published_at IS NULL
      AND published_at = last_collected_at
    )
  ) NOT VALID
`);
await db.saveSourceStories([legacyStory]);
const correctedLegacyTime = await raw.query<{
  timestamp_kind: string;
  original_published_at: Date | null;
  published_at: Date;
  last_collected_at: Date;
}>(`
  SELECT timestamp_kind, original_published_at, published_at, last_collected_at
  FROM source_documents WHERE id = $1
`, [legacyStory.sourceDocumentId]);
assert.equal(correctedLegacyTime.rows[0].timestamp_kind, "collected");
assert.equal(correctedLegacyTime.rows[0].original_published_at, null);
assert.equal(correctedLegacyTime.rows[0].published_at.toISOString(), legacyCollectedAt);
assert.equal(correctedLegacyTime.rows[0].last_collected_at.toISOString(), legacyCollectedAt);

const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => {
  const observationAt = `${date}T02:${String(30 + index).padStart(2, "0")}:00.000Z`;
  return db.saveSourceStories([{
    ...a1,
    collectedAt: observationAt,
    lastCollectedAt: observationAt,
    capture: { ...a1.capture!, collectedAt: observationAt },
    evidence: a1.evidence?.map((item) => ({ ...item, capturedAt: observationAt })),
  }]);
}));
assert.ok(concurrent.every((result) => result.stories[0].sourceDocumentVersionId === firstStory.sourceDocumentVersionId));
assert.equal(concurrent[0].stories[0].capture?.capturedArtifact, firstStory.capture?.capturedArtifact);
assert.equal(concurrent[0].stories[0].capture?.collectedAt, `${date}T02:30:00.000Z`);

const secondStory = (await db.saveSourceStories([b])).stories[0];
const thirdStory = (await db.saveSourceStories([a2])).stories[0];
const corroboratingFeed: FeedDefinition = {
  name: "Evidence Test Filing",
  url: "https://filing.example/feed.xml",
  type: "Official",
};
const corroboratingRaw = parseFeedDocument(
  corroboratingFeed,
  xml("The filing independently confirms the reported revenue change.")
    .replace("evidence-item-1", "filing-item-1")
    .replace("https://evidence.example/items/1", "https://filing.example/items/1"),
  { collectedAt: `${date}T03:25:00.000Z`, mimeType: "application/rss+xml", httpStatus: 200 },
)[0];
const corroboratingStory = (await db.saveSourceStories([corroboratingRaw])).stories[0];
assert.notEqual(secondStory.sourceDocumentVersionId, firstStory.sourceDocumentVersionId);
assert.notEqual(thirdStory.sourceDocumentVersionId, firstStory.sourceDocumentVersionId, "A→B→A must create a third chronological source version");
assert.equal(thirdStory.contentHash, firstStory.contentHash);

const sourceVersions = await raw.query<{
  id: string;
  version_number: number;
  previous_version_id: string | null;
  content_hash: string;
}>(`SELECT id, version_number, previous_version_id, content_hash
    FROM source_document_versions WHERE source_document_id = $1 ORDER BY version_number`, [firstStory.sourceDocumentId]);
assert.equal(sourceVersions.rowCount, 3);
assert.equal(sourceVersions.rows[2].previous_version_id, sourceVersions.rows[1].id);
assert.equal(sourceVersions.rows[2].content_hash, sourceVersions.rows[0].content_hash);

const provenance = await raw.query<{
  original_published_at: Date;
  published_at_raw: string;
  published_at_field: string;
  collected_at: Date;
  capture_scope: string;
  feed_url: string;
  final_url: string | null;
}>(`SELECT original_published_at, published_at_raw, published_at_field, collected_at,
           capture_scope, feed_url, final_url
    FROM source_version_provenance WHERE source_document_version_id = $1`, [firstStory.sourceDocumentVersionId]);
assert.equal(provenance.rowCount, 1);
assert.equal(provenance.rows[0].original_published_at.toISOString(), "2096-07-22T01:02:03.000Z");
assert.equal(provenance.rows[0].published_at_field, "pubDate");
assert.equal(provenance.rows[0].feed_url, feed.url);
assert.equal(provenance.rows[0].capture_scope, "rss_entry");
assert.equal(provenance.rows[0].final_url, null, "an unfetched URL must not be relabelled as a resolved final URL");

const evidenceVersions = await raw.query<{
  id: string;
  evidence_item_id: string;
  version_number: number;
  previous_version_id: string | null;
  source_document_version_id: string;
  quote_original: string | null;
}>(`SELECT id, evidence_item_id, version_number, previous_version_id,
           source_document_version_id, quote_original
    FROM evidence_versions WHERE source_document_id = $1
    ORDER BY evidence_item_id, version_number`, [firstStory.sourceDocumentId]);
assert.equal(evidenceVersions.rowCount, 6, "title and body evidence must each have A→B→A versions");
for (const itemId of new Set(evidenceVersions.rows.map((row) => row.evidence_item_id))) {
  const chain = evidenceVersions.rows.filter((row) => row.evidence_item_id === itemId);
  assert.deepEqual(chain.map((row) => row.version_number), [1, 2, 3]);
  assert.equal(chain[1].previous_version_id, chain[0].id);
  assert.equal(chain[2].previous_version_id, chain[1].id);
}

const titleEvidence = thirdStory.evidence?.find((item) => item.anchorKey === "feed:title");
const bodyEvidence = thirdStory.evidence?.find((item) => item.anchorKey === "feed:description");
assert.ok(titleEvidence && bodyEvidence);
const citations = [createEvidenceCitation(bodyEvidence)];
const directionRationale = "Revenue evidence supports a potentially positive earnings direction.";
const definitions: Array<[string, HeadlineClaim["type"], string]> = [
  ["title", "title", thirdStory.title],
  ["summary", "summary", thirdStory.description],
  ["important_information:0", "important_information", thirdStory.description],
  ["market_impact", "market_impact", "The correction changes the earnings assessment."],
  ["direction_rationale", "direction_rationale", directionRationale],
];
const claims = definitions.map(([claimKey, type, statement], ordinal) => createHeadlineClaim({
  claimKey,
  type,
  ordinal,
  statement,
  originalStatement: statement,
  language: "en",
  verificationStatus: type === "market_impact" || type === "direction_rationale" ? "partially_supported" : "supported",
  citations,
  generator: "deterministic",
  generatorVersion: "postgres-test/v1",
}));
const source: SourceLink = {
  name: thirdStory.source,
  type: thirdStory.sourceType,
  role: "primary",
  url: thirdStory.url,
  sourceDocumentId: thirdStory.sourceDocumentId,
  sourceDocumentVersionId: thirdStory.sourceDocumentVersionId,
  sourceObservationId: thirdStory.sourceObservationId,
  nativeId: thirdStory.nativeId,
  feedNamespace: thirdStory.feedNamespace,
  canonicalUrl: thirdStory.canonicalUrl,
  originalTitle: thirdStory.originalTitle,
  contentHash: thirdStory.contentHash,
  publishedAt: thirdStory.publishedAt,
  originalPublishedAt: thirdStory.originalPublishedAt,
  publishedAtRaw: thirdStory.publishedAtRaw,
  publishedAtField: thirdStory.publishedAtField,
  sourceUpdatedAt: thirdStory.sourceUpdatedAt,
  collectedAt: thirdStory.collectedAt,
  timestampKind: thirdStory.timestampKind,
  capture: thirdStory.capture,
  evidence: thirdStory.evidence,
};
const corroboratingSource: SourceLink = {
  name: corroboratingStory.source,
  type: corroboratingStory.sourceType,
  role: "corroborating",
  url: corroboratingStory.url,
  sourceDocumentId: corroboratingStory.sourceDocumentId,
  sourceDocumentVersionId: corroboratingStory.sourceDocumentVersionId,
  sourceObservationId: corroboratingStory.sourceObservationId,
  nativeId: corroboratingStory.nativeId,
  feedNamespace: corroboratingStory.feedNamespace,
  canonicalUrl: corroboratingStory.canonicalUrl,
  originalTitle: corroboratingStory.originalTitle,
  contentHash: corroboratingStory.contentHash,
  publishedAt: corroboratingStory.publishedAt,
  originalPublishedAt: corroboratingStory.originalPublishedAt,
  publishedAtRaw: corroboratingStory.publishedAtRaw,
  publishedAtField: corroboratingStory.publishedAtField,
  sourceUpdatedAt: corroboratingStory.sourceUpdatedAt,
  collectedAt: corroboratingStory.collectedAt,
  timestampKind: corroboratingStory.timestampKind,
  capture: corroboratingStory.capture,
  evidence: corroboratingStory.evidence,
};
const initialSourceOrder = [source, corroboratingSource].sort((left, right) =>
  (right.sourceDocumentId ?? "").localeCompare(left.sourceDocumentId ?? ""));
const headline: Headline = {
  ...structuredClone(demoBrief.headlines[0]),
  id: "postgres-evidence-event",
  rank: 1,
  title: thirdStory.title,
  summary: thirdStory.description,
  keyPoints: [thirdStory.description],
  marketImpact: "The correction changes the earnings assessment.",
  marketDirection: "bullish",
  directionConfidence: 80,
  directionRationale,
  impact: 5,
  publishedAt: thirdStory.publishedAt,
  newsTimeSource: thirdStory.source,
  timestampKind: thirdStory.timestampKind,
  sources: initialSourceOrder,
  claims,
};
const brief: DailyBrief = {
  ...structuredClone(demoBrief),
  date,
  generatedAt: `${date}T04:00:00.000Z`,
  status: "draft",
  headlines: [headline],
  stats: { ...demoBrief.stats, topStories: 1, consolidatedEvents: 1 },
  socialBuzz: { reddit: [], x: [] },
};
const saved = await db.saveDraft(brief, { stream: "manual", batchKey: "postgres-evidence-relations" });
const eventId = saved.brief.headlines[0].id;
const eventVersionId = (await db.listEventVersions(eventId)).at(-1)?.id;
assert.ok(eventVersionId);
assert.equal((await raw.query(`SELECT 1 FROM event_version_sources WHERE event_id = $1 AND event_version_id = $2`, [eventId, eventVersionId])).rowCount, 2);
assert.equal((await raw.query(`SELECT 1 FROM event_version_evidence WHERE event_id = $1 AND event_version_id = $2`, [eventId, eventVersionId])).rowCount, 4);
assert.equal(Number((await raw.query(`SELECT COUNT(*) AS count FROM event_claims WHERE event_id = $1 AND event_version_id = $2`, [eventId, eventVersionId])).rows[0].count), claims.length);
assert.equal(Number((await raw.query(`SELECT COUNT(*) AS count FROM claim_evidence_links WHERE event_id = $1 AND event_version_id = $2`, [eventId, eventVersionId])).rows[0].count), claims.length);
const snapshotObservation = await raw.query<{
  event_version_id: string;
  source_role: string;
  ordinal: number;
}>(`
  SELECT event_version_id, source_role, ordinal
  FROM brief_snapshot_source_observations
  WHERE snapshot_id = $1 AND event_id = $2
`, [saved.brief.snapshot?.id, eventId]);
assert.equal(snapshotObservation.rowCount, 2);
assert.ok(snapshotObservation.rows.every((row) => row.event_version_id === eventVersionId));
assert.deepEqual(snapshotObservation.rows.map((row) => row.ordinal).sort(), [1, 2]);

assert.deepEqual(await db.verifyBriefEvidenceAuthority(saved.brief), []);
const reversedSources = structuredClone(saved.brief);
reversedSources.headlines[0].sources.reverse();
const versionCountBeforeReorderedSave = (await db.listEventVersions(eventId)).length;
const reorderedSave = await db.saveDraft(reversedSources, {
  stream: "manual",
  batchKey: "postgres-source-order-regression",
});
assert.equal(
  (await db.listEventVersions(eventId)).length,
  versionCountBeforeReorderedSave,
  "source presentation order alone must not create a new event version",
);
assert.deepEqual(
  reorderedSave.brief.headlines[0].sources.map((item) => item.sourceDocumentId),
  saved.brief.headlines[0].sources.map((item) => item.sourceDocumentId),
  "a reused event version must retain its authoritative source order",
);
assert.deepEqual(await db.verifyBriefEvidenceAuthority(reorderedSave.brief), []);
const forgedEventState = structuredClone(saved.brief);
forgedEventState.headlines[0].marketDirection = forgedEventState.headlines[0].marketDirection === "bullish" ? "bearish" : "bullish";
assert.ok((await db.verifyBriefEvidenceAuthority(forgedEventState)).some((issue) =>
  issue.code === "EVENT_VERSION_STATE_AUTHORITY_MISMATCH"));
const forgedSnapshotRanking = structuredClone(saved.brief);
forgedSnapshotRanking.headlines[0].rankingScore = (forgedSnapshotRanking.headlines[0].rankingScore ?? 0) + 1;
assert.ok((await db.verifyBriefEvidenceAuthority(forgedSnapshotRanking)).some((issue) =>
  issue.code === "SNAPSHOT_RANKING_AUTHORITY_MISMATCH"));
const forgedSnapshotMatch = structuredClone(saved.brief);
forgedSnapshotMatch.snapshot!.events[0].matchConfidence = 0.5;
assert.ok((await db.verifyBriefEvidenceAuthority(forgedSnapshotMatch)).some((issue) =>
  issue.code === "SNAPSHOT_EVENT_PROJECTION_AUTHORITY_MISMATCH"));
const forgedArtifact = structuredClone(saved.brief);
forgedArtifact.headlines[0].sources[0].capture!.capturedArtifact += "\nforged";
assert.ok((await db.verifyBriefEvidenceAuthority(forgedArtifact)).some((issue) =>
  issue.code === "SOURCE_PROVENANCE_AUTHORITY_MISMATCH"));
const omittedEvidence = structuredClone(saved.brief);
omittedEvidence.headlines[0].sources[0].evidence!.pop();
assert.ok((await db.verifyBriefEvidenceAuthority(omittedEvidence)).some((issue) =>
  issue.code === "EVIDENCE_SET_AUTHORITY_MISMATCH"));
const forgedRole = structuredClone(saved.brief);
forgedRole.headlines[0].sources[0].role = "context";
assert.ok((await db.verifyBriefEvidenceAuthority(forgedRole)).some((issue) =>
  issue.code === "SOURCE_PROVENANCE_AUTHORITY_MISMATCH"));
const omittedCitation = structuredClone(saved.brief);
omittedCitation.headlines[0].claims![0].citations = [];
assert.ok((await db.verifyBriefEvidenceAuthority(omittedCitation)).some((issue) =>
  issue.code === "CITATION_SET_AUTHORITY_MISMATCH"));

await assert.rejects(
  raw.query(`UPDATE evidence_versions SET quote_zh_cn = '伪造译文' WHERE id = $1`, [bodyEvidence.versionId]),
  /immutable/,
);

const migrationSql = await readFile(new URL("../db/migrations/20260722_source_evidence_v2.sql", import.meta.url), "utf8");
const beforeRerun = Number((await raw.query("SELECT COUNT(*) AS count FROM event_claims")).rows[0].count);
await raw.query("BEGIN");
try {
  await raw.query(migrationSql);
  await raw.query("COMMIT");
} catch (error) {
  await raw.query("ROLLBACK");
  throw error;
}
assert.equal(Number((await raw.query("SELECT COUNT(*) AS count FROM event_claims")).rows[0].count), beforeRerun, "migration rerun must be idempotent");

await globalThis.__analystArenaPool?.end();
globalThis.__analystArenaPool = undefined;
await raw.end();
console.log("PostgreSQL source provenance, evidence chain, claims, FK, concurrency, and rerun tests passed");
