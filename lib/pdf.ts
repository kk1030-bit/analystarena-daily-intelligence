import path from "node:path";
import PDFDocument from "pdfkit";
import type { DailyBrief, Headline } from "./types";

const page = { width: 595.28, height: 841.89, margin: 44 };
const colors = {
  ink: "#151A1C",
  muted: "#596362",
  acid: "#CFFF4F",
  orange: "#FF6B35",
  pale: "#F1F3ED",
  line: "#D4D9D2",
  white: "#FFFFFF",
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
  return path.join(process.cwd(), "assets", "fonts", "NotoSansTC-Regular.ttf");
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
  doc.fillColor(colors.ink).font("NotoTC").fontSize(8.5).text("ANALYSTARENA / TOP 5 MARKET INTELLIGENCE", page.margin, 30, { lineBreak: false });
  doc.fillColor(colors.muted).fontSize(8.5).text(date, page.width - page.margin - 90, 30, { width: 90, align: "right", lineBreak: false });
  doc.moveTo(page.margin, 48).lineTo(page.width - page.margin, 48).strokeColor(colors.ink).lineWidth(1).stroke();
  doc.y = 67;
}

function ensureDetailRoom(doc: PDFKit.PDFDocument, needed: number, date: string): void {
  if (doc.y + needed <= page.height - 72) return;
  doc.addPage();
  drawDetailHeader(doc, date);
}

function drawCover(doc: PDFKit.PDFDocument, brief: DailyBrief, headlines: Headline[]): void {
  doc.save().rect(0, 0, page.width, 176).fill(colors.ink).restore();
  doc.fillColor(colors.acid).font("NotoTC").fontSize(9).text("ANALYSTARENA / TAIPEI EDITION", page.margin, 34);
  doc.fillColor(colors.white).fontSize(31).text("Top 5 Market Intelligence", page.margin, 61, { width: 430 });
  doc.fillColor("#AEB9B5").fontSize(10).text(`${brief.date}  /  ${brief.status === "published" ? "PUBLISHED REPORT" : "PREVIEW REPORT"}`, page.margin, 113);
  doc.fillColor("#CBD2CF").fontSize(9.5).text("Five investor-relevant events, consolidated from verified news, official releases and social signals.", page.margin, 139, { width: 470 });

  doc.y = 210;
  doc.fillColor(colors.ink).fontSize(10).text("EXECUTIVE OVERVIEW", page.margin, doc.y);
  doc.moveTo(page.margin, doc.y + 17).lineTo(page.width - page.margin, doc.y + 17).strokeColor(colors.ink).lineWidth(1).stroke();
  doc.y += 34;
  doc.fillColor(colors.muted).fontSize(10.5).text(
    pdfText(`本日從 ${brief.stats.candidates} 則蒐集素材合併為 ${brief.stats.consolidatedEvents} 個事件, 並依市場影響, 時效性, 來源可信度與跨來源驗證選出前五大重要新聞.`),
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
    doc.fillColor(colors.orange).fontSize(8).text(`${headline.ticker} / ${headline.category}`, x, top + 10, { width: 220 });
    doc.fillColor(colors.ink).fontSize(11.5).text(pdfText(headline.title, 180), x, top + 25, { width: 360, height: 31, ellipsis: true, lineGap: 1 });
    drawImpact(doc, headline.impact, page.width - page.margin - 59, top + 13);
    doc.y = top + rowHeight;
  });

  doc.fillColor(colors.muted).fontSize(8.5).text("詳細事件資訊、關鍵事實、影響判斷與原始來源列於後續頁面。", page.margin, doc.y + 10, { width: 400 });
}

