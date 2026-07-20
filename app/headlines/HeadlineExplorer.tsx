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
import {
  equityDirectionPresentation,
  formatReturn,
  headlineDirectionConfidence,
  headlineDirectionPresentation,
  headlineDirectionRationale,
} from "@/lib/market-direction";
import { categoryDisplayNames, sourceDisplayName } from "@/lib/terms";
import { formatBeijingMinute, resolveHeadlineTimestamp, timestampLabel } from "@/lib/time";
import type { Category, DailyBrief, Headline } from "@/lib/types";

function replaceEventInUrl(eventId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("event", eventId);
  window.history.replaceState(null, "", url);
}

function EventRow({ headline, active, onSelect }: { headline: Headline; active: boolean; onSelect: () => void }) {
  const time = resolveHeadlineTimestamp(headline);
  const evidence = headlineEvidence(headline);
  const direction = headlineDirectionPresentation(headline);
  return (
    <button className={`event-row${active ? " is-active" : ""}`} type="button" aria-pressed={active} onClick={onSelect}>
      <span className="event-rank">{String(headline.rank).padStart(2, "0")}</span>
      <span className="event-row-copy">
        <small><b>{headline.ticker}</b>{categoryDisplayNames[headline.category]} · 影响 {headline.impact}/5</small>
        <strong>{headline.title}</strong>
        <span className="event-row-status"><em className={`direction-badge direction-${direction.direction}`}><b aria-hidden="true">{direction.symbol}</b>{direction.compactLabel}</em><em className={`evidence-pill evidence-${evidence.level}`}>{evidence.label}</em><time dateTime={time.value}>{formatBeijingMinute(time.value)}</time></span>
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
    if (window.matchMedia("(max-width: 980px)").matches) {
      window.setTimeout(() => {
        const dossier = document.getElementById("event-dossier");
        if (!dossier) return;
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        dossier.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        dossier.focus({ preventScroll: true });
      }, 0);
    }
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
              <button type="button" aria-pressed={activeCategory === "All"} className={activeCategory === "All" ? "is-active" : ""} onClick={() => filterCategory("All")}>全部</button>
              {categories.map((category) => <button type="button" aria-pressed={activeCategory === category} className={activeCategory === category ? "is-active" : ""} onClick={() => filterCategory(category)} key={category}>{categoryDisplayNames[category]}</button>)}
            </div>
          </div>

          <section className="research-layout">
            <aside className="event-index" id="event-index" aria-label="市场事件列表">
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
  const equityImpacts = (headline.equityImpacts ?? []).filter((item) => item.reviewStatus !== "rejected");
  const direction = headlineDirectionPresentation(headline);
  const directionConfidence = headlineDirectionConfidence(headline);

  return (
    <article className="event-dossier" id="event-dossier" tabIndex={-1} aria-labelledby={`event-title-${headline.id}`} key={headline.id}>
      <a className="mobile-back-to-list" href="#event-index">← 返回事件列表</a>
      <header className="dossier-header">
        <div className="dossier-kicker">
          <span>排名 {String(headline.rank).padStart(2, "0")}</span>
          <b>{headline.ticker}</b>
          <span>{categoryDisplayNames[headline.category]}</span>
          <em className={`direction-badge direction-${direction.direction}`}><b aria-hidden="true">{direction.symbol}</b>{direction.label}</em>
        </div>
        <h2 id={`event-title-${headline.id}`}>{headline.title}</h2>
        <p>{headline.summary}</p>
        <div className="dossier-time"><Clock3 size={17} /><span>{timestampLabel(eventTime.kind)}</span><time dateTime={eventTime.value}>{formatBeijingMinute(eventTime.value)}</time><small>北京时间 · {eventTime.source ? sourceDisplayName(eventTime.source) : "来源待确认"}</small></div>
      </header>

      <section className="decision-strip" aria-label="事件判断指标">
        <div className={`decision-direction direction-${direction.direction}`}><span>事件潜在方向</span><strong><b aria-hidden="true">{direction.symbol}</b>{direction.label}</strong></div>
        <div><Gauge size={17} /><span>市场影响</span><strong>{headline.impact}/5</strong></div>
        <div><ShieldCheck size={17} /><span>资料可信度</span><strong>{headline.confidence}%</strong></div>
        <div><Activity size={17} /><span>时效分数</span><strong>{headline.freshnessScore ?? "—"}</strong></div>
        <div><Layers3 size={17} /><span>来源层级</span><strong>{layers}</strong></div>
      </section>

      <section className={`dossier-direction direction-${direction.direction}`} aria-label="方向判断依据">
        <div><span>方向证据强度</span><strong>{directionConfidence}%</strong><small>不是上涨或下跌概率</small></div>
        <p>{headlineDirectionRationale(headline)}</p>
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

      {equityImpacts.length ? <section className="dossier-section equity-impact-dossier">
        <header><Activity size={18} /><div><span>新闻 → 美国股票</span><h3>预期传导与实际行情</h3></div><small>只显示数据库中可验证的股票</small></header>
        <div className="equity-impact-grid">
          {equityImpacts.map((item) => {
            const itemDirection = equityDirectionPresentation(item.direction);
            const context = item.marketContext;
            return <article className={`equity-impact-card equity-${item.direction}`} key={item.symbol}>
            <div className="equity-impact-card-head"><b>{item.symbol}</b><span>{item.companyName}</span><em>关联可信度 {item.mappingConfidence}% · 方向证据 {item.directionConfidence ?? "—"}%</em></div>
            <div className="equity-thesis-panel">
              <small>事件推演</small>
              <strong><b aria-hidden="true">{itemDirection.symbol}</b>{itemDirection.label}</strong>
              <span>新闻可能如何传导，不是价格预测</span>
            </div>
            <p>{item.mechanism}</p>
            <dl>
              <div><dt>关系</dt><dd>{item.relation === "issuer" ? "新闻主体" : item.relation === "supplier" ? "供应链" : item.relation === "customer" ? "客户" : item.relation === "competitor" ? "竞争者" : item.relation === "sector_peer" ? "同业" : "宏观暴露"}</dd></div>
            </dl>
            {context?.return1dPct !== undefined ? <section className="equity-realized-block" aria-label={`${item.symbol} 实际行情，截至 ${context.asOf}`}>
              <header><span>市场已发生</span><small>截至 {context.asOf}{context.lastPrice !== undefined ? ` · $${context.lastPrice.toFixed(2)}` : ""}{context.freshness === "stale" ? " · 资料偏旧" : context.freshness === "missing" ? " · 资料过期" : ""}</small></header>
              <div className="equity-returns">
                <span className={context.return1dPct > 0 ? "return-up" : context.return1dPct < 0 ? "return-down" : "return-flat"}><small>实际 1 日</small><b>{context.return1dPct > 0 ? "↑" : context.return1dPct < 0 ? "↓" : "—"} {formatReturn(context.return1dPct)}</b></span>
                <span className={(context.return5dPct ?? 0) > 0 ? "return-up" : (context.return5dPct ?? 0) < 0 ? "return-down" : "return-flat"}><small>实际 5 日</small><b>{(context.return5dPct ?? 0) > 0 ? "↑" : (context.return5dPct ?? 0) < 0 ? "↓" : "—"} {formatReturn(context.return5dPct)}</b></span>
                {context.volumeVs20d !== undefined && <span><small>成交量／20 日均量</small><b>{context.volumeVs20d.toFixed(2)}×</b></span>}
              </div>
            </section> : <section className="equity-realized-block is-unavailable"><header><span>市场已发生</span><small>暂无事件发生前的可用行情</small></header></section>}
            <footer><span>反向情景</span><p>{item.counterCase}</p></footer>
          </article>})}
        </div>
        <p className="equity-method-note">“潜在利好／利空”是新闻传导判断；“实际 1 日／5 日”来自事件发生当日或之前的行情。两者并列展示，但实际涨跌不证明由这则新闻造成。</p>
      </section> : null}

      <section className="dossier-section evidence-section">
        <header><Globe2 size={18} /><div><span>EVIDENCE LEDGER</span><h3>证据与原始来源</h3></div></header>
        <div className="evidence-ledger">
          {sources.map((source, index) => (
            <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}>
              <span className={`source-tier source-${source.type.toLowerCase()}`}>{sourceTypeLabel(source.type)}</span>
              <div><strong>{sourceDisplayName(source.name)}</strong><small>{source.publishedAt ? `${timestampLabel(source.timestampKind ?? "published")} · ${formatBeijingMinute(source.publishedAt)}` : "原始时间未提供"}</small></div>
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
