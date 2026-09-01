import assert from "node:assert/strict";
import { mergeRetainedEvidence } from "../lib/event-versioning";
import { publicationEvidenceIssues } from "../lib/publication-evidence";
import {
  defaultMaintainedEvidenceVersionIds,
  reconcileReviewedBriefEvidence,
  reviewedClaimRetainsCitationRelationship,
} from "../lib/review-evidence";
import {
  createEvidenceCitation,
  createHeadlineClaim,
  createSourceEvidence,
  MANUAL_EVIDENCE_REBIND_GENERATOR_VERSION,
  MANUAL_REVIEW_GENERATOR_VERSION,
} from "../lib/source-evidence";
import type {
  DailyBrief,
  Headline,
  HeadlineClaim,
  SourceEvidence,
  SourceLink,
} from "../lib/types";

const SOURCE_DOCUMENT_ID = "sd_review_gate_official_release";
const SOURCE_DOCUMENT_VERSION_ID = "sdv_review_gate_official_release_v1";
const EVIDENCE_VERSION_ID = "evv_review_gate_official_release_body_v1";
const CAPTURED_AT = "2026-07-22T01:05:00.000Z";

function exactEvidence(overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  return createSourceEvidence({
    versionId: EVIDENCE_VERSION_ID,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceDocumentVersionId: SOURCE_DOCUMENT_VERSION_ID,
    anchorKey: "rss:release-2026-07-22:description",
    quoteOriginal: "公司上调全年收入指引至 120 亿美元，并警告供应限制仍可能压低毛利率。",
    quoteLanguage: "zh-CN",
    locator: {
      kind: "feed_field",
      feedUrl: "https://investor.example.com/releases.xml",
      entryId: "release-2026-07-22",
      field: "description",
      fieldPath: "rss.channel.item[0].description",
    },
    locatorStatus: "exact",
    directness: "direct",
    captureScope: "rss_entry",
    extractionMethod: "fast-xml-parser:raw-field",
    extractorVersion: "source-evidence/v1",
    capturedAt: CAPTURED_AT,
    ...overrides,
  });
}

function exactSource(evidence: SourceEvidence): SourceLink {
  return {
    name: "Example Investor Relations",
    type: "Official",
    url: "https://investor.example.com/releases/2026-07-22",
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceDocumentVersionId: SOURCE_DOCUMENT_VERSION_ID,
    nativeId: "release-2026-07-22",
    canonicalUrl: "https://investor.example.com/releases/2026-07-22",
    originalTitle: "Company raises full-year revenue guidance",
    publishedAt: "2026-07-22T00:30:00.000Z",
    originalPublishedAt: "2026-07-22T00:30:00.000Z",
    collectedAt: CAPTURED_AT,
    timestampKind: "published",
    evidence: [evidence],
  };
}

interface ClaimFixture {
  claimKey: string;
  type: HeadlineClaim["type"];
  ordinal: number;
  statement: string;
}

function supportedClaim(fixture: ClaimFixture, evidence: SourceEvidence): HeadlineClaim {
  return createHeadlineClaim({
    ...fixture,
    originalStatement: fixture.statement,
    language: "zh-CN",
    verificationStatus: "supported",
    citations: [createEvidenceCitation(evidence, {
      relation: "supports",
      confidence: 1,
      order: 0,
    })],
    generator: "deterministic",
    generatorVersion: "review-publication-test/v1",
  });
}

function exactHighImpactHeadline(): Headline {
  const evidence = exactEvidence();
  const title = "公司上调全年收入指引";
  const summary = "全年收入指引提高至 120 亿美元，但供应限制仍是主要风险。";
  const keyPoint = "新指引为 120 亿美元，高于上一版预期。";
  const marketImpact = "收入预期上修利好盈利预测，供应限制则可能压低毛利率。";
  const directionRationale = "上调收入指引构成主要利好，但供应风险限制上涨幅度。";
  const claims = [
    supportedClaim({ claimKey: "title", type: "title", ordinal: 0, statement: title }, evidence),
    supportedClaim({ claimKey: "summary", type: "summary", ordinal: 1, statement: summary }, evidence),
    supportedClaim({
      claimKey: "important_information:0",
      type: "important_information",
      ordinal: 2,
      statement: keyPoint,
    }, evidence),
    supportedClaim({
      claimKey: "market_impact",
      type: "market_impact",
      ordinal: 3,
      statement: marketImpact,
    }, evidence),
    supportedClaim({
      claimKey: "direction_rationale",
      type: "direction_rationale",
      ordinal: 4,
      statement: directionRationale,
    }, evidence),
  ];

  return {
    id: "evt_review_gate_high_impact",
    rank: 1,
    ticker: "EXM",
    title,
    summary,
    keyPoints: [keyPoint],
    publishedAt: "2026-07-22T00:30:00.000Z",
    newsTimeSource: "Example Investor Relations",
    timestampKind: "published",
    marketImpact,
    marketDirection: "bullish",
    directionConfidence: 88,
    directionRationale,
    category: "Earnings",
    impact: 5,
    confidence: 93,
    mentions: 1,
    sentiment: "positive",
    sources: [exactSource(evidence)],
    claims,
  };
}

