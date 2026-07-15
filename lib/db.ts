import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { BriefRecord, BriefStatus, DailyBrief } from "./types";

interface DatabaseRow {
  id: string;
  brief_date: string | Date;
  status: BriefStatus;
  payload: DailyBrief | string;
  created_at: string | Date;
  updated_at: string | Date;
  published_at: string | Date | null;
  has_pdf: boolean;
}

interface MemoryEntry extends BriefRecord {
  pdf?: Buffer;
}

declare global {
  var __analystArenaPool: Pool | undefined;
  var __analystArenaSchemaReady: Promise<void> | undefined;
  var __analystArenaMemory: Map<string, MemoryEntry> | undefined;
}

const memory = globalThis.__analystArenaMemory ?? new Map<string, MemoryEntry>();
globalThis.__analystArenaMemory = memory;

export function storageMode(): "postgres" | "memory" {
  return process.env.DATABASE_URL ? "postgres" : "memory";
}

function pool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!globalThis.__analystArenaPool) {
    const isPrivateOrLocal = /localhost|127\.0\.0\.1|\.internal(?::|\/)/i.test(process.env.DATABASE_URL);
    globalThis.__analystArenaPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 8_000,
      ssl: isPrivateOrLocal ? undefined : { rejectUnauthorized: false },
    });
  }
  return globalThis.__analystArenaPool;
}

async function ensureSchema(): Promise<void> {
  if (storageMode() === "memory") return;
  if (!globalThis.__analystArenaSchemaReady) {
    globalThis.__analystArenaSchemaReady = pool().query(`
      CREATE TABLE IF NOT EXISTS daily_briefs (
        id UUID PRIMARY KEY,
        brief_date DATE NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
        payload JSONB NOT NULL,
        pdf_data BYTEA,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS daily_briefs_status_date_idx
        ON daily_briefs (status, brief_date DESC);
    `).then(() => undefined);
  }
  await globalThis.__analystArenaSchemaReady;
}

function dateOnly(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function rowToRecord(row: DatabaseRow): BriefRecord {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as DailyBrief : row.payload;
  const brief: DailyBrief = {
    ...payload,
    id: row.id,
    status: row.status,
    publishedAt: row.published_at ? iso(row.published_at) : undefined,
    storageMode: "postgres",
  };
  return {
    id: row.id,
    date: dateOnly(row.brief_date),
    status: row.status,
    brief,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: row.published_at ? iso(row.published_at) : undefined,
    hasPdf: row.has_pdf,
  };
}

function cloneMemory(entry: MemoryEntry): BriefRecord {
  return {
    id: entry.id,
    date: entry.date,
    status: entry.status,
    brief: structuredClone(entry.brief),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    publishedAt: entry.publishedAt,
    hasPdf: Boolean(entry.pdf),
  };
}

export async function saveDraft(brief: DailyBrief): Promise<BriefRecord> {
  if (storageMode() === "memory") {
    const existing = [...memory.values()].find((entry) => entry.date === brief.date);
    if (existing?.status === "published") return cloneMemory(existing);
    const now = new Date().toISOString();
    const id = existing?.id ?? randomUUID();
    const entry: MemoryEntry = {
      id,
      date: brief.date,
      status: "draft",
      brief: { ...structuredClone(brief), id, status: "draft", storageMode: "memory" },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      hasPdf: false,
    };
    memory.set(id, entry);
    return cloneMemory(entry);
  }

  await ensureSchema();
  const id = randomUUID();
  const result = await pool().query<DatabaseRow>(`
    INSERT INTO daily_briefs (id, brief_date, status, payload)
    VALUES ($1, $2, 'draft', $3::jsonb)
    ON CONFLICT (brief_date) DO UPDATE
      SET payload = EXCLUDED.payload, status = 'draft', pdf_data = NULL,
          published_at = NULL, updated_at = NOW()
      WHERE daily_briefs.status <> 'published'
    RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
  `, [id, brief.date, JSON.stringify(brief)]);
  if (result.rows[0]) return rowToRecord(result.rows[0]);
  const existing = await getBriefByDate(brief.date);
  if (!existing) throw new Error("Unable to save daily brief");
  return existing;
}

export async function listBriefs(status?: BriefStatus, limit = 40): Promise<BriefRecord[]> {
  if (storageMode() === "memory") {
    return [...memory.values()]
      .filter((entry) => !status || entry.status === status)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map(cloneMemory);
  }
  await ensureSchema();
  const result = status
    ? await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs WHERE status = $1 ORDER BY brief_date DESC LIMIT $2`, [status, limit])
    : await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs ORDER BY brief_date DESC LIMIT $1`, [limit]);
  return result.rows.map(rowToRecord);
}

