import OpenAI from "openai";
import OpenCC from "opencc-js";
import type { DailyBrief, Headline, SocialTopic, TermNote } from "./types";
import { extractTermNotes } from "./terms";

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
const TRANSLATION_CACHE_PREFIX = "zh-CN:v3:";
const TRANSLATION_CACHE_LIMIT = 2_000;
const TRANSLATION_CONCURRENCY = 4;
const translationCache = new Map<string, string>();
const translationsInFlight = new Map<string, Promise<string>>();
const translationWaiters: Array<() => void> = [];
let activeTranslations = 0;

// These terms are useful identifiers for investors and should remain searchable
// in their original form. Other English prose still goes through translation.
const preservedTerms = new Set([
  "ai", "api", "apis", "btc", "capex", "cpi", "cpu", "cpus", "ebitda", "eps", "etf", "etfs",
  "eth", "fomc", "gdp", "gpu", "gpus", "ipo", "ir", "llm", "llms", "p/e", "ppi", "qoq", "rss",
  "sec", "usd", "us", "usa", "yoy",
  "amazon", "amd", "anthropic", "apple", "blackwell", "bloomberg", "broadcom", "coinbase", "deepseek",
  "google", "intel", "meta", "microsoft", "nvidia", "openai", "reddit", "reuters", "tesla", "tsmc",
]);

const commonEnglishProse = new Set([
  "after", "amid", "and", "as", "at", "beat", "beats", "before", "boost", "booms", "boom", "by", "cut",
  "cuts", "decline", "declines", "demand", "down", "earnings", "estimate", "estimates", "for", "from", "growth",
  "guidance", "higher", "improve", "improves", "in", "inflation", "into", "launch", "launches", "lower", "market",
  "markets", "miss", "misses", "new", "of", "on", "outlook", "profit", "profits", "rate", "rates", "record",
  "revenue", "rise", "rises", "sales", "shares", "strong", "surge", "surges", "the", "to", "up", "weak", "with",
]);

// The PDF's Simplified Chinese font does not cover every writing system. Any
// remaining narrative in these scripts must be translated before publication
// instead of silently turning into missing-glyph boxes in the report.
const translatableForeignScript = /[\u0400-\u052F\u0590-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u31F0-\u31FF\uA960-\uA97F\uAC00-\uD7FF]/u;

function normalizeMainlandTerms(value: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/[\u53f0\u81fa]\u5317[\u65f6\u6642][\u95f4\u9593]/g, "\u5317\u4eac\u65f6\u95f4"],
    [/Taipei\s+Time/gi, "\u5317\u4eac\u65f6\u95f4"],
    [/조선일보/g, "朝鲜日报"],
    [/\u8054\u51c6\u4f1a/g, "\u7f8e\u8054\u50a8"],
    [/\u8baf\u53f7/g, "\u4fe1\u53f7"],
    [/\u8d44\u8baf/g, "\u4fe1\u606f"],
    [/\u793e\u7fa4/g, "\u793e\u4ea4\u5a92\u4f53"],
    [/\u6b96\u5229\u7387/g, "\u6536\u76ca\u7387"],
    [/\u901a\u81a8/g, "\u901a\u80c0"],
    [/\u4f3a\u670d\u5668/g, "\u670d\u52a1\u5668"],
    [/\u5e10\u53f7/g, "\u8d26\u53f7"],
    [/\u6cd5\u8bf4\u4f1a?/g, "\u8d22\u62a5\u8bf4\u660e\u4f1a"],
    [/\u641c\u5bfb/g, "\u641c\u7d22"],
    [/\u64b7\u53d6/g, "\u6293\u53d6"],
    [/\u5907\u63f4/g, "\u5907\u7528"],
    [/\u8bbe\u5b9a/g, "\u8bbe\u7f6e"],
    [/\u8fde\u7ebf/g, "\u8fde\u63a5"],
    [/\u56de\u4f20/g, "\u8fd4\u56de"],
    [/\u8bb0\u5fc6\u4f53/g, "\u5185\u5b58"],
    [/\u50a8\u5b58/g, "\u4fdd\u5b58"],
    [/\u8d44\u6599/g, "\u6570\u636e"],
    [/\u673a\u7387/g, "\u6982\u7387"],
    [/\u6676\u7247/g, "\u82af\u7247"],
    [/\u901a\u8def/g, "\u6e20\u9053"],
    [/\u80fd\u89c1\u5ea6/g, "\u53ef\u89c1\u6027"],
    [/\u6708\u8425\u6536/g, "\u6708\u5ea6\u8425\u6536"],
    [/\u600e\u5e7a/g, "\u600e\u4e48"],
    [/\u4e3a\u4ec0\u5e7a/g, "\u4e3a\u4ec0\u4e48"],
    [/\u90a3\u5e7a/g, "\u90a3\u4e48"],
    [/\u8fd9\u5e7a/g, "\u8fd9\u4e48"],
    [/\u751a\u5e7a/g, "\u4ec0\u4e48"],
  ];
  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function simplify(value: string): string {
  return normalizeMainlandTerms(toSimplified(value));
}

