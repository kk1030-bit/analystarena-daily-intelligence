import assert from "node:assert/strict";

process.env.CRON_SECRET = "stock-route-test-secret";
process.env.STOCK_SEARCH_API_TOKEN = "stock-search-test-secret";
delete process.env.DATABASE_URL;

const [syncRoute, beneficiariesRoute] = await Promise.all([
  import("../app/api/cron/stocks/sync/route"),
  import("../app/api/v1/stocks/beneficiaries/route"),
]);

const syncPayload = {
  run: {
    id: "route-test-run",
    startedAt: "2031-01-02T00:00:00.000Z",
    completedAt: "2031-01-02T00:01:00.000Z",
    status: "success",
    sourceVersion: "yfinance-test",
    errors: [],
    profileCount: 1,
    priceCount: 1,
  },
  profiles: [{
    symbol: "NVDA",
    providerSymbol: "NVDA",
    shortName: "NVIDIA",
    aliases: ["NVIDIA", "英伟达"],
    exposureTags: ["ai_compute"],
    active: true,
    profileFetchOk: true,
    sourceUpdatedAt: "2031-01-02T00:00:00.000Z",
  }],
  prices: [{
    symbol: "NVDA",
    tradingDate: "2031-01-01",
    close: 300,
    sourceUpdatedAt: "2031-01-02T00:00:00.000Z",
  }],
};

Object.assign(process.env, { NODE_ENV: "production" });
const productionWithoutDatabase = await syncRoute.POST(new Request("http://localhost/api/cron/stocks/sync", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  body: JSON.stringify(syncPayload),
}));
assert.equal(productionWithoutDatabase.status, 503, "正式环境不得把同步伪装成内存持久化成功");

Object.assign(process.env, { NODE_ENV: "test" });
const localSync = await syncRoute.POST(new Request("http://localhost/api/cron/stocks/sync", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  body: JSON.stringify(syncPayload),
}));
assert.equal(localSync.status, 200);
assert.equal((await localSync.json()).storageMode, "memory");

const apiHeaders = {
  authorization: `Bearer ${process.env.STOCK_SEARCH_API_TOKEN}`,
  "content-type": "application/json",
};
const nullBody = await beneficiariesRoute.POST(new Request("http://localhost/api/v1/stocks/beneficiaries", {
  method: "POST", headers: apiHeaders, body: "null",
}));
assert.equal(nullBody.status, 400);

const badTime = await beneficiariesRoute.POST(new Request("http://localhost/api/v1/stocks/beneficiaries", {
  method: "POST", headers: apiHeaders, body: JSON.stringify({ title: "NVIDIA update", publishedAt: "2031-02-30T00:00:00Z" }),
}));
assert.equal(badTime.status, 400);

const mapped = await beneficiariesRoute.POST(new Request("http://localhost/api/v1/stocks/beneficiaries", {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({
    title: "NVIDIA raises guidance as data-center demand grows",
    summary: "NVIDIA reported stronger chip orders.",
    ticker: "市场",
    sourceType: "News",
    publishedAt: "2031-01-02T08:30:00+08:00",
  }),
}));
assert.equal(mapped.status, 200);
assert.equal((await mapped.json()).data.some((item: { symbol: string }) => item.symbol === "NVDA"), true);

const tickerOnly = await beneficiariesRoute.POST(new Request("http://localhost/api/v1/stocks/beneficiaries", {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({ title: "Unrelated macro story", ticker: "NVDA", publishedAt: "2031-01-02T00:00:00Z" }),
}));
assert.equal(tickerOnly.status, 200);
assert.equal((await tickerOnly.json()).data.some((item: { symbol: string }) => item.symbol === "NVDA"), false);

console.log("stock route tests passed");
