import assert from "node:assert/strict";
import {
  canonicalizeSourceUrl,
  deriveSourceIdentity,
  ensureRawStoryIdentity,
  hashSourceContent,
} from "../lib/source-identity";

const xTwitter = deriveSourceIdentity({
  url: "HTTPS://WWW.TWITTER.COM/OpenAI/status/1812345678901234567?s=20&utm_source=test#replies",
  sourceType: "X",
  source: "Twitter",
});
const xCanonical = deriveSourceIdentity({
  url: "https://x.com/OpenAI/status/1812345678901234567",
  sourceType: "X",
  source: "X",
});
assert.equal(xTwitter.canonicalUrl, "https://x.com/OpenAI/status/1812345678901234567");
assert.equal(xTwitter.nativeId, "1812345678901234567");
assert.equal(xTwitter.sourceDocumentId, xCanonical.sourceDocumentId);
assert.ok(xTwitter.aliasKeys.includes("x:status:1812345678901234567"));

const oldReddit = deriveSourceIdentity({
  url: "https://old.reddit.com/r/stocks/comments/1AbC9z/example/?utm_source=share&share_id=noise#comment",
  sourceType: "Reddit",
  source: "r/stocks",
});
const newReddit = deriveSourceIdentity({
  url: "https://new.reddit.com/r/stocks/comments/1abc9z/example/",
  sourceType: "Reddit",
  source: "r/stocks",
});
const wwwReddit = deriveSourceIdentity({
  url: "https://www.reddit.com/r/stocks/comments/1abc9z/another_slug/",
  sourceType: "Reddit",
  source: "r/stocks",
});
assert.equal(oldReddit.canonicalUrl, "https://www.reddit.com/r/stocks/comments/1AbC9z/example/");
assert.equal(oldReddit.nativeId, "1abc9z");
assert.equal(oldReddit.sourceDocumentId, newReddit.sourceDocumentId);
assert.equal(oldReddit.sourceDocumentId, wwwReddit.sourceDocumentId, "Reddit slug must not fork a post");

const functionalA = canonicalizeSourceUrl("https://example.com/search?sort=new&q=AI&utm_medium=email");
const functionalB = canonicalizeSourceUrl("https://example.com/search?q=AI&sort=top");
assert.equal(functionalA, "https://example.com/search?q=AI&sort=new");
assert.notEqual(functionalA, functionalB, "functional query values must remain part of identity");
assert.equal(
  canonicalizeSourceUrl("https://example.com/search?z=2&a=3&a=1"),
  canonicalizeSourceUrl("https://example.com/search?a=1&z=2&a=3"),
  "query order must not fork an otherwise identical source",
);

assert.notEqual(
  canonicalizeSourceUrl("https://EXAMPLE.com/Company/Report"),
  canonicalizeSourceUrl("https://example.COM/company/Report"),
  "path case must be preserved",
);

const sec = deriveSourceIdentity({
  url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250329.htm?utm_source=brief",
  sourceType: "Official",
  source: "SEC",
});
assert.equal(sec.nativeId, "0000320193-25-000079");
assert.ok(sec.aliasKeys.includes("sec:accession:0000320193-25-000079"));

const guidA = deriveSourceIdentity({
  url: "https://publisher.example/story?id=42",
  sourceType: "News",
  source: "Publisher",
  nativeId: "guid-42",
  feedNamespace: "publisher-main-feed",
});
const guidB = deriveSourceIdentity({
  url: "https://publisher.example/new-location?id=42",
  sourceType: "News",
  source: "Renamed Publisher",
  nativeId: "guid-42",
  feedNamespace: "publisher-main-feed",
});
assert.equal(guidA.sourceDocumentId, guidB.sourceDocumentId, "RSS GUID must survive URL changes within a feed");
assert.equal(guidA.nativeId, "guid-42");
const sameGuidDifferentFeed = deriveSourceIdentity({
  url: "https://another-publisher.example/story",
  sourceType: "News",
  source: "Another publisher",
  nativeId: "guid-42",
  feedNamespace: "another-feed",
});
assert.notEqual(
  guidA.sourceDocumentId,
  sameGuidDifferentFeed.sourceDocumentId,
  "feed namespace must prevent cross-publisher GUID collisions",
);

const rawStory = ensureRawStoryIdentity({
  id: "legacy-32-bit-id",
  nativeId: "rss-guid-9",
  title: "已翻译标题",
  originalTitle: "Original headline",
  description: "已翻译内容",
  originalDescription: "Original body",
  url: "https://publisher.example/Report?id=9&utm_source=rss",
  publishedAt: "2026-07-21T06:00:00.000Z",
  source: "Publisher RSS",
  sourceType: "News",
  collectedAt: "2026-07-21T06:05:00.000Z",
  firstCollectedAt: "2026-07-21T06:01:00.000Z",
  lastCollectedAt: "2026-07-21T06:03:00.000Z",
});
assert.equal(rawStory.id, rawStory.sourceDocumentId);
assert.equal(rawStory.nativeId, "rss-guid-9");
assert.equal(rawStory.canonicalUrl, "https://publisher.example/Report?id=9");
assert.equal(rawStory.originalTitle, "Original headline");
assert.equal(rawStory.originalDescription, "Original body");
assert.equal(rawStory.firstCollectedAt, "2026-07-21T06:01:00.000Z");
assert.equal(rawStory.lastCollectedAt, "2026-07-21T06:05:00.000Z");
assert.equal(rawStory.contentHash?.length, 64);

const differentlyTranslated = ensureRawStoryIdentity({
  ...rawStory,
  title: "另一种译法",
  description: "另一种内容译法",
});
assert.equal(
  differentlyTranslated.contentHash,
  rawStory.contentHash,
  "translations must not create a false source-content revision",
);

const changedOriginal = ensureRawStoryIdentity({
  ...rawStory,
  originalDescription: "Original body with a factual correction",
});
assert.notEqual(changedOriginal.contentHash, rawStory.contentHash);

function legacyHash32(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash;
}

// The old 32-bit polynomial hash collides for these strings; SHA-256 must not.
assert.equal(legacyHash32("Aa"), legacyHash32("BB"));
assert.notEqual(hashSourceContent("Aa"), hashSourceContent("BB"));
assert.equal(hashSourceContent("Aa").length, 64);
assert.equal(hashSourceContent("Aa"), "81acaafba961bb831ec40eb965155e3486392c60cfb8c75150beaf2caffc244a");

console.log("source identity tests passed");
