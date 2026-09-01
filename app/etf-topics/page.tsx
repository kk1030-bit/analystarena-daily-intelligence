import Link from "next/link";
import { Coins, ExternalLink, Flame, Radar, Users } from "lucide-react";
import { getEtfTopicsView } from "@/lib/etf-db";
import type { EtfObservation } from "@/lib/etf-db";
import { ETF_MAX_TRACKED, ETF_TOP_PER_HOUR, ETF_TRACK_HOURS } from "@/lib/etf-topics";
import { formatBeijingMinute } from "@/lib/time";

export const dynamic = "force-dynamic";

function heat(value: number): string {
  return value >= 10_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

function TrendBars({ observations }: { observations: EtfObservation[] }) {
  const series = observations.slice(-24);
  if (series.length < 2) return <span className="etf-trend-empty">观察中</span>;
  const peak = Math.max(...series.map((point) => point.engagement), 1);
  return (
    <span className="etf-trend" aria-label={`${series.length} 次整点热度观察`}>
      {series.map((point) => (
        <i key={point.observedAt} style={{ height: `${Math.max(12, Math.round((point.engagement / peak) * 100))}%` }} />
      ))}
    </span>
  );
}

export default async function EtfTopicsPage() {
  const view = await getEtfTopicsView();
  const selection = view.latestSelection;
  const activeTracked = view.tracked.filter((post) => post.active);
  return (
    <main className="standalone-page">
      <header className="standalone-header">
        <Link href="/" className="standalone-brand"><span><Radar size={21} /></span>AnalystArena</Link>
        <nav className="standalone-links" aria-label="ETF 热门话题导览">
          <Link href="/trending" className="text-link">今日热搜</Link>
          <Link href="/archive" className="text-link">历史日报 →</Link>
        </nav>
      </header>

      <section className="archive-hero">
        <span>Reddit ETF 社区信号</span>
        <h1>ETFs 热门话题</h1>
        <p>
          只采集 Reddit 平台的 ETF 讨论：每小时评审一次，从 {`r/ETFs`}、{`r/investing`}、{`r/Bogleheads`}、{`r/dividends`}、{`r/stocks`} 的热门帖里
          选出流量最高的前 {ETF_TOP_PER_HOUR} 篇，翻译成简体中文并整理重点；每篇入选帖在其后 {ETF_TRACK_HOURS} 小时持续追踪热度
          （同时最多 {ETF_MAX_TRACKED} 篇）。每天北京时间 00:00 统整前一天保存为历史日报，每周再统整 7 天做一次最完整的周报。
          {view.updatedAt ? ` 上次整点评审：北京时间 ${formatBeijingMinute(view.updatedAt)}。` : " 等待第一次整点评审。"}
        </p>
      </section>

      <section className="etf-section" aria-labelledby="etf-top5">
        <h2 id="etf-top5"><Flame size={18} /> 本小时流量前五</h2>
        {selection?.items.length ? (
          <div className="etf-top-list">
            {selection.items.map((item) => (
              <article className="etf-card" key={item.postId}>
                <div className="etf-rank" aria-hidden="true">{item.rank}</div>
                <div className="etf-card-body">
                  <h3>{item.titleZh || item.title}</h3>
                  {item.titleZh && <p className="etf-original">{item.title}</p>}
                  {item.keyPointsZh.length > 0 && (
                    <ul className="etf-points">
                      {item.keyPointsZh.map((point) => <li key={point}>{point}</li>)}
                    </ul>
                  )}
                  <p className="etf-meta">
                    <b>r/{item.subreddit}</b>
                    {item.author && <span>u/{item.author}</span>}
                    <span>热度 {heat(item.engagement)}（{heat(item.score)} 分 · {heat(item.comments)} 评论）</span>
                    <a href={item.url} target="_blank" rel="noreferrer">原帖 <ExternalLink size={12} /></a>
                  </p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="etf-empty">首次整点评审完成后，这里会列出当前流量最高的五篇 ETF 讨论。</div>
        )}
      </section>

      <section className="etf-section" aria-labelledby="etf-tracking">
        <h2 id="etf-tracking"><Coins size={18} /> 24 小时追踪（{activeTracked.length} 篇进行中）</h2>
        {activeTracked.length ? (
          <div className="etf-track-list">
            {activeTracked.map((post) => (
              <article className="etf-track-row" key={post.id}>
                <div>
                  <h3><a href={post.url} target="_blank" rel="noreferrer">{post.titleZh || post.title}</a></h3>
                  <p className="etf-meta">
                    <b>r/{post.subreddit}</b>
                    {post.author && <span>u/{post.author}</span>}
                    <span>入选于北京时间 {formatBeijingMinute(post.firstTrackedAt)}</span>
                    <span>追踪至 {formatBeijingMinute(post.trackingUntil)}</span>
                  </p>
                </div>
                <div className="etf-track-heat">
                  <TrendBars observations={post.observations} />
                  <p>最新 {heat(post.latestEngagement)} · 峰值 {heat(post.peakEngagement)}</p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="etf-empty">入选前五的帖子会在这里持续追踪 24 小时的热度轨迹。</div>
        )}
      </section>

      <section className="etf-section" aria-labelledby="etf-kol">
        <h2 id="etf-kol"><Users size={18} /> 近 7 天热门 KOL</h2>
        {view.topAuthors.length ? (
          <div className="etf-kol-list">
            {view.topAuthors.map((author) => (
              <div key={author.author}>
                <b>u/{author.author}</b>
                <span>{author.posts} 篇入选 · 峰值热度 {heat(author.peakEngagement)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="etf-empty">追踪一段时间后，这里会汇总最常进入前五、热度最高的发帖人。</div>
        )}
      </section>

      <section className="etf-section" aria-labelledby="etf-daily">
        <h2 id="etf-daily">历史日报</h2>
        {view.dailyDigests.length ? view.dailyDigests.map((digest) => (
          <article className="etf-digest" key={digest.periodKey}>
            <header>
              <h3>{digest.titleZh}</h3>
              <span>{digest.generator === "ai" ? "AI 统整" : "规则统整"} · {digest.content.stats.selections} 次评审 · {digest.content.stats.uniquePosts} 篇</span>
            </header>
            <p>{digest.content.overviewZh}</p>
            <ul className="etf-digest-posts">
              {digest.content.topPosts.slice(0, 5).map((post) => (
                <li key={post.url}>
                  <a href={post.url} target="_blank" rel="noreferrer">{post.titleZh || post.title}</a>
                  <span>r/{post.subreddit} · 峰值 {heat(post.peakEngagement)}</span>
                </li>
              ))}
            </ul>
          </article>
        )) : (
          <div className="etf-empty">每天北京时间 00:00 会把前一天的追踪成果统整成一份日报保存在这里。</div>
        )}
      </section>

      <section className="etf-section" aria-labelledby="etf-weekly">
        <h2 id="etf-weekly">每周最完整整理</h2>
        {view.weeklyDigest ? (
          <article className="etf-digest etf-digest-weekly">
            <header>
              <h3>{view.weeklyDigest.titleZh}</h3>
              <span>{view.weeklyDigest.generator === "ai" ? "AI 统整" : "规则统整"} · {view.weeklyDigest.content.stats.selections} 次评审 · {view.weeklyDigest.content.stats.uniquePosts} 篇</span>
            </header>
            <p>{view.weeklyDigest.content.overviewZh}</p>
            <ul className="etf-digest-posts">
              {view.weeklyDigest.content.topPosts.map((post) => (
                <li key={post.url}>
                  <a href={post.url} target="_blank" rel="noreferrer">{post.titleZh || post.title}</a>
                  <span>r/{post.subreddit} · 峰值 {heat(post.peakEngagement)}</span>
                </li>
              ))}
            </ul>
          </article>
        ) : (
          <div className="etf-empty">每周一北京时间 00:00 会把过去 7 天的日报统整成一份最完整的周报。</div>
        )}
      </section>

      <p className="etf-footnote">存储模式：{view.storageMode === "postgres" ? "PostgreSQL 数据库" : "内存示范模式"}。所有内容均保留 Reddit 原帖链接，翻译与重点整理不改写原始事实。</p>
    </main>
  );
}
