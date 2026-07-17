import assert from "node:assert/strict";
import {
  hotSearchBatchKey,
  manualRefreshBatchKey,
  manualRefreshContextKey,
  MANUAL_REFRESH_WINDOW_MS,
  normalizeHotSearchBatchKey,
  normalizeLiveBriefContext,
} from "../lib/live-brief";

assert.equal(MANUAL_REFRESH_WINDOW_MS, 120_000);
assert.equal(hotSearchBatchKey(599_999), "0");
assert.equal(hotSearchBatchKey(600_000), "1");
assert.equal(manualRefreshBatchKey(119_999), "0");
assert.equal(manualRefreshBatchKey(120_000), "1");
assert.equal(manualRefreshContextKey(120_000), "manual:1");

const originalNow = Date.now;
Date.now = () => 12_000_000;
try {
  const current = hotSearchBatchKey();
  assert.equal(normalizeHotSearchBatchKey(current), current);
  assert.equal(normalizeHotSearchBatchKey(String(Number(current) - 1)), String(Number(current) - 1));
  assert.equal(normalizeHotSearchBatchKey("9999999999999999"), current);
  assert.equal(normalizeHotSearchBatchKey("not-a-batch"), current);

  const manualCurrent = manualRefreshBatchKey();
  assert.deepEqual(normalizeLiveBriefContext(`manual:${manualCurrent}`), {
    kind: "manual",
    batchKey: manualCurrent,
    contextKey: `manual:${manualCurrent}`,
  });
  assert.equal(normalizeLiveBriefContext(`manual:${Number(manualCurrent) - 5}`).contextKey, `manual:${Number(manualCurrent) - 5}`);
  assert.equal(normalizeLiveBriefContext(`manual:${Number(manualCurrent) - 6}`).contextKey, `manual:${manualCurrent}`);
  assert.deepEqual(normalizeLiveBriefContext(current), { kind: "shared", batchKey: current, contextKey: current });
} finally {
  Date.now = originalNow;
}

console.log("live brief cache key tests passed");
