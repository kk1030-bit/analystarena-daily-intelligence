import assert from "node:assert/strict";

delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const {
  ETF_MAX_TRACKED,
  aggregateEtfDigest,
  beijingWeekday,
  deterministicEtfOverview,
  enumerateBeijingDates,
  etfBeijingDate,
  etfBeijingHourKey,
  etfEngagement,
  isEtfRelevant,
  lastCompletedBeijingWeek,
  previousBeijingDate,
  selectTopEtfPosts,
  validateEtfBatch,
} = await import("../lib/etf-topics");
const {
  getActiveEtfTracked,
  getEtfDigest,
  getEtfTopicsView,
  getLatestEtfSelection,
  listEtfDigests,
  listEtfSelectionsForDates,
  resetEtfMemoryStores,
  saveEtfDigest,
  saveEtfIngest,
} = await import("../lib/etf-db");
const { buildEtfDailyDigest, buildEtfWeeklyDigest } = await import("../lib/etf-summarize");

// --- Relevance and ranking -------------------------------------------------
assert.ok(isEtfRelevant("ETFs", "Any question at all", ""), "r/ETFs is always on-topic");
assert.ok(isEtfRelevant("investing", "Should I buy VOO or VTI?", ""), "ticker mentions are on-topic");
assert.ok(isEtfRelevant("Bogleheads", "Question about expense ratio", ""), "ETF terms are on-topic");
assert.ok(!isEtfRelevant("stocks", "Apple earnings beat expectations", "iPhone sales grew"), "non-ETF posts are filtered");
assert.equal(etfEngagement(100, 25), 150);

// --- Batch validation ------------------------------------------------------
function redditUrl(id: string): string {
  return `https://www.reddit.com/r/ETFs/comments/${id}/discussion_thread/`;
}

const batch = validateEtfBatch({
  observedAt: "2026-09-01T05:07:00.000Z",
  posts: [
    {
      nativeId: "t3_aaa111",
      subreddit: "r/ETFs",
      author: "u/etf_kol",
      title: "VOO vs VTI allocation question",
      body: "I have been dollar cost averaging into VOO for two years. Considering adding VTI for total market exposure going forward.",
      url: redditUrl("aaa111"),
      score: "not-a-number",
      comments: 25,
      publishedAtRaw: "2026-09-01T04:00:00Z",
    },
    { subreddit: "ETFs", author: "", title: "", body: "", url: redditUrl("bbb222"), score: 5, comments: 1, publishedAtRaw: null },
    { subreddit: "ETFs", author: "someone", title: "No URL post", body: "", url: "not-a-url", score: 5, comments: 1, publishedAtRaw: null },
    {
      subreddit: "ETFs",
      author: "dupe",
      title: "Duplicate of the first post",
      body: "",
      url: redditUrl("aaa111"),
      score: 1,
      comments: 0,
      publishedAtRaw: null,
    },
    {
      subreddit: "dividends",
      author: "income_investor",
      title: "SCHD dividend growth report",
      body: "Short body.",
      url: redditUrl("ccc333"),
      score: 80,
      comments: 10,
      publishedAtRaw: "yesterday",
    },
  ],
});
assert.equal(batch.observedAt, "2026-09-01T05:07:00.000Z");
assert.equal(batch.posts.length, 2, "malformed and duplicate posts are skipped");
assert.equal(batch.skipped, 3);
const [first, second] = batch.posts;
assert.equal(first.nativeId, "aaa111");
assert.equal(first.author, "etf_kol", "the u/ prefix is stripped");
assert.equal(first.score, 0, "non-numeric scores clamp to zero");
assert.equal(first.engagement, 50);
assert.equal(first.timestampKind, "published");
assert.equal(first.publishedAt, "2026-09-01T04:00:00.000Z");
assert.equal(second.timestampKind, "collected", "unparseable publish strings fall back to collection time");
assert.equal(second.publishedAt, batch.observedAt);
assert.throws(() => validateEtfBatch({ posts: "nope" }), /posts must be an array/);

