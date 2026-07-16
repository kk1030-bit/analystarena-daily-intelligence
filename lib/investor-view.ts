import type { Category, DailyBrief, Headline, SocialTopic, SourceLink, SourceType } from "./types";

export type SignalPlatform = "Reddit" | "X";
export type EvidenceLevel = "official" | "reported" | "social" | "pending";

export interface SignalEntry {
  id: string;
  platform: SignalPlatform;
  topic: SocialTopic;
  index: number;
}

export interface EvidenceState {
  level: EvidenceLevel;
  label: string;
  detail: string;
}

const sourcePriority: Record<SourceType, number> = { Official: 0, News: 1, Reddit: 2, X: 3 };
const genericTickers = new Set(["AI", "ETF", "市场", "宏观", "半导体", "加密", "财报", "地缘"]);
const stopWords = new Set([
  "人工", "智能", "市场", "今日", "讨论", "相关", "更新", "公司", "事件", "目前", "可能", "数据", "新闻",
  "the", "and", "for", "with", "from", "this", "that", "market", "news", "update",
]);

const topicAliases = [
  ["nvidia", "nvda", "英伟达", "辉达"],
  ["tsmc", "tsm", "台积电", "台湾积体电路"],
  ["fomc", "federalreserve", "美联储", "联准会"],
  ["openai", "chatgpt"],
  ["bitcoin", "btc", "比特币"],
  ["etf", "交易所交易基金"],
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, "");
}

function meaningfulTokens(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]{3,}/g) ?? []) {
    if (!stopWords.has(word)) tokens.add(word);
  }
  for (const run of normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!stopWords.has(pair)) tokens.add(pair);
    }
  }
  return tokens;
}

function aliasMatch(left: string, right: string): boolean {
  const leftText = normalize(left);
  const rightText = normalize(right);
  return topicAliases.some((group) => group.some((alias) => leftText.includes(normalize(alias))) && group.some((alias) => rightText.includes(normalize(alias))));
}

export function socialSignalId(topic: SocialTopic, platform: SignalPlatform, index: number): string {
  return topic.id?.trim() || `${platform.toLowerCase()}-${index}-${normalize(topic.label).slice(0, 24) || "signal"}`;
}

export function flattenSignals(brief: Pick<DailyBrief, "socialBuzz">): SignalEntry[] {
  const reddit = (brief.socialBuzz?.reddit ?? []).map((topic, index) => ({
    id: socialSignalId(topic, "Reddit", index), platform: "Reddit" as const, topic, index,
  }));
  const x = (brief.socialBuzz?.x ?? []).map((topic, index) => ({
    id: socialSignalId(topic, "X", index), platform: "X" as const, topic, index,
  }));
  return [...reddit, ...x].sort((left, right) => signalStrength(right.topic) - signalStrength(left.topic));
}

export function signalStrength(topic: SocialTopic): number {
  if (Number.isFinite(topic.signalScore)) return Math.max(0, Math.min(100, Math.round(topic.signalScore ?? 0)));
  return Math.max(20, Math.min(92, Math.round(24 + Math.log1p(Math.max(0, topic.mentions)) * 13)));
}

export function signalMetricLabel(topic: SocialTopic): string {
  if (topic.metricKind === "mentions") return "提及次数";
  if (topic.metricKind === "engagement") return "本批互动量";
  if (topic.metricKind === "estimated") return "本批排序指标";
  return "历史热度指标";
}

export function sortedSources(headline: Headline): SourceLink[] {
  return [...headline.sources].sort((left, right) => sourcePriority[left.type] - sourcePriority[right.type]);
}

export function headlineEvidence(headline: Headline): EvidenceState {
  const sourceTypes = new Set(headline.sources.map((source) => source.type));
  if (sourceTypes.has("Official")) {
    return { level: "official", label: "官方来源已纳入", detail: "事件包含公司、监管机构或政府机构的第一手来源。" };
  }
  if (sourceTypes.has("News")) {
    return { level: "reported", label: "新闻来源已报道", detail: "已有新闻来源支持，但仍应等待官方披露或更多独立来源确认。" };
  }
  return { level: "social", label: "仅社交线索", detail: "目前只有 Reddit 或 X 讨论，不应直接视为已证实事实。" };
}

