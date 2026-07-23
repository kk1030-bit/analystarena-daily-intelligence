import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_TOKEN);
}

export function auditConfigured(): boolean {
  const key = process.env.AUDIT_HMAC_KEY ?? "";
  return key.length >= 32
    && (!process.env.ADMIN_TOKEN || !safeEqual(key, process.env.ADMIN_TOKEN));
}

export function isAdminRequest(request: Request): boolean {
  if (!process.env.ADMIN_TOKEN) return false;
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const headerToken = request.headers.get("x-admin-token") ?? "";
  return safeEqual(authorization || headerToken, process.env.ADMIN_TOKEN);
}

export function adminAuditActor(
  request: Request,
  reason: string,
): { type: "admin"; idHash: string; reason: string; requestId?: string } {
  if (!isAdminRequest(request) || !process.env.ADMIN_TOKEN) {
    throw new Error("Cannot create an audit actor for an unauthorized request");
  }
  const auditKey = process.env.AUDIT_HMAC_KEY;
  if (!auditKey || auditKey.length < 32
    || safeEqual(auditKey, process.env.ADMIN_TOKEN)) {
    throw new Error("AUDIT_HMAC_KEY must be an independent value of at least 32 characters");
  }
  return {
    type: "admin",
    idHash: createHmac("sha256", auditKey)
      .update(`admin-credential:${process.env.ADMIN_TOKEN}`)
      .digest("hex"),
    reason,
    requestId: randomUUID(),
  };
}

export function isCronRequest(request: Request): boolean {
  if (!process.env.CRON_SECRET) return false;
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return safeEqual(authorization, process.env.CRON_SECRET);
}

export function redditSearchConfigured(): boolean {
  return Boolean(process.env.REDDIT_SEARCH_API_TOKEN);
}

export function isRedditSearchRequest(request: Request): boolean {
  if (!process.env.REDDIT_SEARCH_API_TOKEN) return false;
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const apiKey = request.headers.get("x-api-key") ?? "";
  return safeEqual(authorization, process.env.REDDIT_SEARCH_API_TOKEN)
    || safeEqual(apiKey, process.env.REDDIT_SEARCH_API_TOKEN);
}

export function stockSearchConfigured(): boolean {
  return Boolean(process.env.STOCK_SEARCH_API_TOKEN);
}

export function isStockSearchRequest(request: Request): boolean {
  if (!process.env.STOCK_SEARCH_API_TOKEN) return false;
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const apiKey = request.headers.get("x-api-key") ?? "";
  return safeEqual(authorization, process.env.STOCK_SEARCH_API_TOKEN)
    || safeEqual(apiKey, process.env.STOCK_SEARCH_API_TOKEN);
}
