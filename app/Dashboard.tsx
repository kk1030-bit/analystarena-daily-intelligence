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
import type { Category, DailyBrief, Headline, MarketDirection, Sentiment, SourceType } from "@/lib/types";
import { signalMetricLabel, signalStrength, socialSignalId } from "@/lib/investor-view";
import {
  equityDirectionPresentation,
  formatReturn,
  headlineDirectionConfidence,
  headlineDirectionPresentation,
  headlineDirectionRationale,
  marketDirectionCounts,
} from "@/lib/market-direction";
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

function safePdfErrorDetail(value: string | null): string | null {
  if (!value) return null;
  const detail = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").replace(/^error:\s*/i, "").trim();
  if (!detail || detail.length > 240) return null;
  // Never surface stack traces, credentials, connection strings, server paths,
  // or implementation details returned by an upstream service.
  if (/(?:database_url|authorization|bearer\s|password|secret|token|api[_-]?key|connection string|postgres(?:ql)?:\/\/|https?:\/\/|sqlstate|prisma|stack trace|\bat\s+\S+\s*\(|[a-z]:\\|\/app\/|node_modules)/i.test(detail)) return null;
  return detail;
}

function readablePdfError(status: number, serverDetail: string | null): string {
  const detail = safePdfErrorDetail(serverDetail);
  const normalized = detail?.toLowerCase() ?? "";

  if (status === 413 || /(?:content|payload|body).*(?:large|size)|内容过大/.test(normalized)) {
    return "PDF 生成失败：日报内容过大，请缩短新闻内容后重试。";
  }
  if (/translation|untranslated|翻译未完成|翻译不完整/.test(normalized)) {
    return "PDF 生成失败：部分内容尚未完成简体中文翻译，请稍后重试。";
  }
  if (status === 400 || /invalid|format|incomplete|格式不正确|内容不完整/.test(normalized)) {
    return "PDF 生成失败：日报资料不完整，请先重新更新今日简报。";
  }
  if (status === 401 || status === 403) {
    return "PDF 生成失败：当前没有导出权限，请重新登录后再试。";
  }
  if (status === 429) {
    return "PDF 生成请求过于频繁，请稍后再试。";
  }
  if (status === 408 || status === 502 || status === 503 || status === 504 || /timeout|timed out/.test(normalized)) {
    return "PDF 生成服务暂时无法完成请求，请稍后再试。";
  }
  if (/font|glyph|字体|字形/.test(normalized)) {
    return "PDF 生成失败：报告字体暂时无法加载，请稍后再试。";
  }
  if (/render|document|渲染/.test(normalized)) {
    return "PDF 生成失败：报告内容暂时无法渲染，请稍后再试。";
  }
  if (detail && /[\u3400-\u9fff]/.test(detail) && !/internal server error|pdf (?:generation )?failed/i.test(detail)) {
    return `PDF 生成失败：${detail}`;
  }
  return "PDF 生成失败：服务器暂时无法完成报告，请稍后再试。";
}

async function pdfErrorFromResponse(response: Response): Promise<string> {
  let detail: string | null = null;
  try {
    const body = await response.text();
    if (body) {
      try {
        const payload = JSON.parse(body) as unknown;
        detail = responseErrorMessage(payload) ?? (typeof payload === "string" ? payload : null);
      } catch {
        detail = body;
      }
    }
  } catch {
    // The status code still provides a safe, useful fallback when the body
    // cannot be read (for example, after a proxy disconnect).
  }
  return readablePdfError(response.status, detail);
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

function userFacingBriefWarning(value?: string): string | null {
  if (!value) return null;
  if (/自动翻译.*待人工确认|headlines\.[\w-]+\.|keyPoints\[\d+\]/i.test(value)) {
    return "少数内容仍在自动翻译，将在下一次更新继续处理；英文原文会保留供核对。";
  }
  const cleaned = value.replace(/headlines\.[\w-]+(?:\.[\w]+(?:\[\d+\])?)?/gi, "个别内容").replace(/\s+/g, " ").trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}…` : cleaned;
}

function DirectionBadge({ headline, compact = false }: { headline: Headline; compact?: boolean }) {
  const direction = headlineDirectionPresentation(headline);
  return (
    <span
      className={`direction-badge direction-${direction.direction}${compact ? " is-compact" : ""}`}
      aria-label={`事件潜在方向：${direction.label}`}
    >
      <b aria-hidden="true">{direction.symbol}</b>{compact ? direction.compactLabel : direction.label}
    </span>
  );
}

function ReturnValue({ value, label }: { value: number | undefined; label: string }) {
  if (value === undefined || !Number.isFinite(value)) return null;
  const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
  return <span className={`return-value return-${direction}`}><small>{label}</small><b>{value > 0 ? "↑" : value < 0 ? "↓" : "—"} {formatReturn(value)}</b></span>;
}

const marketTonePresentation: Record<MarketDirection, { symbol: string; label: string; summary: string }> = {
  bullish: { symbol: "↑", label: "事件结构偏多", summary: "潜在利好事件占上风，但仍需结合实际行情确认。" },
  bearish: { symbol: "↓", label: "事件结构偏空", summary: "潜在利空事件占上风，优先检查风险暴露与后续确认点。" },
  mixed: { symbol: "↕", label: "市场分歧升高", summary: "利好与利空同时存在，单一方向判断容易遗漏风险。" },
  neutral: { symbol: "—", label: "方向尚未形成", summary: "现有证据不足以支持明确方向，继续等待可靠来源。" },
};

function DirectionOverview({
  headlines,
  watchlist,
  contextBatch,
}: {
  headlines: Headline[];
  watchlist: DailyBrief["watchlist"];
  contextBatch?: string;
}) {
  const topStories = [...headlines].sort((left, right) => left.rank - right.rank).slice(0, 5);
  const counts = marketDirectionCounts(topStories);
  const total = counts.bullish + counts.bearish + counts.mixed + counts.neutral;
  const marketTone: MarketDirection = counts.mixed >= Math.max(counts.bullish, counts.bearish) && counts.mixed > 0
    ? "mixed"
    : counts.bullish > counts.bearish
      ? "bullish"
      : counts.bearish > counts.bullish
        ? "bearish"
        : counts.bullish > 0 || counts.bearish > 0
          ? "mixed"
          : "neutral";
  const tone = marketTonePresentation[marketTone];
  const lead = topStories[0];
  const leadDirection = lead ? headlineDirectionPresentation(lead) : undefined;
  const nextWatch = watchlist[0];
  const sourceLayers = topStories.reduce((sum, headline) => sum + sourceLayerCount(headline), 0);

  return (
    <section className={`executive-snapshot direction-${marketTone}`} aria-labelledby="executive-snapshot-title">
      <header className="snapshot-verdict">
        <span>今日快速结论</span>
        <h2 id="executive-snapshot-title"><b aria-hidden="true">{tone.symbol}</b>{tone.label}</h2>
        <p>{tone.summary}</p>
        <small>依据前五大事件的潜在传导整理，不是指数涨跌预测。</small>
      </header>

      {lead ? <a className="snapshot-lead" href={`/headlines?event=${encodeURIComponent(lead.id)}${liveContextSuffix(contextBatch)}`}>
        <span>第一重要事件</span>
        <h3>{lead.title}</h3>
        <p>{lead.marketImpact}</p>
        <footer>
          <strong className={`direction-${leadDirection?.direction}`}><b aria-hidden="true">{leadDirection?.symbol}</b>{leadDirection?.label}</strong>
          <small>影响 {lead.impact}/5 · {sourceLayerCount(lead)} 类来源</small>
          <ArrowRight size={16} aria-hidden="true" />
        </footer>
      </a> : null}

      <article className="snapshot-watch">
        <span>下一催化剂</span>
        {nextWatch ? <>
          <div><time>{nextWatch.time}</time><small>{categoryLabels[nextWatch.category]}</small></div>
          <h3>{nextWatch.event}</h3>
          <p>{nextWatch.why}</p>
        </> : <p>目前没有明确的下一项确认点。</p>}
      </article>

      <footer className="snapshot-footer">
        <div className="snapshot-distribution" aria-label={`前五大事件方向分布，共 ${total} 则`}>
          <span className="direction-bullish"><b>↑ {counts.bullish}</b> 潜在利好</span>
          <span className="direction-bearish"><b>↓ {counts.bearish}</b> 潜在利空</span>
          <span className="direction-mixed"><b>↕ {counts.mixed}</b> 多空并存</span>
          <span className="direction-neutral"><b>— {counts.neutral}</b> 待确认</span>
        </div>
        <small>{total} 则核心事件 · {sourceLayers} 个来源层级交叉检查</small>
      </footer>
    </section>
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
          const direction = headlineDirectionPresentation(headline);
          return (
            <a
              className={`pulse-event pulse-impact-${headline.impact} pulse-layers-${Math.min(layers, 4)} pulse-direction-${direction.direction}`}
              href={`/headlines?event=${encodeURIComponent(headline.id)}${liveContextSuffix(contextBatch)}`}
              key={headline.id}
              role="listitem"
              aria-label={`第 ${headline.rank} 名，${headline.ticker}，${headline.title}`}
            >
              <div className="pulse-meta"><span>排名 {String(headline.rank).padStart(2, "0")}</span><time dateTime={newsTime.value}>{pulseTime(newsTime.value)}</time></div>
              <i className="pulse-node"><span /></i>
              <div className="pulse-copy"><strong>{headline.ticker}</strong><span>{headline.title}</span></div>
              <small><DirectionBadge headline={headline} compact /><span>{layers} 类来源</span><ChevronRight size={14} aria-hidden="true" /></small>
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
  const direction = headlineDirectionPresentation(headline);
  const directionConfidence = headlineDirectionConfidence(headline);
  const visibleEquities = (headline.equityImpacts ?? []).filter((item) => item.reviewStatus !== "rejected"
    && item.mappingConfidence >= 70
    && Math.min(item.mappingConfidence, item.directionConfidence ?? item.mappingConfidence) >= 60).slice(0, 3);
  return (
    <article className={`headline-card headline-rank-${headline.rank} headline-direction-${direction.direction}`} id={`headline-${headline.id}`}>
      <div className="rank-column">
        <small>排名</small>
        <span>{String(headline.rank).padStart(2, "0")}</span>
        <div />
      </div>
      <div className="headline-body">
        <div className="headline-eyebrow">
          <span className="ticker">{headline.ticker}</span>
          <span>{categoryLabels[headline.category]}</span>
          <DirectionBadge headline={headline} />
        </div>
        <h3>{headline.title}</h3>
        <section className={`headline-decision direction-${direction.direction}`} aria-label="事件方向判断">
          <div><span>事件潜在方向</span><strong><b aria-hidden="true">{direction.symbol}</b>{direction.label}</strong></div>
          <p>{headlineDirectionRationale(headline)}</p>
          <small>方向证据强度 {directionConfidence}% · 不是上涨或下跌概率</small>
        </section>
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
        <div className={`impact-note impact-direction-${direction.direction}`}>
          <span>市场影响</span>
          <p>{headline.marketImpact}</p>
        </div>
        {visibleEquities.length ? <section className="equity-impact-summary" aria-label="新闻关联美股">
          <header><TrendingUp size={16} /><div><span>新闻 → 美股</span><strong>预期传导与实际行情</strong></div><small>两者不代表因果关系</small></header>
          <div>
            {visibleEquities.map((item) => {
              const itemDirection = equityDirectionPresentation(item.direction);
              return <a href={`/headlines?event=${encodeURIComponent(headline.id)}${liveContextSuffix(contextBatch)}`} className={`equity-chip equity-${item.direction}`} key={item.symbol}>
                <span className="equity-chip-heading">
                  <b>{item.symbol}</b>
                  <span className="equity-thesis"><small>事件推演</small><strong><i aria-hidden="true">{itemDirection.symbol}</i>{itemDirection.label}</strong></span>
                </span>
                <em>关联可信度 {item.mappingConfidence}% · 方向证据 {item.directionConfidence ?? "—"}%</em>
                {item.marketContext?.return1dPct !== undefined ? <span className="equity-chip-market">
                  <small><b>市场已发生</b> · 截至 {item.marketContext.asOf}</small>
                  <ReturnValue value={item.marketContext.return1dPct} label="1日" />
                  <ReturnValue value={item.marketContext.return5dPct} label="5日" />
                </span> : <small className="equity-chip-no-market">暂无事件发生前的可用行情</small>}
              </a>;
            })}
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
  const [isLivePreview, setIsLivePreview] = useState(false);
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
  const livePreviewRef = useRef(false);
  const nextRefreshAtRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);

  const dailyHeadlines = useMemo(() => {
    return [...brief.headlines].sort((left, right) => left.rank - right.rank).slice(0, 5);
  }, [brief.headlines]);

  const categories = useMemo(() => {
    return Array.from(new Set(dailyHeadlines.map((headline) => headline.category)));
  }, [dailyHeadlines]);

  const visibleHeadlines = activeCategory === "All"
    ? dailyHeadlines
    : dailyHeadlines.filter((headline) => headline.category === activeCategory);

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
  const fallbackCollectors = brief.collectorStatuses?.filter((status) => status.fallbackUsed).length ?? 0;

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
      setIsLivePreview(true);
      livePreviewRef.current = true;
      setContextBatch(response.headers.get("X-AnalystArena-Batch") ?? undefined);
      setLastSuccessfulAt(nextBrief.generatedAt);
      setRefreshFallback(fallback);
      const warning = userFacingBriefWarning(nextBrief.warning);

      if (fallback !== "none") {
        setActiveCategory((current) => origin === "manual" || current === "All" || !nextBrief.headlines.slice(0, 5).some((headline) => headline.category === current) ? "All" : current);
        const source = fallbackLabels[fallback];
        setNotice(`${origin === "manual" ? "手动采集暂未取得新快照" : "自动采集暂未取得新快照"}，已显示${source}（内容时间：${formatBeijingMinute(nextBrief.generatedAt)}）。${warning ? ` ${warning}` : ""}`);
      } else if (origin === "manual") {
        setActiveCategory("All");
        setNotice(warning || `手动更新完成：${nextBrief.stats.consolidatedEvents} 个事件已完成合并与排序。`);
      } else {
        setActiveCategory((current) => current === "All" || nextBrief.headlines.slice(0, 5).some((headline) => headline.category === current) ? current : "All");
        setNotice(warning ? `自动更新完成。${warning}` : null);
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
      if (remainingMs <= 0
        && livePreviewRef.current
        && document.visibilityState === "visible"
        && !requestInFlightRef.current) {
        void refreshBrief("auto");
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };

    tick();
    const intervalId = window.setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      activeRequestRef.current?.abort();
    };
  }, [refreshBrief]);

  function returnToPublishedBrief() {
    activeRequestRef.current?.abort();
    livePreviewRef.current = false;
    setIsLivePreview(false);
    setBrief(initialBrief);
    setContextBatch(undefined);
    setActiveCategory("All");
    setLastSuccessfulAt(initialBrief.generatedAt);
    setRefreshFallback("none");
    setRefreshError(null);
    setNotice("已返回经人工审核的正式发布版本。");
    nextRefreshAtRef.current = Date.now() + AUTO_REFRESH_INTERVAL_MS;
    setSecondsUntilRefresh(AUTO_REFRESH_INTERVAL_MS / 1_000);
  }

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
      if (!response.ok) throw new Error(await pdfErrorFromResponse(response));
      const translationWarning = response.headers.get("X-AnalystArena-Translation-Warning")
        ?? response.headers.get("X-Translation-Warning");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `AnalystArena-Market-Headlines-${brief.date}.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice(translationWarning && translationWarning !== "0" && translationWarning.toLowerCase() !== "false"
        ? "PDF 已下载；部分内容仍在完成简体中文翻译，正式发布前请人工复核。"
        : "PDF 已生成并开始下载。");
    } catch (error) {
      setNotice(error instanceof Error && error.message.startsWith("PDF ")
        ? error.message
        : "PDF 生成失败：网络连接异常，请检查网络后重试。");
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
          <button type="button" onClick={() => void exportPdf()}><FileText size={17} />市场头条完整研究 PDF</button>
        </nav>
        <div className="sidebar-sources">
          <span>信息来源</span>
          <div><CircleDot /> 官方公告与监管</div>
          <div><CircleDot /> 新闻与搜索索引</div>
          <div><CircleDot /> Reddit 社区 / X 平台信号</div>
        </div>
        <div className="system-card">
          <div><Activity size={15} /><span>采集状态</span><b>{fallbackCollectors ? `${fallbackCollectors} 个来源使用备用线路` : `${brief.stats.sourcesOnline} 个来源在线`}</b></div>
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
                : isLivePreview
                  ? `实时预览每 10 分钟自动更新；上次成功更新于北京时间 ${lastSuccessfulLabel}`
                  : brief.status === "published"
                    ? `当前为经审核发布快照，不会被后台采集自动改写；发布时间为北京时间 ${lastSuccessfulLabel}`
                    : `当前为示范快照；需要主动进入实时预览才会显示未发布采集结果`)}
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
                      : isLivePreview
                        ? <><span className="refresh-status-prefix">预览自动更新 </span>{countdownLabel}</>
                        : brief.status === "published" ? "正式发布快照" : "示范快照"}
                </strong>
                <small>{isLivePreview || refreshFallback !== "none" || brief.status !== "published" ? "内容时间" : "发布时间"} {lastSuccessfulLabel}（北京时间）</small>
              </div>
              {(isRefreshing || refreshError) && (
                <span className="visually-hidden" role="status">
                  {refreshError ?? (refreshOrigin === "manual" ? "正在手动更新今日简报" : "正在自动更新今日简报")}
                </span>
              )}
            </div>
            <span className={`mode-badge mode-${brief.mode}`}>{isLivePreview ? "实时预览 · 未发布" : brief.status === "published" ? "已发布" : "示范模式"}</span>
            <button className="secondary-button pdf-action" type="button" onClick={() => void exportPdf()} disabled={isExporting} aria-label={isExporting ? "正在制作市场头条完整研究 PDF" : "下载市场头条完整研究 PDF"}><Download size={16} /><span>{isExporting ? "制作中…" : brief.status === "published" ? "完整研究 PDF" : "预览完整研究 PDF"}</span></button>
            {isLivePreview && <button className="secondary-button" type="button" onClick={returnToPublishedBrief} disabled={isRefreshing}>返回已发布日报</button>}
            <button className="primary-button refresh-action" type="button" onClick={() => void refreshBrief("manual")} disabled={isRefreshing} aria-label={isRefreshing ? "正在更新实时预览" : "查看实时预览"}>
              <RefreshCw size={16} className={isRefreshing ? "is-spinning" : ""} />
              <span>{isRefreshing ? refreshOrigin === "manual" ? "采集中..." : "预览更新中..." : isLivePreview ? "更新实时预览" : "查看实时预览"}</span>
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
              <p>先看今日快速结论，再进入前五大事件。每则结论都保留时间、重要信息和原始来源。</p>
              <div className="briefing-signal"><CheckCircle2 size={16} />官方与新闻负责验证，社交讨论负责发现信号</div>
              <dl className="intelligence-status">
                <div><dt><Gauge size={15} />核心事件</dt><dd>{dailyHeadlines.length} 则</dd></div>
                <div><dt><Layers3 size={15} />事件合并</dt><dd>{brief.stats.consolidatedEvents} 组</dd></div>
                <div><dt><Timer size={15} />更新时间</dt><dd>{generated.hour}:{generated.minute}</dd></div>
              </dl>
              <small className="print-disclaimer">本报告为信息整理与研究工具，不构成投资建议。请由原始来源完成独立查证。</small>
            </div>
          </section>

          <DirectionOverview headlines={dailyHeadlines} watchlist={brief.watchlist} contextBatch={contextBatch} />

          {notice && <div className="notice-bar" role="status" aria-live="polite"><Sparkles size={15} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="关闭通知">×</button></div>}

          <MarketPulse headlines={dailyHeadlines} contextBatch={contextBatch} />

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
                      <div className={`heat-direction heat-direction-${item.direction}`}>
                        <span>{item.direction === "up" ? "↑ 利好事件较多" : item.direction === "down" ? "↓ 利空事件较多" : "— 多空平衡"}</span>
                        <b>{item.score}/5</b>
                      </div>
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
