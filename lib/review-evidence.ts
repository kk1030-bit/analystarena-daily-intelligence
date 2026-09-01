import {
  createEvidenceCitation,
  createHeadlineClaim,
  MANUAL_EVIDENCE_REBIND_GENERATOR_VERSION,
  MANUAL_REVIEW_GENERATOR_VERSION,
} from "./source-evidence";
import type { DailyBrief, EquityImpactAssessment, Headline, HeadlineClaim } from "./types";

const CATEGORIES = new Set<Headline["category"]>([
  "Macro", "AI", "Semiconductor", "Crypto", "ETF", "Earnings", "Geopolitics", "Other",
]);
const MARKET_DIRECTIONS = new Set<NonNullable<Headline["marketDirection"]>>([
  "bullish", "bearish", "mixed", "neutral",
]);

interface ClaimField {
  claimKey: string;
  type: HeadlineClaim["type"];
  ordinal: number;
  previousValue: string;
  submittedValue: string;
  forceReview?: boolean;
}

export interface ManualClaimConfirmation {
  headlineId: string;
  claimKey: string;
  method: "manual_semantic_review";
}

export interface ManualEditedClaimSupport {
  headlineId: string;
  claimKey: string;
  evidenceVersionIds: string[];
  method: "manual_evidence_rebind";
  note: string;
}

export interface ReviewEvidenceOptions {
  manualConfirmations?: ManualClaimConfirmation[];
  manualEditedClaimSupports?: ManualEditedClaimSupport[];
}

/**
 * Returns only support relationships that the review console can truthfully
 * preselect. A contradictory/context citation, an indirect citation, or a
 * citation no longer backed by the event's exact stored evidence must require
 * an explicit reviewer choice and must never be silently converted to support.
 */
export function defaultMaintainedEvidenceVersionIds(
  headline: Headline,
  claim: HeadlineClaim | undefined,
): string[] {
  if (!claim) return [];
  const selectableEvidence = new Map(
    headline.sources.flatMap((source) => source.evidence ?? [])
      .filter((evidence) =>
        evidence.versionId
        && evidence.sourceDocumentVersionId
        && evidence.locatorStatus === "exact"
        && evidence.directness === "direct")
      .map((evidence) => [evidence.versionId!, evidence]),
  );
  return [...new Set(claim.citations
    .filter((citation) => {
      if (citation.relation !== "supports"
        || citation.confidence <= 0
        || citation.locatorStatus !== "exact"
        || citation.directness !== "direct"
        || !citation.versionId
        || !citation.sourceDocumentVersionId) {
        return false;
      }
      const evidence = selectableEvidence.get(citation.versionId);
      return Boolean(
        evidence
        && evidence.id === citation.id
        && evidence.sourceDocumentId === citation.sourceDocumentId
        && evidence.sourceDocumentVersionId === citation.sourceDocumentVersionId
        && evidence.locatorHash === citation.locatorHash,
      );
    })
    .map((citation) => citation.versionId!))];
}

/**
 * Evidence identity alone is not enough to retain a citation relationship.
 * In particular, changing `contradicts` or `context` to `supports` is a
 * removal plus an explicit rebind and must create a retraction audit.
 */
export function reviewedClaimRetainsCitationRelationship(
  claim: HeadlineClaim | undefined,
  citation: HeadlineClaim["citations"][number],
): boolean {
  return Boolean(claim?.citations.some((candidate) =>
    candidate.id === citation.id
    && candidate.versionId === citation.versionId
    && candidate.relation === citation.relation));
}

function reviewClaim(field: ClaimField): HeadlineClaim {
  return createHeadlineClaim({
    claimKey: field.claimKey,
    type: field.type,
    ordinal: field.ordinal,
    statement: field.submittedValue,
    originalStatement: field.submittedValue,
    language: "zh-CN",
    verificationStatus: "pending_confirmation",
    citations: [],
    generator: "review",
    generatorVersion: "review-console/v2",
  });
}