// --- Beijing time helpers --------------------------------------------------
assert.equal(etfBeijingDate(new Date("2026-09-01T05:07:00.000Z")), "2026-09-01");
assert.equal(etfBeijingHourKey(new Date("2026-09-01T05:07:00.000Z")), "2026-09-01 13");
assert.equal(etfBeijingHourKey(new Date("2026-09-01T16:07:00.000Z")), "2026-09-02 00", "16:07 UTC is the 00:00 Beijing review");
assert.equal(previousBeijingDate("2026-09-02"), "2026-09-01");
assert.equal(previousBeijingDate("2026-09-01"), "2026-08-31");
assert.equal(beijingWeekday("2026-08-31"), 1, "2026-08-31 is a Monday");
assert.equal(beijingWeekday("2026-08-30"), 7, "2026-08-30 is a Sunday");
const week = lastCompletedBeijingWeek(new Date("2026-09-01T16:07:00.000Z"));
assert.deepEqual(week, { startDate: "2026-08-24", endDate: "2026-08-30", periodKey: "2026-08-24~2026-08-30" });
assert.deepEqual(enumerateBeijingDates("2026-08-30", "2026-09-02"), ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);

// --- Hourly ingest, tracking window and digests (memory storage) -----------
resetEtfMemoryStores();

function makePost(id: string, engagement: number, title = `Post ${id} about VOO`) {
  return validateEtfBatch({
    observedAt: "2026-09-01T05:07:00.000Z",
    posts: [{
      subreddit: "ETFs",
      author: `author_${id}`,
      title,
      body: "A body about index funds and expense ratios that is long enough to summarize.",
      url: redditUrl(id),
      score: engagement,
      comments: 0,
      publishedAtRaw: "2026-09-01T04:00:00Z",
    }],
  }).posts[0];
}

const hour1 = "2026-09-01T05:07:00.000Z";
const candidates1 = [
  makePost("aaa100", 500), makePost("bbb200", 300), makePost("ccc300", 100),
  makePost("ddd400", 90), makePost("eee500", 80), makePost("fff600", 10),
];
const selection1 = selectTopEtfPosts(candidates1);
assert.equal(selection1.length, 5);
assert.equal(selection1[0].nativeId, "aaa100");
assert.ok(!selection1.some((post) => post.nativeId === "fff600"), "the sixth-ranked post is not selected");

await saveEtfIngest({
  observedAt: hour1,
  beijingHour: etfBeijingHourKey(new Date(hour1)),
  selection: selection1.map((post, index) => ({
    postId: post.id, rank: index + 1, engagement: post.engagement, score: post.score, comments: post.comments,
    title: post.title, titleZh: `译文 ${post.nativeId}`, keyPointsZh: ["要点一", "要点二"], url: post.url,
    subreddit: post.subreddit, author: post.author,
  })),
  newTracked: selection1.map((post) => ({ post, titleZh: `译文 ${post.nativeId}`, keyPointsZh: ["要点一", "要点二"], generator: "deterministic" })),
  observations: selection1.map((post, index) => ({
    postId: post.id, observedAt: hour1, score: post.score, comments: post.comments, engagement: post.engagement, rank: index + 1,
  })),
});
assert.equal((await getActiveEtfTracked(hour1)).length, 5);

// Hour 2: a stronger new post enters; a tracked post gains engagement.
const hour2 = "2026-09-01T06:07:00.000Z";
const grownA = makePost("aaa100", 600);
const newcomer = makePost("ggg700", 700);
const selection2 = selectTopEtfPosts([grownA, newcomer, makePost("bbb200", 290)]);
assert.equal(selection2[0].nativeId, "ggg700");
await saveEtfIngest({
  observedAt: hour2,
  beijingHour: etfBeijingHourKey(new Date(hour2)),
  selection: selection2.map((post, index) => ({
    postId: post.id, rank: index + 1, engagement: post.engagement, score: post.score, comments: post.comments,
    title: post.title, titleZh: `译文 ${post.nativeId}`, keyPointsZh: ["要点"], url: post.url,
    subreddit: post.subreddit, author: post.author,
  })),
  newTracked: [{ post: newcomer, titleZh: "译文 ggg700", keyPointsZh: ["要点"], generator: "deterministic" }],
  observations: selection2.map((post, index) => ({
    postId: post.id, observedAt: hour2, score: post.score, comments: post.comments, engagement: post.engagement, rank: index + 1,
  })),
});

