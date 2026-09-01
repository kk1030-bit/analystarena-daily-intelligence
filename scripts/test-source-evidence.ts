import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assertEvidenceBoundToSourceCapture,
  canonicalEvidenceJson,
  createEvidenceCitation,
  createHeadlineClaim,
  createSourceEvidence,
  evidenceItemId,
  evidenceVersionMaterialHash,
  sha256ExactUtf8,
  SourceEvidenceValidationError,
  validateHeadlineEvidence,
} from "../lib/source-evidence";
import { ensureRawStoryIdentity } from "../lib/source-identity";
import type { EvidenceLocator, Headline, RawStory, SourceEvidence } from "../lib/types";

const capturedAt = "2026-07-22T01:02:03.000Z";
const sourceDocumentId = "sd_test-source-document";

function feedEvidence(quoteOriginal: string, locator?: EvidenceLocator): SourceEvidence {
  return createSourceEvidence({
    sourceDocumentId,
    sourceDocumentVersionId: "sdv_1",
    anchorKey: "feed:entry-42:description",
    quoteOriginal,
    quoteLanguage: "zh-CN",
    locator: locator ?? {
      kind: "feed_field",
      feedUrl: "https://publisher.example/feed.xml",
      entryId: "entry-42",
      field: "description",
      fieldPath: "rss.channel.item[0].description",
    },
    locatorStatus: "exact",
    directness: "direct",
    captureScope: "rss_entry",
    extractionMethod: "fast-xml-parser:raw-field",
    extractorVersion: "source-evidence/v1",
    capturedAt,
  });
}

const exactQuote = "北京市场📈\r\nNVIDIA—Blackwelĺ";
const exactExpected = createHash("sha256").update(Buffer.from(exactQuote, "utf8")).digest("hex");
assert.equal(sha256ExactUtf8(exactQuote), exactExpected, "CJK, emoji, CRLF and combining marks must hash exact bytes");
assert.notEqual(sha256ExactUtf8(exactQuote), sha256ExactUtf8(exactQuote.normalize("NFC")));

const locatorA: EvidenceLocator = {
  kind: "feed_field",
  feedUrl: "https://publisher.example/feed.xml",
  entryId: "entry-42",
  field: "description",
  fieldPath: "rss.channel.item[0].description",
};
const locatorB = {
  fieldPath: "rss.channel.item[0].description",
  field: "description",
  entryId: "entry-42",
  feedUrl: "https://publisher.example/feed.xml",
  kind: "feed_field",
} as EvidenceLocator;
assert.equal(canonicalEvidenceJson(locatorA), canonicalEvidenceJson(locatorB));
const reorderedA = feedEvidence(exactQuote, locatorA);
const reorderedB = feedEvidence(exactQuote, locatorB);
assert.equal(reorderedA.locatorHash, reorderedB.locatorHash, "object key order must not affect locator identity");
assert.equal(reorderedA.id, reorderedB.id);
assert.equal(evidenceVersionMaterialHash(reorderedA), evidenceVersionMaterialHash(reorderedB));

assert.throws(
  () => feedEvidence("quote", { ...locatorA, feedUrl: "javascript:alert(1)" }),
  (error) => error instanceof SourceEvidenceValidationError && error.code === "INVALID_LOCATOR_URL",
  "non-HTTP locator URLs must fail closed",
);
assert.throws(
  () => createSourceEvidence({ ...feedEvidence("quote"), capturedAt: "2026-07-22T01:02:03" }),
  (error) => error instanceof SourceEvidenceValidationError && error.code === "INVALID_CAPTURED_AT",
  "evidence capture time without an explicit timezone must fail closed",
);
assert.throws(
  () => createSourceEvidence({ ...feedEvidence("quote"), capturedAt: "2026-02-30T01:02:03Z" }),
  (error) => error instanceof SourceEvidenceValidationError && error.code === "INVALID_CAPTURED_AT",
  "an impossible evidence capture calendar date must fail closed",
);

const unavailable = createSourceEvidence({
  sourceDocumentId,
  anchorKey: "reddit:post-9:body",
  locator: { kind: "unavailable", reasonCode: "body_not_collected", detail: "Only the title was visible" },
  locatorStatus: "unavailable",
  directness: "unavailable",
  captureScope: "reddit_post",
  extractionMethod: "playwright:title-only",
  extractorVersion: "source-evidence/v1",
  capturedAt,
});
assert.equal(unavailable.quoteOriginal, undefined);
assert.equal(unavailable.quoteHash, undefined);
assert.throws(
  () => createSourceEvidence({ ...unavailable, quoteOriginal: "invented body" }),
  (error) => error instanceof SourceEvidenceValidationError && error.code === "QUOTE_NOT_ALLOWED",
  "unavailable evidence must never carry a fake quote",
);
assert.throws(
  () => createSourceEvidence({ ...unavailable, quoteZhCn: "伪造的译文" }),
  (error) => error instanceof SourceEvidenceValidationError && error.code === "QUOTE_NOT_ALLOWED",
  "unavailable evidence must never carry a translated fake quote",
);

