import assert from "node:assert/strict";
import { buildRedditStory, buildXStory, resolveSocialTimestamp } from "../lib/collectors/browser";
import { hashSourceContent } from "../lib/source-identity";
import {
  assertEvidenceBoundToSourceCapture,
  evidenceLocatorHash,
} from "../lib/source-evidence";

const collectedAt = "2026-07-22T04:05:06.000Z";

const longTweet = `${"Market evidence 🚀 中文 ".repeat(20)}END`;
assert.ok(Array.from(longTweet).length > 180);
const xStory = buildXStory("Nvidia", {
  text: longTweet,
  link: "https://x.com/example/status/2012345678901234567?s=20",
  publishedAt: "2026-07-22T03:04:05.000Z",
  publishedAtField: "time[datetime]",
  metricText: "2.5K likes 300 reposts",
}, collectedAt);
assert.ok(xStory);
assert.equal(Array.from(xStory.title).length, 180, "X display title may be shortened by code point");
assert.equal(xStory.description, longTweet, "the complete tweet must remain usable as source text");
assert.equal(xStory.originalTitle, longTweet, "display truncation must not alter original source content");
assert.equal(xStory.originalDescription, longTweet);
assert.equal(xStory.originalPublishedAt, "2026-07-22T03:04:05.000Z");
assert.equal(xStory.capture?.capturedTextHash, hashSourceContent(longTweet));
assert.equal(xStory.capture?.originalPublishedAt, "2026-07-22T03:04:05.000Z");
assert.equal(xStory.evidence?.length, 1);
assert.equal(xStory.evidence?.[0].quoteOriginal, longTweet);
assert.equal(xStory.evidence?.[0].quoteHash, hashSourceContent(longTweet));
assert.deepEqual(xStory.evidence?.[0].locator, {
  kind: "x_post_field",
  statusId: "2012345678901234567",
  field: "text",
});
assert.doesNotThrow(() => assertEvidenceBoundToSourceCapture(xStory, xStory.capture!));
const forgedX = structuredClone(xStory);
const forgedXLocator = forgedX.evidence![0].locator;
assert.equal(forgedXLocator.kind, "x_post_field");
if (forgedXLocator.kind === "x_post_field") forgedXLocator.statusId = "2099999999999999999";
forgedX.evidence![0].locatorHash = evidenceLocatorHash(forgedXLocator);
assert.throws(
  () => assertEvidenceBoundToSourceCapture(forgedX, forgedX.capture!),
  /does not identify the captured status/,
  "an X locator must be bound to the status ID preserved in capturedArtifact",
);

const redditBody = "Revenue rose 12% year over year.\n\nManagement retained its guidance.";
const redditStory = buildRedditStory("stocks", {
  title: "Earnings source document",
  body: redditBody,
  url: "https://old.reddit.com/r/stocks/comments/1abc9z/earnings_source_document/",
  nativeId: "t3_1AbC9z",
  comments: "120 comments",
  score: "1.5K",
  publishedAt: "2026-07-22T01:02:03Z",
  publishedAtField: "time[datetime]",
}, collectedAt);
assert.ok(redditStory);
assert.equal(redditStory.description, redditBody);
assert.equal(redditStory.originalDescription, redditBody);
assert.equal(redditStory.nativeId, "1abc9z");
assert.equal(redditStory.evidence?.length, 2);
assert.deepEqual(redditStory.evidence?.[0].locator, {
  kind: "reddit_post_field",
  postId: "1abc9z",
  field: "title",
});
assert.deepEqual(redditStory.evidence?.[1].locator, {
  kind: "reddit_post_field",
  postId: "1abc9z",
  field: "body",
});
assert.equal(redditStory.evidence?.[1].quoteOriginal, redditBody);
assert.equal(redditStory.evidence?.[1].quoteHash, hashSourceContent(redditBody));
assert.doesNotThrow(() => assertEvidenceBoundToSourceCapture(redditStory, redditStory.capture!));
const forgedReddit = structuredClone(redditStory);
forgedReddit.evidence![1].quoteOriginal = "Invented Reddit body";
forgedReddit.evidence![1].quoteHash = hashSourceContent("Invented Reddit body");
assert.throws(
  () => assertEvidenceBoundToSourceCapture(forgedReddit, forgedReddit.capture!),
  /not the exact captured Reddit field/,
  "a Reddit quote must be the exact field preserved in capturedArtifact",
);