function reviewClaimWithSelectedEvidence(
  field: ClaimField,
  previousHeadline: Headline,
  support: ManualEditedClaimSupport,
): HeadlineClaim {
  const selectedIds = new Set(support.evidenceVersionIds);
  if (selectedIds.size !== support.evidenceVersionIds.length) {
    throw new Error(`声明 ${field.claimKey} 的人工证据重绑包含重复证据`);
  }
  if (!selectedIds.size) return reviewClaim(field);
  const availableEvidence = new Map(
    previousHeadline.sources.flatMap((source) => source.evidence ?? [])
      .filter((evidence) =>
        evidence.versionId
        && evidence.sourceDocumentVersionId
        && evidence.locatorStatus === "exact"
        && evidence.directness === "direct")
      .map((evidence) => [evidence.versionId!, evidence]),
  );
  const citations = support.evidenceVersionIds.map((versionId, order) => {
    const evidence = availableEvidence.get(versionId);
    if (!evidence) {
      throw new Error(`声明 ${field.claimKey} 的人工证据重绑包含不属于当前事件的精确证据`);
    }
    return createEvidenceCitation(structuredClone(evidence), {
      relation: "supports",
      confidence: 1,
      order,
    });
  });
  if (citations.length !== selectedIds.size) {
    throw new Error(`声明 ${field.claimKey} 的人工证据重绑没有形成唯一证据集合`);
  }
  return createHeadlineClaim({
    claimKey: field.claimKey,
    type: field.type,
    ordinal: field.ordinal,
    statement: field.submittedValue,
    originalStatement: field.submittedValue,
    language: "zh-CN",
    verificationStatus: "partially_supported",
    citations,
    generator: "review",
    generatorVersion: MANUAL_EVIDENCE_REBIND_GENERATOR_VERSION,
  });
}

function reconcileEquityImpacts(
  previous: EquityImpactAssessment[] | undefined,
  submitted: EquityImpactAssessment[] | undefined,
): EquityImpactAssessment[] | undefined {
  if (!previous) return undefined;
  const submittedBySymbol = new Map((Array.isArray(submitted) ? submitted : [])
    .filter((item) => item && typeof item.symbol === "string")
    .map((item) => [item.symbol, item]));
  return previous.map((item) => {
    const requestedStatus = submittedBySymbol.get(item.symbol)?.reviewStatus;
    const reviewStatus = requestedStatus === "approved" || requestedStatus === "rejected"
      ? requestedStatus
      : item.reviewStatus;
    // The review console may approve or reject a persisted assessment. Its
    // symbol, direction, mechanism, confidence and evidence remain server-owned.
    return { ...structuredClone(item), reviewStatus };
  });
}

function validateSubmittedHeadline(previous: Headline, submitted: Headline): void {
  if (typeof submitted.title !== "string" || !submitted.title.trim()) throw new Error(`事件 ${previous.id} 的标题不能为空`);
  if (typeof submitted.summary !== "string" || !submitted.summary.trim()) throw new Error(`事件 ${previous.id} 的摘要不能为空`);
  if (typeof submitted.marketImpact !== "string" || !submitted.marketImpact.trim()) {
    throw new Error(`事件 ${previous.id} 的市场影响判断不能为空`);
  }
  if (submitted.keyPoints !== undefined
    && (!Array.isArray(submitted.keyPoints)
      || submitted.keyPoints.some((point) => typeof point !== "string" || !point.trim()))) {
    throw new Error(`事件 ${previous.id} 的重要信息清单格式无效`);
  }
  if (!CATEGORIES.has(submitted.category)) throw new Error(`事件 ${previous.id} 使用了不支持的分类`);
  if (submitted.marketDirection !== undefined && !MARKET_DIRECTIONS.has(submitted.marketDirection)) {
    throw new Error(`事件 ${previous.id} 使用了不支持的市场方向`);
  }
  if (!Number.isInteger(submitted.impact) || submitted.impact < 1 || submitted.impact > 5) {
    throw new Error(`事件 ${previous.id} 的市场影响必须是 1 至 5 的整数`);
  }
  if (!Number.isFinite(submitted.confidence) || submitted.confidence < 1 || submitted.confidence > 99) {
    throw new Error(`事件 ${previous.id} 的资料可信度必须介于 1 至 99`);
  }
  if (submitted.directionConfidence !== undefined
    && (!Number.isFinite(submitted.directionConfidence)
      || submitted.directionConfidence < 1
      || submitted.directionConfidence > 99)) {
    throw new Error(`事件 ${previous.id} 的方向证据强度必须介于 1 至 99`);
  }
  if (submitted.directionRationale !== undefined && typeof submitted.directionRationale !== "string") {
    throw new Error(`事件 ${previous.id} 的方向判断依据格式无效`);
  }
}