function clean(value: string): string {
  return value.replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function isPreservedEnglishToken(token: string): boolean {
  const normalized = token.toLowerCase();
  if (/^@[A-Za-z0-9_]{1,30}$/.test(token)) return true;
  if (/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/.test(token)) return true;
  if (preservedTerms.has(normalized)) return true;
  if (/^q[1-4]$/i.test(token)) return true;
  if (/^\$[a-z]{1,6}$/i.test(token)) return true;
  // Market index / contract identifiers commonly mix uppercase letters with
  // digits (for example SP500). They are searchable identifiers, not English
  // prose, and must not make an otherwise complete Chinese translation fail.
  if (/^[A-Z]{1,6}\d{1,4}$/.test(token)) return true;
  // Uppercase market identifiers remain searchable, except for common prose
  // that publishers occasionally capitalize in alert-style headlines.
  if (/^[A-Z]{1,6}$/.test(token) && !commonEnglishProse.has(normalized)) return true;
  return false;
}

function hasTranslatableText(value: string): boolean {
  if (translatableForeignScript.test(value)) return true;
  const tokens = value.match(/[@$]?[A-Za-z][A-Za-z0-9_]*(?:[./'-][A-Za-z0-9_]+)*|Q[1-4]/g) ?? [];
  const hasChineseContext = /[\u3400-\u9FFF]/.test(value);
  return tokens.some((token, index) => {
    if (isPreservedEnglishToken(token)) return false;
    const previous = tokens[index - 1] ?? "";
    const next = tokens[index + 1] ?? "";
    const titleCased = (candidate: string) => /^[A-Z][A-Za-z]{2,}$/.test(candidate);
    if (hasChineseContext && /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(token)) return false;
    // Media and company names often retain small connector words after the
    // surrounding prose has been translated (for example The Motley Fool or
    // Bank of America). Keep those identifiers, but still reject lowercase
    // English prose such as "the market".
    if (hasChineseContext && commonEnglishProse.has(token.toLowerCase())) {
      if ((titleCased(previous) && titleCased(next)) || (token === "The" && titleCased(next))) return false;
    }
    if (commonEnglishProse.has(token.toLowerCase())) return true;
    // Once the surrounding sentence is Chinese, a title-cased token is most
    // likely a company, person or product name (for example Palantir). Keeping
    // it avoids rejecting an otherwise complete translation just because the
    // proper noun is not yet present in the curated allow-list.
    if (hasChineseContext && /^[A-Z][A-Za-z]{2,}$/.test(token)) return false;
    const letters = token.replace(/[^A-Za-z]/g, "");
    return letters.length >= 2;
  });
}

function cacheKey(value: string): string {
  return `${TRANSLATION_CACHE_PREFIX}${value}`;
}

function getCachedTranslation(key: string): string | undefined {
  const cached = translationCache.get(key);
  if (cached === undefined) return undefined;
  translationCache.delete(key);
  translationCache.set(key, cached);
  return cached;
}

function setCachedTranslation(key: string, value: string): void {
  translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    const oldest = translationCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    translationCache.delete(oldest);
  }
}

async function withTranslationSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeTranslations < TRANSLATION_CONCURRENCY) {
    activeTranslations += 1;
  } else {
    await new Promise<void>((resolve) => translationWaiters.push(resolve));
  }
  try {
    return await work();
  } finally {
    const next = translationWaiters.shift();
    // Passing the occupied slot directly to the next waiter prevents a new
    // arrival from racing the queued job and temporarily exceeding the limit.
    if (next) next();
    else activeTranslations -= 1;
  }
}

function translationFromGooglePayload(payload: unknown): string {
  const segments = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] as unknown[] : [];
  return segments.map((segment) => Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : "").join("");
}

