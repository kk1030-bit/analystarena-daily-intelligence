"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileCheck2,
  Gauge,
  Globe2,
  Layers3,
  ListChecks,
  MessageCircle,
  Newspaper,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ResearchMobileDock, ResearchSidebar } from "@/app/ResearchNavigation";
import {
  affectedScopes,
  flattenSignals,
  headlineEvidence,
  headlineRiskFlags,
  resolveSignalHeadline,
  signalStrength,
  sortedSources,
  sourceTypeLabel,
} from "@/lib/investor-view";
import { categoryDisplayNames, sourceDisplayName } from "@/lib/terms";
import { formatTaipeiMinute, resolveHeadlineTimestamp, timestampLabel } from "@/lib/time";
import type { Category, DailyBrief, Headline, Sentiment } from "@/lib/types";

const sentimentLabels: Record<Sentiment, string> = { positive: "偏多", neutral: "中性", negative: "偏空" };

function replaceEventInUrl(eventId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("event", eventId);
  window.history.replaceState(null, "", url);
}

function EventRow({ headline, active, onSelect }: { headline: Headline; active: boolean; onSelect: () => void }) {
  const time = resolveHeadlineTimestamp(headline);
  const evidence = headlineEvidence(headline);
  return (
    <button className={`event-row${active ? " is-active" : ""}`} type="button" aria-pressed={active} onClick={onSelect}>
      <span className="event-rank">{String(headline.rank).padStart(2, "0")}</span>
      <span className="event-row-copy">
        <small><b>{headline.ticker}</b>{categoryDisplayNames[headline.category]} · {formatTaipeiMinute(time.value)}</small>
        <strong>{headline.title}</strong>
        <em className={`evidence-pill evidence-${evidence.level}`}>{evidence.label}</em>
      </span>
      <ChevronRight size={17} aria-hidden="true" />
    </button>
  );
}

