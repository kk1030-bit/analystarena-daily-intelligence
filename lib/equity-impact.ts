import { stocksForImpactEngine } from "./db";
import type {
  EquityImpactAssessment,
  EquityImpactDirection,
  EquityRelation,
  Headline,
  StockPriceDaily,
  StockProfile,
} from "./types";

type StockWithPrice = StockProfile & { latestPrice?: StockPriceDaily };

const ENGINE_VERSION = "rules-2026.07.2";
const ambiguousSymbols = new Set(["A", "AI", "ALL", "ARE", "ARM", "BA", "C", "CAT", "COP", "COST", "DE", "DIS", "F", "FOR", "GE", "GM", "HD", "ICE", "IT", "MA", "MS", "NOW", "ON", "SO", "T", "U", "V", "X"]);
const ambiguousCompanyAliases = new Set(["apple", "meta", "amazon", "target", "arm", "delta", "strategy", "苹果", "目标", "战略"]);
const financialContextPattern = /(股票|股价|公司|财报|营收|利润|指引|收购|并购|产品|订单|监管|召回|首席执行官|推出|芯片|半导体|银行|stock|shares?|company|earnings|revenue|guidance|acquir|merger|product|contract|regulator|recall|CEO|launch|chip|semiconductor|bank|iPhone|AWS)/i;
const positivePattern = /(上调|增长|超预期|获批|批准|赢得|签署|(?:订单|需求).{0,8}(?:强劲|增加|上升|增长|创纪录)|创纪录|beat(?:s|ing)?|raise[sd]? guidance|approval|approved|wins? contract|record (?:revenue|orders)|demand (?:surge|growth|strong))/i;
const negativePattern = /(下调|召回|调查|禁令|限制出口|制裁|亏损|不及预期|延迟|裁员|诉讼|(?:订单|需求|销量).{0,8}(?:减少|下降|取消|削减)|(?:减少|取消|削减).{0,8}(?:订单|需求)|fails? to (?:win|secure|land).{0,20}(?:contract|order)|cut(?:s|ting)? guidance|recall|investigation|probe|ban(?:ned)?|export restriction|sanction|miss(?:es|ed)? estimates|delay(?:ed)?|layoffs?|lawsuit)/i;
const negatedPositivePattern = /fails? to (?:win|secure|land).{0,20}(?:contract|order)/i;
const denialPattern = /(否认|澄清.{0,8}(?:并未|没有)|den(?:y|ies|ied).{0,45}(?:cut|lower|delay|recall|miss))/i;

interface ExposureRule {
  id: string;
  pattern: RegExp;
  tags: string[];
  direction: EquityImpactDirection;
  relation: EquityRelation;
  mechanism: string;
  counterCase: string;
  confidence: number;
  maxCompanies: number;
}

const exposureRules: ExposureRule[] = [
  {
    id: "ai-demand",
    pattern: /(AI|人工智能|大模型|数据中心).{0,30}(需求|订单|资本支出|算力|accelerator|GPU|capex|demand)/i,
    tags: ["ai_compute", "semiconductor_foundry", "semiconductor_equipment"],
    direction: "potential_upside",
    relation: "supplier",
    mechanism: "AI 算力与数据中心投入增加，可能提高相关芯片及关键供应链的订单能见度。",
    counterCase: "若投入只是预算表态、订单延后或供给受限，实际营收未必同步增长。",
    confidence: 72,
    maxCompanies: 3,
  },
  {
    id: "chip-export-controls",
    pattern: /(芯片|半导体|GPU).{0,35}(出口限制|出口管制|禁运|export (?:ban|control|restriction))/i,
    tags: ["ai_compute", "semiconductor"],
    direction: "potential_downside",
    relation: "macro_exposure",
    mechanism: "先进芯片出口限制可能缩小可服务市场，并增加产品改版与合规成本。",
    counterCase: "若公司已有合规替代产品，或其他地区需求抵消缺口，影响可能低于预期。",
    confidence: 75,
    maxCompanies: 3,
  },
  {
    id: "oil-up",
    pattern: /(油价|原油|布伦特|WTI).{0,30}(上涨|飙升|供应中断|减产|走高|surge|rally|supply disruption|production cut)/i,
    tags: ["oil_producer"],
    direction: "potential_upside",
    relation: "macro_exposure",
    mechanism: "油价与上游实现价格走高，通常会改善大型产油企业的现金流敏感度。",
    counterCase: "若上涨快速逆转、产量下降或对冲限制收益，利润改善可能不明显。",
    confidence: 73,
    maxCompanies: 2,
  },
  {
    id: "oil-airline-cost",
    pattern: /(油价|原油|布伦特|WTI).{0,30}(上涨|飙升|供应中断|减产|走高|surge|rally|supply disruption|production cut)/i,
    tags: ["airline"],
    direction: "potential_downside",
    relation: "macro_exposure",
    mechanism: "燃油成本上升可能压缩航空公司的单位利润，除非票价或燃油对冲足以抵消。",
    counterCase: "有效对冲、运力纪律或票价上涨可能吸收部分成本压力。",
    confidence: 70,
    maxCompanies: 1,
  },
  {
    id: "defense-spending",
    pattern: /(国防预算|军费|武器订单|军工合同|defen[cs]e spending|weapons? order|military contract)/i,
    tags: ["defense"],
    direction: "potential_upside",
    relation: "macro_exposure",
    mechanism: "新增国防预算或合同可能提高军工企业的在手订单与未来收入能见度。",
    counterCase: "预算仍可能被国会调整，且合同金额不等于当期确认收入。",
    confidence: 74,
    maxCompanies: 3,
  },
  {
    id: "crypto-risk-on",
    pattern: /(比特币|以太坊|加密货币|Bitcoin|Ethereum|crypto).{0,30}(上涨|新高|现货 ETF 获批|资金流入|rally|record high|ETF approval|inflows?)/i,
    tags: ["crypto_exposure"],
    direction: "potential_upside",
    relation: "macro_exposure",
    mechanism: "加密资产价格与交易活跃度上升，可能改善相关平台、矿企及持币公司的收入或资产价值。",
    counterCase: "高波动、监管变化或交易量未跟随价格，可能令经营受益低于表面涨幅。",
    confidence: 72,
    maxCompanies: 3,
  },
];

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[’'"“”(),，。:：]/g, " ").replace(/\s+/g, " ").trim();
}

