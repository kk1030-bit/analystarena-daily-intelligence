import Link from "next/link";
import {
  Activity,
  Bot,
  CircleDot,
  Coins,
  FileText,
  Flame,
  Globe2,
  LayoutDashboard,
  MessageCircle,
  Newspaper,
  Radar,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { DailyBrief } from "@/lib/types";

type ResearchSection = "headlines" | "signals";
type ResearchContext = "trending" | undefined;

export function ResearchSidebar({ active, brief, context, contextBatch }: { active: ResearchSection; brief: DailyBrief; context?: ResearchContext; contextBatch?: string }) {
  const contextQuery = context === "trending" ? `?context=trending${contextBatch ? `&batch=${encodeURIComponent(contextBatch)}` : ""}` : "";
  const headlineHref = `/headlines${contextQuery}`;
  const signalHref = `/signals${contextQuery}`;
  const trendingHref = context === "trending" && contextBatch ? `/trending?refresh=${encodeURIComponent(contextBatch)}` : "/trending";
  return (
    <aside className="sidebar">
      <Link className="brand-lockup" href="/" aria-label="AnalystArena 首页">
        <div className="brand-symbol"><Radar size={24} /></div>
        <div><strong>AnalystArena</strong><span>每日市场情报</span></div>
      </Link>
      <nav aria-label="主要导览">
        <Link href="/"><LayoutDashboard size={17} />今日简报</Link>
        <Link href={trendingHref}><Flame size={17} />热搜榜</Link>
        <Link className={active === "headlines" ? "is-current" : undefined} aria-current={active === "headlines" ? "page" : undefined} href={headlineHref}><Newspaper size={17} />市场头条</Link>
        <Link className={active === "signals" ? "is-current" : undefined} aria-current={active === "signals" ? "page" : undefined} href={signalHref}><MessageCircle size={17} />社交媒体信号</Link>
        <Link href="/etf-topics"><Coins size={17} />ETFs 热门话题</Link>
        <Link href="/archive"><Search size={17} />历史日报</Link>
        <Link href="/review"><ShieldCheck size={17} />人工审核</Link>
        <Link href="/"><FileText size={17} />PDF 报告</Link>
      </nav>
      <div className="sidebar-sources">
        <span>研究原则</span>
        <div><CircleDot /> 官方与新闻确认事实</div>
        <div><CircleDot /> Reddit / X 发现异常</div>
        <div><CircleDot /> 所有结论保留原始来源</div>
      </div>
      <div className="system-card">
        <div><Activity size={15} /><span>本期事件</span><b>{brief.headlines.length} 则</b></div>
        <div><Bot size={15} /><span>分析引擎</span><b>{brief.aiEnabled ? "AI 智能分析" : "规则分析"}</b></div>
        <div><Globe2 size={15} /><span>信息来源</span><b>{brief.stats.sourcesOnline} 个在线</b></div>
        <p><i /> {brief.status === "published" ? "已发布版本" : "研究预览版本"}</p>
      </div>
    </aside>
  );
}

export function ResearchMobileDock({ active, context, contextBatch }: { active: ResearchSection; context?: ResearchContext; contextBatch?: string }) {
  const contextQuery = context === "trending" ? `?context=trending${contextBatch ? `&batch=${encodeURIComponent(contextBatch)}` : ""}` : "";
  const headlineHref = `/headlines${contextQuery}`;
  const signalHref = `/signals${contextQuery}`;
  const trendingHref = context === "trending" && contextBatch ? `/trending?refresh=${encodeURIComponent(contextBatch)}` : "/trending";
  return (
    <nav className="mobile-dock" aria-label="移动端主要导览">
      <Link href="/"><LayoutDashboard size={18} /><span>简报</span></Link>
      <Link href={trendingHref}><Flame size={18} /><span>热搜</span></Link>
      <Link className={active === "headlines" ? "is-current" : undefined} aria-current={active === "headlines" ? "page" : undefined} href={headlineHref}><Newspaper size={18} /><span>头条</span></Link>
      <Link className={active === "signals" ? "is-current" : undefined} aria-current={active === "signals" ? "page" : undefined} href={signalHref}><MessageCircle size={18} /><span>信号</span></Link>
      <Link href="/etf-topics"><Coins size={18} /><span>ETF</span></Link>
      <Link href="/archive"><Search size={18} /><span>历史</span></Link>
    </nav>
  );
}