const activeHour2 = await getActiveEtfTracked(hour2);
assert.equal(activeHour2.length, 6);
const trackedA = activeHour2.find((post) => post.nativeId === "aaa100");
assert.equal(trackedA?.latestEngagement, 600, "hourly observations update the latest engagement");
assert.equal(trackedA?.peakEngagement, 600, "peak engagement follows the highest observation");

// A day after hour 1 the first five expire; the newcomer (tracked from hour 2)
// stays inside its own 24-hour window.
const hour26 = "2026-09-02T05:30:00.000Z";
const activeLate = await getActiveEtfTracked(hour26);
assert.equal(activeLate.length, 1, "the 24-hour tracking window expires");
assert.equal(activeLate[0].nativeId, "ggg700");

const latestSelection = await getLatestEtfSelection();
assert.equal(latestSelection?.beijingHour, "2026-09-01 14");
assert.equal((await listEtfSelectionsForDates(["2026-09-01"])).length, 2);

// Daily digest for the finished Beijing date.
const daily = await buildEtfDailyDigest("2026-09-01");
assert.ok(daily);
assert.equal(daily.kind, "daily");
assert.equal(daily.periodKey, "2026-09-01");
assert.equal(daily.generator, "deterministic");
assert.equal(daily.content.stats.selections, 2);
assert.equal(daily.content.topPosts[0].title.includes("ggg700"), true, "the weekly peak leads the digest");
assert.ok(daily.content.overviewZh.includes("2 次整点评审"));
await saveEtfDigest(daily);
assert.equal((await getEtfDigest("daily", "2026-09-01"))?.titleZh, daily.titleZh);
assert.equal((await listEtfDigests("daily", 7)).length, 1);
assert.equal(await buildEtfDailyDigest("2026-08-15"), null, "dates without selections produce no digest");

// Weekly digest across the seven-day window.
const weekly = await buildEtfWeeklyDigest("2026-08-31", "2026-09-06");
assert.ok(weekly);
assert.equal(weekly.periodKey, "2026-08-31~2026-09-06");
assert.equal(weekly.content.stats.uniquePosts, 6);
await saveEtfDigest(weekly);

const view = await getEtfTopicsView(hour26);
assert.equal(view.storageMode, "memory");
assert.equal(view.latestSelection?.beijingHour, "2026-09-01 14");
assert.equal(view.tracked.filter((post) => post.active).length, 1);
assert.ok(view.tracked[0].observations.length >= 1);
assert.equal(view.dailyDigests.length, 1);
assert.equal(view.weeklyDigest?.periodKey, "2026-08-31~2026-09-06");
assert.ok(view.topAuthors.some((author) => author.author === "author_ggg700"));

// The tracked set never exceeds 5 posts × 24 hours = 120.
resetEtfMemoryStores();
const flood = Array.from({ length: 130 }, (_, index) => makePost(`cap${String(index).padStart(3, "0")}`, 50 + index));
await saveEtfIngest({
  observedAt: hour1,
  beijingHour: etfBeijingHourKey(new Date(hour1)),
  selection: [],
  newTracked: flood.map((post) => ({ post, titleZh: "", keyPointsZh: [], generator: "deterministic" })),
  observations: [],
});
assert.equal((await getActiveEtfTracked(hour1)).length, ETF_MAX_TRACKED);

// Digest aggregation dedupes repeat selections by peak engagement.
const digestContent = aggregateEtfDigest("2026-09-01", "2026-09-01", [
  { items: [{ postId: "p1", rank: 1, engagement: 100, score: 100, comments: 0, title: "T", titleZh: "译", keyPointsZh: ["a"], url: "https://www.reddit.com/r/ETFs/comments/x1/t/", subreddit: "etfs", author: "kol" }] },
  { items: [{ postId: "p1", rank: 1, engagement: 250, score: 250, comments: 0, title: "T", titleZh: "译", keyPointsZh: ["a", "b"], url: "https://www.reddit.com/r/ETFs/comments/x1/t/", subreddit: "etfs", author: "kol" }] },
], 10);
assert.equal(digestContent.stats.uniquePosts, 1);
assert.equal(digestContent.topPosts[0].peakEngagement, 250);
assert.equal(digestContent.topPosts[0].keyPointsZh.length, 2, "the richer key points win");
assert.equal(digestContent.stats.topAuthors[0].author, "kol");
assert.ok(deterministicEtfOverview("weekly", digestContent).includes("一周"));

console.log("ETF hot topics tests passed");
