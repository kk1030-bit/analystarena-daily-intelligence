import assert from "node:assert/strict";
import {
  compareEventBaseline,
  compareEventVersions,
  compareSnapshotEvent,
  extractNumericFacts,
  NUMERIC_FACT_PARSER_VERSION,
  projectWhatChanged,
  WhatChangedIntegrityError,
} from "../lib/what-changed";
import type {
  BriefSnapshotEventRecord,
  EvidenceCitation,
  EventVersionRecord,
  Headline,
  HeadlineClaim,
  NumericFact,
  SourceEvidence,
} from "../lib/types";

function evidence(itemId: string, versionId: string, sourceVersionId: string): SourceEvidence {
  return {
    id: itemId,
    versionId,
    sourceDocumentId: `doc_${itemId}`,
    sourceDocumentVersionId: sourceVersionId,
    anchorKey: "body",
    quoteOriginal: `${itemId} exact quote`,
    quoteHash: "a".repeat(64),
    quoteLanguage: "en",
    locator: {
      kind: "feed_field",
      feedUrl: "https://example.com/feed.xml",
      entryId: itemId,
      field: "description",
      fieldPath: "entry.description",
    },
    locatorHash: "b".repeat(64),
    locatorStatus: "exact",
    directness: "direct",
    captureScope: "rss_entry",
    extractionMethod: "test",
    extractorVersion: "test/v1",
    capturedAt: "2026-07-23T01:00:00.000Z",
  };
}

function support(item: SourceEvidence, order = 0): EvidenceCitation {
  return { ...structuredClone(item), relation: "supports", confidence: 1, order };
}

function claim(claimKey: string, citations: EvidenceCitation[]): HeadlineClaim {
  return {
    id: `claim_${claimKey}`,
    claimKey,
    type: "summary",
    ordinal: 0,
    statement: "公司将全年收入指引从 100 亿美元上调至 120 亿美元。",
    originalStatement: "The company raised full-year revenue guidance from USD 10bn to USD 12bn.",
    statementHash: "c".repeat(64),
    language: "zh-CN",
    verificationStatus: "supported",
    citations,
    generator: "deterministic",
    generatorVersion: "test/v1",
  };
}

function headline(
  sourceEvidence: SourceEvidence[],
  claims: HeadlineClaim[],
  marketDirection: Headline["marketDirection"],
): Headline {
  return {
    id: "evt_test",
    rank: 1,
    ticker: "NVDA",
    title: "测试事件",
    summary: "测试摘要",
    keyPoints: [],
    marketImpact: "测试影响",
    marketDirection,
    category: "Earnings",
    impact: 5,
    confidence: 90,
    mentions: 2,
    sentiment: "neutral",
    sources: [{
      name: "Test Wire",
      type: "News",
      url: "https://example.com/story",
      sourceDocumentId: "doc_source",
      sourceDocumentVersionId: "source_version",
      evidence: sourceEvidence,
    }],
    claims,
  };
}

function version(
  id: string,
  versionNumber: number,
  item: Headline,
  previousVersionId?: string,
): EventVersionRecord {
  return {
    id,
    eventId: "evt_test",
    versionNumber,
    previousVersionId,
    contentHash: "d".repeat(64),
    evidenceHash: "e".repeat(64),
    stateHash: "f".repeat(64),
    presentationHash: "1".repeat(64),
    observedAt: `2026-07-23T0${versionNumber}:00:00.000Z`,
    runId: `run_${versionNumber}`,
    headline: item,
    createdAt: `2026-07-23T0${versionNumber}:00:01.000Z`,
  };
}

