import type { CollectorStatus, RawStory, SourceEvidence } from "../types";
import {
  assertEvidenceBoundToSourceCapture,
  createSourceEvidence,
  sha256ExactUtf8,
} from "../source-evidence";
import { ensureRawStoryIdentity } from "../source-identity";
import { parseStrictSourceTimestamp, requireStrictSourceTimestamp } from "../source-time";
import { safeCollectorNote } from "./router";

const CRAWL_SCHEMA = "crawl4ai-collect/v1";
const GOOGLE_NEWS_FEED_NAMESPACE = "https://news.google.com/rss";
const MAX_ARTIFACT_BYTES = 200_000;
const MAX_PAGES = 48;
const MAX_TITLE_QUOTE_CODE_POINTS = 300;
const MAX_LEAD_QUOTE_CODE_POINTS = 600;
const MIN_LEAD_LINE_LENGTH = 80;
const MIN_LEAD_CONTENT_LENGTH = 60;

export interface Crawl4aiPage {
  feedName: string;
  feedUrl: string;
  feedType: "Official" | "News";
  entryTitle: string;
  entryUrl: string;
  entryGuid: string | null;
  entryPublishedAtRaw: string | null;
  requestedUrl: string;
  pageUrl: string;
  httpStatus: number | null;
  collectedAt: string;
  pageTitle: string | null;
  publishedAtMetaRaw: string | null;
  publishedAtMetaField: string | null;
  extractionMethod: string;
  text: string;
  truncated: boolean;
  ok: boolean;
  note: string | null;
}

export interface Crawl4aiCollectDocument {
  schema: typeof CRAWL_SCHEMA;
  collectorVersion: string;
  crawl4aiVersion: string;
  generatedAt: string;
  feedStatuses: Array<{ name: string; url: string; type: string; ok: boolean; entryCount: number; note: string | null }>;
  pages: Crawl4aiPage[];
  note: string | null;
}

export interface Crawl4aiAdapterResult {
  stories: RawStory[];
  status: CollectorStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function nullableString(value: unknown, field: string, maxLength = 4_000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(`${field} must be null or a string of at most ${maxLength} characters`);
  }
  return value.trim() ? value : null;
}

function parsePage(value: unknown, index: number): Crawl4aiPage {
  if (!isRecord(value)) throw new TypeError(`pages[${index}] must be an object`);
  const feedType = value.feedType;
  if (feedType !== "Official" && feedType !== "News") {
    throw new TypeError(`pages[${index}].feedType must be Official or News`);
  }
  const text = typeof value.text === "string" ? value.text : "";
  if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_BYTES) {
    throw new TypeError(`pages[${index}].text exceeds ${MAX_ARTIFACT_BYTES} UTF-8 bytes`);
  }
  return {
    feedName: requiredString(value.feedName, `pages[${index}].feedName`, 160),
    feedUrl: requiredString(value.feedUrl, `pages[${index}].feedUrl`, 1_500),
    feedType,
    entryTitle: requiredString(value.entryTitle, `pages[${index}].entryTitle`, 2_000),
    entryUrl: requiredString(value.entryUrl, `pages[${index}].entryUrl`, 1_500),
    entryGuid: nullableString(value.entryGuid, `pages[${index}].entryGuid`, 1_500),
    entryPublishedAtRaw: nullableString(value.entryPublishedAtRaw, `pages[${index}].entryPublishedAtRaw`, 300),
    requestedUrl: requiredString(value.requestedUrl, `pages[${index}].requestedUrl`, 1_500),
    pageUrl: requiredString(value.pageUrl, `pages[${index}].pageUrl`, 1_500),
    httpStatus: Number.isInteger(value.httpStatus) ? Number(value.httpStatus) : null,
    collectedAt: requiredString(value.collectedAt, `pages[${index}].collectedAt`, 100),
    pageTitle: nullableString(value.pageTitle, `pages[${index}].pageTitle`, 2_000),
    publishedAtMetaRaw: nullableString(value.publishedAtMetaRaw, `pages[${index}].publishedAtMetaRaw`, 300),
    publishedAtMetaField: nullableString(value.publishedAtMetaField, `pages[${index}].publishedAtMetaField`, 120),
    extractionMethod: requiredString(value.extractionMethod, `pages[${index}].extractionMethod`, 160),
    text,
    truncated: Boolean(value.truncated),
    ok: Boolean(value.ok),
    note: nullableString(value.note, `pages[${index}].note`, 500),
  };
}

