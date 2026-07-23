import { demoBrief } from "./demo-data";
import { getBriefByDate, getLatestPublished } from "./db";
import { beijingDateKey } from "./time";
import type { BriefRecord, DailyBrief } from "./types";

export type DisplayBriefOrigin = "draft" | "published" | "demo";

export interface DisplayBriefSelection {
  brief: DailyBrief;
  origin: DisplayBriefOrigin;
}

export function selectDisplayBrief(
  today: BriefRecord | null,
  latestPublished: BriefRecord | null,
): DisplayBriefSelection {
  if (today?.status === "published") return { brief: today.brief, origin: "published" };
  if (latestPublished) return { brief: latestPublished.brief, origin: "published" };
  return { brief: demoBrief, origin: "demo" };
}

export async function getDisplayBrief(): Promise<DisplayBriefSelection> {
  const [today, latestPublished] = await Promise.all([
    getBriefByDate(beijingDateKey()).catch(() => null),
    getLatestPublished().catch(() => null),
  ]);
  return selectDisplayBrief(today, latestPublished);
}