function numericFact(
  value: number,
  evidenceVersionId: string,
  overrides: Record<string, unknown> = {},
): NumericFact {
  const originalText = "The company raised full-year revenue guidance from USD 10bn to USD 12bn.";
  const rawToken = value === 10 ? "USD 10bn" : "USD 12bn";
  const startOffset = originalText.indexOf(rawToken);
  return {
    factKey: "summary:revenue-guidance:fy2026",
    claimKey: "summary",
    metricKey: "revenue_guidance",
    subjectKey: "issuer",
    periodKey: "FY2026",
    value: String(value),
    unit: "currency",
    currency: "USD",
    scale: "billion",
    rawToken,
    startOffset,
    endOffset: startOffset + rawToken.length,
    originalText,
    parserVersion: NUMERIC_FACT_PARSER_VERSION,
    comparisonStatus: "comparable",
    comparisonReason: "explicit currency unit and fiscal period",
    evidenceVersionIds: [evidenceVersionId],
    ...overrides,
  };
}

const evA1 = evidence("ev_a", "ev_a_v1", "doc_a_v1");
const evA2 = evidence("ev_a", "ev_a_v2", "doc_a_v2");
const evB = evidence("ev_b", "ev_b_v1", "doc_b_v1");
const evC = evidence("ev_c", "ev_c_v1", "doc_c_v1");

const first = version("version_1", 1, headline([evA1, evB], [claim("summary", [support(evB)])], "bullish"));
const firstSeen = compareEventVersions(undefined, first);
assert.equal(firstSeen.status, "first_seen");
assert.deepEqual(firstSeen.items.map((change) => change.kind), ["first_seen"]);
assert.ok(
  firstSeen.items.every((change) => !["direction_changed", "direction_established", "numeric_changed"].includes(change.kind)),
  "没有上一版本时只能产生首次发现，不能捏造方向或数字变化",
);

assert.throws(
  () => compareEventVersions(undefined, { ...first, id: "orphan_v2", versionNumber: 2 }),
  (error: unknown) => error instanceof WhatChangedIntegrityError
    && error.code === "BROKEN_EVENT_VERSION_CHAIN",
  "缺少上一版的 v2 不能被降级成首次发现",
);

const second = version(
  "version_2",
  2,
  headline([evA2, evC], [claim("summary", [support(evC)])], "bearish"),
  first.id,
);
const changed = compareEventVersions(first, second, {
  previous: [numericFact(10, evB.versionId!)],
  current: [numericFact(12, evC.versionId!)],
});
assert.equal(changed.status, "changed");
assert.deepEqual(
  changed.items.map((change) => change.kind),
  [
    "evidence_added",
    "evidence_removed",
    "evidence_revised",
    "claim_support_added",
    "claim_support_removed",
    "numeric_changed",
    "direction_changed",
  ],
);
const revisedEvidence = changed.items.find((change) => change.kind === "evidence_revised");
assert.equal(revisedEvidence?.before?.evidenceVersionId, evA1.versionId);
assert.equal(revisedEvidence?.after?.evidenceVersionId, evA2.versionId);
const numericChange = changed.items.find((change) => change.kind === "numeric_changed");
assert.equal(numericChange?.before?.value, "10");
assert.equal(numericChange?.after?.value, "12");

const supportAnchorV1 = version(
  "support_anchor_v1",
  1,
  headline([evA1], [claim("summary", [support(evA1)])], "bullish"),
);
const supportAnchorV2 = version(
  "support_anchor_v2",
  2,
  headline([evA2], [claim("summary", [support(evA2)])], "bullish"),
  supportAnchorV1.id,
);
const revisedSupport = compareEventVersions(supportAnchorV1, supportAnchorV2);
assert.equal(revisedSupport.items.some((change) => change.kind === "evidence_revised"), true);
assert.equal(
  revisedSupport.items.some((change) => change.kind === "claim_support_changed"),
  true,
  "同一 claim/evidence item 换 exact evidence version 时必须保留 before/after 支持关系",
);

const third = version(
  "version_3",
  3,
  headline([evA1, evB], [claim("summary", [support(evB)])], "bullish"),
  second.id,
);
const returnedToA = compareEventVersions(second, third, {
  previous: [numericFact(12, evC.versionId!)],
  current: [numericFact(10, evB.versionId!)],
});
assert.equal(returnedToA.items.find((change) => change.kind === "numeric_changed")?.before?.value, "12");
assert.equal(returnedToA.items.find((change) => change.kind === "numeric_changed")?.after?.value, "10");
assert.equal(returnedToA.items.find((change) => change.kind === "direction_changed")?.before?.direction, "bearish");
assert.equal(returnedToA.items.find((change) => change.kind === "direction_changed")?.after?.direction, "bullish");

