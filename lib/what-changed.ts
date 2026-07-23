import { createHash } from "node:crypto";
import type {
  BriefSnapshotEventRecord,
  EventVersionComparison,
  EventVersionRecord,
  EvidenceSupportRelation,
  Headline,
  NumericFact,
  SnapshotEventChange,
  WhatChangedBaselineKind,
  WhatChangedItem,
  WhatChangedKind,
  WhatChangedProjection,
  WhatChangedStatus,
  WhatChangedValue,
} from "./types";

export const WHAT_CHANGED_ALGORITHM_VERSION = "what-changed/v1";
export const WHAT_CHANGED_IMPLEMENTATION_HASH =
  "f510adc0e7a9f8987d9ea5bba2e0a886e764745a0b7eed9ea2f20ad7bbe2c01c";
export const NUMERIC_FACT_PARSER_VERSION = "numeric-fact/original-claim-explicit-unit/v1";

export interface NumericFactComparisonInput {
  previous?: readonly NumericFact[];
  current?: readonly NumericFact[];
}

export interface SnapshotEventComparisonInput {
  baselineKind: WhatChangedBaselineKind;
  /** The contextual baseline exists even when it did not contain this event. */
  baselineSnapshotId?: string;
  baselineEvent?: BriefSnapshotEventRecord;
  /** Earlier same-event observation; used only to distinguish entered/reentered. */
  historicalObservation?: BriefSnapshotEventRecord;
  current: BriefSnapshotEventRecord;
  currentSnapshotId: string;
  comparedAt: string;
  isFirstSeen?: boolean;
  legacyUnverified?: boolean;
  /**
   * Exact endpoint comparison for this baseline. Supply it only when the
   * contextual baseline contains a different event version.
   */
  contentComparison?: EventVersionComparison;
}

export interface WhatChangedProjectionInput {
  investor: SnapshotEventChange;
  operational: SnapshotEventChange;
  latestVersion: EventVersionComparison;
}

export class WhatChangedIntegrityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WhatChangedIntegrityError";
    this.code = code;
  }
}

interface ExactEvidence {
  evidenceItemId: string;
  evidenceVersionId: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
}

interface ExactClaimSupport extends ExactEvidence {
  claimKey: string;
  relation: "supports";
  directness: string;
  confidence: number;
  order: number;
}

interface ExactClaimCitation extends ExactEvidence {
  claimKey: string;
  relation: EvidenceSupportRelation;
  directness: string;
  confidence: number;
  order: number;
}

type EventComparisonMode = "adjacent_version" | "snapshot_baseline";

const ITEM_ORDER: Record<WhatChangedKind, number> = {
  first_seen: 0,
  evidence_added: 10,
  evidence_removed: 11,
  evidence_revised: 12,
  claim_support_added: 20,
  claim_support_removed: 21,
  claim_support_changed: 22,
  claim_relation_added: 23,
  claim_relation_removed: 24,
  claim_relation_changed: 25,
  numeric_changed: 30,
  direction_established: 40,
  direction_changed: 41,
  claim_changed: 50,
  state_changed: 60,
  rank_up: 70,
  rank_down: 71,
  entered: 72,
  reentered: 73,
};

