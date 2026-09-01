# ETFs 热门话题

左侧导览新增「ETFs 热门话题」专区（`/etf-topics`）：只采集 Reddit 平台的 ETF 讨论，把热门 KOL、高流量、热点多的帖子翻译成简体中文并做重点整理，按小时评审、按日与按周统整。

## 节奏

| 频率 | 动作 |
| --- | --- |
| 每小时 | GitHub Actions 用 Playwright 采集 `r/ETFs`、`r/investing`、`r/Bogleheads`、`r/dividends`、`r/stocks` 的热门帖（含作者、分数、评论数），并回访仍在追踪窗口内、已跌出热门列表的帖子；服务器选出本小时流量最高的前 5 篇，翻译并整理重点 |
| 入选后 24 小时 | 每小时记录一次热度观察（分数、评论、综合热度、当轮名次），5 篇/小时 × 24 小时 = 同时最多 120 篇 |
| 每天北京时间 00:00 | 把前一天的全部整点评审统整成日报，保存到历史（页面「历史日报」区块） |
| 每周一北京时间 00:00 | 把过去 7 天统整成一份最完整的周报 |

统整由 00:00 的整点评审触发，并带自动补漏：某次排程失败时，下一个小时的评审会发现缺口并补建日报／周报，不会丢失一天。

## 数据流

1. `.github/workflows/etf-topics.yml` 每小时执行 `scripts/run-etf-topics.ts`。
2. 脚本先读取公开的 `/api/etf-topics` 得到追踪中的帖子清单，再用 `lib/collectors/etf-reddit.ts`（Reddit JSON 优先、Playwright shreddit DOM 备援）采集热门列表并回访追踪帖，POST 到 `CRON_SECRET` 保护的 `/api/cron/etf-topics`。每条线路的成败与原因都会打印到 workflow 日志。
3. Reddit 会封锁部分数据中心网段（GitHub Actions 的 IP 常拿到 403 或空壳页面）。因此当远端批次为空时，服务器（Render）会自行采集一次：配置 `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` 时走 Reddit 官方 OAuth API（`oauth.reddit.com`，最稳定的正规管道），未配置时退回公开 JSON 列表；追踪帖回访同样在服务器端补齐。
4. 服务器（`app/api/cron/etf-topics/route.ts`）：
   - `lib/etf-topics.ts` 做 fail-open 的逐帖校验（坏帖跳过并计数）、ETF 相关性过滤（`r/ETFs` 全收，其余需命中 ETF 关键词或代码）、按热度（分数 + 2×评论）选出前五；
   - `lib/etf-summarize.ts` 生成简体中文标题与 2–4 条重点整理：配置 `OPENAI_API_KEY` 时用 Responses API（输入视为不受信任、不得补写事实），失败或未配置时退回内建翻译与句子抽取，永不阻塞评审；
   - `lib/etf-db.ts` 保存追踪帖、热度观察与整点前五快照（PostgreSQL 表见 `db/migrations/20260901_etf_topics.sql`；未配置数据库时用内存模式）。
5. 日报／周报（`buildEtfDailyDigest` / `buildEtfWeeklyDigest`）从整点快照聚合：去重取峰值热度、统计 subreddit 分布与热门 KOL，总结文字同样是 AI 优先、规则兜底。

## 接口

- `GET /api/etf-topics`：公开读取模型——最新整点前五、追踪中帖子与热度轨迹、近 7 天日报、最新周报。
- `POST /api/cron/etf-topics`：仅供排程（Bearer `CRON_SECRET`）。

## 测试

`npm run test:etf` 覆盖：批次校验与坏帖跳过、相关性过滤、前五排序、北京时间小时键／跨日／跨周计算、24 小时追踪窗口到期、120 篇上限、日报与周报聚合及规则式总结。