const incompatibleNumbers = compareEventVersions(first, second, {
  previous: [numericFact(10, evB.versionId!)],
  current: [numericFact(12, evC.versionId!, { currency: "EUR" })],
});
assert.equal(
  incompatibleNumbers.items.some((change) => change.kind === "numeric_changed"),
  false,
  "币种不同的数字必须保持不可比，不能生成数字变化",
);
const incompatiblePeriod = compareEventVersions(first, second, {
  previous: [numericFact(10, evB.versionId!)],
  current: [numericFact(12, evC.versionId!, { periodKey: "FY2027" })],
});
assert.equal(
  incompatiblePeriod.items.some((change) => change.kind === "numeric_changed"),
  false,
  "期间不同的数字不能生成变化",
);

const directionAddedVersion = version(
  "direction_added_v2",
  2,
  headline([evA1, evB], [claim("summary", [support(evB)])], "bullish"),
  first.id,
);
const directionAdded = compareEventVersions(
  { ...first, headline: { ...first.headline, marketDirection: undefined } },
  directionAddedVersion,
);
assert.equal(directionAdded.items.some((change) => change.kind === "direction_established"), true);
assert.equal(directionAdded.items.some((change) => change.kind === "direction_changed"), false);

const missingEvidenceVersion = structuredClone(second);
delete missingEvidenceVersion.headline.sources[0].evidence?.[0].versionId;
assert.throws(
  () => compareEventVersions(first, missingEvidenceVersion),
  (error: unknown) => error instanceof WhatChangedIntegrityError
    && error.code === "INVALID_COMPARISON_INPUT",
  "缺少 exact evidence version 时必须 fail closed",
);

assert.throws(
  () => compareEventVersions(first, { ...second, previousVersionId: "not_first" }),
  (error: unknown) => error instanceof WhatChangedIntegrityError
    && error.code === "NON_ADJACENT_EVENT_VERSIONS",
);

function snapshot(
  snapshotId: string,
  eventVersionId: string,
  rank: number,
): BriefSnapshotEventRecord {
  return {
    snapshotId,
    eventId: "evt_test",
    eventVersionId,
    rank,
    impact: 5,
    confidence: 90,
    mentions: 2,
    matchMethod: "existing_id",
    matchConfidence: 1,
  };
}

const previousSnapshot = snapshot("snapshot_1", first.id, 3);
const currentSnapshot = snapshot("snapshot_2", second.id, 1);
const rankUp = compareSnapshotEvent({
  baselineKind: "previous_observation",
  baselineSnapshotId: previousSnapshot.snapshotId,
  baselineEvent: previousSnapshot,
  current: currentSnapshot,
  currentSnapshotId: currentSnapshot.snapshotId,
  comparedAt: "2026-07-23T02:00:00.000Z",
  contentComparison: changed,
});
assert.equal(rankUp.items.some((change) => change.kind === "rank_up"), true);
assert.equal(rankUp.rankDelta, 2, "rankDelta 必须定义为 previous-current");
const rankDownBaseline = snapshot("snapshot_2", second.id, 1);
const rankDownCurrent = snapshot("snapshot_3", third.id, 4);
const rankDown = compareSnapshotEvent({
  baselineKind: "previous_observation",
  baselineSnapshotId: rankDownBaseline.snapshotId,
  baselineEvent: rankDownBaseline,
  current: rankDownCurrent,
  currentSnapshotId: rankDownCurrent.snapshotId,
  comparedAt: "2026-07-23T03:00:00.000Z",
  contentComparison: returnedToA,
});
assert.equal(rankDown.items.some((change) => change.kind === "rank_down"), true);
assert.equal(rankDown.rankDelta, -3);
const entered = compareSnapshotEvent({
  baselineKind: "previous_published",
  baselineSnapshotId: "snapshot_published",
  current: snapshot("snapshot_4", third.id, 2),
  currentSnapshotId: "snapshot_4",
  comparedAt: "2026-07-23T04:00:00.000Z",
});
assert.equal(entered.presence, "entered");
assert.equal(entered.items[0]?.kind, "entered");
assert.equal(entered.rankDelta, undefined);
const reentered = compareSnapshotEvent({
  baselineKind: "previous_published",
  baselineSnapshotId: "snapshot_published",
  historicalObservation: previousSnapshot,
  current: snapshot("snapshot_4", third.id, 2),
  currentSnapshotId: "snapshot_4",
  comparedAt: "2026-07-23T04:00:00.000Z",
});
assert.equal(reentered.presence, "reentered");
assert.equal(reentered.historicalObservationSnapshotId, previousSnapshot.snapshotId);

