import path from "node:path";
import PDFDocument from "pdfkit";
import type {
  DailyBrief,
  EquityImpactAssessment,
  EquityImpactDirection,
  Headline,
  MarketDirection,
} from "./types";
import {
  equityDirectionPresentation,
  formatReturn,
  headlineDirectionConfidence,
  headlineDirectionPresentation,
  headlineDirectionRationale,
  marketDirectionCounts,
} from "./market-direction";
import { categoryDisplayNames, extractTermNotes, sourceDisplayName } from "./terms";
import { formatBeijingMinute, formatTimestampLine, resolveHeadlineTimestamp } from "./time";

const page = { width: 595.28, height: 841.89, margin: 42 };

// A restrained dark header carries the product identity while the information area stays
// bright and economical to print. Direction colors are always paired with arrows and labels.
const colors = {
  navy: "#0A1220",
  navyRaised: "#111D30",
  navyLine: "#29364C",
  ink: "#101828",
  secondary: "#475467",
  tertiary: "#667085",
  surface: "#F7F8FA",
  surfaceStrong: "#EEF1F5",
  line: "#D9DEE7",
  white: "#FFFFFF",
  accent: "#77E6D1",
  bullish: "#087A60",
  bullishTint: "#EAF7F2",
  bearish: "#C7372F",
  bearishTint: "#FCEDEB",
  mixed: "#9A6700",
  mixedTint: "#FFF5D9",
  neutral: "#5D6675",
  neutralTint: "#EEF1F5",
} as const;

type DirectionTheme = { color: string; tint: string };

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
  return [...brief.headlines].sort((left, right) => left.rank - right.rank).slice(0, 5);
}

function directionTheme(direction: MarketDirection): DirectionTheme {
  if (direction === "bullish") return { color: colors.bullish, tint: colors.bullishTint };
  if (direction === "bearish") return { color: colors.bearish, tint: colors.bearishTint };
  if (direction === "mixed") return { color: colors.mixed, tint: colors.mixedTint };
  return { color: colors.neutral, tint: colors.neutralTint };
}

function equityDirectionTheme(direction: EquityImpactDirection): DirectionTheme {
  if (direction === "potential_upside") return directionTheme("bullish");
  if (direction === "potential_downside") return directionTheme("bearish");
  if (direction === "mixed") return directionTheme("mixed");
  return directionTheme("neutral");
}

function returnColor(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || Math.abs(value) < 0.005) return colors.neutral;
  return value > 0 ? colors.bullish : colors.bearish;
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

function factsFor(headline: Headline): string[] {
  const facts = headline.keyPoints?.map((point) => pdfText(point, 260)).filter(Boolean) ?? [];
  return (facts.length ? facts : [pdfText(headline.summary, 340)]).slice(0, 3);
}

function visibleEquityImpacts(headline: Headline): EquityImpactAssessment[] {
  return (headline.equityImpacts ?? [])
    .filter((item) => {
      const directionConfidence = item.directionConfidence ?? item.mappingConfidence;
      return item.reviewStatus !== "rejected" && Math.min(item.mappingConfidence, directionConfidence) >= 60;
    })
    .slice(0, 3);
}

function needsTranslationPreviewNotice(brief: DailyBrief): boolean {
  if (brief.status === "published") return false;
  if (brief.translationEnabled === false) return true;
  return /(?:翻译|翻譯)[^。；;]{0,24}(?:待人工确认|待人工確認|待确认|待確認|未完成)/.test(brief.warning ?? "");
}

function shortDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "原始链接";
  }
}

function drawMetricDots(doc: PDFKit.PDFDocument, score: number, x: number, y: number, activeColor = colors.ink): void {
  const normalized = Math.max(0, Math.min(5, Math.round(score)));
  for (let index = 0; index < 5; index += 1) {
    doc.save().circle(x + index * 13 + 4, y + 4, 4).fill(index < normalized ? activeColor : colors.line).restore();
  }
}

function drawSectionLabel(doc: PDFKit.PDFDocument, label: string, x: number, y: number): void {
  doc.fillColor(colors.tertiary).font("NotoSC").fontSize(8.2).text(label, x, y, {
    characterSpacing: 0.55,
    lineBreak: false,
  });
}

