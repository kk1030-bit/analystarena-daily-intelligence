import assert from "node:assert/strict";
import {
  applyAiEnrichmentFailClosed,
  assertAiPreservesDeterministicEvents,
  clusterStories,
  storiesCanCorroborate,
} from "../lib/pipeline";
import type { Headline, RawStory } from "../lib/types";

const publishedAt = "2026-07-23T12:00:00.000Z";

function googleStory(id: string, title: string, description = title): RawStory {
  return {
    id,
    sourceDocumentId: `sd_${id}`,
    nativeId: `gn:${id}`,
    feedNamespace: "https://news.google.com/rss",
    canonicalUrl: `https://news.google.com/rss/articles/${id}`,
    title,
    originalTitle: title,
    description,
    originalDescription: description,
    url: `https://news.google.com/rss/articles/${id}`,
    publishedAt,
    originalPublishedAt: publishedAt,
    source: "Technology & companies",
    sourceType: "News",
    timestampKind: "published",
  };
}

function publisherStory(id: string, publisher: string, title: string): RawStory {
  return {
    id,
    sourceDocumentId: `sd_${id}`,
    title,
    originalTitle: title,
    description: title,
    originalDescription: title,
    url: `https://${publisher.toLowerCase().replace(/\W+/g, "")}.example/${id}`,
    publishedAt,
    originalPublishedAt: publishedAt,
    source: publisher,
    sourceType: "News",
    timestampKind: "published",
  };
}

function groupContaining(groups: RawStory[][], id: string): RawStory[] {
  const group = groups.find((candidate) => candidate.some((story) => story.id === id));
  assert.ok(group, `missing cluster for ${id}`);
  return group;
}

const motleyNvidia = googleStory(
  "motley-nvidia",
  "Beyond Nvidia: Why the Next Phase of AI Could Crown a New Market Leader - The Motley Fool",
);
const motleyTesla = googleStory(
  "motley-tesla",
  "Could Buying Tesla Stock Today 10x Your Net Worth? - The Motley Fool",
);
const motleyEtf = googleStory(
  "motley-etf",
  "Does Your ETF Portfolio Reflect Your Goals? A Look at the SPDR Global Stock Market ETF vs. the Climate Paris Aligned ETF. - The Motley Fool",
);

assert.equal(storiesCanCorroborate(motleyNvidia, motleyTesla), false);
assert.equal(storiesCanCorroborate(motleyTesla, motleyEtf), false);
assert.equal(
  clusterStories([motleyNvidia, motleyTesla, motleyEtf]).length,
  3,
  "a shared Google News publisher suffix must never create corroboration",
);
const unknownPublisherTesla = publisherStory(
  "unknown-publisher-tesla",
  "Acme Journal",
  "Tesla Q2 2026 earnings beat expectations - Acme Journal",
);
const unknownPublisherNvidia = publisherStory(
  "unknown-publisher-nvidia",
  "Acme Journal",
  "Nvidia Q2 2026 earnings beat expectations - Acme Journal",
);
assert.equal(
  storiesCanCorroborate(unknownPublisherTesla, unknownPublisherNvidia),
  false,
  "a direct feed publisher label must not satisfy the shared-entity gate",
);

const teslaMorning = googleStory(
  "tesla-morning",
  "Tesla earnings, Amazon layoffs, Kevin Warsh's favorite phrases and more in Morning Squawk - CNBC",
);
const teslaEarnings = googleStory(
  "tesla-earnings",
  "Tesla misses on earnings, as free cash flow turns negative and margins slide - CNBC",
);
const teslaCapex = googleStory(
  "tesla-capex",
  "Tesla Earnings: Shares Fall on Capital Expenditure Growth and Delayed Optimus - Morningstar",
);
const googleCapex = googleStory(
  "google-capex",
  "Google's extreme AI capex spending plans trigger a technical warning on the stock price - Yahoo Finance",
);
const googleEarnings = googleStory(
  "google-earnings",
  "Google Q2 earnings top expectations, cloud revenue grows 82%, but stock falls on capex growth - Yahoo Finance",
);
const teslaGoogleBridge = googleStory(
  "tesla-google-bridge",
  "Dow Jones Futures Fall As Oil Prices Top $90; Google, Tesla Skid On Earnings, Capital Spending - Investor's Business Daily",
);

assert.equal(storiesCanCorroborate(teslaMorning, teslaEarnings), true);
assert.equal(storiesCanCorroborate(teslaEarnings, teslaCapex), true);
assert.equal(storiesCanCorroborate(googleCapex, googleEarnings), true);
assert.equal(storiesCanCorroborate(teslaMorning, googleCapex), false);
const bridgeGroups = clusterStories([
  teslaMorning,
  teslaEarnings,
  teslaCapex,
  googleCapex,
  googleEarnings,
  teslaGoogleBridge,
]);
const teslaGroup = groupContaining(bridgeGroups, "tesla-earnings");
assert.ok(teslaGroup.some((story) => story.id === "tesla-capex"));
assert.ok(
  !teslaGroup.some((story) => story.id === "google-capex" || story.id === "google-earnings"),
  "a multi-company bridge must not transitively join Tesla-only and Google-only events",
);
for (const group of bridgeGroups) {
  for (let left = 0; left < group.length; left += 1) {
    for (let right = left + 1; right < group.length; right += 1) {
      assert.equal(
        storiesCanCorroborate(group[left], group[right]),
        true,
        `cluster ${group.map((story) => story.id).join(", ")} is not a complete semantic clique`,
      );
    }
  }
}

