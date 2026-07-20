"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  Eye,
  FileSearch,
  Gauge,
  Globe2,
  Link2,
  MessageCircle,
  Newspaper,
  Radar,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ResearchMobileDock, ResearchSidebar } from "@/app/ResearchNavigation";
import {
  flattenSignals,
  headlineEvidence,
  resolveSignalHeadline,
  signalMetricLabel,
  signalStrength,
  type SignalEntry,
  type SignalPlatform,
} from "@/lib/investor-view";
import {
  equityDirectionPresentation,
  headlineDirectionConfidence,
  headlineDirectionPresentation,
  headlineDirectionRationale,
} from "@/lib/market-direction";
import { categoryDisplayNames, sourceDisplayName } from "@/lib/terms";
import { formatBeijingMinute, resolveHeadlineTimestamp, timestampLabel } from "@/lib/time";
import type { DailyBrief, Headline, MarketDirection, Sentiment } from "@/lib/types";

type PlatformFilter = "all" | "reddit" | "x";
type EvidenceFilter = "all" | "linked" | "pending";

const sentimentLabels: Record<Sentiment, string> = { positive: "偏多", neutral: "中性", negative: "偏空" };

const socialDirection: Record<Sentiment, { direction: MarketDirection; label: string; symbol: "↑" | "↓" | "—" }> = {
  positive: { direction: "bullish", label: "社群偏多", symbol: "↑" },
  neutral: { direction: "neutral", label: "社群中性", symbol: "—" },
  negative: { direction: "bearish", label: "社群偏空", symbol: "↓" },
};

function isVerifiedHeadline(headline: Headline | undefined): headline is Headline {
  return Boolean(headline?.sources.some((source) => source.type === "Official" || source.type === "News"));
}

function signalVerification(headline: Headline | undefined) {
  if (isVerifiedHeadline(headline)) return headlineEvidence(headline);
  return {
    level: "pending" as const,
    label: "尚未验证",
    detail: headline
      ? "虽然已关联到市场事件，但目前仍只有社交来源，等待官方或新闻来源确认。"
      : "这项讨论尚未关联到可信市场事件，请先查看原始讨论并等待官方或新闻来源。",
  };
}

function updateSignalUrl(entry: SignalEntry | undefined, platformFilter: PlatformFilter, evidenceFilter: EvidenceFilter) {
  const url = new URL(window.location.href);
  if (entry) {
    url.searchParams.set("platform", entry.platform.toLowerCase());
    url.searchParams.set("signal", entry.id);
  } else {
    url.searchParams.delete("platform");
    url.searchParams.delete("signal");
  }
  if (platformFilter === "all") url.searchParams.delete("filter");
  else url.searchParams.set("filter", platformFilter);
  if (evidenceFilter === "all") url.searchParams.delete("evidence");
  else url.searchParams.set("evidence", evidenceFilter);
  window.history.replaceState(null, "", url);
}

function signalTimestamp(entry: SignalEntry, brief: DailyBrief) {
  return {
    value: entry.topic.publishedAt ?? brief.generatedAt,
    kind: entry.topic.timestampKind ?? (entry.topic.publishedAt ? "published" as const : "collected" as const),
    fallback: !entry.topic.publishedAt,
  };
}

function signalTimeLabel(kind: "published" | "collected", fallback: boolean): string {
  if (fallback) return "记录时间";
  return kind === "published" ? "原帖发布时间" : "采集时间";
}