async function translateWithGoogle(value: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const params = new URLSearchParams({ client: "gtx", sl: "auto", tl: "zh-CN", dt: "t", q: value });
      const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
        headers: { "User-Agent": "Mozilla/5.0 AnalystArenaTranslation/2.0" },
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`\u81ea\u52a8\u7ffb\u8bd1\u670d\u52a1\u8fd4\u56de ${response.status}`);
      const translated = simplify(clean(translationFromGooglePayload(await response.json() as unknown)));
      if (!translated) throw new Error("\u81ea\u52a8\u7ffb\u8bd1\u670d\u52a1\u672a\u8fd4\u56de\u5185\u5bb9");
      if (hasTranslatableText(translated)) throw new Error("\u81ea\u52a8\u7ffb\u8bd1\u7ed3\u679c\u4ecd\u5305\u542b\u672a\u7ffb\u8bd1\u53d9\u8ff0");
      return translated;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("\u81ea\u52a8\u7ffb\u8bd1\u5931\u8d25");
}

async function translateWithOpenAI(value: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OpenAI \u7ffb\u8bd1\u5907\u7528\u670d\u52a1\u672a\u8bbe\u7f6e");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5.2",
    max_output_tokens: 1_200,
    instructions: [
      "\u5c06\u8f93\u5165\u51c6\u786e\u7ffb\u8bd1\u4e3a\u7b80\u4f53\u4e2d\u6587\uff0c\u53ea\u8f93\u51fa\u8bd1\u6587\u3002",
      "\u4fdd\u7559\u516c\u53f8\u540d\u3001\u4ea7\u54c1\u540d\u3001\u80a1\u7968\u4ee3\u7801\u3001\u6570\u5b57\u548c\u5e38\u89c1\u91d1\u878d\u7f29\u5199\uff0c\u4e0d\u5f97\u589e\u52a0\u539f\u6587\u6ca1\u6709\u7684\u4fe1\u606f\u3002",
      "\u97e9\u6587\u3001\u65e5\u6587\u5047\u540d\u3001\u897f\u91cc\u5c14\u5b57\u6bcd\u7b49\u975e\u62c9\u4e01\u6587\u5b57\u5fc5\u987b\u8bd1\u6210\u901a\u7528\u7b80\u4f53\u4e2d\u6587\u540d\uff1b\u65e0\u56fa\u5b9a\u8bd1\u540d\u65f6\u97f3\u8bd1\uff0c\u4e0d\u5f97\u4fdd\u7559\u539f\u6587\u5b57\u7b26\u3002",
    ].join("\n"),
    input: value,
  });
  const translated = simplify(clean(response.output_text));
  if (!translated) throw new Error("OpenAI \u7ffb\u8bd1\u5907\u7528\u670d\u52a1\u672a\u8fd4\u56de\u5185\u5bb9");
  if (hasTranslatableText(translated)) throw new Error("OpenAI \u7ffb\u8bd1\u7ed3\u679c\u4ecd\u5305\u542b\u672a\u7ffb\u8bd1\u53d9\u8ff0");
  return translated;
}

async function translateEnglish(value: string): Promise<string> {
  const key = cacheKey(value);
  const cached = getCachedTranslation(key);
  if (cached !== undefined) return cached;

  const pending = translationsInFlight.get(key);
  if (pending) return pending;

  const translation = withTranslationSlot(async () => {
    try {
      return await translateWithGoogle(value);
    } catch (googleError) {
      if (!process.env.OPENAI_API_KEY) throw googleError;
      return translateWithOpenAI(value);
    }
  }).then((result) => {
    setCachedTranslation(key, result);
    return result;
  }).finally(() => {
    translationsInFlight.delete(key);
  });

  translationsInFlight.set(key, translation);
  return translation;
}