function drawDirectionPill(
  doc: PDFKit.PDFDocument,
  direction: MarketDirection,
  label: string,
  x: number,
  y: number,
  width: number,
  options: { dark?: boolean; height?: number; align?: "left" | "center" } = {},
): void {
  const theme = directionTheme(direction);
  const darkText = direction === "bullish"
    ? "#69D6B7"
    : direction === "bearish"
      ? "#FF8C84"
      : direction === "mixed"
        ? "#FFD166"
        : "#CAD3DE";
  const height = options.height ?? 28;
  const background = options.dark ? colors.navyRaised : theme.tint;
  const border = options.dark ? darkText : theme.color;
  doc.save().roundedRect(x, y, width, height, height / 2).fillAndStroke(background, border).restore();
  doc.fillColor(options.dark ? darkText : theme.color).font("NotoSC").fontSize(8.8).text(label, x + 10, y + (height - 10) / 2, {
    width: width - 20,
    align: options.align ?? "center",
    lineBreak: false,
  });
}

function drawCoverHeader(doc: PDFKit.PDFDocument, brief: DailyBrief, headlines: Headline[]): void {
  doc.save().rect(0, 0, page.width, 212).fill(colors.navy).restore();
  doc.save().rect(0, 0, 7, 212).fill(colors.accent).restore();

  doc.fillColor(colors.accent).font("NotoSC").fontSize(9).text("AnalystArena", page.margin, 31, {
    characterSpacing: 1.1,
    lineBreak: false,
  });
  doc.fillColor("#AAB7C8").fontSize(8.5).text(brief.status === "published" ? "正式发布" : "审核预览", page.width - page.margin - 90, 32, {
    width: 90,
    align: "right",
    lineBreak: false,
  });

  doc.fillColor(colors.white).fontSize(30).text("每日市场情报", page.margin, 61, { width: 370, lineBreak: false });
  doc.fillColor("#C4CEDB").fontSize(10.2).text(
    `${brief.date}  /  从重要事实到潜在市场传导`,
    page.margin,
    106,
    { width: 420, lineBreak: false },
  );
  doc.fillColor("#8390A2").fontSize(8.3).text(`生成时间: ${formatBeijingMinute(brief.generatedAt)} (北京时间)`, page.margin, 128, {
    width: 420,
    lineBreak: false,
  });

  const counts = marketDirectionCounts(headlines);
  const overview = [
    { direction: "bullish" as const, label: `↑ 利好  ${counts.bullish}` },
    { direction: "bearish" as const, label: `↓ 利空  ${counts.bearish}` },
    { direction: "mixed" as const, label: `↕ 多空  ${counts.mixed}` },
    { direction: "neutral" as const, label: `- 待确认  ${counts.neutral}` },
  ];
  const gap = 8;
  const width = (page.width - page.margin * 2 - gap * 3) / 4;
  overview.forEach((item, index) => {
    drawDirectionPill(doc, item.direction, item.label, page.margin + index * (width + gap), 159, width, { dark: true, height: 31 });
  });
}