function SignalRow({ entry, brief, headline, active, onSelect }: { entry: SignalEntry; brief: DailyBrief; headline?: Headline; active: boolean; onSelect: () => void }) {
  const evidence = signalVerification(headline);
  const discussion = socialDirection[entry.topic.sentiment];
  const timestamp = signalTimestamp(entry, brief);
  return (
    <button className={`signal-row${active ? " is-active" : ""}`} type="button" aria-pressed={active} onClick={onSelect}>
      <span className={`signal-platform signal-platform-${entry.platform.toLowerCase()}`}>{entry.platform === "Reddit" ? "r/" : "X"}</span>
      <span className="signal-row-copy">
        <small>{sourceDisplayName(entry.topic.source ?? entry.platform)} · {formatBeijingMinute(timestamp.value)}</small>
        <strong>{entry.topic.label}</strong>
        <span>
          <em className={`direction-badge direction-${discussion.direction} is-compact`} aria-label={`社群讨论倾向：${discussion.label}，不是价格预测`}><b aria-hidden="true">{discussion.symbol}</b>{discussion.label}</em>
          <em className={`evidence-pill evidence-${evidence.level}`}>{evidence.label}</em>
          <b>强度 {signalStrength(entry.topic)}</b>
        </span>
      </span>
      <ChevronRight size={17} />
    </button>
  );
}