export async function localizeText(value: string): Promise<string> {
  const normalized = clean(value);
  if (!normalized) return normalized;
  const simplified = simplify(normalized);
  if (!hasTranslatableText(simplified)) return simplified;
  try {
    return await translateEnglish(simplified);
  } catch {
    return simplified;
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
  const [title, summary, marketImpact, directionRationale, keyPoints] = await Promise.all([
    localizeText(headline.title),
    localizeText(headline.summary),
    localizeText(headline.marketImpact),
    headline.directionRationale ? localizeText(headline.directionRationale) : Promise.resolve(headline.directionRationale),
    mapLimited(headline.keyPoints ?? [], 3, localizeText),
  ]);
  const claims = headline.claims?.map((claim) => {
    let statement = claim.statement;
    if (claim.claimKey === "title") statement = title;
    else if (claim.claimKey === "summary") statement = summary;
    else if (claim.claimKey === "market_impact") statement = marketImpact;
    else if (claim.claimKey === "direction_rationale" && directionRationale) statement = directionRationale;
    else {
      const pointIndex = claim.claimKey.match(/^important_information:(\d+)$/)?.[1];
      if (pointIndex !== undefined && keyPoints[Number(pointIndex)] !== undefined) statement = keyPoints[Number(pointIndex)];
    }
    return {
      ...claim,
      statement,
      originalStatement: claim.originalStatement ?? claim.statement,
      language: "zh-CN",
      // statementHash remains the hash of originalStatement. Translation is
      // presentation and must not change evidence identity.
    };
  });
  const localized = { ...headline, title, summary, marketImpact, directionRationale, keyPoints, claims };
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

function untranslatedCriticalFields(headlines: Headline[]): string[] {
  return headlines.flatMap((headline) => {
    const fields: Array<[string, string]> = [
      ["title", headline.title],
      ["summary", headline.summary],
      ["marketImpact", headline.marketImpact],
      ...(headline.directionRationale ? [["directionRationale", headline.directionRationale] as [string, string]] : []),
      ...(headline.keyPoints ?? []).map((point, index): [string, string] => [`keyPoints[${index}]`, point]),
    ];
    return fields
      .filter(([, value]) => hasTranslatableText(value))
      .map(([field]) => `headlines.${headline.id}.${field}`);
  });
}

export async function localizeBriefContent(
  brief: DailyBrief,
  options: { strict?: boolean } = {},
): Promise<DailyBrief> {
  const [headlines, reddit, x, heatNotes, watchEvents, watchReasons] = await Promise.all([
    mapLimited(brief.headlines, 4, localizeHeadline),
    localizeTopics(brief.socialBuzz.reddit),
    localizeTopics(brief.socialBuzz.x),
    mapLimited(brief.marketHeat, 3, async (item) => localizeText(item.note)),
    mapLimited(brief.watchlist, 3, async (item) => localizeText(item.event)),
    mapLimited(brief.watchlist, 3, async (item) => localizeText(item.why)),
  ]);
  const incomplete = untranslatedCriticalFields(headlines);
  if (options.strict && incomplete.length) {
    throw new Error(`\u7b80\u4f53\u4e2d\u6587\u7ffb\u8bd1\u672a\u5b8c\u6210\uff1a${incomplete.join("\u3001")}`);
  }
  const translationWarning = incomplete.length
    ? `\u90e8\u5206\u5b57\u6bb5\u7684\u81ea\u52a8\u7ffb\u8bd1\u5f85\u4eba\u5de5\u786e\u8ba4\uff1a${incomplete.join("\u3001")}`
    : undefined;

  return {
    ...brief,
    translationEnabled: incomplete.length === 0,
    warning: [brief.warning ? await localizeText(brief.warning) : brief.warning, translationWarning].filter(Boolean).join(" ") || undefined,
    headlines,
    marketHeat: brief.marketHeat.map((item, index) => ({ ...item, note: heatNotes[index] })),
    socialBuzz: { reddit, x },
    watchlist: brief.watchlist.map((item, index) => ({ ...item, event: watchEvents[index], why: watchReasons[index] })),
  };
}
