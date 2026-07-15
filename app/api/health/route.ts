import { NextResponse } from "next/server";
import { adminConfigured } from "@/lib/auth";
import { databaseHealth } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const database = await databaseHealth();
  const browserCollectorMode = process.env.NODE_ENV === "production" ? "github-actions" : "in-process";
  return NextResponse.json({
    ok: true,
    service: "analystarena-daily",
    database,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    translationEnabled: true,
    translationLanguage: "zh-CN",
    adminConfigured: adminConfigured(),
    browserCollectorsEnabled:
      browserCollectorMode === "github-actions" || process.env.ENABLE_BROWSER_COLLECTORS === "true",
    browserCollectorMode,
  });
}
