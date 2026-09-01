import assert from "node:assert/strict";
import { buildRedditStory } from "../lib/collectors/browser";
import { storyFromCrawl4aiPage, type Crawl4aiPage } from "../lib/collectors/crawl4ai";
import { safeRemoteStories } from "../lib/collectors/remote";
import type { HtmlTextQuoteLocator } from "../lib/types";

const articleText = [
  "# Fed announces additional bank stress test details",
  "",
  "WASHINGTON — The Federal Reserve Board on Monday announced additional details of its annual bank stress testing framework for the coming cycle.",
  "",
  "Large banks will face an updated severely adverse scenario with a sharper commercial real estate decline.",
].join("\n");

const page: Crawl4aiPage = {
  feedName: "Federal Reserve",
  feedUrl: "https://www.federalreserve.gov/feeds/press_all.xml",
  feedType: "Official",
  entryTitle: "Federal Reserve announces additional stress test details",
  entryUrl: "https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260831a.htm",
  entryGuid: "https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260831a.htm",
  entryPublishedAtRaw: "Mon, 31 Aug 2026 14:30:00 GMT",
  requestedUrl: "https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260831a.htm",
  pageUrl: "https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260831a.htm",
  httpStatus: 200,
  collectedAt: "2026-09-01T00:20:00.000Z",
  pageTitle: "Federal Reserve Board - stress test details",
  publishedAtMetaRaw: null,
  publishedAtMetaField: null,
  extractionMethod: "crawl4ai:fit_markdown",
  text: articleText,
  truncated: false,
  ok: true,
  note: null,
};

const extractorVersion = "crawl4ai-detail/v1+crawl4ai-0.9.3";
const detailStory = storyFromCrawl4aiPage(page, extractorVersion);
const socialStory = buildRedditStory("stocks", {
  title: "Exact social title",
  body: "Exact social body text.",
  url: "https://www.reddit.com/r/stocks/comments/zz9yy8/exact_social_title/",
  nativeId: "zz9yy8",
  comments: "12",
  score: "345",
  publishedAt: "2026-09-01T00:01:02Z",
  publishedAtField: "time[datetime]",
}, "2026-09-01T00:19:00.000Z");
assert.ok(socialStory);

// A mixed batch of native social and full-text detail stories round-trips.
const accepted = safeRemoteStories(JSON.parse(JSON.stringify([socialStory, detailStory])));
assert.equal(accepted.length, 2);
assert.deepEqual(accepted[1].capture, detailStory.capture, "detail capture must survive remote ingestion unchanged");
assert.deepEqual(accepted[1].evidence, detailStory.evidence, "detail evidence must survive remote ingestion unchanged");
assert.equal(accepted[1].sourceType, "Official");
assert.equal(accepted[1].capture?.scope, "detail_page");
assert.equal(accepted[1].originalPublishedAt, "2026-08-31T14:30:00.000Z");
assert.equal(accepted[1].timestampKind, "published");

// Tampered artifact bytes are rejected by the content hash.
const tamperedArtifact = structuredClone(detailStory);
tamperedArtifact.capture!.capturedArtifact += " tampered";
tamperedArtifact.capture!.capturedArtifactSizeBytes = Buffer.byteLength(tamperedArtifact.capture!.capturedArtifact!, "utf8");
assert.throws(() => safeRemoteStories([JSON.parse(JSON.stringify(tamperedArtifact))]),
  /capturedContentHash does not match/,
  "modified captured bytes must be rejected");

// A quote rewritten in both the evidence and its locator still fails, because
// the exact text does not occur in the captured artifact.
const tamperedQuote = structuredClone(detailStory);
tamperedQuote.evidence![0].quoteOriginal = "A sentence the page never contained";
(tamperedQuote.evidence![0].locator as HtmlTextQuoteLocator).textQuote.exact = "A sentence the page never contained";
delete (tamperedQuote.evidence![0] as { quoteHash?: string }).quoteHash;
delete (tamperedQuote.evidence![0] as { locatorHash?: string }).locatorHash;
assert.throws(() => safeRemoteStories([JSON.parse(JSON.stringify(tamperedQuote))]),
  /not present at its claimed capture context/,
  "quotes that are not substrings of the captured artifact must be rejected");

// Structural selectors are not provable from a visible-text capture.
const structuralLocator = structuredClone(detailStory);
(structuralLocator.evidence![0].locator as HtmlTextQuoteLocator).selector = "article h1";
delete (structuralLocator.evidence![0] as { locatorHash?: string }).locatorHash;
assert.throws(() => safeRemoteStories([JSON.parse(JSON.stringify(structuralLocator))]),
  /use an exact TextQuote locator/,
  "structural locators must be rejected for visible-text captures");

// News/Official stories must carry a detail_page capture, not a feed snippet.
const wrongScope = structuredClone(detailStory) as unknown as { capture: { scope: string } };
wrongScope.capture.scope = "rss_entry";
assert.throws(() => safeRemoteStories([JSON.parse(JSON.stringify(wrongScope))]),
  /story\.capture\.scope must be detail_page/,
  "feed-scope captures cannot impersonate detail stories");

// Unknown source types stay rejected.
const unknownType = structuredClone(detailStory) as unknown as { sourceType: string };
unknownType.sourceType = "Blog";
assert.throws(() => safeRemoteStories([JSON.parse(JSON.stringify(unknownType))]),
  /sourceType must be Reddit, X, News or Official/);

// The per-batch detail story limit fails closed.
const overLimit = Array.from({ length: 49 }, () => JSON.parse(JSON.stringify(detailStory)) as unknown);
assert.throws(() => safeRemoteStories(overLimit), /limit of 48 detail-page stories/);

console.log("remote detail evidence ingestion tests passed");
