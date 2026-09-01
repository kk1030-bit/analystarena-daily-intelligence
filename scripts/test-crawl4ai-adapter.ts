import assert from "node:assert/strict";
import {
  adaptCrawl4aiCollectOutput,
  pickArticleQuotes,
  storyFromCrawl4aiPage,
  type Crawl4aiPage,
} from "../lib/collectors/crawl4ai";
import { assertEvidenceBoundToSourceCapture, sha256ExactUtf8 } from "../lib/source-evidence";
import { deriveSourceIdentity } from "../lib/source-identity";

const GOOGLE_NEWS_FEED_NAMESPACE = "https://news.google.com/rss";

const articleText = [
  "# Nvidia unveils next-generation data center GPU",
  "",
  "By Example Reporter",
  "",
  "SANTA CLARA — Nvidia on Monday unveiled its next-generation data center GPU, promising a 40% performance gain for large language model training workloads over the previous generation.",
  "",
  "The company said volume shipments will begin in the first quarter, with cloud providers already committed to initial capacity.",
].join("\n");

const basePage: Crawl4aiPage = {
  feedName: "Google News · 市场焦点",
  feedUrl: "https://news.google.com/rss/search?q=(Nvidia%20OR%20OpenAI)%20markets&hl=en-US&gl=US&ceid=US:en",
  feedType: "News",
  entryTitle: "Nvidia unveils next-generation data center GPU - Example News",
  entryUrl: "https://news.google.com/rss/articles/CBMiExampleToken?oc=5",
  entryGuid: "CBMiExampleToken",
  entryPublishedAtRaw: "Mon, 31 Aug 2026 21:00:00 GMT",
  requestedUrl: "https://news.google.com/rss/articles/CBMiExampleToken?oc=5",
  pageUrl: "https://www.example-news.com/tech/nvidia-gpu?utm_source=rss",
  httpStatus: 200,
  collectedAt: "2026-09-01T00:10:00.000Z",
  pageTitle: "Nvidia unveils next-generation data center GPU | Example News",
  publishedAtMetaRaw: "2026-08-31T20:58:12+00:00",
  publishedAtMetaField: "meta:article:published_time",
  extractionMethod: "crawl4ai:fit_markdown",
  text: articleText,
  truncated: false,
  ok: true,
  note: null,
};

// Quote picking must return exact substrings of the captured artifact.
const quotes = pickArticleQuotes(articleText);
assert.equal(quotes.title, "Nvidia unveils next-generation data center GPU");
assert.ok(quotes.lead?.startsWith("SANTA CLARA — Nvidia on Monday unveiled"));
assert.ok(articleText.includes(quotes.title!), "title quote must occur in the artifact");
assert.ok(articleText.includes(quotes.lead!), "lead quote must occur in the artifact");

const extractorVersion = "crawl4ai-detail/v1+crawl4ai-0.9.3";
const story = storyFromCrawl4aiPage(basePage, extractorVersion);
assert.equal(story.sourceType, "News");
assert.equal(story.source, "example-news.com", "News detail stories are labeled by publisher host");
assert.equal(story.canonicalUrl, "https://www.example-news.com/tech/nvidia-gpu", "tracking parameters are removed from identity");
assert.equal(story.capture?.scope, "detail_page");
assert.equal(story.capture?.capturedContentHash, sha256ExactUtf8(articleText));
assert.equal(story.capture?.capturedArtifact, articleText);
assert.equal(story.capture?.feedUrl, basePage.feedUrl);
assert.equal(story.capture?.extractorVersion, extractorVersion);
assert.equal(story.originalPublishedAt, "2026-08-31T20:58:12.000Z", "publisher meta timestamp is authoritative");
assert.equal(story.publishedAt, "2026-08-31T20:58:12.000Z");
assert.equal(story.timestampKind, "published");
assert.equal(story.publishedAtField, "meta:article:published_time");
assert.equal(story.evidence?.length, 2);
assert.equal(story.evidence?.[0].anchorKey, "article:title");
assert.equal(story.evidence?.[0].locator.kind, "html_text_quote");
assert.equal(story.evidence?.[0].quoteOriginal, quotes.title);
assert.equal(story.evidence?.[1].anchorKey, "article:lead");
assert.equal(story.evidence?.[1].quoteOriginal, quotes.lead);
assertEvidenceBoundToSourceCapture(story, story.capture!);