function drawHeadlineDetail(doc: PDFKit.PDFDocument, headline: Headline, date: string): void {
  const contentWidth = page.width - page.margin * 2;
  const innerWidth = contentWidth - 34;
  const title = pdfText(headline.title, 220);
  const summary = pdfText(headline.summary, 560);
  const impact = pdfText(headline.marketImpact, 560);
  const facts = factsFor(headline);
  const sourceLine = pdfText(`來源: ${headline.sources.map((source) => source.name).join(" / ") || "待補充"}`, 360);

  const titleHeight = doc.font("NotoTC").fontSize(16).heightOfString(title, { width: innerWidth, lineGap: 2 });
  const summaryHeight = doc.fontSize(10.8).heightOfString(summary, { width: innerWidth, lineGap: 3 });
  const factHeights = facts.map((fact) => doc.fontSize(10.5).heightOfString(fact, { width: innerWidth - 22, lineGap: 2 }));
  const factsHeight = factHeights.reduce((sum, height) => sum + height + 7, 0);
  const impactHeight = doc.fontSize(10.5).heightOfString(impact, { width: innerWidth - 18, lineGap: 2 });
  const blockHeight = 191 + titleHeight + summaryHeight + factsHeight + impactHeight;
  ensureDetailRoom(doc, blockHeight + 14, date);

  const top = doc.y;
  doc.save().rect(page.margin, top, contentWidth, blockHeight).fillAndStroke(colors.white, colors.line).restore();
  doc.save().rect(page.margin, top, 7, blockHeight).fill(headline.rank === 1 ? colors.orange : colors.ink).restore();
  let cursor = top + 17;
  const x = page.margin + 22;

  doc.fillColor(colors.orange).fontSize(8.8).text(`NO. ${String(headline.rank).padStart(2, "0")}   ${headline.ticker}   ${headline.category.toUpperCase()}`, x, cursor, { width: 270, lineBreak: false });
  doc.fillColor(colors.muted).fontSize(8.8).text(`CONFIDENCE ${headline.confidence}%`, page.width - page.margin - 150, cursor, { width: 128, align: "right", lineBreak: false });
  drawImpact(doc, headline.impact, page.width - page.margin - 78, cursor + 18);
  cursor += 31;

  doc.fillColor(colors.ink).fontSize(16).text(title, x, cursor, { width: innerWidth, lineGap: 2 });
  cursor += titleHeight + 14;

  doc.fillColor(colors.orange).fontSize(8.5).text("事件摘要", x, cursor);
  cursor += 16;
  doc.fillColor(colors.muted).fontSize(10.8).text(summary, x, cursor, { width: innerWidth, lineGap: 3 });
  cursor += summaryHeight + 14;

  doc.fillColor(colors.orange).fontSize(8.5).text("重要資訊", x, cursor);
  cursor += 17;
  facts.forEach((fact, index) => {
    doc.save().circle(x + 4, cursor + 5, 3).fill(index === 0 ? colors.orange : colors.ink).restore();
    doc.fillColor(colors.ink).fontSize(10.5).text(fact, x + 17, cursor, { width: innerWidth - 22, lineGap: 2 });
    cursor += factHeights[index] + 7;
  });
  cursor += 5;

  doc.save().rect(x, cursor, innerWidth, impactHeight + 36).fill(colors.pale).restore();
  doc.fillColor(colors.orange).fontSize(8.5).text("市場影響", x + 10, cursor + 9);
  doc.fillColor(colors.ink).fontSize(10.5).text(impact, x + 10, cursor + 23, { width: innerWidth - 20, lineGap: 2 });
  cursor += impactHeight + 47;

  doc.fillColor(colors.muted).fontSize(8.5).text(sourceLine, x, cursor, { width: innerWidth, lineBreak: false, ellipsis: true });
  doc.y = top + blockHeight + 14;
}

export async function generateBriefPdf(brief: DailyBrief): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: page.margin, right: page.margin, bottom: page.margin, left: page.margin },
    bufferPages: true,
    info: { Title: `AnalystArena Top 5 Market Intelligence ${brief.date}`, Author: "AnalystArena", Subject: "Top five daily market events" },
  });
  doc.registerFont("NotoTC", fontPath());
  doc.font("NotoTC");

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
    doc.fillColor(colors.muted).fontSize(7.5).text("資訊整理與研究工具, 不構成投資建議. 請由原始來源獨立查證.", page.margin, page.height - 57, { width: 410, lineBreak: false });
    doc.text(`${index + 1} / ${range.count}`, page.width - page.margin - 50, page.height - 57, { width: 50, align: "right", lineBreak: false });
  }

  doc.end();
  return complete;
}
