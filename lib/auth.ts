import { timingSafeEqual } from "node:crypto";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_TOKEN);
}

export function isAdminRequest(request: Request): boolean {
  if (!process.env.ADMIN_TOKEN) return false;
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const headerToken = request.headers.get("x-admin-token") ?? "";
  return safeEqual(authorization || headerToken, process.env.ADMIN_TOKEN);
}

export function isCronRequest(request: Request): boolean {
  if (!process.env.CRON_SECRET) return false;
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return safeEqual(authorization, process.env.CRON_SECRET);
}
