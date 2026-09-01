import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
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
const legacyPublicationClock = await raw.query<{ published_at: string | Date }>(
  "SELECT clock_timestamp() AS published_at",
);
const legacyPublishedAt = new Date(
  legacyPublicationClock.rows[0].published_at,
).toISOString();
await raw.query(`
  INSERT INTO daily_briefs (id, brief_date, status, payload, pdf_data, published_at)
  VALUES ($1, $2, 'published', $3::jsonb, $4, $5)
`, [legacyId, legacyDate, JSON.stringify(legacyBrief), Buffer.from("legacy-pdf"), legacyPublishedAt]);

// Advance the fixture only through 7/22, then insert rows in the exact old
// event_aliases shape. The regular migration runner below must perform the
// one-time 7/23 production upgrade and classify these historical aliases.
const preAliasMigrationFiles = [
  "20260721_event_history.sql",
  "20260722_source_evidence_v2.sql",
  "20260722_source_observation_evidence_time.sql",
  "20260722_zz_snapshot_claim_presentations.sql",
];
await raw.query("BEGIN");
try {
  await raw.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const file of preAliasMigrationFiles) {
    await raw.query(readFileSync(path.join(process.cwd(), "db", "migrations", file), "utf8"));
    await raw.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
  }
  await raw.query("COMMIT");
} catch (error) {
  await raw.query("ROLLBACK");
  throw error;
}

const upgradeTime = `${legacyDate}T03:00:00.000Z`;
const upgradeTimeV2 = `${legacyDate}T03:10:00.000Z`;
const upgradeRunId = randomUUID();
await raw.query(`
  INSERT INTO collection_runs (
    id, stream, batch_key, status, brief_date, input_hash,
    started_at, completed_at
  ) VALUES ($1, 'legacy', $2, 'success', $3, 'upgrade-fixture',
            $4, $5)
`, [
  upgradeRunId,
  `pre-0723-alias-upgrade:${upgradeRunId}`,
  legacyDate,
  upgradeTime,
  upgradeTimeV2,
]);
const upgradeRolelessEventId = "evt_upgrade_roleless";
const upgradeRolelessVersionId = randomUUID();
const upgradeExplicitEventId = "evt_upgrade_explicit";
const upgradeExplicitVersionId = randomUUID();
const upgradeFormerEventId = "evt_upgrade_former_primary";
const upgradeFormerVersionV1Id = randomUUID();
const upgradeFormerVersionV2Id = randomUUID();
type UpgradeSource = SourceLink & {
  sourceDocumentId: string;
  canonicalUrl: string;
};
const upgradeRolelessFirst: UpgradeSource = {
  name: "Upgrade Wire",
  type: "News",
  url: "https://upgrade.example.com/roleless-first",
  canonicalUrl: "https://upgrade.example.com/roleless-first",
  sourceDocumentId: "sd_upgrade_roleless_first",
  originalTitle: "Quasar roleless source one",
};
const upgradeRolelessSecond: UpgradeSource = {
  name: "Upgrade Wire",
  type: "News",
  url: "https://upgrade.example.com/roleless-second",
  canonicalUrl: "https://upgrade.example.com/roleless-second",
  sourceDocumentId: "sd_upgrade_roleless_second",
  originalTitle: "Quasar roleless source two",
};
const upgradeExplicitPrimary: UpgradeSource = {
  name: "Upgrade Wire",
  type: "News",
  role: "primary",
  url: "https://upgrade.example.com/explicit-primary",
  canonicalUrl: "https://upgrade.example.com/explicit-primary",
  sourceDocumentId: "sd_upgrade_explicit_primary",
  originalTitle: "Nebula explicit primary",
};
const upgradeExplicitCorroborating: UpgradeSource = {
  name: "Upgrade Wire",
  type: "News",
  role: "corroborating",
  url: "https://upgrade.example.com/explicit-corroborating",
  canonicalUrl: "https://upgrade.example.com/explicit-corroborating",
  sourceDocumentId: "sd_upgrade_explicit_corroborating",
  originalTitle: "Nebula explicit corroboration",
};
const upgradeMixedUnknown: UpgradeSource = {
  name: "Upgrade Wire",
  type: "News",
  url: "https://upgrade.example.com/mixed-unknown",
  canonicalUrl: "https://upgrade.example.com/mixed-unknown",
  sourceDocumentId: "sd_upgrade_mixed_unknown",
  originalTitle: "Nebula source with missing historical role",
};
const upgradeOrphanDocumentId = "sd_upgrade_orphan_unmatched";
const upgradeOrphanCanonicalUrl = "https://upgrade.example.com/orphan-unmatched";
const upgradeFormerPrimary: UpgradeSource = {
  name: "Upgrade Wire",
  type: "News",
  role: "primary",
  url: "https://upgrade.example.com/former-primary",
  canonicalUrl: "https://upgrade.example.com/former-primary",
  sourceDocumentId: "sd_upgrade_former_primary",
  originalTitle: "Pulsar former primary",
};
const upgradeReplacementPrimary: UpgradeSource = {
  name: "Upgrade Wire",
  type: "News",
  role: "primary",
  url: "https://upgrade.example.com/replacement-primary",
  canonicalUrl: "https://upgrade.example.com/replacement-primary",
  sourceDocumentId: "sd_upgrade_replacement_primary",
  originalTitle: "Pulsar replacement primary",
};
const upgradeHeadline = (
  id: string,
  ticker: string,
  title: string,
  sources: SourceLink[],
): Headline => ({
  ...structuredClone(demoBrief.headlines[0]),
  id,
  ticker,
  category: "Other",
  title,
  summary: `${title} historical upgrade fixture.`,
  keyPoints: [`${title} evidence`],
  sources,
  claims: [],
  equityImpacts: [],
});
const upgradeRolelessHeadline = upgradeHeadline(
  upgradeRolelessEventId,
  "UPG1",
  "Quasar roleless historical event",
  [upgradeRolelessFirst, upgradeRolelessSecond],
);
const upgradeExplicitHeadline = upgradeHeadline(
  upgradeExplicitEventId,
  "UPG2",
  "Nebula mixed-role historical event",
  [upgradeExplicitPrimary, upgradeExplicitCorroborating, upgradeMixedUnknown],
);
const upgradeFormerHeadlineV1 = upgradeHeadline(
  upgradeFormerEventId,
  "UPG3",
  "Pulsar former-primary event",
  [upgradeFormerPrimary],
);
const upgradeFormerHeadlineV2 = upgradeHeadline(
  upgradeFormerEventId,
  "UPG3",
  "Pulsar replacement-primary event",
  [
    upgradeReplacementPrimary,
    { ...upgradeFormerPrimary, role: "corroborating" },
  ],
);

