import assert from "node:assert/strict";
import { buildRedditStory, buildXStory } from "../lib/collectors/browser";
import { safeRemoteStories } from "../lib/collectors/remote";

const collectedAt = "2026-07-22T03:04:05.000Z";
const reddit = buildRedditStory("stocks", {
  title: "Company posts an exact result",
  body: "Revenue increased 18% year over year.",
  url: "https://www.reddit.com/r/stocks/comments/abc123/company_posts_an_exact_result/",
  nativeId: "abc123",
  comments: "42",
  score: "1.2K",
  publishedAt: "2026-07-22T02:03:04Z",
  publishedAtField: "time[datetime]",
}, collectedAt);
const x = buildXStory("Nvidia", {
  text: "Exact X post text used as evidence.",
  link: "https://x.com/example/status/1234567890123456789",
  publishedAt: "",
  publishedAtField: undefined,
  metricText: "99",
}, collectedAt);
assert.ok(reddit && x);

const roundTripped = JSON.parse(JSON.stringify([reddit, x])) as unknown;
const accepted = safeRemoteStories(roundTripped);
assert.equal(accepted.length, 2);
assert.deepEqual(accepted[0].capture, reddit.capture, "native Reddit capture must survive remote ingestion unchanged");
assert.deepEqual(accepted[0].evidence, reddit.evidence, "exact Reddit evidence must survive remote ingestion unchanged");
assert.deepEqual(accepted[1].capture, x.capture, "native X capture must survive remote ingestion unchanged");
assert.deepEqual(accepted[1].evidence, x.evidence, "exact X evidence must survive remote ingestion unchanged");
assert.equal(accepted[0].originalPublishedAt, "2026-07-22T02:03:04.000Z");
assert.equal(accepted[0].publishedAt, "2026-07-22T02:03:04.000Z");
assert.equal(accepted[0].collectedAt, collectedAt);
assert.equal(accepted[1].originalPublishedAt, null);
assert.equal(accepted[1].publishedAt, collectedAt);
assert.equal(accepted[1].timestampKind, "collected");

const withoutCapture = structuredClone(reddit) as unknown as Record<string, unknown>;
delete withoutCapture.capture;
assert.throws(() => safeRemoteStories([withoutCapture]), /story\.capture must be an object/,
  "missing captures must fail closed instead of becoming legacy metadata");

const tamperedArtifact = structuredClone(reddit)!;
tamperedArtifact.capture!.capturedArtifact += "tampered";
tamperedArtifact.capture!.capturedArtifactSizeBytes = Buffer.byteLength(tamperedArtifact.capture!.capturedArtifact!, "utf8");
assert.throws(() => safeRemoteStories([tamperedArtifact]), /capturedContentHash does not match/,
  "modified captured bytes must be rejected");

const tamperedEvidence = structuredClone(reddit)!;
tamperedEvidence.evidence![0].quoteOriginal = "A quote not in the captured post";
assert.throws(() => safeRemoteStories([tamperedEvidence]), /INVALID_QUOTE_HASH|not the exact captured Reddit field/,
  "evidence that is not bound to captured bytes must be rejected");

const ambiguousTime = structuredClone(reddit)!;
ambiguousTime.collectedAt = "2026-07-22 03:04:05";
assert.throws(() => safeRemoteStories([ambiguousTime]), /explicit timezone/,
  "ambiguous timestamps must be rejected rather than normalized by Date");

console.log("remote social evidence ingestion tests passed");