export function parseCrawl4aiCollectDocument(value: unknown): Crawl4aiCollectDocument {
  if (!isRecord(value)) throw new TypeError("crawl4ai output must be a JSON object");
  if (value.schema !== CRAWL_SCHEMA) throw new TypeError(`crawl4ai output schema must be ${CRAWL_SCHEMA}`);
  const rawPages = Array.isArray(value.pages) ? value.pages : [];
  if (rawPages.length > MAX_PAGES * 4) throw new TypeError(`crawl4ai output lists more than ${MAX_PAGES * 4} pages`);
  return {
    schema: CRAWL_SCHEMA,
    collectorVersion: requiredString(value.collectorVersion, "collectorVersion", 120),
    crawl4aiVersion: requiredString(value.crawl4aiVersion, "crawl4aiVersion", 60),
    generatedAt: requiredString(value.generatedAt, "generatedAt", 100),
    feedStatuses: Array.isArray(value.feedStatuses)
      ? value.feedStatuses.slice(0, 20).flatMap((status) => {
          if (!isRecord(status) || typeof status.name !== "string" || typeof status.url !== "string") return [];
          return [{
            name: status.name.slice(0, 160),
            url: status.url.slice(0, 1_500),
            type: typeof status.type === "string" ? status.type.slice(0, 40) : "",
            ok: Boolean(status.ok),
            entryCount: Math.max(0, Math.min(1_000, Math.trunc(Number(status.entryCount) || 0))),
            note: typeof status.note === "string" && status.note.trim() ? status.note.slice(0, 500) : null,
          }];
        })
      : [],
    pages: rawPages.map(parsePage),
    note: typeof value.note === "string" && value.note.trim() ? value.note.slice(0, 500) : null,
  };
}

function clipCodePoints(value: string, maxCodePoints: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= maxCodePoints ? value : codePoints.slice(0, maxCodePoints).join("");
}

function plainMarkdownText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface ArticleQuotes {
  /** Exact substring of the captured artifact that identifies the headline. */
  title?: string;
  /** Exact substring of the captured artifact holding the first substantial paragraph. */
  lead?: string;
}

/**
 * Picks evidence quotes directly out of the captured artifact, so every quote
 * is an exact substring of the bytes whose hash the capture asserts.
 */
