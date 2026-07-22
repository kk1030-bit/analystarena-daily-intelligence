import assert from "node:assert/strict";
import {
  claimVerificationStatus,
  freshnessScore,
  headlineFromGroup,
  MAX_FEED_RESPONSE_BYTES,
  parseFeedDocument,
  readFeedResponseTextLimited,
  type FeedDefinition,
} from "../lib/pipeline";
import {
  assertEvidenceBoundToSourceCapture,
  evidenceLocatorHash,
  sha256ExactUtf8,
} from "../lib/source-evidence";
import { assertPublishedAtRawConsistency } from "../lib/source-time";

const collectedAt = "2026-07-22T03:04:05.000Z";
const rssFeed: FeedDefinition = { name: "Test Wire", url: "https://wire.example/feed.xml", type: "News" };
const rss = `<?xml version="1.0"?><rss><channel><item>
  <guid>wire-123</guid><title>Chip demand &amp; supply</title>
  <link>https://wire.example/story/123?utm_source=feed</link>
  <pubDate>Wed, 22 Jul 2026 01:02:03 GMT</pubDate>
  <description><![CDATA[<p>Orders rose 12%.</p><p>Capacity remains tight.</p>]]></description>
</item></channel></rss>`;
const [rssStory] = parseFeedDocument(rssFeed, rss, { collectedAt, mimeType: "application/rss+xml", httpStatus: 200 });
assert.equal(rssStory.originalPublishedAt, "2026-07-22T01:02:03.000Z");
assert.equal(rssStory.publishedAt, "2026-07-22T01:02:03.000Z");
assert.equal(rssStory.timestampKind, "published");
assert.equal(rssStory.collectedAt, collectedAt);
assert.equal(rssStory.publishedAtRaw, "Wed, 22 Jul 2026 01:02:03 GMT");
assert.equal(rssStory.publishedAtField, "pubDate");
assert.equal(rssStory.originalDescription, "Orders rose 12%.\nCapacity remains tight.");
assert.equal(rssStory.capture?.scope, "rss_entry");
assert.equal(rssStory.capture?.httpStatus, 200);
assert.equal(rssStory.evidence?.[0].locator.kind, "feed_field");
const decodedDescriptionField = "<p>Orders rose 12%.</p><p>Capacity remains tight.</p>";
assert.equal(rssStory.evidence?.[1].quoteOriginal, decodedDescriptionField);
assert.notEqual(rssStory.evidence?.[1].quoteOriginal, rssStory.originalDescription, "display cleanup must not rewrite an exact source quote");
assert.equal(rssStory.evidence?.[1].quoteHash, sha256ExactUtf8(decodedDescriptionField));
assert.equal(rssStory.evidence?.[1].directness, "direct");
assert.doesNotThrow(() => assertEvidenceBoundToSourceCapture(rssStory, rssStory.capture!));

const forgedFeedQuote = structuredClone(rssStory);
forgedFeedQuote.evidence![1].quoteOriginal = "Revenue rose 99 percent (forged).";
forgedFeedQuote.evidence![1].quoteHash = sha256ExactUtf8(forgedFeedQuote.evidence![1].quoteOriginal!);
assert.throws(
  () => assertEvidenceBoundToSourceCapture(forgedFeedQuote, forgedFeedQuote.capture!),
  /not the exact captured feed field/,
  "a self-consistent quote/hash pair must still be rejected when absent from capturedArtifact",
);

const forgedFeedLocator = structuredClone(rssStory);
const forgedLocator = forgedFeedLocator.evidence![0].locator;
assert.equal(forgedLocator.kind, "feed_field");
if (forgedLocator.kind === "feed_field") forgedLocator.entryId = "wire-forged";
forgedFeedLocator.evidence![0].locatorHash = evidenceLocatorHash(forgedLocator);
assert.throws(
  () => assertEvidenceBoundToSourceCapture(forgedFeedLocator, forgedFeedLocator.capture!),
  /does not identify the captured entry/,
  "a self-consistent locator/hash pair must still be rejected when it identifies another feed entry",
);

assert.doesNotThrow(() => assertPublishedAtRawConsistency(
  rssStory.publishedAtRaw,
  rssStory.originalPublishedAt!,
  "published",
));
assert.throws(
  () => assertPublishedAtRawConsistency(
    "Wed, 22 Jul 2026 02:02:03 GMT",
    rssStory.originalPublishedAt!,
    "published",
  ),
  /must exactly match originalPublishedAt/,
  "a parseable raw publisher time cannot disagree with the canonical publication instant",
);
assert.throws(
  () => assertPublishedAtRawConsistency("2026-07-22T01:02:03", rssStory.originalPublishedAt!, "published"),
  /cannot be classified as a published timestamp/,
  "an ambiguous raw publisher time cannot justify timestampKind=published",
);
assert.doesNotThrow(
  () => assertPublishedAtRawConsistency("2026-07-22T01:02:03", null, "collected"),
  "an unparseable raw value remains honest metadata when the timestamp is classified as collection time",
);
const deterministicHeadline = headlineFromGroup([rssStory]);
const deterministicDirectionClaim = deterministicHeadline.claims?.find((claim) => claim.type === "direction_rationale");
assert.ok(deterministicHeadline.directionRationale);
assert.equal(deterministicDirectionClaim?.statement, deterministicHeadline.directionRationale);
assert.equal(deterministicDirectionClaim?.verificationStatus, "partially_supported");
assert.ok(deterministicDirectionClaim?.citations.length, "deterministic direction inference must remain tied to exact evidence");

