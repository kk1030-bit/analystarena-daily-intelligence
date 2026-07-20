import assert from "node:assert/strict";
import { collectFirstAvailable, safeCollectorNote } from "../lib/collectors/router";

let fallbackCalls = 0;
const preferred = await collectFirstAvailable("Reddit", [
  { name: "主线路", collect: async () => ["首选内容"] },
  {
    name: "备用线路",
    collect: async () => {
      fallbackCalls += 1;
      return ["不应读取"];
    },
  },
]);
assert.deepEqual(preferred.items, ["首选内容"]);
assert.equal(fallbackCalls, 0, "首选成功后不得继续请求备用线路");
assert.equal(preferred.status.ok, true);
assert.equal(preferred.status.backend, "主线路");
assert.equal(preferred.status.fallbackUsed, false);
assert.equal(preferred.status.attempts?.length, 1);
assert.equal(preferred.status.attempts?.[0]?.ok, true);
assert.match(preferred.status.lastSuccessAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

const errorFallback = await collectFirstAvailable("X", [
  {
    name: "登录线路",
    collect: async () => {
      throw new Error("token=top-secret Bearer second-secret cookie=session-secret 请求失败");
    },
  },
  { name: "公开索引", collect: async () => ["备用内容"] },
]);
assert.deepEqual(errorFallback.items, ["备用内容"]);
assert.equal(errorFallback.status.ok, true);
assert.equal(errorFallback.status.backend, "公开索引");
assert.equal(errorFallback.status.fallbackUsed, true);
assert.equal(errorFallback.status.attempts?.length, 2);
assert.equal(errorFallback.status.attempts?.[0]?.ok, false);
assert.match(errorFallback.status.attempts?.[0]?.note ?? "", /token=\[(?:已隐藏|redacted)\]/i);
assert.doesNotMatch(errorFallback.status.attempts?.[0]?.note ?? "", /top-secret|second-secret|session-secret/);
assert.match(errorFallback.status.note ?? "", /备用线路接手/);

const emptyFallback = await collectFirstAvailable("Reddit", [
  { name: "新站", collect: async () => [] as string[] },
  { name: "旧站", collect: async () => ["旧站内容"] },
]);
assert.deepEqual(emptyFallback.items, ["旧站内容"]);
assert.equal(emptyFallback.status.fallbackUsed, true);
assert.equal(emptyFallback.status.attempts?.[0]?.note, "未返回可用内容");
assert.equal(emptyFallback.status.attempts?.[1]?.ok, true);

const allFailed = await collectFirstAvailable<string>("新闻", [
  {
    name: "RSS",
    collect: async () => {
      throw new Error("secret=never-show-this 网络错误");
    },
  },
  { name: "网页", collect: async () => [] },
]);
assert.deepEqual(allFailed.items, []);
assert.equal(allFailed.status.ok, false);
assert.equal(allFailed.status.count, 0);
assert.equal(allFailed.status.backend, undefined);
assert.equal(allFailed.status.fallbackUsed, true);
assert.equal(allFailed.status.attempts?.length, 2);
assert.match(allFailed.status.note ?? "", /RSS.*网页/);
assert.doesNotMatch(allFailed.status.note ?? "", /never-show-this/);

const redacted = safeCollectorNote("authorization=private-key reddit_session=private-session 正常错误");
assert.doesNotMatch(redacted, /private-key|private-session/);
assert.match(redacted, /authorization=\[(?:已隐藏|redacted)\].*reddit_session=\[(?:已隐藏|redacted)\]/i);
assert.ok(safeCollectorNote("x".repeat(500)).length <= 240, "错误备注应限制长度");

console.log("collector routing tests passed");