const htmlArtifact = "Context before Exact filing sentence. Context after";
const htmlBase = ensureRawStoryIdentity({
  id: "html-source",
  title: "Filing",
  description: "Exact filing sentence.",
  url: "https://publisher.example/filing/42?utm_source=test",
  publishedAt: capturedAt,
  originalPublishedAt: null,
  source: "Publisher",
  sourceType: "Official",
  collectedAt: capturedAt,
  timestampKind: "collected",
} as RawStory);
const htmlEvidence = createSourceEvidence({
  sourceDocumentId: htmlBase.sourceDocumentId!,
  anchorKey: "html:filing-sentence",
  quoteOriginal: "Exact filing sentence.",
  locator: {
    kind: "html_text_quote",
    pageUrl: htmlBase.canonicalUrl!,
    textQuote: {
      exact: "Exact filing sentence.",
      prefix: "Context before ",
      suffix: " Context after",
    },
  },
  locatorStatus: "exact",
  directness: "direct",
  captureScope: "detail_page",
  extractionMethod: "playwright_visible_text",
  extractorVersion: "html-test/v1",
  capturedAt,
});
const htmlStory: RawStory = {
  ...htmlBase,
  capture: {
    rawUrl: htmlBase.url,
    canonicalUrl: htmlBase.canonicalUrl,
    originalPublishedAt: null,
    collectedAt: capturedAt,
    scope: "detail_page",
    capturedContentHash: sha256ExactUtf8(htmlArtifact),
    capturedArtifact: htmlArtifact,
    capturedArtifactEncoding: "utf8",
    capturedArtifactSizeBytes: Buffer.byteLength(htmlArtifact, "utf8"),
    extractionMethod: "playwright_visible_text",
    extractorVersion: "html-test/v1",
    backfillQuality: "native",
  },
  evidence: [htmlEvidence],
};
assert.doesNotThrow(() => assertEvidenceBoundToSourceCapture(htmlStory, htmlStory.capture!));
const forgedHtml = structuredClone(htmlStory);
forgedHtml.evidence![0] = createSourceEvidence({
  ...forgedHtml.evidence![0],
  quoteOriginal: "Invented filing sentence.",
  locator: {
    kind: "html_text_quote",
    pageUrl: htmlBase.canonicalUrl!,
    textQuote: { exact: "Invented filing sentence." },
  },
  quoteHash: undefined,
  locatorHash: undefined,
});
assert.throws(
  () => assertEvidenceBoundToSourceCapture(forgedHtml, forgedHtml.capture!),
  /not present at its claimed capture context/,
  "an internally consistent HTML TextQuoteSelector cannot cite text absent from capturedArtifact",
);
const forgedHtmlStructure = structuredClone(htmlStory);
forgedHtmlStructure.evidence![0] = createSourceEvidence({
  ...forgedHtmlStructure.evidence![0],
  locator: {
    kind: "html_text_quote",
    pageUrl: htmlBase.canonicalUrl!,
    selector: "#fabricated-paragraph",
    textQuote: { exact: "Exact filing sentence." },
  },
  locatorHash: undefined,
});
assert.throws(
  () => assertEvidenceBoundToSourceCapture(forgedHtmlStructure, forgedHtmlStructure.capture!),
  /structural locator.*not proven/i,
  "a CSS or paragraph locator must not be accepted when the capture preserves only visible text",
);

const pdfBase = ensureRawStoryIdentity({
  id: "pdf-source",
  title: "Annual report",
  description: "Revenue increased by 12 percent.",
  url: "https://publisher.example/reports/annual.pdf",
  publishedAt: capturedAt,
  originalPublishedAt: null,
  source: "Publisher",
  sourceType: "Official",
  collectedAt: capturedAt,
  timestampKind: "collected",
} as RawStory);
const pdfCapturedArtifact = JSON.stringify({
  schema: "pdf-text-capture/v1",
  url: pdfBase.canonicalUrl,
  pages: [
    { pageNumber: 1, text: "Cover page" },
    { pageNumber: 2, text: "Revenue increased by 12 percent." },
  ],
});
const pdfEvidence = createSourceEvidence({
  sourceDocumentId: pdfBase.sourceDocumentId!,
  anchorKey: "pdf:annual-report:revenue",
  quoteOriginal: "Revenue increased by 12 percent.",
  locator: {
    kind: "pdf_text",
    pdfUrl: pdfBase.canonicalUrl!,
    pageNumber: 2,
    startOffset: 0,
    endOffset: 32,
  },
  locatorStatus: "exact",
  directness: "direct",
  captureScope: "pdf",
  extractionMethod: "pdf_text_by_page",
  extractorVersion: "pdf-test/v1",
  capturedAt,
});
const pdfStory: RawStory = {
  ...pdfBase,
  capture: {
    rawUrl: pdfBase.url,
    canonicalUrl: pdfBase.canonicalUrl,
    originalPublishedAt: null,
    collectedAt: capturedAt,
    scope: "pdf",
    capturedContentHash: sha256ExactUtf8(pdfCapturedArtifact),
    capturedArtifact: pdfCapturedArtifact,
    capturedArtifactEncoding: "utf8",
    capturedArtifactSizeBytes: Buffer.byteLength(pdfCapturedArtifact, "utf8"),
    extractionMethod: "pdf_text_by_page",
    extractorVersion: "pdf-test/v1",
    backfillQuality: "native",
  },
  evidence: [pdfEvidence],
};
assert.doesNotThrow(() => assertEvidenceBoundToSourceCapture(pdfStory, pdfStory.capture!));
const forgedPdfPage = structuredClone(pdfStory);
forgedPdfPage.evidence![0] = createSourceEvidence({
  ...forgedPdfPage.evidence![0],
  locator: {
    kind: "pdf_text",
    pdfUrl: pdfBase.canonicalUrl!,
    pageNumber: 3,
  },
  locatorHash: undefined,
});
assert.throws(
  () => assertEvidenceBoundToSourceCapture(forgedPdfPage, forgedPdfPage.capture!),
  /page absent from the capture/,
  "a PDF quote cannot claim a page number that was not preserved in the page-aware capture",
);

