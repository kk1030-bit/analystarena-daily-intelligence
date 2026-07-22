import assert from "node:assert/strict";
import { demoBrief } from "../lib/demo-data";
import { createEvidenceCitation, createHeadlineClaim, createSourceEvidence } from "../lib/source-evidence";
import type { Headline, HeadlineClaim } from "../lib/types";

process.env.ADMIN_TOKEN = "publish-review-test-token";

const [{ saveDraft, updateDraft, getPublishedPdf }, listRoute, publishRoute] = await Promise.all([
  import("../lib/db"),
  import("../app/api/briefs/route"),
  import("../app/api/briefs/[id]/publish/route"),
]);

const date = "2099-12-30";
function withTestEvidence(headline: Headline): Headline {
  const sourceDocumentId = `sd_publish_gate_${headline.rank}`;
  const sourceDocumentVersionId = `00000000-0000-4000-8000-${String(headline.rank).padStart(12, "0")}`;
  const evidence = createSourceEvidence({
    sourceDocumentId,
    sourceDocumentVersionId,
    versionId: `10000000-0000-4000-8000-${String(headline.rank).padStart(12, "0")}`,
    anchorKey: "test:record",
    quoteOriginal: [headline.title, headline.summary, ...(headline.keyPoints ?? []), headline.marketImpact].join("\n"),
    locator: {
      kind: "feed_field",
      feedUrl: `https://wire.example/${headline.rank}/feed.xml`,
      entryId: `item-${headline.rank}`,
      field: "content",
      fieldPath: "/rss/channel/item/content:encoded",
    },
    locatorStatus: "exact",
    directness: "direct",
    captureScope: "rss_entry",
    extractionMethod: "test-fixture",
    extractorVersion: "v1",
    capturedAt: `${date}T01:00:00.000Z`,
  });
  const citation = createEvidenceCitation(evidence);
  const directionRationale = headline.directionRationale ?? "测试来源中的需求与风险因素支持该方向判断。";
  const definitions: Array<[string, HeadlineClaim["type"], string]> = [
    ["title", "title", headline.title],
    ["summary", "summary", headline.summary],
    ...(headline.keyPoints ?? []).map((point, index): [string, HeadlineClaim["type"], string] => [`important_information:${index}`, "important_information", point]),
    ["market_impact", "market_impact", headline.marketImpact],
    ["direction_rationale", "direction_rationale", directionRationale],
  ];
  const claims = definitions.map(([claimKey, type, statement], ordinal) => createHeadlineClaim({
    claimKey,
    type,
    ordinal,
    statement,
    originalStatement: statement,
    language: "zh-CN",
    verificationStatus: type === "market_impact" || type === "direction_rationale" ? "partially_supported" : "supported",
    citations: [citation],
    generator: "deterministic",
    generatorVersion: "test/v1",
  }));
  return {
    ...headline,
    directionRationale,
    sources: [{
      name: "Test Wire",
      type: "News",
      url: `https://wire.example/${headline.rank}`,
      sourceDocumentId,
      sourceDocumentVersionId,
      evidence: [evidence],
    }],
    claims,
  };
}

const oldDraft = {
  ...demoBrief,
  date,
  headlines: demoBrief.headlines.map((headline) => ({ ...withTestEvidence(headline), equityImpacts: undefined })),
};
const saved = await saveDraft(oldDraft);
const headers = { "x-admin-token": process.env.ADMIN_TOKEN };

const listResponse = await listRoute.GET(new Request("http://localhost/api/briefs", { headers }));
assert.equal(listResponse.status, 200);
const listBody = await listResponse.json();
const hydrated = listBody.records.find((record: { id: string }) => record.id === saved.id);
assert.ok(hydrated, "管理员列表应返回测试草稿");
assert.ok(hydrated.brief.headlines.every((headline: { equityImpacts?: unknown[] }) => Array.isArray(headline.equityImpacts)), "旧草稿必须在审核前补算股票映射");

let lowConfidenceInjected = false;
const lowConfidenceBrief = {
  ...hydrated.brief,
  headlines: hydrated.brief.headlines.map((headline: Headline) => ({
    ...headline,
    equityImpacts: (headline.equityImpacts ?? []).map((item) => {
      if (lowConfidenceInjected) return item;
      lowConfidenceInjected = true;
      return { ...item, mappingConfidence: 69, reviewStatus: "auto_pending" as const };
    }),
  })),
};
assert.equal(lowConfidenceInjected, true, "fixture must contain at least one equity assessment");
const lowConfidenceDraft = await updateDraft(saved.id, lowConfidenceBrief);

const blockedResponse = await publishRoute.POST(
  new Request(`http://localhost/api/briefs/${saved.id}/publish`, { method: "POST", headers }),
  { params: Promise.resolve({ id: saved.id }) },
);
assert.equal(blockedResponse.status, 409);
const blockedBody = await blockedResponse.json();
assert.equal(blockedBody.code, "EQUITY_REVIEW_REQUIRED");
assert.ok(blockedBody.pending.length > 0, "高可信自动映射必须经过人工审核");

assert.ok(blockedBody.pending.some((item: { mappingConfidence: number }) => item.mappingConfidence === 69),
  "low-confidence unreviewed equity impacts must not bypass publication");

const reviewedBrief = {
  ...lowConfidenceDraft.brief,
  headlines: lowConfidenceDraft.brief.headlines.map((headline: Headline) => ({
    ...headline,
    equityImpacts: (headline.equityImpacts ?? []).map((item) => ({
      ...item,
      reviewStatus: "approved" as const,
    })),
  })),
};
await updateDraft(saved.id, reviewedBrief);

const publishedResponse = await publishRoute.POST(
  new Request(`http://localhost/api/briefs/${saved.id}/publish`, { method: "POST", headers }),
  { params: Promise.resolve({ id: saved.id }) },
);
assert.equal(publishedResponse.status, 200);
const publishedBody = await publishedResponse.json();
assert.equal(publishedBody.status, "published");
assert.equal(publishedBody.hasPdf, true);
assert.ok(publishedBody.brief.headlines.some((headline: { equityImpacts?: Array<{ reviewStatus: string }> }) => headline.equityImpacts?.some((item) => item.reviewStatus === "approved")));
assert.ok((await getPublishedPdf(saved.id))?.pdf.length, "正式发布必须保存同批数据生成的 PDF");

console.log("publish review gate tests passed");
