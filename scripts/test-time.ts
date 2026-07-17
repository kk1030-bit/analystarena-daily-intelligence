import assert from "node:assert/strict";
import { beijingDateKey } from "../lib/time";

assert.equal(beijingDateKey(new Date("2026-07-16T15:59:00.000Z")), "2026-07-16");
assert.equal(beijingDateKey(new Date("2026-07-16T16:00:00.000Z")), "2026-07-17");

console.log("Beijing date tests passed");