const versionA1 = feedEvidence("Revenue was $10 million.");
const versionB = feedEvidence("Revenue was corrected to $9 million.");
const versionA2 = feedEvidence("Revenue was $10 million.");
assert.equal(versionA1.id, versionB.id, "item ID must remain stable at the same source anchor");
assert.equal(versionB.id, versionA2.id);
assert.notEqual(evidenceVersionMaterialHash(versionA1), evidenceVersionMaterialHash(versionB));
assert.notEqual(evidenceVersionMaterialHash(versionB), evidenceVersionMaterialHash(versionA2));
assert.equal(
  evidenceVersionMaterialHash(versionA1),
  evidenceVersionMaterialHash(versionA2),
  "A→B→A detects the return to A while retaining deterministic A material",
);
assert.equal(versionA1.id, evidenceItemId(sourceDocumentId, "feed:entry-42:description"));

const citation = createEvidenceCitation(versionA1, { relation: "supports", confidence: 1, order: 0 });
const claim = createHeadlineClaim({
  claimKey: "evt_test:important_information:0",
  type: "important_information",
  ordinal: 0,
  statement: "Revenue was $10 million.",
  originalStatement: "Revenue was $10 million.",
  language: "en",
  verificationStatus: "supported",
  citations: [citation],
  generator: "deterministic",
  generatorVersion: "source-evidence/v1",
});

const headline: Headline = {
  id: "evt_test",
  rank: 1,
  ticker: "TEST",
  title: "Test headline",
  summary: "Test summary",
  keyPoints: [claim.statement],
  marketImpact: "Pending analysis",
  category: "Earnings",
  impact: 3,
  confidence: 0.8,
  mentions: 1,
  sentiment: "neutral",
  sources: [{
    name: "Publisher",
    type: "News",
    url: "https://publisher.example/story/42",
    sourceDocumentId,
    sourceDocumentVersionId: "sdv_1",
    evidence: [versionA1],
  }],
  claims: [claim],
};
assert.deepEqual(validateHeadlineEvidence(headline), { valid: true, issues: [] });

const forgedEvidence = feedEvidence("Revenue was $100 million.");
const forgedCitation = createEvidenceCitation(forgedEvidence, { relation: "supports", confidence: 1, order: 0 });
const forgedHeadline: Headline = structuredClone(headline);
forgedHeadline.claims![0].citations = [forgedCitation];
const forgedResult = validateHeadlineEvidence(forgedHeadline);
assert.equal(forgedResult.valid, false);
assert.ok(forgedResult.issues.some((item) => item.code === "CITATION_QUOTE_MISMATCH"));
assert.ok(forgedResult.issues.some((item) => item.code === "CITATION_QUOTE_HASH_MISMATCH"));

const forgedVersionHeadline: Headline = structuredClone(headline);
forgedVersionHeadline.claims![0].citations[0].versionId = "evv_forged";
const forgedVersionResult = validateHeadlineEvidence(forgedVersionHeadline);
assert.equal(forgedVersionResult.valid, false);
assert.ok(forgedVersionResult.issues.some((item) => item.code === "CITATION_VERSION_MISMATCH"));

const editedHeadline: Headline = structuredClone(headline);
editedHeadline.claims![0].statement = "Revenue was $11 million.";
editedHeadline.claims![0].originalStatement = "Revenue was $11 million.";
const editedResult = validateHeadlineEvidence(editedHeadline);
assert.equal(editedResult.valid, false);
assert.ok(
  editedResult.issues.some((item) => item.code === "CLAIM_STATEMENT_HASH_MISMATCH"),
  "review-edited statements must invalidate the prior hash/citation projection",
);

console.log("source evidence tests passed");
