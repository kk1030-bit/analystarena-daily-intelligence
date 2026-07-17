import assert from "node:assert/strict";
import { demoBrief } from "../lib/demo-data";
import { selectDisplayBrief } from "../lib/display-brief";
import type { BriefRecord, BriefStatus } from "../lib/types";

function record(date: string, status: BriefStatus, title: string): BriefRecord {
  return {
    id: `${date}-${status}`,
    date,
    status,
    brief: {
      ...structuredClone(demoBrief),
      date,
      status,
      headlines: [{ ...structuredClone(demoBrief.headlines[0]), title }],
    },
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
    hasPdf: status === "published",
  };
}

const draft = record("2026-07-17", "draft", "今日草稿");
const todayPublished = record("2026-07-17", "published", "今日已发布");
const yesterdayPublished = record("2026-07-16", "published", "昨日已发布");

assert.deepEqual(selectDisplayBrief(draft, yesterdayPublished), { brief: draft.brief, origin: "draft" });
assert.deepEqual(selectDisplayBrief(todayPublished, yesterdayPublished), { brief: todayPublished.brief, origin: "published" });
assert.deepEqual(selectDisplayBrief(null, yesterdayPublished), { brief: yesterdayPublished.brief, origin: "published" });
assert.equal(selectDisplayBrief(null, null).origin, "demo");

console.log("display brief selection tests passed");