function inferDirection(text: string, fallback?: Headline["sentiment"]): EquityImpactDirection {
  const withoutDeniedClaim = text.replace(new RegExp(denialPattern.source, "gi"), "");
  const withoutNegatedPositive = withoutDeniedClaim.replace(new RegExp(negatedPositivePattern.source, "gi"), "");
  const positive = positivePattern.test(withoutNegatedPositive);
  const negative = negativePattern.test(withoutDeniedClaim);
  if (positive && negative) return "mixed";
  if (positive) return "potential_upside";
  if (negative) return "potential_downside";
  if (fallback === "positive") return "potential_upside";
  if (fallback === "negative") return "potential_downside";
  return "unclear";
}

function sourceScore(headline: Headline): number {
  const types = new Set(headline.sources.map((source) => source.type));
  if (types.has("Official")) return 20;
  if (types.has("News")) return 16;
  return 4;
}

function isSocialOnly(headline: Headline): boolean {
  return headline.sources.length > 0 && headline.sources.every((source) => source.type === "Reddit" || source.type === "X");
}

function companyName(stock: StockProfile): string {
  return stock.longName || stock.shortName || stock.symbol;
}

function marketContext(headline: Headline, price?: StockPriceDaily): EquityImpactAssessment["marketContext"] {
  if (!price) return undefined;
  const eventDate = (headline.publishedAt ?? new Date().toISOString()).slice(0, 10);
  if (price.tradingDate > eventDate) return undefined;
  const eventTime = new Date(`${eventDate}T23:59:59Z`).getTime();
  const ageDays = Math.max(0, Math.floor((eventTime - new Date(`${price.tradingDate}T21:00:00Z`).getTime()) / 86_400_000));
  return {
    asOf: price.tradingDate,
    lastPrice: price.adjustedClose ?? price.close,
    freshness: ageDays <= 4 ? "fresh" : ageDays <= 10 ? "stale" : "missing",
  };
}