export function SignalExplorer({ brief, initialPlatform, initialFilter, initialEvidence, initialSignal, context, contextBatch }: { brief: DailyBrief; initialPlatform?: string; initialFilter?: string; initialEvidence?: string; initialSignal?: string; context?: "trending"; contextBatch?: string }) {
  const contextQuery = context === "trending" ? `?context=trending${contextBatch ? `&batch=${encodeURIComponent(contextBatch)}` : ""}` : "";
  const signals = useMemo(() => flattenSignals(brief), [brief]);
  const initialPlatformFilter: PlatformFilter = initialFilter === "reddit" || initialFilter === "x" ? initialFilter : "all";
  const initialEvidenceFilter: EvidenceFilter = initialEvidence === "linked" || initialEvidence === "pending" ? initialEvidence : "all";
  const signalPlatform = initialPlatform === "reddit" || initialPlatform === "x" ? initialPlatform : undefined;
  const initialEntry = initialSignal
    ? signals.find((entry) => entry.id === initialSignal && (!signalPlatform || entry.platform.toLowerCase() === signalPlatform))
    : signals[0];
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>(initialPlatformFilter);
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>(initialEvidenceFilter);
  const [selectedId, setSelectedId] = useState(initialEntry?.id);
  const [linkMissing, setLinkMissing] = useState(Boolean(initialSignal && !initialEntry));

  const signalRelations = useMemo(() => new Map(signals.map((entry) => [entry.id, resolveSignalHeadline(entry.topic, brief.headlines)])), [brief.headlines, signals]);
  const filtered = signals.filter((entry) => {
    const platformMatches = platformFilter === "all" || entry.platform.toLowerCase() === platformFilter;
    const verified = isVerifiedHeadline(signalRelations.get(entry.id));
    const evidenceMatches = evidenceFilter === "all" || (evidenceFilter === "linked" ? verified : !verified);
    return platformMatches && evidenceMatches;
  });
  const selected = linkMissing ? undefined : filtered.find((entry) => entry.id === selectedId) ?? filtered[0];
  const selectedHeadline = selected ? signalRelations.get(selected.id) : undefined;

  function selectSignal(entry: SignalEntry) {
    setLinkMissing(false);
    setSelectedId(entry.id);
    updateSignalUrl(entry, platformFilter, evidenceFilter);
    if (window.matchMedia("(max-width: 980px)").matches) {
      window.setTimeout(() => {
        const dossier = document.getElementById("signal-dossier");
        if (!dossier) return;
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        dossier.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        dossier.focus({ preventScroll: true });
      }, 0);
    }
  }

  function choosePlatform(next: PlatformFilter) {
    setPlatformFilter(next);
    const nextEntry = signals.find((entry) => {
      const platformMatches = next === "all" || entry.platform.toLowerCase() === next;
      const verified = isVerifiedHeadline(signalRelations.get(entry.id));
      const evidenceMatches = evidenceFilter === "all" || (evidenceFilter === "linked" ? verified : !verified);
      return platformMatches && evidenceMatches;
    });
    setLinkMissing(false);
    setSelectedId(nextEntry?.id);
    updateSignalUrl(nextEntry, next, evidenceFilter);
  }

  function chooseEvidence(next: EvidenceFilter) {
    setEvidenceFilter(next);
    const nextEntry = signals.find((entry) => {
      const platformMatches = platformFilter === "all" || entry.platform.toLowerCase() === platformFilter;
      const verified = isVerifiedHeadline(signalRelations.get(entry.id));
      const evidenceMatches = next === "all" || (next === "linked" ? verified : !verified);
      return platformMatches && evidenceMatches;
    });
    setLinkMissing(false);
    setSelectedId(nextEntry?.id);
    updateSignalUrl(nextEntry, platformFilter, next);
  }

  const verifiedCount = signals.filter((entry) => isVerifiedHeadline(signalRelations.get(entry.id))).length;
  const pendingCount = signals.length - verifiedCount;
  const crossPlatformCount = new Map<string, Set<SignalPlatform>>();
  for (const entry of signals) {
    const headline = signalRelations.get(entry.id);
    if (!headline) continue;
    const platforms = crossPlatformCount.get(headline.id) ?? new Set<SignalPlatform>();
    platforms.add(entry.platform);
    crossPlatformCount.set(headline.id, platforms);
  }
  const crossPlatformThemes = [...crossPlatformCount.values()].filter((platforms) => platforms.size > 1).length;

  return (
    <div className="app-shell research-shell">
      <a className="skip-link" href="#signal-dossier">跳至信号详情</a>
      <ResearchSidebar active="signals" brief={brief} context={context} contextBatch={contextBatch} />
      <main className="main-canvas research-main">
        <header className="topbar">
          <Link className="mobile-brand" href="/"><Radar size={20} /><span>AnalystArena</span></Link>
          <div className="breadcrumb"><span>市场情报</span><b>/</b><strong>社交信号雷达</strong></div>
          <div className="topbar-actions">
            <Link className="secondary-button" href={`/headlines${contextQuery}`}><Newspaper size={16} />查看市场头条</Link>
            <Link className="primary-button" href="/"><ArrowRight size={16} />返回今日简报</Link>
          </div>
        </header>

        <div className="research-wrap signal-research-wrap">
          <section className="research-hero signal-hero">
            <div>
              <span><ScanSearch size={16} /> SOCIAL RADAR · 社交雷达</span>
              <h1>找异常<br /><em>不把热度当事实</em></h1>
              <p>先发现讨论升温，再检查原帖、可信来源与关联市场事件。</p>
            </div>
            <div className="research-hero-metrics" aria-label="社交信号摘要">
              <div><small>本批信号</small><strong>{signals.length}</strong><span>保留原帖与时间</span></div>
              <div><small>已验证信号</small><strong>{verifiedCount}</strong><span>有官方或新闻支持</span></div>
              <div><small>跨平台主题</small><strong>{crossPlatformThemes}</strong><span>Reddit 与 X 同时出现</span></div>
              <div><small>等待验证</small><strong>{pendingCount}</strong><span>不强行匹配</span></div>
            </div>
          </section>

          <div className="signal-principle"><ShieldCheck size={18} /><p><strong>事实边界：</strong>社交讨论负责发现线索，官方与新闻来源负责确认事实；“信号强度”综合可取得的互动量、排序估算与时效，不是价格涨幅或历史环比。</p></div>

          <div className="research-toolbar signal-toolbar">
            <div className="research-filters" aria-label="平台筛选">
              <button type="button" aria-pressed={platformFilter === "all"} className={platformFilter === "all" ? "is-active" : ""} onClick={() => choosePlatform("all")}>全部平台</button>
              <button type="button" aria-pressed={platformFilter === "reddit"} className={platformFilter === "reddit" ? "is-active" : ""} onClick={() => choosePlatform("reddit")}>Reddit</button>
              <button type="button" aria-pressed={platformFilter === "x"} className={platformFilter === "x" ? "is-active" : ""} onClick={() => choosePlatform("x")}>X</button>
            </div>
            <div className="research-filters" aria-label="证据筛选">
              <button type="button" aria-pressed={evidenceFilter === "all"} className={evidenceFilter === "all" ? "is-active" : ""} onClick={() => chooseEvidence("all")}>全部状态</button>
              <button type="button" aria-pressed={evidenceFilter === "linked"} className={evidenceFilter === "linked" ? "is-active" : ""} onClick={() => chooseEvidence("linked")}>已验证</button>
              <button type="button" aria-pressed={evidenceFilter === "pending"} className={evidenceFilter === "pending" ? "is-active" : ""} onClick={() => chooseEvidence("pending")}>尚未验证</button>
            </div>
          </div>

          <section className="research-layout signal-layout">
            <aside className="event-index signal-index" id="signal-index" aria-label="社交信号列表">
              <header><span>异常信号</span><b>{filtered.length} 项</b></header>
              <div>
                {filtered.map((entry) => <SignalRow entry={entry} brief={brief} headline={signalRelations.get(entry.id)} active={entry.id === selected?.id} onSelect={() => selectSignal(entry)} key={entry.id} />)}
                {!filtered.length && <p className="filter-empty">这个筛选条件下没有信号。</p>}
              </div>
            </aside>
            {selected ? <SignalDossier brief={brief} entry={selected} headline={selectedHeadline} context={context} contextBatch={contextBatch} /> : <div className="research-empty">{linkMissing ? "此信号链接已过期或不属于当前数据批次，请从左侧重新选择。" : "当前筛选没有可分析的社交信号。"}</div>}
          </section>
        </div>
      </main>
      <ResearchMobileDock active="signals" context={context} contextBatch={contextBatch} />
    </div>
  );
}