const baselineThird = version(
  "baseline_version_3",
  3,
  headline([evA2, evC], [claim("summary", [support(evC)])], "mixed"),
  second.id,
);
const publishedBaselineComparison = compareEventBaseline(first, baselineThird, {
  previous: [numericFact(10, evB.versionId!)],
  current: [numericFact(12, evC.versionId!)],
});
assert.equal(publishedBaselineComparison.previousVersionId, first.id);
assert.equal(publishedBaselineComparison.currentVersionId, baselineThird.id);
assert.equal(
  publishedBaselineComparison.items.some((change) => change.kind === "direction_changed"),
  true,
  "非相邻发布基线必须比较 exact endpoints，而不是重放 v2→v3",
);
assert.notEqual(
  publishedBaselineComparison.inputHash,
  changed.inputHash,
  "baseline comparison hash 必须标识不同的比较模式与端点",
);
const publishedSnapshotComparison = compareSnapshotEvent({
  baselineKind: "previous_published",
  baselineSnapshotId: "published_snapshot_v1",
  baselineEvent: snapshot("published_snapshot_v1", first.id, 1),
  current: snapshot("current_snapshot_v3", baselineThird.id, 2),
  currentSnapshotId: "current_snapshot_v3",
  comparedAt: "2026-07-23T05:00:00.000Z",
  contentComparison: publishedBaselineComparison,
});
assert.equal(
  publishedSnapshotComparison.items.some((change) =>
    change.kind === "direction_changed" && change.before?.direction === "bullish" && change.after?.direction === "mixed"),
  true,
  "previous_published 的非相邻版本差异必须合入该基线快照记录",
);

const originalNumericText = [
  "For FY2026, revenue guidance increased from USD 10bn to USD 12bn.",
  "Gross margin for FY2026 rose to 55.5%, while policy interest rate changed by 25 bps.",
  "GPT-5 launched on 2026-07-23.",
].join(" ");
const numericClaim = {
  ...claim("summary", [support(evA1)]),
  originalStatement: originalNumericText,
  statement: "展示译文中的 999 不得被解析。",
};
const extracted = extractNumericFacts(headline([evA1], [numericClaim], "bullish"));
assert.equal(extracted.length, 4, "只提取带明确单位的货币、百分比和基点");
assert.deepEqual(
  extracted.map((fact) => fact.value),
  ["10000000000", "12000000000", "55.5", "25"],
);
assert.equal(extracted.every((fact) => fact.comparisonStatus === "comparable"), true);
assert.equal(extracted.some((fact) => fact.rawToken.includes("GPT-5")), false);
assert.equal(extracted.some((fact) => fact.rawToken.includes("2026-07-23")), false);
assert.equal(extracted.some((fact) => fact.rawToken.includes("999")), false);
assert.equal(new Set(extracted.map((fact) => fact.factKey)).size, extracted.length);
for (const fact of extracted) {
  assert.equal(
    fact.originalText.slice(fact.startOffset, fact.endOffset),
    fact.rawToken,
    "数字事实 offset 必须精确回指原文 token",
  );
  assert.deepEqual(fact.evidenceVersionIds, [evA1.versionId]);
}