function exactBrief(): DailyBrief {
  return {
    id: "brief_review_gate_2026-07-22",
    date: "2026-07-22",
    generatedAt: "2026-07-22T01:10:00.000Z",
    mode: "live",
    aiEnabled: true,
    translationEnabled: true,
    status: "draft",
    storageMode: "postgres",
    stats: {
      candidates: 1,
      consolidatedEvents: 1,
      topStories: 1,
      sourcesOnline: 1,
    },
    headlines: [exactHighImpactHeadline()],
    marketHeat: [],
    socialBuzz: { reddit: [], x: [] },
    watchlist: [],
  };
}

function issueCodes(brief: DailyBrief): string[] {
  return publicationEvidenceIssues(brief).map((item) => `${item.claimKey}:${item.code}`);
}

// A complete high-impact assessment is publishable only when every required
// assertion points to the exact immutable source-document and evidence versions.
const clean = exactBrief();
assert.deepEqual(publicationEvidenceIssues(clean), [], "complete versioned evidence must pass publication");
assert.ok(clean.headlines[0].claims?.some((claim) => claim.claimKey === "direction_rationale"));

// Editing a factual key point cannot inherit the old citation. The server must
// rebuild the claim as pending while retaining all genuinely unchanged claims.
const editedSubmission = structuredClone(clean);
editedSubmission.headlines[0].keyPoints![0] = "新指引为 130 亿美元，高于上一版预期。";
const edited = reconcileReviewedBriefEvidence(clean, editedSubmission);
const editedPoint = edited.headlines[0].claims?.find((claim) => claim.claimKey === "important_information:0");
assert.equal(editedPoint?.statement, "新指引为 130 亿美元，高于上一版预期。");
assert.equal(editedPoint?.verificationStatus, "pending_confirmation");
assert.deepEqual(editedPoint?.citations, [], "an edited assertion must lose its stale citation");
assert.ok(
  issueCodes(edited).includes("important_information:0:CLAIM_PENDING"),
  "an edited assertion must block publication until it is re-evidenced",
);

// A reviewer may publish edited wording only by explicitly selecting exact
// immutable evidence versions from the previous claim. This is a rebind, not a
// silent inheritance of every old citation.
const manuallyRebound = reconcileReviewedBriefEvidence(clean, editedSubmission, {
  manualEditedClaimSupports: [{
    headlineId: clean.headlines[0].id,
    claimKey: "important_information:0",
    evidenceVersionIds: [EVIDENCE_VERSION_ID],
    method: "manual_evidence_rebind",
    note: "已核对原文，数字与期间均直接支持改写后的文字。",
  }],
});
const reboundPoint = manuallyRebound.headlines[0].claims?.find((claim) =>
  claim.claimKey === "important_information:0");
assert.equal(reboundPoint?.statement, editedSubmission.headlines[0].keyPoints?.[0]);
assert.equal(reboundPoint?.generator, "review");
assert.equal(reboundPoint?.generatorVersion, MANUAL_EVIDENCE_REBIND_GENERATOR_VERSION);
assert.equal(reboundPoint?.verificationStatus, "partially_supported");
assert.deepEqual(reboundPoint?.citations.map((citation) => citation.versionId), [EVIDENCE_VERSION_ID]);
assert.ok(
  !issueCodes(manuallyRebound).includes("important_information:0:CLAIM_PENDING"),
  "an exact manual evidence rebind must clear only the pending-claim blocker",
);
assert.throws(
  () => reconcileReviewedBriefEvidence(clean, editedSubmission, {
    manualEditedClaimSupports: [{
      headlineId: clean.headlines[0].id,
      claimKey: "important_information:0",
      evidenceVersionIds: ["00000000-0000-4000-8000-000000000099"],
      method: "manual_evidence_rebind",
      note: "伪造证据版本不能通过。",
    }],
  }),
  /不属于当前事件的精确证据/,
  "a review client cannot bind an unrelated evidence UUID to edited wording",
);

