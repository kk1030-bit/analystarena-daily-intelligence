"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Flame,
  Globe2,
  Gauge,
  LayoutDashboard,
  Layers3,
  ListChecks,
  MessageCircle,
  Newspaper,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  Signal,
  Sparkles,
  Timer,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Category, DailyBrief, Headline, Sentiment, SourceType } from "@/lib/types";
import { signalMetricLabel, signalStrength, socialSignalId } from "@/lib/investor-view";
import { categoryDisplayNames as categoryLabels, extractTermNotes, sourceDisplayName } from "@/lib/terms";
import { formatBeijingMinute, resolveHeadlineTimestamp, timestampLabel } from "@/lib/time";

const AUTO_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
const REFRESH_TIMEOUT_MS = 90 * 1_000;

type RefreshOrigin = "manual" | "auto";
type RefreshFallback = "none" | "draft" | "published" | "memory";

const fallbackLabels: Record<Exclude<RefreshFallback, "none">, string> = {
  draft: "数据库今日草稿",
  published: "数据库已发布日报",
  memory: "服务器备用快照",
};

function isDailyBrief(value: unknown): value is DailyBrief {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DailyBrief>;
  return typeof candidate.generatedAt === "string"
    && typeof candidate.date === "string"
    && Array.isArray(candidate.headlines)
    && Boolean(candidate.stats && typeof candidate.stats === "object");
}

function responseErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as { error?: unknown; message?: unknown; code?: unknown };
  const detail = typeof payload.error === "string"
    ? payload.error
    : typeof payload.message === "string"
      ? payload.message
      : null;
  if (!detail) return null;
  return typeof payload.code === "string" ? `${detail}（${payload.code}）` : detail;
}

function refreshFallbackFromHeaders(headers: Headers): RefreshFallback {
  const value = headers.get("X-AnalystArena-Fallback")?.toLowerCase();
  if (value === "draft" || value === "published" || value === "memory") return value;
  return headers.get("X-AnalystArena-Stale") === "1" ? "memory" : "none";
}