for (const event of [
  {
    id: upgradeRolelessEventId,
    stableKey: "upgrade:roleless",
    title: upgradeRolelessHeadline.title,
    ticker: "UPG1",
  },
  {
    id: upgradeExplicitEventId,
    stableKey: "upgrade:explicit",
    title: upgradeExplicitHeadline.title,
    ticker: "UPG2",
  },
  {
    id: upgradeFormerEventId,
    stableKey: "upgrade:former-primary",
    title: upgradeFormerHeadlineV2.title,
    ticker: "UPG3",
  },
]) {
  await raw.query(`
    INSERT INTO events (
      id, stable_key, canonical_title, category, ticker,
      first_seen_at, last_seen_at, identity_quality
    ) VALUES ($1, $2, $3, 'Other', $4, $5, $6, 'legacy_unmatched')
  `, [event.id, event.stableKey, event.title, event.ticker, upgradeTime, upgradeTimeV2]);
}

const insertUpgradeVersion = async (
  id: string,
  eventId: string,
  versionNumber: number,
  previousVersionId: string | null,
  observedAt: string,
  headlinePayload: Headline,
) => {
  await raw.query(`
    INSERT INTO event_versions (
      id, event_id, version_number, previous_version_id,
      content_hash, evidence_hash, state_hash, presentation_hash,
      observed_at, run_id, payload
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
    )
  `, [
    id,
    eventId,
    versionNumber,
    previousVersionId,
    `upgrade-content:${id}`,
    `upgrade-evidence:${id}`,
    `upgrade-state:${id}`,
    `upgrade-presentation:${id}`,
    observedAt,
    upgradeRunId,
    JSON.stringify({ headline: headlinePayload }),
  ]);
};
await insertUpgradeVersion(
  upgradeRolelessVersionId,
  upgradeRolelessEventId,
  1,
  null,
  upgradeTime,
  upgradeRolelessHeadline,
);
await insertUpgradeVersion(
  upgradeExplicitVersionId,
  upgradeExplicitEventId,
  1,
  null,
  upgradeTime,
  upgradeExplicitHeadline,
);
await insertUpgradeVersion(
  upgradeFormerVersionV1Id,
  upgradeFormerEventId,
  1,
  null,
  upgradeTime,
  upgradeFormerHeadlineV1,
);
await insertUpgradeVersion(
  upgradeFormerVersionV2Id,
  upgradeFormerEventId,
  2,
  upgradeFormerVersionV1Id,
  upgradeTimeV2,
  upgradeFormerHeadlineV2,
);

const upgradeUrlKey = (canonicalUrl: string) =>
  createHash("sha256").update(canonicalUrl, "utf8").digest("hex");
const upgradeAliasRows: Array<[
  "document" | "url" | "legacy",
  string,
  string,
  string | null,
]> = [
  ["document", upgradeRolelessFirst.sourceDocumentId, upgradeRolelessEventId, upgradeRolelessFirst.canonicalUrl],
  ["url", upgradeUrlKey(upgradeRolelessFirst.canonicalUrl), upgradeRolelessEventId, upgradeRolelessFirst.canonicalUrl],
  ["document", upgradeRolelessSecond.sourceDocumentId, upgradeRolelessEventId, upgradeRolelessSecond.canonicalUrl],
  ["url", upgradeUrlKey(upgradeRolelessSecond.canonicalUrl), upgradeRolelessEventId, upgradeRolelessSecond.canonicalUrl],
  ["document", upgradeExplicitPrimary.sourceDocumentId, upgradeExplicitEventId, upgradeExplicitPrimary.canonicalUrl],
  ["url", upgradeUrlKey(upgradeExplicitPrimary.canonicalUrl), upgradeExplicitEventId, upgradeExplicitPrimary.canonicalUrl],
  ["document", upgradeExplicitCorroborating.sourceDocumentId, upgradeExplicitEventId, upgradeExplicitCorroborating.canonicalUrl],
  ["url", upgradeUrlKey(upgradeExplicitCorroborating.canonicalUrl), upgradeExplicitEventId, upgradeExplicitCorroborating.canonicalUrl],
  ["document", upgradeMixedUnknown.sourceDocumentId, upgradeExplicitEventId, upgradeMixedUnknown.canonicalUrl],
  ["url", upgradeUrlKey(upgradeMixedUnknown.canonicalUrl), upgradeExplicitEventId, upgradeMixedUnknown.canonicalUrl],
  ["document", upgradeOrphanDocumentId, upgradeExplicitEventId, upgradeOrphanCanonicalUrl],
  ["url", upgradeUrlKey(upgradeOrphanCanonicalUrl), upgradeExplicitEventId, upgradeOrphanCanonicalUrl],
  ["document", upgradeFormerPrimary.sourceDocumentId, upgradeFormerEventId, upgradeFormerPrimary.canonicalUrl],
  ["url", upgradeUrlKey(upgradeFormerPrimary.canonicalUrl), upgradeFormerEventId, upgradeFormerPrimary.canonicalUrl],
  ["legacy", "legacy-reused-collision-id", upgradeRolelessEventId, null],
];
for (const [type, key, eventId, canonicalUrl] of upgradeAliasRows) {
  await raw.query(`
    INSERT INTO event_aliases (
      alias_type, alias_key, event_id, canonical_url,
      first_seen_at, last_seen_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
  `, [type, key, eventId, canonicalUrl, upgradeTime, upgradeTimeV2]);
}

