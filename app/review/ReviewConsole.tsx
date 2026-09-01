"use client";

import Link from "next/link";
import { Check, FileDown, KeyRound, LoaderCircle, LogOut, PencilLine, Plus, Radar, Save, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BriefRecord, Category, DailyBrief, Headline, HeadlineClaim, MarketDirection } from "@/lib/types";
import { normalizePublicationIssues } from "@/lib/publication-issues";
import type { PublicationIssueDisplay } from "@/lib/publication-issues";
import { categoryDisplayNames, extractTermNotes } from "@/lib/terms";
import { toBeijingDateTimeInput } from "@/lib/time";
import {
  defaultMaintainedEvidenceVersionIds,
  type ManualEditedClaimSupport,
} from "@/lib/review-evidence";

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

function pendingClaims(headline: Headline): HeadlineClaim[] {
  return (headline.claims ?? []).filter((claim) =>
    claim.verificationStatus === "pending_confirmation");
}

function confirmableAiClaims(headline: Headline): HeadlineClaim[] {
  return (headline.claims ?? []).filter((claim) =>
    claim.generator === "ai" && claim.verificationStatus === "pending_confirmation");
}

function claimDisplayNameByKey(claimKey: string): string {
  if (claimKey === "title") return "标题";
  if (claimKey === "summary") return "摘要";
  if (claimKey === "market_impact") return "市场影响";
  if (claimKey === "direction_rationale") return "方向依据";
  if (claimKey.startsWith("important_information:")) return "重要信息";
  return claimKey;
}

function claimDisplayName(claim: HeadlineClaim): string {
  return claimDisplayNameByKey(claim.claimKey);
}

interface EvidenceReviewClaim {
  headlineId: string;
  headlineRank: number;
  headline: Headline;
  claimKey: string;
  previousClaim?: HeadlineClaim;
  statement: string;
  changed: boolean;
  removed: boolean;
}

function managedClaimChanged(previous: Headline, reviewed: Headline, claimKey: string): {
  changed: boolean;
  removed: boolean;
} {
  if (claimKey === "title") return { changed: previous.title !== reviewed.title, removed: false };
  if (claimKey === "summary") return { changed: previous.summary !== reviewed.summary, removed: false };
  if (claimKey === "market_impact") {
    return {
      changed: previous.marketImpact !== reviewed.marketImpact
        || previous.category !== reviewed.category
        || previous.impact !== reviewed.impact
        || previous.confidence !== reviewed.confidence
        || previous.marketDirection !== reviewed.marketDirection
        || previous.directionConfidence !== reviewed.directionConfidence
        || previous.directionRationale !== reviewed.directionRationale,
      removed: false,
    };
  }
  if (claimKey === "direction_rationale") {
    const nextValue = reviewed.directionRationale?.trim() ?? "";
    return {
      changed: (previous.directionRationale?.trim() ?? "") !== nextValue
        || previous.marketDirection !== reviewed.marketDirection
        || previous.directionConfidence !== reviewed.directionConfidence,
      removed: !nextValue,
    };
  }
  const important = claimKey.match(/^important_information:(\d+)$/);
  if (important) {
    const index = Number(important[1]);
    const next = reviewed.keyPoints?.[index];
    return {
      changed: (previous.keyPoints?.[index] ?? "") !== (next ?? ""),
      removed: !next,
    };
  }
  return { changed: false, removed: false };
}