const unusedEvidence = exactEvidence({
  versionId: "evv_review_gate_official_release_supplement_v1",
  anchorKey: "rss:release-2026-07-22:supplement",
  quoteOriginal: "补充材料确认新指引为 130 亿美元。",
  locator: {
    kind: "feed_field",
    feedUrl: "https://investor.example.com/releases.xml",
    entryId: "release-2026-07-22",
    field: "content",
    fieldPath: "rss.channel.item[0].content",
  },
});
const eventWithUnusedEvidence = structuredClone(clean);
eventWithUnusedEvidence.headlines[0].sources[0].evidence?.push(unusedEvidence);
const editedWithUnusedEvidence = structuredClone(eventWithUnusedEvidence);
editedWithUnusedEvidence.headlines[0].keyPoints![0] =
  "补充材料确认新指引为 130 亿美元。";
const reboundToUnusedEvidence = reconcileReviewedBriefEvidence(
  eventWithUnusedEvidence,
  editedWithUnusedEvidence,
  {
    manualEditedClaimSupports: [{
      headlineId: eventWithUnusedEvidence.headlines[0].id,
      claimKey: "important_information:0",
      evidenceVersionIds: [unusedEvidence.versionId!],
      method: "manual_evidence_rebind",
      note: "改绑到同一事件中此前未被该声明使用的精确补充材料。",
    }],
  },
);
assert.deepEqual(
  reboundToUnusedEvidence.headlines[0].claims
    ?.find((claim) => claim.claimKey === "important_information:0")
    ?.citations.map((citation) => citation.versionId),
  [unusedEvidence.versionId],
  "manual review may bind exact evidence already stored on the same event even if the old claim did not cite it",
);

const contradictoryEvidence = exactEvidence({
  versionId: "evv_review_gate_official_release_contradiction_v1",
  anchorKey: "rss:release-2026-07-22:contradiction",
  quoteOriginal: "公司同时提示最终收入可能低于指引。",
});
const maintenanceIndirectEvidence = exactEvidence({
  versionId: "evv_review_gate_official_release_indirect_v1",
  anchorKey: "rss:release-2026-07-22:indirect",
  quoteOriginal: "分析师转述公司可能调整指引。",
  directness: "indirect",
});
const mixedRelationshipHeadline = exactHighImpactHeadline();
mixedRelationshipHeadline.sources[0].evidence?.push(
  contradictoryEvidence,
  maintenanceIndirectEvidence,
);
const mixedTitleClaim = mixedRelationshipHeadline.claims?.find((claim) =>
  claim.claimKey === "title");
assert.ok(mixedTitleClaim);
mixedTitleClaim.citations = [
  ...mixedTitleClaim.citations,
  createEvidenceCitation(contradictoryEvidence, {
    relation: "contradicts",
    confidence: 1,
    order: 1,
  }),
  createEvidenceCitation(maintenanceIndirectEvidence, {
    relation: "supports",
    confidence: 0.7,
    order: 2,
  }),
];
assert.deepEqual(
  defaultMaintainedEvidenceVersionIds(mixedRelationshipHeadline, mixedTitleClaim),
  [EVIDENCE_VERSION_ID],
  "evidence maintenance must preselect only the old exact, direct support relationship",
);
const explicitContradictionRebind = reconcileReviewedBriefEvidence(
  {
    ...exactBrief(),
    headlines: [mixedRelationshipHeadline],
  },
  {
    ...exactBrief(),
    headlines: [structuredClone(mixedRelationshipHeadline)],
  },
  {
    manualEditedClaimSupports: [{
      headlineId: mixedRelationshipHeadline.id,
      claimKey: "title",
      evidenceVersionIds: [contradictoryEvidence.versionId!],
      method: "manual_evidence_rebind",
      note: "审核人主动选择该精确原文作为新版标题的支持证据。",
    }],
  },
);
const reboundTitleClaim = explicitContradictionRebind.headlines[0].claims?.find((claim) =>
  claim.claimKey === "title");
assert.equal(reboundTitleClaim?.citations[0].relation, "supports");
assert.equal(
  reviewedClaimRetainsCitationRelationship(
    reboundTitleClaim,
    mixedTitleClaim.citations[1],
  ),
  false,
  "changing an old contradiction into support must be audited as removal plus explicit rebind",
);

const unchangedCitationRemoved = reconcileReviewedBriefEvidence(clean, structuredClone(clean), {
  manualEditedClaimSupports: [{
    headlineId: clean.headlines[0].id,
    claimKey: "title",
    evidenceVersionIds: [],
    method: "manual_evidence_rebind",
    note: "原有标题引用不支持当前判断，先撤下并保留为待确认。",
  }],
});
const titleWithoutSupport = unchangedCitationRemoved.headlines[0].claims
  ?.find((claim) => claim.claimKey === "title");