const db = await import("../lib/db");
const health = await db.databaseHealth();
assert.equal(health.ok, true);

const migrationRows = await raw.query<{ id: string }>(`
  SELECT id FROM schema_migrations WHERE id = '20260721_event_history.sql'
`);
assert.equal(migrationRows.rowCount, 1);
const aliasOwnershipMigration = await raw.query<{ id: string }>(`
  SELECT id
  FROM schema_migrations
  WHERE id = '20260723_event_alias_primary_ownership.sql'
`);
assert.equal(
  aliasOwnershipMigration.rowCount,
  1,
  "the primary-source alias ownership migration must be applied before observations",
);
const upgradedAliases = await raw.query<{
  alias_type: string;
  alias_key: string;
  primary_ever: boolean;
  owner_event_version_id: string | null;
  resolution_eligible: boolean;
}>(`
  SELECT alias_type, alias_key, primary_ever, owner_event_version_id,
         analystarena_event_version_owns_alias(
           event_id,
           owner_event_version_id,
           alias_type,
           alias_key,
           canonical_url
         ) AS resolution_eligible
  FROM event_aliases
  WHERE alias_key = ANY($1::text[])
`, [upgradeAliasRows.map(([, key]) => key)]);
const upgradedAliasMap = new Map(
  upgradedAliases.rows.map((row) => [`${row.alias_type}:${row.alias_key}`, row]),
);
const expectUpgradedOwnership = (
  type: "document" | "url" | "legacy",
  key: string,
  primaryEver: boolean,
  ownerVersionId: string | null,
  resolutionEligible: boolean,
) => {
  const row = upgradedAliasMap.get(`${type}:${key}`);
  assert.ok(row, `missing upgraded alias ${type}:${key}`);
  assert.equal(row.primary_ever, primaryEver);
  assert.equal(row.owner_event_version_id, ownerVersionId);
  assert.equal(row.resolution_eligible, resolutionEligible);
};
expectUpgradedOwnership(
  "document",
  upgradeRolelessFirst.sourceDocumentId,
  true,
  upgradeRolelessVersionId,
  false,
);
expectUpgradedOwnership(
  "url",
  upgradeUrlKey(upgradeRolelessFirst.canonicalUrl),
  true,
  upgradeRolelessVersionId,
  false,
);
expectUpgradedOwnership(
  "document",
  upgradeRolelessSecond.sourceDocumentId,
  true,
  upgradeRolelessVersionId,
  false,
);
expectUpgradedOwnership(
  "url",
  upgradeUrlKey(upgradeRolelessSecond.canonicalUrl),
  true,
  upgradeRolelessVersionId,
  false,
);
expectUpgradedOwnership(
  "document",
  upgradeExplicitPrimary.sourceDocumentId,
  true,
  upgradeExplicitVersionId,
  true,
);
expectUpgradedOwnership(
  "document",
  upgradeExplicitCorroborating.sourceDocumentId,
  false,
  null,
  false,
);
expectUpgradedOwnership(
  "url",
  upgradeUrlKey(upgradeExplicitCorroborating.canonicalUrl),
  false,
  null,
  false,
);
expectUpgradedOwnership(
  "document",
  upgradeMixedUnknown.sourceDocumentId,
  true,
  upgradeExplicitVersionId,
  false,
);
expectUpgradedOwnership(
  "url",
  upgradeUrlKey(upgradeMixedUnknown.canonicalUrl),
  true,
  upgradeExplicitVersionId,
  false,
);
expectUpgradedOwnership(
  "document",
  upgradeOrphanDocumentId,
  true,
  upgradeExplicitVersionId,
  false,
);
expectUpgradedOwnership(
  "url",
  upgradeUrlKey(upgradeOrphanCanonicalUrl),
  true,
  upgradeExplicitVersionId,
  false,
);
expectUpgradedOwnership(
  "document",
  upgradeFormerPrimary.sourceDocumentId,
  true,
  upgradeFormerVersionV1Id,
  true,
);
expectUpgradedOwnership(
  "url",
  upgradeUrlKey(upgradeFormerPrimary.canonicalUrl),
  true,
  upgradeFormerVersionV1Id,
  true,
);
expectUpgradedOwnership(
  "legacy",
  "legacy-reused-collision-id",
  true,
  upgradeRolelessVersionId,
  false,
);
const legacySnapshot = await raw.query<{ id: string; payload: DailyBrief; actor_type: string }>(`
  SELECT id, payload, actor_type
  FROM brief_snapshots
  WHERE stream = 'legacy' AND batch_key = $1
`, [`daily-brief:${legacyId}`]);
assert.equal(legacySnapshot.rowCount, 1);
assert.equal(legacySnapshot.rows[0].payload.date, legacyDate);
assert.equal(legacySnapshot.rows[0].actor_type, "legacy");
assert.ok(legacySnapshot.rows[0].payload.headlines.every((headline) => headline.id.startsWith("evt_legacy_")));
assert.equal((await raw.query("SELECT COUNT(*)::integer AS count FROM event_versions WHERE run_id = $1", [legacyId])).rows[0].count, legacyBrief.headlines.length);
assert.equal(
  (await raw.query<{ current_snapshot_id: string }>(
    "SELECT current_snapshot_id FROM daily_briefs WHERE id = $1",
    [legacyId],
  )).rows[0].current_snapshot_id,
  legacySnapshot.rows[0].id,
  "the 7/23 migration must bind a pre-migration daily brief to its exact legacy snapshot",
);
assert.equal(
  (await raw.query<{ count: number }>(`
    SELECT COUNT(*)::integer AS count
    FROM event_versions
    WHERE run_id = $1 AND actor_type = 'legacy'
  `, [legacyId])).rows[0].count,
  legacyBrief.headlines.length,
  "event versions that predate actor auditing must be labelled legacy rather than system",
);