const titleOnly = buildRedditStory("investing", {
  title: "Title is the only exact text exposed",
  body: null,
  url: "https://www.reddit.com/r/investing/comments/1def456/title_only/",
  nativeId: "1def456",
  comments: "50",
  score: "900",
  publishedAt: "",
  publishedAtField: "created-timestamp",
}, collectedAt);
assert.ok(titleOnly);
assert.equal(titleOnly.description, "", "missing body must not be replaced by a synthetic factual sentence");
assert.equal(titleOnly.originalDescription, "");
assert.equal(titleOnly.timestampKind, "collected");
assert.equal(titleOnly.publishedAt, collectedAt, "legacy fallback remains collection time only when marked collected");
assert.equal(titleOnly.originalPublishedAt, null, "collection time must never masquerade as original publication time");
assert.equal(titleOnly.capture?.originalPublishedAt, null);
assert.equal(titleOnly.capture?.publishedAtRaw, undefined);
assert.equal(titleOnly.evidence?.[0].quoteOriginal, titleOnly.title);
assert.equal(titleOnly.evidence?.[1].quoteOriginal, undefined);
assert.equal(titleOnly.evidence?.[1].locatorStatus, "unavailable");
assert.equal(titleOnly.evidence?.[1].directness, "unavailable");
assert.deepEqual(titleOnly.evidence?.[1].locator, {
  kind: "unavailable",
  reasonCode: "body_not_collected",
  detail: "Reddit listing DOM did not expose non-empty post body text at collection time.",
});

const invalidTime = resolveSocialTimestamp("not-a-platform-time", collectedAt);
assert.deepEqual(invalidTime, {
  publishedAt: collectedAt,
  originalPublishedAt: null,
  collectedAt,
  timestampKind: "collected",
});
assert.deepEqual(resolveSocialTimestamp("2026-07-22T12:04:05+08:00", collectedAt), {
  publishedAt: "2026-07-22T04:04:05.000Z",
  originalPublishedAt: "2026-07-22T04:04:05.000Z",
  collectedAt,
  timestampKind: "published",
});
assert.equal(
  resolveSocialTimestamp("2026-07-22T03:04:05", collectedAt).originalPublishedAt,
  null,
  "a timezone-less platform value must not be interpreted in the server timezone",
);
assert.equal(
  resolveSocialTimestamp("2026-02-30T03:04:05Z", collectedAt).originalPublishedAt,
  null,
  "an impossible platform calendar date must not be normalized into March",
);
assert.throws(
  () => resolveSocialTimestamp("2026-07-22T03:04:05Z", "2026-07-22T04:05:06"),
  /explicit timezone/,
  "collection time is authoritative metadata and must fail closed when ambiguous",
);

const recapturedTitleOnly = buildRedditStory("investing", {
  title: "Title is the only exact text exposed",
  body: null,
  url: "https://old.reddit.com/r/investing/comments/1def456/a_changed_slug/?utm_source=share",
  nativeId: "1def456",
  comments: "55",
  score: "901",
  publishedAt: "",
}, "2026-07-22T04:15:06.000Z");
assert.ok(recapturedTitleOnly);
assert.equal(recapturedTitleOnly.sourceDocumentId, titleOnly.sourceDocumentId);
assert.equal(recapturedTitleOnly.evidence?.[0].id, titleOnly.evidence?.[0].id, "evidence anchor remains stable across recaptures");
assert.equal(recapturedTitleOnly.evidence?.[0].quoteHash, titleOnly.evidence?.[0].quoteHash);

assert.equal(
  buildXStory("bad", {
    text: "A post without a status identity",
    link: "https://x.com/search?q=bad",
    publishedAt: "",
    metricText: "",
  }, collectedAt),
  null,
  "an X citation must not be created without its native status ID",
);

console.log("social source evidence tests passed");
