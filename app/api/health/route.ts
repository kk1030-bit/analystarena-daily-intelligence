import { NextResponse } from "next/server";
import { adminConfigured } from "@/lib/auth";
import { databaseHealth } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const database = await databaseHealth();
  return NextResponse.json({
    ok: true,
    service: "analystarena-daily",
    database,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    adminConfigured: adminConfigured(),
    browserCollectorsEnabled: process.env.ENABLE_BROWSER_COLLECTORS === "true",
  });
}
