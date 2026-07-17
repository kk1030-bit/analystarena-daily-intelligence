import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { listBriefs, storageMode } from "@/lib/db";
import { attachEquityImpacts } from "@/lib/equity-impact";
import { localizeBriefContent } from "@/lib/translation";
import type { BriefStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requested = url.searchParams.get("status") as BriefStatus | null;
    const admin = isAdminRequest(request);
    const status: BriefStatus | undefined = admin
      ? (requested === "draft" || requested === "published" ? requested : undefined)
      : "published";
    const records = await listBriefs(status, 60);
    if (!admin) return NextResponse.json({ records, storageMode: storageMode(), admin });

    const localizedRecords = await Promise.all(records.map(async (record) => record.status === "draft"
      ? { ...record, brief: await localizeBriefContent(record.brief) }
      : record));
    const draftHeadlines = localizedRecords.flatMap((record) => record.status === "draft" ? record.brief.headlines : []);
    const attached = draftHeadlines.length ? await attachEquityImpacts(draftHeadlines) : [];
    let cursor = 0;
    const hydratedRecords = localizedRecords.map((record) => {
      if (record.status !== "draft") return record;
      const headlines = attached.slice(cursor, cursor + record.brief.headlines.length);
      cursor += record.brief.headlines.length;
      return { ...record, brief: { ...record.brief, headlines } };
    });
    return NextResponse.json({ records: hydratedRecords, storageMode: storageMode(), admin });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取日报失败" }, { status: 500 });
  }
}
