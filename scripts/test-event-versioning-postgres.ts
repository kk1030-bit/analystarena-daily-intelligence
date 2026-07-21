import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { demoBrief } from "../lib/demo-data";
import { createStableEventIdentity } from "../lib/event-versioning";
import { ensureRawStoryIdentity } from "../lib/source-identity";
import type { DailyBrief, Headline, RawStory, SourceLink } from "../lib/types";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the PostgreSQL event-history test");

const raw = new Pool({ connectionString: process.env.DATABASE_URL });
const legacyId = randomUUID();
const legacyDate = "2097-07-20";
const legacyBrief = {
  ...structuredClone(demoBrief),
  date: legacyDate,
  generatedAt: `${legacyDate}T01:00:00.000Z`,
  status: "published" as const,
};

// Simulate the exact pre-migration production shape so the migration must
// preserve and backfill an existing published report.
await raw.query(`
  CREATE TABLE IF NOT EXISTS daily_briefs (
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
await raw.query(`
  INSERT INTO daily_briefs (id, brief_date, status, payload, pdf_data, published_at)
  VALUES ($1, $2, 'published', $3::jsonb, $4, $5)
`, [legacyId, legacyDate, JSON.stringify(legacyBrief), Buffer.from("legacy-pdf"), `${legacyDate}T02:00:00.000Z`]);

const db = await import("../lib/db");
const health = await db.databaseHealth();
assert.equal(health.ok, true);

const migrationRows = await raw.query<{ id: string }>(`
  SELECT id FROM schema_migrations WHERE id = '20260721_event_history.sql'
`);
assert.equal(migrationRows.rowCount, 1);
const legacySnapshot = await raw.query<{ payload: DailyBrief }>(`
  SELECT payload FROM brief_snapshots WHERE stream = 'legacy' AND batch_key = $1
`, [`daily-brief:${legacyId}`]);
assert.equal(legacySnapshot.rowCount, 1);
assert.equal(legacySnapshot.rows[0].payload.date, legacyDate);
assert.ok(legacySnapshot.rows[0].payload.headlines.every((headline) => headline.id.startsWith("evt_legacy_")));
assert.equal((await raw.query("SELECT COUNT(*)::integer AS count FROM event_versions WHERE run_id = $1", [legacyId])).rows[0].count, legacyBrief.headlines.length);

const date = "2097-07-21";

function story(url: string, title: string, description: string): RawStory {
  return ensureRawStoryIdentity({
    id: url,
    title,
    originalTitle: title,
    description,
    originalDescription: description,
    url,
    publishedAt: `${date}T01:00:00.000Z`,
    collectedAt: `${date}T01:05:00.000Z`,
    source: "Postgres Test Wire",
    sourceType: "News",
    timestampKind: "published",
  });
}

function sourceLink(item: RawStory): SourceLink {
  return {
    name: item.source,
    type: item.sourceType,
    url: item.url,
    sourceDocumentId: item.sourceDocumentId,
    nativeId: item.nativeId,
    canonicalUrl: item.canonicalUrl,
    originalTitle: item.originalTitle,
    contentHash: item.contentHash,
    publishedAt: item.publishedAt,
    collectedAt: item.collectedAt,
    timestampKind: item.timestampKind,
  };
}

const sourceV1 = story(
  "https://postgres.example.com/nvda/blackwell?utm_source=test",
  "NVIDIA Blackwell orders accelerate",
  "Customers accelerated Blackwell orders.",
);
const sourceV2 = ensureRawStoryIdentity({
  ...sourceV1,
  title: "NVIDIA Blackwell orders accelerate after capacity update",
  originalTitle: "NVIDIA Blackwell orders accelerate after capacity update",
  description: "Customers accelerated Blackwell orders after a capacity update.",
  originalDescription: "Customers accelerated Blackwell orders after a capacity update.",
  collectedAt: `${date}T01:15:00.000Z`,
  lastCollectedAt: `${date}T01:15:00.000Z`,
});
await db.saveSourceStories([sourceV1]);
await db.saveSourceStories([sourceV2]);
await db.saveSourceStories([{ ...sourceV1, collectedAt: `${date}T01:25:00.000Z`, lastCollectedAt: `${date}T01:25:00.000Z` }]);
const sourceVersions = await raw.query<{
  id: string;
  version_number: number;
  previous_version_id: string | null;
  content_hash: string;
}>(`
  SELECT id, version_number, previous_version_id, content_hash
  FROM source_document_versions WHERE source_document_id = $1 ORDER BY version_number
`, [sourceV1.sourceDocumentId]);
assert.equal(sourceVersions.rowCount, 3, "source correction A→B→A must retain all three revisions");
assert.equal(sourceVersions.rows[1].previous_version_id, sourceVersions.rows[0].id);
assert.equal(sourceVersions.rows[2].previous_version_id, sourceVersions.rows[1].id);
assert.equal(sourceVersions.rows[2].content_hash, sourceVersions.rows[0].content_hash);

function headline(overrides: Partial<Headline> = {}): Headline {
  return {
    ...structuredClone(demoBrief.headlines[0]),
    id: "temporary-postgres-id",
    rank: 1,
    ticker: "NVDA",
    title: "英伟达 Blackwell 订单加速",
    summary: "客户增加订单。",
    keyPoints: ["订单增加", "需求提高"],
    publishedAt: `${date}T01:00:00.000Z`,
    newsTimeSource: "Postgres Test Wire",
    timestampKind: "published",
    marketImpact: "订单变化可能影响收入预期。",
    marketDirection: "bullish",
    directionConfidence: 80,
    directionRationale: "订单增加支持收入增长。",
    equityImpacts: [],
    category: "Semiconductor",
    impact: 5,
    confidence: 84,
    mentions: 2,
    rankingScore: 90,
    freshnessScore: 95,
    crossSourceCount: 1,
    sentiment: "positive",
    sources: [sourceLink(sourceV1)],
    ...overrides,
  };
}

function brief(generatedAt: string, item: Headline): DailyBrief {
  return {
    ...structuredClone(demoBrief),
    id: undefined,
    date,
    generatedAt,
    status: "draft",
    snapshot: undefined,
    headlines: [item],
    stats: { ...demoBrief.stats, topStories: 1, consolidatedEvents: 1 },
    socialBuzz: { reddit: [], x: [] },
  };
}

const first = brief(`${date}T01:10:00.000Z`, headline());
const concurrent = await Promise.all(Array.from({ length: 20 }, () =>
  db.saveDraft(first, { stream: "shared", batchKey: "postgres-same-bucket" })));
const eventId = concurrent[0].brief.headlines[0].id;
assert.ok(concurrent.every((record) => record.brief.snapshot?.id === concurrent[0].brief.snapshot?.id));
assert.equal((await db.listBriefSnapshots(date)).length, 1);
assert.equal((await db.listEventVersions(eventId)).length, 1);

const second = brief(`${date}T01:20:00.000Z`, headline({ marketDirection: "bearish" }));
const third = brief(`${date}T01:30:00.000Z`, headline({ marketDirection: "neutral", directionConfidence: 55 }));
await Promise.all([
  db.saveDraft(second, { stream: "shared", batchKey: "postgres-bucket-2" }),
  db.saveDraft(third, { stream: "shared", batchKey: "postgres-bucket-3" }),
]);
const versions = await db.listEventVersions(eventId);
assert.equal(versions.length, 3);
assert.equal(versions[1].previousVersionId, versions[0].id);
assert.equal(versions[2].previousVersionId, versions[1].id);
const snapshots = await db.listBriefSnapshots(date);
assert.deepEqual(snapshots.map((snapshot) => snapshot.sequenceNumber), [3, 2, 1]);
assert.equal(snapshots[0].previousSnapshotId, snapshots[1].id);
assert.equal(snapshots[1].previousSnapshotId, snapshots[2].id);

const unrelatedStory = story(
  "https://postgres.example.com/nvda/office-lease",
  "NVIDIA board approves an office lease",
  "The board approved an office lease unrelated to production demand.",
);
const unrelatedBrief = brief(`${date}T01:35:00.000Z`, headline({
  id: "postgres-unrelated-event",
  title: "英伟达批准办公室租约",
  summary: "董事会批准办公室租约。",
  keyPoints: ["办公室租约获批"],
  sources: [sourceLink(unrelatedStory)],
  marketDirection: "neutral",
  directionConfidence: 40,
}));
const unrelatedRecord = await db.saveDraft(unrelatedBrief, {
  stream: "shared",
  batchKey: "postgres-unrelated-bucket",
});
assert.notEqual(unrelatedRecord.brief.headlines[0].id, eventId);

const teslaStory = story(
  "https://postgres.example.com/tsla/battery-line",
  "Tesla opens a new battery production line",
  "Tesla started a separate battery production line.",
);
const teslaHeadline = headline({
  id: "postgres-new-before-conflict",
  rank: 1,
  ticker: "TSLA",
  title: "特斯拉启用新的电池产线",
  summary: "新的电池产线开始运作。",
  keyPoints: ["新产线启用"],
  category: "Other",
  sources: [sourceLink(teslaStory)],
  marketDirection: "neutral",
});
const conflictingHeadline = headline({
  id: "postgres-conflicting-aliases",
  rank: 2,
  sources: [sourceLink(sourceV1), sourceLink(unrelatedStory)],
});
const conflictingBrief = {
  ...brief(`${date}T01:36:00.000Z`, teslaHeadline),
  headlines: [teslaHeadline, conflictingHeadline],
  stats: { ...demoBrief.stats, topStories: 2, consolidatedEvents: 2 },
};
const beforeConflict = await raw.query<{ snapshots: number; events: number; versions: number }>(`
  SELECT
    (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
    (SELECT COUNT(*)::integer FROM events) AS events,
    (SELECT COUNT(*)::integer FROM event_versions) AS versions
`);
await assert.rejects(
  () => db.persistBriefObservation(conflictingBrief, { stream: "manual", batchKey: "postgres-conflict-bucket" }),
  /multiple existing events/,
);
const afterConflict = await raw.query<{ snapshots: number; events: number; versions: number }>(`
  SELECT
    (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
    (SELECT COUNT(*)::integer FROM events) AS events,
    (SELECT COUNT(*)::integer FROM event_versions) AS versions
`);
assert.deepEqual(afterConflict.rows[0], beforeConflict.rows[0]);
assert.equal((await db.listEventVersions(createStableEventIdentity(teslaHeadline).id)).length, 0);
assert.equal((await raw.query<{ status: string }>(`
  SELECT status FROM collection_runs WHERE stream = 'manual' AND batch_key = 'postgres-conflict-bucket'
`)).rows[0].status, "failed");

await assert.rejects(
  () => db.saveDraft(second, { stream: "shared", batchKey: "postgres-bucket-3" }),
  /reused with different brief content/,
);

const versionUpdateError = await raw.query("UPDATE event_versions SET payload = payload WHERE id = $1", [versions[0].id])
  .then(() => undefined, (error: { code?: string }) => error);
assert.equal(versionUpdateError?.code, "55000");
const snapshotDeleteError = await raw.query("DELETE FROM brief_snapshots WHERE id = $1", [snapshots[0].id])
  .then(() => undefined, (error: { code?: string }) => error);
assert.equal(snapshotDeleteError?.code, "55000");
const sourceDeleteError = await raw.query("DELETE FROM source_document_versions WHERE id = $1", [sourceVersions.rows[0].id])
  .then(() => undefined, (error: { code?: string }) => error);
assert.equal(sourceDeleteError?.code, "55000");

await assert.rejects(
  () => db.publishBrief(concurrent[0].id, concurrent[0].brief, Buffer.from("stale-pdf"), {
    stream: "publish",
    batchKey: "postgres-stale-publish",
  }),
  (error: unknown) => error instanceof db.StaleBriefRevisionError,
);
const currentDraft = await db.getBrief(concurrent[0].id);
assert.equal(currentDraft?.status, "draft");
const published = await db.publishBrief(concurrent[0].id, currentDraft!.brief, Buffer.from("frozen-pdf"), {
  stream: "publish",
  batchKey: "postgres-publish",
});
assert.equal(published.status, "published");
const frozenPayload = JSON.stringify(published.brief);
await db.persistBriefObservation(brief(`${date}T01:40:00.000Z`, headline({ marketDirection: "mixed" })), {
  stream: "shared",
  batchKey: "postgres-after-publish",
});
const afterRefresh = await db.getBrief(published.id);
assert.equal(JSON.stringify(afterRefresh?.brief), frozenPayload, "post-publication refresh must not mutate the published payload");
assert.equal((await db.getPublishedPdf(published.id))?.pdf.toString(), "frozen-pdf");

// Force the migration runner through a second process-local initialization;
// the migration ledger must prevent any duplicate backfill.
const beforeRerun = await raw.query<{ snapshots: number; versions: number }>(`
  SELECT
    (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
    (SELECT COUNT(*)::integer FROM event_versions) AS versions
`);
globalThis.__analystArenaSchemaReady = undefined;
await db.databaseHealth();
const afterRerun = await raw.query<{ snapshots: number; versions: number }>(`
  SELECT
    (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
    (SELECT COUNT(*)::integer FROM event_versions) AS versions
`);
assert.deepEqual(afterRerun.rows[0], beforeRerun.rows[0]);

await raw.end();
console.log("PostgreSQL migration, concurrency, immutability, and publication-freeze tests passed");