assert.equal(titleWithoutSupport?.verificationStatus, "pending_confirmation");
assert.deepEqual(titleWithoutSupport?.citations, []);

const addedPointSubmission = structuredClone(eventWithUnusedEvidence);
addedPointSubmission.headlines[0].keyPoints?.push("补充材料确认新指引为 130 亿美元。");
const addedPointWithEvidence = reconcileReviewedBriefEvidence(
  eventWithUnusedEvidence,
  addedPointSubmission,
  {
    manualEditedClaimSupports: [{
      headlineId: eventWithUnusedEvidence.headlines[0].id,
      claimKey: "important_information:1",
      evidenceVersionIds: [unusedEvidence.versionId!],
      method: "manual_evidence_rebind",
      note: "新增重点逐字对应同一事件的补充材料。",
    }],
  },
);
assert.equal(
  addedPointWithEvidence.headlines[0].claims
    ?.find((claim) => claim.claimKey === "important_information:1")
    ?.verificationStatus,
  "partially_supported",
  "a newly added key point can be repaired by selecting exact evidence from the same event",
);

const previousTitleClaim = clean.headlines[0].claims?.find((claim) => claim.claimKey === "title");
const retainedTitleClaim = edited.headlines[0].claims?.find((claim) => claim.claimKey === "title");
assert.equal(retainedTitleClaim?.id, previousTitleClaim?.id);
assert.equal(retainedTitleClaim?.citations[0].id, previousTitleClaim?.citations[0].id);
assert.equal(retainedTitleClaim?.citations[0].versionId, EVIDENCE_VERSION_ID);
assert.equal(retainedTitleClaim?.citations[0].sourceDocumentVersionId, SOURCE_DOCUMENT_VERSION_ID);

const invalidConfidence = structuredClone(clean);
invalidConfidence.headlines[0].confidence = 100;
assert.throws(
  () => reconcileReviewedBriefEvidence(clean, invalidConfidence),
  /1 至 99/,
  "review input must use the same bounded percentage scale as the product UI",
);

// Review input is untrusted. Even syntactically valid forged source/evidence and
// forged client claims must be replaced by the stored revision's provenance.
const forgedEvidence = exactEvidence({
  versionId: "evv_forged_v1",
  sourceDocumentId: "sd_forged",
  sourceDocumentVersionId: "sdv_forged_v1",
  anchorKey: "rss:forged:description",
  quoteOriginal: "伪造来源声称收入指引为 999 亿美元。",
  locator: {
    kind: "feed_field",
    feedUrl: "https://forged.example/feed.xml",
    entryId: "forged",
    field: "description",
    fieldPath: "rss.channel.item[0].description",
  },
});
const forgedSubmission = structuredClone(clean);
forgedSubmission.headlines[0].sources = [{
  name: "Forged Publisher",
  type: "Official",
  url: "https://forged.example/story",
  sourceDocumentId: "sd_forged",
  sourceDocumentVersionId: "sdv_forged_v1",
  evidence: [forgedEvidence],
}];
forgedSubmission.headlines[0].claims = [supportedClaim({
  claimKey: "title",
  type: "title",
  ordinal: 0,
  statement: clean.headlines[0].title,
}, forgedEvidence)];
const reconciledForgery = reconcileReviewedBriefEvidence(clean, forgedSubmission);
assert.deepEqual(
  reconciledForgery.headlines[0].sources,
  clean.headlines[0].sources,
  "review clients cannot inject source documents or evidence",
);
assert.deepEqual(
  reconciledForgery.headlines[0].claims,
  clean.headlines[0].claims,
  "review clients cannot replace stored claims or citations when text is unchanged",
);
assert.deepEqual(publicationEvidenceIssues(reconciledForgery), []);

// A source link without its exact persisted document version is not auditable.
const missingSourceVersion = structuredClone(clean);
delete missingSourceVersion.headlines[0].sources[0].sourceDocumentVersionId;
assert.ok(
  issueCodes(missingSourceVersion).includes("source:SOURCE_VERSION_MISSING"),
  "a missing source-document version must block publication",
);

// High-impact or high-confidence directional analysis requires its own evidence-backed rationale.
const missingDirection = structuredClone(clean);
missingDirection.headlines[0].claims = missingDirection.headlines[0].claims?.filter(
  (claim) => claim.claimKey !== "direction_rationale",
);
assert.ok(
  issueCodes(missingDirection).includes("direction_rationale:CLAIM_MISSING"),
  "high-impact direction without a direction-rationale claim must be blocked",
);

