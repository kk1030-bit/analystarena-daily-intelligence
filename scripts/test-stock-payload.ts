import assert from "node:assert/strict";
import { parseStockSyncPayload } from "../lib/stock-payload";

const valid = {
  run: {
    id: "test-run",
    startedAt: "2026-07-17T00:00:00Z",
    completedAt: "2026-07-17T00:01:00Z",
    status: "success",
    sourceVersion: "yfinance-test",
    errors: [],
    profileCount: 1,
    priceCount: 1,
  },
  profiles: [{
    symbol: "NVDA",
    providerSymbol: "NVDA",
    aliases: ["NVIDIA", "英伟达"],
    exposureTags: ["AI_COMPUTE"],
    active: true,
    profileFetchOk: true,
    sourceUpdatedAt: "2026-07-17T00:00:00Z",
  }],
  prices: [{
    symbol: "NVDA",
    tradingDate: "2026-07-16",
    close: 207.4,
    volume: 120_000_000,
    sourceUpdatedAt: "2026-07-17T00:00:00Z",
  }],
};

assert.equal(parseStockSyncPayload(valid).profiles[0]?.exposureTags[0], "ai_compute");

function rejects(change: (payload: typeof valid) => void, pattern: RegExp): void {
  const payload = structuredClone(valid);
  change(payload);
  assert.throws(() => parseStockSyncPayload(payload), pattern);
}

rejects((payload) => { payload.profiles[0]!.active = "false" as unknown as boolean; }, /布尔值/);
rejects((payload) => { payload.prices[0]!.close = "207.4" as unknown as number; }, /有限数字/);
rejects((payload) => { payload.prices[0]!.tradingDate = "2026-02-31"; }, /YYYY-MM-DD/);
rejects((payload) => { payload.profiles[0]!.symbol = "ABCDEFGHIJKLMNOPQ"; }, /不得超过/);
rejects((payload) => { payload.run.startedAt = "2026-02-30T00:00:00Z"; }, /日历时间/);
rejects((payload) => { payload.run.completedAt = "2026-07-16T23:59:59Z"; }, /不得早于/);
rejects((payload) => { delete (payload.prices[0] as { close?: number }).close; }, /close 必须是正数/);
rejects((payload) => { delete (payload.run as Partial<typeof payload.run>).profileCount; }, /不能为空/);
rejects((payload) => { payload.profiles.push(structuredClone(payload.profiles[0]!)); payload.run.profileCount = 2; }, /重复 symbol/);
rejects((payload) => { payload.prices.push(structuredClone(payload.prices[0]!)); payload.run.priceCount = 2; }, /重复/);
rejects((payload) => { payload.run.profileCount = 0; }, /不得小于/);

const failedRunOnly = structuredClone(valid);
failedRunOnly.run.status = "failed";
failedRunOnly.run.profileCount = 0;
failedRunOnly.run.priceCount = 0;
failedRunOnly.profiles = [];
failedRunOnly.prices = [];
assert.equal(parseStockSyncPayload(failedRunOnly).run.status, "failed");

console.log("stock payload tests passed");
