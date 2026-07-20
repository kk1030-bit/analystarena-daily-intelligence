import type { CollectorAttempt, CollectorStatus } from "../types";

export interface CollectorBackend<T> {
  name: string;
  collect: () => Promise<T[]>;
}

export interface CollectorRouteResult<T> {
  items: T[];
  status: CollectorStatus;
}

export function safeCollectorNote(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "采集失败");
  return message
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 [redacted]")
    .replace(/(auth_token|ct0|reddit_session|cookie|authorization|token|secret)\s*[:=]\s*["']?[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "采集失败";
}

export async function collectFirstAvailable<T>(
  channel: string,
  backends: CollectorBackend<T>[],
): Promise<CollectorRouteResult<T>> {
  const attempts: CollectorAttempt[] = [];
  const startedAt = Date.now();

  for (const [index, backend] of backends.entries()) {
    const attemptStartedAt = Date.now();
    try {
      const items = await backend.collect();
      const completedAt = new Date().toISOString();
      const latencyMs = Math.max(0, Date.now() - attemptStartedAt);
      const ok = items.length > 0;
      attempts.push({
        backend: backend.name,
        ok,
        count: items.length,
        latencyMs,
        completedAt,
        note: ok ? undefined : "未返回可用内容",
      });
      if (!ok) continue;
      return {
        items,
        status: {
          name: channel,
          channel,
          ok: true,
          count: items.length,
          backend: backend.name,
          latencyMs: Math.max(0, Date.now() - startedAt),
          fallbackUsed: index > 0,
          lastSuccessAt: completedAt,
          attempts,
          note: index > 0 ? `首选线路不可用，已由 ${backend.name} 备用线路接手` : undefined,
        },
      };
    } catch (error) {
      attempts.push({
        backend: backend.name,
        ok: false,
        count: 0,
        latencyMs: Math.max(0, Date.now() - attemptStartedAt),
        completedAt: new Date().toISOString(),
        note: safeCollectorNote(error),
      });
    }
  }

  return {
    items: [],
    status: {
      name: channel,
      channel,
      ok: false,
      count: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      fallbackUsed: attempts.length > 1,
      attempts,
      note: attempts.map((attempt) => `${attempt.backend}：${attempt.note ?? "失败"}`).join("；").slice(0, 240),
    },
  };
}