function SignalDossier({ brief, entry, headline, context, contextBatch }: { brief: DailyBrief; entry: SignalEntry; headline?: Headline; context?: "trending"; contextBatch?: string }) {
  const topic = entry.topic;
  const timestamp = signalTimestamp(entry, brief);
  const strength = signalStrength(topic);
  const evidence = signalVerification(headline);
  const eventEvidence = headline ? headlineEvidence(headline) : undefined;
  const eventTime = headline ? resolveHeadlineTimestamp(headline) : undefined;
  const trustedSourceCount = headline?.sources.filter((source) => source.type === "Official" || source.type === "News").length ?? 0;
  const eventSourceLayers = headline ? (headline.crossSourceCount ?? new Set(headline.sources.map((source) => source.type)).size) : 0;
  const verified = isVerifiedHeadline(headline);
  const discussion = socialDirection[topic.sentiment];
  const eventDirection = headline ? headlineDirectionPresentation(headline) : undefined;
  const eventDirectionConfidence = headline ? headlineDirectionConfidence(headline) : undefined;
  const equityImpacts = verified
    ? (headline.equityImpacts ?? [])
      .filter((item) => item.reviewStatus !== "rejected")
      .filter((item) => item.direction === "potential_upside" || item.direction === "potential_downside")
      .filter((item) => Math.min(item.mappingConfidence, item.directionConfidence ?? item.mappingConfidence) >= 60)
      .sort((left, right) => {
        const leftConfidence = Math.min(left.mappingConfidence, left.directionConfidence ?? left.mappingConfidence);
        const rightConfidence = Math.min(right.mappingConfidence, right.directionConfidence ?? right.mappingConfidence);
        return rightConfidence - leftConfidence;
      })
      .slice(0, 2)
    : [];

  return (
    <article className="event-dossier signal-dossier" id="signal-dossier" tabIndex={-1} aria-labelledby={`signal-title-${entry.id}`} key={entry.id}>
      <a className="mobile-back-to-list" href="#signal-index">← 返回信号列表</a>
      <header className="dossier-header signal-dossier-header">
        <div className="dossier-kicker">
          <span className={`signal-platform signal-platform-${entry.platform.toLowerCase()}`}>{entry.platform === "Reddit" ? "r/" : "X"}</span>
          <span>{sourceDisplayName(topic.source ?? entry.platform)}</span>
          <em className={`evidence-pill evidence-${evidence.level}`}>{evidence.label}</em>
          <em className={`sentiment sentiment-${topic.sentiment}`}>{sentimentLabels[topic.sentiment]}</em>
        </div>
        <h2 id={`signal-title-${entry.id}`}>{topic.label}</h2>
        <p>{topic.description ?? "旧版历史记录只保存了主题名称；可查看原始来源或关联事件继续查证。"}</p>
        <div className="dossier-time"><Clock3 size={17} /><span>{signalTimeLabel(timestamp.kind, timestamp.fallback)}</span><time dateTime={timestamp.value}>{formatBeijingMinute(timestamp.value)}</time><small>北京时间{timestamp.fallback ? " · 旧记录未保存原帖时间" : ""}</small></div>
      </header>

      <section className="decision-strip signal-metrics" aria-label="社交信号指标">
        <div><Gauge size={17} /><span>信号强度</span><strong>{strength}</strong></div>
        <div><MessageCircle size={17} /><span>{signalMetricLabel(topic)}</span><strong>{topic.mentions}</strong></div>
        <div><Activity size={17} /><span>社群讨论倾向（非价格预测）</span><strong className={`direction-${discussion.direction}`}>{discussion.symbol} {discussion.label}</strong></div>
        <div><Link2 size={17} /><span>验证状态</span><strong>{verified ? "已验证" : "尚未验证"}</strong></div>
      </section>

      <section className={`dossier-direction direction-${verified && eventDirection ? eventDirection.direction : "neutral"}`} aria-label="社群讨论与关联事件方向">
        <div>
          <span>关联事件潜在方向</span>
          <strong>{verified && eventDirection ? <><b aria-hidden="true">{eventDirection.symbol}</b>{eventDirection.label}</> : <><b aria-hidden="true">—</b>尚未验证</>}</strong>
          <small>{verified && eventDirectionConfidence !== undefined ? `方向证据 ${eventDirectionConfidence}% · 不是实际价格涨跌` : "仅有社群线索或可信来源不足"}</small>
        </div>
        <p><strong className={`direction-${discussion.direction}`}>社群讨论倾向（不是价格预测）：{discussion.symbol} {discussion.label}</strong><br />{verified && headline ? headlineDirectionRationale(headline) : "等待官方或新闻来源后，才判断事件可能如何传导到市场与个股。"}</p>
      </section>

      <div className={`evidence-banner evidence-${evidence.level}`}>
        {verified ? <CheckCircle2 size={19} /> : <ShieldAlert size={19} />}
        <div><strong>{evidence.label}</strong><span>{evidence.detail}</span></div>
      </div>

      <div className="dossier-grid signal-detail-grid">
        <section className="dossier-section signal-origin-card">
          <header><Eye size={18} /><div><span>ORIGINAL SIGNAL</span><h3>原始讨论记录</h3></div></header>
          <dl>
            <div><dt>平台</dt><dd>{entry.platform}</dd></div>
            <div><dt>采集来源</dt><dd>{sourceDisplayName(topic.source ?? entry.platform)}</dd></div>
            <div><dt>时间质量</dt><dd>{timestamp.fallback ? "仅有日报生成时间" : timestamp.kind === "published" ? "已取得原帖发布时间" : "仅确认采集时间"}</dd></div>
            <div><dt>指标口径</dt><dd>{topic.metricKind === "mentions" ? "提及次数" : topic.metricKind === "estimated" ? "来源未提供互动量，使用本批排序估算" : "采集器返回的互动指标"}</dd></div>
          </dl>
          {topic.url ? <a className="origin-link" href={topic.url} target="_blank" rel="noreferrer">打开原始讨论 <ExternalLink size={15} /></a> : <span className="origin-missing">旧版记录未保存原始链接</span>}
        </section>

        <section className="dossier-section boundary-card">
          <header><ShieldAlert size={18} /><div><span>FACT BOUNDARY</span><h3>这项信号能说明什么</h3></div></header>
          <p><strong>可以说明：</strong>这个主题在本批采集结果中具有较高互动、较前排序或较新时效，值得进入查证流程。</p>
          <p><strong>不能说明：</strong>事件已经发生、市场一定上涨或下跌，也不能把互动量当成真实提及次数。</p>
        </section>
      </div>

      <section className="dossier-section linked-event-section">
        <header><Newspaper size={18} /><div><span>LINKED MARKET EVENT</span><h3>关联市场事件</h3></div></header>
        {headline ? <Link className="linked-event-card" href={`/headlines?event=${encodeURIComponent(headline.id)}${context === "trending" ? `&context=trending${contextBatch ? `&batch=${encodeURIComponent(contextBatch)}` : ""}` : ""}`}>
          <span className="linked-event-rank">{String(headline.rank).padStart(2, "0")}</span>
          <div><small>{headline.ticker} · {categoryDisplayNames[headline.category]} · {eventEvidence?.label}</small><strong>{headline.title}</strong><p>{headline.marketImpact}</p><footer>{eventTime && `${timestampLabel(eventTime.kind)} · ${formatBeijingMinute(eventTime.value)}`}<b>打开事件研究 <ArrowRight size={14} /></b></footer></div>
        </Link> : <div className="unlinked-event"><Sparkles size={20} /><div><strong>本期尚无可安全关联的市场事件</strong><p>系统不会只凭“AI”“市场”等泛词强行配对。请先查看原帖，等待官方或新闻来源出现。</p></div></div>}
      </section>

      {equityImpacts.length ? <section className="dossier-section equity-impact-dossier" aria-label="已验证事件关联股票">
        <header><Activity size={18} /><div><span>VERIFIED EVENT → US EQUITIES</span><h3>最多两档潜在受益／承压股票</h3></div><small>新闻传导判断，不是价格预测</small></header>
        <div className="equity-impact-grid">
          {equityImpacts.map((item) => {
            const itemDirection = equityDirectionPresentation(item.direction);
            return <article className={`equity-impact-card equity-${item.direction}`} key={item.symbol}>
              <div className="equity-impact-card-head"><b>{item.symbol}</b><span>{item.companyName}</span><em>关联可信度 {item.mappingConfidence}% · 方向证据 {item.directionConfidence ?? "—"}%</em></div>
              <strong><b aria-hidden="true">{itemDirection.symbol}</b>{itemDirection.label}</strong>
              <p>{item.mechanism}</p>
            </article>;
          })}
        </div>
      </section> : null}

      <section className="dossier-section verification-checklist">
        <header><FileSearch size={18} /><div><span>VERIFICATION PATH</span><h3>验证清单</h3></div></header>
        <div>
          <p className={topic.url ? "is-done" : ""}><span>{topic.url ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}</span><strong>原始讨论</strong><small>{topic.url ? "已保留可访问链接" : "旧记录缺少原始链接"}</small></p>
          <p className={headline ? "is-done" : ""}><span>{headline ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}</span><strong>事件关联</strong><small>{headline ? "已关联本期市场头条" : "尚未找到保守匹配"}</small></p>
          <p className={trustedSourceCount > 0 ? "is-done" : ""}><span>{trustedSourceCount > 0 ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}</span><strong>可信来源</strong><small>{trustedSourceCount > 0 ? `${trustedSourceCount} 个官方或新闻来源` : "等待官方或新闻确认"}</small></p>
          <p className={eventSourceLayers >= 2 ? "is-done" : ""}><span>{eventSourceLayers >= 2 ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}</span><strong>跨层验证</strong><small>{eventSourceLayers >= 2 ? "至少两类来源支持" : "来源层级仍不足"}</small></p>
        </div>
      </section>

      <div className="signal-actions">
        {topic.url && <a className="secondary-button" href={topic.url} target="_blank" rel="noreferrer"><Globe2 size={15} />查看原始讨论</a>}
        {headline && <Link className="primary-button" href={`/headlines?event=${encodeURIComponent(headline.id)}${context === "trending" ? `&context=trending${contextBatch ? `&batch=${encodeURIComponent(contextBatch)}` : ""}` : ""}`}><Newspaper size={15} />查看关联事件</Link>}
      </div>

      <footer className="research-disclaimer"><ShieldCheck size={15} />社交信号仅用于异常发现与研究排序，不构成事实确认、投资建议或买卖指令。</footer>
    </article>
  );
}