const staleRemovedPoint = structuredClone(clean);
staleRemovedPoint.headlines[0].keyPoints = [];
assert.ok(
  issueCodes(staleRemovedPoint).includes("important_information:0:CLAIM_UNEXPECTED"),
  "a removed page field must not leave an old evidence-backed claim hidden in the event version",
);
const incomingWithoutPoint = structuredClone(clean.headlines[0]);
incomingWithoutPoint.keyPoints = [];
incomingWithoutPoint.claims = incomingWithoutPoint.claims?.filter(
  (claim) => claim.claimKey !== "important_information:0",
);
const mergedWithoutPoint = mergeRetainedEvidence(clean.headlines[0], incomingWithoutPoint);
assert.equal(
  mergedWithoutPoint.claims?.some((claim) => claim.claimKey === "important_information:0"),
  false,
  "event-version merging must not resurrect a removed page-field claim",
);

const lowImpactBullishWithoutRationale = structuredClone(clean);
lowImpactBullishWithoutRationale.headlines[0].impact = 2;
lowImpactBullishWithoutRationale.headlines[0].directionConfidence = 50;
delete lowImpactBullishWithoutRationale.headlines[0].directionRationale;
lowImpactBullishWithoutRationale.headlines[0].claims = lowImpactBullishWithoutRationale.headlines[0].claims?.filter(
  (claim) => claim.claimKey !== "direction_rationale",
);
assert.ok(
  issueCodes(lowImpactBullishWithoutRationale).includes("direction_rationale:CLAIM_MISSING"),
  "an explicit bullish/bearish/mixed judgment requires evidence even when impact is low",
);

const exactDirection = exactBrief();
assert.deepEqual(
  publicationEvidenceIssues(exactDirection),
  [],
  "an exact, fully versioned high-impact direction claim must pass",
);

// Legacy payloads are never grandfathered into a new publication merely because
// they contain polished prose. They must be regenerated or explicitly evidenced.
const noClaims = structuredClone(clean);
delete noClaims.headlines[0].claims;
const noClaimCodes = issueCodes(noClaims);
assert.ok(noClaimCodes.includes("title:CLAIM_MISSING"));
assert.ok(noClaimCodes.includes("direction_rationale:CLAIM_MISSING"));

const legacyClaim = structuredClone(clean);
const legacyTitle = legacyClaim.headlines[0].claims?.find((claim) => claim.claimKey === "title");
assert.ok(legacyTitle);
legacyTitle.verificationStatus = "legacy_unverified";
legacyTitle.citations = [];
assert.ok(
  issueCodes(legacyClaim).includes("title:CLAIM_PENDING"),
  "legacy-unverified prose must block a new publication",
);

// Unavailable evidence is useful for recording a truthful collection gap, but
// it must never be relabelled as positive support for any claim.
const unavailableEvidence = createSourceEvidence({
  versionId: "evv_unavailable_body_v1",
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourceDocumentVersionId: SOURCE_DOCUMENT_VERSION_ID,
  anchorKey: "rss:release-2026-07-22:body-unavailable",
  locator: { kind: "unavailable", reasonCode: "body_not_collected" },
  locatorStatus: "unavailable",
  directness: "unavailable",
  captureScope: "rss_entry",
  extractionMethod: "feed-metadata-only",
  extractorVersion: "source-evidence/v1",
  capturedAt: CAPTURED_AT,
});
assert.throws(
  () => createEvidenceCitation(unavailableEvidence, { relation: "supports" }),
  /unavailable evidence cannot be labelled as supporting/i,
);

// Indirect evidence can justify a partially-supported inference, not a fully
// supported assertion. Active counter-evidence also downgrades full support.
const indirectEvidence = exactEvidence({ directness: "indirect" });
assert.throws(() => createHeadlineClaim({
  claimKey: "indirect_test",
  type: "summary",
  ordinal: 0,
  statement: "该判断来自间接索引。",
  originalStatement: "该判断来自间接索引。",
  language: "zh-CN",
  verificationStatus: "supported",
  citations: [createEvidenceCitation(indirectEvidence)],
  generator: "deterministic",
  generatorVersion: "review-publication-test/v1",
}), /direct, exact supporting citation/i);
assert.doesNotThrow(() => createHeadlineClaim({
  claimKey: "indirect_partial_test",
  type: "summary",
  ordinal: 0,
  statement: "该判断来自间接索引。",
  originalStatement: "该判断来自间接索引。",
  language: "zh-CN",
  verificationStatus: "partially_supported",
  citations: [createEvidenceCitation(indirectEvidence)],
  generator: "deterministic",
  generatorVersion: "review-publication-test/v1",
}));
assert.throws(() => createHeadlineClaim({
  claimKey: "contradiction_test",
  type: "summary",
  ordinal: 0,
  statement: "该判断同时存在反证。",
  originalStatement: "该判断同时存在反证。",
  language: "zh-CN",
  verificationStatus: "supported",
  citations: [
    createEvidenceCitation(exactEvidence(), { relation: "supports", order: 0 }),
    createEvidenceCitation(exactEvidence(), { relation: "contradicts", order: 1 }),
  ],
  generator: "deterministic",
  generatorVersion: "review-publication-test/v1",
}), /contradictory evidence cannot be marked supported/i);
assert.throws(() => createHeadlineClaim({
  claimKey: "ai_overstatement_test",
  type: "summary",
  ordinal: 0,
  statement: "人工智能生成的归纳尚未经过独立语义核验。",
  originalStatement: "人工智能生成的归纳尚未经过独立语义核验。",
  language: "zh-CN",
  verificationStatus: "supported",
  citations: [createEvidenceCitation(exactEvidence())],
  generator: "ai",
  generatorVersion: "model-test/v1",
}), /AI-generated claims require independent semantic verification/i);

