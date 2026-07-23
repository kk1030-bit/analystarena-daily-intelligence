import { isAdminRequest } from "@/lib/auth";
import { getPublishedPdf } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await getPublishedPdf(id, {
    includeSuperseded: isAdminRequest(request),
  });
  if (!result) return Response.json({ error: "找不到已发布 PDF" }, { status: 404 });
  return new Response(new Uint8Array(result.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="AnalystArena-Daily-${result.date}.pdf"`,
      "Cache-Control": "public, max-age=3600, immutable",
    },
  });
}
