import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WHAT_CHANGED_IMPLEMENTATION_HASH } from "../lib/what-changed";

const sourceUrl = new URL("../lib/what-changed.ts", import.meta.url);
const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
const hashLiteralPattern =
  /(export const WHAT_CHANGED_IMPLEMENTATION_HASH =\n\s*)"[0-9a-f]{64}";/;
assert.match(source, hashLiteralPattern, "What Changed implementation hash literal is missing");

const normalizedSource = source.replace(
  hashLiteralPattern,
  '$1"__WHAT_CHANGED_IMPLEMENTATION_HASH__";',
);
const actualHash = createHash("sha256").update(normalizedSource, "utf8").digest("hex");

assert.equal(
  WHAT_CHANGED_IMPLEMENTATION_HASH,
  actualHash,
  "What Changed source changed without updating its implementation hash, migration, and audit documentation",
);

console.log("What Changed implementation source hash test passed");
