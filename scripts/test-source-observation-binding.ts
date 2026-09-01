import assert from "node:assert/strict";
import type { Headline, SourceLink } from "../lib/types";

// This regression exercises the in-memory implementation even when a
// developer has DATABASE_URL configured. The process is isolated by tsx, so
// no PostgreSQL pool can have been initialized before these dynamic imports.
const configuredDatabaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

const [{ saveSourceStories }, { parseFeedDocument }, {
  assertEvidenceBoundToSourceCapture,
  validateHeadlineEvidence,
}] = await Promise.all([
  import("../lib/db"),
  import("../lib/pipeline"),
  import("../lib/source-evidence"),
]);

const feed = {
  name: "Observation Binding Wire",
  url: "https://observation-binding.example/feed.xml",
  type: "News" as const,
};
const xml = `<?xml version="1.0"?><rss><channel><item>`
  + `<guid>observation-binding-item-1</guid>`
  + `<title>Revenue outlook remains unchanged</title>`
  + `<link>https://observation-binding.example/items/1</link>`
  + `<pubDate>Wed, 22 Jul 2099 01:00:00 GMT</pubDate>`
  + `<description>Management retained its full-year revenue outlook.</description>`
  + `</item></channel></rss>`;
const firstCapturedAt = "2099-07-22T02:00:00.000Z";
const secondCapturedAt = "2099-07-22T02:10:00.000Z";
const storyAt = (collectedAt: string) => parseFeedDocument(feed, xml, {
  collectedAt,
  mimeType: "application/rss+xml",
  httpStatus: 200,
})[0];

const first = (await saveSourceStories([storyAt(firstCapturedAt)])).stories[0];
const second = (await saveSourceStories([storyAt(secondCapturedAt)])).stories[0];

assert.equal(second.sourceDocumentVersionId, first.sourceDocumentVersionId);
assert.notEqual(second.sourceObservationId, first.sourceObservationId);
assert.equal(second.capture?.collectedAt, secondCapturedAt);
assert.deepEqual(
  second.evidence?.map((item) => item.versionId),
  first.evidence?.map((item) => item.versionId),
  "unchanged quote/locator material must reuse immutable evidence version ids",
);
assert.ok(second.evidence?.every((item) => item.capturedAt === secondCapturedAt));
assert.doesNotThrow(() => assertEvidenceBoundToSourceCapture(second, second.capture!));

const source: SourceLink = {
  name: second.source,
  type: second.sourceType,
  role: "primary",
  url: second.url,
  sourceDocumentId: second.sourceDocumentId,
  sourceDocumentVersionId: second.sourceDocumentVersionId,
  sourceObservationId: second.sourceObservationId,
  canonicalUrl: second.canonicalUrl,
  contentHash: second.contentHash,
  publishedAt: second.publishedAt,
  collectedAt: second.collectedAt,
  timestampKind: second.timestampKind,
  originalPublishedAt: second.originalPublishedAt,
  capture: second.capture,
  evidence: second.evidence,
};
const headline = {
  id: "observation-binding-event",
  rank: 1,
  ticker: "TEST",
  category: "Earnings",
  title: second.title,
  summary: second.description,
  marketImpact: "No change in the outlook.",
  impact: 1,
  confidence: 90,
  mentions: 1,
  sentiment: "neutral",
  sources: [source],
  claims: [],
} as Headline;
assert.equal(validateHeadlineEvidence(headline).valid, true);

const staleProjection = structuredClone(headline);
staleProjection.sources[0].evidence![0].capturedAt = firstCapturedAt;
assert.ok(validateHeadlineEvidence(staleProjection).issues.some((issue) =>
  issue.code === "SOURCE_EVIDENCE_OBSERVATION_TIME_MISMATCH"));

if (configuredDatabaseUrl !== undefined) process.env.DATABASE_URL = configuredDatabaseUrl;
console.log("Source recapture evidence is bound to the current observation without version proliferation");
