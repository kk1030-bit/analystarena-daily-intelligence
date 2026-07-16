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
import { useMemo, useState } from "react";
import type { Category, DailyBrief, Headline, Sentiment, SourceType } from "@/lib/types";
import { categoryDisplayNames as categoryLabels, extractTermNotes, sourceDisplayName } from "@/lib/terms";
import { formatTaipeiMinute, resolveHeadlineTimestamp, timestampLabel } from "@/lib/time";

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
  const formatted = formatTaipeiMinute(value);
  const match = formatted.match(/(\d{2}:\d{2})$/);
  return match?.[1] ?? "待确认";
}

function sourceLayerCount(headline: Headline) {
  return Math.max(1, headline.crossSourceCount ?? new Set(headline.sources.map((source) => source.type)).size);
}

function MarketPulse({ headlines }: { headlines: Headline[] }) {
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
              href={`#headline-${headline.id}`}
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

function HeadlineCard({ headline }: { headline: Headline }) {
  const newsTime = resolveHeadlineTimestamp(headline);
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
          <time dateTime={newsTime.value}>{formatTaipeiMinute(newsTime.value)}</time>
          <small>台北时间{newsTime.source ? ` · 时间来源：${sourceDisplayName(newsTime.source)}` : ""}</small>
        </div>
        {headline.keyPoints?.length ? <div className="key-facts">
          <div><ListChecks size={16} /><span>重要信息</span></div>
          <ul>{headline.keyPoints.map((point, index) => <li key={`${headline.id}-fact-${index}`}>{point}</li>)}</ul>
        </div> : null}
        <div className="impact-note">
          <span>市场影响</span>
          <p>{headline.marketImpact}</p>
        </div>
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
      </div>
    </article>
  );
}

function BuzzPanel({ title, kind, topics }: { title: string; kind: "reddit" | "x"; topics: DailyBrief["socialBuzz"]["reddit"] }) {
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
          <div className="buzz-row" key={`${kind}-${topic.label}`}>
            <span className="buzz-index">0{index + 1}</span>
            <div className="buzz-content">
              <strong>{topic.label}</strong>
              <span>{topic.mentions} 次讨论 · <b className={topic.change >= 0 ? "change-up" : "change-down"}>{topic.change >= 0 ? "+" : ""}{topic.change}%</b></span>
            </div>
            <SentimentMark value={topic.sentiment} />
          </div>
        )) : <p className="empty-note">本次未取得足够的公开讨论信息。</p>}
      </div>
    </section>
  );
}

export function Dashboard({ initialBrief }: { initialBrief: DailyBrief }) {
  const [brief, setBrief] = useState(initialBrief);
  const [activeCategory, setActiveCategory] = useState<Category | "All">("All");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(brief.generatedAt));
  const generated = Object.fromEntries(generatedParts.map((part) => [part.type, part.value]));
  const generatedLabel = `${generated.year}-${generated.month}-${generated.day} ${generated.hour}:${generated.minute} TPE`;

  async function refreshBrief() {
    setIsRefreshing(true);
    setNotice(null);
    try {
      const response = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live: true, useAi: true }),
      });
      if (!response.ok) throw new Error("更新请求失败");
      const nextBrief = (await response.json()) as DailyBrief;
      setBrief(nextBrief);
      setActiveCategory("All");
      setNotice(nextBrief.warning || `完成更新：${nextBrief.stats.candidates} 则素材已进入分析流程。`);
    } catch {
      setNotice("目前无法更新实时来源，页面仍保留上一份可用日报。");
    } finally {
      setIsRefreshing(false);
    }
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
          <a href="/trending"><Flame size={17} />热搜榜</a>
          <a href="#headlines"><Newspaper size={17} />市场头条</a>
          <a href="#social"><MessageCircle size={17} />社交媒体信号</a>
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
            <span className={`mode-badge mode-${brief.mode}`}>{brief.status === "published" ? "已发布" : brief.mode === "live" ? "实时预览" : "示范模式"}</span>
            <button className="secondary-button" type="button" onClick={() => void exportPdf()} disabled={isExporting}><Download size={16} />{isExporting ? "制作中…" : "前五大 PDF"}</button>
            <button className="primary-button" type="button" onClick={refreshBrief} disabled={isRefreshing}>
              <RefreshCw size={16} className={isRefreshing ? "is-spinning" : ""} />
              {isRefreshing ? "分析中..." : "立即更新"}
            </button>
          </div>
        </header>

        <div className="report-wrap">
          <section className="report-masthead">
            <div className="masthead-primary">
              <div className="edition-line"><span>台北版</span><i />{dateLabel}</div>
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

          <MarketPulse headlines={brief.headlines} />

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
              {visibleHeadlines.map((headline) => <HeadlineCard headline={headline} key={headline.id} />)}
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
                <BuzzPanel title="Reddit 热门讨论" kind="reddit" topics={brief.socialBuzz.reddit} />
                <BuzzPanel title="X 讨论动能" kind="x" topics={brief.socialBuzz.x} />
              </div>
            </aside>
          </div>

          <footer className="report-footer">
            <div className="footer-brand"><Globe2 size={18} /><strong>AnalystArena 每日市场情报</strong></div>
            <p>本报告为信息整理与研究工具，不构成投资建议。请点击原始来源完成独立查证。</p>
            <span>生成时间：{generatedLabel.replace("TPE", "台北")}</span>
          </footer>
        </div>
      </main>
      <nav className="mobile-dock" aria-label="移动端主要导览">
        <a className="is-current" aria-current="page" href="#brief"><LayoutDashboard size={18} /><span>简报</span></a>
        <a href="/trending"><Flame size={18} /><span>热搜</span></a>
        <a href="#headlines"><Newspaper size={18} /><span>头条</span></a>
        <a href="#watchlist"><CalendarDays size={18} /><span>观察</span></a>
        <a href="/archive"><Search size={18} /><span>历史</span></a>
      </nav>
    </div>
  );
}
