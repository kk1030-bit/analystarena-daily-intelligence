import assert from "node:assert/strict";
import { identifyEquityImpacts } from "../lib/equity-impact";
import type { Headline, StockProfile } from "../lib/types";

const updatedAt = "2026-07-16T22:00:00.000Z";

function stock(symbol: string, name: string, aliases: string[], exposureTags: string[], marketCap: number): StockProfile {
  return { symbol, providerSymbol: symbol, shortName: name, longName: name, aliases, exposureTags, marketCap, active: true, sourceUpdatedAt: updatedAt };
}

const stocks = [
  stock("NVDA", "NVIDIA Corporation", ["NVIDIA", "英伟达"], ["ai_compute", "semiconductor"], 4_000_000_000_000),
  stock("AMD", "Advanced Micro Devices, Inc.", ["AMD", "超微半导体"], ["ai_compute", "semiconductor"], 350_000_000_000),
  stock("TSLA", "Tesla, Inc.", ["Tesla", "特斯拉"], ["electric_vehicle"], 1_000_000_000_000),
  stock("AAPL", "Apple Inc.", ["Apple", "苹果"], ["consumer"], 4_800_000_000_000),
  stock("NOW", "ServiceNow, Inc.", ["ServiceNow"], ["enterprise_software"], 190_000_000_000),
  stock("INTC", "Intel Corporation", ["Intel", "英特尔"], ["semiconductor"], 150_000_000_000),
  stock("ARM", "Arm Holdings plc", ["Arm"], ["semiconductor"], 180_000_000_000),
  stock("XOM", "Exxon Mobil Corporation", ["Exxon", "埃克森美孚"], ["oil_producer"], 500_000_000_000),
  stock("DAL", "Delta Air Lines, Inc.", ["Delta", "Delta Air Lines", "达美航空"], ["airline"], 45_000_000_000),
];

function headline(title: string, ticker = "市场", sourceType: Headline["sources"][number]["type"] = "News"): Headline {
  return {
    id: title, rank: 1, ticker, title, summary: title, marketImpact: "",
    category: "Other", impact: 4, confidence: 80, mentions: 3, sentiment: "neutral",
    publishedAt: "2026-07-17T01:00:00.000Z", sources: [{ name: "test", type: sourceType, url: "https://example.com" }],
  };
}

const nvidia = identifyEquityImpacts(headline("NVIDIA raises Blackwell revenue guidance as demand surges", "NVDA"), stocks);
assert.equal(nvidia[0]?.symbol, "NVDA");
assert.equal(nvidia[0]?.direction, "potential_upside");
assert.ok((nvidia[0]?.mappingConfidence ?? 0) >= 70);

const tesla = identifyEquityImpacts(headline("Tesla recalls two million vehicles after safety defect", "TSLA"), stocks);
assert.equal(tesla.find((item) => item.symbol === "TSLA")?.direction, "potential_downside");

const fed = identifyEquityImpacts(headline("Federal Reserve cuts interest rates by 25 basis points", "FOMC"), stocks);
assert.equal(fed.length, 0, "宏观降息不应自动列出全部科技股");

const exportBan = identifyEquityImpacts(headline("美国扩大先进芯片出口管制，限制 GPU 对华销售", "半导体", "Official"), stocks);
assert.equal(exportBan.find((item) => item.symbol === "NVDA")?.direction, "potential_downside");
assert.equal(exportBan.find((item) => item.symbol === "AMD")?.direction, "potential_downside");

const oil = identifyEquityImpacts(headline("供应中断推动原油价格飙升", "宏观"), stocks);
assert.equal(oil.find((item) => item.symbol === "XOM")?.direction, "potential_upside");
assert.equal(oil.find((item) => item.symbol === "DAL")?.direction, "potential_downside");

const rumor = identifyEquityImpacts(headline("Reddit rumor says Apple will acquire a startup", "市场", "Reddit"), stocks);
assert.ok((rumor.find((item) => item.symbol === "AAPL")?.mappingConfidence ?? 99) <= 45);