function drawCover(doc: PDFKit.PDFDocument, brief: DailyBrief, headlines: Headline[]): void {
  drawCoverHeader(doc, brief, headlines);
  let cursor = 231;

  if (needsTranslationPreviewNotice(brief)) {
    doc.save().roundedRect(page.margin, cursor, page.width - page.margin * 2, 43, 8).fillAndStroke(colors.mixedTint, colors.mixed).restore();
    doc.fillColor(colors.mixed).fontSize(9).text("翻译待确认", page.margin + 13, cursor + 9, { width: 78, lineBreak: false });
    doc.fillColor(colors.ink).fontSize(8.7).text(
      "部分自动翻译仍待人工确认. 本文件仅供预览, 请以原始来源与正式发布版本为准.",
      page.margin + 93,
      cursor + 8,
      { width: page.width - page.margin * 2 - 106, height: 28, lineGap: 2 },
    );
    cursor += 57;
  }

  doc.fillColor(colors.ink).fontSize(15).text("今日必读", page.margin, cursor, { lineBreak: false });
  doc.fillColor(colors.tertiary).fontSize(8.5).text(
    `${brief.stats.candidates} 则素材 → ${brief.stats.consolidatedEvents} 个事件 → 前 ${headlines.length} 大重点`,
    page.width - page.margin - 270,
    cursor + 4,
    { width: 270, align: "right", lineBreak: false },
  );
  cursor += 30;

  const availableHeight = 781 - cursor;
  const rowHeight = Math.min(88, Math.floor(availableHeight / Math.max(1, headlines.length)));
  headlines.forEach((headline, index) => {
    const direction = headlineDirectionPresentation(headline);
    const theme = directionTheme(direction.direction);
    const timestamp = resolveHeadlineTimestamp(headline);
    const top = cursor + index * rowHeight;
    const cardHeight = rowHeight - 8;

    doc.save().roundedRect(page.margin, top, page.width - page.margin * 2, cardHeight, 9).fillAndStroke(index === 0 ? colors.surfaceStrong : colors.surface, colors.line).restore();
    doc.save().roundedRect(page.margin, top, 6, cardHeight, 3).fill(theme.color).restore();

    doc.fillColor(index === 0 ? colors.ink : colors.secondary).fontSize(17).text(String(index + 1).padStart(2, "0"), page.margin + 17, top + 16, {
      width: 29,
      align: "center",
      lineBreak: false,
    });
    const contentX = page.margin + 62;
    doc.fillColor(colors.tertiary).fontSize(7.8).text(`${headline.ticker}  /  ${categoryDisplayNames[headline.category]}`, contentX, top + 10, {
      width: 245,
      lineBreak: false,
    });
    doc.fillColor(colors.ink).fontSize(11.5).text(pdfText(headline.title, 170), contentX, top + 25, {
      width: 330,
      height: 29,
      ellipsis: true,
      lineGap: 1.5,
    });
    const time = timestamp.value ? formatBeijingMinute(timestamp.value) : "时间待确认";
    doc.fillColor(colors.tertiary).fontSize(7.5).text(`${time}  /  ${headline.sources.length} 个来源`, contentX, top + cardHeight - 17, {
      width: 315,
      lineBreak: false,
    });

    drawDirectionPill(doc, direction.direction, `${direction.symbol} ${direction.compactLabel}`, page.width - page.margin - 92, top + 10, 76, { height: 24 });
    doc.fillColor(colors.tertiary).fontSize(7.4).text(`影响 ${headline.impact}/5`, page.width - page.margin - 92, top + 42, {
      width: 76,
      align: "center",
      lineBreak: false,
    });
  });

  doc.fillColor(colors.tertiary).fontSize(7.6).text("方向表示事件的潜在传导, 不代表价格一定上涨或下跌. 详细依据与实际行情见后续页面.", page.margin, 787, {
    width: page.width - page.margin * 2,
    lineBreak: false,
  });
}

function drawDetailHeader(doc: PDFKit.PDFDocument, brief: DailyBrief, index: number, total: number): void {
  doc.save().rect(0, 0, page.width, 96).fill(colors.navy).restore();
  doc.save().rect(0, 0, 7, 96).fill(colors.accent).restore();
  doc.fillColor(colors.accent).font("NotoSC").fontSize(8.6).text("AnalystArena / 每日市场情报", page.margin, 28, {
    characterSpacing: 0.6,
    lineBreak: false,
  });
  doc.fillColor(colors.white).fontSize(17).text(`事件 ${String(index).padStart(2, "0")}`, page.margin, 49, { lineBreak: false });
  doc.fillColor("#AAB7C8").fontSize(8.4).text(`${brief.date}  /  ${index} of ${total}`, page.width - page.margin - 120, 31, {
    width: 120,
    align: "right",
    lineBreak: false,
  });
  doc.fillColor("#D2D9E3").fontSize(8).text("前五大市场事件详细解读", page.width - page.margin - 165, 55, {
    width: 165,
    align: "right",
    lineBreak: false,
  });
}