function reconcileHeadline(
  previous: Headline,
  submitted: Headline,
  manualConfirmationKeys: Set<string>,
  editedClaimSupports: Map<string, ManualEditedClaimSupport>,
): Headline {
  validateSubmittedHeadline(previous, submitted);
  const previousPoints = previous.keyPoints ?? [];
  const submittedPoints = submitted.keyPoints ?? [];
  const fields: ClaimField[] = [
    { claimKey: "title", type: "title", ordinal: 0, previousValue: previous.title, submittedValue: submitted.title },
    { claimKey: "summary", type: "summary", ordinal: 1, previousValue: previous.summary, submittedValue: submitted.summary },
    ...submittedPoints.map((value, index) => ({
      claimKey: `important_information:${index}`,
      type: "important_information" as const,
      ordinal: index + 2,
      previousValue: previousPoints[index] ?? "",
      submittedValue: value,
    })),
    {
      claimKey: "market_impact",
      type: "market_impact",
      ordinal: submittedPoints.length + 2,
      previousValue: previous.marketImpact,
      submittedValue: submitted.marketImpact,
      forceReview: previous.category !== submitted.category
        || previous.impact !== submitted.impact
        || previous.confidence !== submitted.confidence
        || previous.marketDirection !== submitted.marketDirection
        || previous.directionConfidence !== submitted.directionConfidence
        || previous.directionRationale !== submitted.directionRationale,
    },
    ...(submitted.directionRationale ? [{
      claimKey: "direction_rationale",
      type: "direction_rationale" as const,
      ordinal: submittedPoints.length + 3,
      previousValue: previous.directionRationale ?? "",
      submittedValue: submitted.directionRationale,
      forceReview: previous.marketDirection !== submitted.marketDirection
        || previous.directionConfidence !== submitted.directionConfidence,
    }] : []),
  ];
  const previousClaimList = previous.claims ?? [];
  if (new Set(previousClaimList.map((claim) => claim.claimKey)).size !== previousClaimList.length) {
    throw new Error(`事件 ${previous.id} 存在重复的声明编号，修复前不能审核`);
  }
  const previousClaims = new Map(previousClaimList.map((claim) => [claim.claimKey, claim]));
  const consumedSupportKeys = new Set<string>();
  const managedClaims = fields.map((field) => {
    const retained = previousClaims.get(field.claimKey);
    const changed = Boolean(field.forceReview || field.previousValue !== field.submittedValue);
    const selectedSupport = editedClaimSupports.get(field.claimKey);
    if (selectedSupport) {
      consumedSupportKeys.add(field.claimKey);
      return reviewClaimWithSelectedEvidence(field, previous, selectedSupport);
    }
    if (!changed) {
      return retained
        ? createHeadlineClaim({ ...structuredClone(retained), ordinal: field.ordinal })
        : reviewClaim(field);
    }
    return reviewClaim(field);
  });
  for (const claimKey of editedClaimSupports.keys()) {
    if (!consumedSupportKeys.has(claimKey)) {
      throw new Error(`人工证据重绑包含未使用的声明 ${claimKey}`);
    }
  }
  const isPageFieldClaim = (claimKey: string) => claimKey === "title"
    || claimKey === "summary"
    || claimKey === "market_impact"
    || claimKey === "direction_rationale"
    || /^important_information:\d+$/.test(claimKey);
  const supplementalClaims = previousClaimList
    .filter((claim) => !isPageFieldClaim(claim.claimKey))
    .map((claim) => createHeadlineClaim(structuredClone(claim)));
  const unconfirmedClaims = [...managedClaims, ...supplementalClaims];
  const claims = unconfirmedClaims.map((claim) => {
    if (!manualConfirmationKeys.has(claim.claimKey)) return claim;
    const storedClaim = previousClaims.get(claim.claimKey);
    if (!storedClaim) {
      throw new Error(`事件 ${previous.id} 不存在声明 ${claim.claimKey}，不能确认`);
    }
    if (storedClaim.generator !== "ai") {
      throw new Error(`声明 ${claim.claimKey} 不是待人工语义核验的 AI 声明`);
    }
    if (claim.generator !== "ai"
      || claim.statement !== storedClaim.statement
      || claim.originalStatement !== storedClaim.originalStatement
      || claim.statementHash !== storedClaim.statementHash) {
      throw new Error(`声明 ${claim.claimKey} 已被编辑，必须重新绑定证据后才能确认`);
    }
    // A confirmation changes only the verifier semantics. The assertion and
    // every immutable evidence-version link remain the stored server values;
    // review payloads cannot replace either of them.
    return createHeadlineClaim({
      ...structuredClone(storedClaim),
      ordinal: claim.ordinal,
      verificationStatus: "partially_supported",
      generator: "review",
      generatorVersion: MANUAL_REVIEW_GENERATOR_VERSION,
    });
  });

  return {
    ...structuredClone(previous),
    // Only fields exposed by the review console are accepted. Rank, ticker,
    // sentiment, scoring, collection times and all other event metadata remain
    // the stored server revision even if a client submits replacements.
    title: submitted.title,
    summary: submitted.summary,
    keyPoints: structuredClone(submittedPoints),
    marketImpact: submitted.marketImpact,
    marketDirection: submitted.marketDirection,
    directionConfidence: submitted.directionConfidence,
    directionRationale: submitted.directionRationale,
    category: submitted.category,
    impact: submitted.impact,
    confidence: submitted.confidence,
    equityImpacts: reconcileEquityImpacts(previous.equityImpacts, submitted.equityImpacts),
    // Source provenance and evidence are server authority. The review client
    // may edit analysis fields, but can neither inject nor rewrite citations.
    sources: structuredClone(previous.sources),
    publishedAt: previous.publishedAt,
    timestampKind: previous.timestampKind,
    newsTimeSource: previous.newsTimeSource,
    claims,
  };
}