async function expectAdminActorAuditConstraint(
  table: "event_versions" | "brief_snapshots",
  immutableTrigger: "event_versions_immutable" | "brief_snapshots_immutable",
  id: string,
): Promise<void> {
  await raw.query(`ALTER TABLE ${table} DISABLE TRIGGER ${immutableTrigger}`);
  try {
    const error = await raw.query(
      `UPDATE ${table}
       SET actor_type = 'admin', actor_id_hash = NULL
       WHERE id = $1`,
      [id],
    ).then(() => undefined, (value: { code?: string }) => value);
    assert.equal(
      error?.code,
      "23514",
      `${table} must reject an admin actor without a pseudonymous id, reason, and request id`,
    );
  } finally {
    await raw.query(`ALTER TABLE ${table} ENABLE TRIGGER ${immutableTrigger}`);
  }
}

const legacyEventVersionId = (await raw.query<{ id: string }>(
  "SELECT id FROM event_versions WHERE run_id = $1 ORDER BY version_number LIMIT 1",
  [legacyId],
)).rows[0].id;
await expectAdminActorAuditConstraint(
  "event_versions",
  "event_versions_immutable",
  legacyEventVersionId,
);
await expectAdminActorAuditConstraint(
  "brief_snapshots",
  "brief_snapshots_immutable",
  legacySnapshot.rows[0].id,
);

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

// Concurrent writes do not have a deterministic lock-acquisition order. Give
// both observations the same logical timestamp so this test exercises chain
// serialization without manufacturing a time-reversing event/snapshot.
const second = brief(`${date}T01:30:00.000Z`, headline({ marketDirection: "bearish" }));
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

const reusedLegacyIdStory = story(
  "https://postgres.example.com/identity/reused-legacy-id",
  "Independent municipal bond covenant update",
  "A municipal bond covenant changed independently of the old quasar event.",
);
const reusedLegacyIdRecord = await db.saveDraft(brief(`${date}T01:35:05.000Z`, headline({
  id: "legacy-reused-collision-id",
  ticker: "MUNI",
  category: "Macro",
  title: "市政债券契约出现独立调整",
  summary: "本事件与旧版采集器使用同一临时编号，但事实与来源完全无关。",
  keyPoints: ["本地采集编号不能决定事件身份"],
  sources: [{ ...sourceLink(reusedLegacyIdStory), role: "primary" }],
  claims: [],
})), {
  stream: "shared",
  batchKey: "postgres-reused-legacy-id",
});
assert.notEqual(
  reusedLegacyIdRecord.brief.headlines[0].id,
  upgradeRolelessEventId,
  "a reused collector-local legacy id must not merge an unrelated event",
);
assert.equal(reusedLegacyIdRecord.brief.snapshot?.events[0].matchMethod, "new");

const rolelessFirstReappearance = headline({
  id: "postgres-roleless-first-reappeared",
  ticker: upgradeRolelessHeadline.ticker,
  category: upgradeRolelessHeadline.category,
  title: upgradeRolelessHeadline.title,
  summary: upgradeRolelessHeadline.summary,
  keyPoints: structuredClone(upgradeRolelessHeadline.keyPoints),
  sources: [{ ...upgradeRolelessFirst, role: "primary" }],
  claims: [],
});
const rolelessVersionCountBeforeConflict = (
  await db.listEventVersions(upgradeRolelessEventId)
).length;
await assert.rejects(
  () => db.saveDraft(brief(`${date}T01:35:06.000Z`, rolelessFirstReappearance), {
    stream: "shared",
    batchKey: "postgres-roleless-first-reappeared",
  }),
  /protected but not resolution-eligible; manual provenance review is required/,
  "a roleless first source must remain ambiguous even when semantic matching points to its old event",
);
assert.equal(
  (await db.listEventVersions(upgradeRolelessEventId)).length,
  rolelessVersionCountBeforeConflict,
  "an unresolved roleless alias must fail before appending to the semantically matching old event",
);

const orphanAliasStory = story(
  upgradeOrphanCanonicalUrl,
  "Independent insurance reserve methodology update",
  "An insurer changed its reserve methodology independently of the old nebula event.",
);
const orphanAliasHeadline = headline({
  id: "postgres-orphan-alias-reappeared",
  ticker: "INSURE",
  category: "Other",
  title: "保险准备金方法出现独立调整",
  summary: "无法证明归属的旧别名不得自动合并，也不得自动转移。",
  keyPoints: ["未知别名必须进入人工来源审查"],
  sources: [{ ...sourceLink(orphanAliasStory), role: "primary" }],
  claims: [],
});
const orphanCandidateEventId = createStableEventIdentity(orphanAliasHeadline).id;
await assert.rejects(
  () => db.saveDraft(brief(`${date}T01:35:07.000Z`, orphanAliasHeadline), {
    stream: "shared",
    batchKey: "postgres-orphan-alias-reappeared",
  }),
  /protected but not resolution-eligible; manual provenance review is required/,
  "an unresolved protected alias must never force an unrelated event merge",
);
assert.equal(
  (await db.listEventVersions(orphanCandidateEventId)).length,
  0,
  "the explicit provenance conflict must roll back the isolated candidate event",
);
const orphanAliasAfterConflict = await raw.query<{
  event_id: string;
  primary_ever: boolean;
}>(`
  SELECT event_id, primary_ever
  FROM event_aliases
  WHERE alias_type = 'url' AND alias_key = $1
`, [upgradeUrlKey(upgradeOrphanCanonicalUrl)]);
assert.equal(orphanAliasAfterConflict.rows[0].event_id, upgradeExplicitEventId);
assert.equal(orphanAliasAfterConflict.rows[0].primary_ever, true);

