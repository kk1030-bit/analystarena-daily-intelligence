import path from "node:path";
import PDFDocument from "pdfkit";
import type { DailyBrief, Headline } from "./types";

const page = { width: 595.28, height: 841.89, margin: 42 };
const colors = { ink: "#151A1C", muted: "#596362", acid: "#CFFF4F", orange: "#FF6B35", pale: "#F0F2EC", line: "#D6DAD2" };

function pdfText(value: string): string {
  return value
    .replace(/[，、]/g, ", ")
    .replace(/。/g, ". ")
    .replace(/；/g, "; ")
    .replace(/：/g, ": ")
    .replace(/[「」『』“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

function fontPath(): string {
  return path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-tc", "files", "noto-sans-tc-chinese-traditional-400-normal.woff");
}

function ensureRoom(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > page.height - 58) doc.addPage();
}

function drawImpact(doc: PDFKit.PDFDocument, score: number, x: number, y: number): void {
  for (let index = 0; index < 5; index += 1) {
    doc.rect(x + index * 9, y, 6, 6).fill(index < score ? colors.orange : colors.line);
  }
}

function drawHeadline(doc: PDFKit.PDFDocument, headline: Headline): void {
  const contentWidth = page.width - page.margin * 2;
  const title = pdfText(headline.title);
  const summary = pdfText(headline.summary);
  const marketImpact = pdfText(headline.marketImpact);
  const titleHeight = doc.font("NotoTC").fontSize(14).heightOfString(title, { width: contentWidth - 72 });
  const summaryHeight = doc.fontSize(8.8).heightOfString(summary, { width: contentWidth - 76, lineGap: 2 });
  const impactHeight = doc.fontSize(8.2).heightOfString(marketImpact, { width: contentWidth - 100, lineGap: 1 });
  const blockHeight = Math.max(112, titleHeight + summaryHeight + impactHeight + 70);
  ensureRoom(doc, blockHeight);
  const top = doc.y;

  doc.save().rect(page.margin, top, contentWidth, blockHeight - 8).fillAndStroke("#FFFFFF", colors.line).restore();
  doc.save().rect(page.margin, top, 52, blockHeight - 8).fill(colors.ink).restore();
  doc.fillColor("#FFFFFF").fontSize(17).text(String(headline.rank).padStart(2, "0"), page.margin + 15, top + 18, { width: 26, align: "center" });
  doc.fillColor(colors.acid).fontSize(7).text(headline.ticker, page.margin + 7, top + 47, { width: 38, align: "center" });

  const x = page.margin + 66;
  const width = contentWidth - 80;
  doc.fillColor(colors.muted).fontSize(7.2).text(`${headline.category.toUpperCase()}  ·  ${headline.confidence}% CONFIDENCE`, x, top + 13, { width });
  drawImpact(doc, headline.impact, page.width - page.margin - 52, top + 14);
  doc.fillColor(colors.ink).fontSize(14).text(title, x, top + 31, { width, lineGap: 1 });
  const afterTitle = doc.y + 8;
  doc.fillColor(colors.muted).fontSize(8.8).text(summary, x, afterTitle, { width, lineGap: 2 });
  const impactTop = doc.y + 8;
  doc.save().rect(x, impactTop, width, impactHeight + 14).fill(colors.pale).restore();
  doc.fillColor(colors.orange).fontSize(6.6).text("MARKET IMPACT", x + 7, impactTop + 6, { width: 74 });
  doc.fillColor(colors.ink).fontSize(8.2).text(marketImpact, x + 82, impactTop + 5, { width: width - 90, lineGap: 1 });
  doc.y = top + blockHeight;
}

export async function generateBriefPdf(brief: DailyBrief): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: page.margin, right: page.margin, bottom: page.margin, left: page.margin },
    bufferPages: true,
    info: { Title: `AnalystArena Daily Intelligence ${brief.date}`, Author: "AnalystArena", Subject: "Daily market intelligence" },
  });
  doc.registerFont("NotoTC", fontPath());
  doc.font("NotoTC");

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.save().rect(0, 0, page.width, 116).fill(colors.ink).restore();
  doc.fillColor(colors.acid).fontSize(8).text("ANALYSTARENA · TAIPEI EDITION", page.margin, 29);
  doc.fillColor("#FFFFFF").fontSize(28).text("Daily Intelligence", page.margin, 48);
  doc.fillColor("#AAB5B2").fontSize(8).text(`${brief.date}  ·  ${brief.status === "published" ? "PUBLISHED" : "DRAFT"}`, page.margin, 88);
  doc.y = 136;

  doc.fillColor(colors.ink).fontSize(9).text("EXECUTIVE SIGNAL", page.margin, doc.y);
  doc.moveTo(page.margin, doc.y + 14).lineTo(page.width - page.margin, doc.y + 14).strokeColor(colors.ink).lineWidth(1).stroke();
  doc.moveDown(1.4);
  doc.fillColor(colors.muted).fontSize(9).text(
    `今日從 ${brief.stats.candidates} 則素材合併為 ${brief.stats.consolidatedEvents} 個事件, 依時效性, 跨來源數量, 可信度與分類配額選出 ${brief.headlines.length} 則核心頭條.`,
    { lineGap: 2 },
  );
  doc.moveDown(1.3);

  for (const headline of brief.headlines) drawHeadline(doc, headline);

  ensureRoom(doc, 170);
  doc.fillColor(colors.ink).fontSize(11).text("NEXT SESSION / 明日觀察", page.margin, doc.y);
  doc.moveDown(0.7);
  for (const item of brief.watchlist) {
    doc.fillColor(colors.orange).fontSize(7).text(item.time, page.margin, doc.y, { continued: true });
    doc.fillColor(colors.ink).fontSize(9).text(`   ${pdfText(item.event)}`);
    doc.fillColor(colors.muted).fontSize(7.8).text(pdfText(item.why), page.margin + 54, doc.y + 2, { width: page.width - page.margin * 2 - 54 });
    doc.moveDown(0.6);
  }

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.moveTo(page.margin, page.height - 60).lineTo(page.width - page.margin, page.height - 60).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.muted).fontSize(6.5).text("資訊整理與研究工具, 不構成投資建議. 請由原始來源獨立查證.", page.margin, page.height - 52, { width: 390, lineBreak: false });
    doc.text(`${index + 1} / ${range.count}`, page.width - page.margin - 50, page.height - 52, { width: 50, align: "right", lineBreak: false });
  }

  doc.end();
  return complete;
}
