import OpenCC from "opencc-js";
import type { DailyBrief, Headline, SocialTopic, TermNote } from "./types";
import { extractTermNotes } from "./terms";

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
const translationCache = new Map<string, string>();

function normalizeMainlandTerms(value: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/联准会/g, "美联储"],
    [/讯号/g, "信号"],
    [/资讯/g, "信息"],
    [/社群/g, "社交媒体"],
    [/殖利率/g, "收益率"],
    [/通膨/g, "通胀"],
    [/伺服器/g, "服务器"],
    [/帐号/g, "账号"],
    [/法说会?/g, "财报说明会"],
    [/搜寻/g, "搜索"],
    [/撷取/g, "抓取"],
    [/备援/g, "备用"],
    [/设定/g, "设置"],
    [/连线/g, "连接"],
    [/回传/g, "返回"],
    [/记忆体/g, "内存"],
    [/储存/g, "保存"],
    [/资料/g, "数据"],
    [/机率/g, "概率"],
    [/晶片/g, "芯片"],
    [/通路/g, "渠道"],
    [/能见度/g, "可见性"],
    [/月营收/g, "月度营收"],
    [/怎幺/g, "怎么"],
    [/为什幺/g, "为什么"],
    [/那幺/g, "那么"],
    [/这幺/g, "这么"],
    [/甚幺/g, "什么"],
  ];
  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function simplify(value: string): string {
  return normalizeMainlandTerms(toSimplified(value));
}

function needsEnglishTranslation(value: string): boolean {
  const latinCount = (value.match(/[A-Za-z]/g) ?? []).length;
  const chineseCount = (value.match(/[\u3400-\u9fff]/g) ?? []).length;
  return latinCount >= 10 && (chineseCount === 0 || latinCount > chineseCount * 1.25);
}

function clean(value: string): string {
  return value.replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

async function translateEnglish(value: string): Promise<string> {
  const cached = translationCache.get(value);
  if (cached) return cached;

  const params = new URLSearchParams({ client: "gtx", sl: "auto", tl: "zh-CN", dt: "t", q: value });
  const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
    headers: { "User-Agent": "Mozilla/5.0 AnalystArenaTranslation/1.0" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`自动翻译服务返回 ${response.status}`);
  const payload = await response.json() as unknown;
  const segments = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] as unknown[] : [];
  const translated = segments.map((segment) => Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : "").join("");
  if (!translated) throw new Error("自动翻译服务未返回内容");
  const result = simplify(clean(translated));
  translationCache.set(value, result);
  return result;
}

export async function localizeText(value: string): Promise<string> {
  const normalized = clean(value);
  if (!normalized) return normalized;
  if (!needsEnglishTranslation(normalized)) return simplify(normalized);
  try {
    return await translateEnglish(normalized);
  } catch {
    return simplify(normalized);
  }
}

async function mapLimited<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return result;
}

async function localizeHeadline(headline: Headline): Promise<Headline> {
  const [title, summary, marketImpact, keyPoints] = await Promise.all([
    localizeText(headline.title),
    localizeText(headline.summary),
    localizeText(headline.marketImpact),
    mapLimited(headline.keyPoints ?? [], 3, localizeText),
  ]);
  const localized = { ...headline, title, summary, marketImpact, keyPoints };
  const termNotes: TermNote[] = extractTermNotes(localized);
  return { ...localized, termNotes };
}

async function localizeTopics(topics: SocialTopic[]): Promise<SocialTopic[]> {
  return mapLimited(topics, 3, async (topic) => {
    const [label, description] = await Promise.all([
      localizeText(topic.label),
      topic.description ? localizeText(topic.description) : Promise.resolve(topic.description),
    ]);
    return { ...topic, label, description };
  });
}

export async function localizeBriefContent(brief: DailyBrief): Promise<DailyBrief> {
  const [headlines, reddit, x, heatNotes, watchEvents, watchReasons] = await Promise.all([
    mapLimited(brief.headlines, 4, localizeHeadline),
    localizeTopics(brief.socialBuzz.reddit),
    localizeTopics(brief.socialBuzz.x),
    mapLimited(brief.marketHeat, 3, async (item) => localizeText(item.note)),
    mapLimited(brief.watchlist, 3, async (item) => localizeText(item.event)),
    mapLimited(brief.watchlist, 3, async (item) => localizeText(item.why)),
  ]);

  return {
    ...brief,
    translationEnabled: true,
    warning: brief.warning ? await localizeText(brief.warning) : brief.warning,
    headlines,
    marketHeat: brief.marketHeat.map((item, index) => ({ ...item, note: heatNotes[index] })),
    socialBuzz: { reddit, x },
    watchlist: brief.watchlist.map((item, index) => ({ ...item, event: watchEvents[index], why: watchReasons[index] })),
  };
}