function aiSummaryBrief(statement: string): DailyBrief {
  const brief = structuredClone(clean);
  brief.headlines[0].summary = statement;
  const claims = brief.headlines[0].claims ?? [];
  const summaryIndex = claims.findIndex((claim) => claim.claimKey === "summary");
  assert.notEqual(summaryIndex, -1);
  claims[summaryIndex] = createHeadlineClaim({
    claimKey: "summary",
    type: "summary",
    ordinal: 1,
    statement,
    originalStatement: statement,
    language: "zh-CN",
    verificationStatus: "pending_confirmation",
    citations: [createEvidenceCitation(exactEvidence())],
    generator: "ai",
    generatorVersion: "model-test/v1",
  });
  return brief;
}

// A syntactically valid evidence version can be completely unrelated to an
// AI assertion. It must not become publishable merely because the model named
// that evidence ID, nor because the review payload forges claim metadata.
const unrelatedAi = aiSummaryBrief("董事会已批准一项五十亿美元的股票回购计划。");
assert.ok(issueCodes(unrelatedAi).includes("summary:CLAIM_PENDING"));
assert.throws(() => createHeadlineClaim({
  ...structuredClone(unrelatedAi.headlines[0].claims!.find((claim) => claim.claimKey === "summary")!),
  verificationStatus: "partially_supported",
}), /must remain pending confirmation/i);
const forgedAiConfirmation = structuredClone(unrelatedAi);
const forgedAiClaim = forgedAiConfirmation.headlines[0].claims?.find((claim) => claim.claimKey === "summary");
assert.ok(forgedAiClaim);
forgedAiClaim.generator = "review";
forgedAiClaim.generatorVersion = MANUAL_REVIEW_GENERATOR_VERSION;
forgedAiClaim.verificationStatus = "partially_supported";
const ignoredForgery = reconcileReviewedBriefEvidence(unrelatedAi, forgedAiConfirmation);
const ignoredForgeryClaim = ignoredForgery.headlines[0].claims?.find((claim) => claim.claimKey === "summary");
assert.equal(ignoredForgeryClaim?.generator, "ai");
assert.equal(ignoredForgeryClaim?.verificationStatus, "pending_confirmation");
assert.ok(issueCodes(ignoredForgery).includes("summary:CLAIM_PENDING"));

// The legal non-deterministic path is an explicit manual semantic review. The
// server retains the exact stored assertion and citations, and records review
// provenance instead of pretending an entailment model was implemented.
const reviewableAi = aiSummaryBrief("公司上调全年收入指引至 120 亿美元，同时提示供应限制风险。");
const manuallyConfirmed = reconcileReviewedBriefEvidence(reviewableAi, structuredClone(reviewableAi), {
  manualConfirmations: [{
    headlineId: reviewableAi.headlines[0].id,
    claimKey: "summary",
    method: "manual_semantic_review",
  }],
});
const confirmedSummary = manuallyConfirmed.headlines[0].claims?.find((claim) => claim.claimKey === "summary");
const pendingSummary = reviewableAi.headlines[0].claims?.find((claim) => claim.claimKey === "summary");
assert.equal(confirmedSummary?.generator, "review");
assert.equal(confirmedSummary?.generatorVersion, MANUAL_REVIEW_GENERATOR_VERSION);
assert.equal(confirmedSummary?.verificationStatus, "partially_supported");
assert.deepEqual(confirmedSummary?.citations, pendingSummary?.citations, "manual review must retain server citations");
assert.deepEqual(publicationEvidenceIssues(manuallyConfirmed), []);