// A source that was ever primary remains protected after a later version
// demotes it to corroborating.
const formerPrimaryStory = story(
  "https://postgres.example.com/identity/former-primary",
  "Former primary identity for a durable event",
  "The first document establishes the durable event identity.",
);
const replacementPrimaryStory = story(
  "https://postgres.example.com/identity/replacement-primary",
  "Official replacement document for the durable event",
  "A later official document becomes the displayed primary source.",
);
const formerPrimarySeed = await db.saveDraft(brief(`${date}T01:35:10.000Z`, headline({
  id: "postgres-former-primary-seed",
  ticker: "ALIASA",
  category: "Other",
  title: "持久事件最初由第一份文件确认",
  summary: "第一份文件建立该事件的身份。",
  keyPoints: ["第一份文件是主来源"],
  sources: [{ ...sourceLink(formerPrimaryStory), role: "primary" }],
  claims: [],
})), {
  stream: "shared",
  batchKey: "postgres-former-primary-seed",
});
const formerPrimaryEventId = formerPrimarySeed.brief.headlines[0].id;
await db.saveDraft(brief(`${date}T01:35:20.000Z`, headline({
  id: formerPrimaryEventId,
  ticker: "ALIASA",
  category: "Other",
  title: "官方文件成为新的显示主来源",
  summary: "同一事件现在优先展示官方文件。",
  keyPoints: ["官方文件成为显示主来源"],
  sources: [
    { ...sourceLink(replacementPrimaryStory), role: "primary" },
    { ...sourceLink(formerPrimaryStory), role: "corroborating" },
  ],
  claims: [],
})), {
  stream: "shared",
  batchKey: "postgres-former-primary-demoted",
});
const formerPrimaryReturn = await db.saveDraft(brief(`${date}T01:35:30.000Z`, headline({
  id: "postgres-former-primary-return",
  ticker: "ALIASB",
  category: "Other",
  title: "第一份文件再次作为主来源出现",
  summary: "曾经的主来源不得被另一个事件夺走。",
  keyPoints: ["历史主来源保持永久归属"],
  sources: [{ ...sourceLink(formerPrimaryStory), role: "primary" }],
  claims: [],
})), {
  stream: "shared",
  batchKey: "postgres-former-primary-return",
});
assert.equal(formerPrimaryReturn.brief.headlines[0].id, formerPrimaryEventId);
assert.equal(
  formerPrimaryReturn.brief.snapshot?.events[0].matchMethod,
  "source_alias",
);
const protectedFormerAlias = await raw.query<{
  event_id: string;
  primary_ever: boolean;
  owner_event_version_id: string | null;
}>(`
  SELECT event_id, primary_ever, owner_event_version_id
  FROM event_aliases
  WHERE alias_type = 'document' AND alias_key = $1
`, [formerPrimaryStory.sourceDocumentId]);
assert.equal(protectedFormerAlias.rows[0].event_id, formerPrimaryEventId);
assert.equal(protectedFormerAlias.rows[0].primary_ever, true);
assert.ok(protectedFormerAlias.rows[0].owner_event_version_id);

// A role-less historical payload is ambiguous, not proven corruption. Every
// matching source is conservatively protected during migration analysis, even
// though only the first source is accepted for a new exact write.
const ambiguousFirstStory = story(
  "https://postgres.example.com/identity/ambiguous-first",
  "Ambiguous legacy source one",
  "A legacy payload did not declare source roles.",
);
const ambiguousSecondStory = story(
  "https://postgres.example.com/identity/ambiguous-second",
  "Ambiguous legacy source two",
  "The second legacy source may have been the real primary.",
);
const ambiguousPayloadHeadline = headline({
  id: "postgres-ambiguous-legacy-roles",
  ticker: "AMBIG",
  category: "Other",
  title: "旧版来源角色无法确定",
  summary: "没有角色的历史来源必须保守保护。",
  keyPoints: ["不得猜测第二来源只是佐证"],
  sources: [sourceLink(ambiguousFirstStory), sourceLink(ambiguousSecondStory)],
  claims: [],
});
const ambiguousEventId = `evt_ambiguous_${randomUUID().replaceAll("-", "")}`;
const ambiguousRunId = randomUUID();
const ambiguousVersionId = randomUUID();
await raw.query(`
  INSERT INTO collection_runs (
    id, stream, batch_key, status, brief_date, input_hash,
    started_at, completed_at
  ) VALUES ($1, 'legacy', $2, 'success', $3, 'legacy-test',
            $4, $4)
`, [
  ambiguousRunId,
  `postgres-ambiguous-legacy-roles:${ambiguousRunId}`,
  date,
  `${date}T01:35:40.000Z`,
]);
await raw.query(`
  INSERT INTO events (
    id, stable_key, canonical_title, category, ticker,
    first_seen_at, last_seen_at, identity_quality
  ) VALUES ($1, $2, $3, 'Other', 'AMBIG', $4, $4, 'legacy_unmatched')
`, [
  ambiguousEventId,
  `ambiguous:${ambiguousEventId}`,
  ambiguousPayloadHeadline.title,
  `${date}T01:35:40.000Z`,
]);
await raw.query(`
  INSERT INTO event_versions (
    id, event_id, version_number, previous_version_id,
    content_hash, evidence_hash, state_hash, presentation_hash,
    observed_at, run_id, payload, actor_type
  ) VALUES (
    $1, $2, 1, NULL, 'legacy-content', 'legacy-evidence',
    'legacy-state', 'legacy-presentation', $3, $4, $5::jsonb, 'legacy'
  )
`, [
  ambiguousVersionId,
  ambiguousEventId,
  `${date}T01:35:40.000Z`,
  ambiguousRunId,
  JSON.stringify({ headline: ambiguousPayloadHeadline }),
]);
const ambiguousProtection = await raw.query<{
  protects: boolean;
  owns: boolean;
}>(`
  SELECT
    analystarena_event_version_protects_historical_alias(
      $1, $2, 'document', $3, $4
    ) AS protects,
    analystarena_event_version_owns_alias(
      $1, $2, 'document', $3, $4
    ) AS owns
`, [
  ambiguousEventId,
  ambiguousVersionId,
  ambiguousSecondStory.sourceDocumentId,
  ambiguousSecondStory.canonicalUrl,
]);
assert.equal(ambiguousProtection.rows[0].protects, true);
assert.equal(ambiguousProtection.rows[0].owns, false);