export async function getBrief(id: string): Promise<BriefRecord | null> {
  if (storageMode() === "memory") return memory.has(id) ? cloneMemory(memory.get(id)!) : null;
  await ensureSchema();
  const result = await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs WHERE id = $1`, [id]);
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

export async function getBriefByDate(date: string): Promise<BriefRecord | null> {
  if (storageMode() === "memory") {
    const entry = [...memory.values()].find((candidate) => candidate.date === date);
    return entry ? cloneMemory(entry) : null;
  }
  await ensureSchema();
  const result = await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs WHERE brief_date = $1`, [date]);
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

export async function getLatestPublished(): Promise<BriefRecord | null> {
  if (storageMode() === "memory") {
    const latest = [...memory.values()].filter((entry) => entry.status === "published").sort((a, b) => b.date.localeCompare(a.date))[0];
    return latest ? cloneMemory(latest) : null;
  }
  await ensureSchema();
  const result = await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs WHERE status = 'published' ORDER BY brief_date DESC LIMIT 1`);
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

export async function updateDraft(id: string, brief: DailyBrief): Promise<BriefRecord> {
  const current = await getBrief(id);
  if (!current) throw new Error("找不到这份日报");
  if (current.status !== "draft") throw new Error("已发布日报不可直接修改");
  if (storageMode() === "memory") {
    const entry = memory.get(id)!;
    entry.brief = { ...structuredClone(brief), id, status: "draft", storageMode: "memory" };
    entry.updatedAt = new Date().toISOString();
    memory.set(id, entry);
    return cloneMemory(entry);
  }
  const result = await pool().query<DatabaseRow>(`
    UPDATE daily_briefs SET payload = $2::jsonb, updated_at = NOW()
    WHERE id = $1 AND status = 'draft'
    RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
  `, [id, JSON.stringify(brief)]);
  if (!result.rows[0]) throw new Error("日报更新失败");
  return rowToRecord(result.rows[0]);
}

export async function publishBrief(id: string, brief: DailyBrief, pdf: Buffer): Promise<BriefRecord> {
  const now = new Date().toISOString();
  if (storageMode() === "memory") {
    const entry = memory.get(id);
    if (!entry) throw new Error("找不到这份日报");
    entry.status = "published";
    entry.publishedAt = now;
    entry.updatedAt = now;
    entry.pdf = pdf;
    entry.hasPdf = true;
    entry.brief = { ...structuredClone(brief), id, status: "published", publishedAt: now, storageMode: "memory" };
    memory.set(id, entry);
    return cloneMemory(entry);
  }
  await ensureSchema();
  const payload = { ...brief, id, status: "published" as const, publishedAt: now, storageMode: "postgres" as const };
  const result = await pool().query<DatabaseRow>(`
    UPDATE daily_briefs
      SET status = 'published', payload = $2::jsonb, pdf_data = $3,
          published_at = NOW(), updated_at = NOW()
    WHERE id = $1
    RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
  `, [id, JSON.stringify(payload), pdf]);
  if (!result.rows[0]) throw new Error("发布失败");
  return rowToRecord(result.rows[0]);
}

export async function getPublishedPdf(id: string): Promise<{ pdf: Buffer; date: string } | null> {
  if (storageMode() === "memory") {
    const entry = memory.get(id);
    return entry?.status === "published" && entry.pdf ? { pdf: entry.pdf, date: entry.date } : null;
  }
  await ensureSchema();
  const result = await pool().query<{ pdf_data: Buffer; brief_date: string | Date }>(`SELECT pdf_data, brief_date FROM daily_briefs WHERE id = $1 AND status = 'published' AND pdf_data IS NOT NULL`, [id]);
  return result.rows[0] ? { pdf: result.rows[0].pdf_data, date: dateOnly(result.rows[0].brief_date) } : null;
}

export async function databaseHealth(): Promise<{ mode: "postgres" | "memory"; ok: boolean }> {
  if (storageMode() === "memory") return { mode: "memory", ok: true };
  try {
    await ensureSchema();
    await pool().query("SELECT 1");
    return { mode: "postgres", ok: true };
  } catch {
    return { mode: "postgres", ok: false };
  }
}
