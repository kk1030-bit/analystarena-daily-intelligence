export interface PublicationIssueDisplay {
  code: string;
  headlineId?: string;
  headlineRank?: number;
  claimKey?: string;
  message: string;
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function safeRank(value: unknown): number | undefined {
  const rank = Number(value);
  return Number.isInteger(rank) && rank > 0 && rank <= 10_000 ? rank : undefined;
}

/**
 * Converts an untrusted publication response into bounded plain text for the
 * review console. React renders every field as text; no server-provided HTML,
 * selectors, credentials or request metadata are accepted here.
 */
export function normalizePublicationIssues(value: unknown): PublicationIssueDisplay[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: PublicationIssueDisplay[] = [];

  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const code = safeText(record.code, 100) ?? "UNKNOWN_PUBLICATION_ISSUE";
    const headlineId = safeText(record.headlineId, 200);
    const headlineRank = safeRank(record.headlineRank);
    const claimKey = safeText(record.claimKey, 160);
    const message = safeText(record.reason ?? record.message, 600) ?? "发布核验未通过，请重新载入草稿后检查。";
    const key = JSON.stringify([code, headlineId, headlineRank, claimKey, message]);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      code,
      ...(headlineId ? { headlineId } : {}),
      ...(headlineRank ? { headlineRank } : {}),
      ...(claimKey ? { claimKey } : {}),
      message,
    });
  }
  return normalized;
}
