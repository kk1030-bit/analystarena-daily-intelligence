import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { demoBrief } from "../lib/demo-data";
import { attachEquityImpacts } from "../lib/equity-impact";
import { generateBriefPdf } from "../lib/pdf";
import type { EquityImpactDirection } from "../lib/types";

const directions: EquityImpactDirection[] = ["potential_upside", "potential_downside", "mixed"];
const enrichedHeadlines = await attachEquityImpacts(demoBrief.headlines);
const impactTemplates = enrichedHeadlines.flatMap((headline) => headline.equityImpacts ?? []).slice(0, 3);
assert.equal(impactTemplates.length, 3, "测试种子必须能生成至少三个股票映射");

const longText = "这是一段用于验证正式日报分页安全性的超长信息，包含事实、假设、风险与市场传导路径。".repeat(45);
const stressBrief = {
  ...demoBrief,
  headlines: enrichedHeadlines.map((headline) => ({
    ...headline,
    title: `${headline.title} ${longText}`,
    summary: longText,
    keyPoints: [longText, longText, longText, longText],
    marketImpact: longText,
    equityImpacts: impactTemplates.map((item, index) => ({
      ...item,
      symbol: `${item.symbol}${index + 1}`,
      direction: directions[index],
      mappingConfidence: 90 - index,
      mechanism: longText,
      reviewStatus: "approved" as const,
    })),
  })),
};

const pdf = await generateBriefPdf(stressBrief);
assert.ok(pdf.length > 25_000, "压力测试 PDF 内容异常");
assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF", "输出不是 PDF 文件");

const outputDirectory = path.join(process.cwd(), "tmp", "pdfs");
await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, "publish-layout-stress.pdf");
await writeFile(outputPath, pdf);
console.log(outputPath);
