import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { POST } from "../app/api/brief/pdf/route";
import { demoBrief } from "../lib/demo-data";
import type { DailyBrief } from "../lib/types";

async function extractPdfText(value: Buffer): Promise<string> {
  const loadingTask = getDocument({ data: new Uint8Array(value), useSystemFonts: true });
  const document = await loadingTask.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages.join("\n");
}

const originalFetch = globalThis.fetch;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

const untranslatedText = "Translation failure must remain visible in preview PDFs";
const previewBrief: DailyBrief = {
  ...demoBrief,
  status: "draft",
  translationEnabled: false,
  headlines: demoBrief.headlines.map((headline, index) => index === 0
    ? { ...headline, title: untranslatedText }
    : headline),
};

try {
  globalThis.fetch = (async () => {
    throw new Error("translator unavailable");
  }) as typeof fetch;

  const response = await POST(new Request("http://localhost/api/brief/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: previewBrief }),
  }));

  assert.equal(response.status, 200, "部分翻译失败不得阻止预览 PDF");
  assert.match(response.headers.get("Content-Type") ?? "", /^application\/pdf/i);
  assert.equal(
    response.headers.get("Content-Disposition"),
    `attachment; filename="AnalystArena-Market-Headlines-${previewBrief.date.slice(0, 10)}.pdf"`,
    "预览下载档名必须反映完整市场头条报告",
  );
  assert.equal(response.headers.get("X-AnalystArena-Translation-Warning"), "1", "未完成翻译的预览必须附带警告标记");
  const pdf = Buffer.from(await response.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF", "预览接口必须返回有效 PDF");
  assert.ok(pdf.length > 20_000, "预览 PDF 内容异常");
  const pdfText = (await extractPdfText(pdf)).replace(/\s+/gu, "");
  assert.ok(pdfText.includes("潜在利好标的"), "预览 PDF 必须明确列出潜在利好标的");
  assert.ok(pdfText.includes("潜在利空标的"), "预览 PDF 必须明确列出潜在利空标的");
  assert.ok(pdfText.includes("AVGO"), "预览路由必须补算市场头条已有的股票映射");
  console.log("pdf preview route test passed");
} finally {
  globalThis.fetch = originalFetch;
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
}