function drawDirectionCard(doc: PDFKit.PDFDocument, headline: Headline, y: number): void {
  const direction = headlineDirectionPresentation(headline);
  const confidence = headlineDirectionConfidence(headline);
  const rationale = pdfText(headlineDirectionRationale(headline), 310);
  const theme = directionTheme(direction.direction);
  const width = page.width - page.margin * 2;

  doc.save().roundedRect(page.margin, y, width, 82, 10).fillAndStroke(theme.tint, theme.color).restore();
  doc.save().roundedRect(page.margin, y, 7, 82, 4).fill(theme.color).restore();
  doc.fillColor(theme.color).fontSize(17).text(`${direction.symbol} ${direction.label}`, page.margin + 20, y + 15, {
    width: 145,
    lineBreak: false,
  });
  doc.fillColor(theme.color).fontSize(8).text("事件潜在方向", page.margin + 21, y + 47, { width: 105, lineBreak: false });
  doc.fillColor(colors.secondary).fontSize(9.2).text(rationale, page.margin + 178, y + 14, {
    width: width - 298,
    height: 48,
    lineGap: 2.5,
    ellipsis: true,
  });
  doc.fillColor(colors.secondary).fontSize(8).text(`方向证据 ${confidence}%`, page.width - page.margin - 105, y + 17, {
    width: 88,
    align: "right",
    lineBreak: false,
  });
  doc.fillColor(colors.tertiary).fontSize(7.2).text("不是涨跌概率", page.width - page.margin - 105, y + 35, {
    width: 88,
    align: "right",
    lineBreak: false,
  });
}

function drawDecisionMetrics(doc: PDFKit.PDFDocument, headline: Headline, x: number, y: number, width: number): void {
  doc.save().roundedRect(x, y, width, 84, 9).fillAndStroke(colors.surface, colors.line).restore();
  drawSectionLabel(doc, "判断指标", x + 12, y + 11);
  doc.fillColor(colors.ink).fontSize(8.6).text("市场影响", x + 12, y + 31, { lineBreak: false });
  drawMetricDots(doc, headline.impact, x + width - 81, y + 33, colors.ink);
  doc.fillColor(colors.secondary).fontSize(8.3).text("资料可信度", x + 12, y + 55, { lineBreak: false });
  doc.fillColor(colors.ink).fontSize(9.5).text(`${headline.confidence}%`, x + width - 49, y + 54, {
    width: 37,
    align: "right",
    lineBreak: false,
  });
}

function drawEquityTable(doc: PDFKit.PDFDocument, headline: Headline, y: number): void {
  const equities = visibleEquityImpacts(headline);
  const x = page.margin;
  const width = page.width - page.margin * 2;
  const columns = { symbol: 62, expected: 105, confidence: 82, actual1d: 66, actual5d: 66 };
  const actualWidth = columns.actual1d + columns.actual5d;
  const mechanismWidth = width - columns.symbol - columns.expected - columns.confidence - actualWidth;

  drawSectionLabel(doc, "关联美股", x, y);
  doc.fillColor(colors.tertiary).fontSize(7.3).text("预期传导与实际行情分开呈现; 实际涨跌不证明新闻因果.", x + 86, y, {
    width: width - 86,
    align: "right",
    lineBreak: false,
  });
  const headerY = y + 18;
  doc.save().roundedRect(x, headerY, width, 22, 5).fill(colors.surfaceStrong).restore();
  let cursor = x;
  const headers: Array<[string, number, "left" | "center"]> = [
    ["股票", columns.symbol, "left"],
    ["预期传导", columns.expected, "left"],
    ["证据", columns.confidence, "center"],
    ["实际 1 日", columns.actual1d, "center"],
    ["实际 5 日", columns.actual5d, "center"],
    ["传导逻辑", mechanismWidth, "left"],
  ];
  headers.forEach(([label, columnWidth, align]) => {
    doc.fillColor(colors.secondary).fontSize(7.2).text(label, cursor + 7, headerY + 7, {
      width: columnWidth - 14,
      align,
      lineBreak: false,
    });
    cursor += columnWidth;
  });

  if (!equities.length) {
    doc.save().roundedRect(x, headerY + 28, width, 32, 5).fillAndStroke(colors.surface, colors.line).restore();
    doc.fillColor(colors.tertiary).fontSize(8.3).text("暂无达到展示门槛的股票影响判断", x + 12, headerY + 39, {
      width: width - 24,
      align: "center",
      lineBreak: false,
    });
    return;
  }

  equities.forEach((item, index) => {
    const direction = equityDirectionPresentation(item.direction);
    const theme = equityDirectionTheme(item.direction);
    const rowY = headerY + 27 + index * 35;
    const rowHeight = 30;
    doc.save().roundedRect(x, rowY, width, rowHeight, 5).fillAndStroke(index % 2 === 0 ? colors.white : colors.surface, colors.line).restore();
    doc.save().roundedRect(x, rowY, 4, rowHeight, 2).fill(theme.color).restore();

    cursor = x;
    doc.fillColor(colors.ink).fontSize(8.8).text(pdfText(item.symbol, 12), cursor + 9, rowY + 10, {
      width: columns.symbol - 15,
      lineBreak: false,
    });
    cursor += columns.symbol;
    doc.fillColor(theme.color).fontSize(7.9).text(`${direction.symbol} ${direction.compactLabel}`, cursor + 7, rowY + 10, {
      width: columns.expected - 14,
      lineBreak: false,
    });
    cursor += columns.expected;
    const effectiveConfidence = Math.min(item.mappingConfidence, item.directionConfidence ?? item.mappingConfidence);
    doc.fillColor(colors.secondary).fontSize(7.8).text(`${effectiveConfidence}%`, cursor + 7, rowY + 10, {
      width: columns.confidence - 14,
      align: "center",
      lineBreak: false,
    });
    cursor += columns.confidence;
    const return1d = item.marketContext?.return1dPct;
    doc.fillColor(returnColor(return1d)).fontSize(8.2).text(formatReturn(return1d), cursor + 4, rowY + 10, {
      width: columns.actual1d - 8,
      align: "center",
      lineBreak: false,
    });
    cursor += columns.actual1d;
    const return5d = item.marketContext?.return5dPct;
    doc.fillColor(returnColor(return5d)).fontSize(8.2).text(formatReturn(return5d), cursor + 4, rowY + 10, {
      width: columns.actual5d - 8,
      align: "center",
      lineBreak: false,
    });
    cursor += columns.actual5d;
    doc.fillColor(colors.secondary).fontSize(7.4).text(pdfText(item.mechanism, 95), cursor + 7, rowY + 7, {
      width: mechanismWidth - 14,
      height: 18,
      lineGap: 1,
      ellipsis: true,
    });
  });

  const asOfDates = [...new Set(equities.map((item) => item.marketContext?.asOf).filter(Boolean))];
  if (asOfDates.length) {
    doc.fillColor(colors.tertiary).fontSize(7).text(`实际行情截至 ${asOfDates.join(" / ")}`, x, headerY + 27 + equities.length * 35, {
      width,
      align: "right",
      lineBreak: false,
    });
  }
}

