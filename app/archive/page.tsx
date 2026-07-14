import Link from "next/link";
import { FileDown, Radar } from "lucide-react";
import { listBriefs, storageMode } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  const records = await listBriefs("published", 100).catch(() => []);
  return (
    <main className="standalone-page">
      <header className="standalone-header">
        <Link href="/" className="standalone-brand"><span><Radar size={21} /></span>AnalystArena</Link>
        <Link href="/review" className="text-link">人工審核 →</Link>
      </header>
      <section className="archive-hero">
        <span>HISTORICAL INTELLIGENCE</span>
        <h1>歷史日報與 PDF</h1>
        <p>每次正式發布都會把當日內容與 PDF 快照一起保存。儲存模式：{storageMode() === "postgres" ? "PostgreSQL" : "記憶體示範模式"}。</p>
      </section>
      <section className="archive-list">
        {records.length ? records.map((record) => (
          <article key={record.id}>
            <div><span>{record.date}</span><h2>{record.brief.headlines[0]?.title ?? "Daily Intelligence"}</h2><p>{record.brief.stats.topStories} 則頭條 · {record.brief.stats.candidates} 則候選素材</p></div>
            {record.hasPdf && <a className="primary-button" href={`/api/briefs/${record.id}/pdf`} target="_blank" rel="noreferrer"><FileDown size={16} />PDF</a>}
          </article>
        )) : <div className="archive-empty">目前尚無已發布日報。請先到人工審核頁產生草稿並發布。</div>}
      </section>
    </main>
  );
}
