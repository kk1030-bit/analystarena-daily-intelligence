"use client";

import Link from "next/link";
import { Check, FileDown, KeyRound, LoaderCircle, LogOut, PencilLine, Plus, Radar, Save, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BriefRecord, Category, DailyBrief, Headline, HeadlineClaim, MarketDirection } from "@/lib/types";
import { categoryDisplayNames, extractTermNotes } from "@/lib/terms";
import { fromBeijingDateTimeInput, toBeijingDateTimeInput } from "@/lib/time";

const categories: Category[] = ["Macro", "AI", "Semiconductor", "Crypto", "ETF", "Earnings", "Geopolitics", "Other"];
const directionOptions: Array<{ value: MarketDirection; label: string }> = [
  { value: "bullish", label: "潜在利好 ↑" },
  { value: "bearish", label: "潜在利空 ↓" },
  { value: "mixed", label: "多空并存 ↕" },
  { value: "neutral", label: "方向待确认 —" },
];

function authHeaders(token: string, json = false): HeadersInit {
  return { "x-admin-token": token, ...(json ? { "Content-Type": "application/json" } : {}) };
}

interface ManualConfirmation {
  headlineId: string;
  claimKey: string;
  method: "manual_semantic_review";
}

function pendingAiClaims(headline: Headline): HeadlineClaim[] {
  return (headline.claims ?? []).filter((claim) =>
    claim.generator === "ai" && claim.verificationStatus === "pending_confirmation");
}