// Simulate one exact row produced by the pre-7/23 bug: an explicitly
// corroborating document was nevertheless registered as the event alias.
const pollutedOwnerStory = story(
  "https://postgres.example.com/identity/polluted-owner",
  "Federal water policy establishes an unrelated event",
  "A federal water policy is unrelated to the shared market document.",
);
const pollutedSharedStory = story(
  "https://postgres.example.com/identity/shared-market-document",
  "Tesla battery deliveries accelerate",
  "Tesla battery deliveries accelerated during the quarter.",
);
const pollutedOwner = await db.saveDraft(brief(`${date}T01:35:50.000Z`, headline({
  id: "postgres-polluted-alias-owner",
  ticker: "WATER",
  category: "Macro",
  title: "联邦水资源政策形成独立事件",
  summary: "该政策与特斯拉电池交付没有关系。",
  keyPoints: ["联邦政策独立成事"],
  sources: [
    { ...sourceLink(pollutedOwnerStory), role: "primary" },
    { ...sourceLink(pollutedSharedStory), role: "corroborating" },
  ],
  claims: [],
})), {
  stream: "shared",
  batchKey: "postgres-polluted-alias-owner",
});
const pollutedOwnerEventId = pollutedOwner.brief.headlines[0].id;
const pollutedOwnerVersionId = pollutedOwner.brief.snapshot!.events[0].eventVersionId;
const provenCorroborating = await raw.query<{ protects: boolean }>(`
  SELECT analystarena_event_version_protects_historical_alias(
    $1, $2, 'document', $3, $4
  ) AS protects
`, [
  pollutedOwnerEventId,
  pollutedOwnerVersionId,
  pollutedSharedStory.sourceDocumentId,
  pollutedSharedStory.canonicalUrl,
]);
assert.equal(provenCorroborating.rows[0].protects, false);

await raw.query("ALTER TABLE event_aliases DISABLE TRIGGER event_aliases_guard_assignment");
try {
  await raw.query(`
    INSERT INTO event_aliases (
      alias_type, alias_key, event_id, canonical_url,
      first_seen_at, last_seen_at, primary_ever, owner_event_version_id
    ) VALUES ('document', $1, $2, $3, $4, $4, FALSE, NULL)
  `, [
    pollutedSharedStory.sourceDocumentId,
    pollutedOwnerEventId,
    pollutedSharedStory.canonicalUrl,
    `${date}T01:35:50.000Z`,
  ]);
} finally {
  await raw.query("ALTER TABLE event_aliases ENABLE TRIGGER event_aliases_guard_assignment");
}

const correctedOwner = await db.saveDraft(brief(`${date}T01:36:00.000Z`, headline({
  id: "postgres-corrected-polluted-alias-owner",
  ticker: "TSLA",
  category: "Other",
  title: "特斯拉电池交付加速",
  summary: "共享文件现在作为真正事件的主来源。",
  keyPoints: ["特斯拉电池交付加速"],
  sources: [{ ...sourceLink(pollutedSharedStory), role: "primary" }],
  claims: [],
})), {
  stream: "shared",
  batchKey: "postgres-corrected-polluted-alias-owner",
});
const correctedOwnerEventId = correctedOwner.brief.headlines[0].id;
const correctedOwnerVersionId = correctedOwner.brief.snapshot!.events[0].eventVersionId;
assert.notEqual(correctedOwnerEventId, pollutedOwnerEventId);
assert.equal(correctedOwner.brief.snapshot?.events[0].matchMethod, "new");
const correctedAlias = await raw.query<{
  event_id: string;
  primary_ever: boolean;
  owner_event_version_id: string;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
}>(`
  SELECT event_id, primary_ever, owner_event_version_id,
         first_seen_at, last_seen_at
  FROM event_aliases
  WHERE alias_type = 'document' AND alias_key = $1
`, [pollutedSharedStory.sourceDocumentId]);
assert.equal(correctedAlias.rows[0].event_id, correctedOwnerEventId);
assert.equal(correctedAlias.rows[0].primary_ever, true);
assert.equal(correctedAlias.rows[0].owner_event_version_id, correctedOwnerVersionId);
assert.equal(
  new Date(correctedAlias.rows[0].first_seen_at).toISOString(),
  `${date}T01:36:00.000Z`,
);
assert.equal(
  new Date(correctedAlias.rows[0].last_seen_at).toISOString(),
  `${date}T01:36:00.000Z`,
);
const assignmentHistory = await raw.query<{
  id: string;
  from_event_id: string;
  to_event_id: string;
  to_owner_event_version_id: string;
  target_run_id: string;
  reason_code: string;
}>(`
  SELECT id::text, from_event_id, to_event_id, to_owner_event_version_id,
         target_run_id, reason_code
  FROM event_alias_assignment_history
  WHERE alias_type = 'document' AND alias_key = $1
`, [pollutedSharedStory.sourceDocumentId]);
assert.equal(assignmentHistory.rowCount, 1);
assert.equal(assignmentHistory.rows[0].from_event_id, pollutedOwnerEventId);
assert.equal(assignmentHistory.rows[0].to_event_id, correctedOwnerEventId);
assert.equal(assignmentHistory.rows[0].to_owner_event_version_id, correctedOwnerVersionId);
assert.equal(assignmentHistory.rows[0].reason_code, "legacy_corrob_alias_cleanup");
assert.equal(
  assignmentHistory.rows[0].target_run_id,
  correctedOwner.brief.snapshot!.runId,
);

