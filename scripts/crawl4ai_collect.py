"""Collect full-text article pages for the daily brief with crawl4ai.

This script runs in GitHub Actions before scripts/run-daily.ts. It re-reads the
same Official/News RSS feeds the server uses, follows each entry to the
publisher's article page with crawl4ai, and writes a `crawl4ai-collect/v1`
JSON document. The TypeScript adapter (lib/collectors/crawl4ai.ts) converts
that document into evidence-chain stories; this script never fabricates
timestamps, quotes, or identity fields — it only reports what it observed.

The script always exits 0 and always writes an output file, so a crawl failure
degrades the daily brief back to feed-level collection instead of blocking it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ElementTree
from datetime import datetime, timezone

COLLECTOR_VERSION = "crawl4ai-detail/v1"
GOOGLE_NEWS_FEED_NAMESPACE = "https://news.google.com/rss"
FEED_FETCH_TIMEOUT_SECONDS = 20
PAGE_TIMEOUT_MS = 25_000
CRAWL_CONCURRENCY = 4
CRAWL_DEADLINE_SECONDS = 360
MAX_TEXT_BYTES = 200_000
MIN_TEXT_BYTES = 400
GLOBAL_PAGE_BUDGET = 30

# Mirrors the Official/News feeds in lib/pipeline.ts. URLs must stay byte-equal
# to the pipeline list because non-Google feed URLs act as identity namespaces.
FEEDS = [
    {
        "name": "Federal Reserve",
        "url": "https://www.federalreserve.gov/feeds/press_all.xml",
        "type": "Official",
        "entry_cap": 8,
    },
    {
        "name": "SEC",
        "url": "https://www.sec.gov/news/pressreleases.rss",
        "type": "Official",
        "entry_cap": 8,
    },
    {
        "name": "Google News · 市场焦点",
        "url": "https://news.google.com/rss/search?q=(Nvidia%20OR%20OpenAI%20OR%20Anthropic%20OR%20semiconductor)%20markets&hl=en-US&gl=US&ceid=US:en",
        "type": "News",
        "entry_cap": 6,
    },
    {
        "name": "Google News · 宏观与资金流",
        "url": "https://news.google.com/rss/search?q=(FOMC%20OR%20inflation%20OR%20earnings%20OR%20ETF)%20markets&hl=en-US&gl=US&ceid=US:en",
        "type": "News",
        "entry_cap": 6,
    },
    {
        "name": "Google News · 巨头动态",
        "url": "https://news.google.com/rss/search?q=(Tesla%20OR%20Microsoft%20OR%20Google%20OR%20Amazon%20OR%20TSMC)%20(stock%20OR%20market)&hl=en-US&gl=US&ceid=US:en",
        "type": "News",
        "entry_cap": 6,
    },
]

INTERSTITIAL_HOSTS = {
    "news.google.com",
    "consent.google.com",
    "www.google.com",
    "google.com",
    "accounts.google.com",
}

PUBLISHED_META_PATTERNS = [
    (
        "meta:article:published_time",
        re.compile(
            r"<meta[^>]+(?:property|name)\s*=\s*[\"'](?:og:)?article:published_time[\"'][^>]*content\s*=\s*[\"']([^\"']+)[\"']",
            re.IGNORECASE,
        ),
    ),
    (
        "meta:article:published_time",
        re.compile(
            r"<meta[^>]+content\s*=\s*[\"']([^\"']+)[\"'][^>]*(?:property|name)\s*=\s*[\"'](?:og:)?article:published_time[\"']",
            re.IGNORECASE,
        ),
    ),
    (
        "json-ld:datePublished",
        re.compile(r"\"datePublished\"\s*:\s*\"([^\"]+)\"", re.IGNORECASE),
    ),
    (
        "meta:datePublished",
        re.compile(
            r"<meta[^>]+(?:property|name|itemprop)\s*=\s*[\"']datePublished[\"'][^>]*content\s*=\s*[\"']([^\"']+)[\"']",
            re.IGNORECASE,
        ),
    ),
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def safe_note(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text[:240] or "collection failed"


def element_text(parent: ElementTree.Element, *names: str) -> str:
    for name in names:
        node = parent.find(name)
        if node is not None and node.text:
            return node.text.strip()
    return ""


def fetch_feed_entries(feed: dict) -> tuple[list[dict], str | None]:
    """Reads one RSS 2.0 feed with stdlib only. Returns (entries, error_note)."""
    request = urllib.request.Request(
        feed["url"],
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
            "Accept": "application/rss+xml, application/xml, text/xml",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=FEED_FETCH_TIMEOUT_SECONDS) as response:
            raw = response.read(2_000_000)
        root = ElementTree.fromstring(raw)
    except Exception as error:  # noqa: BLE001 - a feed failure must not stop the run
        return [], safe_note(error)

    entries: list[dict] = []
    for item in root.iterfind("./channel/item"):
        title = element_text(item, "title")
        link = element_text(item, "link")
        if not title or not link.startswith("http"):
            continue
        guid = element_text(item, "guid")
        pub_date = element_text(item, "pubDate", "date")
        entries.append(
            {
                "title": title,
                "url": link,
                "guid": guid or None,
                "publishedAtRaw": pub_date or None,
            }
        )
        if len(entries) >= feed["entry_cap"]:
            break
    return entries, None


def extract_published_meta(html: str) -> tuple[str | None, str | None]:
    head = html[:300_000]
    for field, pattern in PUBLISHED_META_PATTERNS:
        match = pattern.search(head)
        if match:
            value = match.group(1).strip()
            if value:
                return value, field
    return None, None


def truncate_utf8(text: str, max_bytes: int) -> tuple[str, bool]:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text, False
    clipped = encoded[:max_bytes]
    # Never split a UTF-8 sequence: decode ignoring the trailing partial bytes.
    return clipped.decode("utf-8", errors="ignore"), True


def page_hostname(url: str) -> str:
    match = re.match(r"https?://([^/]+)", url, re.IGNORECASE)
    return (match.group(1) if match else "").lower()


def markdown_from_result(result: object) -> tuple[str, str]:
    """Returns (text, extraction_method) from a crawl4ai result across versions."""
    markdown = getattr(result, "markdown", None)
    fit = getattr(markdown, "fit_markdown", None)
    if isinstance(fit, str) and len(fit.strip()) >= 200:
        return fit, "crawl4ai:fit_markdown"
    raw = getattr(markdown, "raw_markdown", None)
    if isinstance(raw, str) and raw.strip():
        return raw, "crawl4ai:raw_markdown"
    if isinstance(markdown, str):
        return markdown, "crawl4ai:markdown"
    return "", "crawl4ai:markdown"


async def crawl_targets(targets: list[dict]) -> list[dict]:
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig

    markdown_generator = None
    try:
        from crawl4ai import DefaultMarkdownGenerator, PruningContentFilter

        markdown_generator = DefaultMarkdownGenerator(content_filter=PruningContentFilter())
    except Exception:  # noqa: BLE001 - raw markdown remains a valid capture
        markdown_generator = None

    run_config_kwargs = {
        "cache_mode": CacheMode.BYPASS,
        "page_timeout": PAGE_TIMEOUT_MS,
        "wait_until": "domcontentloaded",
        "check_robots_txt": True,
    }
    if markdown_generator is not None:
        run_config_kwargs["markdown_generator"] = markdown_generator
    run_config = CrawlerRunConfig(**run_config_kwargs)

    pages: list[dict] = []
    started = asyncio.get_event_loop().time()
    async with AsyncWebCrawler(config=BrowserConfig(headless=True, text_mode=True)) as crawler:
        for offset in range(0, len(targets), CRAWL_CONCURRENCY):
            if asyncio.get_event_loop().time() - started > CRAWL_DEADLINE_SECONDS:
                for target in targets[offset:]:
                    pages.append(page_record(target, ok=False, note="crawl deadline reached before this page"))
                break
            chunk = targets[offset : offset + CRAWL_CONCURRENCY]
            results = await asyncio.gather(
                *(crawl_one(crawler, run_config, target) for target in chunk),
                return_exceptions=True,
            )
            for target, outcome in zip(chunk, results):
                if isinstance(outcome, Exception):
                    pages.append(page_record(target, ok=False, note=safe_note(outcome)))
                else:
                    pages.append(outcome)
    return pages


def page_record(
    target: dict,
    *,
    ok: bool,
    note: str | None = None,
    page_url: str | None = None,
    http_status: int | None = None,
    page_title: str | None = None,
    published_meta_raw: str | None = None,
    published_meta_field: str | None = None,
    text: str = "",
    truncated: bool = False,
    extraction_method: str = "crawl4ai:markdown",
) -> dict:
    return {
        "feedName": target["feedName"],
        "feedUrl": target["feedUrl"],
        "feedType": target["feedType"],
        "entryTitle": target["entryTitle"],
        "entryUrl": target["entryUrl"],
        "entryGuid": target["entryGuid"],
        "entryPublishedAtRaw": target["entryPublishedAtRaw"],
        "requestedUrl": target["entryUrl"],
        "pageUrl": page_url or target["entryUrl"],
        "httpStatus": http_status,
        "collectedAt": utc_now_iso(),
        "pageTitle": page_title,
        "publishedAtMetaRaw": published_meta_raw,
        "publishedAtMetaField": published_meta_field,
        "extractionMethod": extraction_method,
        "text": text,
        "textSizeBytes": len(text.encode("utf-8")),
        "truncated": truncated,
        "ok": ok,
        "note": note,
    }


async def crawl_one(crawler: object, run_config: object, target: dict) -> dict:
    result = await crawler.arun(url=target["entryUrl"], config=run_config)
    final_url = getattr(result, "redirected_url", None) or getattr(result, "url", target["entryUrl"])
    http_status = getattr(result, "status_code", None)
    if not getattr(result, "success", False):
        return page_record(
            target,
            ok=False,
            page_url=final_url,
            http_status=http_status,
            note=safe_note(getattr(result, "error_message", "crawl was not successful")),
        )
    host = page_hostname(final_url)
    if host in INTERSTITIAL_HOSTS:
        return page_record(
            target,
            ok=False,
            page_url=final_url,
            http_status=http_status,
            note=f"landed on interstitial host {host}",
        )
    if http_status is not None and http_status != 200:
        return page_record(
            target,
            ok=False,
            page_url=final_url,
            http_status=http_status,
            note=f"publisher returned HTTP {http_status}",
        )

    text, extraction_method = markdown_from_result(result)
    text, truncated = truncate_utf8(text, MAX_TEXT_BYTES)
    if len(text.encode("utf-8")) < MIN_TEXT_BYTES:
        return page_record(
            target,
            ok=False,
            page_url=final_url,
            http_status=http_status,
            extraction_method=extraction_method,
            note="extracted visible text is too short to be an article capture",
        )

    html = getattr(result, "html", "") or ""
    published_meta_raw, published_meta_field = extract_published_meta(html)
    metadata = getattr(result, "metadata", None) or {}
    page_title = metadata.get("title") if isinstance(metadata, dict) else None

    return page_record(
        target,
        ok=True,
        page_url=final_url,
        http_status=http_status,
        page_title=page_title.strip() if isinstance(page_title, str) and page_title.strip() else None,
        published_meta_raw=published_meta_raw,
        published_meta_field=published_meta_field,
        text=text,
        truncated=truncated,
        extraction_method=extraction_method + (":head200k" if truncated else ""),
    )


def crawl4ai_version() -> str:
    # crawl4ai exposes __version__ as a module in some releases, so the
    # installed distribution metadata is the reliable version source.
    try:
        from importlib.metadata import version

        return version("crawl4ai")[:60]
    except Exception:  # noqa: BLE001
        return "unavailable"


def build_targets(feed_statuses: list[dict]) -> list[dict]:
    targets: list[dict] = []
    seen_urls: set[str] = set()
    for feed in FEEDS:
        entries, error = fetch_feed_entries(feed)
        feed_statuses.append(
            {
                "name": feed["name"],
                "url": feed["url"],
                "type": feed["type"],
                "ok": bool(entries),
                "entryCount": len(entries),
                "note": error,
            }
        )
        for entry in entries:
            if entry["url"] in seen_urls:
                continue
            seen_urls.add(entry["url"])
            targets.append(
                {
                    "feedName": feed["name"],
                    "feedUrl": feed["url"],
                    "feedType": feed["type"],
                    "entryTitle": entry["title"],
                    "entryUrl": entry["url"],
                    "entryGuid": entry["guid"],
                    "entryPublishedAtRaw": entry["publishedAtRaw"],
                }
            )
    return targets[:GLOBAL_PAGE_BUDGET]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="crawl-results.json", help="Path of the crawl4ai-collect/v1 JSON output")
    arguments = parser.parse_args()

    document = {
        "schema": "crawl4ai-collect/v1",
        "collectorVersion": COLLECTOR_VERSION,
        "crawl4aiVersion": crawl4ai_version(),
        "generatedAt": utc_now_iso(),
        "feedStatuses": [],
        "pages": [],
        "note": None,
    }
    try:
        targets = build_targets(document["feedStatuses"])
        if targets:
            document["pages"] = asyncio.run(crawl_targets(targets))
        else:
            document["note"] = "no feed entries were available to crawl"
    except Exception as error:  # noqa: BLE001 - the daily brief must still run without detail pages
        document["note"] = safe_note(error)

    with open(arguments.output, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False)

    collected = sum(1 for page in document["pages"] if page["ok"])
    print(
        f"crawl4ai collected {collected}/{len(document['pages'])} article pages "
        f"from {sum(1 for status in document['feedStatuses'] if status['ok'])}/{len(document['feedStatuses'])} feeds"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