function evidenceReviewCandidates(
  previous: DailyBrief | undefined,
  reviewed: DailyBrief | null,
): EvidenceReviewClaim[] {
  if (!previous || !reviewed) return [];
  const reviewedById = new Map(reviewed.headlines.map((headline) => [headline.id, headline]));
  return previous.headlines.flatMap((headline) => {
    const next = reviewedById.get(headline.id);
    if (!next) return [];
    const previousClaims = new Map((headline.claims ?? []).map((claim) => [claim.claimKey, claim]));
    const points = Array.from(
      { length: Math.max(headline.keyPoints?.length ?? 0, next.keyPoints?.length ?? 0) },
      (_, index) => ({
        claimKey: `important_information:${index}`,
        statement: next.keyPoints?.[index] ?? "",
      }),
    );
    const fields = [
      { claimKey: "title", statement: next.title },
      { claimKey: "summary", statement: next.summary },
      ...points,
      { claimKey: "market_impact", statement: next.marketImpact },
      ...(headline.directionRationale || next.directionRationale
        ? [{ claimKey: "direction_rationale", statement: next.directionRationale ?? "" }]
        : []),
    ];
    return fields.map(({ claimKey, statement }) => {
      const change = managedClaimChanged(headline, next, claimKey);
      return {
        headlineId: headline.id,
        headlineRank: headline.rank,
        headline,
        claimKey,
        previousClaim: previousClaims.get(claimKey),
        statement,
        changed: change.changed,
        removed: change.removed,
      };
    });
  });
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
  const [publicationIssues, setPublicationIssues] = useState<PublicationIssueDisplay[]>([]);
  const [selectedEvidenceByClaim, setSelectedEvidenceByClaim] = useState<Record<string, string[]>>({});
  const [maintainedEvidenceClaims, setMaintainedEvidenceClaims] = useState<string[]>([]);
  const [evidenceReviewConfirmed, setEvidenceReviewConfirmed] = useState(false);
  const [evidenceReviewNote, setEvidenceReviewNote] = useState("");

  const hasChanges = useMemo(() => Boolean(selected && draft
    && (JSON.stringify(selected.brief) !== JSON.stringify(draft)
      || manualConfirmations.length
      || maintainedEvidenceClaims.length)),
  [selected, draft, manualConfirmations.length, maintainedEvidenceClaims.length]);
  const needsAuditRebase = Boolean(
    selected?.status === "draft"
    && selected.brief.headlines.some((headline) => !headline.whatChanged),
  );
  const evidenceCandidates = useMemo(
    () => evidenceReviewCandidates(selected?.brief, draft),
    [selected?.brief, draft],
  );
  const evidenceReviews = useMemo(
    () => evidenceCandidates.filter((item) =>
      item.changed
      || maintainedEvidenceClaims.includes(
        `${item.headlineId}\u0000${item.claimKey}`,
      )),
    [evidenceCandidates, maintainedEvidenceClaims],
  );

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
      setPublicationIssues([]);
      setSelectedEvidenceByClaim({});
      setMaintainedEvidenceClaims([]);
      setEvidenceReviewConfirmed(false);
      setEvidenceReviewNote("");
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
    setPublicationIssues([]);
    setSelectedEvidenceByClaim({});
    setMaintainedEvidenceClaims([]);
    setEvidenceReviewConfirmed(false);
    setEvidenceReviewNote("");
  }

  function choose(record: BriefRecord) {
    setSelected(record);
    setDraft(structuredClone(record.brief));
    setManualConfirmations([]);
    setPublicationIssues([]);
    setSelectedEvidenceByClaim({});
    setMaintainedEvidenceClaims([]);
    setEvidenceReviewConfirmed(false);
    setEvidenceReviewNote("");
    setMessage("");
  }

  function updateHeadline(id: string, changes: Partial<Headline>) {
    if (!draft) return;
    // Any edit may change the meaning of one or more generated assertions.
    // Clear the whole event's confirmations and require a fresh active review.
    setManualConfirmations((current) => current.filter((item) => item.headlineId !== id));
    setSelectedEvidenceByClaim((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(`${id}\u0000`)),
    ));
    setMaintainedEvidenceClaims((current) =>
      current.filter((key) => !key.startsWith(`${id}\u0000`)));
    setEvidenceReviewConfirmed(false);
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

  function evidenceSelectionKey(headlineId: string, claimKey: string): string {
    return `${headlineId}\u0000${claimKey}`;
  }

  function toggleEvidenceSupport(
    headlineId: string,
    claimKey: string,
    evidenceVersionId: string,
    checked: boolean,
  ) {
    const key = evidenceSelectionKey(headlineId, claimKey);
    setSelectedEvidenceByClaim((current) => {
      const selected = new Set(current[key] ?? []);
      if (checked) selected.add(evidenceVersionId);
      else selected.delete(evidenceVersionId);
      return { ...current, [key]: [...selected] };
    });
    setEvidenceReviewConfirmed(false);
  }

  function toggleEvidenceMaintenance(item: EvidenceReviewClaim) {
    const key = evidenceSelectionKey(item.headlineId, item.claimKey);
    const active = maintainedEvidenceClaims.includes(key);
    setMaintainedEvidenceClaims((current) =>
      active ? current.filter((candidate) => candidate !== key) : [...current, key]);
    setSelectedEvidenceByClaim((current) => {
      if (active) {
        return Object.fromEntries(
          Object.entries(current).filter(([candidate]) => candidate !== key),
        );
      }
      const existing = defaultMaintainedEvidenceVersionIds(
        item.headline,
        item.previousClaim,
      );
      return { ...current, [key]: existing };
    });
    setEvidenceReviewConfirmed(false);
  }

  function reviewMutationBody() {
    const note = evidenceReviewNote.trim();
    if (evidenceReviews.length) {
      if (!evidenceReviewConfirmed) {
        throw new Error("请先确认声明证据的保留、新增与撤下范围");
      }
      if (note.length < 8) {
        throw new Error("请填写至少 8 个字的证据审核说明，说明选择或撤下这些来源的理由");
      }
    }
    const manualEditedClaimSupports: ManualEditedClaimSupport[] = evidenceReviews
      .filter((item) => !item.removed)
      .map((item) => {
        const selected = selectedEvidenceByClaim[
          evidenceSelectionKey(item.headlineId, item.claimKey)
        ] ?? [];
        return {
          headlineId: item.headlineId,
          claimKey: item.claimKey,
          evidenceVersionIds: selected,
          method: "manual_evidence_rebind",
          note,
        };
      });
    return {
      brief: draft,
      manualConfirmations,
      manualEditedClaimSupports,
      evidenceReviewConfirmed,
      evidenceReviewNote: note,
    };
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
        body: JSON.stringify(reviewMutationBody()),
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

  async function rebaseAuditChain() {
    if (!selected || selected.status !== "draft") return;
    setBusy(true);
    setMessage("正在为旧草稿建立可稽核的版本比较，请稍候…");
    try {
      const response = await fetch(`/api/briefs/${selected.id}/rebase`, {
        method: "POST",
        headers: authHeaders(token),
      });
      const data = await response.json() as BriefRecord & { error?: string };
      if (!response.ok) throw new Error(data.error || "审核链升级失败");
      await reload(data.id);
      setMessage("审核链已升级。旧端点只标记为历史未验证，不会伪造昨日差异。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "审核链升级失败");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!selected || !draft || !window.confirm("发布后会成为首页正式日报并建立不可变的历史 PDF。确定发布？")) return;
    if (needsAuditRebase) {
      setMessage("这份旧草稿尚未建立 What Changed 审核链，请先点击“升级审核链”。");
      return;
    }
    setBusy(true);
    try {
      let reviewedSnapshotId = selected.brief.snapshot?.id;
      let reviewedPayloadHash = selected.brief.snapshot?.payloadHash;
      if (hasChanges) {
        const saveResponse = await fetch(`/api/briefs/${selected.id}`, {
          method: "PATCH",
          headers: authHeaders(token, true),
          body: JSON.stringify(reviewMutationBody()),
        });
        const saveData = await saveResponse.json() as BriefRecord & { error?: string };
        if (!saveResponse.ok) throw new Error(saveData.error || "发布前保存失败");
        setRecords((current) => current.map((record) => record.id === saveData.id ? saveData : record));
        setSelected(saveData);
        setDraft(structuredClone(saveData.brief));
        setManualConfirmations([]);
        reviewedSnapshotId = saveData.brief.snapshot?.id;
        reviewedPayloadHash = saveData.brief.snapshot?.payloadHash;
      }
      if (!reviewedSnapshotId || !reviewedPayloadHash) {
        throw new Error("当前草稿没有可发布的审核快照，请先刷新或升级审核链。");
      }
      const response = await fetch(`/api/briefs/${selected.id}/publish`, {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({
          expectedSnapshotId: reviewedSnapshotId,
          expectedPayloadHash: reviewedPayloadHash,
        }),
      });
      const data = await response.json() as BriefRecord & { error?: string; issues?: unknown };
      if (!response.ok) {
        setPublicationIssues(normalizePublicationIssues(data.issues));
        throw new Error(data.error || "发布失败");
      }
      setPublicationIssues([]);
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
    setToken(""); setTokenInput(""); setRecords([]); setSelected(null); setDraft(null); setManualConfirmations([]); setPublicationIssues([]);
    setSelectedEvidenceByClaim({}); setMaintainedEvidenceClaims([]); setEvidenceReviewConfirmed(false); setEvidenceReviewNote("");
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
          {selected && <div>{selected.hasPdf && <a className="secondary-button" href={`/api/briefs/${selected.id}/pdf`} target="_blank" rel="noreferrer"><FileDown size={15} />PDF</a>}{needsAuditRebase && <button className="secondary-button" onClick={() => void rebaseAuditChain()} disabled={busy}><Radar size={15} />升级审核链</button>}<button className="secondary-button" onClick={() => void save()} disabled={busy || !hasChanges || selected.status !== "draft"}><Save size={15} />保存</button><button className="publish-button" onClick={() => void publish()} disabled={busy || selected.status === "published" || needsAuditRebase}><Send size={15} />发布日报</button></div>}
        </div>
        {needsAuditRebase && <div className="review-warning" role="alert">这份草稿建立于 What Changed 上线前。请先升级审核链；系统会新增不可变快照，并把无法证明的旧差异标记为“历史未验证”。</div>}
        {message && <div className="review-message" role="status" aria-live="polite">{busy && <LoaderCircle className="is-spinning" size={15} />}{message}</div>}
        {publicationIssues.length ? <section className="review-publication-issues" role="alert" aria-live="assertive">
          <header><strong>发布核验未通过</strong><span>{publicationIssues.length} 项</span></header>
          <p>系统没有生成 PDF，也没有改变日报发布状态。请依照以下数据库权威核验结果修复后重试。</p>
          <ol>
            {publicationIssues.map((issue, index) => <li key={`${issue.code}:${issue.headlineId ?? "brief"}:${issue.claimKey ?? "none"}:${index}`}>
              <b>{issue.headlineRank ? `头条 #${issue.headlineRank}` : "日报级"}</b>
              <code>{issue.code}</code>
              {issue.claimKey ? <em>{issue.claimKey}</em> : null}
              <span>{issue.message}</span>
              {issue.headlineId ? <small>事件 ID：{issue.headlineId}</small> : null}
            </li>)}
          </ol>
        </section> : null}
        {draft ? <section className="review-editor">
          {draft.warning && <div className="review-warning">{draft.warning}</div>}
          {evidenceReviews.length ? <section className="review-evidence-rebind" role="group" aria-labelledby="evidence-rebind-title">
            <header>
              <div>
                <strong id="evidence-rebind-title">声明证据维护与重绑</strong>
                <small>可从该事件保存的全部精确证据中选择。文字改变时不会自动沿用旧引用；未选择的旧引用会以“人工驳回”写入不可变撤证记录，新增选择则建立新的精确支持关系。</small>
              </div>
              <b>{evidenceReviews.length} 项判断</b>
            </header>
            <div className="review-evidence-rebind-list">
              {evidenceReviews.map((item) => {
                const key = evidenceSelectionKey(item.headlineId, item.claimKey);
                const selectedIds = new Set(selectedEvidenceByClaim[key] ?? []);
                const currentCitations = item.previousClaim?.citations ?? [];
                const currentCitationByVersionId = new Map(currentCitations
                  .filter((citation) => citation.versionId)
                  .map((citation) => [citation.versionId!, citation]));
                const retainedByDefault = new Set(defaultMaintainedEvidenceVersionIds(
                  item.headline,
                  item.previousClaim,
                ));
                const citationsRemovedByDefault = currentCitations.filter((citation) =>
                  !citation.versionId
                  || !retainedByDefault.has(citation.versionId)
                  || citation.relation !== "supports"
                  || citation.confidence <= 0
                  || citation.locatorStatus !== "exact"
                  || citation.directness !== "direct");
                const evidenceOptions = item.removed
                  ? item.previousClaim?.citations ?? []
                  : item.headline.sources.flatMap((source) => source.evidence ?? [])
                    .filter((evidence) =>
                      evidence.versionId
                      && evidence.sourceDocumentVersionId
                      && evidence.locatorStatus === "exact"
                      && evidence.directness === "direct")
                    .filter((evidence, index, all) =>
                      all.findIndex((candidate) =>
                        candidate.versionId === evidence.versionId) === index);
                return <article key={key}>
                  <div className="review-evidence-rebind-heading">
                    <span>头条 #{item.headlineRank}</span>
                    <strong>{claimDisplayNameByKey(item.claimKey)}</strong>
                    <small>{item.removed
                      ? "这项判断已删除，以下旧引用将全部撤下。"
                      : item.changed
                        ? "判断已改变，请从该事件的全部精确来源中重新选择。"
                        : "正在维护未改文字的引用；可撤下错误引用或加入同事件的新证据。"}</small>
                    {!item.changed && <button type="button" onClick={() => toggleEvidenceMaintenance(item)}>取消维护</button>}
                  </div>
                  {!item.removed && <p className="review-evidence-statement">{item.statement}</p>}
                  <div className="review-evidence-options">
                    {evidenceOptions.map((evidence) => {
                      const source = item.headline.sources.find((candidate) =>
                        candidate.sourceDocumentId === evidence.sourceDocumentId);
                      const versionId = evidence.versionId;
                      const currentCitation = versionId
                        ? currentCitationByVersionId.get(versionId)
                        : undefined;
                      const currentRelation = currentCitation?.relation === "supports"
                        ? "当前支持"
                        : currentCitation?.relation === "contradicts"
                          ? "当前反证（默认撤下）"
                          : currentCitation?.relation === "context"
                            ? "当前背景（默认撤下）"
                            : "";
                      const quote = evidence.quoteZhCn || evidence.quoteOriginal || "该证据版本没有可显示的引文，请打开原始来源核对。";
                      return <label key={`${evidence.id}:${versionId ?? "legacy"}`}>
                        {!item.removed && <input
                          type="checkbox"
                          checked={Boolean(versionId && selectedIds.has(versionId))}
                          disabled={selected?.status === "published" || !versionId}
                          onChange={(event) => versionId && toggleEvidenceSupport(
                            item.headlineId,
                            item.claimKey,
                            versionId,
                            event.target.checked,
                          )}
                        />}
                        <span>
                          <b>{source?.name ?? evidence.sourceDocumentId}{currentRelation ? ` · ${currentRelation}` : ""}</b>
                          <small>{quote}</small>
                          {source?.url && <a href={source.url} target="_blank" rel="noreferrer">打开原始来源</a>}
                          {currentCitation && currentCitation.relation !== "supports"
                            && <em>此旧关系不会自动转为支持；只有主动勾选并确认审核后，才会建立新的支持关系。</em>}
                          {!versionId && <em>旧资料没有不可变证据版本，必须先升级审核链。</em>}
                        </span>
                      </label>;
                    })}
                    {!evidenceOptions.length && <p className="review-evidence-empty">该事件目前没有可供人工重绑的精确、直接证据。可以保存为待确认，但发布前必须重新采集并补证。</p>}
                  </div>
                  {citationsRemovedByDefault.length ? <div className="review-evidence-excluded" role="note">
                    <strong>以下旧关系默认撤下，不会转成支持证据</strong>
                    <ul>
                      {citationsRemovedByDefault.map((citation, index) => {
                        const source = item.headline.sources.find((candidate) =>
                          candidate.sourceDocumentId === citation.sourceDocumentId);
                        const relation = citation.relation === "contradicts"
                          ? "反证"
                          : citation.relation === "context"
                            ? "背景"
                            : "非精确／非直接支持";
                        return <li key={`${citation.id}:${citation.versionId ?? "legacy"}:${citation.relation}:${index}`}>
                          <b>{relation}</b>
                          <span>{source?.name ?? citation.sourceDocumentId}</span>
                          <small>{citation.quoteZhCn || citation.quoteOriginal || "没有可显示的引文"}</small>
                        </li>;
                      })}
                    </ul>
                  </div> : null}
                </article>;
              })}
            </div>
            <label className="review-evidence-note">
              证据审核说明
              <textarea
                rows={3}
                value={evidenceReviewNote}
                disabled={selected?.status === "published"}
                onChange={(event) => {
                  setEvidenceReviewNote(event.target.value);
                  setEvidenceReviewConfirmed(false);
                }}
                placeholder="例如：已逐条核对原文；保留或新增的引用直接支持当前判断，撤下的引用不再适用。"
              />
            </label>
            <label className="review-evidence-confirm">
              <input
                type="checkbox"
                checked={evidenceReviewConfirmed}
                disabled={selected?.status === "published"}
                onChange={(event) => setEvidenceReviewConfirmed(event.target.checked)}
              />
              <span>我已核对以上原文，并确认保留、新增与撤下的证据范围。</span>
            </label>
          </section> : null}
          {draft.headlines.map((headline) => (
            <article key={headline.id}>
              <header><span>#{headline.rank} · {headline.ticker}</span><div><b>{headline.rankingScore ?? "—"}</b> 排名分数 <PencilLine size={14} /></div></header>
              <details className="review-evidence-maintenance">
                <summary>维护现有判断的引用</summary>
                <p>不必改写文字，也能撤下错误引用或从这个事件已保存的精确证据中补上一条新引用。</p>
                <div>
                  {evidenceCandidates
                    .filter((item) =>
                      item.headlineId === headline.id
                      && !item.changed
                      && !item.removed)
                    .map((item) => {
                      const key = evidenceSelectionKey(item.headlineId, item.claimKey);
                      const active = maintainedEvidenceClaims.includes(key);
                      return <button
                        type="button"
                        key={key}
                        aria-pressed={active}
                        disabled={selected?.status === "published"}
                        onClick={() => toggleEvidenceMaintenance(item)}
                      >
                        {active ? "取消" : "维护"}{claimDisplayNameByKey(item.claimKey)}
                      </button>;
                    })}
                </div>
              </details>
              {pendingClaims(headline).length ? <section className="review-ai-confirmations">
                <header><div><strong>待人工核验的判断</strong><small>引用存在不代表原文支持判断。AI 原文可在未改写时确认；人工新增或已改写但未重绑的文字必须先补证，不能直接发布。</small></div><b>{manualConfirmations.filter((item) => item.headlineId === headline.id).length}/{confirmableAiClaims(headline).length} 已确认</b></header>
                <div>
                  {pendingClaims(headline).map((claim) => {
                    const confirmable = claim.generator === "ai";
                    return <label key={claim.claimKey}>
                    <input
                      type="checkbox"
                      checked={isManuallyConfirmed(headline.id, claim.claimKey)}
                      disabled={selected?.status === "published" || !confirmable}
                      onChange={(event) => toggleManualConfirmation(headline.id, claim.claimKey, event.target.checked)}
                    />
                    <span><b>{claimDisplayName(claim)} · {confirmable ? "可核对原文确认" : "缺少重绑证据"}</b><small>{claim.statement}</small></span>
                  </label>;
                  })}
                </div>
              </section> : null}
              {(headline.termNotes?.length || extractTermNotes(headline).length) ? <div className="term-notes">
                <span>自动术语说明：</span>
                {(headline.termNotes?.length ? headline.termNotes : extractTermNotes(headline)).map((item) => <em key={item.term}><b>{item.term}</b>＝{item.note}</em>)}
              </div> : null}
              <label>标题<input value={headline.title} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { title: event.target.value })} /></label>
              <label>摘要<textarea rows={3} value={headline.summary} disabled={selected?.status === "published"} onChange={(event) => updateHeadline(headline.id, { summary: event.target.value })} /></label>
              <div className="review-fields review-time-fields">
                <label>新闻时间（北京时间）<input type="datetime-local" value={toBeijingDateTimeInput(headline.publishedAt)} readOnly aria-readonly="true" /></label>
                <label>时间依据<input value={(headline.timestampKind ?? "published") === "published" ? "新闻发布时间" : "采集时间"} readOnly aria-readonly="true" /></label>
                <label>时间来源<input value={headline.newsTimeSource ?? headline.sources[0]?.name ?? ""} readOnly aria-readonly="true" /></label>
              </div>
              <p className="review-immutable-note">新闻时间与依据来自不可变来源版本，审核台不会伪造人工时间。发现错误时请重新采集该来源，生成新的来源与事件版本后再审核。</p>
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
