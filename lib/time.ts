import type { Headline, TimestampKind } from "./types";

const taipeiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function dateParts(value: string): Record<string, string> | null {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return Object.fromEntries(taipeiFormatter.formatToParts(date).map((part) => [part.type, part.value]));
}

export function formatTaipeiMinute(value?: string): string {
  if (!value) return "时间待确认";
  const parts = dateParts(value);
  if (!parts) return "时间待确认";
  return `${parts.year} 年 ${Number(parts.month)} 月 ${Number(parts.day)} 日 ${parts.hour}:${parts.minute}`;
}

export function timestampLabel(kind?: TimestampKind): string {
  return kind === "collected" ? "采集时间" : "新闻发布时间";
}

export function formatTimestampLine(value?: string, kind?: TimestampKind): string {
  return `${timestampLabel(kind)}：${formatTaipeiMinute(value)}（台北时间）`;
}

export function toTaipeiDateTimeInput(value?: string): string {
  if (!value) return "";
  const parts = dateParts(value);
  if (!parts) return "";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function fromTaipeiDateTimeInput(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}:00+08:00`);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function resolveHeadlineTimestamp(headline: Headline): {
  value?: string;
  kind: TimestampKind;
  source?: string;
} {
  if (headline.publishedAt && !Number.isNaN(new Date(headline.publishedAt).valueOf())) {
    return {
      value: headline.publishedAt,
      kind: headline.timestampKind ?? "published",
      source: headline.newsTimeSource ?? headline.sources[0]?.name,
    };
  }

  const source = [...headline.sources]
    .filter((item) => item.publishedAt && !Number.isNaN(new Date(item.publishedAt).valueOf()))
    .sort((left, right) => {
      const kindDifference = Number(left.timestampKind === "collected") - Number(right.timestampKind === "collected");
      return kindDifference || +new Date(right.publishedAt ?? 0) - +new Date(left.publishedAt ?? 0);
    })[0];

  return {
    value: source?.publishedAt,
    kind: source?.timestampKind ?? headline.timestampKind ?? "published",
    source: headline.newsTimeSource ?? source?.name,
  };
}
