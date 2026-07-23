import assert from "node:assert/strict";
import { demoBrief } from "../lib/demo-data";
import { createEvidenceCitation, createHeadlineClaim, createSourceEvidence } from "../lib/source-evidence";
import type { Headline, HeadlineClaim } from "../lib/types";

process.env.ADMIN_TOKEN = "publish-review-test-token";
process.env.AUDIT_HMAC_KEY = "publish-review-independent-audit-key-for-tests";

const [{ saveDraft, updateDraft, getPublishedPdf }, listRoute, detailRoute, publishRoute] = await Promise.all([
  import("../lib/db"),
  import("../app/api/briefs/route"),
  import("../app/api/briefs/[id]/route"),
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
    equityImpacts: headline.equityImpacts?.length
      ? structuredClone(headline.equityImpacts)
      : [{
          symbol: headline.ticker,
          providerSymbol: headline.ticker,
          companyName: `${headline.ticker} Test Issuer`,
          direction: "potential_upside" as const,
          relation: "issuer" as const,
          mappingConfidence: 90,
          directionConfidence: 80,
          mechanism: "测试事件可能影响该发行人的收入与估值预期。",
          assumptions: ["事件信息经来源确认"],
          counterCase: "若事件没有落实，方向可能反转。",
          evidence: [{
            basis: "explicit_symbol" as const,
            statement: `新闻明确提及 ${headline.ticker}`,
            weight: 1,
          }],
          engineVersion: "publish-review-gate/v1",
          reviewStatus: "auto_pending" as const,
        }],
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
  headlines: demoBrief.headlines.map((headline) => withTestEvidence(headline)),
};
const saved = await saveDraft(oldDraft);
const headers = { "x-admin-token": process.env.ADMIN_TOKEN };

const listResponse = await listRoute.GET(new Request("http://localhost/api/briefs", { headers }));
assert.equal(listResponse.status, 200);
const listBody = await listResponse.json();
const hydrated = listBody.records.find((record: { id: string }) => record.id === saved.id);
assert.ok(hydrated, "管理员列表应返回测试草稿");
assert.equal(
  hydrated.brief.snapshot?.id,
  saved.brief.snapshot?.id,
  "list GET must return the exact persisted snapshot instead of hydrating a new read-time projection",
);
assert.equal(
  hydrated.brief.snapshot?.payloadHash,
  saved.brief.snapshot?.payloadHash,
  "list GET must preserve the immutable payload hash",
);
assert.deepEqual(
  hydrated.brief.headlines,
  JSON.parse(JSON.stringify(saved.brief.headlines)),
  "list GET must not translate, map equities, or otherwise mutate frozen snapshot content",
);
const detailResponse = await detailRoute.GET(
  new Request(`http://localhost/api/briefs/${saved.id}`, { headers }),
  { params: Promise.resolve({ id: saved.id }) },
);
assert.equal(detailResponse.status, 200);
const detailBody = await detailResponse.json();
assert.equal(detailBody.brief.snapshot?.id, saved.brief.snapshot?.id);
assert.equal(detailBody.brief.snapshot?.payloadHash, saved.brief.snapshot?.payloadHash);
assert.deepEqual(
  detailBody.brief.headlines,
  JSON.parse(JSON.stringify(saved.brief.headlines)),
  "detail GET must return the exact persisted snapshot without read-time enrichment",
);

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
  new Request(`http://localhost/api/briefs/${saved.id}/publish`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      expectedSnapshotId: lowConfidenceDraft.brief.snapshot?.id,
      expectedPayloadHash: lowConfidenceDraft.brief.snapshot?.payloadHash,
    }),
  }),
  { params: Promise.resolve({ id: saved.id }) },
);
assert.equal(blockedResponse.status, 409);
const blockedBody = await blockedResponse.json();
assert.equal(blockedBody.code, "EQUITY_REVIEW_REQUIRED");
assert.ok(blockedBody.pending.length > 0, "高可信自动映射必须经过人工审核");
assert.equal(blockedBody.issues.length, blockedBody.pending.length, "审核台必须收到逐项股票问题");
assert.ok(
  blockedBody.issues.every((item: { code: string; headlineId?: string; claimKey?: string }) =>
    item.code === "EQUITY_REVIEW_REQUIRED"
    && Boolean(item.headlineId)
    && item.claimKey?.startsWith("equity_impact:")),
  "每项股票审核问题必须包含事件 ID 与标的",
);

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
const reviewed = await updateDraft(saved.id, reviewedBrief);

// The reviewer saw S1. A later save creates S2 before the publish request
// arrives. The route must reject S1's optimistic concurrency token, even when
// the stale payload would otherwise pass every evidence/review gate.
const supersededReviewed = reviewed;
const currentReviewed = await updateDraft(saved.id, {
  ...structuredClone(reviewed.brief),
  stats: {
    ...reviewed.brief.stats,
    candidates: reviewed.brief.stats.candidates + 1,
  },
});
assert.notEqual(
  currentReviewed.brief.snapshot?.id,
  supersededReviewed.brief.snapshot?.id,
  "the fixture must create a distinct S2 after S1 was reviewed",
);
const stalePublishResponse = await publishRoute.POST(
  new Request(`http://localhost/api/briefs/${saved.id}/publish`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      expectedSnapshotId: supersededReviewed.brief.snapshot?.id,
      expectedPayloadHash: supersededReviewed.brief.snapshot?.payloadHash,
    }),
  }),
  { params: Promise.resolve({ id: saved.id }) },
);
assert.equal(stalePublishResponse.status, 409);
assert.equal((await stalePublishResponse.json()).code, "STALE_BRIEF_REVISION");

const publishedResponse = await publishRoute.POST(
  new Request(`http://localhost/api/briefs/${saved.id}/publish`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      expectedSnapshotId: currentReviewed.brief.snapshot?.id,
      expectedPayloadHash: currentReviewed.brief.snapshot?.payloadHash,
    }),
  }),
  { params: Promise.resolve({ id: saved.id }) },
);
assert.equal(publishedResponse.status, 200);
const publishedBody = await publishedResponse.json();
assert.equal(publishedBody.status, "published");
assert.equal(publishedBody.hasPdf, true);
assert.ok(publishedBody.brief.headlines.some((headline: { equityImpacts?: Array<{ reviewStatus: string }> }) => headline.equityImpacts?.some((item) => item.reviewStatus === "approved")));
assert.ok((await getPublishedPdf(saved.id))?.pdf.length, "正式发布必须保存同批数据生成的 PDF");
const publicDetailResponse = await detailRoute.GET(
  new Request(`http://localhost/api/briefs/${saved.id}`),
  { params: Promise.resolve({ id: saved.id }) },
);
assert.equal(publicDetailResponse.status, 200);
const publicDetail = await publicDetailResponse.json();
assert.equal(publicDetail.brief.snapshot?.id, publishedBody.brief.snapshot?.id);
assert.equal(
  publicDetail.brief.snapshot?.payloadHash,
  publishedBody.brief.snapshot?.payloadHash,
);
assert.deepEqual(
  publicDetail.brief.headlines,
  publishedBody.brief.headlines,
  "public detail GET must expose the exact frozen published snapshot without read-time mutation",
);

console.log("publish review gate tests passed");