// The corrected primary is protected against application-independent SQL
// theft, alias-key mutation, malformed URL identity, and history rewriting.
const directTheftError = await raw.query(`
  UPDATE event_aliases
  SET event_id = $2, owner_event_version_id = $3
  WHERE alias_type = 'document' AND alias_key = $1
`, [
  pollutedSharedStory.sourceDocumentId,
  pollutedOwnerEventId,
  pollutedOwnerVersionId,
]).then(() => undefined, (error: { code?: string }) => error);
assert.equal(directTheftError?.code, "23505");
const aliasKeyMutationError = await raw.query(`
  UPDATE event_aliases
  SET alias_key = alias_key || '-tampered'
  WHERE alias_type = 'document' AND alias_key = $1
`, [pollutedSharedStory.sourceDocumentId])
  .then(() => undefined, (error: { code?: string }) => error);
assert.equal(aliasKeyMutationError?.code, "55000");
const aliasDeleteError = await raw.query(`
  DELETE FROM event_aliases
  WHERE alias_type = 'document' AND alias_key = $1
`, [pollutedSharedStory.sourceDocumentId])
  .then(() => undefined, (error: { code?: string }) => error);
assert.equal(aliasDeleteError?.code, "55000");
const aliasTruncateError = await raw.query("TRUNCATE event_aliases")
  .then(() => undefined, (error: { code?: string }) => error);
assert.equal(aliasTruncateError?.code, "55000");
const malformedUrlAliasError = await raw.query(`
  INSERT INTO event_aliases (
    alias_type, alias_key, event_id, canonical_url,
    first_seen_at, last_seen_at, primary_ever, owner_event_version_id
  ) VALUES ('url', $1, $2, $3, $4, $4, TRUE, $5)
`, [
  "0".repeat(64),
  correctedOwnerEventId,
  pollutedSharedStory.canonicalUrl,
  `${date}T01:36:00.000Z`,
  correctedOwnerVersionId,
]).then(() => undefined, (error: { code?: string }) => error);
assert.equal(malformedUrlAliasError?.code, "23514");
const newLegacyAliasError = await raw.query(`
  INSERT INTO event_aliases (
    alias_type, alias_key, event_id, canonical_url,
    first_seen_at, last_seen_at, primary_ever, owner_event_version_id
  ) VALUES ('legacy', 'new-unproven-legacy-id', $1, NULL, $2, $2, TRUE, $3)
`, [
  correctedOwnerEventId,
  `${date}T01:36:00.000Z`,
  correctedOwnerVersionId,
]).then(() => undefined, (error: { code?: string }) => error);
assert.equal(newLegacyAliasError?.code, "23514");
const historyUpdateError = await raw.query(`
  UPDATE event_alias_assignment_history
  SET reason_code = reason_code
  WHERE id = $1
`, [assignmentHistory.rows[0].id])
  .then(() => undefined, (error: { code?: string }) => error);
assert.equal(historyUpdateError?.code, "55000");
const historyDeleteError = await raw.query(
  "DELETE FROM event_alias_assignment_history WHERE id = $1",
  [assignmentHistory.rows[0].id],
).then(() => undefined, (error: { code?: string }) => error);
assert.equal(historyDeleteError?.code, "55000");
const historyTruncateError = await raw.query(
  "TRUNCATE event_alias_assignment_history",
).then(() => undefined, (error: { code?: string }) => error);
assert.equal(historyTruncateError?.code, "55000");