const harvest = identifyEquityImpacts(headline("apple harvest forecast improves after rainfall"), stocks);
assert.equal(harvest.some((item) => item.symbol === "AAPL"), false);

const denied = identifyEquityImpacts(headline("Tesla denies report it cut guidance", "TSLA"), stocks);
assert.notEqual(denied.find((item) => item.symbol === "TSLA")?.direction, "potential_downside");

const tickerOnly = identifyEquityImpacts(headline("AI infrastructure spending remains strong", "NVDA"), stocks);
assert.equal(tickerOnly.some((item) => item.symbol === "NVDA"), false, "ticker 元数据不能单独作为公司映射证据");

const failedContract = identifyEquityImpacts(headline("NVIDIA fails to win contract for a major data center", "市场"), stocks);
assert.equal(failedContract.find((item) => item.symbol === "NVDA")?.direction, "potential_downside");

const appleOrdersCut = identifyEquityImpacts(headline("苹果订单减少/取消，供应商下调产量预期", "市场"), stocks);
assert.equal(appleOrdersCut.find((item) => item.symbol === "AAPL")?.direction, "potential_downside");

const appleHarvest = identifyEquityImpacts(headline("苹果丰收带动水果批发价格下降", "市场"), stocks);
assert.equal(appleHarvest.some((item) => item.symbol === "AAPL"), false, "中文歧义别名缺少金融语境时不应匹配");

const impactFieldEvidence = headline("AI infrastructure spending remains strong", "NVDA");
impactFieldEvidence.marketImpact = "NVDA shares may benefit from higher accelerator demand";
assert.equal(identifyEquityImpacts(impactFieldEvidence, stocks).some((item) => item.symbol === "NVDA"), true);

assert.equal(identifyEquityImpacts(headline("NOW is the time to improve public education"), stocks).some((item) => item.symbol === "NOW"), false);
assert.equal(identifyEquityImpacts(headline("Intelligence agencies publish an annual security report"), stocks).some((item) => item.symbol === "INTC"), false);
assert.equal(identifyEquityImpacts(headline("River delta expands after heavy rainfall"), stocks).some((item) => item.symbol === "DAL"), false);
assert.equal(identifyEquityImpacts(headline("ARM launches a new data-center chip product"), stocks).some((item) => item.symbol === "ARM"), true);

const mixedNvidia = identifyEquityImpacts(
  headline("NVIDIA beats revenue estimates but cuts forward guidance", "NVDA", "Official"),
  stocks,
).find((item) => item.symbol === "NVDA");
assert.equal(mixedNvidia?.direction, "mixed");
assert.ok((mixedNvidia?.directionConfidence ?? 0) >= 60);

const socialDirection = identifyEquityImpacts(
  headline("NVIDIA demand surges according to an unverified post", "NVDA", "Reddit"),
  stocks,
).find((item) => item.symbol === "NVDA");
assert.ok((socialDirection?.directionConfidence ?? 99) <= 45, "social-only direction evidence must be capped");

const pricedNvda = {
  ...stocks[0],
  priceSummary: {
    asOf: "2026-07-16",
    lastPrice: 110,
    previousClose: 100,
    close5SessionsAgo: 88,
    latestVolume: 150,
    averageVolume20d: 100,
  },
};
const pricedImpact = identifyEquityImpacts(
  headline("NVIDIA raises Blackwell revenue guidance as demand surges", "NVDA"),
  [pricedNvda],
)[0];
assert.equal(pricedImpact?.marketContext?.return1dPct, 10);
assert.equal(pricedImpact?.marketContext?.return5dPct, 25);
assert.equal(pricedImpact?.marketContext?.volumeVs20d, 1.5);

const futurePricedNvda = {
  ...pricedNvda,
  priceSummary: { ...pricedNvda.priceSummary, asOf: "2026-07-18" },
};
assert.equal(
  identifyEquityImpacts(headline("NVIDIA raises Blackwell revenue guidance as demand surges", "NVDA"), [futurePricedNvda])[0]?.marketContext,
  undefined,
  "prices after the event date must not be shown as event-time evidence",
);

console.log("equity impact tests passed");
