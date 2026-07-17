import assert from "node:assert/strict";
import { readJsonBody, RequestBodyTooLargeError } from "../lib/request-json";

const parsed = await readJsonBody(new Request("http://localhost", {
  method: "POST",
  body: JSON.stringify({ symbol: "NVDA" }),
}), 1_000);
assert.deepEqual(parsed, { symbol: "NVDA" });

const disguisedOversize = new Request("http://localhost", {
  method: "POST",
  headers: { "content-length": "1" },
  body: JSON.stringify({ text: "x".repeat(2_000) }),
});
await assert.rejects(() => readJsonBody(disguisedOversize, 1_000), RequestBodyTooLargeError);

console.log("request JSON limit tests passed");