function drawSources(doc: PDFKit.PDFDocument, headline: Headline, y: number): void {
  const x = page.margin;
  const width = page.width - page.margin * 2;
  const sources = headline.sources.slice(0, 3);
  const termNotes = headline.termNotes?.length ? headline.termNotes : extractTermNotes(headline);
  drawSectionLabel(doc, "来源与术语", x, y);
  let cursor = y + 16;

  sources.forEach((source, index) => {
    const label = pdfText(`${index + 1}. ${sourceDisplayName(source.name)}  /  ${shortDomain(source.url)}`, 105);
    doc.fillColor(colors.secondary).fontSize(7.7).text(label, x, cursor, {
      width,
      height: 13,
      lineBreak: false,
      ellipsis: true,
      link: /^https?:\/\//i.test(source.url) ? source.url : undefined,
      underline: false,
    });
    cursor += 15;
  });

  if (!sources.length) {
    doc.fillColor(colors.tertiary).fontSize(7.7).text("来源待补充", x, cursor, { lineBreak: false });
    cursor += 15;
  }

  if (termNotes.length) {
    const note = pdfText(`术语注释: ${termNotes.slice(0, 4).map((item) => `${item.term} = ${item.note}`).join("; ")}`, 250);
    doc.fillColor(colors.tertiary).fontSize(7.3).text(note, x, Math.min(cursor + 2, y + 63), {
      width,
      height: 13,
      lineBreak: false,
      ellipsis: true,
    });
  }
}

