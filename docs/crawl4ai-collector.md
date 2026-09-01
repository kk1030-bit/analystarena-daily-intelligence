# crawl4ai 全文采集器

第四版流程原本只保存 RSS 条目的标题与摘要，AI 摘要与市场影响判断因此只能依据几十个词的片段。crawl4ai 全文采集器把公开来源的文章正文纳入证据链：GitHub Actions 在生成日报前，用 [crawl4ai](https://github.com/unclecode/crawl4ai) 打开每条 RSS 条目对应的文章页面，保存可稽核的正文捕获与逐句引用证据。

## 数据流

1. `scripts/crawl4ai_collect.py`（Python，GitHub Actions 内执行）重新读取与服务器相同的 Official/News RSS 来源，用 crawl4ai 打开每条条目的文章页面，把可见正文（fit markdown）与发布时间元数据写入 `crawl-results.json`（schema `crawl4ai-collect/v1`）。脚本永远退出 0：整体失败时输出空结果并记录原因，日报回退为仅使用 RSS 与社群来源。
2. `lib/collectors/crawl4ai.ts`（TypeScript 转接层）把每页转换为证据链故事：
   - `detail_page` 不可变捕获：正文的确切 UTF-8 字节、SHA-256 哈希、采集时间与提取方法；
   - `html_text_quote` 证据：`article:title` 与 `article:lead` 两条引用，引文必须是捕获字节的确切子串；没有可引用的段落时保存显式的 `unavailable` 证据，绝不伪造；
   - 身份对接：条目带 `guid` 时沿用与 RSS 条目相同的 feed-native 文档身份，因此全文捕获与摘要条目是同一 source document 的两次观察，不会分叉出重复事件。
   转换完全复用服务器的 `ensureRawStoryIdentity` / `createSourceEvidence` / `assertEvidenceBoundToSourceCapture`，无法证明的页面被丢弃并记录原因，不会降级成不可验证的元数据。
3. `scripts/run-daily.ts` 把全文故事与 Playwright 社群故事合并成同一批次，POST 到 `/api/cron/daily`。
4. 服务器端 `safeRemoteStories` 新增 News/Official `detail_page` 校验路径：哈希、时间戳语义、canonical 身份与“引文确在捕获字节内”全部 fail closed 重验。
5. 排序去重时（`deduplicateStories`），同一 source document 的全文捕获永远优先于 feed 摘要作为代表文本；两次观察都仍保存在不可变来源历史中。

## 已知边界

- Google News 条目的跳转页 (`news.google.com/rss/articles/…`) 被其 robots.txt 拒绝；采集器尊重 robots（`check_robots_txt=True`），这些条目保持原有的 RSS 摘要路径。后续可加入直接提供文章网址的出版商 RSS 来扩大全文覆盖。
- 正文以渲染后的可见文本（markdown）保存，单页上限 200 KB，超出部分截断并在提取方法中标注。
- 采集失败、正文过短（少于 400 字节）、落在跳转/同意页的页面都会被标记 `ok=false` 并附原因，不进入证据链。

## 本机测试

```bash
pip install -r scripts/requirements-crawl4ai.txt
crawl4ai-setup
python scripts/crawl4ai_collect.py --output crawl-results.json
CRAWL4AI_OUTPUT=crawl-results.json npx tsx scripts/run-daily.ts   # 需要 CRON_SECRET
```

单元测试：`npx tsx scripts/test-crawl4ai-adapter.ts` 与 `npx tsx scripts/test-remote-detail-ingestion.ts`（已并入 `npm run test:brief`）。