const barronsTesla = googleStory(
  "barrons-tesla",
  "Why Analysts Aren't Worried About Tesla's Latest Post-Earnings Stock Slide - Barron's",
);
const barronsMicron = googleStory(
  "barrons-micron",
  "Micron Stock Is Gaining After Google Earnings. Why SK Hynix Is Rising Even More. - Barron's",
);
assert.equal(storiesCanCorroborate(barronsTesla, barronsMicron), false);
assert.equal(clusterStories([barronsTesla, barronsMicron]).length, 2);

const qzLockheed = googleStory(
  "qz-lockheed",
  "Lockheed Martin Q2 2026 earnings beat, full-year outlook raised - qz.com",
);
const qzNasdaq = googleStory(
  "qz-nasdaq",
  "Nasdaq Q2 2026 earnings beat on SpaceX IPO, data revenue - qz.com",
);
assert.equal(storiesCanCorroborate(qzLockheed, qzNasdaq), false);
assert.equal(clusterStories([qzLockheed, qzNasdaq]).length, 2);

const teslaQ1 = googleStory("tesla-q1", "Tesla Q1 2026 earnings beat expectations - Reuters");
const teslaQ2 = googleStory("tesla-q2", "Tesla Q2 2026 earnings beat expectations - CNBC");
assert.equal(
  storiesCanCorroborate(teslaQ1, teslaQ2),
  false,
  "matching company/event words cannot override an explicit reporting-period conflict",
);

const teslaLaunchModelQ = googleStory("tesla-model-q", "Tesla Launches Model Q Electric Car - Reuters");
const teslaUnveilsModelQ = googleStory("tesla-model-q-2", "Tesla Unveils Model Q Electric Vehicle - CNBC");
const teslaLaunchRobotaxi = googleStory("tesla-robotaxi", "Tesla Launches Robotaxi App in the US - Bloomberg");
assert.equal(storiesCanCorroborate(teslaLaunchModelQ, teslaUnveilsModelQ), true);
assert.equal(
  storiesCanCorroborate(teslaLaunchModelQ, teslaLaunchRobotaxi),
  false,
  "the same company and launch verb cannot merge distinct named products",
);

const microsoftOpenAiDeal = googleStory("msft-openai", "Microsoft Signs AI Deal With OpenAI - Reuters");
const microsoftAnthropicDeal = googleStory("msft-anthropic", "Microsoft Signs AI Deal With Anthropic - CNBC");
assert.equal(
  storiesCanCorroborate(microsoftOpenAiDeal, microsoftAnthropicDeal),
  false,
  "the same company and transaction verb cannot merge distinct counterparties",
);

const acmeLaunch = googleStory("acme-launch", "Acme Robotics Launches Orion Warehouse Robot - Reuters");
const acmeUnveils = googleStory("acme-unveils", "Acme Robotics Unveils Orion Robot for Warehouses - CNBC");
assert.equal(
  storiesCanCorroborate(acmeLaunch, acmeUnveils),
  true,
  "unknown multi-word entities should still corroborate when the event predicate also matches",
);

const chineseTeslaEarnings = googleStory("zh-tesla-earnings", "特斯拉2026年第二季度财报不及预期 - 财经媒体");
const chineseTeslaRecall = googleStory("zh-tesla-recall", "特斯拉在美国宣布新一轮召回 - 新闻媒体");
const chineseTeslaEarningsSecond = googleStory("zh-tesla-earnings-2", "特斯拉第二季度财报显示利润下降 - 市场媒体");
assert.equal(storiesCanCorroborate(chineseTeslaEarnings, chineseTeslaRecall), false);
assert.equal(storiesCanCorroborate(chineseTeslaEarnings, chineseTeslaEarningsSecond), true);
const unknownChineseA = googleStory("zh-unknown-a", "星河科技发布新一代仓储机器人 - 媒体甲");
const unknownChineseB = googleStory("zh-unknown-b", "星河科技推出仓储机器人平台 - 媒体乙");
assert.equal(
  storiesCanCorroborate(unknownChineseA, unknownChineseB),
  false,
  "an unknown language/entity shape must remain separate instead of guessing identity",
);

const availableIds = new Set(["event-a", "event-b"]);
assert.equal(assertAiPreservesDeterministicEvents(["event-a"], availableIds), "event-a");
assert.throws(
  () => assertAiPreservesDeterministicEvents(["event-a", "event-b"], availableIds),
  /attempted to merge 2 deterministic events/,
);
assert.throws(
  () => assertAiPreservesDeterministicEvents(["event-a", "event-a"], availableIds),
  /duplicate deterministic source IDs/,
);
assert.throws(
  () => assertAiPreservesDeterministicEvents(["invented"], availableIds),
  /unknown deterministic source IDs/,
);
const deterministicCandidates = [
  { id: "event-a" } as Headline,
  { id: "event-b" } as Headline,
  { id: "event-c" } as Headline,
];
const rejectedEnrichment = await applyAiEnrichmentFailClosed(
  deterministicCandidates,
  async () => {
    throw new Error("unsafe sourceIds");
  },
);
assert.equal(rejectedEnrichment.enabled, false);
assert.strictEqual(
  rejectedEnrichment.candidates,
  deterministicCandidates,
  "AI rejection must retain the exact complete deterministic candidate set",
);
assert.match(String(rejectedEnrichment.error), /unsafe sourceIds/);

console.log("story clustering semantic gate tests passed");
