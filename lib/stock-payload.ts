import type { StockPriceDaily, StockProfile, StockSyncPayload, StockSyncRun } from "./types";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} 不得超过 ${max} 个字符`);
  return text;
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function finiteNumber(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = requiredString(value, label, 64);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!match) throw new Error(`${label} 必须是带时区的 RFC 3339 时间`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new Error(`${label} 必须是有效日历时间`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} 必须是有效时间`);
  return parsed.toISOString();
}

function dateOnly(value: unknown, label: string): string {
  const text = requiredString(value, label, 10);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new Error(`${label} 必须是有效的 YYYY-MM-DD`);
  return text;
}

function symbol(value: unknown, label: string): string {
  const text = requiredString(value, label, 16).toLocaleUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,15}$/.test(text)) throw new Error(`${label} 格式无效`);
  return text;
}

function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
  return value;
}

function stringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} 必须是字符串数组`);
  return [...new Set(value
    .map((item) => item.trim()).filter(Boolean).slice(0, maxItems).map((item) => item.slice(0, maxLength)))];
}

function parseProfile(value: unknown, index: number): StockProfile {
  const item = object(value, `profiles[${index}]`);
  const stockSymbol = symbol(item.symbol, `profiles[${index}].symbol`);
  return {
    symbol: stockSymbol,
    providerSymbol: symbol(item.providerSymbol ?? stockSymbol.replace(".", "-"), `profiles[${index}].providerSymbol`),
    shortName: optionalString(item.shortName, 180),
    longName: optionalString(item.longName, 300),
    exchange: optionalString(item.exchange, 40),
    currency: optionalString(item.currency, 12),
    country: optionalString(item.country, 80),
    sector: optionalString(item.sector, 120),
    industry: optionalString(item.industry, 160),
    website: optionalString(item.website, 500),
    businessSummary: optionalString(item.businessSummary, 5_000),
    marketCap: nonNegativeInteger(item.marketCap, `profiles[${index}].marketCap`),
    averageVolume3m: nonNegativeInteger(item.averageVolume3m, `profiles[${index}].averageVolume3m`),
    aliases: stringArray(item.aliases, `profiles[${index}].aliases`, 30, 160),
    exposureTags: stringArray(item.exposureTags, `profiles[${index}].exposureTags`, 30, 80).map((tag) => tag.toLocaleLowerCase()),
    active: optionalBoolean(item.active, `profiles[${index}].active`, true),
    profileFetchOk: optionalBoolean(item.profileFetchOk, `profiles[${index}].profileFetchOk`, true),
    sourceUpdatedAt: isoTimestamp(item.sourceUpdatedAt, `profiles[${index}].sourceUpdatedAt`),
  };
}

function parsePrice(value: unknown, index: number): StockPriceDaily {
  const item = object(value, `prices[${index}]`);
  const price: StockPriceDaily = {
    symbol: symbol(item.symbol, `prices[${index}].symbol`),
    tradingDate: dateOnly(item.tradingDate, `prices[${index}].tradingDate`),
    open: finiteNumber(item.open, `prices[${index}].open`),
    high: finiteNumber(item.high, `prices[${index}].high`),
    low: finiteNumber(item.low, `prices[${index}].low`),
    close: finiteNumber(item.close, `prices[${index}].close`),
    adjustedClose: finiteNumber(item.adjustedClose, `prices[${index}].adjustedClose`),
    volume: nonNegativeInteger(item.volume, `prices[${index}].volume`),
    dividends: finiteNumber(item.dividends, `prices[${index}].dividends`),
    stockSplits: finiteNumber(item.stockSplits, `prices[${index}].stockSplits`),
    sourceUpdatedAt: isoTimestamp(item.sourceUpdatedAt, `prices[${index}].sourceUpdatedAt`),
  };
  if (price.close === undefined || price.close <= 0) throw new Error(`prices[${index}].close 必须是正数`);
  for (const [field, amount] of Object.entries({
    open: price.open,
    high: price.high,
    low: price.low,
    adjustedClose: price.adjustedClose,
    dividends: price.dividends,
    stockSplits: price.stockSplits,
  })) {
    if (amount !== undefined && amount < 0) throw new Error(`prices[${index}].${field} 不得为负数`);
  }
  return price;
}

function parseRun(value: unknown): StockSyncRun {
  const item = object(value, "run");
  const statuses: StockSyncRun["status"][] = ["running", "success", "partial", "failed"];
  if (!statuses.includes(item.status as StockSyncRun["status"])) throw new Error("run.status 无效");
  const run: StockSyncRun = {
    id: requiredString(item.id, "run.id", 160),
    startedAt: isoTimestamp(item.startedAt, "run.startedAt"),
    completedAt: item.completedAt === null || item.completedAt === undefined ? undefined : isoTimestamp(item.completedAt, "run.completedAt"),
    status: item.status as StockSyncRun["status"],
    sourceVersion: requiredString(item.sourceVersion, "run.sourceVersion", 80),
    errors: stringArray(item.errors, "run.errors", 100, 500),
    profileCount: nonNegativeInteger(item.profileCount, "run.profileCount"),
    priceCount: nonNegativeInteger(item.priceCount, "run.priceCount"),
  };
  if (run.profileCount === undefined || run.priceCount === undefined) throw new Error("run.profileCount 与 run.priceCount 不能为空");
  if (run.status === "running" && run.completedAt) throw new Error("running 状态不得包含 run.completedAt");
  if (run.status !== "running" && !run.completedAt) throw new Error(`${run.status} 状态必须包含 run.completedAt`);
  if (run.completedAt && Date.parse(run.completedAt) < Date.parse(run.startedAt)) throw new Error("run.completedAt 不得早于 run.startedAt");
  return run;
}

export function parseStockSyncPayload(value: unknown): StockSyncPayload {
  const root = object(value, "body");
  if (!Array.isArray(root.profiles) || root.profiles.length > 150) throw new Error("profiles 必须是数组，且每批不得超过 150 项");
  if (!Array.isArray(root.prices) || root.prices.length > 5_000) throw new Error("prices 必须是数组，且每批不得超过 5,000 项");
  const run = parseRun(root.run);
  if (!root.profiles.length && !root.prices.length && run.status !== "failed") throw new Error("只有 failed 运行可以同时省略 profiles 与 prices");
  const profiles = root.profiles.map(parseProfile);
  const prices = root.prices.map(parsePrice);
  if (new Set(profiles.map((profile) => profile.symbol)).size !== profiles.length) throw new Error("profiles 同一批次不得包含重复 symbol");
  if (new Set(prices.map((price) => `${price.symbol}:${price.tradingDate}`)).size !== prices.length) throw new Error("prices 同一批次不得包含重复的 symbol 与 tradingDate");
  if (run.profileCount !== undefined && run.profileCount < profiles.length) throw new Error("run.profileCount 不得小于本批 profiles 数量");
  if (run.priceCount !== undefined && run.priceCount < prices.length) throw new Error("run.priceCount 不得小于本批 prices 数量");
  return {
    run,
    profiles,
    prices,
  };
}