// The PostgreSQL candidate map must refresh after headline one in the same
// transaction. Headline two resembles the pre-batch version but sees the newly
// persisted policy version and therefore remains a separate event.
const batchOldStory = story(
  "https://postgres.example.com/identity/batch-old-blackwell",
  "NVIDIA Blackwell capacity update expands supplier orders",
  "Blackwell supplier orders expanded after a capacity update.",
);
const batchPolicyStory = story(
  "https://postgres.example.com/identity/batch-new-policy",
  "Federal retirement filing policy changes next quarter",
  "A federal retirement filing policy changes next quarter.",
);
const batchNvidiaStory = story(
  "https://postgres.example.com/identity/batch-nvidia-followup",
  "NVIDIA Blackwell capacity update expands supplier orders again",
  "Blackwell supplier orders expanded again after a capacity update.",
);
const batchSeed = await db.saveDraft(brief(`${date}T01:36:10.000Z`, headline({
  id: "postgres-same-batch-seed",
  ticker: "NVDA",
  category: "Semiconductor",
  title: "英伟达 Blackwell 产能更新推动供应商订单",
  summary: "供应商订单因 Blackwell 产能更新而增加。",
  keyPoints: ["Blackwell 供应商订单增加"],
  sources: [{ ...sourceLink(batchOldStory), role: "primary" }],
  claims: [],
})), {
  stream: "shared",
  batchKey: "postgres-same-batch-seed",
});
const batchSeedEventId = batchSeed.brief.headlines[0].id;
const batchUpdatedHeadline = headline({
  id: batchSeedEventId,
  rank: 1,
  ticker: "POLICY",
  category: "Macro",
  title: "联邦退休申报政策将在下季度调整",
  summary: "这是一项与半导体无关的申报政策调整。",
  keyPoints: ["退休申报政策调整"],
  sources: [
    { ...sourceLink(batchPolicyStory), role: "primary" },
    { ...sourceLink(batchOldStory), role: "corroborating" },
  ],
  claims: [],
});
const batchSecondHeadline = headline({
  id: "postgres-same-batch-secondary",
  rank: 2,
  ticker: "NVDA",
  category: "Semiconductor",
  title: "英伟达 Blackwell 供应商订单再次增加",
  summary: "供应商订单在产能更新后再次增加。",
  keyPoints: ["Blackwell 供应商订单再次增加"],
  sources: [
    { ...sourceLink(batchNvidiaStory), role: "primary" },
    { ...sourceLink(batchPolicyStory), role: "corroborating" },
  ],
  claims: [],
});
const refreshedBatch = await db.persistBriefObservation({
  ...brief(`${date}T01:36:20.000Z`, batchUpdatedHeadline),
  headlines: [batchUpdatedHeadline, batchSecondHeadline],
  stats: { ...demoBrief.stats, topStories: 2, consolidatedEvents: 2 },
}, {
  stream: "manual",
  batchKey: "postgres-same-batch-candidate-refresh",
});
assert.notEqual(refreshedBatch.brief.headlines[1].id, batchSeedEventId);
assert.equal(refreshedBatch.events[1].matchMethod, "new");

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
  sources: [
    { ...sourceLink(sourceV1), role: "primary" },
    { ...sourceLink(unrelatedStory), role: "primary" },
  ],
});
const conflictingBrief = {
  ...brief(`${date}T01:37:00.000Z`, teslaHeadline),
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
assert.ok(currentDraft?.brief.snapshot?.id);
const reviewedSnapshotId = currentDraft.brief.snapshot.id;
const reviewedEvent = currentDraft.brief.snapshot.events[0];
const reviewedHeadline = structuredClone(currentDraft.brief.headlines[0]);
const alternateSnapshotId = snapshots.find((snapshot) => snapshot.id !== reviewedSnapshotId)?.id;
assert.ok(alternateSnapshotId);
await raw.query("UPDATE daily_briefs SET current_snapshot_id = $2 WHERE id = $1", [
  currentDraft.id,
  alternateSnapshotId,
]);
await assert.rejects(
  () => db.publishBrief(currentDraft.id, currentDraft.brief, Buffer.from("split-pointer-pdf")),
  (error: unknown) => error instanceof db.StaleBriefRevisionError,
  "payload.snapshot.id and daily_briefs.current_snapshot_id must be one CAS pointer",
);
await raw.query("UPDATE daily_briefs SET current_snapshot_id = $2 WHERE id = $1", [
  currentDraft.id,
  reviewedSnapshotId,
]);
const beforeTamperedPublish = await raw.query<{ snapshots: number; runs: number; versions: number }>(`
  SELECT
    (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
    (SELECT COUNT(*)::integer FROM collection_runs) AS runs,
    (SELECT COUNT(*)::integer FROM event_versions) AS versions
`);
await assert.rejects(
  () => db.publishBrief(concurrent[0].id, {
    ...structuredClone(currentDraft.brief),
    headlines: currentDraft.brief.headlines.map((item: Headline, index: number) =>
      index === 0 ? { ...item, summary: `${item.summary} tampered after review` } : item),
  }, Buffer.from("tampered-pdf")),
  (error: unknown) => error instanceof db.StaleBriefRevisionError,
);
const afterTamperedPublish = await raw.query<{ snapshots: number; runs: number; versions: number }>(`
  SELECT
    (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
    (SELECT COUNT(*)::integer FROM collection_runs) AS runs,
    (SELECT COUNT(*)::integer FROM event_versions) AS versions
`);
assert.deepEqual(afterTamperedPublish.rows[0], beforeTamperedPublish.rows[0]);

await db.persistBriefObservation({
  ...structuredClone(currentDraft.brief),
  id: undefined,
  status: "draft",
  storageMode: undefined,
  snapshot: undefined,
  generatedAt: `${date}T01:40:00.000Z`,
  headlines: [{
    ...reviewedHeadline,
    marketDirection: reviewedHeadline.marketDirection === "mixed" ? "bearish" : "mixed",
  }],
}, {
  stream: "shared",
  batchKey: "postgres-between-review-and-publish",
});
const advancedHead = (await db.listEventVersions(reviewedEvent.eventId)).at(-1);
assert.notEqual(
  advancedHead?.id,
  reviewedEvent.eventVersionId,
  "fixture must advance the event head after the reviewed snapshot",
);
const beforePublishPromotion = await raw.query<{ snapshots: number; runs: number; versions: number }>(`
  SELECT
    (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
    (SELECT COUNT(*)::integer FROM collection_runs) AS runs,
    (SELECT COUNT(*)::integer FROM event_versions) AS versions
`);
const published = await db.publishBrief(concurrent[0].id, {
  ...structuredClone(currentDraft.brief),
  id: "caller-metadata-is-ignored",
  status: "published",
  publishedAt: `${date}T01:45:00.000Z`,
  storageMode: "memory",
}, Buffer.from("frozen-pdf"), {
  stream: "publish",
  batchKey: "postgres-publish",
});
assert.equal(published.status, "published");
assert.equal(published.brief.snapshot?.id, reviewedSnapshotId);
assert.equal(published.brief.snapshot?.events[0].eventVersionId, reviewedEvent.eventVersionId);
assert.equal(published.brief.headlines[0].marketDirection, reviewedHeadline.marketDirection);
const afterPublishPromotion = await raw.query<{ snapshots: number; runs: number; versions: number }>(`
  SELECT
    (SELECT COUNT(*)::integer FROM brief_snapshots) AS snapshots,
    (SELECT COUNT(*)::integer FROM collection_runs) AS runs,
    (SELECT COUNT(*)::integer FROM event_versions) AS versions
`);
assert.deepEqual(
  afterPublishPromotion.rows[0],
  beforePublishPromotion.rows[0],
  "publication must not create a collection run, snapshot, or event version",
);
const promotedRow = await raw.query<{
  current_snapshot_id: string;
  payload_snapshot_id: string;
  snapshot_event_version_id: string;
}>(`
  SELECT daily.current_snapshot_id,
         daily.payload->'snapshot'->>'id' AS payload_snapshot_id,
         snapshot_event.event_version_id AS snapshot_event_version_id
  FROM daily_briefs AS daily
  JOIN brief_snapshot_events AS snapshot_event
    ON snapshot_event.snapshot_id = daily.current_snapshot_id
   AND snapshot_event.event_id = $2
  WHERE daily.id = $1
`, [published.id, reviewedEvent.eventId]);
assert.equal(promotedRow.rows[0].current_snapshot_id, reviewedSnapshotId);
assert.equal(promotedRow.rows[0].payload_snapshot_id, reviewedSnapshotId);
assert.equal(promotedRow.rows[0].snapshot_event_version_id, reviewedEvent.eventVersionId);
const frozenPayload = JSON.stringify(published.brief);
await db.persistBriefObservation(brief(`${date}T01:50:00.000Z`, headline({ marketDirection: "neutral" })), {
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
