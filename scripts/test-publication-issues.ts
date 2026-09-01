import assert from "node:assert/strict";
import { demoBrief } from "../lib/demo-data";
import { publicationEvidenceIssues } from "../lib/publication-evidence";
import { normalizePublicationIssues } from "../lib/publication-issues";

const malicious = '<img src=x onerror="alert(1)">';
const issues = normalizePublicationIssues([
  {
    code: "SOURCE_PROVENANCE_AUTHORITY_MISMATCH\n",
    headlineId: "evt_123",
    headlineRank: 2,
    claimKey: "database_authority",
    reason: `${malicious}\u0000 source mismatch`,
  },
  {
    code: "SOURCE_PROVENANCE_AUTHORITY_MISMATCH\n",
    headlineId: "evt_123",
    headlineRank: 2,
    claimKey: "database_authority",
    reason: `${malicious}\u0000 source mismatch`,
  },
  { code: "UNKNOWN_CODE", headlineRank: "not-a-rank", reason: "x".repeat(1_000) },
  null,
]);

assert.equal(issues.length, 2, "duplicate and malformed issues must be bounded");
assert.equal(issues[0].code, "SOURCE_PROVENANCE_AUTHORITY_MISMATCH");
assert.equal(issues[0].headlineId, "evt_123");
assert.equal(issues[0].headlineRank, 2);
assert.ok(issues[0].message.includes(malicious), "text must remain literal for React text rendering");
assert.ok(!issues[0].message.includes("\u0000"), "control characters must be removed");
assert.equal(issues[1].headlineRank, undefined);
assert.equal(issues[1].message.length, 600);
assert.deepEqual(normalizePublicationIssues({ issues: [] }), []);

const untranslated = {
  ...structuredClone(demoBrief),
  translationEnabled: false,
};
const translationIssues = publicationEvidenceIssues(untranslated)
  .filter((item) => item.code === "TRANSLATION_INCOMPLETE");
assert.equal(
  translationIssues.length,
  untranslated.headlines.length,
  "every headline in a snapshot without completed Simplified-Chinese translation must block publication",
);
assert.ok(
  translationIssues.every((item) => item.claimKey === "translation" && Boolean(item.headlineId)),
  "translation publication issues must identify the affected headline",
);

console.log("publication issue normalization tests passed");