export function pickArticleQuotes(text: string): ArticleQuotes {
  const lines = text.split(/\r?\n/);
  let title: string | undefined;
  let titleLineIndex = -1;
  for (const [index, line] of lines.entries()) {
    const headingMatch = line.match(/^#{1,3}\s+(\S.*)$/);
    const candidate = (headingMatch ? headingMatch[1] : line).trim();
    if (!candidate) continue;
    title = clipCodePoints(candidate, MAX_TITLE_QUOTE_CODE_POINTS);
    titleLineIndex = index;
    break;
  }
  if (!title) return {};

  for (const [index, line] of lines.entries()) {
    if (index === titleLineIndex) continue;
    const trimmed = line.trim();
    if (trimmed.length < MIN_LEAD_LINE_LENGTH || trimmed.startsWith("#")) continue;
    if (plainMarkdownText(trimmed).length < MIN_LEAD_CONTENT_LENGTH) continue;
    const lead = clipCodePoints(trimmed, MAX_LEAD_QUOTE_CODE_POINTS);
    if (lead === title) continue;
    return { title, lead };
  }
  return { title };
}

interface ResolvedPublication {
  originalPublishedAt: string | null;
  publishedAtRaw?: string;
  publishedAtField?: string;
  timestampKind: "published" | "collected";
}

function resolvePublication(page: Crawl4aiPage): ResolvedPublication {
  const metaIso = parseStrictSourceTimestamp(page.publishedAtMetaRaw);
  if (metaIso && page.publishedAtMetaRaw) {
    return {
      originalPublishedAt: metaIso,
      publishedAtRaw: page.publishedAtMetaRaw,
      publishedAtField: page.publishedAtMetaField ?? "meta:published",
      timestampKind: "published",
    };
  }
  const rssIso = parseStrictSourceTimestamp(page.entryPublishedAtRaw);
  if (rssIso && page.entryPublishedAtRaw) {
    return {
      originalPublishedAt: rssIso,
      publishedAtRaw: page.entryPublishedAtRaw,
      publishedAtField: "rss:pubDate",
      timestampKind: "published",
    };
  }
  // An unparseable publisher string is preserved as provenance, but it can
  // never justify classifying collection time as publication time.
  const unparsedRaw = page.publishedAtMetaRaw ?? page.entryPublishedAtRaw ?? undefined;
  return {
    originalPublishedAt: null,
    ...(unparsedRaw ? { publishedAtRaw: unparsedRaw } : {}),
    ...(unparsedRaw && page.publishedAtMetaRaw ? { publishedAtField: page.publishedAtMetaField ?? "meta:published" } : {}),
    ...(unparsedRaw && !page.publishedAtMetaRaw ? { publishedAtField: "rss:pubDate" } : {}),
    timestampKind: "collected",
  };
}

function feedNamespaceFor(feedUrl: string): string {
  try {
    return new URL(feedUrl).hostname.toLowerCase() === "news.google.com" ? GOOGLE_NEWS_FEED_NAMESPACE : feedUrl;
  } catch {
    return feedUrl;
  }
}

function sourceLabelFor(page: Crawl4aiPage): string {
  if (page.feedType === "Official") return page.feedName;
  try {
    return new URL(page.pageUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return page.feedName;
  }
}

/**
 * Converts one crawled article page into an evidence-chain story: an immutable
 * `detail_page` capture of the visible text plus exact `html_text_quote`
 * evidence for the headline and lead paragraph. Every field the server later
 * re-verifies (identity, hashes, quote occurrence) is produced by the same
 * library code the server runs, so a story that fails those checks here is
 * dropped instead of shipped.
 */
export function storyFromCrawl4aiPage(page: Crawl4aiPage, extractorVersion: string): RawStory {
  if (!page.ok) throw new TypeError("page was not collected successfully");
  const collectedAt = requireStrictSourceTimestamp(page.collectedAt, "page collectedAt");
  const quotes = pickArticleQuotes(page.text);
  if (!quotes.title) throw new TypeError("captured text does not contain a quotable headline line");
  const publication = resolvePublication(page);

  const identified = ensureRawStoryIdentity({
    id: page.pageUrl,
    ...(page.entryGuid ? { nativeId: page.entryGuid } : {}),
    ...(page.entryGuid ? { feedNamespace: feedNamespaceFor(page.feedUrl) } : {}),
    title: clipCodePoints(page.entryTitle || page.pageTitle || plainMarkdownText(quotes.title), 300),
    originalTitle: clipCodePoints(page.entryTitle || page.pageTitle || plainMarkdownText(quotes.title), 300),
    description: quotes.lead ? clipCodePoints(plainMarkdownText(quotes.lead), 600) : "",
    originalDescription: quotes.lead ? clipCodePoints(plainMarkdownText(quotes.lead), 600) : "",
    url: page.pageUrl,
    publishedAt: publication.originalPublishedAt ?? collectedAt,
    originalPublishedAt: publication.originalPublishedAt,
    ...(publication.publishedAtRaw ? { publishedAtRaw: publication.publishedAtRaw } : {}),
    ...(publication.publishedAtField ? { publishedAtField: publication.publishedAtField } : {}),
    source: sourceLabelFor(page),
    sourceType: page.feedType,
    engagement: 0,
    collectedAt,
    firstCollectedAt: collectedAt,
    lastCollectedAt: collectedAt,
    timestampKind: publication.timestampKind,
    capture: {
      rawUrl: page.pageUrl,
      feedUrl: page.feedUrl,
      mimeType: "text/html",
      ...(page.httpStatus === null ? {} : { httpStatus: page.httpStatus }),
      originalPublishedAt: publication.originalPublishedAt,
      ...(publication.publishedAtRaw ? { publishedAtRaw: publication.publishedAtRaw } : {}),
      ...(publication.publishedAtField ? { publishedAtField: publication.publishedAtField } : {}),
      collectedAt,
      scope: "detail_page",
      capturedContentHash: sha256ExactUtf8(page.text),
      capturedArtifact: page.text,
      capturedArtifactEncoding: "utf8",
      capturedArtifactSizeBytes: Buffer.byteLength(page.text, "utf8"),
      capturedTextHash: sha256ExactUtf8(page.text),
      extractionMethod: page.extractionMethod,
      extractorVersion,
      backfillQuality: "native",
    },
  });
  const sourceDocumentId = identified.sourceDocumentId;
  if (!sourceDocumentId) throw new TypeError("A source document ID is required before evidence can be created");

  const common = {
    sourceDocumentId,
    captureScope: "detail_page",
    extractionMethod: page.extractionMethod,
    extractorVersion,
    capturedAt: collectedAt,
  } as const;
  const evidence: SourceEvidence[] = [createSourceEvidence({
    ...common,
    anchorKey: "article:title",
    quoteOriginal: quotes.title,
    quoteLanguage: "und",
    locator: { kind: "html_text_quote", pageUrl: page.pageUrl, textQuote: { exact: quotes.title } },
    locatorStatus: "exact",
    directness: "direct",
  })];
  evidence.push(quotes.lead ? createSourceEvidence({
    ...common,
    anchorKey: "article:lead",
    quoteOriginal: quotes.lead,
    quoteLanguage: "und",
    locator: { kind: "html_text_quote", pageUrl: page.pageUrl, textQuote: { exact: quotes.lead } },
    locatorStatus: "exact",
    directness: "direct",
  }) : createSourceEvidence({
    ...common,
    anchorKey: "article:lead",
    locator: {
      kind: "unavailable",
      reasonCode: "content_not_extracted",
      detail: "The captured page text has no substantial lead paragraph to quote.",
    },
    locatorStatus: "unavailable",
    directness: "unavailable",
  }));

  const story = ensureRawStoryIdentity({ ...identified, evidence });
  assertEvidenceBoundToSourceCapture(story, story.capture!);
  return story;
}

/**
 * Adapts a `crawl4ai-collect/v1` document into evidence-chain stories. Each
 * page is converted fail-closed and independently: a page whose capture cannot
 * be proven is dropped and reported in the collector status, never downgraded
 * to unverifiable metadata.
 */
export function adaptCrawl4aiCollectOutput(value: unknown): Crawl4aiAdapterResult {
  let document: Crawl4aiCollectDocument;
  try {
    document = parseCrawl4aiCollectDocument(value);
  } catch (error) {
    return {
      stories: [],
      status: {
        name: "News 全文",
        channel: "News",
        backend: "crawl4ai",
        ok: false,
        count: 0,
        note: safeCollectorNote(error),
      },
    };
  }

  const extractorVersion = `${document.collectorVersion}+crawl4ai-${document.crawl4aiVersion}`;
  const stories: RawStory[] = [];
  const dropNotes: string[] = [];
  const skipReasons = new Map<string, number>();
  for (const page of document.pages.slice(0, MAX_PAGES)) {
    if (!page.ok) {
      const reason = page.note ?? "采集失败";
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      continue;
    }
    try {
      stories.push(storyFromCrawl4aiPage(page, extractorVersion));
    } catch (error) {
      dropNotes.push(`${sourceLabelFor(page)}：${safeCollectorNote(error)}`);
    }
  }

  const skipped = [...skipReasons.values()].reduce((total, count) => total + count, 0);
  const topSkipReasons = [...skipReasons.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, 2)
    .map(([reason, count]) => `${count}×${reason.slice(0, 60)}`)
    .join("、");
  const noteParts: string[] = [];
  if (document.note) noteParts.push(document.note);
  if (skipped) noteParts.push(`${skipped} 页在采集端未成功（${topSkipReasons}）`);
  if (dropNotes.length) noteParts.push(`丢弃 ${dropNotes.length} 页：${dropNotes.slice(0, 3).join("；")}`);
  return {
    stories,
    status: {
      name: "News 全文",
      channel: "News",
      backend: "crawl4ai",
      ok: stories.length > 0,
      count: stories.length,
      lastSuccessAt: stories.length > 0 ? document.generatedAt : undefined,
      note: noteParts.length ? noteParts.join("；").slice(0, 240) : undefined,
    },
  };
}

/** Status used when the workflow produced no crawl4ai output file at all. */
export function missingCrawl4aiStatus(outputPath: string): CollectorStatus {
  return {
    name: "News 全文",
    channel: "News",
    backend: "crawl4ai",
    ok: false,
    count: 0,
    note: `未找到 crawl4ai 输出文件 ${outputPath}，本轮日报仅使用 RSS 与社群来源`.slice(0, 240),
  };
}