const corroboratingFeed: FeedDefinition = {
  name: "Second Test Wire",
  url: "https://second-wire.example/feed.xml",
  type: "News",
};
const [corroboratingStory] = parseFeedDocument(
  corroboratingFeed,
  rss
    .replace("wire-123", "wire-456")
    .replaceAll("https://wire.example", "https://second-wire.example"),
  { collectedAt },
);
const mergedDeterministic = headlineFromGroup([rssStory, corroboratingStory]);
const mergedDirectionClaim = mergedDeterministic.claims?.find((claim) => claim.type === "direction_rationale");
const mergedMarketClaim = mergedDeterministic.claims?.find((claim) => claim.type === "market_impact");
assert.equal(mergedDirectionClaim?.citations.length, 2, "group-level direction must retain every source it analyzed");
assert.equal(mergedMarketClaim?.citations.length, 2, "group-level impact must retain every source counted in the conclusion");

const fieldWithFormatting = "<p>Orders&nbsp; rose 12%.</p>  \n  <p>Capacity remains tight.</p>";
const formattedRss = rss.replace(
  "<p>Orders rose 12%.</p><p>Capacity remains tight.</p>",
  fieldWithFormatting,
);
const [formattedStory] = parseFeedDocument(rssFeed, formattedRss, { collectedAt });
assert.equal(formattedStory.evidence?.[1].quoteOriginal, fieldWithFormatting);
assert.equal(formattedStory.evidence?.[1].quoteHash, sha256ExactUtf8(fieldWithFormatting));
assert.equal(formattedStory.originalDescription, "Orders rose 12%.\nCapacity remains tight.");

const [rssRecapture] = parseFeedDocument(rssFeed, rss, { collectedAt: "2026-07-22T03:14:05.000Z" });
assert.equal(rssRecapture.contentHash, rssStory.contentHash, "collection time must not manufacture a content version");

const longBody = "A".repeat(1_200);
const [longStory] = parseFeedDocument(rssFeed, rss.replace("<p>Orders rose 12%.</p><p>Capacity remains tight.</p>", longBody), { collectedAt });
assert.equal(longStory.originalDescription?.length, 1_200, "captured source text must not be silently truncated");
assert.notEqual(longStory.contentHash, rssStory.contentHash);

const atomFeed: FeedDefinition = { name: "Official Atom", url: "https://official.example/atom.xml", type: "Official" };
const atom = `<?xml version="1.0"?><feed><entry>
  <id>tag:official.example,2026:item-7</id><title>Policy decision</title>
  <link rel="alternate" href="https://official.example/releases/7" />
  <published>2026-07-21T08:00:00Z</published><updated>2026-07-22T09:30:00Z</updated>
  <summary>Target range was unchanged.</summary>
</entry></feed>`;
const [atomStory] = parseFeedDocument(atomFeed, atom, { collectedAt });
assert.equal(atomStory.originalPublishedAt, "2026-07-21T08:00:00.000Z");
assert.equal(atomStory.sourceUpdatedAt, "2026-07-22T09:30:00.000Z");
assert.equal(atomStory.publishedAtField, "published");
assert.equal(atomStory.capture?.scope, "atom_entry");

const updatedOnly = atom.replace("<published>2026-07-21T08:00:00Z</published>", "");
const [updatedOnlyStory] = parseFeedDocument(atomFeed, updatedOnly, { collectedAt });
assert.equal(updatedOnlyStory.originalPublishedAt, null, "Atom updated must never be relabelled as publication time");
assert.equal(updatedOnlyStory.publishedAt, collectedAt);
assert.equal(updatedOnlyStory.timestampKind, "collected");
assert.equal(updatedOnlyStory.sourceUpdatedAt, "2026-07-22T09:30:00.000Z");
assert.equal(freshnessScore(updatedOnlyStory.publishedAt, updatedOnlyStory.timestampKind, Date.parse(collectedAt)), 12);
assert.equal(freshnessScore(collectedAt, "published", Date.parse(collectedAt)), 100);
assert.equal(freshnessScore("invalid", "published", Date.parse(collectedAt)), 0);