function formatCountdown(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const sentimentLabels: Record<Sentiment, string> = {
  positive: "偏多",
  neutral: "中性",
  negative: "偏空",
};

const sourceLabels: Record<SourceType, string> = {
  Official: "官方",
  News: "新闻",
  Reddit: "Reddit",
  X: "X",
};

function ImpactDots({ score }: { score: number }) {
  return (
    <span className="impact-dots" aria-label={`影响分数 ${score} / 5`}>
      {Array.from({ length: 5 }, (_, index) => (
        <i className={index < score ? "is-active" : ""} key={index} />
      ))}
    </span>
  );
}

function SentimentMark({ value }: { value: Sentiment }) {
  const Icon = value === "positive" ? ArrowUpRight : value === "negative" ? ArrowDownRight : ArrowRight;
  return (
    <span className={`sentiment sentiment-${value}`}>
      <Icon size={13} strokeWidth={2.4} /> {sentimentLabels[value]}
    </span>
  );
}

function pulseTime(value?: string) {
  const formatted = formatBeijingMinute(value);
  const match = formatted.match(/(\d{2}:\d{2})$/);
  return match?.[1] ?? "待确认";
}

function sourceLayerCount(headline: Headline) {
  return Math.max(1, headline.crossSourceCount ?? new Set(headline.sources.map((source) => source.type)).size);
}

function liveContextSuffix(contextBatch?: string): string {
  return contextBatch ? `&context=trending&batch=${encodeURIComponent(contextBatch)}` : "";
}

function liveContextQuery(contextBatch?: string): string {
  return contextBatch ? `?context=trending&batch=${encodeURIComponent(contextBatch)}` : "";
}

function liveTrendingHref(contextBatch?: string): string {
  return contextBatch ? `/trending?refresh=${encodeURIComponent(contextBatch)}` : "/trending";
}

function MarketPulse({ headlines, contextBatch }: { headlines: Headline[]; contextBatch?: string }) {
  const topStories = [...headlines]
    .sort((left, right) => left.rank - right.rank)
    .slice(0, 5)
    .sort((left, right) => {
      const leftTime = new Date(resolveHeadlineTimestamp(left).value ?? 0).valueOf();
      const rightTime = new Date(resolveHeadlineTimestamp(right).value ?? 0).valueOf();
      return leftTime - rightTime || left.rank - right.rank;
    });

  return (
    <section className="market-pulse" aria-labelledby="market-pulse-title">
      <header className="pulse-header">
        <div>
          <span><Signal size={15} aria-hidden="true" />过去 24 小时</span>
          <h2 id="market-pulse-title">今日市场冲击带</h2>
        </div>
        <p>节点亮度代表市场影响，来源层级越多，验证基础越完整。</p>
      </header>
      <div className="pulse-track" role="list" aria-label="今日前五大事件时间轴">
        {topStories.map((headline) => {
          const newsTime = resolveHeadlineTimestamp(headline);
          const layers = sourceLayerCount(headline);
          return (
            <a
              className={`pulse-event pulse-impact-${headline.impact} pulse-layers-${Math.min(layers, 4)}`}
              href={`/headlines?event=${encodeURIComponent(headline.id)}${liveContextSuffix(contextBatch)}`}
              key={headline.id}
              role="listitem"
              aria-label={`第 ${headline.rank} 名，${headline.ticker}，${headline.title}`}
            >
              <div className="pulse-meta"><span>排名 {String(headline.rank).padStart(2, "0")}</span><time dateTime={newsTime.value}>{pulseTime(newsTime.value)}</time></div>
              <i className="pulse-node"><span /></i>
              <div className="pulse-copy"><strong>{headline.ticker}</strong><span>{headline.title}</span></div>
              <small><ImpactDots score={headline.impact} />{layers} 类来源<ChevronRight size={14} aria-hidden="true" /></small>
            </a>
          );
        })}
      </div>
      {!topStories.length && <p className="pulse-empty">目前没有可用于建立市场冲击带的事件。</p>}
    </section>
  );
}

function WatchPanel({ items }: { items: DailyBrief["watchlist"] }) {
  return (
    <section className="side-card watch-card" id="watchlist">
      <div className="side-card-heading">
        <div className="icon-box icon-box-gold"><CalendarDays size={18} /></div>
        <div><span>下一交易日</span><h3>明日观察清单</h3></div>
      </div>
      <div className="watch-rail-list">
        {items.map((item, index) => (
          <article key={`${item.event}-${index}`}>
            <div><span>{item.time}</span><small>{categoryLabels[item.category]}</small></div>
            <h4>{item.event}</h4>
            <p>{item.why}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function HeadlineCard({ headline, contextBatch }: { headline: Headline; contextBatch?: string }) {
  const newsTime = resolveHeadlineTimestamp(headline);
  const visibleEquities = (headline.equityImpacts ?? []).filter((item) => item.reviewStatus !== "rejected" && item.mappingConfidence >= 70).slice(0, 3);
  return (
    <article className={`headline-card headline-rank-${headline.rank}`} id={`headline-${headline.id}`}>
      <div className="rank-column">
        <small>排名</small>
        <span>{String(headline.rank).padStart(2, "0")}</span>
        <div />
      </div>
      <div className="headline-body">
        <div className="headline-eyebrow">
          <span className="ticker">{headline.ticker}</span>
          <span>{categoryLabels[headline.category]}</span>
          <SentimentMark value={headline.sentiment} />
        </div>
        <h3>{headline.title}</h3>
        {(headline.termNotes?.length || extractTermNotes(headline).length) ? <div className="term-notes" aria-label="英文术语说明">
          <span>英文术语：</span>
          {(headline.termNotes?.length ? headline.termNotes : extractTermNotes(headline)).map((item) => <em key={item.term}><b>{item.term}</b>＝{item.note}</em>)}
        </div> : null}
        <p className="headline-summary">{headline.summary}</p>
        <div className={`news-time news-time-${newsTime.kind}`}>
          <Clock3 size={17} aria-hidden="true" />
          <span>{timestampLabel(newsTime.kind)}</span>
          <time dateTime={newsTime.value}>{formatBeijingMinute(newsTime.value)}</time>
          <small>北京时间{newsTime.source ? ` · 时间来源：${sourceDisplayName(newsTime.source)}` : ""}</small>
        </div>
        {headline.keyPoints?.length ? <div className="key-facts">
          <div><ListChecks size={16} /><span>重要信息</span></div>
          <ul>{headline.keyPoints.map((point, index) => <li key={`${headline.id}-fact-${index}`}>{point}</li>)}</ul>
        </div> : null}
        <div className="impact-note">
          <span>市场影响</span>
          <p>{headline.marketImpact}</p>
        </div>
        {visibleEquities.length ? <section className="equity-impact-summary" aria-label="新闻关联美股">
          <header><TrendingUp size={16} /><div><span>NEWS → STOCKS</span><strong>潜在受益／承压美股</strong></div><small>映射可信度，不是上涨概率</small></header>
          <div>
            {visibleEquities.map((item) => <a href={`/headlines?event=${encodeURIComponent(headline.id)}${liveContextSuffix(contextBatch)}`} className={`equity-chip equity-${item.direction}`} title={item.mechanism} key={item.symbol}>
              <b>{item.symbol}</b><span>{item.direction === "potential_upside" ? "潜在受益" : item.direction === "potential_downside" ? "潜在承压" : item.direction === "mixed" ? "多空并存" : "方向待确认"}</span><em>{item.mappingConfidence}%</em>
            </a>)}
          </div>
        </section> : null}
        <footer className="headline-footer">
          <div className="source-list" aria-label="信息来源">
            {headline.sources.map((source, index) => (
              <a href={source.url} target="_blank" rel="noreferrer" key={`${source.name}-${index}`}>
                <span>{sourceLabels[source.type]}</span>
                {sourceDisplayName(source.name)}
                <ExternalLink size={11} />
              </a>
            ))}
          </div>
          <div className="score-list">
            <span><ImpactDots score={headline.impact} /> 影响 {headline.impact}/5</span>
            <span><ShieldCheck size={13} /> 信心 {headline.confidence}%</span>
            <span><MessageCircle size={13} /> 讨论 {headline.mentions}</span>
            {headline.freshnessScore !== undefined && <span><Activity size={13} /> 时效 {headline.freshnessScore}</span>}
            {headline.crossSourceCount !== undefined && <span><Globe2 size={13} /> {headline.crossSourceCount} 种来源</span>}
          </div>
        </footer>
        <a className="headline-research-link" href={`/headlines?event=${encodeURIComponent(headline.id)}${liveContextSuffix(contextBatch)}`}>
          <span>打开事件研究</span><small>查看证据层级、影响路径与下一步确认点</small><ArrowRight size={16} />
        </a>
      </div>
    </article>
  );
}

function BuzzPanel({ title, kind, topics, contextBatch }: { title: string; kind: "reddit" | "x"; topics: DailyBrief["socialBuzz"]["reddit"]; contextBatch?: string }) {
  const platform = kind === "reddit" ? "Reddit" : "X";
  return (
    <section className="side-card buzz-card">
      <div className="side-card-heading">
        <div className={`platform-mark platform-${kind}`}>{kind === "reddit" ? "r/" : "X"}</div>
        <div>
          <span>讨论热度</span>
          <h3>{title}</h3>
        </div>
      </div>
      <div className="buzz-list">
        {topics.length ? topics.map((topic, index) => (
          <a className="buzz-row" href={`/signals?platform=${kind}&signal=${encodeURIComponent(socialSignalId(topic, platform, index))}${liveContextSuffix(contextBatch)}`} key={socialSignalId(topic, platform, index)}>
            <span className="buzz-index">0{index + 1}</span>
            <div className="buzz-content">
              <strong>{topic.label}</strong>
              <span>{signalMetricLabel(topic)} {topic.mentions} · <b>信号强度 {signalStrength(topic)}</b></span>
            </div>
            <SentimentMark value={topic.sentiment} />
          </a>
        )) : <p className="empty-note">本次未取得足够的公开讨论信息。</p>}
      </div>
      <a className="buzz-all-link" href={`/signals?filter=${kind}${liveContextSuffix(contextBatch)}`}>查看全部并验证事实 <ArrowRight size={14} /></a>
    </section>
  );
}

export function Dashboard({ initialBrief }: { initialBrief: DailyBrief }) {
  const [brief, setBrief] = useState(initialBrief);
  const [contextBatch, setContextBatch] = useState<string>();
  const [activeCategory, setActiveCategory] = useState<Category | "All">("All");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState(AUTO_REFRESH_INTERVAL_MS / 1_000);
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState(initialBrief.generatedAt);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshOrigin, setRefreshOrigin] = useState<RefreshOrigin | null>(null);
  const [refreshFallback, setRefreshFallback] = useState<RefreshFallback>("none");
  const requestInFlightRef = useRef(false);
  const nextRefreshAtRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);

  const categories = useMemo(() => {
    return Array.from(new Set(brief.headlines.map((headline) => headline.category)));
  }, [brief.headlines]);

  const visibleHeadlines = activeCategory === "All"
    ? brief.headlines
    : brief.headlines.filter((headline) => headline.category === activeCategory);

  const [year, month, day] = brief.date.split("-").map(Number);
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const dateLabel = `${year} 年 ${month} 月 ${day} 日 / 周${weekday}`;
  const generatedParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(brief.generatedAt));
  const generated = Object.fromEntries(generatedParts.map((part) => [part.type, part.value]));
  const generatedLabel = `${generated.year}-${generated.month}-${generated.day} ${generated.hour}:${generated.minute} BJT`;
  const countdownLabel = formatCountdown(secondsUntilRefresh);
  const lastSuccessfulLabel = pulseTime(lastSuccessfulAt);

  const refreshBrief = useCallback(async (origin: RefreshOrigin = "manual") => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    const refreshStartedAt = Date.now();
    setIsRefreshing(true);
    setRefreshOrigin(origin);
    setRefreshError(null);
    if (origin === "manual") setNotice(null);
    const controller = new AbortController();
    activeRequestRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
      const response = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          live: true,
          useAi: true,
          force: origin === "manual",
          intent: origin === "manual" ? "manual-refresh" : "scheduled-refresh",
        }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseErrorMessage(payload) || `更新请求失败（HTTP ${response.status}）`);
      if (!isDailyBrief(payload)) throw new Error(responseErrorMessage(payload) || "服务器没有返回可用的日报内容。");

      const nextBrief = payload;
      const fallback = refreshFallbackFromHeaders(response.headers);
      setBrief(nextBrief);
      setContextBatch(response.headers.get("X-AnalystArena-Batch") ?? undefined);
      setLastSuccessfulAt(nextBrief.generatedAt);
      setRefreshFallback(fallback);

      if (fallback !== "none") {
        setActiveCategory((current) => origin === "manual" || current === "All" || !nextBrief.headlines.some((headline) => headline.category === current) ? "All" : current);
        const source = fallbackLabels[fallback];
        const warning = nextBrief.warning ? ` ${nextBrief.warning}` : "";
        setNotice(`${origin === "manual" ? "手动采集暂未取得新快照" : "自动采集暂未取得新快照"}，已显示${source}（内容时间：${formatBeijingMinute(nextBrief.generatedAt)}）。${warning}`);
      } else if (origin === "manual") {
        setActiveCategory("All");
        setNotice(nextBrief.warning || `手动更新完成：${nextBrief.stats.candidates} 则素材已进入分析流程。`);
      } else {
        setActiveCategory((current) => current === "All" || nextBrief.headlines.some((headline) => headline.category === current) ? current : "All");
        setNotice(nextBrief.warning ? `自动更新完成，但服务端提示：${nextBrief.warning}` : null);
      }
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      const requestLabel = origin === "manual" ? "手动更新" : "自动更新";
      const detail = error instanceof Error ? error.message : "未知错误";
      const message = timedOut
        ? `${requestLabel}超时，已保留当前简报。`
        : `${requestLabel}失败：${detail} 已保留当前简报。`;
      setRefreshError(message);
      setNotice(message);
    } finally {
      window.clearTimeout(timeoutId);
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      requestInFlightRef.current = false;
      setIsRefreshing(false);
      setRefreshOrigin(null);
      nextRefreshAtRef.current = refreshStartedAt + AUTO_REFRESH_INTERVAL_MS;
      setSecondsUntilRefresh(Math.max(0, Math.ceil((nextRefreshAtRef.current - Date.now()) / 1_000)));
    }
  }, []);

  useEffect(() => {
    nextRefreshAtRef.current = Date.now() + AUTO_REFRESH_INTERVAL_MS;

    const tick = () => {
      const remainingMs = nextRefreshAtRef.current - Date.now();
      setSecondsUntilRefresh(Math.max(0, Math.ceil(remainingMs / 1_000)));
      if (remainingMs <= 0 && document.visibilityState === "visible" && !requestInFlightRef.current) {
        void refreshBrief("auto");
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };

    tick();
    // Start with the shared server snapshot immediately; the zero-delay task is
    // cancellable so React Strict Mode does not fire two mount refreshes.
    const initialRefreshId = window.setTimeout(() => void refreshBrief("auto"), 0);
    const intervalId = window.setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearTimeout(initialRefreshId);
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      activeRequestRef.current?.abort();
    };
  }, [refreshBrief]);

  async function exportPdf() {
    if (brief.status === "published" && brief.id) {
      window.open(`/api/briefs/${brief.id}/pdf`, "_blank", "noopener,noreferrer");
      return;
    }
    setIsExporting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/brief/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      if (!response.ok) throw new Error("PDF 生成失败");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `AnalystArena-Top5-${brief.date}.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setNotice("目前无法生成 PDF，请稍后再试。");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#brief">跳至主要内容</a>
      <aside className="sidebar">
        <a className="brand-lockup" href="#brief" aria-label="AnalystArena 首页">
          <div className="brand-symbol"><Radar size={24} /></div>
          <div><strong>AnalystArena</strong><span>每日市场情报</span></div>
        </a>
        <nav aria-label="主要导览">
          <a className="is-current" aria-current="page" href="#brief"><LayoutDashboard size={17} />今日简报</a>
          <a href={liveTrendingHref(contextBatch)}><Flame size={17} />热搜榜</a>
          <a href={`/headlines${liveContextQuery(contextBatch)}`}><Newspaper size={17} />市场头条</a>
          <a href={`/signals${liveContextQuery(contextBatch)}`}><MessageCircle size={17} />社交媒体信号</a>
          <a href="#watchlist"><CalendarDays size={17} />观察清单</a>
          <a href="/archive"><Search size={17} />历史日报</a>
          <a href="/review"><ShieldCheck size={17} />人工审核</a>
          <button type="button" onClick={() => void exportPdf()}><FileText size={17} />PDF 报告</button>
        </nav>
        <div className="sidebar-sources">
          <span>信息来源</span>
          <div><CircleDot /> 官方公告与监管</div>
          <div><CircleDot /> 新闻与搜索索引</div>
          <div><CircleDot /> Reddit 社区 / X 平台信号</div>
        </div>
        <div className="system-card">
          <div><Activity size={15} /><span>采集状态</span><b>{brief.stats.sourcesOnline} 个来源在线</b></div>
          <div><Bot size={15} /><span>分析引擎</span><b>{brief.aiEnabled ? "AI 智能分析" : "规则分析"}</b></div>
          <div><Globe2 size={15} /><span>自动翻译</span><b>{brief.translationEnabled ? "简体中文" : "待更新"}</b></div>
          <p><i /> {brief.status === "published" ? "已发布版本" : "草稿／预览版本"}</p>
        </div>
      </aside>

      <main className="main-canvas" id="brief">
        <header className="topbar">
          <a className="mobile-brand" href="#brief"><Radar size={20} /><span>AnalystArena</span></a>
          <div className="breadcrumb"><span>市场情报</span><b>/</b><strong>每日简报</strong></div>
          <div className="topbar-actions">
            <div
              className={`refresh-status${isRefreshing ? " is-refreshing" : ""}${refreshError ? " has-error" : ""}${refreshFallback !== "none" ? " has-fallback" : ""}`}
              title={refreshError ?? (refreshFallback !== "none"
                ? `实时采集暂不可用，当前显示${fallbackLabels[refreshFallback]}，内容时间为北京时间 ${lastSuccessfulLabel}`
                : `每 10 分钟自动更新；上次成功更新于北京时间 ${lastSuccessfulLabel}`)}
            >
              <i aria-hidden="true" />
              <div>
                <strong>
                  {isRefreshing
                    ? refreshOrigin === "manual" ? "正在手动更新…" : "正在自动更新…"
                    : refreshError
                      ? "更新失败"
                      : refreshFallback !== "none"
                        ? `已显示${fallbackLabels[refreshFallback]}`
                      : <><span className="refresh-status-prefix">自动更新 </span>{countdownLabel}</>}
                </strong>
                <small>{refreshFallback !== "none" ? "内容时间" : "上次更新"} {lastSuccessfulLabel}（北京时间）</small>
              </div>
              {(isRefreshing || refreshError) && (
                <span className="visually-hidden" role="status">
                  {refreshError ?? (refreshOrigin === "manual" ? "正在手动更新今日简报" : "正在自动更新今日简报")}
                </span>
              )}
            </div>
            <span className={`mode-badge mode-${brief.mode}`}>{refreshFallback !== "none" ? fallbackLabels[refreshFallback] : brief.status === "published" ? "已发布" : brief.status === "draft" ? "今日草稿 · 待审核" : brief.mode === "live" ? "实时预览" : "示范模式"}</span>
            <button className="secondary-button" type="button" onClick={() => void exportPdf()} disabled={isExporting}><Download size={16} />{isExporting ? "制作中…" : brief.status === "published" ? "前五大 PDF" : "预览 PDF"}</button>
            <button className="primary-button" type="button" onClick={() => void refreshBrief("manual")} disabled={isRefreshing}>
              <RefreshCw size={16} className={isRefreshing ? "is-spinning" : ""} />
              {isRefreshing ? refreshOrigin === "manual" ? "手动更新中..." : "自动更新中..." : "立即更新"}
            </button>
          </div>
        </header>

        <div className="report-wrap">
          <section className="report-masthead">
            <div className="masthead-primary">
              <div className="edition-line">{dateLabel}</div>
              <h1><span>三分钟</span><em>看懂今日市场</em></h1>
              <p className="hero-deck">从事件发生时间、来源验证到市场影响，一次读完今天真正需要关注的金融变化。</p>
            </div>
            <div className="masthead-note">
              <span>今日决策入口</span>
              <p>先看市场冲击带，再进入前五大事件。每则结论都保留时间、重要信息和原始来源。</p>
              <div className="briefing-signal"><CheckCircle2 size={16} />官方与新闻负责验证，社交讨论负责发现信号</div>
              <dl className="intelligence-status">
                <div><dt><Gauge size={15} />核心事件</dt><dd>{brief.stats.topStories} 则</dd></div>
                <div><dt><Layers3 size={15} />合并素材</dt><dd>{brief.stats.consolidatedEvents} 组</dd></div>
                <div><dt><Timer size={15} />更新时间</dt><dd>{generated.hour}:{generated.minute}</dd></div>
              </dl>
              <small className="print-disclaimer">本报告为信息整理与研究工具，不构成投资建议。请由原始来源完成独立查证。</small>
            </div>
          </section>

          {notice && <div className="notice-bar" role="status" aria-live="polite"><Sparkles size={15} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="关闭通知">×</button></div>}

          <MarketPulse headlines={brief.headlines} contextBatch={contextBatch} />

          <section className="stat-grid" aria-label="本日分析摘要">
            <div><span>进入分析</span><strong>{brief.stats.candidates}</strong><small>候选素材</small></div>
            <div><span>完成合并</span><strong>{brief.stats.consolidatedEvents}</strong><small>独立市场事件</small></div>
            <div><span>今日必读</span><strong>{brief.stats.topStories}</strong><small>影响排序头条</small></div>
            <div className="stat-accent"><span>验证网络</span><strong>{brief.stats.sourcesOnline}</strong><small>在线信息来源</small></div>
          </section>

          <div className="section-heading" id="headlines">
            <div><span>按市场影响排序</span><h2>今日五大重要事件</h2></div>
            <div className="category-filters" aria-label="分类筛选">
              <button type="button" aria-pressed={activeCategory === "All"} className={activeCategory === "All" ? "is-active" : ""} onClick={() => setActiveCategory("All")}>全部</button>
              {categories.map((category) => (
                <button type="button" aria-pressed={activeCategory === category} className={activeCategory === category ? "is-active" : ""} onClick={() => setActiveCategory(category)} key={category}>{categoryLabels[category]}</button>
              ))}
            </div>
          </div>

          <div className="content-grid">
            <div className="headline-list">
              {visibleHeadlines.map((headline) => <HeadlineCard headline={headline} contextBatch={contextBatch} key={headline.id} />)}
            </div>

            <aside className="right-rail">
              <section className="side-card heat-card">
                <div className="side-card-heading">
                  <div className="icon-box"><TrendingUp size={18} /></div>
                  <div><span>市场影响</span><h3>市场热度</h3></div>
                </div>
                <div className="heat-list">
                  {brief.marketHeat.map((item) => (
                    <div className="heat-row" key={item.category}>
                      <div><strong>{categoryLabels[item.category]}</strong><span>{item.note}</span></div>
                      <ImpactDots score={item.score} />
                    </div>
                  ))}
                </div>
                <p className="method-note"><ShieldCheck size={14} /> 分数综合市场影响、来源可信度、时效性与跨来源验证。</p>
              </section>

              <WatchPanel items={brief.watchlist} />

              <div id="social">
                <BuzzPanel title="Reddit 热门讨论" kind="reddit" topics={brief.socialBuzz.reddit} contextBatch={contextBatch} />
                <BuzzPanel title="X 讨论动能" kind="x" topics={brief.socialBuzz.x} contextBatch={contextBatch} />
              </div>
            </aside>
          </div>

          <footer className="report-footer">
            <div className="footer-brand"><Globe2 size={18} /><strong>AnalystArena 每日市场情报</strong></div>
            <p>本报告为信息整理与研究工具，不构成投资建议。请点击原始来源完成独立查证。</p>
            <span>生成时间：{generatedLabel.replace("BJT", "北京")}</span>
          </footer>
        </div>
      </main>
      <nav className="mobile-dock" aria-label="移动端主要导览">
        <a className="is-current" aria-current="page" href="#brief"><LayoutDashboard size={18} /><span>简报</span></a>
        <a href={liveTrendingHref(contextBatch)}><Flame size={18} /><span>热搜</span></a>
        <a href={`/headlines${liveContextQuery(contextBatch)}`}><Newspaper size={18} /><span>头条</span></a>
        <a href={`/signals${liveContextQuery(contextBatch)}`}><MessageCircle size={18} /><span>信号</span></a>
        <a href="/archive"><Search size={18} /><span>历史</span></a>
      </nav>
    </div>
  );
}