function directMatch(stock: StockProfile, rawText: string, normalizedText: string): "symbol" | "alias" | undefined {
  const symbols = [stock.symbol, stock.providerSymbol].filter(Boolean);
  if (symbols.some((symbol) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\$${escaped}\\b`, "i").test(rawText)) return true;
    if (ambiguousSymbols.has(symbol.toLocaleUpperCase()) && !financialContextPattern.test(rawText)) return false;
    return new RegExp(`\\b${escaped}\\b`).test(rawText);
  })) return "symbol";
  const names = [stock.shortName, stock.longName, ...stock.aliases]
    .filter((value): value is string => Boolean(value))
    .map(normalize)
    .filter((value) => {
      const cjkCharacters = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
      return cjkCharacters > 0 ? cjkCharacters >= 2 : value.length >= 4;
    });
  return names.some((alias) => {
    if (ambiguousCompanyAliases.has(alias) && !financialContextPattern.test(rawText)) return false;
    if (/[^\x00-\x7F]/.test(alias)) return normalizedText.includes(alias);
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalizedText);
  }) ? "alias" : undefined;
}

function assessmentForDirect(stock: StockWithPrice, headline: Headline, match: "symbol" | "alias", direction: EquityImpactDirection): EquityImpactAssessment {
  let confidence = (match === "symbol" ? 52 : 46) + sourceScore(headline) + Math.min(10, (headline.crossSourceCount ?? 1) * 3);
  if (direction !== "unclear") confidence += 8;
  if (isSocialOnly(headline)) confidence = Math.min(confidence, 45);
  confidence = Math.min(96, confidence);
  const directionText = direction === "potential_upside" ? "可能形成正面催化" : direction === "potential_downside" ? "可能形成经营或估值压力" : direction === "mixed" ? "同时包含正负因素" : "影响方向仍待确认";
  return {
    symbol: stock.symbol,
    providerSymbol: stock.providerSymbol,
    companyName: companyName(stock),
    direction,
    relation: "issuer",
    mappingConfidence: confidence,
    mechanism: `新闻直接涉及 ${companyName(stock)}，事件${directionText}。`,
    assumptions: ["新闻主体与数据库公司实体已正确匹配", "事件描述尚需以公司公告或监管文件继续确认"],
    counterCase: "若后续官方信息否定、缩小或推迟该事件，实际市场影响可能与初步判断不同。",
    evidence: [{
      basis: match === "symbol" ? "explicit_symbol" : "company_alias",
      statement: match === "symbol" ? `新闻明确出现股票代码 ${stock.symbol}` : `新闻出现公司名称或已审核别名 ${companyName(stock)}`,
      weight: match === "symbol" ? 1 : 0.9,
    }],
    marketContext: marketContext(headline, stock.latestPrice),
    engineVersion: ENGINE_VERSION,
    reviewStatus: "auto_pending",
  };
}

function assessmentForRule(stock: StockWithPrice, headline: Headline, rule: ExposureRule): EquityImpactAssessment {
  let confidence = rule.confidence + Math.min(6, Math.max(0, sourceScore(headline) - 14));
  if (isSocialOnly(headline)) confidence = Math.min(confidence, 45);
  return {
    symbol: stock.symbol,
    providerSymbol: stock.providerSymbol,
    companyName: companyName(stock),
    direction: rule.direction,
    relation: rule.relation,
    mappingConfidence: Math.min(88, confidence),
    mechanism: rule.mechanism,
    assumptions: [`${companyName(stock)} 的已审核业务标签包含：${stock.exposureTags.filter((tag) => rule.tags.includes(tag)).join("、")}`, "该传导路径属于情景判断，并非已证实因果"],
    counterCase: rule.counterCase,
    evidence: [{ basis: "event_rule", statement: `事件符合规则 ${rule.id}`, weight: 0.72 }, {
      basis: "curated_exposure", statement: `股票主档含有与事件相符的业务暴露标签`, weight: 0.78,
    }],
    marketContext: marketContext(headline, stock.latestPrice),
    engineVersion: ENGINE_VERSION,
    reviewStatus: "auto_pending",
  };
}

export function identifyEquityImpacts(headline: Headline, stocks: StockWithPrice[]): EquityImpactAssessment[] {
  // ticker is presentation metadata, not evidence. A company must be named in the
  // article fields before it can receive a direct issuer mapping.
  const rawText = [headline.title, headline.summary, ...(headline.keyPoints ?? []), headline.marketImpact].join(" ");
  const normalizedText = normalize(rawText);
  const directDirection = inferDirection(rawText, headline.sentiment);
  const bySymbol = new Map<string, EquityImpactAssessment>();

  for (const stock of stocks) {
    const match = directMatch(stock, rawText, normalizedText);
    if (match) bySymbol.set(stock.symbol, assessmentForDirect(stock, headline, match, directDirection));
  }

  for (const rule of exposureRules) {
    if (!rule.pattern.test(rawText)) continue;
    const matches = stocks
      .filter((stock) => stock.exposureTags.some((tag) => rule.tags.includes(tag)))
      .sort((left, right) => (right.marketCap ?? 0) - (left.marketCap ?? 0))
      .slice(0, rule.maxCompanies);
    for (const stock of matches) {
      if (!bySymbol.has(stock.symbol)) bySymbol.set(stock.symbol, assessmentForRule(stock, headline, rule));
    }
  }

  return [...bySymbol.values()]
    .sort((left, right) => right.mappingConfidence - left.mappingConfidence || left.symbol.localeCompare(right.symbol))
    .slice(0, 5);
}

export async function attachEquityImpacts(headlines: Headline[]): Promise<Headline[]> {
  try {
    const stockCache = new Map<string, ReturnType<typeof stocksForImpactEngine>>();
    return await Promise.all(headlines.map(async (headline) => {
      const dateMatch = headline.publishedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
      const cacheKey = dateMatch ?? "latest";
      let stockRequest = stockCache.get(cacheKey);
      if (!stockRequest) {
        stockRequest = stocksForImpactEngine(dateMatch);
        stockCache.set(cacheKey, stockRequest);
      }
      const stocks = await stockRequest;
      if (!stocks.length) return headline;
      const existing = headline.equityImpacts ?? [];
      if (existing.length && existing.every((item) => item.engineVersion === ENGINE_VERSION)) return headline;
      const reviewBySymbol = new Map(existing
        .filter((item) => item.engineVersion === ENGINE_VERSION)
        .map((item) => [item.symbol, item.reviewStatus]));
      const equityImpacts = identifyEquityImpacts(headline, stocks).map((item) => ({
        ...item,
        reviewStatus: reviewBySymbol.get(item.symbol) ?? item.reviewStatus,
      }));
      return { ...headline, equityImpacts };
    }));
  } catch (error) {
    console.warn("Equity impact engine unavailable", error);
    return headlines;
  }
}