/**
 * Rebuilds review claims against the stored revision. Edited assertions lose
 * stale citations and become pending confirmation; unchanged assertions keep
 * their exact immutable evidence links. Client-provided evidence is ignored.
 */
export function reconcileReviewedBriefEvidence(
  previous: DailyBrief,
  submitted: DailyBrief,
  options: ReviewEvidenceOptions = {},
): DailyBrief {
  const previousById = new Map(previous.headlines.map((headline) => [headline.id, headline]));
  const submittedIds = submitted.headlines.map((headline) => headline.id);
  if (new Set(submittedIds).size !== submittedIds.length) {
    throw new Error("审核内容包含重复的事件编号，请重新载入最新草稿");
  }
  if (submittedIds.length !== previous.headlines.length
    || submittedIds.some((id) => !previousById.has(id))) {
    throw new Error("审核内容的事件集合与数据库草稿不一致，请重新载入最新草稿");
  }
  const confirmationsByHeadline = new Map<string, Set<string>>();
  for (const confirmation of options.manualConfirmations ?? []) {
    if (!confirmation
      || confirmation.method !== "manual_semantic_review"
      || typeof confirmation.headlineId !== "string"
      || !confirmation.headlineId.trim()
      || typeof confirmation.claimKey !== "string"
      || !confirmation.claimKey.trim()) {
      throw new Error("人工确认请求格式无效");
    }
    if (!previousById.has(confirmation.headlineId)) {
      throw new Error(`人工确认请求包含未知事件 ${confirmation.headlineId}`);
    }
    const keys = confirmationsByHeadline.get(confirmation.headlineId) ?? new Set<string>();
    if (keys.has(confirmation.claimKey)) {
      throw new Error(`声明 ${confirmation.claimKey} 被重复确认`);
    }
    keys.add(confirmation.claimKey);
    confirmationsByHeadline.set(confirmation.headlineId, keys);
  }
  const editedSupportsByHeadline = new Map<string, Map<string, ManualEditedClaimSupport>>();
  for (const support of options.manualEditedClaimSupports ?? []) {
    if (!support
      || support.method !== "manual_evidence_rebind"
      || typeof support.headlineId !== "string"
      || !support.headlineId.trim()
      || typeof support.claimKey !== "string"
      || !support.claimKey.trim()
      || !Array.isArray(support.evidenceVersionIds)
      || support.evidenceVersionIds.some((id) => typeof id !== "string" || !id.trim())
      || typeof support.note !== "string"
      || !support.note.trim()) {
      throw new Error("人工证据重绑请求格式无效");
    }
    if (!previousById.has(support.headlineId)) {
      throw new Error(`人工证据重绑包含未知事件 ${support.headlineId}`);
    }
    const claims = editedSupportsByHeadline.get(support.headlineId) ?? new Map();
    if (claims.has(support.claimKey)) {
      throw new Error(`声明 ${support.claimKey} 被重复提交人工证据重绑`);
    }
    claims.set(support.claimKey, structuredClone(support));
    editedSupportsByHeadline.set(support.headlineId, claims);
  }
  const submittedById = new Map(submitted.headlines.map((headline) => [headline.id, headline]));
  return {
    ...structuredClone(previous),
    headlines: previous.headlines.map((stored) => {
      const headline = submittedById.get(stored.id);
      if (!headline) throw new Error(`审核内容缺少事件 ${stored.id}，请重新载入最新草稿`);
      return reconcileHeadline(
        stored,
        headline,
        confirmationsByHeadline.get(stored.id) ?? new Set(),
        editedSupportsByHeadline.get(stored.id) ?? new Map(),
      );
    }),
  };
}