// The detail story must share the feed entry's document identity, so the
// full-text capture becomes a richer observation of the same source document.
const feedEntryIdentity = deriveSourceIdentity({
  url: basePage.entryUrl,
  sourceType: "News",
  source: "Google News · 市场焦点",
  nativeId: basePage.entryGuid!,
  feedNamespace: GOOGLE_NEWS_FEED_NAMESPACE,
});
assert.equal(story.sourceDocumentId, feedEntryIdentity.sourceDocumentId,
  "detail capture and feed entry must resolve to one source document");

// Without a publisher meta timestamp, the RSS pubDate is used.
const rssTimed = storyFromCrawl4aiPage({ ...basePage, publishedAtMetaRaw: null, publishedAtMetaField: null }, extractorVersion);
assert.equal(rssTimed.originalPublishedAt, "2026-08-31T21:00:00.000Z");
assert.equal(rssTimed.publishedAtField, "rss:pubDate");
assert.equal(rssTimed.timestampKind, "published");

// Unparseable publisher strings can never be classified as publication time.
const vagueTimed = storyFromCrawl4aiPage({
  ...basePage,
  publishedAtMetaRaw: "yesterday afternoon",
  entryPublishedAtRaw: null,
}, extractorVersion);
assert.equal(vagueTimed.timestampKind, "collected");
assert.equal(vagueTimed.originalPublishedAt, null);
assert.equal(vagueTimed.publishedAt, "2026-09-01T00:10:00.000Z");
assert.equal(vagueTimed.publishedAtRaw, "yesterday afternoon", "the raw string is preserved as provenance only");

// A page whose text has no substantial paragraph still ships with an exact
// title quote plus an explicit unavailable lead, never a fabricated quote.
const headlineOnly = storyFromCrawl4aiPage({
  ...basePage,
  text: "# Short headline about markets\n\nBrief.",
}, extractorVersion);
assert.equal(headlineOnly.evidence?.[1].locator.kind, "unavailable");
assert.equal(headlineOnly.evidence?.[1].locatorStatus, "unavailable");
assertEvidenceBoundToSourceCapture(headlineOnly, headlineOnly.capture!);

// Official feeds keep their curated display name.
const officialStory = storyFromCrawl4aiPage({
  ...basePage,
  feedName: "Federal Reserve",
  feedUrl: "https://www.federalreserve.gov/feeds/press_all.xml",
  feedType: "Official",
  entryUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260831a.htm",
  requestedUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260831a.htm",
  pageUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260831a.htm",
  entryGuid: null,
}, extractorVersion);
assert.equal(officialStory.source, "Federal Reserve");
assert.equal(officialStory.sourceType, "Official");

// Whole-document adaptation: failed pages are skipped, unprovable pages are
// dropped with a reason, and provable pages become stories.
const document = {
  schema: "crawl4ai-collect/v1",
  collectorVersion: "crawl4ai-detail/v1",
  crawl4aiVersion: "0.9.3",
  generatedAt: "2026-09-01T00:12:00.000Z",
  feedStatuses: [
    { name: "Google News · 市场焦点", url: basePage.feedUrl, type: "News", ok: true, entryCount: 6, note: null },
  ],
  pages: [
    basePage,
    { ...basePage, pageUrl: "https://www.example-news.com/failed", ok: false, text: "", note: "publisher returned HTTP 403" },
    { ...basePage, pageUrl: "https://www.example-news.com/empty", entryGuid: "CBMiOtherToken", text: "\n\n\n" },
  ],
  note: null,
};
const adapted = adaptCrawl4aiCollectOutput(JSON.parse(JSON.stringify(document)));
assert.equal(adapted.stories.length, 1);
assert.equal(adapted.status.ok, true);
assert.equal(adapted.status.count, 1);
assert.equal(adapted.status.backend, "crawl4ai");
assert.match(adapted.status.note ?? "", /1 页在采集端未成功/);
assert.match(adapted.status.note ?? "", /丢弃 1 页/);

// Malformed collector output degrades to a failed status instead of throwing.
const rejected = adaptCrawl4aiCollectOutput({ schema: "not-crawl4ai" });
assert.equal(rejected.stories.length, 0);
assert.equal(rejected.status.ok, false);

console.log("crawl4ai adapter tests passed");
