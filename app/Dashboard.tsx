"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  CircleDot,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Globe2,
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  Newspaper,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
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

function HeadlineCard({ headline }: { headline: Headline }) {
  const newsTime = resolveHeadlineTimestamp(headline);
  return (
    <article className="headline-card">
      <div className="rank-column">
        <span>0{headline.rank}</span>
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
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-symbol"><Radar size={24} /></div>
          <div><strong>AnalystArena</strong><span>每日市场情报</span></div>
        </div>
        <nav aria-label="主要导览">
          <a className="is-current" href="#brief"><LayoutDashboard size={17} />今日简报</a>
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
            <div>
              <div className="edition-line"><span>台北版</span><i />{dateLabel}</div>
              <h1>每日<br /><em>市场情报</em></h1>
            </div>
            <div className="masthead-note">
              <span>投资人晨间情报</span>
              <p>把官方信息、新闻与社交媒体讨论整理成可验证、可排序的市场事件。</p>
              <div><CheckCircle2 size={15} /> 来源优先，社交媒体仅作为信号</div>
              <small className="print-disclaimer">本报告为信息整理与研究工具，不构成投资建议。请由原始来源完成独立查证。</small>
            </div>
          </section>

          {notice && <div className="notice-bar"><Sparkles size={15} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="关闭通知">×</button></div>}

          <section className="stat-grid" aria-label="本日分析摘要">
            <div><span>候选素材</span><strong>{brief.stats.candidates}</strong><small>已采集信息</small></div>
            <div><span>合并事件</span><strong>{brief.stats.consolidatedEvents}</strong><small>合并后事件</small></div>
            <div><span>核心头条</span><strong>{brief.stats.topStories}</strong><small>排序后新闻</small></div>
            <div className="stat-accent"><span>可用来源</span><strong>{brief.stats.sourcesOnline}</strong><small>在线信息来源</small></div>
          </section>

          <div className="section-heading" id="headlines">
            <div><span>01 / 重点新闻</span><h2>今日市场头条</h2></div>
            <div className="category-filters" aria-label="分类筛选">
              <button className={activeCategory === "All" ? "is-active" : ""} onClick={() => setActiveCategory("All")}>全部</button>
              {categories.map((category) => (
                <button className={activeCategory === category ? "is-active" : ""} onClick={() => setActiveCategory(category)} key={category}>{categoryLabels[category]}</button>
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

              <div id="social">
                <BuzzPanel title="Reddit 热门讨论" kind="reddit" topics={brief.socialBuzz.reddit} />
                <BuzzPanel title="X 讨论动能" kind="x" topics={brief.socialBuzz.x} />
              </div>
            </aside>
          </div>

          <section className="watch-section" id="watchlist">
            <div className="section-heading watch-heading">
              <div><span>02 / 下一交易日</span><h2>明日观察清单</h2></div>
              <p>只保留可能改变市场共识的事件</p>
            </div>
            <div className="watch-grid">
              {brief.watchlist.map((item, index) => (
                <article key={`${item.event}-${index}`}>
                  <span className="watch-time">{item.time}</span>
                  <div><small>{categoryLabels[item.category]}</small><h3>{item.event}</h3><p>{item.why}</p></div>
                  <ArrowUpRight size={19} />
                </article>
              ))}
            </div>
          </section>

          <footer className="report-footer">
            <div className="footer-brand"><Globe2 size={18} /><strong>AnalystArena 每日市场情报</strong></div>
            <p>本报告为信息整理与研究工具，不构成投资建议。请点击原始来源完成独立查证。</p>
            <span>生成时间：{generatedLabel.replace("TPE", "台北")}</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
