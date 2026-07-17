import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { saveStockSync, storageMode } from "@/lib/db";
import { readJsonBody, RequestBodyTooLargeError } from "@/lib/request-json";
import { parseStockSyncPayload } from "@/lib/stock-payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const MAX_BODY_BYTES = 8_000_000;

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "排程密钥（CRON_SECRET）尚未设置" }, { status: 503 });
  if (!isCronRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  if (process.env.NODE_ENV === "production" && storageMode() !== "postgres") {
    return NextResponse.json({ error: "正式环境的 PostgreSQL 尚未连接，同步未写入" }, { status: 503 });
  }
  try {
    const payload = parseStockSyncPayload(await readJsonBody(request, MAX_BODY_BYTES));
    const saved = await saveStockSync(payload);
    return NextResponse.json({ ok: true, runId: payload.run.id, saved, storageMode: storageMode() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "股票同步失败";
    const status = error instanceof RequestBodyTooLargeError ? 413
      : error instanceof SyntaxError || /必须|不得|不能为空|无效|格式|重复/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
