import assert from "node:assert/strict";
import { localizeBriefContent, localizeText } from "../lib/translation";
import type { DailyBrief } from "../lib/types";

const originalFetch = globalThis.fetch;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

function googleResponse(translated: string): Response {
  return new Response(JSON.stringify([[[translated, "source", null, null]]]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function briefWith(text: string): DailyBrief {
  return {
    date: "2026-07-17",
    generatedAt: "2026-07-17T00:00:00.000Z",
    mode: "live",
    aiEnabled: false,
    stats: { candidates: 1, consolidatedEvents: 1, topStories: 1, sourcesOnline: 1 },
    headlines: [{
      id: "translation-test",
      rank: 1,
      ticker: "NVDA",
      title: text,
      summary: text,
      keyPoints: [text],
      marketImpact: text,
      category: "AI",
      impact: 4,
      confidence: 80,
      mentions: 1,
      sentiment: "positive",
      sources: [{ name: "Test", type: "News", url: "https://example.com" }],
    }],
    marketHeat: [],
    socialBuzz: { reddit: [], x: [] },
    watchlist: [],
  };
}

try {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return googleResponse("\u4eba\u5de5\u667a\u80fd\u70ed\u6f6e");
  }) as typeof fetch;
  assert.equal(await localizeText("AI boom"), "\u4eba\u5de5\u667a\u80fd\u70ed\u6f6e", "\u77ed\u82f1\u6587\u53d9\u8ff0\u5fc5\u987b\u7ffb\u8bd1");
  assert.equal(calls, 1);

  globalThis.fetch = (async () => googleResponse("NVDA \u7b2c\u4e8c\u5b63\u5ea6\u8425\u6536\u8d85\u51fa\u9884\u671f")) as typeof fetch;
  assert.equal(await localizeText("NVDA Q2 \u8425\u6536 beat estimates"), "NVDA \u7b2c\u4e8c\u5b63\u5ea6\u8425\u6536\u8d85\u51fa\u9884\u671f", "\u4e2d\u82f1\u6df7\u6392\u53d9\u8ff0\u5fc5\u987b\u7ffb\u8bd1");

  globalThis.fetch = (async () => googleResponse("Palantir \u63a8\u51fa\u4eba\u5de5\u667a\u80fd\u5e73\u53f0")) as typeof fetch;
  assert.equal(
    await localizeText("Palantir launches an AI platform"),
    "Palantir \u63a8\u51fa\u4eba\u5de5\u667a\u80fd\u5e73\u53f0",
    "\u672a\u6536\u5f55\u7684\u516c\u53f8\u4e13\u540d\u4e0d\u5e94\u8ba9\u5df2\u5b8c\u6210\u7684\u4e2d\u6587\u7ffb\u8bd1\u88ab\u8bef\u5224\u4e3a\u5931\u8d25",
  );

  calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return googleResponse("\u4e0d\u5e94\u88ab\u8c03\u7528");
  }) as typeof fetch;
  assert.equal(await localizeText("NVIDIA Blackwell AI GPU"), "NVIDIA Blackwell AI GPU", "\u80a1\u7968\u76f8\u5173\u4e13\u540d\u4e0e\u7f29\u5199\u5e94\u4fdd\u7559");
  assert.equal(calls, 0);
  assert.equal(await localizeText("\u8cc7\u8a0a\u8207\u6676\u7247"), "\u4fe1\u606f\u4e0e\u82af\u7247", "\u7e41\u4f53\u4e2d\u6587\u5fc5\u987b\u8f6c\u4e3a\u7b80\u4f53\u53ca\u5927\u9646\u7528\u8bed");
  assert.equal(calls, 0);

  calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return googleResponse("\u6536\u5165\u5c55\u671b\u6539\u5584");
  }) as typeof fetch;
  const repeated = "Revenue outlook improves singleflight test";
  const simultaneous = await Promise.all(Array.from({ length: 8 }, () => localizeText(repeated)));
  assert.deepEqual(simultaneous, Array(8).fill("\u6536\u5165\u5c55\u671b\u6539\u5584"));
  assert.equal(calls, 1, "\u76f8\u540c\u6587\u672c\u7684\u5e76\u53d1\u7ffb\u8bd1\u5fc5\u987b\u5355\u98de\u53bb\u91cd");

  let active = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return googleResponse("\u4e2d\u6587\u7ffb\u8bd1\u7ed3\u679c");
  }) as typeof fetch;
  await Promise.all(Array.from({ length: 9 }, (_, index) => localizeText(`Revenue outlook improves concurrency ${index}`)));
  assert.ok(peak <= 4, `\u7ffb\u8bd1\u8bf7\u6c42\u5e76\u53d1\u4e0d\u5f97\u8d85\u8fc7 4\uff0c\u5b9e\u9645\u4e3a ${peak}`);

  calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("translator unavailable");
  }) as typeof fetch;
  const failedText = "Translation failure must remain visible";
  const nonStrict = await localizeBriefContent(briefWith(failedText));
  assert.equal(nonStrict.translationEnabled, false, "\u7ffb\u8bd1\u5931\u8d25\u65f6\u4e0d\u5f97\u8bef\u6807\u4e3a\u5df2\u542f\u7528\u7b80\u4f53\u4e2d\u6587");
  assert.equal(nonStrict.headlines[0].title, failedText);
  assert.equal(calls, 2, "Google \u7ffb\u8bd1\u5e94\u5c1d\u8bd5\u4e24\u6b21\uff0c\u540c\u6587\u672c\u5e76\u53d1\u5e94\u5355\u98de");

  await assert.rejects(
    () => localizeBriefContent(briefWith("Strict translation rejection test"), { strict: true }),
    /\u7b80\u4f53\u4e2d\u6587\u7ffb\u8bd1\u672a\u5b8c\u6210/,
    "strict \u6a21\u5f0f\u5fc5\u987b\u62d2\u7edd\u6b8b\u7559\u82f1\u6587\u53d9\u8ff0\u7684\u7ed3\u679c",
  );

  console.log("translation tests passed");
} finally {
  globalThis.fetch = originalFetch;
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
}
