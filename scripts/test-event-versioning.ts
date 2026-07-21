import assert from "node:assert/strict";
import { demoBrief } from "../lib/demo-data";
import { createStableEventIdentity } from "../lib/event-versioning";
import { ensureRawStoryIdentity } from "../lib/source-identity";
import type { DailyBrief, Headline, RawStory, SourceLink } from "../lib/types";

delete process.env.DATABASE_URL;

const {
  listBriefSnapshots,
  listEventVersions,
  persistBriefObservation,
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
  sources: [sec, wire],
  crossSourceCount: 2,
  marketDirection: "bearish",
  directionRationale: "New concentration data introduces downside risk.",
}));
const evidenceRecord = await saveDraft(evidenceBrief, { stream: "shared", batchKey: "event-version-test-3" });
assert.equal(evidenceRecord.brief.headlines[0].id, eventId, "primary-source change must not fork the event");
versions = await listEventVersions(eventId);
assert.equal(versions.length, 2);
assert.equal(versions[1].versionNumber, 2);
assert.equal(versions[1].previousVersionId, versions[0].id);

// A temporary collector miss does not erase previously confirmed evidence.
const partialBrief = brief(`${date}T01:40:00.000Z`, headline({
  id: "only-sec-returned-this-time",
  sources: [sec],
  crossSourceCount: 1,
  marketDirection: "bearish",
}));
const partialRecord = await saveDraft(partialBrief, { stream: "shared", batchKey: "event-version-test-4" });
assert.equal(partialRecord.brief.headlines[0].id, eventId);
assert.equal(partialRecord.brief.headlines[0].sources.length, 2, "historical evidence must be retained");
assert.equal((await listEventVersions(eventId)).length, 2);

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
  sources: [wire, sec, secondWire],
  crossSourceCount: 2,
  marketDirection: "neutral",
  directionConfidence: 60,
}));
await saveDraft(neutralBrief, { stream: "shared", batchKey: "event-version-test-6" });
const bearishAgainBrief = brief(`${date}T02:10:00.000Z`, headline({
  id: eventId,
  sources: [wire, sec, secondWire],
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
  sources: [wire, unrelatedSource],
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

console.log("event identity, immutable snapshot, and version-chain tests passed");