const invalidCalendar = rss.replace(
  "Wed, 22 Jul 2026 01:02:03 GMT",
  "Mon, 30 Feb 2026 01:02:03 GMT",
);
const [invalidCalendarStory] = parseFeedDocument(rssFeed, invalidCalendar, { collectedAt });
assert.equal(invalidCalendarStory.originalPublishedAt, null, "an impossible calendar date must not be normalized");
assert.equal(invalidCalendarStory.publishedAt, collectedAt);
assert.equal(invalidCalendarStory.timestampKind, "collected");
assert.equal(invalidCalendarStory.publishedAtRaw, "Mon, 30 Feb 2026 01:02:03 GMT");

const missingTimezone = rss.replace(
  "Wed, 22 Jul 2026 01:02:03 GMT",
  "2026-07-22T01:02:03",
);
const [missingTimezoneStory] = parseFeedDocument(rssFeed, missingTimezone, { collectedAt });
assert.equal(missingTimezoneStory.originalPublishedAt, null, "a timezone-less value must not be guessed");
assert.equal(missingTimezoneStory.timestampKind, "collected");
const ambiguousTimezone = rss.replace(
  "Wed, 22 Jul 2026 01:02:03 GMT",
  "Wed, 22 Jul 2026 01:02:03 CST",
);
const [ambiguousTimezoneStory] = parseFeedDocument(rssFeed, ambiguousTimezone, { collectedAt });
assert.equal(
  ambiguousTimezoneStory.originalPublishedAt,
  null,
  "an ambiguous timezone abbreviation must not be interpreted as a precise source time",
);
assert.equal(ambiguousTimezoneStory.timestampKind, "collected");
assert.throws(
  () => parseFeedDocument(rssFeed, rss, { collectedAt: "2026-07-22T03:04:05" }),
  /explicit timezone/,
);

const googleFeed: FeedDefinition = {
  name: "Google News index",
  url: "https://news.google.com/rss/search?q=chips",
  type: "News",
};
const [googleStory] = parseFeedDocument(googleFeed, rss, { collectedAt });
assert.ok(googleStory.evidence?.filter((item) => item.locatorStatus !== "unavailable").every((item) => item.directness === "indirect"));
assert.equal(
  claimVerificationStatus("title", [googleStory.evidence![0]], "deterministic"),
  "partially_supported",
  "an aggregator quote cannot fully verify an underlying factual claim",
);
assert.equal(
  claimVerificationStatus("title", [rssStory.evidence![0]], "ai"),
  "pending_confirmation",
  "a valid evidence ID selected by AI does not establish semantic entailment",
);
const secondGoogleQuery: FeedDefinition = {
  name: "Another Google News query",
  url: "https://news.google.com/rss/search?q=semiconductors&hl=en-US",
  type: "News",
};
const [sameGoogleItem] = parseFeedDocument(secondGoogleQuery, rss, { collectedAt });
assert.equal(
  sameGoogleItem.sourceDocumentId,
  googleStory.sourceDocumentId,
  "Google News query parameters must not fork the same native feed item",
);
assert.equal(
  sameGoogleItem.contentHash,
  googleStory.contentHash,
  "an acquisition query belongs to the observation, not the immutable content version",
);

const noBody = rss.replace(/<description>[\s\S]*?<\/description>/, "");
const [noBodyStory] = parseFeedDocument(rssFeed, noBody, { collectedAt });
const unavailable = noBodyStory.evidence?.find((item) => item.anchorKey === "feed:body");
assert.equal(unavailable?.locator.kind, "unavailable");
assert.equal(unavailable?.quoteOriginal, undefined);

const noGuidFeed = `<?xml version="1.0"?><rss><channel>
  <item><title>First item</title><link>https://wire.example/story/first?utm_source=rss</link><description>First body</description></item>
  <item><title>Second item</title><link>https://wire.example/story/second</link><description>Second body</description></item>
</channel></rss>`;
const noGuidStories = parseFeedDocument(rssFeed, noGuidFeed, { collectedAt });
assert.equal(noGuidStories.length, 2);
const entryIds = noGuidStories.map((story) => {
  const locator = story.evidence?.[0].locator;
  assert.equal(locator?.kind, "feed_field");
  return locator?.kind === "feed_field" ? locator.entryId : undefined;
});
assert.deepEqual(entryIds, ["https://wire.example/story/first", "https://wire.example/story/second"]);
assert.equal(new Set(entryIds).size, 2, "field locators must identify the exact no-GUID item, not only the field path");

assert.equal(await readFeedResponseTextLimited(new Response("五个字"), 9), "五个字");
await assert.rejects(
  readFeedResponseTextLimited(new Response("五个字"), 8),
  /exceeds 8 bytes/,
  "the streaming limit must count UTF-8 bytes rather than JavaScript characters",
);
await assert.rejects(
  readFeedResponseTextLimited(new Response("small", { headers: { "content-length": "999" } }), 10),
  /declared 999/,
);
assert.throws(
  () => parseFeedDocument(rssFeed, "x".repeat(MAX_FEED_RESPONSE_BYTES + 1), { collectedAt }),
  /Feed document exceeds/,
  "direct parser calls must not bypass the transport byte limit",
);

console.log("feed timestamp and evidence tests passed");