export function HeadlineExplorer({ brief, initialEvent, context, contextBatch }: { brief: DailyBrief; initialEvent?: string; context?: "trending"; contextBatch?: string }) {
  const contextQuery = context === "trending" ? `?context=trending${contextBatch ? `&batch=${encodeURIComponent(contextBatch)}` : ""}` : "";
  const ordered = useMemo(() => [...brief.headlines].sort((left, right) => left.rank - right.rank), [brief.headlines]);
  const categories = useMemo(() => Array.from(new Set(ordered.map((headline) => headline.category))), [ordered]);
  const requestedEventMissing = Boolean(initialEvent && !ordered.some((headline) => headline.id === initialEvent));
  const initialId = initialEvent ? (requestedEventMissing ? undefined : initialEvent) : ordered[0]?.id;
  const [activeCategory, setActiveCategory] = useState<Category | "All">("All");
  const [selectedId, setSelectedId] = useState(initialId);
  const [linkMissing, setLinkMissing] = useState(requestedEventMissing);
  const visible = activeCategory === "All" ? ordered : ordered.filter((headline) => headline.category === activeCategory);
  const selected = linkMissing ? undefined : ordered.find((headline) => headline.id === selectedId) ?? visible[0] ?? ordered[0];

  const allSignals = useMemo(() => flattenSignals(brief), [brief]);
  const relatedSignals = selected
    ? allSignals.filter((entry) => resolveSignalHeadline(entry.topic, ordered)?.id === selected.id)
    : [];

  function selectHeadline(id: string) {
    setLinkMissing(false);
    setSelectedId(id);
    replaceEventInUrl(id);
  }

  function filterCategory(category: Category | "All") {
    setActiveCategory(category);
    const next = category === "All" ? ordered[0] : ordered.find((headline) => headline.category === category);
    if (next && (category !== "All" || !selected)) selectHeadline(next.id);
  }

  const verifiedCount = ordered.filter((headline) => headlineEvidence(headline).level === "official").length;
  const multiSourceCount = ordered.filter((headline) => (headline.crossSourceCount ?? new Set(headline.sources.map((source) => source.type)).size) >= 2).length;

  return (
    <div className="app-shell research-shell">
      <a className="skip-link" href="#event-dossier">跳至事件研究</a>
      <ResearchSidebar active="headlines" brief={brief} context={context} contextBatch={contextBatch} />
      <main className="main-canvas research-main">
        <header className="topbar">
          <Link className="mobile-brand" href="/"><Radar size={20} /><span>AnalystArena</span></Link>
          <div className="breadcrumb"><span>市场情报</span><b>/</b><strong>事件研究台</strong></div>
          <div className="topbar-actions">
            <Link className="secondary-button" href={`/signals${contextQuery}`}><MessageCircle size={16} />查看社交信号</Link>
            <Link className="primary-button" href="/"><ArrowRight size={16} />返回今日简报</Link>
          </div>
        </header>

        <div className="research-wrap">
          <section className="research-hero">
            <div>
              <span><Newspaper size={16} /> EVENT RESEARCH · 事件研究</span>
              <h1>市场头条<br /><em>不是标题列表</em></h1>
              <p>点开每项事件，直接判断事实、证据、市场传导与下一步确认点。</p>
            </div>
            <div className="research-hero-metrics" aria-label="事件研究摘要">
              <div><small>本期事件</small><strong>{ordered.length}</strong><span>按市场影响排序</span></div>
              <div><small>官方来源</small><strong>{verifiedCount}</strong><span>包含第一手资料</span></div>
              <div><small>跨层验证</small><strong>{multiSourceCount}</strong><span>至少两类来源</span></div>
            </div>
          </section>

          <div className="research-toolbar">
            <div><span>筛选事件</span><strong>先看重要性，再看证据是否充分</strong></div>
            <div className="research-filters" aria-label="事件分类">
              <button type="button" className={activeCategory === "All" ? "is-active" : ""} onClick={() => filterCategory("All")}>全部</button>
              {categories.map((category) => <button type="button" className={activeCategory === category ? "is-active" : ""} onClick={() => filterCategory(category)} key={category}>{categoryDisplayNames[category]}</button>)}
            </div>
          </div>

          <section className="research-layout">
            <aside className="event-index" aria-label="市场事件列表">
              <header><span>影响排序</span><b>{visible.length} 项</b></header>
              <div>
                {visible.map((headline) => <EventRow headline={headline} active={headline.id === selected?.id} onSelect={() => selectHeadline(headline.id)} key={headline.id} />)}
              </div>
            </aside>

            {selected ? <EventDossier brief={brief} headline={selected} relatedSignals={relatedSignals} context={context} contextBatch={contextBatch} /> : <div className="research-empty">{linkMissing ? "此事件链接已过期或不属于当前数据批次，请从左侧重新选择。" : "本期暂无可研究事件。"}</div>}
          </section>
        </div>
      </main>
      <ResearchMobileDock active="headlines" context={context} contextBatch={contextBatch} />
    </div>
  );
}