const editedWhileConfirming = structuredClone(reviewableAi);
editedWhileConfirming.headlines[0].summary = "改写后的判断不能沿用旧证据。";
assert.throws(
  () => reconcileReviewedBriefEvidence(reviewableAi, editedWhileConfirming, {
    manualConfirmations: [{
      headlineId: reviewableAi.headlines[0].id,
      claimKey: "summary",
      method: "manual_semantic_review",
    }],
  }),
  /已被编辑，必须重新绑定证据/,
);

// Publication is blocked by every pending claim, not only claims mapped to a
// currently required UI field.
const extraPending = structuredClone(clean);
extraPending.headlines[0].claims?.push(createHeadlineClaim({
  claimKey: "equity_impact:EXM",
  type: "equity_impact",
  ordinal: 99,
  statement: "EXM 可能受益，仍待确认。",
  originalStatement: "EXM 可能受益，仍待确认。",
  language: "zh-CN",
  verificationStatus: "pending_confirmation",
  citations: [],
  generator: "review",
  generatorVersion: "review-console/v2",
}));
assert.ok(issueCodes(extraPending).includes("equity_impact:EXM:CLAIM_PENDING"));
const pendingAfterReview = reconcileReviewedBriefEvidence(extraPending, structuredClone(extraPending));
assert.ok(
  issueCodes(pendingAfterReview).includes("equity_impact:EXM:CLAIM_PENDING"),
  "saving a review must not discard supplemental pending claims",
);

// Every citation and every source evidence projection must name exact immutable
// versions, including non-required supplemental claims/evidence.
const missingCitationVersion = structuredClone(clean);
const titleCitation = missingCitationVersion.headlines[0].claims?.find((claim) => claim.claimKey === "title")?.citations[0];
assert.ok(titleCitation);
delete titleCitation.versionId;
assert.ok(issueCodes(missingCitationVersion).includes("title:CITATION_VERSION_MISSING"));

const missingEvidenceVersion = structuredClone(clean);
missingEvidenceVersion.headlines[0].sources[0].evidence?.push(createSourceEvidence({
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourceDocumentVersionId: SOURCE_DOCUMENT_VERSION_ID,
  anchorKey: "rss:release-2026-07-22:supplemental",
  quoteOriginal: "补充材料未被任何当前声明引用。",
  quoteLanguage: "zh-CN",
  locator: {
    kind: "feed_field",
    feedUrl: "https://investor.example.com/releases.xml",
    entryId: "release-2026-07-22",
    field: "content",
    fieldPath: "rss.channel.item[0].content",
  },
  locatorStatus: "exact",
  directness: "direct",
  captureScope: "rss_entry",
  extractionMethod: "fast-xml-parser:raw-field",
  extractorVersion: "source-evidence/v1",
  capturedAt: CAPTURED_AT,
}));
assert.ok(issueCodes(missingEvidenceVersion).includes("source:0:SOURCE_EVIDENCE_VERSION_MISSING"));

// Changing a direction judgment invalidates both its rationale and the broader
// market-impact assessment even when their display prose was left untouched.
const changedDirectionSubmission = structuredClone(clean);
changedDirectionSubmission.headlines[0].marketDirection = "bearish";
const changedDirection = reconcileReviewedBriefEvidence(clean, changedDirectionSubmission);
assert.equal(
  changedDirection.headlines[0].claims?.find((claim) => claim.claimKey === "direction_rationale")?.verificationStatus,
  "pending_confirmation",
);
assert.equal(
  changedDirection.headlines[0].claims?.find((claim) => claim.claimKey === "market_impact")?.verificationStatus,
  "pending_confirmation",
);

// Removing a key point changes later visual ordinals. Retained claims keep the
// same evidence but are re-indexed by the server, so no duplicate/stale order
// can slip through the publication gate.
const twoPointBrief = structuredClone(clean);
const pointTwo = "供应限制仍可能压低毛利率。";
twoPointBrief.headlines[0].keyPoints?.push(pointTwo);
twoPointBrief.headlines[0].claims = [
  ...(twoPointBrief.headlines[0].claims ?? []).filter((claim) => claim.claimKey !== "market_impact" && claim.claimKey !== "direction_rationale"),
  supportedClaim({ claimKey: "important_information:1", type: "important_information", ordinal: 3, statement: pointTwo }, exactEvidence()),
  supportedClaim({ claimKey: "market_impact", type: "market_impact", ordinal: 4, statement: twoPointBrief.headlines[0].marketImpact }, exactEvidence()),
  supportedClaim({ claimKey: "direction_rationale", type: "direction_rationale", ordinal: 5, statement: twoPointBrief.headlines[0].directionRationale! }, exactEvidence()),
];
assert.deepEqual(publicationEvidenceIssues(twoPointBrief), []);
const onePointSubmission = structuredClone(twoPointBrief);
onePointSubmission.headlines[0].keyPoints = [onePointSubmission.headlines[0].keyPoints![0]];
const onePointReviewed = reconcileReviewedBriefEvidence(twoPointBrief, onePointSubmission);
assert.equal(
  onePointReviewed.headlines[0].claims?.find((claim) => claim.claimKey === "market_impact")?.ordinal,
  3,
);
assert.equal(
  onePointReviewed.headlines[0].claims?.find((claim) => claim.claimKey === "direction_rationale")?.ordinal,
  4,
);
assert.deepEqual(publicationEvidenceIssues(onePointReviewed), []);

