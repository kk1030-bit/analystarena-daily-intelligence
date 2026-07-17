import assert from "node:assert/strict";
import { demoBrief } from "../lib/demo-data";

process.env.ADMIN_TOKEN = "publish-review-test-token";

const [{ saveDraft, updateDraft, getPublishedPdf }, listRoute, publishRoute] = await Promise.all([
  import("../lib/db"),
  import("../app/api/briefs/route"),
  import("../app/api/briefs/[id]/publish/route"),
]);

const date = "2099-12-30";
const oldDraft = {
  ...demoBrief,
  date,
  headlines: demoBrief.headlines.map((headline) => ({ ...headline, equityImpacts: undefined })),
};
const saved = await saveDraft(oldDraft);
const headers = { "x-admin-token": process.env.ADMIN_TOKEN };

const listResponse = await listRoute.GET(new Request("http://localhost/api/briefs", { headers }));
assert.equal(listResponse.status, 200);
const listBody = await listResponse.json();
const hydrated = listBody.records.find((record: { id: string }) => record.id === saved.id);
assert.ok(hydrated, "管理员列表应返回测试草稿");
assert.ok(hydrated.brief.headlines.every((headline: { equityImpacts?: unknown[] }) => Array.isArray(headline.equityImpacts)), "旧草稿必须在审核前补算股票映射");

const blockedResponse = await publishRoute.POST(
  new Request(`http://localhost/api/briefs/${saved.id}/publish`, { method: "POST", headers }),
  { params: Promise.resolve({ id: saved.id }) },
);
assert.equal(blockedResponse.status, 409);
const blockedBody = await blockedResponse.json();
assert.equal(blockedBody.code, "EQUITY_REVIEW_REQUIRED");
assert.ok(blockedBody.pending.length > 0, "高可信自动映射必须经过人工审核");

const reviewedBrief = {
  ...hydrated.brief,
  headlines: hydrated.brief.headlines.map((headline: { equityImpacts: Array<{ mappingConfidence: number; reviewStatus: string }> }) => ({
    ...headline,
    equityImpacts: headline.equityImpacts.map((item) => ({
      ...item,
      reviewStatus: item.mappingConfidence >= 70 ? "approved" : item.reviewStatus,
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
