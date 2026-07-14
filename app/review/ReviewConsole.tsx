"use client";

import Link from "next/link";
import { Check, FileDown, KeyRound, LoaderCircle, LogOut, PencilLine, Plus, Radar, Save, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BriefRecord, Category, DailyBrief, Headline } from "@/lib/types";

const categories: Category[] = ["Macro", "AI", "Semiconductor", "Crypto", "ETF", "Earnings", "Geopolitics", "Other"];

function authHeaders(token: string, json = false): HeadersInit {
  return { "x-admin-token": token, ...(json ? { "Content-Type": "application/json" } : {}) };
}

export function ReviewConsole() {
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [records, setRecords] = useState<BriefRecord[]>([]);
  const [selected, setSelected] = useState<BriefRecord | null>(null);
  const [draft, setDraft] = useState<DailyBrief | null>(null);
  const [storage, setStorage] = useState<"postgres" | "memory">("memory");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const hasChanges = useMemo(() => Boolean(selected && draft && JSON.stringify(selected.brief) !== JSON.stringify(draft)), [selected, draft]);

  useEffect(() => {
    const existing = sessionStorage.getItem("analystarena-admin-token") ?? "";
    if (existing) void connect(existing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(nextToken = tokenInput) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/briefs", { headers: authHeaders(nextToken), cache: "no-store" });
      const data = await response.json() as { records?: BriefRecord[]; storageMode?: "postgres" | "memory"; admin?: boolean; error?: string };
      if (!response.ok || !data.admin) throw new Error(data.error || "管理密碼不正確");
      sessionStorage.setItem("analystarena-admin-token", nextToken);
      setToken(nextToken);
      setRecords(data.records ?? []);
      setStorage(data.storageMode ?? "memory");
      const first = data.records?.[0] ?? null;
      setSelected(first);
      setDraft(first ? structuredClone(first.brief) : null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  }

  async function reload(selectId?: string) {
    const response = await fetch("/api/briefs", { headers: authHeaders(token), cache: "no-store" });
    const data = await response.json() as { records: BriefRecord[]; storageMode: "postgres" | "memory" };
    setRecords(data.records ?? []);
    setStorage(data.storageMode ?? "memory");
    const next = data.records.find((record) => record.id === selectId) ?? data.records[0] ?? null;
    setSelected(next);
    setDraft(next ? structuredClone(next.brief) : null);
  }

  function choose(record: BriefRecord) {
    setSelected(record);
    setDraft(structuredClone(record.brief));
    setMessage("");
  }

  function updateHeadline(id: string, changes: Partial<Headline>) {
    if (!draft) return;
    setDraft({ ...draft, headlines: draft.headlines.map((headline) => headline.id === id ? { ...headline, ...changes } : headline) });
  }

  async function generateDraft() {
    setBusy(true);
    setMessage("正在啟動 Playwright 蒐集、事件合併與 AI 分析，可能需要 1–3 分鐘…");
    try {
      const response = await fetch("/api/briefs/generate", {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({ useAi: true, useBrowserCollectors: true }),
      });
      const data = await response.json() as BriefRecord & { error?: string };
      if (!response.ok) throw new Error(data.error || "產生草稿失敗");
      await reload(data.id);
      setMessage(`已產生 ${data.date} 草稿，請逐則審核後再發布。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "產生草稿失敗");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!selected || !draft) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/briefs/${selected.id}`, { method: "PATCH", headers: authHeaders(token, true), body: JSON.stringify({ brief: draft }) });
      const data = await response.json() as BriefRecord & { error?: string };
      if (!response.ok) throw new Error(data.error || "儲存失敗");
      await reload(data.id);
      setMessage("修改已儲存。這份日報仍是草稿。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!selected || !draft || !window.confirm("發布後會成為首頁正式日報並建立不可變的歷史 PDF。確定發布？")) return;
    setBusy(true);
    try {
      if (hasChanges) {
        const saveResponse = await fetch(`/api/briefs/${selected.id}`, { method: "PATCH", headers: authHeaders(token, true), body: JSON.stringify({ brief: draft }) });
        const saveData = await saveResponse.json() as BriefRecord & { error?: string };
        if (!saveResponse.ok) throw new Error(saveData.error || "發布前儲存失敗");
      }
      const response = await fetch(`/api/briefs/${selected.id}/publish`, { method: "POST", headers: authHeaders(token) });
      const data = await response.json() as BriefRecord & { error?: string };
      if (!response.ok) throw new Error(data.error || "發布失敗");
      await reload(data.id);
      setMessage("日報已正式發布，首頁與歷史 PDF 已同步更新。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "發布失敗");
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    sessionStorage.removeItem("analystarena-admin-token");
    setToken(""); setTokenInput(""); setRecords([]); setSelected(null); setDraft(null);
  }

  if (!token) {
    return (
      <main className="review-login">
        <div className="review-login-card">
          <span className="review-logo"><Radar size={25} /></span>
          <small>ANALYSTARENA REVIEW DESK</small>
          <h1>人工審核入口</h1>
          <p>輸入 Render 環境中的 ADMIN_TOKEN。密碼只保存在這個分頁的 sessionStorage。</p>
          <label><KeyRound size={15} /><input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void connect()} placeholder="管理密碼" /></label>
          <button className="primary-button" onClick={() => void connect()} disabled={busy || !tokenInput}>{busy ? <LoaderCircle className="is-spinning" size={16} /> : <Check size={16} />}進入審核台</button>
          {message && <p className="review-error">{message}</p>}
          <Link href="/">← 返回日報</Link>
        </div>
      </main>
    );
  }

  return (
    <div className="review-shell">
      <header className="review-topbar">
        <Link href="/" className="standalone-brand"><span><Radar size={20} /></span>AnalystArena</Link>
        <div><Link href="/archive">歷史 PDF</Link><button onClick={signOut}><LogOut size={15} />登出</button></div>
      </header>
      <aside className="review-list">
        <div><small>REVIEW QUEUE</small><h1>日報審核</h1><p className={`storage-pill storage-${storage}`}>{storage === "postgres" ? "PostgreSQL 已連線" : "記憶體示範模式"}</p></div>
        <button className="primary-button generate-button" onClick={() => void generateDraft()} disabled={busy}><Plus size={16} />產生今日草稿</button>
        <nav>
          {records.map((record) => <button key={record.id} className={selected?.id === record.id ? "is-selected" : ""} onClick={() => choose(record)}><span>{record.date}</span><b>{record.status === "published" ? "已發布" : "待審核"}</b><small>{record.brief.headlines.length} 則頭條</small></button>)}
          {!records.length && <p>尚無草稿。請產生今天的第一份日報。</p>}
        </nav>
      </aside>
      <main className="review-workspace">
        <div className="review-actions">
          <div><small>{selected?.status === "published" ? "PUBLISHED" : "DRAFT"}</small><h2>{selected ? `${selected.date} 日報` : "選擇一份日報"}</h2></div>
          {selected && <div>{selected.hasPdf && <a className="secondary-button" href={`/api/briefs/${selected.id}/pdf`} target="_blank" rel="noreferrer"><FileDown size={15} />PDF</a>}<button className="secondary-button" onClick={() => void save()} disabled={busy || !hasChanges || selected.status !== "draft"}><Save size={15} />儲存</button><button className="publish-button" onClick={() => void publish()} disabled={busy || selected.status === "published"}><Send size={15} />發布日報</button></div>}
        </div>
        {message && <div className="review-message">{busy && <LoaderCircle className="is-spinning" size={15} />}{message}</div>}
        {draft ? <section className="review-editor">
          {draft.warning && <div className="review-warning">{draft.warning}</div>}
          {draft.headlines.map((headline) => (
            <article key={headline.id}>
              <header><span>#{headline.rank} · {headline.ticker}</span><div><b>{headline.rankingScore ?? "—"}</b> ranking score <PencilLine size={14} /></div></header>
              <label>標題<input value={headline.title} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { title: event.target.value })} /></label>
              <label>摘要<textarea rows={3} value={headline.summary} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { summary: event.target.value })} /></label>
              <label>市場影響<textarea rows={3} value={headline.marketImpact} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { marketImpact: event.target.value })} /></label>
              <div className="review-fields"><label>分類<select value={headline.category} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { category: event.target.value as Category })}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>影響<input type="number" min="1" max="5" value={headline.impact} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { impact: Number(event.target.value) })} /></label><label>信心<input type="number" min="1" max="99" value={headline.confidence} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { confidence: Number(event.target.value) })} /></label></div>
            </article>
          ))}
        </section> : <div className="review-empty">從左側選擇草稿，或產生今日草稿開始審核。</div>}
      </main>
    </div>
  );
}
