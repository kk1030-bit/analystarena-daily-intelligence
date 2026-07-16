"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowUpRight,
  Bot,
  CalendarDays,
  ChevronRight,
  CircleDot,
  Clock3,
  FileText,
  Flame,
  Globe2,
  LayoutDashboard,
  MessageCircle,
  Newspaper,
  Radar,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { resolveSignalHeadline, signalMetricLabel, signalStrength, socialSignalId } from "@/lib/investor-view";
import { categoryDisplayNames, sourceDisplayName } from "@/lib/terms";
import { formatBeijingMinute, resolveHeadlineTimestamp, timestampLabel } from "@/lib/time";
import type { Category, DailyBrief, TimestampKind } from "@/lib/types";

type BoardTab = "all" | "finance" | "technology";

interface TrendingItem {
  id: string;
  title: string;
  description: string;
  category: Category;
  href: string;
  external: boolean;
  score: number;
  mentions: number;
  badge?: "热" | "新";
  source: string;
  publishedAt?: string;
  timestampKind: TimestampKind;
}

const tabs: Array<{ id: BoardTab; label: string }> = [
  { id: "all", label: "热搜榜" },
  { id: "finance", label: "财经榜" },
  { id: "technology", label: "科技榜" },
];

const financeCategories = new Set<Category>(["Macro", "Crypto", "ETF", "Earnings", "Geopolitics", "Semiconductor"]);
const technologyCategories = new Set<Category>(["AI", "Semiconductor"]);

function topicCategory(label: string): Category {
  if (/AI|人工智能|英伟达|NVIDIA|OpenAI|模型/i.test(label)) return "AI";
  if (/台积电|TSMC|晶片|芯片|半导体/i.test(label)) return "Semiconductor";
  if (/BTC|比特币|加密|ETF/i.test(label)) return "Crypto";
  if (/FOMC|利率|通胀|降息|宏观/i.test(label)) return "Macro";
  return "Other";
}

function scoreForHeadline(brief: DailyBrief, rank: number): number {
  const headline = brief.headlines.find((item) => item.rank === rank);
  if (!headline) return 50;
  const ranking = headline.rankingScore ?? headline.impact * 14 + headline.confidence * 0.18;
  return Math.max(50, Math.min(99, Math.round(ranking)));
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "").slice(0, 48);
}

