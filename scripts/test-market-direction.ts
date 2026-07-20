import assert from "node:assert/strict";
import {
  equityDirectionPresentation,
  formatReturn,
  headlineDirectionConfidence,
  headlineDirectionPresentation,
  headlineDirectionRationale,
  headlineMarketDirection,
  marketDirectionCounts,
} from "../lib/market-direction";
import type { EquityImpactAssessment, Headline } from "../lib/types";

function headline(overrides: Partial<Headline> = {}): Headline {
  return {
    id: "direction-test",
    rank: 1,
    ticker: "市场",
    title: "测试事件",
    summary: "测试事件摘要",
    marketImpact: "等待确认市场传导",
    category: "Other",
    impact: 3,
    confidence: 82,
    mentions: 2,
    sentiment: "neutral",
    sources: [{ name: "测试来源", type: "News", url: "https://example.com" }],
    ...overrides,
  };
}

function equityImpact(
  symbol: string,
  direction: EquityImpactAssessment["direction"],
  overrides: Partial<EquityImpactAssessment> = {},
): EquityImpactAssessment {
  return {
    symbol,
    providerSymbol: symbol,
    companyName: symbol,
    direction,
    relation: "issuer",
    mappingConfidence: 84,
    directionConfidence: 78,
    mechanism: "测试传导机制",
    assumptions: [],
    counterCase: "若事件未落实，方向可能反转。",
    evidence: [{ basis: "company_alias", statement: "新闻明确提及公司", weight: 80 }],
    engineVersion: "test",
    reviewStatus: "auto_pending",
    ...overrides,
  };
}

const bullish = headline({ sentiment: "positive" });
assert.equal(headlineMarketDirection(bullish), "bullish");
assert.deepEqual(
  [headlineDirectionPresentation(bullish).label, headlineDirectionPresentation(bullish).symbol],
  ["潜在利好", "↑"],
);

const bearish = headline({ sentiment: "negative" });
assert.equal(headlineMarketDirection(bearish), "bearish");
assert.deepEqual(
  [headlineDirectionPresentation(bearish).label, headlineDirectionPresentation(bearish).symbol],
  ["潜在利空", "↓"],
);

const neutral = headline();
assert.equal(headlineMarketDirection(neutral), "neutral");
assert.deepEqual(
  [headlineDirectionPresentation(neutral).label, headlineDirectionPresentation(neutral).symbol],
  ["方向待确认", "—"],
);

const mixed = headline({
  marketDirection: "bullish",
  equityImpacts: [
    equityImpact("NVDA", "potential_upside"),
    equityImpact("AMD", "potential_downside"),
  ],
});
assert.equal(headlineMarketDirection(mixed), "mixed", "相反个股传导应优先显示为多空并存");
assert.deepEqual(
  [headlineDirectionPresentation(mixed).label, headlineDirectionPresentation(mixed).symbol],
  ["多空并存", "↕"],
);
assert.match(headlineDirectionRationale(mixed), /NVDA.*潜在受益.*AMD.*潜在承压/);

const rejectedDoesNotPollute = headline({
  equityImpacts: [
    equityImpact("NVDA", "potential_upside", { reviewStatus: "approved" }),
    equityImpact("AMD", "potential_downside", { reviewStatus: "rejected" }),
  ],
});
assert.equal(headlineMarketDirection(rejectedDoesNotPollute), "bullish", "已拒绝判断不得影响事件方向");
assert.doesNotMatch(headlineDirectionRationale(rejectedDoesNotPollute), /AMD/);

const lowConfidenceDoesNotPollute = headline({
  equityImpacts: [
    equityImpact("NVDA", "potential_upside"),
    equityImpact("AMD", "potential_downside", { mappingConfidence: 59, directionConfidence: 95 }),
  ],
});
assert.equal(headlineMarketDirection(lowConfidenceDoesNotPollute), "bullish", "低置信映射不得改变事件方向");

assert.deepEqual(
  marketDirectionCounts([bullish, bearish, mixed, neutral]),
  { bullish: 1, bearish: 1, mixed: 1, neutral: 1 },
);

assert.equal(equityDirectionPresentation("potential_upside").symbol, "↑");
assert.equal(equityDirectionPresentation("potential_downside").symbol, "↓");
assert.equal(equityDirectionPresentation("mixed").symbol, "↕");
assert.equal(equityDirectionPresentation("unclear").symbol, "—");

assert.equal(headlineDirectionConfidence(headline({ directionConfidence: 1000 })), 99);
assert.equal(headlineDirectionConfidence(headline({ directionConfidence: -10 })), 1);
assert.equal(
  headlineDirectionConfidence(headline({
    confidence: 70,
    equityImpacts: [equityImpact("NVDA", "potential_upside", { directionConfidence: 64 })],
  })),
  64,
);

assert.equal(formatReturn(3.126), "+3.13%");
assert.equal(formatReturn(-2.345), "-2.35%");
assert.equal(formatReturn(0), "0.00%");
assert.equal(formatReturn(0.004), "0.00%");
assert.equal(formatReturn(undefined), "—");
assert.equal(formatReturn(Number.NaN), "—");

console.log("market direction tests passed");
