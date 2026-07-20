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
import {
  affectedScopes,
  flattenSignals,
  headlineEvidence,
  headlineRiskFlags,
  resolveSignalHeadline,
  signalStrength,
  sortedSources,
  sourceTypeLabel,
} from "./investor-view";
import { categoryDisplayNames, extractTermNotes, sourceDisplayName } from "./terms";
import { formatBeijingMinute, formatTimestampLine, resolveHeadlineTimestamp, timestampLabel } from "./time";

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

function pdfFullText(value: string): string {
  return pdfText(value, Number.MAX_SAFE_INTEGER);
}

function fontPath(): string {
  return path.join(process.cwd(), "assets", "fonts", "NotoSansSC-Regular.ttf");
}

function orderedHeadlines(brief: DailyBrief): Headline[] {
  return [...brief.headlines].sort((left, right) => left.rank - right.rank);
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

function factsFor(headline: Headline): string[] {
  const facts = headline.keyPoints?.map((point) => pdfFullText(point)).filter(Boolean) ?? [];
  return facts.length ? facts : [pdfFullText(headline.summary)];
}

function visibleEquityImpacts(headline: Headline): EquityImpactAssessment[] {
  return (headline.equityImpacts ?? [])
    .filter((item) => item.reviewStatus !== "rejected");
}

type EquityImpactGroups = {
  upside: EquityImpactAssessment[];
  downside: EquityImpactAssessment[];
  mixed: EquityImpactAssessment[];
  unclear: EquityImpactAssessment[];
};

function groupEquityImpacts(headline: Headline): EquityImpactGroups {
  const groups: EquityImpactGroups = { upside: [], downside: [], mixed: [], unclear: [] };
  visibleEquityImpacts(headline).forEach((item) => {
    if (item.direction === "potential_upside") groups.upside.push(item);
    else if (item.direction === "potential_downside") groups.downside.push(item);
    else if (item.direction === "mixed") groups.mixed.push(item);
    else groups.unclear.push(item);
  });
  return groups;
}

function equityReviewLabel(item: EquityImpactAssessment): string {
  if (item.reviewStatus === "approved") return "人工已批准";
  if (item.reviewStatus === "edited") return "人工已调整";
  return "待人工复核";
}

function equityMappingEmptyMessage(headline: Headline): string {
  if (!Array.isArray(headline.equityImpacts)) return "股票映射尚未完成，不能据此判断利好或利空标的";
  if (!headline.equityImpacts.length) return "股票映射已完成，暂未找到可安全关联的美国股票";
  return "相关股票已在人工审核中驳回，本期不列为利好或利空标的";
}

function compactEquityTargetSummary(headline: Headline): string {
  const groups = groupEquityImpacts(headline);
  const segments = [
    groups.upside.length ? `利好 ${groups.upside.map((item) => item.symbol).join(", ")}` : "",
    groups.downside.length ? `利空 ${groups.downside.map((item) => item.symbol).join(", ")}` : "",
    groups.mixed.length ? `多空 ${groups.mixed.map((item) => item.symbol).join(", ")}` : "",
    groups.unclear.length ? `待确认 ${groups.unclear.map((item) => item.symbol).join(", ")}` : "",
  ].filter(Boolean);
  if (segments.length) return segments.join(" / ");
  if (!Array.isArray(headline.equityImpacts)) return "标的映射待完成";
  if (!headline.equityImpacts.length) return "暂无数据库可验证标的";
  return "相关标的已由人工审核驳回";
}

function equityTargetList(items: EquityImpactAssessment[]): string {
  return items.map((item) => {
    const directionConfidence = item.directionConfidence === undefined ? "-" : `${item.directionConfidence}%`;
    return `${item.symbol} / ${item.companyName} (关联 ${item.mappingConfidence}%, 方向 ${directionConfidence}, ${equityReviewLabel(item)})`;
  }).join("; ");
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
    `${brief.stats.candidates} 则素材 → ${brief.stats.consolidatedEvents} 个事件 → ${headlines.length} 项市场头条`,
    page.width - page.margin - 270,
    cursor + 4,
    { width: 270, align: "right", lineBreak: false },
  );
  cursor += 30;

  const availableHeight = 781 - cursor;
  const rowHeight = Math.min(88, Math.max(58, Math.floor(availableHeight / Math.max(1, headlines.length))));
  headlines.forEach((headline, index) => {
    const direction = headlineDirectionPresentation(headline);
    const theme = directionTheme(direction.direction);
    const timestamp = resolveHeadlineTimestamp(headline);
    const top = cursor + index * rowHeight;
    const cardHeight = rowHeight - 8;
    const compact = rowHeight < 70;
    const targetSummary = compactEquityTargetSummary(headline);

    doc.save().roundedRect(page.margin, top, page.width - page.margin * 2, cardHeight, 9).fillAndStroke(index === 0 ? colors.surfaceStrong : colors.surface, colors.line).restore();
    doc.save().roundedRect(page.margin, top, 6, cardHeight, 3).fill(theme.color).restore();

    doc.fillColor(index === 0 ? colors.ink : colors.secondary).fontSize(compact ? 14 : 17).text(String(headline.rank).padStart(2, "0"), page.margin + 17, top + (compact ? 13 : 16), {
      width: 29,
      align: "center",
      lineBreak: false,
    });
    const contentX = page.margin + 62;
    doc.fillColor(colors.tertiary).fontSize(compact ? 7.1 : 7.8).text(`${headline.ticker}  /  ${categoryDisplayNames[headline.category]}`, contentX, top + (compact ? 7 : 10), {
      width: 245,
      lineBreak: false,
    });
    doc.fillColor(colors.ink).fontSize(compact ? 9.4 : 11.5).text(pdfText(headline.title, 170), contentX, top + (compact ? 19 : 25), {
      width: 330,
      height: compact ? 15 : 29,
      ellipsis: true,
      lineGap: 1.5,
    });
    doc.fillColor(colors.secondary).fontSize(compact ? 6.4 : 6.8).text(pdfText(targetSummary, 150), contentX, top + cardHeight - (compact ? 22 : 25), {
      width: 315,
      height: 9,
      ellipsis: true,
      lineBreak: false,
    });
    const time = timestamp.value ? formatBeijingMinute(timestamp.value) : "时间待确认";
    doc.fillColor(colors.tertiary).fontSize(compact ? 6.8 : 7.5).text(`${time}  /  ${headline.sources.length} 个来源`, contentX, top + cardHeight - (compact ? 12 : 17), {
      width: 315,
      lineBreak: false,
    });

    drawDirectionPill(doc, direction.direction, `${direction.symbol} ${direction.compactLabel}`, page.width - page.margin - 92, top + (compact ? 7 : 10), 76, { height: compact ? 21 : 24 });
    doc.fillColor(colors.tertiary).fontSize(compact ? 6.8 : 7.4).text(`影响 ${headline.impact}/5`, page.width - page.margin - 92, top + (compact ? 32 : 42), {
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

const detailContentBottom = page.height - 51;

type EventFlow = {
  doc: PDFKit.PDFDocument;
  brief: DailyBrief;
  headline: Headline;
  index: number;
  total: number;
  cursor: number;
  pageInEvent: number;
};

type FlowTextOptions = {
  x?: number;
  width?: number;
  fontSize?: number;
  lineGap?: number;
  color?: string;
  gapAfter?: number;
  continuationLabel?: string;
  link?: string;
};

const relationLabels: Record<EquityImpactAssessment["relation"], string> = {
  issuer: "新闻主体",
  supplier: "供应链",
  customer: "客户",
  competitor: "竞争者",
  sector_peer: "同业",
  macro_exposure: "宏观暴露",
};

function drawDetailHeader(flow: EventFlow, continuationLabel?: string): void {
  const { doc, brief, headline, index, total, pageInEvent } = flow;
  doc.save().rect(0, 0, page.width, 96).fill(colors.navy).restore();
  doc.save().rect(0, 0, 7, 96).fill(colors.accent).restore();
  doc.fillColor(colors.accent).font("NotoSC").fontSize(8.6).text("AnalystArena / 每日市场情报", page.margin, 25, {
    characterSpacing: 0.6,
    lineBreak: false,
  });
  doc.fillColor(colors.white).fontSize(16.5).text(
    `事件 ${String(index).padStart(2, "0")} / 排名 ${String(headline.rank).padStart(2, "0")}`,
    page.margin,
    47,
    { width: 245, lineBreak: false },
  );
  doc.fillColor("#AAB7C8").fontSize(8.4).text(`${brief.date}  /  ${index} of ${total}`, page.width - page.margin - 155, 27, {
    width: 155,
    align: "right",
    lineBreak: false,
  });
  const pageLabel = pageInEvent > 1 ? `事件续页 ${pageInEvent}` : "市场头条完整研究";
  doc.fillColor("#D2D9E3").fontSize(8).text(continuationLabel ? `${pageLabel} / ${continuationLabel}` : pageLabel, page.width - page.margin - 220, 53, {
    width: 220,
    align: "right",
    lineBreak: false,
  });
}

function addEventPage(flow: EventFlow, continuationLabel?: string): void {
  flow.doc.addPage();
  flow.pageInEvent += 1;
  drawDetailHeader(flow, continuationLabel);
  flow.cursor = 113;
  if (continuationLabel) {
    flow.doc.save().rect(page.margin, flow.cursor + 2, 4, 15).fill(colors.accent).restore();
    flow.doc.fillColor(colors.secondary).font("NotoSC").fontSize(9).text(`${continuationLabel} / 续`, page.margin + 12, flow.cursor, {
      width: page.width - page.margin * 2 - 12,
      lineBreak: false,
    });
    flow.cursor += 28;
  }
}

function ensureSpace(flow: EventFlow, height: number, continuationLabel?: string): void {
  if (flow.cursor + height <= detailContentBottom) return;
  addEventPage(flow, continuationLabel);
}

function measuredTextHeight(
  doc: PDFKit.PDFDocument,
  value: string,
  width: number,
  fontSize: number,
  lineGap: number,
): number {
  doc.font("NotoSC").fontSize(fontSize);
  return Math.max(fontSize + 2, Math.ceil(doc.heightOfString(value, { width, lineGap })) + 1);
}

function splitTextForHeight(
  doc: PDFKit.PDFDocument,
  value: string,
  width: number,
  fontSize: number,
  lineGap: number,
  maxHeight: number,
): [string, string] {
  if (measuredTextHeight(doc, value, width, fontSize, lineGap) <= maxHeight) return [value, ""];

  let low = 1;
  let high = value.length;
  let best = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (measuredTextHeight(doc, candidate, width, fontSize, lineGap) <= maxHeight) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const candidate = value.slice(0, best);
  const searchStart = Math.max(1, best - 80);
  const tail = candidate.slice(searchStart);
  const breakMatches = [...tail.matchAll(/[\s,.;!?]/g)];
  const lastBreak = breakMatches.at(-1)?.index;
  const cut = lastBreak !== undefined && searchStart + lastBreak > best * 0.7
    ? searchStart + lastBreak + 1
    : best;
  return [value.slice(0, Math.max(1, cut)).trimEnd(), value.slice(Math.max(1, cut)).trimStart()];
}

function drawFlowText(flow: EventFlow, value: string, options: FlowTextOptions = {}): void {
  const x = options.x ?? page.margin;
  const width = options.width ?? page.width - page.margin * 2;
  const fontSize = options.fontSize ?? 9.3;
  const lineGap = options.lineGap ?? 2.5;
  const color = options.color ?? colors.ink;
  const gapAfter = options.gapAfter ?? 8;
  let remaining = pdfFullText(value);
  if (!remaining) return;

  while (remaining) {
    const minimumHeight = fontSize + lineGap + 4;
    if (detailContentBottom - flow.cursor < minimumHeight) addEventPage(flow, options.continuationLabel);
    const availableHeight = detailContentBottom - flow.cursor;
    const [chunk, rest] = splitTextForHeight(flow.doc, remaining, width, fontSize, lineGap, availableHeight);
    const chunkHeight = measuredTextHeight(flow.doc, chunk, width, fontSize, lineGap);
    flow.doc.fillColor(color).font("NotoSC").fontSize(fontSize).text(chunk, x, flow.cursor, {
      width,
      lineGap,
      link: options.link && /^https?:\/\//i.test(options.link) ? options.link : undefined,
      underline: false,
    });
    flow.cursor += chunkHeight;
    remaining = rest;
    if (remaining) addEventPage(flow, options.continuationLabel);
  }
  flow.cursor += gapAfter;
}

function drawSectionHeading(flow: EventFlow, label: string): void {
  // Keep the heading with at least the first content row so section titles never
  // become stranded at the bottom of a page.
  ensureSpace(flow, 108, label);
  flow.doc.moveTo(page.margin, flow.cursor + 4).lineTo(page.width - page.margin, flow.cursor + 4).strokeColor(colors.line).lineWidth(0.6).stroke();
  flow.doc.fillColor(colors.tertiary).font("NotoSC").fontSize(7.5).text("MARKET HEADLINES", page.margin, flow.cursor + 12, {
    width: 112,
    characterSpacing: 0.65,
    lineBreak: false,
  });
  flow.doc.fillColor(colors.ink).fontSize(12.3).text(label, page.margin + 128, flow.cursor + 8, {
    width: page.width - page.margin * 2 - 128,
    lineBreak: false,
  });
  flow.cursor += 34;
}

function drawMetricStrip(flow: EventFlow): void {
  ensureSpace(flow, 69, "判断指标");
  const { doc, headline } = flow;
  const direction = headlineDirectionPresentation(headline);
  const layers = headline.crossSourceCount ?? new Set(headline.sources.map((source) => source.type)).size;
  const metrics = [
    ["事件潜在方向", `${direction.symbol} ${direction.label}`],
    ["市场影响", `${headline.impact}/5`],
    ["资料可信度", `${headline.confidence}%`],
    ["时效分数", headline.freshnessScore === undefined ? "-" : String(headline.freshnessScore)],
    ["来源层级", String(layers)],
  ];
  const width = page.width - page.margin * 2;
  const cellWidth = width / metrics.length;
  doc.save().roundedRect(page.margin, flow.cursor, width, 57, 8).fillAndStroke(colors.surface, colors.line).restore();
  metrics.forEach(([label, value], index) => {
    const x = page.margin + cellWidth * index;
    if (index > 0) doc.moveTo(x, flow.cursor + 11).lineTo(x, flow.cursor + 46).strokeColor(colors.line).lineWidth(0.45).stroke();
    doc.fillColor(colors.tertiary).font("NotoSC").fontSize(7.1).text(label, x + 8, flow.cursor + 11, {
      width: cellWidth - 16,
      align: "center",
      lineBreak: false,
    });
    doc.fillColor(index === 0 ? directionTheme(direction.direction).color : colors.ink).fontSize(9.2).text(value, x + 7, flow.cursor + 31, {
      width: cellWidth - 14,
      align: "center",
      lineBreak: false,
    });
  });
  flow.cursor += 69;
}

function drawEventOverview(flow: EventFlow): void {
  const { headline } = flow;
  const timestamp = resolveHeadlineTimestamp(headline);
  addEventPage(flow);
  drawFlowText(
    flow,
    `排名 ${String(headline.rank).padStart(2, "0")} / ${headline.ticker} / ${categoryDisplayNames[headline.category]} / ${formatTimestampLine(timestamp.value, timestamp.kind)}${timestamp.source ? ` / ${sourceDisplayName(timestamp.source)}` : ""}`,
    { fontSize: 8.2, lineGap: 2, color: colors.tertiary, gapAfter: 11, continuationLabel: "事件信息" },
  );
  drawFlowText(flow, headline.title, {
    fontSize: 19.5,
    lineGap: 3.4,
    color: colors.ink,
    gapAfter: 15,
    continuationLabel: "事件标题",
  });
  drawMetricStrip(flow);

  const direction = headlineDirectionPresentation(headline);
  const directionConfidence = headlineDirectionConfidence(headline);
  drawSectionHeading(flow, "方向判断");
  drawFlowText(flow, `${direction.symbol} ${direction.label} / 方向证据强度 ${directionConfidence}% / 不是上涨或下跌概率`, {
    fontSize: 11.2,
    color: directionTheme(direction.direction).color,
    gapAfter: 5,
    continuationLabel: "方向判断",
  });
  drawFlowText(flow, headlineDirectionRationale(headline), {
    fontSize: 9.4,
    color: colors.secondary,
    continuationLabel: "方向判断",
  });

  const evidence = headlineEvidence(headline);
  drawSectionHeading(flow, "证据状态");
  drawFlowText(flow, evidence.label, {
    fontSize: 10.5,
    color: evidence.level === "official" ? colors.bullish : evidence.level === "social" ? colors.mixed : colors.ink,
    gapAfter: 4,
    continuationLabel: "证据状态",
  });
  drawFlowText(flow, evidence.detail, { color: colors.secondary, continuationLabel: "证据状态" });

  drawSectionHeading(flow, "事件摘要");
  drawFlowText(flow, headline.summary, { fontSize: 9.7, lineGap: 3, continuationLabel: "事件摘要" });

  drawSectionHeading(flow, "目前已知事实");
  factsFor(headline).forEach((fact, factIndex) => {
    drawFlowText(flow, `${String(factIndex + 1).padStart(2, "0")}  ${fact}`, {
      fontSize: 9.3,
      lineGap: 2.7,
      gapAfter: 7,
      continuationLabel: "目前已知事实",
    });
  });

  drawSectionHeading(flow, "市场如何传导");
  drawFlowText(flow, headline.marketImpact, { fontSize: 9.5, lineGap: 3, continuationLabel: "市场如何传导" });
  drawFlowText(flow, `可能受影响的观察范围: ${affectedScopes(headline).join(" / ")}`, {
    fontSize: 8.7,
    color: colors.secondary,
    continuationLabel: "市场如何传导",
  });
}

function freshnessLabel(value: EquityImpactAssessment["marketContext"]): string {
  const freshness = value?.freshness;
  if (freshness === "fresh") return "资料最新";
  if (freshness === "stale") return "资料偏旧";
  if (freshness === "missing") return "资料过期";
  return "行情待补充";
}

function drawEquityImpacts(flow: EventFlow): void {
  const equities = visibleEquityImpacts(flow.headline);
  const groups = groupEquityImpacts(flow.headline);
  const noMappingMessage = equityMappingEmptyMessage(flow.headline);
  drawSectionHeading(flow, "利好 / 利空标的一览");
  drawFlowText(
    flow,
    `潜在利好标的 (${groups.upside.length}): ${groups.upside.length ? equityTargetList(groups.upside) : equities.length ? "本事件暂无数据库中可验证的潜在利好标的" : noMappingMessage}`,
    { fontSize: 9.1, color: colors.bullish, gapAfter: 7, continuationLabel: "利好 / 利空标的一览" },
  );
  drawFlowText(
    flow,
    `潜在利空标的 (${groups.downside.length}): ${groups.downside.length ? equityTargetList(groups.downside) : equities.length ? "本事件暂无数据库中可验证的潜在利空标的" : noMappingMessage}`,
    { fontSize: 9.1, color: colors.bearish, gapAfter: 7, continuationLabel: "利好 / 利空标的一览" },
  );
  if (groups.mixed.length) {
    drawFlowText(flow, `多空并存标的 (${groups.mixed.length}): ${equityTargetList(groups.mixed)}`, {
      fontSize: 9.1,
      color: colors.mixed,
      gapAfter: 7,
      continuationLabel: "利好 / 利空标的一览",
    });
  }
  if (groups.unclear.length) {
    drawFlowText(flow, `方向待确认标的 (${groups.unclear.length}): ${equityTargetList(groups.unclear)}`, {
      fontSize: 9.1,
      color: colors.neutral,
      gapAfter: 7,
      continuationLabel: "利好 / 利空标的一览",
    });
  }
  if (!equities.length) return;

  drawSectionHeading(flow, `关联美股完整研究 (${equities.length})`);
  drawFlowText(flow, "预期传导与实际行情分开呈现; 实际涨跌不证明由这则新闻造成.", {
    fontSize: 8.2,
    color: colors.tertiary,
    gapAfter: 12,
    continuationLabel: "关联美股",
  });

  equities.forEach((item, itemIndex) => {
    const direction = equityDirectionPresentation(item.direction);
    const theme = equityDirectionTheme(item.direction);
    const directionConfidence = item.directionConfidence === undefined ? "-" : `${item.directionConfidence}%`;
    ensureSpace(flow, 86, "关联美股");
    flow.doc.save().rect(page.margin, flow.cursor, 5, 22).fill(theme.color).restore();
    drawFlowText(flow, `${itemIndex + 1}. ${item.symbol} / ${item.companyName}`, {
      x: page.margin + 14,
      width: page.width - page.margin * 2 - 14,
      fontSize: 12.1,
      color: colors.ink,
      gapAfter: 5,
      continuationLabel: "关联美股",
    });
    drawFlowText(
      flow,
      `事件推演: ${direction.symbol} ${direction.label} / 关联可信度 ${item.mappingConfidence}% / 方向证据 ${directionConfidence} / 关系: ${relationLabels[item.relation]} / 审核状态: ${equityReviewLabel(item)}`,
      { fontSize: 8.9, color: theme.color, gapAfter: 5, continuationLabel: "关联美股" },
    );
    drawFlowText(flow, `传导逻辑: ${item.mechanism}`, {
      fontSize: 9.2,
      color: colors.secondary,
      continuationLabel: "关联美股",
    });

    const context = item.marketContext;
    if (context?.return1dPct !== undefined) {
      const marketLine = [
        `市场已发生: 截至 ${context.asOf}`,
        context.lastPrice !== undefined ? `最新价 $${context.lastPrice.toFixed(2)}` : "最新价 -",
        freshnessLabel(context),
        `实际 1 日 ${formatReturn(context.return1dPct)}`,
        `实际 5 日 ${formatReturn(context.return5dPct)}`,
        context.volumeVs20d !== undefined ? `成交量 / 20 日均量 ${context.volumeVs20d.toFixed(2)}x` : "成交量 / 20 日均量 -",
      ].join(" / ");
      drawFlowText(flow, marketLine, {
        fontSize: 8.6,
        color: colors.ink,
        continuationLabel: "关联美股",
      });
    } else {
      drawFlowText(flow, "市场已发生: 暂无事件发生前的可用行情.", {
        fontSize: 8.6,
        color: colors.tertiary,
        continuationLabel: "关联美股",
      });
    }
    drawFlowText(flow, `反向情景: ${item.counterCase}`, {
      fontSize: 8.9,
      color: colors.secondary,
      gapAfter: 12,
      continuationLabel: "关联美股",
    });
  });
}

function drawSources(flow: EventFlow): void {
  const sources = sortedSources(flow.headline);
  drawSectionHeading(flow, `证据与原始来源 (${sources.length})`);
  if (!sources.length) {
    drawFlowText(flow, "本期尚无可用来源.", { color: colors.tertiary, continuationLabel: "证据与原始来源" });
    return;
  }

  sources.forEach((source, sourceIndex) => {
    ensureSpace(flow, 52, "证据与原始来源");
    drawFlowText(flow, `${sourceIndex + 1}. ${sourceTypeLabel(source.type)} / ${sourceDisplayName(source.name)}`, {
      fontSize: 9.7,
      color: colors.ink,
      gapAfter: 3,
      continuationLabel: "证据与原始来源",
    });
    const sourceTime = source.publishedAt
      ? `${timestampLabel(source.timestampKind ?? "published")} / ${formatBeijingMinute(source.publishedAt)}`
      : "原始时间未提供";
    drawFlowText(flow, `${sourceTime} / ${shortDomain(source.url)}`, {
      fontSize: 8.3,
      color: colors.secondary,
      gapAfter: 4,
      continuationLabel: "证据与原始来源",
    });
    drawFlowText(flow, "打开原始来源", {
      fontSize: 8.2,
      color: colors.bullish,
      gapAfter: 10,
      continuationLabel: "证据与原始来源",
      link: source.url,
    });
  });
}

function drawNextSteps(flow: EventFlow): void {
  const sources = sortedSources(flow.headline);
  const primarySource = sources[0];
  const watch = flow.brief.watchlist.find((item) => item.category === flow.headline.category);
  const risks = headlineRiskFlags(flow.headline);
  drawSectionHeading(flow, "投资人下一步");
  drawFlowText(
    flow,
    `01  先读最高可信来源: ${primarySource ? `${sourceTypeLabel(primarySource.type)} / ${sourceDisplayName(primarySource.name)}` : "本期尚无可用来源"}`,
    {
      fontSize: 9.2,
      continuationLabel: "投资人下一步",
      link: primarySource?.url,
    },
  );
  drawFlowText(
    flow,
    `02  跟踪下一项确认点: ${watch ? `${watch.event}: ${watch.why}` : "等待公司、监管机构或主流新闻后续更新"}`,
    { fontSize: 9.2, continuationLabel: "投资人下一步" },
  );
  risks.forEach((risk, riskIndex) => {
    drawFlowText(flow, `${String(riskIndex + 3).padStart(2, "0")}  证据缺口: ${risk}`, {
      fontSize: 9.2,
      color: colors.secondary,
      gapAfter: 6,
      continuationLabel: "投资人下一步",
    });
  });
}

function drawRelatedSignals(flow: EventFlow): void {
  const headlines = orderedHeadlines(flow.brief);
  const relatedSignals = flattenSignals(flow.brief)
    .filter((entry) => resolveSignalHeadline(entry.topic, headlines)?.id === flow.headline.id);
  drawSectionHeading(flow, `关联社交信号 (${relatedSignals.length})`);
  if (!relatedSignals.length) {
    drawFlowText(flow, "暂无高置信关联. 本期不会为了填满版面而强行匹配社交线索.", {
      color: colors.tertiary,
      continuationLabel: "关联社交信号",
    });
    return;
  }
  relatedSignals.forEach((entry, signalIndex) => {
    drawFlowText(flow, `${signalIndex + 1}. ${entry.platform} / 信号强度 ${signalStrength(entry.topic)} / ${entry.topic.label}`, {
      fontSize: 9.2,
      color: colors.secondary,
      gapAfter: 8,
      continuationLabel: "关联社交信号",
      link: entry.topic.url,
    });
  });
}

function drawTermNotes(flow: EventFlow): void {
  const notes = flow.headline.termNotes?.length ? flow.headline.termNotes : extractTermNotes(flow.headline);
  if (!notes.length) return;
  drawSectionHeading(flow, `英文术语说明 (${notes.length})`);
  notes.forEach((item, index) => {
    drawFlowText(flow, `${index + 1}. ${item.term} = ${item.note}`, {
      fontSize: 8.8,
      color: colors.secondary,
      gapAfter: 6,
      continuationLabel: "英文术语说明",
    });
  });
}

function drawHeadlineDetail(doc: PDFKit.PDFDocument, brief: DailyBrief, headline: Headline, index: number, total: number): void {
  const flow: EventFlow = { doc, brief, headline, index, total, cursor: 0, pageInEvent: 0 };
  drawEventOverview(flow);
  drawEquityImpacts(flow);
  drawSources(flow);
  drawNextSteps(flow);
  drawRelatedSignals(flow);
  drawTermNotes(flow);
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
      Subject: "每日市场头条完整事件研究与潜在传导",
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

  const headlines = orderedHeadlines(brief);
  drawCover(doc, brief, headlines);
  headlines.forEach((headline, index) => drawHeadlineDetail(doc, brief, headline, index + 1, headlines.length));
  drawFooters(doc);

  doc.end();
  return complete;
}