function integrity(code: string, message: string): never {
  throw new WhatChangedIntegrityError(code, message);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    integrity("INVALID_COMPARISON_INPUT", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactIso(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) integrity("INVALID_COMPARISON_INPUT", `${field} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function changeItem(input: {
  kind: WhatChangedKind;
  subjectKey: string;
  reasonCode: string;
  summary: string;
  before?: WhatChangedValue;
  after?: WhatChangedValue;
  evidenceVersionIds?: readonly string[];
}): Omit<WhatChangedItem, "ordinal"> {
  const core = {
    schema: "what-changed-item/v1",
    kind: input.kind,
    subjectKey: requiredText(input.subjectKey, "change.subjectKey"),
    reasonCode: requiredText(input.reasonCode, "change.reasonCode"),
    summary: requiredText(input.summary, "change.summary"),
    before: input.before,
    after: input.after,
    evidenceVersionIds: uniqueSorted(input.evidenceVersionIds ?? []),
  };
  const changeHash = sha256(core);
  return {
    id: `chg_${changeHash.slice(0, 32)}`,
    kind: input.kind,
    subjectKey: core.subjectKey,
    reasonCode: core.reasonCode,
    summary: core.summary,
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
    evidenceVersionIds: core.evidenceVersionIds,
    changeHash,
  };
}

function finalizeItems(
  drafts: Array<Omit<WhatChangedItem, "ordinal">>,
): WhatChangedItem[] {
  return drafts
    .sort((left, right) =>
      ITEM_ORDER[left.kind] - ITEM_ORDER[right.kind]
      || left.subjectKey.localeCompare(right.subjectKey)
      || left.reasonCode.localeCompare(right.reasonCode)
      || left.changeHash.localeCompare(right.changeHash))
    .map((draft, index) => ({ ...draft, ordinal: index + 1 }));
}

function stripOrdinal(item: WhatChangedItem): Omit<WhatChangedItem, "ordinal"> {
  return {
    id: item.id,
    kind: item.kind,
    subjectKey: item.subjectKey,
    reasonCode: item.reasonCode,
    summary: item.summary,
    ...(item.before === undefined ? {} : { before: item.before }),
    ...(item.after === undefined ? {} : { after: item.after }),
    evidenceVersionIds: [...item.evidenceVersionIds],
    changeHash: item.changeHash,
  };
}

function evidenceIdentity(evidence: ExactEvidence): string {
  return `${evidence.sourceDocumentId}\u0000${evidence.evidenceItemId}`;
}

function evidenceValue(evidence: ExactEvidence): WhatChangedValue {
  return {
    type: "evidence",
    evidenceItemId: evidence.evidenceItemId,
    evidenceVersionId: evidence.evidenceVersionId,
    sourceDocumentId: evidence.sourceDocumentId,
    sourceDocumentVersionId: evidence.sourceDocumentVersionId,
  };
}

function supportValue(support: ExactClaimSupport): WhatChangedValue {
  return {
    ...evidenceValue(support),
    type: "claim_support",
    claimKey: support.claimKey,
    relation: support.relation,
    directness: support.directness,
    confidence: support.confidence,
    order: support.order,
  };
}

function citationValue(citation: ExactClaimCitation): WhatChangedValue {
  return {
    ...evidenceValue(citation),
    type: "claim_evidence_relation",
    claimKey: citation.claimKey,
    relation: citation.relation,
    directness: citation.directness,
    confidence: citation.confidence,
    order: citation.order,
  };
}

function exactEvidenceMap(version: EventVersionRecord): Map<string, ExactEvidence> {
  const result = new Map<string, ExactEvidence>();
  for (const source of version.headline.sources) {
    for (const evidence of source.evidence ?? []) {
      const exact: ExactEvidence = {
        evidenceItemId: requiredText(evidence.id, "evidence.id"),
        evidenceVersionId: requiredText(evidence.versionId, `evidence ${evidence.id}.versionId`),
        sourceDocumentId: requiredText(evidence.sourceDocumentId, `evidence ${evidence.id}.sourceDocumentId`),
        sourceDocumentVersionId: requiredText(
          evidence.sourceDocumentVersionId,
          `evidence ${evidence.id}.sourceDocumentVersionId`,
        ),
      };
      const key = evidenceIdentity(exact);
      const prior = result.get(key);
      if (prior && (prior.evidenceVersionId !== exact.evidenceVersionId
        || prior.sourceDocumentVersionId !== exact.sourceDocumentVersionId)) {
        integrity(
          "AMBIGUOUS_EVIDENCE_ITEM",
          `event version ${version.id} projects evidence item ${exact.evidenceItemId} with conflicting versions`,
        );
      }
      result.set(key, exact);
    }
  }
  return result;
}

function citationIdentity(citation: ExactClaimCitation): string {
  return `${citation.claimKey}\u0000${evidenceIdentity(citation)}\u0000${citation.relation}`;
}

function exactClaimCitationMap(version: EventVersionRecord): Map<string, ExactClaimCitation> {
  const attachedEvidence = exactEvidenceMap(version);
  const result = new Map<string, ExactClaimCitation>();
  for (const claim of version.headline.claims ?? []) {
    for (const citation of claim.citations) {
      const exactCitation: ExactClaimCitation = {
        claimKey: requiredText(claim.claimKey, "claim.claimKey"),
        relation: citation.relation,
        evidenceItemId: requiredText(citation.id, `claim ${claim.claimKey} citation.id`),
        evidenceVersionId: requiredText(
          citation.versionId,
          `claim ${claim.claimKey} citation ${citation.id}.versionId`,
        ),
        sourceDocumentId: requiredText(
          citation.sourceDocumentId,
          `claim ${claim.claimKey} citation ${citation.id}.sourceDocumentId`,
        ),
        sourceDocumentVersionId: requiredText(
          citation.sourceDocumentVersionId,
          `claim ${claim.claimKey} citation ${citation.id}.sourceDocumentVersionId`,
        ),
        directness: citation.directness,
        confidence: citation.confidence,
        order: citation.order,
      };
      const attached = attachedEvidence.get(evidenceIdentity(exactCitation));
      if (!attached
        || attached.evidenceVersionId !== exactCitation.evidenceVersionId
        || attached.sourceDocumentVersionId !== exactCitation.sourceDocumentVersionId) {
        integrity(
          "CLAIM_RELATION_EVIDENCE_MISMATCH",
          `claim ${claim.claimKey} relationship ${exactCitation.evidenceVersionId} is not an exact event-version evidence projection`,
        );
      }
      const key = citationIdentity(exactCitation);
      const prior = result.get(key);
      if (prior && canonicalJson(prior) !== canonicalJson(exactCitation)) {
        integrity(
          "AMBIGUOUS_CLAIM_RELATION",
          `claim ${claim.claimKey} has conflicting ${citation.relation} links for evidence item ${exactCitation.evidenceItemId}`,
        );
      }
      result.set(key, exactCitation);
    }
  }
  return result;
}

function exactClaimSupportMap(version: EventVersionRecord): Map<string, ExactClaimSupport> {
  return new Map(
    [...exactClaimCitationMap(version).entries()]
      .filter(([, citation]) => citation.relation === "supports")
      .map(([key, citation]) => [key, { ...citation, relation: "supports" as const }]),
  );
}

function claimSupportEvidenceIds(version: EventVersionRecord, claimKey: string): string[] {
  return uniqueSorted(
    [...exactClaimSupportMap(version).values()]
      .filter((support) => support.claimKey === claimKey)
      .map((support) => support.evidenceVersionId),
  );
}

function assertAdjacentVersions(
  previous: EventVersionRecord | undefined,
  current: EventVersionRecord,
): void {
  if (!previous) {
    if (current.versionNumber !== 1 || current.previousVersionId !== undefined) {
      integrity(
        "BROKEN_EVENT_VERSION_CHAIN",
        `event version ${current.id} cannot be first-seen: version=${current.versionNumber}, previous=${current.previousVersionId ?? "null"}`,
      );
    }
    return;
  }
  if (previous.eventId !== current.eventId) {
    integrity("EVENT_ID_MISMATCH", `cannot compare ${previous.eventId} with ${current.eventId}`);
  }
  if (current.previousVersionId !== previous.id
    || current.versionNumber !== previous.versionNumber + 1) {
    integrity(
      "NON_ADJACENT_EVENT_VERSIONS",
      `event version ${current.id} is not the direct successor of ${previous.id}`,
    );
  }
}

function assertBaselineVersions(
  previous: EventVersionRecord | undefined,
  current: EventVersionRecord,
): void {
  if (!previous) {
    if (current.versionNumber < 1
      || (current.versionNumber === 1 && current.previousVersionId !== undefined)) {
      integrity("BROKEN_EVENT_VERSION_CHAIN", `event version ${current.id} has an invalid chain shape`);
    }
    return;
  }
  if (previous.eventId !== current.eventId) {
    integrity("EVENT_ID_MISMATCH", `cannot compare ${previous.eventId} with ${current.eventId}`);
  }
  if (previous.id === current.id || previous.versionNumber >= current.versionNumber) {
    integrity(
      "INVALID_BASELINE_EVENT_VERSION",
      `baseline ${previous.id} must precede current version ${current.id}`,
    );
  }
}

function legacyVersion(version: EventVersionRecord): boolean {
  return [version.contentHash, version.evidenceHash, version.stateHash]
    .some((hash) => hash.startsWith("legacy-md5:"));
}

interface NumericTokenCandidate {
  startOffset: number;
  endOffset: number;
  rawToken: string;
  value: string;
  unit: string;
  currency?: string;
  scale: string;
  priority: number;
  comparisonBlocker?: string;
}

const NUMBER_PATTERN = "[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";
const SCALE_PATTERN =
  "trillions?|billions?|millions?|thousands?|tn|bn|mm|mn|k|万亿|萬億|亿|億|万|萬|千";
const CURRENCY_PATTERN =
  "US\\$|USD|CNY|RMB|EUR|GBP|JPY|HKD|\\$|美元|美金|人民币|人民幣|欧元|歐元|英镑|英鎊|日元|日圓|港元|元";

const METRIC_PATTERNS: Array<{ key: string; pattern: RegExp }> = [
  { key: "revenue_guidance", pattern: /revenue guidance|sales guidance|营收指引|營收指引|收入指引/giu },
  { key: "eps_guidance", pattern: /(?:eps|earnings per share) guidance|每股收益指引|每股盈余指引|每股盈餘指引/giu },
  { key: "gross_margin", pattern: /gross margin|毛利率/giu },
  { key: "operating_margin", pattern: /operating margin|营业利润率|營業利潤率|營業利益率/giu },
  { key: "interest_rate", pattern: /interest rates?|policy rates?|fed funds rate|利率|政策利率/giu },
  { key: "inflation", pattern: /inflation|consumer prices?|(?:^|\W)cpi(?:\W|$)|通胀|通膨|消费者价格|消費者價格/giu },
  { key: "earnings_per_share", pattern: /earnings per share|(?:^|\W)eps(?:\W|$)|每股收益|每股盈余|每股盈餘/giu },
  { key: "net_income", pattern: /net income|net profit|净利润|淨利潤|纯利|純利/giu },
  { key: "revenue", pattern: /revenue|sales|营收|營收|收入/giu },
  { key: "gdp", pattern: /gross domestic product|(?:^|\W)gdp(?:\W|$)|国内生产总值|國內生產總值/giu },
  { key: "capital_expenditure", pattern: /capital expenditure|capex|资本支出|資本支出/giu },
  { key: "production", pattern: /production|output|shipments?|产量|產量|出货|出貨/giu },
  { key: "orders", pattern: /orders?|bookings?|订单|訂單/giu },
  { key: "market_cap", pattern: /market cap(?:italization)?|市值/giu },
  { key: "valuation", pattern: /valuation|enterprise value|估值|估值水平/giu },
  { key: "deal_value", pattern: /deal value|transaction value|purchase price|交易金额|交易金額|收购价|收購價/giu },
];

function canonicalDecimal(raw: string): string {
  const compact = raw.replace(/,/g, "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(compact)) {
    integrity("INVALID_NUMERIC_TOKEN", `invalid decimal token ${raw}`);
  }
  const negative = compact.startsWith("-");
  const unsigned = compact.replace(/^[+-]/, "");
  const [integerRaw, fractionRaw = ""] = unsigned.split(".");
  const integer = integerRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.replace(/0+$/, "");
  const zero = integer === "0" && !fraction;
  return `${negative && !zero ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

function multiplyDecimalPower10(raw: string, power: number): string {
  const canonical = canonicalDecimal(raw);
  const negative = canonical.startsWith("-");
  const unsigned = canonical.replace(/^-/, "");
  const [integer, fraction = ""] = unsigned.split(".");
  // Keep leading zeroes until the decimal point has been moved. Removing the
  // leading zero from 0.5 before multiplying by 10^9 would incorrectly yield
  // 5,000,000,000 instead of 500,000,000.
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + power;
  let expanded: string;
  if (decimalPosition <= 0) {
    expanded = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  return canonicalDecimal(`${negative ? "-" : ""}${expanded}`);
}

function scalePower(raw: string | undefined): number {
  const scale = (raw ?? "").toLocaleLowerCase("en-US");
  if (!scale) return 0;
  if (/^(?:trillions?|tn|万亿|萬億)$/.test(scale)) return 12;
  if (/^(?:billions?|bn)$/.test(scale)) return 9;
  if (/^(?:millions?|mm|mn)$/.test(scale)) return 6;
  if (/^(?:thousands?|k|千)$/.test(scale)) return 3;
  if (/^(?:亿|億)$/.test(scale)) return 8;
  if (/^(?:万|萬)$/.test(scale)) return 4;
  integrity("INVALID_NUMERIC_SCALE", `unsupported numeric scale ${raw}`);
}

function currencyCode(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLocaleUpperCase("en-US");
  if (/^(?:US\$|USD|\$|美元|美金)$/.test(normalized)) return "USD";
  if (/^(?:CNY|RMB|人民币|人民幣|元)$/.test(normalized)) return "CNY";
  if (/^(?:EUR|欧元|歐元)$/.test(normalized)) return "EUR";
  if (/^(?:GBP|英镑|英鎊)$/.test(normalized)) return "GBP";
  if (/^(?:JPY|日元|日圓)$/.test(normalized)) return "JPY";
  if (/^(?:HKD|港元)$/.test(normalized)) return "HKD";
  return undefined;
}

function scanNumericTokens(text: string): NumericTokenCandidate[] {
  const candidates: NumericTokenCandidate[] = [];
  const add = (
    match: RegExpExecArray,
    numericRaw: string,
    unit: string,
    scaleRaw: string | undefined,
    currencyRaw: string | undefined,
    priority: number,
    comparisonBlocker?: string,
  ) => {
    candidates.push({
      startOffset: match.index,
      endOffset: match.index + match[0].length,
      rawToken: match[0],
      value: multiplyDecimalPower10(numericRaw, scalePower(scaleRaw)),
      unit,
      currency: currencyCode(currencyRaw),
      scale: scalePower(scaleRaw) === 0 ? "one" : "base",
      priority,
      comparisonBlocker,
    });
  };

  const prefixCurrency = new RegExp(
    `(${CURRENCY_PATTERN})\\s*(${NUMBER_PATTERN})\\s*(${SCALE_PATTERN})?(?:\\s*(${CURRENCY_PATTERN}))?`,
    "giu",
  );
  for (const match of text.matchAll(prefixCurrency)) {
    const prefix = currencyCode(match[1]);
    const suffix = currencyCode(match[4]);
    add(
      match as RegExpExecArray,
      match[2],
      "currency",
      match[3],
      suffix ?? prefix,
      100,
      prefix && suffix && prefix !== suffix ? "currency_conflict" : undefined,
    );
  }

  const suffixCurrency = new RegExp(
    `(${NUMBER_PATTERN})\\s*(${SCALE_PATTERN})?\\s*(${CURRENCY_PATTERN})`,
    "giu",
  );
  for (const match of text.matchAll(suffixCurrency)) {
    add(match as RegExpExecArray, match[1], "currency", match[2], match[3], 100);
  }

  const percentagePoints = new RegExp(
    `(${NUMBER_PATTERN})\\s*(percentage\\s+points?|个百分点|個百分點)`,
    "giu",
  );
  for (const match of text.matchAll(percentagePoints)) {
    add(match as RegExpExecArray, match[1], "percentage_point", undefined, undefined, 90);
  }

  const percentages = new RegExp(`(${NUMBER_PATTERN})\\s*(%|％|percent(?:age)?s?)`, "giu");
  for (const match of text.matchAll(percentages)) {
    add(match as RegExpExecArray, match[1], "percent", undefined, undefined, 85);
  }

  const basisPoints = new RegExp(
    `(${NUMBER_PATTERN})\\s*(?:bps?|basis\\s+points?|个?基点|個?基點)`,
    "giu",
  );
  for (const match of text.matchAll(basisPoints)) {
    add(match as RegExpExecArray, match[1], "basis_point", undefined, undefined, 90);
  }

  const scaledCounts = new RegExp(`(${NUMBER_PATTERN})\\s*(${SCALE_PATTERN})`, "giu");
  for (const match of text.matchAll(scaledCounts)) {
    add(match as RegExpExecArray, match[1], "count", match[2], undefined, 50);
  }

  // Prefer semantically stronger tokens (currency/percent/bps) and reject
  // overlapping generic scaled counts. This also prevents "USD 10bn" from
  // becoming both a currency fact and a count fact.
  const accepted: NumericTokenCandidate[] = [];
  for (const candidate of candidates.sort((left, right) =>
    right.priority - left.priority
    || (right.endOffset - right.startOffset) - (left.endOffset - left.startOffset)
    || left.startOffset - right.startOffset)) {
    if (accepted.some((existing) =>
      candidate.startOffset < existing.endOffset && candidate.endOffset > existing.startOffset)) continue;
    accepted.push(candidate);
  }
  return accepted.sort((left, right) => left.startOffset - right.startOffset);
}

function nearestMetric(text: string, token: NumericTokenCandidate): string {
  const midpoint = (token.startOffset + token.endOffset) / 2;
  let winner: { key: string; distance: number; priority: number } | undefined;
  for (const [priority, metric] of METRIC_PATTERNS.entries()) {
    metric.pattern.lastIndex = 0;
    for (const match of text.matchAll(metric.pattern)) {
      const index = match.index ?? 0;
      const distance = Math.abs(midpoint - (index + match[0].length / 2));
      if (!winner || distance < winner.distance
        || (distance === winner.distance && priority < winner.priority)) {
        winner = { key: metric.key, distance, priority };
      }
    }
  }
  return winner?.key ?? "unclassified";
}

function numericRole(text: string, token: NumericTokenCandidate): string {
  const prefix = text.slice(Math.max(0, token.startOffset - 24), token.startOffset);
  if (/(?:\bfrom|从|從)\s*$/iu.test(prefix)) return "reference";
  if (/(?:\bto|上调至|上調至|下调至|下調至|至|到)\s*$/iu.test(prefix)) return "target";
  return "current";
}

function nearestPeriod(text: string, token: NumericTokenCandidate): string {
  const matches: Array<{ key: string; index: number; length: number }> = [];
  const collect = (pattern: RegExp, normalize: (match: RegExpExecArray) => string | undefined) => {
    for (const rawMatch of text.matchAll(pattern)) {
      const match = rawMatch as RegExpExecArray;
      const key = normalize(match);
      if (key) matches.push({ key, index: match.index, length: match[0].length });
    }
  };
  collect(/\bFY\s*(20\d{2})\b/giu, (match) => `FY${match[1]}`);
  collect(/\b(20\d{2})\s*(?:fiscal\s+year|fiscal)\b/giu, (match) => `FY${match[1]}`);
  collect(/(20\d{2})\s*(?:财年|財年)/gu, (match) => `FY${match[1]}`);
  collect(/\bQ([1-4])\s*[- /]?(20\d{2})\b/giu, (match) => `${match[2]}Q${match[1]}`);
  collect(/\b(20\d{2})\s*[- /]?Q([1-4])\b/giu, (match) => `${match[1]}Q${match[2]}`);
  collect(/(20\d{2})年?第?([一二三四1-4])季度/gu, (match) => {
    const quarter = ({ 一: "1", 二: "2", 三: "3", 四: "4" } as Record<string, string>)[match[2]] ?? match[2];
    return `${match[1]}Q${quarter}`;
  });
  collect(/\b(TTM|LTM)\b/giu, (match) => match[1].toLocaleUpperCase("en-US"));
  collect(/\b(20\d{2})\s*(?:calendar\s+year|year)\b/giu, (match) => `CY${match[1]}`);
  collect(/(20\d{2})年(?!\s*\d{1,2}月)/gu, (match) => `CY${match[1]}`);
  if (!matches.length) return "unspecified";
  const midpoint = (token.startOffset + token.endOffset) / 2;
  return matches.sort((left, right) =>
    Math.abs(midpoint - (left.index + left.length / 2))
    - Math.abs(midpoint - (right.index + right.length / 2))
    || left.index - right.index)[0].key;
}

function exactSupportedCitations(headline: Headline, claimKey: string): string[] {
  const claim = (headline.claims ?? []).find((candidate) => candidate.claimKey === claimKey);
  if (!claim) return [];
  const attachedEvidence = new Set(headline.sources.flatMap((source) =>
    (source.evidence ?? [])
      .filter((evidence) =>
        Boolean(evidence.versionId)
        && Boolean(evidence.sourceDocumentVersionId)
        && evidence.locatorStatus === "exact"
        && evidence.directness === "direct")
      .map((evidence) => canonicalJson({
        evidenceItemId: evidence.id,
        evidenceVersionId: evidence.versionId,
        sourceDocumentId: evidence.sourceDocumentId,
        sourceDocumentVersionId: evidence.sourceDocumentVersionId,
      }))));
  return uniqueSorted(claim.citations
    .filter((citation) =>
      citation.relation === "supports"
      && citation.confidence > 0
      && citation.locatorStatus === "exact"
      && citation.directness === "direct"
      && Boolean(citation.versionId)
      && Boolean(citation.sourceDocumentVersionId)
      && attachedEvidence.has(canonicalJson({
        evidenceItemId: citation.id,
        evidenceVersionId: citation.versionId,
        sourceDocumentId: citation.sourceDocumentId,
        sourceDocumentVersionId: citation.sourceDocumentVersionId,
      })))
    .map((citation) => citation.versionId!));
}

/**
 * Extracts only explicitly unit-bearing numeric facts from immutable original
 * claim text. It deliberately ignores translated display text, bare integers,
 * dates, years and model names such as GPT-5.
 */
export function extractNumericFacts(headline: Headline): NumericFact[] {
  const drafts: NumericFact[] = [];
  for (const claim of [...(headline.claims ?? [])].sort((left, right) =>
    left.ordinal - right.ordinal || left.claimKey.localeCompare(right.claimKey))) {
    if (claim.verificationStatus !== "supported"
      && claim.verificationStatus !== "partially_supported") continue;
    if (!claim.originalStatement) continue;
    const evidenceVersionIds = exactSupportedCitations(headline, claim.claimKey);
    if (!evidenceVersionIds.length) continue;
    const originalText = claim.originalStatement;
    for (const token of scanNumericTokens(originalText)) {
      const baseMetric = nearestMetric(originalText, token);
      const role = numericRole(originalText, token);
      const metricKey = `${baseMetric}:${role}`;
      const subjectKey = headline.ticker.trim()
        ? `ticker:${headline.ticker.trim().toLocaleUpperCase("en-US")}`
        : `event:${headline.id}`;
      const periodKey = nearestPeriod(originalText, token);
      const blockers = [
        token.comparisonBlocker,
        baseMetric === "unclassified" ? "metric_unclassified" : undefined,
        periodKey === "unspecified" ? "period_unspecified" : undefined,
      ].filter((item): item is string => Boolean(item));
      const comparisonStatus: NumericFact["comparisonStatus"] =
        blockers.length ? "uncomparable" : "comparable";
      const context = {
        schema: "numeric-fact-key/v1",
        claimKey: claim.claimKey,
        metricKey,
        subjectKey,
        periodKey,
        unit: token.unit,
        currency: token.currency ?? null,
        scale: token.scale,
      };
      drafts.push({
        factKey: `nf_${sha256(context).slice(0, 48)}`,
        claimKey: claim.claimKey,
        metricKey,
        subjectKey,
        periodKey,
        value: token.value,
        unit: token.unit,
        currency: token.currency,
        scale: token.scale,
        rawToken: token.rawToken,
        startOffset: token.startOffset,
        endOffset: token.endOffset,
        originalText,
        parserVersion: NUMERIC_FACT_PARSER_VERSION,
        comparisonStatus,
        comparisonReason: blockers.length
          ? blockers.join(",")
          : "exact_supported_original_claim_explicit_unit",
        evidenceVersionIds,
      });
    }
  }

  const groups = new Map<string, NumericFact[]>();
  for (const fact of drafts) groups.set(fact.factKey, [...(groups.get(fact.factKey) ?? []), fact]);
  return drafts.map((fact) => {
    const duplicates = groups.get(fact.factKey) ?? [];
    if (duplicates.length === 1) return fact;
    // Multiple values with identical normalized context cannot be paired
    // safely across revisions. Preserve each exact token for audit, but make
    // every duplicate explicitly non-comparable.
    return {
      ...fact,
      factKey: `${fact.factKey}_${sha256({
        rawToken: fact.rawToken,
        startOffset: fact.startOffset,
        endOffset: fact.endOffset,
      }).slice(0, 12)}`,
      comparisonStatus: "uncomparable" as const,
      comparisonReason: [
        fact.comparisonReason,
        "duplicate_normalized_context",
      ].filter(Boolean).join(","),
    };
  }).sort((left, right) =>
    left.claimKey.localeCompare(right.claimKey)
    || left.startOffset - right.startOffset
    || left.factKey.localeCompare(right.factKey));
}

function numericFactMap(
  facts: readonly NumericFact[] | undefined,
  version: EventVersionRecord,
): Map<string, NumericFact> {
  const supports = exactClaimSupportMap(version);
  const result = new Map<string, NumericFact>();
  for (const fact of facts ?? []) {
    const factKey = requiredText(fact.factKey, "numericFact.factKey");
    if (result.has(factKey)) {
      integrity("DUPLICATE_NUMERIC_FACT", `event version ${version.id} repeats fact ${factKey}`);
    }
    requiredText(fact.claimKey, `numeric fact ${factKey}.claimKey`);
    requiredText(fact.metricKey, `numeric fact ${factKey}.metricKey`);
    requiredText(fact.subjectKey, `numeric fact ${factKey}.subjectKey`);
    requiredText(fact.periodKey, `numeric fact ${factKey}.periodKey`);
    requiredText(fact.unit, `numeric fact ${factKey}.unit`);
    requiredText(fact.scale, `numeric fact ${factKey}.scale`);
    requiredText(fact.rawToken, `numeric fact ${factKey}.rawToken`);
    requiredText(fact.originalText, `numeric fact ${factKey}.originalText`);
    requiredText(fact.parserVersion, `numeric fact ${factKey}.parserVersion`);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(fact.value)) {
      integrity("INVALID_NUMERIC_FACT", `numeric fact ${factKey} has a non-canonical decimal value`);
    }
    if (canonicalDecimal(fact.value) !== fact.value) {
      integrity("INVALID_NUMERIC_FACT", `numeric fact ${factKey} decimal is not normalized`);
    }
    if (!Number.isInteger(fact.startOffset) || !Number.isInteger(fact.endOffset)
      || fact.startOffset < 0 || fact.endOffset <= fact.startOffset
      || fact.originalText.slice(fact.startOffset, fact.endOffset) !== fact.rawToken) {
      integrity("INVALID_NUMERIC_FACT", `numeric fact ${factKey} does not match its original-text offsets`);
    }
    if (fact.comparisonStatus === "comparable") {
      if (fact.parserVersion !== NUMERIC_FACT_PARSER_VERSION) {
        integrity(
          "NUMERIC_PARSER_VERSION_MISMATCH",
          `comparable numeric fact ${factKey} uses ${fact.parserVersion}`,
        );
      }
      if (!fact.evidenceVersionIds.length) {
        integrity("NUMERIC_FACT_SUPPORT_REQUIRED", `comparable numeric fact ${factKey} has no evidence`);
      }
      const exactSupports = new Set(
        [...supports.values()]
          .filter((support) => support.claimKey === fact.claimKey)
          .map((support) => support.evidenceVersionId),
      );
      for (const evidenceVersionId of fact.evidenceVersionIds) {
        if (!exactSupports.has(evidenceVersionId)) {
          integrity(
            "NUMERIC_FACT_SUPPORT_MISMATCH",
            `numeric fact ${factKey} cites evidence ${evidenceVersionId} outside claim ${fact.claimKey}`,
          );
        }
      }
    }
    result.set(factKey, { ...fact, evidenceVersionIds: uniqueSorted(fact.evidenceVersionIds) });
  }
  return result;
}

function comparableFacts(previous: NumericFact, current: NumericFact): boolean {
  return previous.comparisonStatus === "comparable"
    && current.comparisonStatus === "comparable"
    && previous.parserVersion === current.parserVersion
    && previous.claimKey === current.claimKey
    && previous.metricKey === current.metricKey
    && previous.subjectKey === current.subjectKey
    && previous.periodKey === current.periodKey
    && previous.unit === current.unit
    && previous.currency === current.currency
    && previous.scale === current.scale;
}

function numericValue(fact: NumericFact): WhatChangedValue {
  return {
    type: "numeric_fact",
    factKey: fact.factKey,
    claimKey: fact.claimKey,
    metricKey: fact.metricKey,
    subjectKey: fact.subjectKey,
    periodKey: fact.periodKey,
    value: fact.value,
    unit: fact.unit,
    currency: fact.currency,
    scale: fact.scale,
    rawToken: fact.rawToken,
    startOffset: fact.startOffset,
    endOffset: fact.endOffset,
    parserVersion: fact.parserVersion,
  };
}

function claimMap(version: EventVersionRecord): Map<string, NonNullable<EventVersionRecord["headline"]["claims"]>[number]> {
  const result = new Map<string, NonNullable<EventVersionRecord["headline"]["claims"]>[number]>();
  for (const claim of version.headline.claims ?? []) {
    if (result.has(claim.claimKey)) {
      integrity("DUPLICATE_CLAIM_KEY", `event version ${version.id} repeats claim ${claim.claimKey}`);
    }
    result.set(claim.claimKey, claim);
  }
  return result;
}

function nonDirectionState(version: EventVersionRecord): WhatChangedValue {
  const headline = version.headline;
  return {
    ticker: headline.ticker,
    category: headline.category,
    impact: headline.impact,
    confidence: headline.confidence,
    sentiment: headline.sentiment,
    directionConfidence: headline.directionConfidence,
    equityImpacts: (headline.equityImpacts ?? []).map((impact) => ({
      symbol: impact.symbol,
      direction: impact.direction,
      relation: impact.relation,
      mappingConfidence: impact.mappingConfidence,
      directionConfidence: impact.directionConfidence,
      engineVersion: impact.engineVersion,
      reviewStatus: impact.reviewStatus,
    })).sort((left, right) => `${left.symbol}:${left.direction}`.localeCompare(`${right.symbol}:${right.direction}`)),
  };
}

function comparisonCore(
  comparisonMode: EventComparisonMode,
  previous: EventVersionRecord | undefined,
  current: EventVersionRecord,
  previousEvidence: Map<string, ExactEvidence>,
  currentEvidence: Map<string, ExactEvidence>,
  previousCitations: Map<string, ExactClaimCitation>,
  currentCitations: Map<string, ExactClaimCitation>,
  previousNumbers: Map<string, NumericFact>,
  currentNumbers: Map<string, NumericFact>,
): Record<string, unknown> {
  return {
    schema: "event-version-comparison-input/v1",
    comparisonMode,
    algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
    implementationHash: WHAT_CHANGED_IMPLEMENTATION_HASH,
    eventId: current.eventId,
    previous: previous ? {
      id: previous.id,
      versionNumber: previous.versionNumber,
      contentHash: previous.contentHash,
      evidenceHash: previous.evidenceHash,
      stateHash: previous.stateHash,
    } : null,
    current: {
      id: current.id,
      versionNumber: current.versionNumber,
      previousVersionId: current.previousVersionId,
      contentHash: current.contentHash,
      evidenceHash: current.evidenceHash,
      stateHash: current.stateHash,
    },
    evidenceBefore: [...previousEvidence.values()].sort((a, b) => evidenceIdentity(a).localeCompare(evidenceIdentity(b))),
    evidenceAfter: [...currentEvidence.values()].sort((a, b) => evidenceIdentity(a).localeCompare(evidenceIdentity(b))),
    citationBefore: [...previousCitations.values()].sort((a, b) => citationIdentity(a).localeCompare(citationIdentity(b))),
    citationAfter: [...currentCitations.values()].sort((a, b) => citationIdentity(a).localeCompare(citationIdentity(b))),
    numericBefore: [...previousNumbers.values()].sort((a, b) => a.factKey.localeCompare(b.factKey)),
    numericAfter: [...currentNumbers.values()].sort((a, b) => a.factKey.localeCompare(b.factKey)),
    directionBefore: previous?.headline.marketDirection ?? null,
    directionAfter: current.headline.marketDirection ?? null,
  };
}

function comparisonResultHash(input: {
  comparisonMode: EventComparisonMode;
  status: EventVersionComparison["status"];
  summary: string;
  items: WhatChangedItem[];
}): string {
  return sha256({
    schema: "event-version-comparison-result/v1",
    algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
    ...input,
  });
}

function compareEventVersionPair(
  comparisonMode: EventComparisonMode,
  previous: EventVersionRecord | undefined,
  current: EventVersionRecord,
  numericFacts: NumericFactComparisonInput = {},
): EventVersionComparison {
  if (comparisonMode === "adjacent_version") assertAdjacentVersions(previous, current);
  else assertBaselineVersions(previous, current);
  const comparedAt = exactIso(current.observedAt, "current.observedAt");

  if (!previous) {
    if (comparisonMode === "snapshot_baseline" && current.versionNumber !== 1) {
      const status = "comparison_unavailable" as const;
      const summary = "该快照基线没有此事件，但当前事件并非首个版本；不捏造首次发现或跨期变化。";
      const items: WhatChangedItem[] = [];
      const inputHash = sha256({
        schema: "event-version-comparison-input/v1",
        comparisonMode,
        algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
        implementationHash: WHAT_CHANGED_IMPLEMENTATION_HASH,
        previous: null,
        current: {
          eventId: current.eventId,
          id: current.id,
          versionNumber: current.versionNumber,
          contentHash: current.contentHash,
          evidenceHash: current.evidenceHash,
          stateHash: current.stateHash,
        },
      });
      return {
        eventId: current.eventId,
        currentVersionId: current.id,
        status,
        algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
        inputHash,
        resultHash: comparisonResultHash({ comparisonMode, status, summary, items }),
        comparedAt,
        summary,
        items,
      };
    }
    const draft = changeItem({
      kind: "first_seen",
      subjectKey: current.eventId,
      reasonCode: "NO_PREVIOUS_EVENT_VERSION",
      summary: "系统首次发现该事件；没有上一版本，不生成增减、转多或转空判断。",
      after: { type: "event_version", id: current.id, versionNumber: current.versionNumber },
    });
    const items = finalizeItems([draft]);
    const status = "first_seen" as const;
    const summary = "首次发现：没有上一事件版本。";
    const inputHash = sha256({
      schema: "event-version-comparison-input/v1",
      comparisonMode,
      algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
      implementationHash: WHAT_CHANGED_IMPLEMENTATION_HASH,
      previous: null,
      current: {
        eventId: current.eventId,
        id: current.id,
        versionNumber: current.versionNumber,
        contentHash: current.contentHash,
        evidenceHash: current.evidenceHash,
        stateHash: current.stateHash,
      },
    });
    return {
      eventId: current.eventId,
      currentVersionId: current.id,
      status,
      algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
      inputHash,
      resultHash: comparisonResultHash({ comparisonMode, status, summary, items }),
      comparedAt,
      summary,
      items,
    };
  }

  if (legacyVersion(previous) || legacyVersion(current)) {
    const status = "legacy_unverified" as const;
    const summary = "历史版本缺少原生差异记录，不生成推测性变化。";
    const inputHash = sha256({
      schema: "event-version-comparison-input/v1",
      comparisonMode,
      algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
      implementationHash: WHAT_CHANGED_IMPLEMENTATION_HASH,
      previous: { id: previous.id, contentHash: previous.contentHash },
      current: { id: current.id, contentHash: current.contentHash },
      legacyUnverified: true,
    });
    return {
      eventId: current.eventId,
      previousVersionId: previous.id,
      currentVersionId: current.id,
      status,
      algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
      inputHash,
      resultHash: comparisonResultHash({ comparisonMode, status, summary, items: [] }),
      comparedAt,
      summary,
      items: [],
    };
  }

  const previousEvidence = exactEvidenceMap(previous);
  const currentEvidence = exactEvidenceMap(current);
  const previousCitations = exactClaimCitationMap(previous);
  const currentCitations = exactClaimCitationMap(current);
  const previousNumbers = numericFactMap(numericFacts.previous ?? previous.numericFacts, previous);
  const currentNumbers = numericFactMap(numericFacts.current ?? current.numericFacts, current);
  const drafts: Array<Omit<WhatChangedItem, "ordinal">> = [];

  for (const key of [...new Set([...previousEvidence.keys(), ...currentEvidence.keys()])].sort()) {
    const before = previousEvidence.get(key);
    const after = currentEvidence.get(key);
    if (!before && after) {
      drafts.push(changeItem({
        kind: "evidence_added",
        subjectKey: `evidence:${after.sourceDocumentId}:${after.evidenceItemId}`,
        reasonCode: "EVIDENCE_ITEM_ADDED",
        summary: "当前版本新增一条可定位证据。",
        after: evidenceValue(after),
        evidenceVersionIds: [after.evidenceVersionId],
      }));
    } else if (before && !after) {
      drafts.push(changeItem({
        kind: "evidence_removed",
        subjectKey: `evidence:${before.sourceDocumentId}:${before.evidenceItemId}`,
        reasonCode: "EVIDENCE_ITEM_REMOVED",
        summary: "当前版本不再包含上一版本的一条证据。",
        before: evidenceValue(before),
        evidenceVersionIds: [before.evidenceVersionId],
      }));
    } else if (before && after && (before.evidenceVersionId !== after.evidenceVersionId
      || before.sourceDocumentVersionId !== after.sourceDocumentVersionId)) {
      drafts.push(changeItem({
        kind: "evidence_revised",
        subjectKey: `evidence:${after.sourceDocumentId}:${after.evidenceItemId}`,
        reasonCode: "EVIDENCE_VERSION_REVISED",
        summary: "同一证据锚点换成新的不可变证据版本。",
        before: evidenceValue(before),
        after: evidenceValue(after),
        evidenceVersionIds: [before.evidenceVersionId, after.evidenceVersionId],
      }));
    }
  }

  for (const key of [...new Set([...previousCitations.keys(), ...currentCitations.keys()])].sort()) {
    const before = previousCitations.get(key);
    const after = currentCitations.get(key);
    if (!before && after) {
      const support = after.relation === "supports";
      drafts.push(changeItem({
        kind: support ? "claim_support_added" : "claim_relation_added",
        subjectKey: `claim:${after.claimKey}:${after.relation}:${after.evidenceVersionId}`,
        reasonCode: support ? "CLAIM_SUPPORT_LINK_ADDED" : "CLAIM_EVIDENCE_RELATION_ADDED",
        summary: support
          ? "当前声明新增一条精确支持关系。"
          : `当前声明新增一条${after.relation === "contradicts" ? "反证" : "背景"}关系。`,
        after: support
          ? supportValue({ ...after, relation: "supports" })
          : citationValue(after),
        evidenceVersionIds: [after.evidenceVersionId],
      }));
    } else if (before && !after) {
      const support = before.relation === "supports";
      drafts.push(changeItem({
        kind: support ? "claim_support_removed" : "claim_relation_removed",
        subjectKey: `claim:${before.claimKey}:${before.relation}:${before.evidenceVersionId}`,
        reasonCode: support ? "CLAIM_SUPPORT_LINK_REMOVED" : "CLAIM_EVIDENCE_RELATION_REMOVED",
        summary: support
          ? "当前声明移除一条上一版本的支持关系。"
          : `当前声明移除一条上一版本的${before.relation === "contradicts" ? "反证" : "背景"}关系。`,
        before: support
          ? supportValue({ ...before, relation: "supports" })
          : citationValue(before),
        evidenceVersionIds: [before.evidenceVersionId],
      }));
    } else if (before && after && canonicalJson(before) !== canonicalJson(after)) {
      const support = before.relation === "supports" && after.relation === "supports";
      drafts.push(changeItem({
        kind: support ? "claim_support_changed" : "claim_relation_changed",
        subjectKey: `claim:${after.claimKey}:${after.relation}:${after.sourceDocumentId}:${after.evidenceItemId}`,
        reasonCode: support ? "CLAIM_SUPPORT_LINK_CHANGED" : "CLAIM_EVIDENCE_RELATION_CHANGED",
        summary: support
          ? "同一声明与证据锚点的精确支持版本或支持属性发生变化。"
          : "同一声明与证据锚点的非支持关系版本或属性发生变化。",
        before: support
          ? supportValue({ ...before, relation: "supports" })
          : citationValue(before),
        after: support
          ? supportValue({ ...after, relation: "supports" })
          : citationValue(after),
        evidenceVersionIds: [before.evidenceVersionId, after.evidenceVersionId],
      }));
    }
  }

  for (const factKey of [...new Set([...previousNumbers.keys(), ...currentNumbers.keys()])].sort()) {
    const before = previousNumbers.get(factKey);
    const after = currentNumbers.get(factKey);
    if (!before || !after || !comparableFacts(before, after) || before.value === after.value) continue;
    drafts.push(changeItem({
      kind: "numeric_changed",
      subjectKey: `numeric:${factKey}`,
      reasonCode: "COMPARABLE_NUMERIC_VALUE_CHANGED",
      summary: "同一指标、主体、期间、单位及尺度下的原文数字发生变化。",
      before: numericValue(before),
      after: numericValue(after),
      evidenceVersionIds: [...before.evidenceVersionIds, ...after.evidenceVersionIds],
    }));
  }

  const beforeDirection = previous.headline.marketDirection;
  const afterDirection = current.headline.marketDirection;
  if (!beforeDirection && afterDirection) {
    const evidenceIds = claimSupportEvidenceIds(current, "direction_rationale");
    drafts.push(changeItem({
      kind: "direction_established",
      subjectKey: "market_direction",
      reasonCode: "MARKET_DIRECTION_ESTABLISHED",
      summary: "当前版本首次建立明确市场方向；不是由上一方向“转多”或“转空”。",
      after: {
        type: "market_direction",
        direction: afterDirection,
        confidence: current.headline.directionConfidence,
      },
      evidenceVersionIds: evidenceIds,
    }));
  } else if (beforeDirection !== afterDirection) {
    const evidenceIds = uniqueSorted([
      ...claimSupportEvidenceIds(previous, "direction_rationale"),
      ...claimSupportEvidenceIds(current, "direction_rationale"),
    ]);
    drafts.push(changeItem({
      kind: "direction_changed",
      subjectKey: "market_direction",
      reasonCode: afterDirection ? "MARKET_DIRECTION_CHANGED" : "MARKET_DIRECTION_REMOVED",
      summary: afterDirection ? "明确市场方向与上一事件版本不同。" : "当前版本撤除上一版本的明确市场方向。",
      before: beforeDirection ? {
        type: "market_direction",
        direction: beforeDirection,
        confidence: previous.headline.directionConfidence,
      } : undefined,
      after: afterDirection ? {
        type: "market_direction",
        direction: afterDirection,
        confidence: current.headline.directionConfidence,
      } : undefined,
      evidenceVersionIds: evidenceIds,
    }));
  }

  const previousClaims = claimMap(previous);
  const currentClaims = claimMap(current);
  for (const claimKey of [...new Set([...previousClaims.keys(), ...currentClaims.keys()])].sort()) {
    const before = previousClaims.get(claimKey);
    const after = currentClaims.get(claimKey);
    if (before?.statementHash === after?.statementHash) continue;
    drafts.push(changeItem({
      kind: "claim_changed",
      subjectKey: `claim:${claimKey}`,
      reasonCode: !before ? "CLAIM_ADDED" : !after ? "CLAIM_REMOVED" : "ORIGINAL_CLAIM_CHANGED",
      summary: !before ? "当前版本新增一条声明。" : !after ? "当前版本移除一条声明。" : "同一声明的原文断言发生变化。",
      before: before ? {
        type: "claim",
        claimKey,
        statementHash: before.statementHash,
        originalStatement: before.originalStatement ?? before.statement,
      } : undefined,
      after: after ? {
        type: "claim",
        claimKey,
        statementHash: after.statementHash,
        originalStatement: after.originalStatement ?? after.statement,
      } : undefined,
      evidenceVersionIds: uniqueSorted([
        ...claimSupportEvidenceIds(previous, claimKey),
        ...claimSupportEvidenceIds(current, claimKey),
      ]),
    }));
  }

  const previousNonDirectionState = nonDirectionState(previous);
  const currentNonDirectionState = nonDirectionState(current);
  if (canonicalJson(previousNonDirectionState) !== canonicalJson(currentNonDirectionState)) {
    drafts.push(changeItem({
      kind: "state_changed",
      subjectKey: "event_state",
      reasonCode: "NON_DIRECTION_EVENT_STATE_CHANGED",
      summary: "事件的非排名、非展示状态发生变化。",
      before: previousNonDirectionState,
      after: currentNonDirectionState,
    }));
  }

  const items = finalizeItems(drafts);
  const status: EventVersionComparison["status"] = items.length ? "changed" : "comparison_unavailable";
  const summary = items.length
    ? `与上一事件版本相比，共识别 ${items.length} 项可稽核变化。`
    : "两个相邻版本存在，但本算法未识别到可安全陈述的差异。";
  const inputHash = sha256(comparisonCore(
    comparisonMode,
    previous,
    current,
    previousEvidence,
    currentEvidence,
    previousCitations,
    currentCitations,
    previousNumbers,
    currentNumbers,
  ));
  return {
    eventId: current.eventId,
    previousVersionId: previous.id,
    currentVersionId: current.id,
    status,
    algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
    inputHash,
    resultHash: comparisonResultHash({ comparisonMode, status, summary, items }),
    comparedAt,
    summary,
    items,
  };
}

export function compareEventVersions(
  previous: EventVersionRecord | undefined,
  current: EventVersionRecord,
  numericFacts: NumericFactComparisonInput = {},
): EventVersionComparison {
  return compareEventVersionPair("adjacent_version", previous, current, numericFacts);
}

export function compareEventBaseline(
  previous: EventVersionRecord | undefined,
  current: EventVersionRecord,
  numericFacts: NumericFactComparisonInput = {},
): EventVersionComparison {
  return compareEventVersionPair("snapshot_baseline", previous, current, numericFacts);
}

function assertSnapshotInput(input: SnapshotEventComparisonInput): void {
  const currentSnapshotId = requiredText(input.currentSnapshotId, "currentSnapshotId");
  if (input.current.snapshotId && input.current.snapshotId !== currentSnapshotId) {
    integrity(
      "SNAPSHOT_ID_MISMATCH",
      `current event belongs to ${input.current.snapshotId}, not ${currentSnapshotId}`,
    );
  }
  if (input.baselineEvent) {
    if (!input.baselineSnapshotId) {
      integrity("BASELINE_SNAPSHOT_REQUIRED", "baseline event requires its contextual snapshot id");
    }
    if (input.baselineEvent.snapshotId !== input.baselineSnapshotId) {
      integrity("BASELINE_SNAPSHOT_MISMATCH", "baseline event is not from the contextual baseline snapshot");
    }
    if (input.baselineEvent.eventId !== input.current.eventId) {
      integrity("EVENT_ID_MISMATCH", "baseline event and current event have different event ids");
    }
  }
  const versionChanged = Boolean(
    input.baselineEvent
    && input.baselineEvent.eventVersionId !== input.current.eventVersionId,
  );
  if (versionChanged && !input.contentComparison) {
    integrity(
      "CONTENT_COMPARISON_REQUIRED",
      "different baseline/current event versions require an exact endpoint content comparison",
    );
  }
  if (!versionChanged && input.contentComparison) {
    integrity(
      "REDUNDANT_CONTENT_COMPARISON",
      "same-version or absent-event baselines must not replay an old content comparison",
    );
  }
  if (input.contentComparison) {
    if (input.contentComparison.eventId !== input.current.eventId
      || input.contentComparison.previousVersionId !== input.baselineEvent?.eventVersionId
      || input.contentComparison.currentVersionId !== input.current.eventVersionId) {
      integrity(
        "CONTENT_COMPARISON_BASELINE_MISMATCH",
        "content comparison endpoints do not match the exact snapshot baseline/current versions",
      );
    }
  }
  if (input.historicalObservation) {
    if (input.baselineEvent) {
      integrity("REDUNDANT_HISTORICAL_OBSERVATION", "continued events do not use a reentry observation");
    }
    if (input.historicalObservation.eventId !== input.current.eventId) {
      integrity("EVENT_ID_MISMATCH", "historical observation and current event have different event ids");
    }
    if (input.historicalObservation.snapshotId === input.baselineSnapshotId) {
      integrity("INVALID_HISTORICAL_OBSERVATION", "historical observation cannot equal an absent-event baseline");
    }
  }
  if (input.isFirstSeen && (input.baselineEvent || input.historicalObservation)) {
    integrity("INVALID_FIRST_SEEN_BASELINE", "first-seen event cannot have an earlier event observation");
  }
  exactIso(input.comparedAt, "comparedAt");
}

function snapshotSummary(
  presence: SnapshotEventChange["presence"],
  rankMovement: SnapshotEventChange["rankMovement"],
  rankDelta: number | undefined,
): string {
  if (presence === "first_seen") return "该事件为系统首次发现，没有可比较的历史排名。";
  if (presence === "no_baseline") return "缺少该比较口径的基线快照，不生成排名变化。";
  if (presence === "entered") return "该事件进入当前榜单；系统此前没有该事件的排名观测。";
  if (presence === "reentered") return "该事件重新进入当前榜单；基线快照未包含它。";
  if (rankMovement === "up") return `排名较基线上升 ${rankDelta} 位。`;
  if (rankMovement === "down") return `排名较基线下降 ${Math.abs(rankDelta ?? 0)} 位。`;
  return "排名与基线相同。";
}

export function compareSnapshotEvent(input: SnapshotEventComparisonInput): SnapshotEventChange {
  assertSnapshotInput(input);
  const { baselineEvent, current, historicalObservation } = input;
  const presence: SnapshotEventChange["presence"] = input.isFirstSeen
    ? "first_seen"
    : baselineEvent
      ? "continued"
      : input.baselineSnapshotId
        ? historicalObservation ? "reentered" : "entered"
        : "no_baseline";
  const rankDelta = !input.legacyUnverified && baselineEvent
    ? baselineEvent.rank - current.rank
    : undefined;
  const rankMovement: SnapshotEventChange["rankMovement"] = rankDelta === undefined
    ? "not_comparable"
    : rankDelta > 0 ? "up" : rankDelta < 0 ? "down" : "unchanged";
  const drafts: Array<Omit<WhatChangedItem, "ordinal">> = [];

  if (presence === "first_seen") {
    drafts.push(changeItem({
      kind: "first_seen",
      subjectKey: `snapshot:${input.baselineKind}:presence`,
      reasonCode: "NO_EARLIER_EVENT_OBSERVATION",
      summary: "该事件为系统首次发现；不生成排名升降。",
      after: { type: "rank", rank: current.rank },
    }));
  } else if (presence === "entered" || presence === "reentered") {
    drafts.push(changeItem({
      kind: presence,
      subjectKey: `snapshot:${input.baselineKind}:presence`,
      reasonCode: presence === "entered" ? "EVENT_ENTERED_BASELINE" : "EVENT_REENTERED_BASELINE",
      summary: presence === "entered" ? "事件进入当前榜单。" : "事件在缺席基线后重新进入当前榜单。",
      after: { type: "rank", rank: current.rank },
    }));
  } else if (rankMovement === "up" || rankMovement === "down") {
    drafts.push(changeItem({
      kind: rankMovement === "up" ? "rank_up" : "rank_down",
      subjectKey: `snapshot:${input.baselineKind}:rank`,
      reasonCode: rankMovement === "up" ? "RANK_MOVED_UP" : "RANK_MOVED_DOWN",
      summary: rankMovement === "up"
        ? `排名由第 ${baselineEvent?.rank} 位升至第 ${current.rank} 位。`
        : `排名由第 ${baselineEvent?.rank} 位降至第 ${current.rank} 位。`,
      before: { type: "rank", rank: baselineEvent?.rank },
      after: { type: "rank", rank: current.rank },
    }));
  }

  if (!input.legacyUnverified && input.contentComparison) {
    for (const contentItem of input.contentComparison.items) drafts.push(stripOrdinal(contentItem));
  }

  const items = input.legacyUnverified ? [] : finalizeItems(drafts);
  const status: WhatChangedStatus = input.legacyUnverified
    ? "legacy_unverified"
    : presence === "first_seen"
      ? "first_seen"
      : presence === "no_baseline"
        ? "comparison_unavailable"
        : items.length ? "changed"
          : input.contentComparison?.status === "comparison_unavailable"
            ? "comparison_unavailable"
            : "unchanged";
  const rankSummary = input.legacyUnverified
    ? "迁移前快照没有原生排名比较记录，不生成推测性变化。"
    : snapshotSummary(presence, rankMovement, rankDelta);
  const summary = input.contentComparison && !input.legacyUnverified
    ? `${rankSummary} 内容基线：${input.contentComparison.summary}`
    : rankSummary;
  const inputHash = sha256({
    schema: "snapshot-event-comparison-input/v1",
    algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
    implementationHash: WHAT_CHANGED_IMPLEMENTATION_HASH,
    baselineKind: input.baselineKind,
    baselineSnapshotId: input.baselineSnapshotId ?? null,
    baselineEvent: baselineEvent ? {
      snapshotId: baselineEvent.snapshotId,
      eventId: baselineEvent.eventId,
      eventVersionId: baselineEvent.eventVersionId,
      rank: baselineEvent.rank,
    } : null,
    historicalObservation: historicalObservation ? {
      snapshotId: historicalObservation.snapshotId,
      eventId: historicalObservation.eventId,
      eventVersionId: historicalObservation.eventVersionId,
      rank: historicalObservation.rank,
    } : null,
    current: {
      snapshotId: input.currentSnapshotId,
      eventId: current.eventId,
      eventVersionId: current.eventVersionId,
      rank: current.rank,
    },
    isFirstSeen: input.isFirstSeen === true,
    legacyUnverified: input.legacyUnverified === true,
    contentComparisonResultHash: input.contentComparison?.resultHash ?? null,
  });
  const resultCore = {
    schema: "snapshot-event-comparison-result/v1",
    algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
    baselineKind: input.baselineKind,
    presence,
    previousRank: baselineEvent?.rank,
    currentRank: current.rank,
    rankDelta,
    rankMovement,
    status,
    summary,
    items,
    contentComparisonResultHash: input.contentComparison?.resultHash ?? null,
  };
  return {
    currentSnapshotId: input.currentSnapshotId,
    eventId: current.eventId,
    currentEventVersionId: current.eventVersionId,
    baselineKind: input.baselineKind,
    baselineSnapshotId: input.baselineSnapshotId,
    baselineEventVersionId: baselineEvent?.eventVersionId,
    historicalObservationSnapshotId: historicalObservation?.snapshotId,
    presence,
    previousRank: baselineEvent?.rank,
    currentRank: current.rank,
    rankDelta,
    rankMovement,
    status,
    algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
    inputHash,
    resultHash: sha256(resultCore),
    comparedAt: exactIso(input.comparedAt, "comparedAt"),
    summary,
    items,
  };
}

export function projectWhatChanged(input: WhatChangedProjectionInput): WhatChangedProjection {
  for (const comparison of [input.investor, input.operational, input.latestVersion]) {
    if (comparison.algorithmVersion !== WHAT_CHANGED_ALGORITHM_VERSION) {
      integrity(
        "ALGORITHM_VERSION_MISMATCH",
        `cannot combine ${comparison.algorithmVersion} with ${WHAT_CHANGED_ALGORITHM_VERSION}`,
      );
    }
  }
  const status: WhatChangedStatus =
    input.investor.status === "first_seen"
      || input.operational.status === "first_seen"
      ? "first_seen"
      : input.investor.status === "changed"
        || input.operational.status === "changed"
        ? "changed"
        : input.investor.status === "legacy_unverified"
          && input.operational.status === "legacy_unverified"
          ? "legacy_unverified"
        : input.investor.status === "comparison_unavailable"
          && input.operational.status === "comparison_unavailable"
          ? "comparison_unavailable"
          : "unchanged";
  const itemMap = new Map<string, WhatChangedItem>();
  for (const item of [
    ...input.investor.items,
    ...input.operational.items,
  ]) {
    itemMap.set(item.changeHash, item);
  }
  const items = finalizeItems(
    [...itemMap.values()].map(stripOrdinal),
  );
  const summary = [
    `投资人基线：${input.investor.summary}`,
    `运行基线：${input.operational.summary}`,
    `事件版本：${input.latestVersion.summary}`,
  ].join(" ");
  const core = {
    schemaVersion: "what-changed/v1" as const,
    algorithmVersion: WHAT_CHANGED_ALGORITHM_VERSION,
    status,
    summary,
    investor: input.investor,
    operational: input.operational,
    latestVersion: input.latestVersion,
    items,
  };
  return { ...core, resultHash: sha256(core) };
}
