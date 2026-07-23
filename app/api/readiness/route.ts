import { NextResponse } from "next/server";
import {
  adminConfigured,
  auditConfigured,
  isAdminRequest,
  redditSearchConfigured,
  stockSearchConfigured,
} from "@/lib/auth";
import { databaseHealth } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "未授权" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const database = await databaseHealth();
  const browserCollectorMode = process.env.NODE_ENV === "production" ? "github-actions" : "in-process";
  const cronConfigured = Boolean(process.env.CRON_SECRET);
  const ready = database.ok
    && database.mode === "postgres"
    && adminConfigured()
    && auditConfigured()
    && cronConfigured
    && redditSearchConfigured()
    && stockSearchConfigured();

  return NextResponse.json({
    ok: ready,
    service: "analystarena-daily",
    checkedAt: new Date().toISOString(),
    database,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    translationEnabled: true,
    translationLanguage: "zh-CN",
    adminConfigured: adminConfigured(),
    auditConfigured: auditConfigured(),
    cronConfigured,
    redditSearchApiConfigured: redditSearchConfigured(),
    stockSearchApiConfigured: stockSearchConfigured(),
    browserCollectorsEnabled:
      browserCollectorMode === "github-actions" || process.env.ENABLE_BROWSER_COLLECTORS === "true",
    browserCollectorMode,
  }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