function EventDossier({ brief, headline, relatedSignals, context, contextBatch }: { brief: DailyBrief; headline: Headline; relatedSignals: ReturnType<typeof flattenSignals>; context?: "trending"; contextBatch?: string }) {
  const eventTime = resolveHeadlineTimestamp(headline);
  const evidence = headlineEvidence(headline);
  const sources = sortedSources(headline);
  const primarySource = sources[0];
  const risks = headlineRiskFlags(headline);
  const watch = brief.watchlist.find((item) => item.category === headline.category);
  const layers = headline.crossSourceCount ?? new Set(headline.sources.map((source) => source.type)).size;

  return (
    <article className="event-dossier" id="event-dossier" key={headline.id}>
      <header className="dossier-header">
        <div className="dossier-kicker">
          <span>排名 {String(headline.rank).padStart(2, "0")}</span>
          <b>{headline.ticker}</b>
          <span>{categoryDisplayNames[headline.category]}</span>
          <em className={`sentiment sentiment-${headline.sentiment}`}>{sentimentLabels[headline.sentiment]}</em>
        </div>
        <h2>{headline.title}</h2>
        <p>{headline.summary}</p>
        <div className="dossier-time"><Clock3 size={17} /><span>{timestampLabel(eventTime.kind)}</span><time dateTime={eventTime.value}>{formatTaipeiMinute(eventTime.value)}</time><small>台北时间 · {eventTime.source ? sourceDisplayName(eventTime.source) : "来源待确认"}</small></div>
      </header>

      <section className="decision-strip" aria-label="事件判断指标">
        <div><Gauge size={17} /><span>市场影响</span><strong>{headline.impact}/5</strong></div>
        <div><ShieldCheck size={17} /><span>系统信心</span><strong>{headline.confidence}%</strong></div>
        <div><Activity size={17} /><span>时效分数</span><strong>{headline.freshnessScore ?? "—"}</strong></div>
        <div><Layers3 size={17} /><span>来源层级</span><strong>{layers}</strong></div>
      </section>

      <div className={`evidence-banner evidence-${evidence.level}`}>
        {evidence.level === "official" ? <CheckCircle2 size={19} /> : <ShieldAlert size={19} />}
        <div><strong>{evidence.label}</strong><span>{evidence.detail}</span></div>
      </div>

      <div className="dossier-grid">
        <section className="dossier-section dossier-facts">
          <header><ListChecks size={18} /><div><span>KNOWN FACTS</span><h3>目前已知事实</h3></div></header>
          <ol>
            {(headline.keyPoints?.length ? headline.keyPoints : [headline.summary]).map((point, index) => <li key={`${headline.id}-fact-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{point}</p></li>)}
          </ol>
        </section>

        <section className="dossier-section transmission-card">
          <header><Target size={18} /><div><span>MARKET TRANSMISSION</span><h3>市场如何传导</h3></div></header>
          <p>{headline.marketImpact}</p>
          <div className="scope-list" aria-label="可能受影响的观察范围">
            <small>可能受影响的观察范围</small>
            <div>{affectedScopes(headline).map((scope) => <span key={scope}>{scope}</span>)}</div>
          </div>
        </section>
      </div>

      <section className="dossier-section evidence-section">
        <header><Globe2 size={18} /><div><span>EVIDENCE LEDGER</span><h3>证据与原始来源</h3></div></header>
        <div className="evidence-ledger">
          {sources.map((source, index) => (
            <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}>
              <span className={`source-tier source-${source.type.toLowerCase()}`}>{sourceTypeLabel(source.type)}</span>
              <div><strong>{sourceDisplayName(source.name)}</strong><small>{source.publishedAt ? `${timestampLabel(source.timestampKind ?? "published")} · ${formatTaipeiMinute(source.publishedAt)}` : "原始时间未提供"}</small></div>
              <ExternalLink size={16} />
            </a>
          ))}
        </div>
      </section>

      <div className="dossier-grid dossier-bottom-grid">
        <section className="dossier-section next-step-card">
          <header><FileCheck2 size={18} /><div><span>NEXT CONFIRMATION</span><h3>投资人下一步</h3></div></header>
          <div className="next-step-list">
            <div><b>01</b><p><strong>先读最高可信来源</strong><span>{primarySource ? `${sourceTypeLabel(primarySource.type)} · ${sourceDisplayName(primarySource.name)}` : "本期尚无可用来源"}</span></p>{primarySource && <a href={primarySource.url} target="_blank" rel="noreferrer">打开 <ExternalLink size={13} /></a>}</div>
            <div><b>02</b><p><strong>跟踪下一项确认点</strong><span>{watch ? `${watch.event}：${watch.why}` : "等待公司、监管机构或主流新闻后续更新"}</span></p></div>
            <div><b>03</b><p><strong>先检查证据缺口</strong><span>{risks.join("；")}</span></p></div>
          </div>
        </section>

        <section className="dossier-section related-signal-card">
          <header><MessageCircle size={18} /><div><span>RELATED SIGNALS</span><h3>关联社交信号</h3></div></header>
          {relatedSignals.length ? <div className="related-signal-list">
            {relatedSignals.map((entry) => <Link href={`/signals?platform=${entry.platform.toLowerCase()}&signal=${encodeURIComponent(entry.id)}${context === "trending" ? `&context=trending${contextBatch ? `&batch=${encodeURIComponent(contextBatch)}` : ""}` : ""}`} key={entry.id}><span>{entry.platform}</span><strong>{entry.topic.label}</strong><small>信号强度 {signalStrength(entry.topic)}</small><ChevronRight size={15} /></Link>)}
          </div> : <div className="no-related-signal"><Sparkles size={18} /><p><strong>暂无高置信关联</strong><span>这代表本期没有足够明确的社交线索，不会为了填满版面而强行匹配。</span></p></div>}
        </section>
      </div>

      <footer className="research-disclaimer"><ShieldCheck size={15} />本页提供事件研究与来源查证，不构成投资建议或买卖指令。</footer>
    </article>
  );
}