function drawHeadlineDetail(doc: PDFKit.PDFDocument, brief: DailyBrief, headline: Headline, index: number, total: number): void {
  doc.addPage();
  drawDetailHeader(doc, brief, index, total);

  const timestamp = resolveHeadlineTimestamp(headline);
  const metaY = 113;
  doc.fillColor(colors.secondary).fontSize(8.4).text(`${headline.ticker}  /  ${categoryDisplayNames[headline.category]}`, page.margin, metaY, {
    width: 210,
    lineBreak: false,
  });
  const timestampLine = pdfText(
    `${formatTimestampLine(timestamp.value, timestamp.kind)}${timestamp.source ? ` / ${sourceDisplayName(timestamp.source)}` : ""}`,
    150,
  );
  doc.fillColor(colors.tertiary).fontSize(7.6).text(timestampLine, page.margin + 205, metaY + 1, {
    width: page.width - page.margin * 2 - 205,
    align: "right",
    lineBreak: false,
    ellipsis: true,
  });

  const title = pdfText(headline.title, 220);
  const titleHeight = boundedTextHeight(doc, title, page.width - page.margin * 2, 20, 3, 52);
  doc.fillColor(colors.ink).fontSize(20).text(title, page.margin, 137, {
    width: page.width - page.margin * 2,
    height: titleHeight,
    lineGap: 3,
    ellipsis: true,
  });

  drawDirectionCard(doc, headline, 206);

  const leftX = page.margin;
  const leftWidth = 322;
  const rightX = leftX + leftWidth + 17;
  const rightWidth = page.width - page.margin - rightX;
  const mainY = 310;
  drawSectionLabel(doc, "事件摘要", leftX, mainY);
  const summary = pdfText(headline.summary, 460);
  doc.fillColor(colors.secondary).fontSize(9.7).text(summary, leftX, mainY + 17, {
    width: leftWidth,
    height: 63,
    lineGap: 3,
    ellipsis: true,
  });

  const facts = factsFor(headline);
  drawSectionLabel(doc, "关键信息", leftX, mainY + 94);
  let factY = mainY + 113;
  facts.forEach((fact, factIndex) => {
    const factHeight = boundedTextHeight(doc, fact, leftWidth - 20, 8.9, 2, 34);
    doc.save().circle(leftX + 4, factY + 5, 3).fill(factIndex === 0 ? colors.ink : colors.tertiary).restore();
    doc.fillColor(colors.ink).fontSize(8.9).text(fact, leftX + 16, factY, {
      width: leftWidth - 20,
      height: factHeight,
      lineGap: 2,
      ellipsis: true,
    });
    factY += 39;
  });

  drawDecisionMetrics(doc, headline, rightX, mainY, rightWidth);
  drawSectionLabel(doc, "市场影响", rightX, mainY + 103);
  doc.save().roundedRect(rightX, mainY + 121, rightWidth, 111, 9).fillAndStroke(colors.surface, colors.line).restore();
  doc.fillColor(colors.ink).fontSize(8.7).text(pdfText(headline.marketImpact, 390), rightX + 12, mainY + 133, {
    width: rightWidth - 24,
    height: 84,
    lineGap: 2.5,
    ellipsis: true,
  });

  drawEquityTable(doc, headline, 556);
  drawSources(doc, headline, 704);
}

function drawFooters(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    // Keep the footer inside PDFKit's bottom margin. Text placed below the content
    // boundary silently creates an extra page even when explicit coordinates are used.
    const footerLineY = page.height - 36;
    const footerTextY = page.height - 27;
    doc.moveTo(page.margin, footerLineY).lineTo(page.width - page.margin, footerLineY).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.tertiary).font("NotoSC").fontSize(6.9).text(
      "信息整理与研究工具, 不构成投资建议. 请从原始来源独立查证.",
      page.margin,
      footerTextY,
      { width: 390, lineBreak: false },
    );
    doc.fillColor(colors.tertiary).text(`${index + 1} / ${range.count}`, page.width - page.margin - 55, footerTextY, {
      width: 55,
      align: "right",
      lineBreak: false,
    });
  }
}

export async function generateBriefPdf(brief: DailyBrief): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    // A small PDFKit bottom margin lets us position a controlled footer inside the
    // physical page without triggering its automatic overflow pagination.
    margins: { top: page.margin, right: page.margin, bottom: 10, left: page.margin },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `AnalystArena 每日市场情报 ${brief.date}`,
      Author: "AnalystArena",
      Subject: "每日前五大市场事件与潜在传导",
    },
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
  headlines.forEach((headline, index) => drawHeadlineDetail(doc, brief, headline, index + 1, headlines.length));
  drawFooters(doc);

  doc.end();
  return complete;
}
