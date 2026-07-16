import Link from "next/link";
import { FileDown, Radar } from "lucide-react";
import { listBriefs, storageMode } from "@/lib/db";
import { localizeText } from "@/lib/translation";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  const records = await listBriefs("published", 100).catch(() => []);
  const localizedTitles = await Promise.all(records.map((record) => localizeText(record.brief.headlines[0]?.title ?? "每日市场情报")));
  return (
    <main className="standalone-page">
      <header className="standalone-header">
        <Link href="/" className="standalone-brand"><span><Radar size={21} /></span>AnalystArena</Link>
        <nav className="standalone-links" aria-label="历史日报导览">
          <Link href="/trending" className="text-link">今日热搜</Link>
          <Link href="/review" className="text-link">人工审核 →</Link>
        </nav>
      </header>
      <section className="archive-hero">
        <span>历史市场情报</span>
        <h1>历史日报与 PDF</h1>
        <p>每次正式发布都会把当日内容与 PDF 快照一起保存。存储模式：{storageMode() === "postgres" ? "PostgreSQL 数据库" : "内存示范模式"}。</p>
      </section>
      <section className="archive-list">
        {records.length ? records.map((record, index) => (
          <article key={record.id}>
            <div><span>{record.date}</span><h2>{localizedTitles[index]}</h2><p>{record.brief.stats.topStories} 则头条 · {record.brief.stats.candidates} 则候选素材</p></div>
            {record.hasPdf && <a className="primary-button" href={`/api/briefs/${record.id}/pdf`} target="_blank" rel="noreferrer"><FileDown size={16} />PDF</a>}
          </article>
        )) : <div className="archive-empty">目前尚无已发布日报。请先到人工审核页生成草稿并发布。</div>}
      </section>
    </main>
  );
}