const staleOrdinal = structuredClone(clean);
const staleMarketImpact = staleOrdinal.headlines[0].claims?.find((claim) => claim.claimKey === "market_impact");
assert.ok(staleMarketImpact);
staleMarketImpact.ordinal = 98;
assert.ok(issueCodes(staleOrdinal).includes("market_impact:CLAIM_ORDINAL_MISMATCH"));

// The review payload is a patch request, not a replacement authority. Event
// identity, scores, sentiment, collection time and equity reasoning cannot be
// changed by posting a handcrafted JSON object; only approval status may move.
const authorityBrief = structuredClone(clean);
authorityBrief.headlines[0].equityImpacts = [{
  symbol: "EXM",
  providerSymbol: "EXM",
  companyName: "Example Corp",
  direction: "potential_upside",
  relation: "issuer",
  mappingConfidence: 91,
  directionConfidence: 84,
  mechanism: "收入指引上调可能提高盈利预期。",
  assumptions: ["新指引能够兑现"],
  counterCase: "供应限制可能抵消收入上修。",
  evidence: [{ basis: "explicit_symbol", statement: "公告明确指向 EXM。", weight: 1 }],
  engineVersion: "equity-impact/v1",
  reviewStatus: "auto_pending",
}];
const forgedMetadata = structuredClone(authorityBrief);
forgedMetadata.date = "2099-01-01";
forgedMetadata.generatedAt = "2099-01-01T00:00:00.000Z";
forgedMetadata.mode = "demo";
forgedMetadata.headlines[0].rank = 99;
forgedMetadata.headlines[0].ticker = "HACK";
forgedMetadata.headlines[0].sentiment = "negative";
forgedMetadata.headlines[0].publishedAt = "2099-01-01T00:00:00.000Z";
forgedMetadata.headlines[0].equityImpacts![0] = {
  ...forgedMetadata.headlines[0].equityImpacts![0],
  direction: "potential_downside",
  mappingConfidence: 1,
  mechanism: "伪造机制",
  reviewStatus: "approved",
};
const sanitized = reconcileReviewedBriefEvidence(authorityBrief, forgedMetadata);
assert.equal(sanitized.date, authorityBrief.date);
assert.equal(sanitized.generatedAt, authorityBrief.generatedAt);
assert.equal(sanitized.mode, authorityBrief.mode);
assert.equal(sanitized.headlines[0].rank, authorityBrief.headlines[0].rank);
assert.equal(sanitized.headlines[0].ticker, authorityBrief.headlines[0].ticker);
assert.equal(sanitized.headlines[0].sentiment, authorityBrief.headlines[0].sentiment);
assert.equal(sanitized.headlines[0].publishedAt, authorityBrief.headlines[0].publishedAt);
assert.equal(sanitized.headlines[0].equityImpacts?.[0].direction, "potential_upside");
assert.equal(sanitized.headlines[0].equityImpacts?.[0].mappingConfidence, 91);
assert.equal(sanitized.headlines[0].equityImpacts?.[0].mechanism, "收入指引上调可能提高盈利预期。");
assert.equal(sanitized.headlines[0].equityImpacts?.[0].reviewStatus, "approved");

const removedHeadline = structuredClone(clean);
removedHeadline.headlines = [];
assert.throws(
  () => reconcileReviewedBriefEvidence(clean, removedHeadline),
  /事件集合与数据库草稿不一致/,
);

// Malformed stored JSON must fail closed as evidence issues instead of turning
// the publish endpoint into a 500 response.
const malformed = structuredClone(clean);
(malformed.headlines[0] as unknown as { sources: null }).sources = null;
(malformed.headlines[0] as unknown as { claims: null }).claims = null;
assert.doesNotThrow(() => publicationEvidenceIssues(malformed));
assert.ok(issueCodes(malformed).some((code) => code.endsWith(":EVIDENCE_INVALID")));

console.log("review and publication evidence tests passed");
