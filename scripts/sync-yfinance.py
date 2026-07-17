#!/usr/bin/env python3
"""Synchronize a curated US-stock universe from yfinance.

The script deliberately keeps Yahoo access outside the web process. It can write
one JSON seed file for development, POST idempotent batches to the protected
Render route, or do both in the same run.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, TypeVar
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pandas as pd
import yfinance as yf


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UNIVERSE = ROOT / "data" / "us-stock-universe.csv"
DEFAULT_CACHE = ROOT / ".cache" / "yfinance"
SOURCE_VERSION = f"yfinance-{yf.__version__}"
T = TypeVar("T")

# Normalize high-level signals to the vocabulary consumed by the news-impact
# engine. More specific curated tags are retained in lowercase as useful
# secondary facets.
EXPOSURE_TAG_ALIASES = {
    "foundry": "semiconductor_foundry",
    "semiconductor_ip": "semiconductor",
    "semiconductor_software": "semiconductor",
    "ev": "electric_vehicle",
    "energy_producer": "oil_producer",
    "banking": "bank",
    "global_banking": "bank",
    "investment_banking": "bank",
    "brokerage": "broker",
    "crypto_exchange": "exchange",
    "health_insurance": "healthcare",
    "healthcare_services": "healthcare",
    "life_sciences": "biotech",
    "biotech_tools": "biotech",
    "consumer_hardware": "consumer",
    "consumer_discretionary": "consumer",
    "consumer_staples": "consumer",
    "retail": "consumer",
    "restaurants": "consumer",
    "travel": "consumer",
    "media": "consumer",
    "streaming": "consumer",
}


@dataclass(frozen=True)
class UniverseEntry:
    symbol: str
    provider_symbol: str
    aliases: tuple[str, ...]
    exposure_tags: tuple[str, ...]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def split_pipe(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(dict.fromkeys(part.strip() for part in value.split("|") if part.strip()))


def load_universe(path: Path, selected: set[str] | None) -> list[UniverseEntry]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    entries: list[UniverseEntry] = []
    seen: set[str] = set()
    for row in rows:
        symbol = (row.get("symbol") or "").strip().upper()
        provider_symbol = (row.get("provider_symbol") or symbol).strip().upper()
        if not symbol or symbol in seen:
            continue
        if selected and symbol not in selected and provider_symbol not in selected:
            continue
        aliases = split_pipe(row.get("aliases"))
        tags = tuple(
            dict.fromkeys(
                EXPOSURE_TAG_ALIASES.get(tag.lower(), tag.lower())
                for tag in split_pipe(row.get("exposure_tags"))
            )
        )
        entries.append(UniverseEntry(symbol, provider_symbol, aliases, tags))
        seen.add(symbol)

    if not entries:
        raise ValueError(f"No symbols found in universe file: {path}")
    return entries


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def finite_int(value: Any) -> int | None:
    number = finite_number(value)
    if number is None:
        return None
    return int(number)


def compact_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split()).strip()
    if not text:
        return None
    return text if len(text) <= limit else f"{text[: limit - 1].rstrip()}…"


def retry(
    label: str,
    operation: Callable[[], T],
    attempts: int,
    base_delay: float = 1.0,
) -> T:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except Exception as exc:  # Network/client errors vary across yfinance releases.
            last_error = exc
            if attempt == attempts:
                break
            delay = base_delay * (2 ** (attempt - 1)) + random.uniform(0.05, 0.35)
            log(f"{label}: attempt {attempt}/{attempts} failed; retrying in {delay:.1f}s ({exc})")
            time.sleep(delay)
    assert last_error is not None
    raise last_error


def chunks(items: list[T], size: int) -> Iterable[list[T]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


def download_history(provider_symbols: list[str], attempts: int) -> pd.DataFrame:
    return retry(
        f"daily prices for {len(provider_symbols)} symbols",
        lambda: yf.download(
            tickers=provider_symbols,
            period="3mo",
            interval="1d",
            group_by="ticker",
            auto_adjust=False,
            actions=True,
            threads=True,
            progress=False,
            timeout=25,
        ),
        attempts,
    )


def frame_for_symbol(history: pd.DataFrame, provider_symbol: str) -> pd.DataFrame:
    if history.empty:
        return pd.DataFrame()
    if not isinstance(history.columns, pd.MultiIndex):
        return history.copy()

    level_zero = {str(value).upper(): value for value in history.columns.get_level_values(0).unique()}
    level_one = {str(value).upper(): value for value in history.columns.get_level_values(1).unique()}
    key = provider_symbol.upper()
    if key in level_zero:
        return history[level_zero[key]].copy()
    if key in level_one:
        return history.xs(level_one[key], axis=1, level=1).copy()
    return pd.DataFrame()


def row_value(row: pd.Series, *names: str) -> Any:
    normalized = {str(column).lower().replace(" ", ""): column for column in row.index}
    for name in names:
        key = name.lower().replace(" ", "")
        if key in normalized:
            return row[normalized[key]]
    return None


def prices_from_frame(entry: UniverseEntry, frame: pd.DataFrame, source_updated_at: str) -> list[dict[str, Any]]:
    if frame.empty:
        return []
    output: list[dict[str, Any]] = []
    for index, row in frame.sort_index().iterrows():
        close = finite_number(row_value(row, "Close"))
        if close is None:
            continue
        timestamp = pd.Timestamp(index)
        output.append(
            {
                "symbol": entry.symbol,
                "tradingDate": timestamp.date().isoformat(),
                "open": finite_number(row_value(row, "Open")),
                "high": finite_number(row_value(row, "High")),
                "low": finite_number(row_value(row, "Low")),
                "close": close,
                "adjustedClose": finite_number(row_value(row, "Adj Close", "Adjusted Close")) or close,
                "volume": finite_int(row_value(row, "Volume")),
                "dividends": finite_number(row_value(row, "Dividends")) or 0.0,
                "stockSplits": finite_number(row_value(row, "Stock Splits")) or 0.0,
                "sourceUpdatedAt": source_updated_at,
            }
        )
    return output


def fetch_prices(
    entries: list[UniverseEntry],
    download_batch_size: int,
    attempts: int,
    source_updated_at: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    prices: list[dict[str, Any]] = []
    errors: list[str] = []
    for batch in chunks(entries, download_batch_size):
        provider_symbols = [entry.provider_symbol for entry in batch]
        try:
            history = download_history(provider_symbols, attempts)
        except Exception as exc:
            log(
                f"price batch {','.join(provider_symbols)} failed; "
                f"falling back to individual downloads ({type(exc).__name__}: {exc})"
            )
            history = pd.DataFrame()

        for entry in batch:
            frame = frame_for_symbol(history, entry.provider_symbol)
            rows = prices_from_frame(entry, frame, source_updated_at)
            single_error: Exception | None = None
            if not rows:
                try:
                    single = download_history([entry.provider_symbol], attempts)
                    rows = prices_from_frame(entry, frame_for_symbol(single, entry.provider_symbol), source_updated_at)
                except Exception as exc:
                    single_error = exc
            if rows:
                prices.extend(rows)
            else:
                detail = (
                    f"{type(single_error).__name__}: {single_error}"
                    if single_error
                    else "no daily rows returned"
                )
                errors.append(f"prices {entry.symbol}: {detail}")
    return prices, errors


def fetch_profile(entry: UniverseEntry, attempts: int, source_updated_at: str) -> dict[str, Any]:
    info = retry(
        f"profile {entry.symbol}",
        lambda: yf.Ticker(entry.provider_symbol).get_info(),
        attempts,
        base_delay=0.8,
    )
    if not isinstance(info, dict):
        info = {}
    if not compact_text(info.get("shortName") or info.get("longName"), 300):
        raise RuntimeError("Yahoo profile response did not include a company name")

    short_name = compact_text(info.get("shortName"), 180) or (entry.aliases[0] if entry.aliases else entry.symbol)
    long_name = compact_text(info.get("longName"), 240) or short_name
    aliases = list(dict.fromkeys([entry.symbol, entry.provider_symbol, *entry.aliases, short_name, long_name]))
    return {
        "symbol": entry.symbol,
        "providerSymbol": entry.provider_symbol,
        "shortName": short_name,
        "longName": long_name,
        "exchange": compact_text(info.get("fullExchangeName") or info.get("exchange"), 120),
        "currency": compact_text(info.get("currency"), 16) or "USD",
        "country": compact_text(info.get("country"), 100),
        "sector": compact_text(info.get("sector"), 160),
        "industry": compact_text(info.get("industry"), 180),
        "website": compact_text(info.get("website"), 500),
        "businessSummary": compact_text(info.get("longBusinessSummary"), 1800),
        "marketCap": finite_int(info.get("marketCap")),
        "averageVolume3m": finite_int(info.get("averageVolume") or info.get("averageDailyVolume3Month")),
        "aliases": aliases,
        "exposureTags": list(entry.exposure_tags),
        "active": True,
        "profileFetchOk": True,
        "sourceUpdatedAt": source_updated_at,
    }


def fallback_profile(entry: UniverseEntry, source_updated_at: str) -> dict[str, Any]:
    return {
        "symbol": entry.symbol,
        "providerSymbol": entry.provider_symbol,
        "shortName": None,
        "longName": None,
        "exchange": None,
        "currency": "USD",
        "country": None,
        "sector": None,
        "industry": None,
        "website": None,
        "businessSummary": None,
        "marketCap": None,
        "averageVolume3m": None,
        "aliases": list(dict.fromkeys([entry.symbol, entry.provider_symbol, *entry.aliases])),
        "exposureTags": list(entry.exposure_tags),
        "active": True,
        "profileFetchOk": False,
        "sourceUpdatedAt": source_updated_at,
    }


def fetch_profiles(
    entries: list[UniverseEntry],
    attempts: int,
    profile_delay: float,
    source_updated_at: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    profiles: list[dict[str, Any]] = []
    errors: list[str] = []
    for position, entry in enumerate(entries, start=1):
        log(f"profile {position}/{len(entries)}: {entry.symbol}")
        try:
            profiles.append(fetch_profile(entry, attempts, source_updated_at))
        except Exception as exc:
            errors.append(f"profile {entry.symbol}: {type(exc).__name__}: {exc}")
            profiles.append(fallback_profile(entry, source_updated_at))
        if position < len(entries) and profile_delay > 0:
            time.sleep(profile_delay + random.uniform(0.0, min(0.2, profile_delay)))
    return profiles, errors


def post_json(endpoint: str, token: str, payload: dict[str, Any], attempts: int) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def send() -> dict[str, Any]:
        request = Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": f"AnalystArena-stock-sync/{SOURCE_VERSION}",
            },
        )
        try:
            with urlopen(request, timeout=60) as response:
                response_body = response.read().decode("utf-8", errors="replace")
                if not 200 <= response.status < 300:
                    raise RuntimeError(f"HTTP {response.status}: {response_body[:500]}")
                try:
                    result = json.loads(response_body)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"sync endpoint returned invalid JSON: {response_body[:500]}") from exc
                if not isinstance(result, dict) or result.get("ok") is not True:
                    raise RuntimeError(f"sync endpoint did not confirm success: {response_body[:500]}")
                expected_run_id = payload.get("run", {}).get("id")
                if result.get("runId") != expected_run_id:
                    raise RuntimeError(
                        f"sync endpoint run mismatch: expected {expected_run_id!r}, got {result.get('runId')!r}"
                    )
                if result.get("storageMode") != "postgres":
                    raise RuntimeError("sync endpoint did not persist to PostgreSQL")
                saved = result.get("saved")
                expected_profiles = len(payload.get("profiles", []))
                expected_prices = len(payload.get("prices", []))
                if not isinstance(saved, dict) or saved.get("profiles") != expected_profiles or saved.get("prices") != expected_prices:
                    raise RuntimeError(
                        "sync endpoint count mismatch: "
                        f"expected profiles={expected_profiles}, prices={expected_prices}; got {saved!r}"
                    )
                return result
        except HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {response_body[:500]}") from exc
        except URLError as exc:
            raise RuntimeError(f"network error: {exc.reason}") from exc

    return retry("stock sync POST", send, attempts, base_delay=2.0)


def write_seed(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--universe", type=Path, default=DEFAULT_UNIVERSE)
    parser.add_argument("--symbols", help="Optional comma-separated canonical/provider symbols")
    parser.add_argument("--output", type=Path, help="Optional full JSON seed output path")
    parser.add_argument("--endpoint", default=os.environ.get("STOCK_SYNC_ENDPOINT"), help="Protected sync endpoint")
    parser.add_argument("--batch-size", type=int, default=20, help="Profiles per POST batch")
    parser.add_argument("--download-batch-size", type=int, default=40, help="Symbols per yfinance download")
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--profile-delay", type=float, default=0.18)
    parser.add_argument("--skip-profiles", action="store_true", help="Use curated fallback profiles only")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.batch_size < 1 or args.download_batch_size < 1 or args.attempts < 1:
        raise SystemExit("Batch sizes and attempts must be positive integers")
    if args.batch_size > 70:
        raise SystemExit("--batch-size cannot exceed 70 because the sync endpoint caps each batch at 5,000 daily rows")
    if args.endpoint and args.skip_profiles:
        raise SystemExit("--skip-profiles cannot be used with a production sync endpoint")

    selected = None
    if args.symbols:
        selected = {symbol.strip().upper() for symbol in args.symbols.split(",") if symbol.strip()}
    entries = load_universe(args.universe.resolve(), selected)

    cache_dir = Path(os.environ.get("YFINANCE_CACHE_DIR", DEFAULT_CACHE)).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    yf.set_tz_cache_location(str(cache_dir))

    started_at = utc_now()
    run_id = f"yf-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    log(f"sync {run_id}: {len(entries)} symbols; cache={cache_dir}")

    source_updated_at = utc_now()
    prices, price_errors = fetch_prices(entries, args.download_batch_size, args.attempts, source_updated_at)
    if args.skip_profiles:
        profiles = [fallback_profile(entry, source_updated_at) for entry in entries]
        profile_errors: list[str] = []
    else:
        profiles, profile_errors = fetch_profiles(entries, args.attempts, args.profile_delay, source_updated_at)

    errors = [*price_errors, *profile_errors]
    latest_price_dates: dict[str, str] = {}
    for price in prices:
        symbol = price["symbol"]
        latest_price_dates[symbol] = max(latest_price_dates.get(symbol, ""), price["tradingDate"])
    freshness_cutoff = (datetime.now(timezone.utc).date() - timedelta(days=10)).isoformat()
    fresh_price_symbols = {
        symbol for symbol, latest_date in latest_price_dates.items()
        if latest_date >= freshness_cutoff
    }
    for entry in entries:
        latest_date = latest_price_dates.get(entry.symbol)
        if latest_date and entry.symbol not in fresh_price_symbols:
            errors.append(f"prices {entry.symbol}: latest daily row {latest_date} is older than {freshness_cutoff}")
    price_coverage = len(fresh_price_symbols) / len(entries)
    critical_price_failure = price_coverage < 0.8
    if critical_price_failure:
        errors.append(
            f"critical fresh-price coverage: {len(fresh_price_symbols)}/{len(entries)} symbols "
            f"({price_coverage:.1%}); minimum is 80%"
        )
    completed_at = utc_now()
    run = {
        "id": run_id,
        "startedAt": started_at,
        "completedAt": completed_at,
        "status": "failed" if critical_price_failure else "partial" if errors else "success",
        "sourceVersion": SOURCE_VERSION,
        "errors": errors,
        "profileCount": len(profiles),
        "priceCount": len(prices),
    }
    full_payload = {"run": run, "profiles": profiles, "prices": prices}

    if args.output:
        output_path = args.output if args.output.is_absolute() else ROOT / args.output
        write_seed(output_path.resolve(), full_payload)
        log(f"wrote seed: {output_path.resolve()}")

    token = ""
    if args.endpoint:
        token = os.environ.get("CRON_SECRET", "").strip()
        if not token:
            raise SystemExit("CRON_SECRET is required when --endpoint/STOCK_SYNC_ENDPOINT is set")

    if args.endpoint and not critical_price_failure:
        prices_by_symbol: dict[str, list[dict[str, Any]]] = {}
        for price in prices:
            prices_by_symbol.setdefault(price["symbol"], []).append(price)

        profile_batches = list(chunks(profiles, args.batch_size))
        for batch_number, profile_batch in enumerate(profile_batches, start=1):
            batch_symbols = {profile["symbol"] for profile in profile_batch}
            price_batch = [row for symbol in batch_symbols for row in prices_by_symbol.get(symbol, [])]
            is_last_batch = batch_number == len(profile_batches)
            batch_run = run if is_last_batch else {
                **run,
                "completedAt": None,
                "status": "running",
                "errors": [],
            }
            post_json(
                args.endpoint,
                token,
                {"run": batch_run, "profiles": profile_batch, "prices": price_batch},
                args.attempts,
            )
            log(
                f"posted batch {batch_number}: {len(profile_batch)} profiles, "
                f"{len(price_batch)} price rows"
            )
    elif args.endpoint:
        post_json(
            args.endpoint,
            token,
            {"run": run, "profiles": [], "prices": []},
            args.attempts,
        )
        log("critical price coverage failure: recorded failed run without uploading partial market data")

    if not args.output and not args.endpoint:
        print(json.dumps(full_payload, ensure_ascii=False))

    log(
        f"sync complete: profiles={len(profiles)}, prices={len(prices)}, "
        f"errors={len(errors)}, status={run['status']}"
    )
    if critical_price_failure:
        return 3
    return 2 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
