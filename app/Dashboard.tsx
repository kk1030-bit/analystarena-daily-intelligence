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

const categoryLabels: Record<Category, string> = {
  Macro: "總體經濟",
  AI: "AI",
  Semiconductor: "半導體",
  Crypto: "加密資產",
  ETF: "ETF",
  Earnings: "財報",
  Geopolitics: "地緣政治",
  Other: "其他",
};

const sentimentLabels: Record<Sentiment, string> = {
  positive: "偏多",
  neutral: "中性",
  negative: "偏空",
};

const sourceLabels: Record<SourceType, string> = {
  Official: "官方",
  News: "新聞",
  Reddit: "Reddit",
  X: "X",
};

function ImpactDots({ score }: { score: number }) {
  return (
    <span className="impact-dots" aria-label={`影響分數 ${score} / 5`}>
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
        <p className="headline-summary">{headline.summary}</p>
        {headline.keyPoints?.length ? <div className="key-facts">
          <div><ListChecks size={16} /><span>重要資訊</span></div>
          <ul>{headline.keyPoints.map((point, index) => <li key={`${headline.id}-fact-${index}`}>{point}</li>)}</ul>
        </div> : null}
        <div className="impact-note">
          <span>MARKET IMPACT</span>
          <p>{headline.marketImpact}</p>
        </div>
        <footer className="headline-footer">
          <div className="source-list" aria-label="資料來源">
            {headline.sources.map((source, index) => (
              <a href={source.url} target="_blank" rel="noreferrer" key={`${source.name}-${index}`}>
                <span>{sourceLabels[source.type]}</span>
                {source.name}
                <ExternalLink size={11} />
              </a>
            ))}
          </div>
          <div className="score-list">
            <span><ImpactDots score={headline.impact} /> 影響 {headline.impact}/5</span>
            <span><ShieldCheck size={13} /> 信心 {headline.confidence}%</span>
            <span><MessageCircle size={13} /> 討論 {headline.mentions}</span>
            {headline.freshnessScore !== undefined && <span><Activity size={13} /> 時效 {headline.freshnessScore}</span>}
            {headline.crossSourceCount !== undefined && <span><Globe2 size={13} /> {headline.crossSourceCount} 種來源</span>}
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
          <span>DISCUSSION PULSE</span>
          <h3>{title}</h3>
        </div>
      </div>
      <div className="buzz-list">
        {topics.length ? topics.map((topic, index) => (
          <div className="buzz-row" key={`${kind}-${topic.label}`}>
            <span className="buzz-index">0{index + 1}</span>
            <div className="buzz-content">
              <strong>{topic.label}</strong>
              <span>{topic.mentions} mentions · <b className={topic.change >= 0 ? "change-up" : "change-down"}>{topic.change >= 0 ? "+" : ""}{topic.change}%</b></span>
            </div>
            <SentimentMark value={topic.sentiment} />
          </div>
        )) : <p className="empty-note">本次未取得足夠的公開討論資料。</p>}
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
  const dateLabel = `${year} 年 ${month} 月 ${day} 日 / 週${weekday}`;
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
      if (!response.ok) throw new Error("更新請求失敗");
      const nextBrief = (await response.json()) as DailyBrief;
      setBrief(nextBrief);
      setActiveCategory("All");
      setNotice(nextBrief.warning || `完成更新：${nextBrief.stats.candidates} 則素材已進入分析流程。`);
    } catch {
      setNotice("目前無法更新即時來源，畫面仍保留上一份可用日報。");
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
      if (!response.ok) throw new Error("PDF 產生失敗");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `AnalystArena-Top5-${brief.date}.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setNotice("目前無法產生 PDF，請稍後再試。");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-symbol"><Radar size={24} /></div>
          <div><strong>AnalystArena</strong><span>DAILY INTELLIGENCE</span></div>
        </div>
        <nav aria-label="主要導覽">
          <a className="is-current" href="#brief"><LayoutDashboard size={17} />今日簡報</a>
          <a href="#headlines"><Newspaper size={17} />市場頭條</a>
          <a href="#social"><MessageCircle size={17} />社群訊號</a>
          <a href="#watchlist"><CalendarDays size={17} />觀察清單</a>
          <a href="/archive"><Search size={17} />歷史日報</a>
          <a href="/review"><ShieldCheck size={17} />人工審核</a>
          <button type="button" onClick={() => void exportPdf()}><FileText size={17} />PDF 報告</button>
        </nav>
        <div className="sidebar-sources">
          <span>SOURCE LAYERS</span>
          <div><CircleDot /> 官方公告與監管</div>
          <div><CircleDot /> 新聞與搜尋索引</div>
          <div><CircleDot /> Reddit / X 訊號</div>
        </div>
        <div className="system-card">
          <div><Activity size={15} /><span>Collector status</span><b>{brief.stats.sourcesOnline} online</b></div>
          <div><Bot size={15} /><span>Analysis engine</span><b>{brief.aiEnabled ? "AI" : "Rules"}</b></div>
          <p><i /> {brief.status === "published" ? "已發布版本" : "草稿／預覽版本"}</p>
        </div>
      </aside>

      <main className="main-canvas" id="brief">
        <header className="topbar">
          <div className="breadcrumb"><span>INTELLIGENCE</span><b>/</b><strong>DAILY BRIEF</strong></div>
          <div className="topbar-actions">
            <span className={`mode-badge mode-${brief.mode}`}>{brief.status === "published" ? "PUBLISHED" : brief.mode === "live" ? "LIVE PREVIEW" : "DEMO MODE"}</span>
            <button className="secondary-button" type="button" onClick={() => void exportPdf()} disabled={isExporting}><Download size={16} />{isExporting ? "製作中…" : "前五大 PDF"}</button>
            <button className="primary-button" type="button" onClick={refreshBrief} disabled={isRefreshing}>
              <RefreshCw size={16} className={isRefreshing ? "is-spinning" : ""} />
              {isRefreshing ? "分析中..." : "立即更新"}
            </button>
          </div>
        </header>

        <div className="report-wrap">
          <section className="report-masthead">
            <div>
              <div className="edition-line"><span>TAIPEI EDITION</span><i />{dateLabel}</div>
              <h1>Daily<br /><em>Intelligence</em></h1>
            </div>
            <div className="masthead-note">
              <span>投資人晨間情報</span>
              <p>把官方訊息、新聞與社群討論整理成可驗證、可排序的市場事件。</p>
              <div><CheckCircle2 size={15} /> 來源優先，社群僅作為訊號</div>
              <small className="print-disclaimer">本報告為資訊整理與研究工具，不構成投資建議。請由原始來源完成獨立查證。</small>
            </div>
          </section>

          {notice && <div className="notice-bar"><Sparkles size={15} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="關閉通知">×</button></div>}

          <section className="stat-grid" aria-label="本日分析摘要">
            <div><span>候選素材</span><strong>{brief.stats.candidates}</strong><small>collected items</small></div>
            <div><span>合併事件</span><strong>{brief.stats.consolidatedEvents}</strong><small>after clustering</small></div>
            <div><span>核心頭條</span><strong>{brief.stats.topStories}</strong><small>ranked stories</small></div>
            <div className="stat-accent"><span>可用來源</span><strong>{brief.stats.sourcesOnline}</strong><small>source layers online</small></div>
          </section>

          <div className="section-heading" id="headlines">
            <div><span>01 / TOP STORIES</span><h2>今日市場頭條</h2></div>
            <div className="category-filters" aria-label="分類篩選">
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
                  <div><span>MARKET IMPACT</span><h3>市場熱度</h3></div>
                </div>
                <div className="heat-list">
                  {brief.marketHeat.map((item) => (
                    <div className="heat-row" key={item.category}>
                      <div><strong>{categoryLabels[item.category]}</strong><span>{item.note}</span></div>
                      <ImpactDots score={item.score} />
                    </div>
                  ))}
                </div>
                <p className="method-note"><ShieldCheck size={14} /> 分數綜合市場影響、來源可信度、新穎性與跨來源驗證。</p>
              </section>

              <div id="social">
                <BuzzPanel title="Reddit 熱門討論" kind="reddit" topics={brief.socialBuzz.reddit} />
                <BuzzPanel title="X 討論動能" kind="x" topics={brief.socialBuzz.x} />
              </div>
            </aside>
          </div>

          <section className="watch-section" id="watchlist">
            <div className="section-heading watch-heading">
              <div><span>02 / NEXT SESSION</span><h2>明日觀察清單</h2></div>
              <p>只保留可能改變市場共識的事件</p>
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
            <div className="footer-brand"><Globe2 size={18} /><strong>AnalystArena Daily Intelligence</strong></div>
            <p>本報告為資訊整理與研究工具，不構成投資建議。請點擊原始來源完成獨立查證。</p>
            <span>Generated {generatedLabel}</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