function claimDisplayName(claim: HeadlineClaim): string {
  if (claim.claimKey === "title") return "标题";
  if (claim.claimKey === "summary") return "摘要";
  if (claim.claimKey === "market_impact") return "市场影响";
  if (claim.claimKey === "direction_rationale") return "方向依据";
  if (claim.claimKey.startsWith("important_information:")) return "重要信息";
  return claim.claimKey;
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
  const [manualConfirmations, setManualConfirmations] = useState<ManualConfirmation[]>([]);

  const hasChanges = useMemo(() => Boolean(selected && draft
    && (JSON.stringify(selected.brief) !== JSON.stringify(draft) || manualConfirmations.length)),
  [selected, draft, manualConfirmations.length]);

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
      if (!response.ok || !data.admin) throw new Error(data.error || "管理密码不正确");
      sessionStorage.setItem("analystarena-admin-token", nextToken);
      setToken(nextToken);
      setRecords(data.records ?? []);
      setStorage(data.storageMode ?? "memory");
      const first = data.records?.[0] ?? null;
      setSelected(first);
      setDraft(first ? structuredClone(first.brief) : null);
      setManualConfirmations([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登入失败");
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
    setManualConfirmations([]);
  }

  function choose(record: BriefRecord) {
    setSelected(record);
    setDraft(structuredClone(record.brief));
    setManualConfirmations([]);
    setMessage("");
  }

  function updateHeadline(id: string, changes: Partial<Headline>) {
    if (!draft) return;
    // Any edit may change the meaning of one or more generated assertions.
    // Clear the whole event's confirmations and require a fresh active review.
    setManualConfirmations((current) => current.filter((item) => item.headlineId !== id));
    setDraft({ ...draft, headlines: draft.headlines.map((headline) => headline.id === id ? { ...headline, ...changes } : headline) });
  }

  function toggleManualConfirmation(headlineId: string, claimKey: string, checked: boolean) {
    setManualConfirmations((current) => {
      const retained = current.filter((item) => !(item.headlineId === headlineId && item.claimKey === claimKey));
      return checked ? [...retained, { headlineId, claimKey, method: "manual_semantic_review" }] : retained;
    });
  }

  function isManuallyConfirmed(headlineId: string, claimKey: string): boolean {
    return manualConfirmations.some((item) => item.headlineId === headlineId && item.claimKey === claimKey);
  }

  function reviewEquityImpact(headlineId: string, symbol: string, reviewStatus: "approved" | "rejected") {
    const headline = draft?.headlines.find((item) => item.id === headlineId);
    if (!headline?.equityImpacts) return;
    updateHeadline(headlineId, {
      equityImpacts: headline.equityImpacts.map((item) => item.symbol === symbol ? { ...item, reviewStatus } : item),
    });
  }

  async function generateDraft() {
    setBusy(true);
    setMessage("正在启动浏览器自动采集（Playwright）、事件合并、自动翻译与人工智能（AI）分析，可能需要 1–3 分钟…");
    try {
      const response = await fetch("/api/briefs/generate", {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({ useAi: true, useBrowserCollectors: true }),
      });
      const data = await response.json() as BriefRecord & { error?: string };
      if (!response.ok) throw new Error(data.error || "生成草稿失败");
      await reload(data.id);
      setMessage(`已生成 ${data.date} 草稿，请逐条审核后再发布。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成草稿失败");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!selected || !draft) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/briefs/${selected.id}`, {
        method: "PATCH",
        headers: authHeaders(token, true),
        body: JSON.stringify({ brief: draft, manualConfirmations }),
      });
      const data = await response.json() as BriefRecord & { error?: string };
      if (!response.ok) throw new Error(data.error || "保存失败");
      await reload(data.id);
      setMessage("修改已保存。这份日报仍是草稿。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!selected || !draft || !window.confirm("发布后会成为首页正式日报并建立不可变的历史 PDF。确定发布？")) return;
    setBusy(true);
    try {
      if (hasChanges) {
        const saveResponse = await fetch(`/api/briefs/${selected.id}`, {
          method: "PATCH",
          headers: authHeaders(token, true),
          body: JSON.stringify({ brief: draft, manualConfirmations }),
        });
        const saveData = await saveResponse.json() as BriefRecord & { error?: string };
        if (!saveResponse.ok) throw new Error(saveData.error || "发布前保存失败");
      }
      const response = await fetch(`/api/briefs/${selected.id}/publish`, { method: "POST", headers: authHeaders(token) });
      const data = await response.json() as BriefRecord & { error?: string };
      if (!response.ok) throw new Error(data.error || "发布失败");
      await reload(data.id);
      setMessage("日报已正式发布，首页与历史 PDF 已同步更新。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发布失败");
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    sessionStorage.removeItem("analystarena-admin-token");
    setToken(""); setTokenInput(""); setRecords([]); setSelected(null); setDraft(null); setManualConfirmations([]);
  }

  if (!token) {
    return (
      <main className="review-login">
        <div className="review-login-card">
          <span className="review-logo"><Radar size={25} /></span>
          <small>AnalystArena 人工审核台</small>
          <h1>人工审核入口</h1>
          <p>输入 Render 环境中的管理员密码（ADMIN_TOKEN）。密码只保存在这个浏览器分页的临时存储中。</p>
          <label><span className="visually-hidden">管理员密码</span><KeyRound size={15} /><input aria-label="管理员密码" aria-invalid={Boolean(message)} autoComplete="current-password" type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void connect()} placeholder="管理密码" /></label>
          <button className="primary-button" onClick={() => void connect()} disabled={busy || !tokenInput}>{busy ? <LoaderCircle className="is-spinning" size={16} /> : <Check size={16} />}进入审核台</button>
          {message && <p className="review-error" role="alert">{message}</p>}
          <Link href="/">← 返回日报</Link>
        </div>
      </main>
    );
  }

  return (
    <div className="review-shell">
      <header className="review-topbar">
        <Link href="/" className="standalone-brand"><span><Radar size={20} /></span>AnalystArena</Link>
        <div><Link href="/archive">历史 PDF</Link><button onClick={signOut}><LogOut size={15} />退出登录</button></div>
      </header>
      <aside className="review-list">
        <div><small>审核队列</small><h1>日报审核</h1><p className={`storage-pill storage-${storage}`}>{storage === "postgres" ? "PostgreSQL 数据库已连接" : "内存示范模式"}</p></div>
        <button className="primary-button generate-button" onClick={() => void generateDraft()} disabled={busy}><Plus size={16} />生成今日草稿</button>
        <nav>
          {records.map((record) => <button key={record.id} aria-pressed={selected?.id === record.id} className={selected?.id === record.id ? "is-selected" : ""} onClick={() => choose(record)}><span>{record.date}</span><b>{record.status === "published" ? "已发布" : "待审核"}</b><small>{record.brief.headlines.length} 则头条</small></button>)}
          {!records.length && <p>尚无草稿。请生成今天的第一份日报。</p>}
        </nav>
      </aside>
      <main className="review-workspace">
        <div className="review-actions">
          <div><small>{selected?.status === "published" ? "已发布" : "草稿"}</small><h2>{selected ? `${selected.date} 日报` : "选择一份日报"}</h2></div>
          {selected && <div>{selected.hasPdf && <a className="secondary-button" href={`/api/briefs/${selected.id}/pdf`} target="_blank" rel="noreferrer"><FileDown size={15} />PDF</a>}<button className="secondary-button" onClick={() => void save()} disabled={busy || !hasChanges || selected.status !== "draft"}><Save size={15} />保存</button><button className="publish-button" onClick={() => void publish()} disabled={busy || selected.status === "published"}><Send size={15} />发布日报</button></div>}
        </div>
        {message && <div className="review-message" role="status" aria-live="polite">{busy && <LoaderCircle className="is-spinning" size={15} />}{message}</div>}
        {draft ? <section className="review-editor">
          {draft.warning && <div className="review-warning">{draft.warning}</div>}
          {draft.headlines.map((headline) => (
            <article key={headline.id}>
              <header><span>#{headline.rank} · {headline.ticker}</span><div><b>{headline.rankingScore ?? "—"}</b> 排名分数 <PencilLine size={14} /></div></header>
              {pendingAiClaims(headline).length ? <section className="review-ai-confirmations">
                <header><div><strong>人工语义确认</strong><small>引用存在不代表原文支持判断。请逐条核对原文后主动勾选；编辑内容会清除本事件全部确认。</small></div><b>{manualConfirmations.filter((item) => item.headlineId === headline.id).length}/{pendingAiClaims(headline).length}</b></header>
                <div>
                  {pendingAiClaims(headline).map((claim) => <label key={claim.claimKey}>
                    <input
                      type="checkbox"
                      checked={isManuallyConfirmed(headline.id, claim.claimKey)}
                      disabled={selected?.status === "published"}
                      onChange={(event) => toggleManualConfirmation(headline.id, claim.claimKey, event.target.checked)}
                    />
                    <span><b>{claimDisplayName(claim)}</b><small>{claim.statement}</small></span>
                  </label>)}
                </div>
              </section> : null}
              {(headline.termNotes?.length || extractTermNotes(headline).length) ? <div className="term-notes">
                <span>自动术语说明：</span>
                {(headline.termNotes?.length ? headline.termNotes : extractTermNotes(headline)).map((item) => <em key={item.term}><b>{item.term}</b>＝{item.note}</em>)}
              </div> : null}
              <label>标题<input value={headline.title} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { title: event.target.value })} /></label>
              <label>摘要<textarea rows={3} value={headline.summary} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { summary: event.target.value })} /></label>
              <div className="review-fields review-time-fields">
                <label>新闻时间（北京时间）<input type="datetime-local" value={toBeijingDateTimeInput(headline.publishedAt)} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { publishedAt: fromBeijingDateTimeInput(event.target.value) })} /></label>
                <label>时间依据<select value={headline.timestampKind ?? "published"} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { timestampKind: event.target.value === "collected" ? "collected" : "published" })}><option value="published">新闻发布时间</option><option value="collected">采集时间</option></select></label>
                <label>时间来源<input value={headline.newsTimeSource ?? headline.sources[0]?.name ?? ""} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { newsTimeSource: event.target.value })} /></label>
              </div>
              <label>重要信息（每行一点）<textarea rows={4} value={(headline.keyPoints ?? []).join("\n")} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { keyPoints: event.target.value.split("\n").map((point) => point.trim()).filter(Boolean).slice(0, 4) })} /></label>
              <div className="review-fields review-direction-fields">
                <label>事件潜在方向<select value={headline.marketDirection ?? (headline.sentiment === "positive" ? "bullish" : headline.sentiment === "negative" ? "bearish" : "neutral")} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { marketDirection: event.target.value as MarketDirection })}>{directionOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
                <label>方向证据强度<input type="number" min="1" max="99" value={headline.directionConfidence ?? 52} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { directionConfidence: Number(event.target.value) })} /></label>
                <label>分类<select value={headline.category} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { category: event.target.value as Category })}>{categories.map((category) => <option key={category} value={category}>{categoryDisplayNames[category]}</option>)}</select></label>
              </div>
              <label>方向判断依据<textarea rows={2} value={headline.directionRationale ?? ""} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { directionRationale: event.target.value })} placeholder="说明为何属于利好、利空、多空并存或待确认" /></label>
              <label>市场影响<textarea rows={3} value={headline.marketImpact} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { marketImpact: event.target.value })} /></label>
              {headline.equityImpacts?.length ? <section className="review-equity-impacts">
                <header><span>新闻关联美股</span><small>请确认传导理由；映射可信度不是上涨概率</small></header>
                {headline.equityImpacts.map((item) => <div className={`review-equity-row review-equity-${item.reviewStatus}`} key={item.symbol}>
                  <b>{item.symbol}</b><p><strong>{item.companyName} · {item.direction === "potential_upside" ? "潜在受益 ↑" : item.direction === "potential_downside" ? "潜在承压 ↓" : item.direction === "mixed" ? "多空并存 ↕" : "方向待确认 —"}</strong><span>{item.mechanism}</span></p><em>关联 {item.mappingConfidence}%<br />方向 {item.directionConfidence ?? "—"}%</em>
                  <div><button type="button" disabled={selected?.status === "published"} aria-pressed={item.reviewStatus === "approved"} onClick={() => reviewEquityImpact(headline.id, item.symbol, "approved")}>批准</button><button type="button" disabled={selected?.status === "published"} aria-pressed={item.reviewStatus === "rejected"} onClick={() => reviewEquityImpact(headline.id, item.symbol, "rejected")}>驳回</button></div>
                </div>)}
              </section> : null}
              <div className="review-fields review-score-fields"><label>市场影响<input type="number" min="1" max="5" value={headline.impact} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { impact: Number(event.target.value) })} /></label><label>资料可信度<input type="number" min="1" max="99" value={headline.confidence} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { confidence: Number(event.target.value) })} /></label></div>
            </article>
          ))}
        </section> : <div className="review-empty">从左侧选择草稿，或生成今日草稿开始审核。</div>}
      </main>
    </div>
  );
}
