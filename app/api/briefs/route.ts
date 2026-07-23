import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { listBriefs, storageMode } from "@/lib/db";
import type { BriefStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requested = url.searchParams.get("status") as BriefStatus | null;
    const admin = isAdminRequest(request);
    const status: BriefStatus | undefined = admin
      ? (
          requested === "draft"
          || requested === "published"
          || requested === "superseded"
            ? requested
            : undefined
        )
      : "published";
    const records = await listBriefs(status, 60);
    return NextResponse.json({ records, storageMode: storageMode(), admin });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取日报失败" }, { status: 500 });
  }
}