const chineseOriginal = "2026财年收入指引上调至120亿美元，2026财年毛利率上调至55％。";
const chineseFacts = extractNumericFacts(headline([evA1], [{
  ...claim("summary", [support(evA1)]),
  originalStatement: chineseOriginal,
}], "bullish"));
assert.deepEqual(chineseFacts.map((fact) => fact.value), ["12000000000", "55"]);
assert.equal(chineseFacts.every((fact) => fact.periodKey === "FY2026"), true);
const fractionalScaleText = "For FY2026, capital expenditure was USD 0.5bn.";
const fractionalScaleFacts = extractNumericFacts(headline([evA1], [{
  ...claim("summary", [support(evA1)]),
  originalStatement: fractionalScaleText,
}], "bullish"));
assert.equal(fractionalScaleFacts[0]?.value, "500000000", "小数乘英文量级必须使用十进制定点运算");

const unsupportedNumericClaim = {
  ...numericClaim,
  verificationStatus: "pending_confirmation" as const,
};
assert.deepEqual(
  extractNumericFacts(headline([evA1], [unsupportedNumericClaim], "bullish")),
  [],
  "未核验 claim 不得生成可写入数据库的数字事实",
);

const projection = projectWhatChanged({
  investor: entered,
  operational: rankUp,
  latestVersion: changed,
});
assert.equal(projection.latestVersion.currentVersionId, second.id);
assert.equal(projection.investor.currentSnapshotId, "snapshot_4");
assert.equal(projection.operational.currentSnapshotId, "snapshot_2");

const sameVersionInvestor = compareSnapshotEvent({
  baselineKind: "previous_published",
  baselineSnapshotId: "published_same_version",
  baselineEvent: snapshot("published_same_version", second.id, 1),
  current: snapshot("current_same_version", second.id, 1),
  currentSnapshotId: "current_same_version",
  comparedAt: "2026-07-23T06:00:00.000Z",
});
const sameVersionOperational = compareSnapshotEvent({
  baselineKind: "previous_observation",
  baselineSnapshotId: "observation_same_version",
  baselineEvent: snapshot("observation_same_version", second.id, 1),
  current: snapshot("current_same_version", second.id, 1),
  currentSnapshotId: "current_same_version",
  comparedAt: "2026-07-23T06:00:00.000Z",
});
const reusedChangedVersion = projectWhatChanged({
  investor: sameVersionInvestor,
  operational: sameVersionOperational,
  latestVersion: changed,
});
assert.equal(reusedChangedVersion.status, "unchanged");
assert.deepEqual(
  reusedChangedVersion.items,
  [],
  "S3 重用 v2 时，顶层不得重放 v1→v2 的证据或方向变化",
);

const sameFirstInvestor = compareSnapshotEvent({
  baselineKind: "previous_published",
  baselineSnapshotId: "published_first_version",
  baselineEvent: snapshot("published_first_version", first.id, 1),
  current: snapshot("current_first_version", first.id, 1),
  currentSnapshotId: "current_first_version",
  comparedAt: "2026-07-23T06:30:00.000Z",
});
const sameFirstOperational = compareSnapshotEvent({
  baselineKind: "previous_observation",
  baselineSnapshotId: "observation_first_version",
  baselineEvent: snapshot("observation_first_version", first.id, 1),
  current: snapshot("current_first_version", first.id, 1),
  currentSnapshotId: "current_first_version",
  comparedAt: "2026-07-23T06:30:00.000Z",
});
const reusedFirstVersion = projectWhatChanged({
  investor: sameFirstInvestor,
  operational: sameFirstOperational,
  latestVersion: firstSeen,
});
assert.equal(reusedFirstVersion.status, "unchanged");
assert.deepEqual(
  reusedFirstVersion.items,
  [],
  "S2 重用 v1 时，嵌套 first_seen 审计记录不得让顶层再次显示首次发现",
);

console.log("Exact What Changed domain comparison tests passed");
