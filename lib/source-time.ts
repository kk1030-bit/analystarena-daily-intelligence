const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/i;
const RFC_2822_TIMESTAMP_WITH_ZONE = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(UT|UTC|GMT|[+-]\d{4})$/i;

const MONTHS = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
]);

const WEEKDAYS = new Map([
  ["sun", 0], ["mon", 1], ["tue", 2], ["wed", 3], ["thu", 4], ["fri", 5], ["sat", 6],
]);

const NAMED_ZONE_OFFSET_MINUTES = new Map([
  ["ut", 0], ["utc", 0], ["gmt", 0],
]);

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validCalendarParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return year >= 1000
    && year <= 9999
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month)
    && hour >= 0
    && hour <= 23
    && minute >= 0
    && minute <= 59
    && second >= 0
    && second <= 59;
}

function numericZoneOffsetMinutes(value: string): number | null {
  if (/^z$/i.test(value)) return 0;
  const match = value.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return NAMED_ZONE_OFFSET_MINUTES.get(value.toLowerCase()) ?? null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  const magnitude = hours * 60 + minutes;
  return match[1] === "+" ? magnitude : -magnitude;
}

function isoTimestamp(value: string): string | null {
  const match = value.match(ISO_TIMESTAMP_WITH_ZONE);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", fraction = "", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!validCalendarParts(year, month, day, hour, minute, second)) return null;
  const offsetMinutes = numericZoneOffsetMinutes(zone);
  if (offsetMinutes === null) return null;
  const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offsetMinutes * 60_000;
  const result = new Date(epoch);
  return Number.isFinite(result.valueOf()) ? result.toISOString() : null;
}

function rfc2822Timestamp(value: string): string | null {
  const match = value.match(RFC_2822_TIMESTAMP_WITH_ZONE);
  if (!match) return null;
  const [, weekdayText, dayText, monthText, yearText, hourText, minuteText, secondText = "0", zone] = match;
  const year = Number(yearText);
  const month = MONTHS.get(monthText.toLowerCase());
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!month || !validCalendarParts(year, month, day, hour, minute, second)) return null;
  const offsetMinutes = numericZoneOffsetMinutes(zone);
  if (offsetMinutes === null) return null;
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second);
  if (weekdayText && WEEKDAYS.get(weekdayText.toLowerCase()) !== new Date(localEpoch).getUTCDay()) return null;
  const result = new Date(localEpoch - offsetMinutes * 60_000);
  return Number.isFinite(result.valueOf()) ? result.toISOString() : null;
}

/**
 * Parses only complete source timestamps with an explicit numeric UTC offset,
 * Z, UT, UTC or GMT. Ambiguous abbreviations such as CST, missing zones and
 * calendar-normalized values such as February 30 are rejected.
 */
export function parseStrictSourceTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isoTimestamp(trimmed) ?? rfc2822Timestamp(trimmed);
}

/** Requires a precise timestamp and returns its canonical ISO-8601 UTC representation. */
export function requireStrictSourceTimestamp(value: string, fieldName = "timestamp"): string {
  const parsed = parseStrictSourceTimestamp(value);
  if (!parsed) throw new TypeError(`Invalid ${fieldName}; an explicit timezone and valid calendar timestamp are required: ${value}`);
  return parsed;
}

/**
 * Validates the publisher's preserved timestamp text against the canonical
 * publication instant. An unparseable raw value may be retained as evidence,
 * but it can never justify classifying collection time as publication time.
 */
export function assertPublishedAtRawConsistency(
  publishedAtRaw: string | null | undefined,
  originalPublishedAt: string | null,
  timestampKind: "published" | "collected",
): void {
  const raw = publishedAtRaw?.trim();
  if (!raw) return;
  const parsedRaw = parseStrictSourceTimestamp(raw);
  if (parsedRaw === null) {
    if (timestampKind === "published") {
      throw new TypeError("Unparseable publishedAtRaw cannot be classified as a published timestamp");
    }
    return;
  }
  const canonicalOriginal = parseStrictSourceTimestamp(originalPublishedAt);
  if (parsedRaw !== canonicalOriginal) {
    throw new TypeError("Strictly parsed publishedAtRaw must exactly match originalPublishedAt");
  }
}
