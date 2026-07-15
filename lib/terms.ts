import type { Category, Headline, TermNote } from "./types";

export const categoryDisplayNames: Record<Category, string> = {
  Macro: "宏观经济",
  AI: "人工智能（AI）",
  Semiconductor: "半导体",
  Crypto: "加密资产",
  ETF: "交易所交易基金（ETF）",
  Earnings: "财报",
  Geopolitics: "地缘政治",
  Other: "其他",
};

const financialTerms: Array<TermNote & { pattern: RegExp }> = [
  { term: "AI", note: "人工智能", pattern: /\bAI\b/i },
  { term: "FOMC", note: "美国联邦公开市场委员会", pattern: /\bFOMC\b/i },
  { term: "SEC", note: "美国证券交易委员会", pattern: /\bSEC\b/i },
  { term: "ETF", note: "交易所交易基金", pattern: /\bETFs?\b/i },
  { term: "CPI", note: "消费者价格指数", pattern: /\bCPI\b/i },
  { term: "PPI", note: "生产者价格指数", pattern: /\bPPI\b/i },
  { term: "GDP", note: "国内生产总值", pattern: /\bGDP\b/i },
  { term: "EPS", note: "每股收益", pattern: /\bEPS\b/i },
  { term: "P/E", note: "市盈率", pattern: /\bP\s*\/\s*E\b/i },
  { term: "EBITDA", note: "息税折旧及摊销前利润", pattern: /\bEBITDA\b/i },
  { term: "CapEx", note: "资本支出", pattern: /\bcap\s*ex\b|\bcapex\b/i },
  { term: "IPO", note: "首次公开募股", pattern: /\bIPO\b/i },
  { term: "GPU", note: "图形处理器", pattern: /\bGPUs?\b/i },
  { term: "CPU", note: "中央处理器", pattern: /\bCPUs?\b/i },
  { term: "LLM", note: "大语言模型", pattern: /\bLLMs?\b/i },
  { term: "API", note: "应用程序接口", pattern: /\bAPIs?\b/i },
  { term: "RSS", note: "网站内容订阅格式", pattern: /\bRSS\b/i },
  { term: "IR", note: "投资者关系", pattern: /\bIR\b/i },
  { term: "YoY", note: "同比", pattern: /\bYoY\b/i },
  { term: "QoQ", note: "环比", pattern: /\bQoQ\b/i },
  { term: "Blackwell", note: "英伟达新一代图形处理器架构", pattern: /\bBlackwell\b/i },
  { term: "CoWoS", note: "台积电先进封装技术", pattern: /\bCoWoS\b/i },
];

export function extractTermNotes(headline: Pick<Headline, "ticker" | "title" | "summary" | "keyPoints" | "marketImpact">): TermNote[] {
  const content = [headline.ticker, headline.title, headline.summary, ...(headline.keyPoints ?? []), headline.marketImpact].join(" ");
  return financialTerms.filter((item) => item.pattern.test(content)).slice(0, 5).map(({ term, note }) => ({ term, note }));
}

export function sourceDisplayName(name: string): string {
  const exact: Record<string, string> = {
    "Federal Reserve": "美联储（Federal Reserve）",
    SEC: "美国证券交易委员会（SEC）",
    "Google News": "谷歌新闻（Google News）",
    "AI & markets": "人工智能与市场新闻",
    "Macro & earnings": "宏观经济与财报新闻",
    "Technology & companies": "科技与公司新闻",
    "X discovery fallback": "X 平台搜索备用源",
    "r/stocks RSS fallback": "Reddit 股票社区备用源",
    "r/investing RSS fallback": "Reddit 投资社区备用源",
    "Company IR": "公司投资者关系页面（IR）",
    "Company blogs": "公司官方博客",
    "X discovery": "X 平台搜索",
  };
  if (exact[name]) return exact[name];
  if (/^r\//i.test(name)) return `Reddit 社区 ${name}`;
  if (/reddit/i.test(name)) return name.replace(/reddit/i, "Reddit 社区");
  return name;
}