function makeItems(brief: DailyBrief, contextBatch: string): TrendingItem[] {
  const batchQuery = encodeURIComponent(contextBatch);
  const headlineItems: TrendingItem[] = [...brief.headlines]
    .sort((left, right) => left.rank - right.rank)
    .map((headline) => {
      const newsTime = resolveHeadlineTimestamp(headline);
      return {
        id: `headline-${headline.id}`,
        title: headline.title,
        description: headline.summary,
        category: headline.category,
        href: `/headlines?event=${encodeURIComponent(headline.id)}&context=trending&batch=${batchQuery}`,
        external: false,
        score: scoreForHeadline(brief, headline.rank),
        mentions: headline.mentions,
        badge: headline.rank <= 3 ? "热" : (headline.freshnessScore ?? 0) >= 86 ? "新" : undefined,
        source: newsTime.source ?? headline.sources[0]?.name ?? "AnalystArena",
        publishedAt: newsTime.value,
        timestampKind: newsTime.kind,
      };
    });

  const socialEntries = [
    ...brief.socialBuzz.reddit.map((topic, index) => ({ topic, platform: "Reddit" as const, index })),
    ...brief.socialBuzz.x.map((topic, index) => ({ topic, platform: "X" as const, index })),
  ];
  const socialItems: TrendingItem[] = socialEntries.map(({ topic, platform, index }) => {
    const related = resolveSignalHeadline(topic, brief.headlines);
    const sourceTypes = new Set(related?.sources.map((source) => source.type) ?? []);
    const scoreCap = sourceTypes.has("Official") ? 93 : sourceTypes.has("News") ? 90 : related ? 84 : 76;
    const score = Math.min(signalStrength(topic), scoreCap);
    return {
      id: `social-${socialSignalId(topic, platform, index)}`,
      title: topic.label,
      description: topic.description ?? `${platform} ${signalMetricLabel(topic)}为 ${topic.mentions}；社交媒体只作为市场情绪信号。`,
      category: topic.category ?? topicCategory(topic.label),
      href: `/signals?platform=${platform.toLowerCase()}&signal=${encodeURIComponent(socialSignalId(topic, platform, index))}&context=trending&batch=${batchQuery}`,
      external: false,
      score,
      mentions: topic.mentions,
      badge: score >= 80 ? "热" : score >= 65 ? "新" : undefined,
      source: topic.source ?? `${platform} 公开讨论`,
      publishedAt: topic.publishedAt ?? brief.generatedAt,
      timestampKind: topic.timestampKind ?? "collected" as const,
    };
  });

  const seen = new Set<string>();
  return [...headlineItems, ...socialItems]
    .filter((item) => {
      const key = normalizeTitle(item.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.score - left.score || right.mentions - left.mentions)
    .slice(0, 18);
}

function matchesTab(item: TrendingItem, tab: BoardTab): boolean {
  if (tab === "finance") return financeCategories.has(item.category);
  if (tab === "technology") return technologyCategories.has(item.category);
  return true;
}

export function TrendingBoard({ brief, contextBatch }: { brief: DailyBrief; contextBatch: string }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<BoardTab>("all");
  const [batch, setBatch] = useState(0);
  const [isRefreshing, startRefresh] = useTransition();
  const items = useMemo(() => makeItems(brief, contextBatch), [brief, contextBatch]);
  const filtered = useMemo(() => items.filter((item) => matchesTab(item, activeTab)), [activeTab, items]);
  const visibleItems = useMemo(() => {
    if (filtered.length <= 5 || batch === 0) return filtered.slice(0, 15);
    const leaders = filtered.slice(0, 3);
    const rest = filtered.slice(3);
    const offset = (batch * 4) % rest.length;
    return [...leaders, ...rest.slice(offset), ...rest.slice(0, offset)].slice(0, 15);
  }, [batch, filtered]);
  const lead = items[0];
  const updatedAt = formatBeijingMinute(brief.generatedAt);

  function refreshPage() {
    startRefresh(() => router.replace(`/trending?refresh=${Date.now()}`, { scroll: false }));
  }

  return (
    <div className="app-shell trending-shell">
      <a className="skip-link" href="#hot-board-title">跳至热搜榜</a>
      <aside className="sidebar">
        <Link className="brand-lockup" href="/" aria-label="AnalystArena 首页">
          <div className="brand-symbol"><Radar size={24} /></div>
          <div><strong>AnalystArena</strong><span>每日市场情报</span></div>
        </Link>
        <nav aria-label="主要导览">
          <Link href="/"><LayoutDashboard size={17} />今日简报</Link>
          <Link className="is-current" aria-current="page" href="/trending"><Flame size={17} />热搜榜</Link>
          <Link href={`/headlines?context=trending&batch=${encodeURIComponent(contextBatch)}`}><Newspaper size={17} />市场头条</Link>
          <Link href={`/signals?context=trending&batch=${encodeURIComponent(contextBatch)}`}><MessageCircle size={17} />社交媒体信号</Link>
          <Link href="/#watchlist"><CalendarDays size={17} />观察清单</Link>
          <Link href="/archive"><Search size={17} />历史日报</Link>
          <Link href="/review"><ShieldCheck size={17} />人工审核</Link>
          <Link href="/"><FileText size={17} />日报与 PDF</Link>
        </nav>
        <div className="sidebar-sources">
          <span>榜单依据</span>
          <div><CircleDot /> 市场影响与时效性</div>
          <div><CircleDot /> 跨来源验证数量</div>
          <div><CircleDot /> Reddit / X 讨论热度</div>
        </div>
        <div className="system-card">
          <div><Activity size={15} /><span>榜单项目</span><b>{items.length} 个热点</b></div>
          <div><Bot size={15} /><span>分析方式</span><b>动态事件排序</b></div>
          <div><Globe2 size={15} /><span>自动翻译</span><b>简体中文</b></div>
          <p><i /> 每十分钟更新资料</p>
        </div>
      </aside>

      <main className="main-canvas trending-main">
        <header className="topbar">
          <Link className="mobile-brand" href="/"><Radar size={20} /><span>AnalystArena</span></Link>
          <div className="breadcrumb"><span>热点中心</span><b>/</b><strong>今日榜单</strong></div>
          <div className="topbar-actions">
            <span className="mode-badge mode-live"><Activity size={12} /> 动态热搜</span>
            <Link className="secondary-button" href="/"><Newspaper size={16} />返回日报</Link>
            <button className="primary-button" type="button" onClick={refreshPage} disabled={isRefreshing}>
              <RefreshCw size={16} className={isRefreshing ? "is-spinning" : ""} />{isRefreshing ? "更新中..." : "刷新榜单"}
            </button>
          </div>
        </header>

        <div className="trending-wrap">
          <section className="trending-hero">
            <div>
              <span><Flame size={15} /> 今日热点先看</span>
              <h1>市场<br /><em>热搜榜</em></h1>
            </div>
            <div className="trending-hero-note">
              <strong>把市场今天正在关注的事情放到最前面</strong>
              <p>综合新闻重要性、发布时间、跨来源数量与讨论热度；榜单不是搜索次数的简单堆叠。</p>
              <div><Clock3 size={14} />榜单更新时间：{updatedAt}（北京时间）</div>
            </div>
          </section>

          {lead && <a className="trending-lead" href={lead.href} target={lead.external ? "_blank" : undefined} rel={lead.external ? "noreferrer" : undefined}>
            <span className="pin-label"><TrendingUp size={14} /> 今日置顶</span>
            <div>
              <small>{categoryDisplayNames[lead.category]} · 热度 {lead.score}</small>
              <h2>{lead.title}</h2>
              <p>{lead.description}</p>
              <footer><span>{timestampLabel(lead.timestampKind)}：{formatBeijingMinute(lead.publishedAt)}（北京时间）</span><b>{sourceDisplayName(lead.source)} <ArrowUpRight size={13} /></b></footer>
            </div>
          </a>}

          <div className="trending-content-grid">
            <section className="hot-board" aria-labelledby="hot-board-title">
              <header className="hot-board-header">
                <div><span>实时榜单</span><h2 id="hot-board-title">今日热搜</h2></div>
                <button type="button" onClick={() => setBatch((value) => value + 1)}><RotateCw size={15} />换一批</button>
              </header>
              <div className="hot-tabs" role="tablist" aria-label="热搜榜分类">
                {tabs.map((tab) => <button id={`hot-tab-${tab.id}`} aria-controls="hot-list-panel" key={tab.id} role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "is-active" : ""} onClick={() => { setActiveTab(tab.id); setBatch(0); }}>{tab.label}</button>)}
              </div>
              <div className="hot-list" id="hot-list-panel" role="tabpanel" aria-labelledby={`hot-tab-${activeTab}`} aria-live="polite" aria-busy={isRefreshing}>
                {visibleItems.map((item, index) => (
                  <a className="hot-row" href={item.href} target={item.external ? "_blank" : undefined} rel={item.external ? "noreferrer" : undefined} key={item.id}>
                    <span className={`hot-rank hot-rank-${index + 1}`}>{index + 1}</span>
                    <div className="hot-row-content">
                      <div><span>{categoryDisplayNames[item.category]}</span>{item.badge && <i className={`hot-badge hot-badge-${item.badge === "热" ? "hot" : "new"}`}>{item.badge}</i>}</div>
                      <strong>{item.title}</strong>
                      <small>{sourceDisplayName(item.source)} · {formatBeijingMinute(item.publishedAt)} · 热度指标 {item.mentions}</small>
                    </div>
                    <div className="hot-row-score"><span>热度</span><b>{item.score}</b><ChevronRight size={15} /></div>
                  </a>
                ))}
                {!visibleItems.length && <p className="hot-empty">这个分类目前没有足够的已验证热点。</p>}
              </div>
            </section>

            <aside className="trending-rail">
              <section>
                <span className="rail-icon"><Sparkles size={18} /></span>
                <small>榜单说明</small>
                <h3>不是谁声音大，谁就排第一</h3>
                <ul>
                  <li>新闻重要性与市场影响</li>
                  <li>来源发布时间与时效性</li>
                  <li>官方、新闻、社区交叉验证</li>
                  <li>讨论数量只作为辅助信号</li>
                </ul>
              </section>
              <section>
                <span className="rail-icon rail-icon-orange"><Globe2 size={18} /></span>
                <small>今日覆盖</small>
                <h3>{brief.stats.sourcesOnline} 个信息来源在线</h3>
                <div className="trend-coverage">
                  <div><b>{brief.stats.candidates}</b><span>采集素材</span></div>
                  <div><b>{brief.stats.consolidatedEvents}</b><span>合并事件</span></div>
                </div>
              </section>
              <section>
                <span className="rail-icon"><TrendingUp size={18} /></span>
                <small>市场热度</small>
                <h3>今日分类强度</h3>
                <div className="trend-category-list">
                  {brief.marketHeat.slice(0, 5).map((item) => <div key={item.category}><span>{categoryDisplayNames[item.category]}</span><span className="trend-strength" role="meter" aria-label={`${categoryDisplayNames[item.category]}强度 ${item.score} / 5`} aria-valuemin={1} aria-valuemax={5} aria-valuenow={item.score}><i style={{ width: `${item.score * 20}%` }} /></span></div>)}
                </div>
              </section>
            </aside>
          </div>
        </div>
      </main>
      <nav className="mobile-dock" aria-label="移动端主要导览">
        <Link href="/"><LayoutDashboard size={18} /><span>简报</span></Link>
        <Link className="is-current" aria-current="page" href="/trending"><Flame size={18} /><span>热搜</span></Link>
        <Link href={`/headlines?context=trending&batch=${encodeURIComponent(contextBatch)}`}><Newspaper size={18} /><span>头条</span></Link>
        <Link href={`/signals?context=trending&batch=${encodeURIComponent(contextBatch)}`}><MessageCircle size={18} /><span>信号</span></Link>
        <Link href="/archive"><Search size={18} /><span>历史</span></Link>
      </nav>
    </div>
  );
}
