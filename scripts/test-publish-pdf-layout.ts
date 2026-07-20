import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { demoBrief } from "../lib/demo-data";
import { generateBriefPdf } from "../lib/pdf";
import type {
  DailyBrief,
  EquityImpactAssessment,
  EquityImpactDirection,
  Headline,
  SourceLink,
} from "../lib/types";

type PdfInspection = {
  pageTexts: string[];
  urls: string[];
};

function compactText(value: string): string {
  return value.replace(/\s+/gu, "");
}

function assertPdfContains(text: string, expected: string, message: string): void {
  assert.ok(compactText(text).includes(compactText(expected)), message);
}

async function inspectPdf(value: Buffer): Promise<PdfInspection> {
  const loadingTask = getDocument({ data: new Uint8Array(value), useSystemFonts: true });
  const document = await loadingTask.promise;
  const pageTexts: string[] = [];
  const urls: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pageTexts.push(textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "));
      const annotations = await page.getAnnotations();
      annotations.forEach((annotation) => {
        if (typeof annotation.url === "string") urls.push(annotation.url);
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return { pageTexts, urls };
}

const directions: EquityImpactDirection[] = ["potential_upside", "potential_downside", "mixed", "unclear"];
const mechanismPrefix = "该段用于验证美股影响资料在动态分页后仍然完整，包含事件传导、假设与市场验证。";

function makeEquityImpact(index: number, reviewStatus: EquityImpactAssessment["reviewStatus"] = "approved"): EquityImpactAssessment {
  return {
    symbol: `QA${index}`,
    providerSymbol: `QA${index}`,
    companyName: index === 4 ? "Fourth Equity Company Sentinel" : index === 5 ? "Rejected Equity Must Not Appear" : `Test Equity ${index}`,
    direction: directions[(index - 1) % directions.length],
    relation: index === 1 ? "issuer" : index === 2 ? "supplier" : index === 3 ? "competitor" : "sector_peer",
    mappingConfidence: 94 - index,
    directionConfidence: 90 - index,
    mechanism: `${mechanismPrefix.repeat(index === 4 ? 8 : 2)} ${index === 4 ? "EQUITYMECHANISMTAIL4" : `EQUITYMECHANISM${index}`}`,
    assumptions: [`测试假设 ${index}`],
    counterCase: index === 4 ? "若需求和订单没有兑现，则传导逻辑失效。 EQUITYCOUNTERTAIL4" : `反向情景 ${index}`,
    evidence: [{ basis: "curated_exposure", statement: `测试证据 ${index}`, weight: 80 }],
    marketContext: {
      asOf: index === 4 ? "2099-12-24" : "2099-12-20",
      lastPrice: index === 4 ? 444.44 : 100 + index,
      return1dPct: index / 100,
      return5dPct: -index / 100,
      volumeVs20d: index === 4 ? 4.44 : 1 + index / 10,
      freshness: "fresh",
    },
    engineVersion: "pdf-layout-test-v1",
    reviewStatus,
  };
}

const sources: SourceLink[] = Array.from({ length: 5 }, (_, index) => ({
  name: index === 3 ? "Fourth Source Sentinel" : `Test Source ${index + 1}`,
  type: "News" as const,
  url: `https://source-${index + 1}.example.com/report`,
  publishedAt: index === 3 ? "2099-12-24T08:34:00.000Z" : `2099-12-${String(20 + index).padStart(2, "0")}T00:00:00.000Z`,
  timestampKind: "published" as const,
}));

const summaryPrefix = "这是一段用于验证事件摘要动态分页的资料，必须保留到最后一个字，不能用省略号裁切。";
const impactPrefix = "这是一段用于验证市场传导动态分页的资料，包含受影响资产、风险路径与后续确认点。";
const firstHeadline: Headline = {
  ...demoBrief.headlines[0],
  confidence: 60,
  freshnessScore: 30,
  crossSourceCount: 1,
  timestampKind: "collected",
  directionRationale: "方向判断应依据完整事件证据，而不是把社交热度误认为价格预测。 DIRECTIONRATIONALETAIL",
  summary: `${summaryPrefix.repeat(28)} SUMMARYTAILSENTINEL`,
  keyPoints: [
    "第一项已知事实用于测试。",
    "第二项已知事实用于测试。",
    "第三项已知事实用于测试。",
    `${summaryPrefix.repeat(8)} FOURTHKEYPOINTSENTINEL`,
  ],
  marketImpact: `${impactPrefix.repeat(24)} MARKETIMPACTTAILSENTINEL`,
  equityImpacts: [
    makeEquityImpact(1),
    makeEquityImpact(2),
    makeEquityImpact(3),
    makeEquityImpact(4, "auto_pending"),
    makeEquityImpact(5, "rejected"),
  ],
  sources,
};

const sixthHeadline: Headline = {
  ...demoBrief.headlines[0],
  id: "sixth-headline-layout-test",
  rank: 6,
  ticker: "SIX",
  title: "第六则市场头条 SIXTHHEADLINESENTINEL",
  summary: "第六则事件也必须完整输出到日报。",
  keyPoints: ["第六则事件的已知事实。"],
  marketImpact: "第六则事件的市场传导说明。",
  sources: [{
    name: "Sixth Source",
    type: "News",
    url: "https://sixth.example.com/report",
    publishedAt: "2099-12-24T09:00:00.000Z",
    timestampKind: "published",
  }],
  equityImpacts: [],
};

const seventhHeadline: Headline = {
  ...sixthHeadline,
  id: "seventh-headline-layout-test",
  rank: 7,
  ticker: "SEV",
  title: "第七则市场头条 SEVENTHHEADLINESENTINEL",
  sources: [{
    name: "Seventh Source",
    type: "News",
    url: "https://seventh.example.com/report",
    publishedAt: "2099-12-24T09:10:00.000Z",
    timestampKind: "published",
  }],
  equityImpacts: undefined,
};

const eighthHeadline: Headline = {
  ...sixthHeadline,
  id: "eighth-headline-layout-test",
  rank: 8,
  ticker: "EIG",
  title: "第八则市场头条 EIGHTHHEADLINESENTINEL",
  sources: [{
    name: "Eighth Source",
    type: "News",
    url: "https://eighth.example.com/report",
    publishedAt: "2099-12-24T09:20:00.000Z",
    timestampKind: "published",
  }],
  equityImpacts: [makeEquityImpact(5, "rejected")],
};

const stressBrief: DailyBrief = {
  ...demoBrief,
  date: "2099-12-24",
  stats: { ...demoBrief.stats, topStories: 8 },
  headlines: [firstHeadline, ...demoBrief.headlines.slice(1), sixthHeadline, seventhHeadline, eighthHeadline],
  socialBuzz: {
    reddit: [{
      id: "pdf-related-signal",
      label: "SOCIALSIGNALSENTINEL",
      description: "与第一则事件直接相关的测试社交信号。",
      url: "https://reddit.example.com/pdf-related-signal",
      source: "r/test",
      platform: "Reddit",
      publishedAt: "2099-12-24T08:00:00.000Z",
      timestampKind: "published",
      category: firstHeadline.category,
      signalScore: 88,
      metricKind: "engagement",
      relatedHeadlineId: firstHeadline.id,
      relationKind: "semantic",
      mentions: 80,
      change: 0.2,
      sentiment: "positive",
    }],
    x: [],
  },
  watchlist: [{
    time: "盘后",
    event: "WATCHPOINTSENTINEL",
    why: "WATCHWHYSENTINEL",
    category: firstHeadline.category,
  }],
};

assert.equal(stressBrief.headlines.length, 8, "PDF 压力测试必须覆盖正式流程的八则市场头条上限");

const pdf = await generateBriefPdf(stressBrief);
assert.ok(pdf.length > 25_000, "压力测试 PDF 内容异常");
assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF", "输出不是 PDF 文件");

const inspection = await inspectPdf(pdf);
const allText = inspection.pageTexts.join("\n");
assert.ok(inspection.pageTexts.length >= 1 + stressBrief.headlines.length, "至少应有一页封面及每则市场头条的起始页");
assert.ok(inspection.pageTexts.length > 7, "长内容必须产生事件续页，而不是被裁切");
assert.ok(inspection.pageTexts.length < 40, "压力测试页数异常，可能存在分页循环或过度留白");
inspection.pageTexts.forEach((pageText, index) => {
  assert.ok(compactText(pageText).length >= 12, `PDF 第 ${index + 1} 页不得为空白页`);
});
assert.ok(inspection.pageTexts.some((pageText) => compactText(pageText).includes("事件续页")), "长内容必须显示事件续页标记");

assertPdfContains(allText, "SIXTHHEADLINESENTINEL", "第六则市场头条必须输出");
assertPdfContains(inspection.pageTexts[0], "EIGHTHHEADLINESENTINEL", "封面必须列出第八则市场头条");
assertPdfContains(allText, "EIGHTHHEADLINESENTINEL", "第八则市场头条详情不得被省略");
assertPdfContains(inspection.pageTexts[0], "利好 QA1 / 利空 QA2", "封面必须同时显示利好与利空标的摘要");
assertPdfContains(allText, "潜在利好标的 (1): QA1 / Test Equity 1", "潜在利好标的必须单独列示");
assertPdfContains(allText, "潜在利空标的 (1): QA2 / Test Equity 2", "潜在利空标的必须单独列示");
assertPdfContains(allText, "多空并存标的 (1): QA3 / Test Equity 3", "多空并存标的不得归入单一方向");
assertPdfContains(allText, "方向待确认标的 (1): QA4 / Fourth Equity Company Sentinel", "方向待确认标的必须保留");
assertPdfContains(allText, "关联 93%, 方向 89%, 人工已批准", "利好标的必须包含两种可信度与审核状态");
assertPdfContains(allText, "关联 92%, 方向 88%, 人工已批准", "利空标的必须包含两种可信度与审核状态");
assertPdfContains(allText, "关联 90%, 方向 86%, 待人工复核", "待审核标的必须明确标记");
assertPdfContains(allText, "股票映射已完成, 暂未找到可安全关联的美国股票", "已完成但无标的的状态必须明确");
assertPdfContains(allText, "股票映射尚未完成, 不能据此判断利好或利空标的", "尚未补算的股票映射不得误报为零标的");
assertPdfContains(allText, "相关股票已在人工审核中驳回, 本期不列为利好或利空标的", "全部驳回的股票映射必须明确说明");
assertPdfContains(allText, "FOURTHKEYPOINTSENTINEL", "第四项已知事实必须输出");
assertPdfContains(allText, "SUMMARYTAILSENTINEL", "事件摘要尾部不得被裁切");
assertPdfContains(allText, "MARKETIMPACTTAILSENTINEL", "市场传导尾部不得被裁切");
assertPdfContains(allText, "Fourth Equity Company Sentinel", "第四个非拒绝股票的公司名称必须输出");
assertPdfContains(allText, "EQUITYMECHANISMTAIL4", "第四个非拒绝股票的传导逻辑必须完整输出");
assertPdfContains(allText, "EQUITYCOUNTERTAIL4", "第四个非拒绝股票的反向情景必须完整输出");
assertPdfContains(allText, "$444.44", "第四个非拒绝股票的价格必须输出");
assertPdfContains(allText, "4.44x", "第四个非拒绝股票的成交量倍数必须输出");
assertPdfContains(allText, "Fourth Source Sentinel", "第四个来源名称必须输出");
assertPdfContains(allText, "2099 年 12 月 24 日 16:34", "第四个来源的北京时间必须输出");
assertPdfContains(allText, "WATCHPOINTSENTINEL", "投资人下一步的观察事件必须输出");
assertPdfContains(allText, "WATCHWHYSENTINEL", "投资人下一步的观察原因必须输出");
assertPdfContains(allText, "尚无官方第一手来源", "证据风险提示必须输出");
assertPdfContains(allText, "跨来源层级不足", "跨来源风险提示必须输出");
assertPdfContains(allText, "SOCIALSIGNALSENTINEL", "关联社交信号必须输出");
assert.ok(!compactText(allText).includes(compactText("Rejected Equity Must Not Appear")), "已拒绝股票不得输出");
sources.forEach((source) => assert.ok(inspection.urls.includes(source.url), `来源链接必须可点击：${source.url}`));

const completePreviewPdf = await generateBriefPdf({
  ...stressBrief,
  status: "draft",
  translationEnabled: true,
  warning: undefined,
});
const disabledTranslationPreviewPdf = await generateBriefPdf({
  ...stressBrief,
  status: "draft",
  translationEnabled: false,
  warning: undefined,
});
const pendingTranslationPreviewPdf = await generateBriefPdf({
  ...stressBrief,
  status: "draft",
  translationEnabled: true,
  warning: "部分字段的自动翻译待人工确认。",
});
assert.ok(disabledTranslationPreviewPdf.length > completePreviewPdf.length + 100, "翻译未完成的预览 PDF 必须显示独立提示");
assert.ok(pendingTranslationPreviewPdf.length > completePreviewPdf.length + 100, "含翻译待确认警告的预览 PDF 必须显示独立提示");
const [completePreviewInspection, disabledPreviewInspection, pendingPreviewInspection] = await Promise.all([
  inspectPdf(completePreviewPdf),
  inspectPdf(disabledTranslationPreviewPdf),
  inspectPdf(pendingTranslationPreviewPdf),
]);
assert.equal(disabledPreviewInspection.pageTexts.length, completePreviewInspection.pageTexts.length, "翻译提示不得改变同一份资料的页数");
assert.equal(pendingPreviewInspection.pageTexts.length, completePreviewInspection.pageTexts.length, "待确认翻译提示不得改变同一份资料的页数");

const completePublishedPdf = await generateBriefPdf({
  ...stressBrief,
  status: "published",
  translationEnabled: true,
  warning: undefined,
});
const flaggedPublishedPdf = await generateBriefPdf({
  ...stressBrief,
  status: "published",
  translationEnabled: false,
  warning: "部分字段的自动翻译待人工确认。",
});
assert.equal(flaggedPublishedPdf.length, completePublishedPdf.length, "已发布 PDF 不应显示预览翻译提示");

const outputDirectory = path.join(process.cwd(), "tmp", "pdfs");
await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, "publish-layout-stress.pdf");
await writeFile(outputPath, pdf);
const previewOutputPath = path.join(outputDirectory, "preview-translation-notice.pdf");
await writeFile(previewOutputPath, disabledTranslationPreviewPdf);
console.log(outputPath, previewOutputPath, `${inspection.pageTexts.length} pages`);
