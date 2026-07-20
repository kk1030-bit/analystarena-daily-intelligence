import assert from "node:assert/strict";
import type { StockSyncPayload } from "../lib/types";

delete process.env.DATABASE_URL;
const { saveStockSync, searchStockProfiles } = await import("../lib/db");

function payload(sourceUpdatedAt: string, profileFetchOk: boolean, close: number): StockSyncPayload {
  return {
    run: {
      id: `memory-${sourceUpdatedAt}`,
      startedAt: sourceUpdatedAt,
      completedAt: sourceUpdatedAt,
      status: "success",
      sourceVersion: "test",
      errors: [],
      profileCount: 1,
      priceCount: 1,
    },
    profiles: [{
      symbol: "NVDA",
      providerSymbol: "NVDA",
      shortName: profileFetchOk ? "New NVIDIA" : undefined,
      longName: profileFetchOk ? "Newer profile wins" : undefined,
      sector: profileFetchOk ? "Technology" : undefined,
      industry: profileFetchOk ? "Semiconductors" : undefined,
      businessSummary: profileFetchOk ? "Rich profile data" : undefined,
      marketCap: profileFetchOk ? 4_000_000_000_000 : undefined,
      aliases: ["NVIDIA", "英伟达"],
      exposureTags: ["ai_compute"],
      active: true,
      profileFetchOk,
      sourceUpdatedAt,
    }],
    prices: [{
      symbol: "NVDA",
      tradingDate: "2030-01-02",
      close,
      sourceUpdatedAt,
    }],
  };
}

await saveStockSync(payload("2030-01-03T00:00:00.000Z", true, 300));
await saveStockSync(payload("2029-12-31T00:00:00.000Z", false, 100));

const nvda = (await searchStockProfiles("NVDA", 1)).items[0];
assert.equal(nvda?.longName, "Newer profile wins");
assert.equal(nvda?.sector, "Technology");
assert.equal(nvda?.sourceUpdatedAt, "2030-01-03T00:00:00.000Z");
assert.equal(nvda?.latestPrice?.close, 300);
const historicalNvda = (await searchStockProfiles("NVDA", 1, "2026-07-16")).items[0];
assert.equal(historicalNvda?.latestPrice?.tradingDate, "2026-07-16");

const newerPartial = payload("2030-01-03T00:00:01.000Z", true, 302);
newerPartial.profiles[0]!.sector = undefined;
newerPartial.profiles[0]!.industry = undefined;
newerPartial.profiles[0]!.businessSummary = undefined;
newerPartial.profiles[0]!.marketCap = undefined;
await saveStockSync(newerPartial);
const mergedNvda = (await searchStockProfiles("NVDA", 1)).items[0];
assert.equal(mergedNvda?.sector, "Technology");
assert.equal(mergedNvda?.industry, "Semiconductors");
assert.equal(mergedNvda?.businessSummary, "Rich profile data");
assert.equal(mergedNvda?.marketCap, 4_000_000_000_000);

const finalRun = payload("2030-01-04T00:00:00.000Z", true, 301);
finalRun.run.id = "replayed-run";
await saveStockSync(finalRun);
const replayedRunning = structuredClone(finalRun);
replayedRunning.run.status = "running";
replayedRunning.run.completedAt = undefined;
replayedRunning.run.errors = [];
await saveStockSync(replayedRunning);
assert.equal(globalThis.__analystArenaStockRunMemory?.get("replayed-run")?.status, "success");
assert.equal(globalThis.__analystArenaStockRunMemory?.get("replayed-run")?.priceCount, 1);

const priceHistoryPayload: StockSyncPayload = {
  run: {
    id: "price-summary-run",
    startedAt: "2040-01-22T00:00:00.000Z",
    completedAt: "2040-01-22T00:00:00.000Z",
    status: "success",
    sourceVersion: "test",
    errors: [],
    profileCount: 1,
    priceCount: 21,
  },
  profiles: [{
    symbol: "TSTX",
    providerSymbol: "TSTX",
    shortName: "Test Equity",
    longName: "Test Equity Corporation",
    aliases: ["Test Equity"],
    exposureTags: [],
    active: true,
    profileFetchOk: true,
    sourceUpdatedAt: "2040-01-22T00:00:00.000Z",
  }],
  prices: Array.from({ length: 21 }, (_, index) => ({
    symbol: "TSTX",
    tradingDate: `2040-01-${String(index + 1).padStart(2, "0")}`,
    close: 101 + index,
    adjustedClose: 101 + index,
    volume: index === 20 ? 200 : 100,
    sourceUpdatedAt: "2040-01-22T00:00:00.000Z",
  })),
};
await saveStockSync(priceHistoryPayload);
const summarized = (await searchStockProfiles("TSTX", 1)).items[0]?.priceSummary;
assert.equal(summarized?.asOf, "2040-01-21");
assert.equal(summarized?.lastPrice, 121);
assert.equal(summarized?.previousClose, 120);
assert.equal(summarized?.close5SessionsAgo, 116);
assert.equal(summarized?.latestVolume, 200);
assert.equal(summarized?.averageVolume20d, 100);

const boundedSummary = (await searchStockProfiles("TSTX", 1, "2040-01-10")).items[0]?.priceSummary;
assert.equal(boundedSummary?.asOf, "2040-01-10", "as-of searches must not read future prices");
assert.equal(boundedSummary?.lastPrice, 110);

console.log("stock memory ordering tests passed");