export function resolveSignalHeadline(topic: SocialTopic, headlines: Headline[]): Headline | undefined {
  if (topic.relatedHeadlineId) {
    const related = headlines.find((headline) => headline.id === topic.relatedHeadlineId);
    if (related) return related;
  }

  if (topic.url) {
    const topicUrl = topic.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    const sameSource = headlines.find((headline) => headline.sources.some((source) => source.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase() === topicUrl));
    if (sameSource) return sameSource;
  }

  const signalText = `${topic.label} ${topic.description ?? ""}`;
  const signalTokens = meaningfulTokens(signalText);
  let best: { headline: Headline; score: number; anchors: number } | undefined;

  for (const headline of headlines) {
    if (topic.category && headline.category !== topic.category) continue;
    const headlineText = `${headline.ticker} ${headline.title} ${headline.summary}`;
    const headlineTokens = meaningfulTokens(headlineText);
    const overlap = [...signalTokens].filter((token) => headlineTokens.has(token)).length;
    const tickerAnchor = !genericTickers.has(headline.ticker) && normalize(signalText).includes(normalize(headline.ticker));
    const aliasAnchor = aliasMatch(signalText, headlineText);
    const anchors = Number(tickerAnchor) + Number(aliasAnchor);
    const score = overlap + anchors * 4;
    if (!best || score > best.score) best = { headline, score, anchors };
  }

  return best && (best.anchors >= 1 || best.score >= 4) ? best.headline : undefined;
}

export function signalEvidence(topic: SocialTopic, headline?: Headline): EvidenceState {
  if (!headline) {
    return { level: "pending", label: "尚未验证", detail: "这项讨论尚未关联到本期可信市场事件，请先查看原始讨论并等待官方或新闻来源。" };
  }
  const evidence = headlineEvidence(headline);
  if (evidence.level === "official") return { ...evidence, label: "已关联官方事件" };
  if (evidence.level === "reported") return { ...evidence, label: "已关联新闻事件" };
  return { ...evidence, label: "关联仅限社交来源" };
}

export function headlineRiskFlags(headline: Headline): string[] {
  const flags: string[] = [];
  const types = new Set(headline.sources.map((source) => source.type));
  if (!types.has("Official")) flags.push("尚无官方第一手来源");
  if ((headline.crossSourceCount ?? types.size) < 2) flags.push("跨来源层级不足");
  if (headline.freshnessScore !== undefined && headline.freshnessScore < 54) flags.push("事件时效性偏低");
  if (headline.confidence < 75) flags.push("系统信心低于 75%");
  if ((headline.timestampKind ?? "published") === "collected") flags.push("仅确认采集时间，原始发布时间待核实");
  return flags.length ? flags : ["未发现明显证据缺口，仍需持续跟踪后续披露"];
}

const categoryScopes: Record<Category, string[]> = {
  Macro: ["利率与债券", "美元", "成长股估值"],
  AI: ["人工智能应用", "云计算", "数据中心"],
  Semiconductor: ["芯片设计", "晶圆代工", "设备与材料"],
  Crypto: ["数字资产", "交易平台", "加密相关基金"],
  ETF: ["基金资金流", "相关指数", "成分资产"],
  Earnings: ["公司股价", "同业估值", "上下游供应链"],
  Geopolitics: ["能源与运输", "防务", "风险资产"],
  Other: ["相关公司", "同业", "大盘风险偏好"],
};

export function affectedScopes(headline: Headline): string[] {
  return [headline.ticker, ...categoryScopes[headline.category]].filter((item, index, all) => item && all.indexOf(item) === index);
}

export function sourceTypeLabel(type: SourceType): string {
  return { Official: "官方", News: "新闻", Reddit: "Reddit", X: "X" }[type];
}
