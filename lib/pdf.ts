import path from "node:path";
import PDFDocument from "pdfkit";
import type { DailyBrief, EquityImpactDirection, Headline } from "./types";
import { categoryDisplayNames, extractTermNotes, sourceDisplayName } from "./terms";
import { formatTimestampLine, resolveHeadlineTimestamp } from "./time";

const page = { width: 595.28, height: 841.89, margin: 44 };
const colors = {
  ink: "#151A1C",
  muted: "#596362",
  acid: "#CFFF4F",
  orange: "#FF6B35",
  pale: "#F1F3ED",
  line: "#D4D9D2",
  white: "#FFFFFF",
  upside: "#24766C",
  downside: "#C43D2F",
  mixed: "#9A6500",
};

function pdfText(value: string, limit = 2_000): string {
  return String(value ?? "")
    .slice(0, limit)
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/[，、]/g, ", ")
    .replace(/。/g, ". ")
    .replace(/；/g, "; ")
    .replace(/：/g, ": ")
    .replace(/[「」『』“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

function fontPath(): string {
  return path.join(process.cwd(), "assets", "fonts", "NotoSansSC-Regular.ttf");
}

function topFive(brief: DailyBrief): Headline[] {
  return [...brief.headlines].sort((a, b) => a.rank - b.rank).slice(0, 5);
}

function factsFor(headline: Headline): string[] {
  const facts = headline.keyPoints?.map((point) => pdfText(point, 280)).filter(Boolean) ?? [];
  return facts.length ? facts.slice(0, 4) : [pdfText(headline.summary, 360)];
}

function drawImpact(doc: PDFKit.PDFDocument, score: number, x: number, y: number): void {
  for (let index = 0; index < 5; index += 1) {
    doc.rect(x + index * 11, y, 7, 7).fill(index < score ? colors.orange : colors.line);
  }
}

function drawDetailHeader(doc: PDFKit.PDFDocument, date: string): void {
  doc.fillColor(colors.ink).font("NotoSC").fontSize(8.5).text("AnalystArena / 前五大市场情报", page.margin, 30, { lineBreak: false });
  doc.fillColor(colors.muted).fontSize(8.5).text(date, page.width - page.margin - 90, 30, { width: 90, align: "right", lineBreak: false });
  doc.moveTo(page.margin, 48).lineTo(page.width - page.margin, 48).strokeColor(colors.ink).lineWidth(1).stroke();
  doc.y = 67;
}

function ensureDetailRoom(doc: PDFKit.PDFDocument, needed: number, date: string): void {
  if (doc.y + needed <= page.height - 72) return;
  doc.addPage();
  drawDetailHeader(doc, date);
}

function boundedTextHeight(
  doc: PDFKit.PDFDocument,
  value: string,
  width: number,
  fontSize: number,
  lineGap: number,
  maxHeight: number,
): number {
  const measured = doc.font("NotoSC").fontSize(fontSize).heightOfString(value, { width, lineGap });
  return Math.min(maxHeight, Math.max(fontSize + 2, Math.ceil(measured) + 1));
}

function equityDirectionColor(direction: EquityImpactDirection): string {
  if (direction === "potential_upside") return colors.upside;
  if (direction === "potential_downside") return colors.downside;
  if (direction === "mixed") return colors.mixed;
  return colors.muted;
}

function drawCover(doc: PDFKit.PDFDocument, brief: DailyBrief, headlines: Headline[]): void {
  doc.save().rect(0, 0, page.width, 176).fill(colors.ink).restore();
  doc.fillColor(colors.acid).font("NotoSC").fontSize(9).text("AnalystArena / 每日市场情报", page.margin, 34);
  doc.fillColor(colors.white).fontSize(31).text("前五大市场情报", page.margin, 61, { width: 430 });
  doc.fillColor("#AEB9B5").fontSize(10).text(`${brief.date}  /  ${brief.status === "published" ? "已发布报告" : "预览报告"}`, page.margin, 113);
  doc.fillColor("#CBD2CF").fontSize(9.5).text("从已验证新闻、官方公告与社交媒体信号中，合并整理出五个与投资人最相关的事件。", page.margin, 139, { width: 470 });

  doc.y = 210;
  doc.fillColor(colors.ink).fontSize(10).text("执行摘要", page.margin, doc.y);
  doc.moveTo(page.margin, doc.y + 17).lineTo(page.width - page.margin, doc.y + 17).strokeColor(colors.ink).lineWidth(1).stroke();
  doc.y += 34;
  doc.fillColor(colors.muted).fontSize(10.5).text(
    pdfText(`本日从 ${brief.stats.candidates} 则采集素材合并为 ${brief.stats.consolidatedEvents} 个事件, 并依市场影响, 时效性, 来源可信度与跨来源验证选出前五大重要新闻.`),
    page.margin,
    doc.y,
    { width: page.width - page.margin * 2, lineGap: 3 },
  );
  doc.y += 36;

  headlines.forEach((headline, index) => {
    const top = doc.y;
    const rowHeight = 68;
    doc.save().rect(page.margin, top, page.width - page.margin * 2, rowHeight - 7).fillAndStroke(index === 0 ? "#F7F9EF" : colors.white, colors.line).restore();
    doc.save().rect(page.margin, top, 48, rowHeight - 7).fill(index === 0 ? colors.ink : colors.pale).restore();
    doc.fillColor(index === 0 ? colors.acid : colors.ink).fontSize(15).text(String(index + 1).padStart(2, "0"), page.margin + 10, top + 15, { width: 28, align: "center" });
    const x = page.margin + 62;
    doc.fillColor(colors.orange).fontSize(8).text(`${headline.ticker} / ${categoryDisplayNames[headline.category]}`, x, top + 10, { width: 260 });
    doc.fillColor(colors.ink).fontSize(11.5).text(pdfText(headline.title, 180), x, top + 25, { width: 360, height: 31, ellipsis: true, lineGap: 1 });
    drawImpact(doc, headline.impact, page.width - page.margin - 59, top + 13);
    doc.y = top + rowHeight;
  });

  doc.fillColor(colors.muted).fontSize(8.5).text("详细事件信息、关键事实、影响判断与原始来源列于后续页面。", page.margin, doc.y + 10, { width: 400 });
}

function drawHeadlineDetail(doc: PDFKit.PDFDocument, headline: Headline, date: string): void {
  const contentWidth = page.width - page.margin * 2;
  const innerWidth = contentWidth - 34;
  const title = pdfText(headline.title, 220);
  const summary = pdfText(headline.summary, 560);
  const impact = pdfText(headline.marketImpact, 560);
  const equityRows = (headline.equityImpacts ?? [])
    .filter((item) => item.reviewStatus !== "rejected" && item.mappingConfidence >= 70)
    .slice(0, 3)
    .map((item) => ({
      direction: item.direction,
      text: pdfText(`${item.symbol} / ${item.direction === "potential_upside" ? "潜在受益" : item.direction === "potential_downside" ? "潜在承压" : item.direction === "mixed" ? "多空并存" : "方向待确认"} / 映射可信度 ${item.mappingConfidence}%: ${item.mechanism}`, 300),
    }));
  const facts = factsFor(headline);
  const termNotes = headline.termNotes?.length ? headline.termNotes : extractTermNotes(headline);
  const termLine = pdfText(termNotes.length ? `英文术语: ${termNotes.map((item) => `${item.term}=${item.note}`).join("; ")}` : "", 420);
  const newsTime = resolveHeadlineTimestamp(headline);
  const timeLine = pdfText(`${formatTimestampLine(newsTime.value, newsTime.kind)}${newsTime.source ? ` / 时间来源: ${sourceDisplayName(newsTime.source)}` : ""}`, 420);
  const sourceLine = pdfText(`来源: ${headline.sources.map((source) => sourceDisplayName(source.name)).join(" / ") || "待补充"}`, 420);

  // Every section has an explicit vertical budget. PDFKit otherwise moves overflowing text
  // to an implicit page, leaving the surrounding card clipped on the previous page.
  const titleHeight = boundedTextHeight(doc, title, innerWidth, 16, 2, 42);
  const termHeight = termLine ? boundedTextHeight(doc, termLine, innerWidth, 8.8, 2, 24) : 0;
  const timeHeight = boundedTextHeight(doc, timeLine, innerWidth - 20, 9.5, 2, 20);
  const summaryHeight = boundedTextHeight(doc, summary, innerWidth, 10.8, 3, 48);
  const factHeights = facts.map((fact) => boundedTextHeight(doc, fact, innerWidth - 22, 10.5, 2, 27));
  const factsHeight = factHeights.reduce((sum, height) => sum + height + 7, 0);
  const impactHeight = boundedTextHeight(doc, impact, innerWidth - 20, 10.5, 2, 48);
  const equityHeights = equityRows.map((row) => boundedTextHeight(doc, row.text, innerWidth - 20, 9.4, 2, 27));
  const equitiesHeight = equityRows.length ? 31 + equityHeights.reduce((sum, height) => sum + height + 7, 0) : 0;
  const blockHeight = 218 + titleHeight + termHeight + (termLine ? 12 : 0) + timeHeight + summaryHeight + factsHeight + impactHeight + equitiesHeight;
  ensureDetailRoom(doc, blockHeight + 14, date);

  const top = doc.y;
  doc.save().rect(page.margin, top, contentWidth, blockHeight).fillAndStroke(colors.white, colors.line).restore();
  doc.save().rect(page.margin, top, 7, blockHeight).fill(headline.rank === 1 ? colors.orange : colors.ink).restore();
  let cursor = top + 17;
  const x = page.margin + 22;

  doc.fillColor(colors.orange).fontSize(8.8).text(`第 ${String(headline.rank).padStart(2, "0")} 名   ${headline.ticker}   ${categoryDisplayNames[headline.category]}`, x, cursor, { width: 310, lineBreak: false });
  doc.fillColor(colors.muted).fontSize(8.8).text(`信心 ${headline.confidence}%`, page.width - page.margin - 150, cursor, { width: 128, align: "right", lineBreak: false });
  drawImpact(doc, headline.impact, page.width - page.margin - 78, cursor + 18);
  cursor += 31;

  doc.fillColor(colors.ink).fontSize(16).text(title, x, cursor, { width: innerWidth, height: titleHeight, lineGap: 2, ellipsis: true });
  cursor += titleHeight + 14;

  if (termLine) {
    doc.fillColor(colors.muted).fontSize(8.8).text(termLine, x, cursor, { width: innerWidth, height: termHeight, lineGap: 2, ellipsis: true });
    cursor += termHeight + 12;
  }

  doc.save().rect(x, cursor, innerWidth, timeHeight + 20).fill(newsTime.kind === "collected" ? "#FFF0E8" : "#EEF6E8").restore();
  doc.fillColor(newsTime.kind === "collected" ? colors.orange : colors.upside).fontSize(9.5).text(timeLine, x + 10, cursor + 9, { width: innerWidth - 20, height: timeHeight, lineGap: 2, ellipsis: true });
  cursor += timeHeight + 31;

  doc.fillColor(colors.orange).fontSize(8.5).text("事件摘要", x, cursor);
  cursor += 16;
  doc.fillColor(colors.muted).fontSize(10.8).text(summary, x, cursor, { width: innerWidth, height: summaryHeight, lineGap: 3, ellipsis: true });
  cursor += summaryHeight + 14;

  doc.fillColor(colors.orange).fontSize(8.5).text("重要信息", x, cursor);
  cursor += 17;
  facts.forEach((fact, index) => {
    doc.save().circle(x + 4, cursor + 5, 3).fill(index === 0 ? colors.orange : colors.ink).restore();
    doc.fillColor(colors.ink).fontSize(10.5).text(fact, x + 17, cursor, { width: innerWidth - 22, height: factHeights[index], lineGap: 2, ellipsis: true });
    cursor += factHeights[index] + 7;
  });
  cursor += 5;

  doc.save().rect(x, cursor, innerWidth, impactHeight + 36).fill(colors.pale).restore();
  doc.fillColor(colors.orange).fontSize(8.5).text("市场影响", x + 10, cursor + 9);
  doc.fillColor(colors.ink).fontSize(10.5).text(impact, x + 10, cursor + 23, { width: innerWidth - 20, height: impactHeight, lineGap: 2, ellipsis: true });
  cursor += impactHeight + 47;

  if (equityRows.length) {
    doc.fillColor(colors.orange).fontSize(8.5).text("关联美股（映射可信度并非上涨概率）", x, cursor);
    cursor += 17;
    equityRows.forEach((row, index) => {
      doc.fillColor(equityDirectionColor(row.direction)).fontSize(9.4).text(row.text, x + 10, cursor, { width: innerWidth - 20, height: equityHeights[index], lineGap: 2, ellipsis: true });
      cursor += equityHeights[index] + 7;
    });
    cursor += 7;
  }

  doc.fillColor(colors.muted).fontSize(8.5).text(sourceLine, x, cursor, { width: innerWidth, lineBreak: false, ellipsis: true });
  doc.y = top + blockHeight + 14;
}

export async function generateBriefPdf(brief: DailyBrief): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: page.margin, right: page.margin, bottom: page.margin, left: page.margin },
    bufferPages: true,
    info: { Title: `AnalystArena 前五大市场情报 ${brief.date}`, Author: "AnalystArena", Subject: "每日前五大市场事件" },
  });
  doc.registerFont("NotoSC", fontPath());
  doc.font("NotoSC");

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const headlines = topFive(brief);
  drawCover(doc, brief, headlines);
  doc.addPage();
  drawDetailHeader(doc, brief.date);
  headlines.forEach((headline) => drawHeadlineDetail(doc, headline, brief.date));

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.moveTo(page.margin, page.height - 66).lineTo(page.width - page.margin, page.height - 66).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.muted).fontSize(7.5).text("信息整理与研究工具, 不构成投资建议. 请由原始来源独立查证.", page.margin, page.height - 57, { width: 410, lineBreak: false });
    doc.text(`${index + 1} / ${range.count}`, page.width - page.margin - 50, page.height - 57, { width: 50, align: "right", lineBreak: false });
  }

  doc.end();
  return complete;
}
