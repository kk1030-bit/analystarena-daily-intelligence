# AnalystArena Daily Intelligence

> 本週開發主線：[7/21–7/26 可稽核投資晨報迭代任務](docs/tasks/2026-07-21-07-26-auditable-daily-brief.md) · [GitHub Issue #12](https://github.com/kk1030-bit/analystarena-daily-intelligence/issues/12)

把官方公告、新闻、Reddit 与 X 的公开信号整理成“可审核、可发布、可保存 PDF”的每日投资情报。

## 在线入口

| 功能 | 网址 |
| --- | --- |
| 网站首页 | [analystarena-daily-intelligence.onrender.com](https://analystarena-daily-intelligence.onrender.com/) |
| 今日热搜榜 | [/trending](https://analystarena-daily-intelligence.onrender.com/trending) |
| ETFs 热门话题 | [/etf-topics](https://analystarena-daily-intelligence.onrender.com/etf-topics) |
| 历史日报与 PDF | [/archive](https://analystarena-daily-intelligence.onrender.com/archive) |
| 人工审核台（需要管理员凭证） | [/review](https://analystarena-daily-intelligence.onrender.com/review) |
| Reddit 数据服务说明 | [/api/v1/reddit](https://analystarena-daily-intelligence.onrender.com/api/v1/reddit) |
| Reddit 搜索接口 | [/api/v1/reddit/search](https://analystarena-daily-intelligence.onrender.com/api/v1/reddit/search) |
| 美股搜索接口 | [/api/v1/stocks/search](https://analystarena-daily-intelligence.onrender.com/api/v1/stocks/search) |
| 新闻关联美股接口 | [/api/v1/stocks/beneficiaries](https://analystarena-daily-intelligence.onrender.com/api/v1/stocks/beneficiaries) |
| 进程健康检查 | [/api/health](https://analystarena-daily-intelligence.onrender.com/api/health) |
| 数据库与配置就绪检查（需管理员凭证） | [/api/readiness](https://analystarena-daily-intelligence.onrender.com/api/readiness) |
| GitHub 仓库 | [kk1030-bit/analystarena-daily-intelligence](https://github.com/kk1030-bit/analystarena-daily-intelligence) |

`/trending` 提供今日热搜榜：置顶当日焦点，并可切换热搜榜、财经榜与科技榜；榜单综合市场影响、发布时间、跨来源验证与讨论热度，每十分钟自动更新，也可手动刷新。

首页“今日简报”在打开后会立即取得共享实时快照，并在页面可见期间每十分钟自动更新。所有访客共用同一批采集结果，避免重复触发来源；若本轮采集或翻译失败，页面会保留上一份完整内容并提示更新失败，不会用空白或示范数据覆盖正在阅读的简报。标题、摘要、重要信息与市场影响必须完成简体中文翻译，未通过检查的新快照不会替换旧内容。

每个成功触发的刷新批次现在都会保存为不可变快照：来源标题、主要来源或 AI 合并顺序改变时，正式事件 ID 仍保持不变；证据或结构化判断改变时才新增事件版本，排名与时效分则保存在当次快照。发布后的刷新不会覆盖正式日报或 PDF。完整设计、迁移与验证方式见 [事件身份与不可变版本历史](docs/event-history.md)。

## 可稽核的 What Changed

每则事件同时计算两种差异：`previous_observation` 对照同日上一份成功快照，用于确认十分钟刷新或审核操作实际改变了什么；`previous_published` 对照上一份正式发布日报的冻结快照，用于告诉投资人相对上一版正式报告新增了什么。中间草稿不会把投资人差异清零。

系统会区分首次发现、首次进入与重新进榜，并分别记录证据新增／明确撤回、数字、方向及排名变化。来源暂时限流或本轮未抓到不会被误判为证据移除；撤回必须指定准确的事件版本、证据版本、原因及经服务端密钥 HMAC 处理的匿名审计身份，并建立新的不可变事件版本。排名变化只写入快照差异，不制造事件内容版本。

发布不会重新采集或重建日报：系统只会原子提升审核台看到的同一个不可变快照，并在同一数据库事务写入快照 hash、PDF SHA-256、匿名操作者、原因、请求 ID 与发布时间。审核后若日报指针、内容或快照权威发生变化，发布会直接失败并要求重新审核。

当前算法身份为 `what-changed/v1`；经测试锁定的源代码实作 hash、比较输入／结果 hash 与逐项 change hash 都会持久化。迁移前资料只标记 `legacy_unverified`，不会补造昨日差异；发布时服务器会从 PostgreSQL 重新载入并重算权威比较，缺少记录、端点／hash 不完整或请求内容与权威结果不一致时一律拒绝发布。完整表结构、双基线语义及 fail-closed 错误码见 [事件身份与不可变版本历史](docs/event-history.md#what-changed不可变比较模型)。

首页先呈现“今日快速结论、首要事件、下一观察点”，再展开完整事件列表。事件卡片以绿色、红色、黄色与灰色区分潜在利好、潜在利空、多空并存与方向待确认；“事件推演”与市场已经发生的 1 日／5 日行情分开显示，避免把预测误读成事实。手机端采用可横向浏览的卡片与大尺寸触控目标，选择事件或社交信号后会自动进入对应详情。

## Reddit 数据服务

采集到的 Reddit 帖子可保存到 PostgreSQL，并通过带凭证的公开搜索接口提供给团队程序。正式环境必须同时配置 `DATABASE_URL` 与 `REDDIT_SEARCH_API_TOKEN`；任何一项缺失时，搜索接口会返回 `503`，避免在未受保护或未持久化的状态下对外提供数据。

```bash
curl "https://analystarena-daily-intelligence.onrender.com/api/v1/reddit/search?q=Nvidia&subreddit=stocks&limit=20" \
  -H "Authorization: Bearer $REDDIT_SEARCH_API_TOKEN"
```

接口也支持 `X-API-Key` 请求头。查询参数、响应格式与状态码请参阅 [Reddit 搜索接口文档](docs/reddit-search-api.md)。仓库与文档不会保存真实凭证。

## 美股资料库与新闻影响辨识

项目内置 89 支核心流动性美股的首批真实资料，包含公司主档、5,518 条近三个月日线、公司别名与人工整理的业务暴露标签。资料由 `yfinance==1.5.1` 取得，GitHub Actions 每天北京时间 05:30 更新后，通过 `CRON_SECRET` 保护的同步端点写入 PostgreSQL；07:00 的日报随后使用最新资料。

新闻进入日报后会先匹配股票代码、公司名称与已审核别名，再根据有限的业务暴露规则判断直接主体、供应链或宏观传导关系。每项结果保存：

- 潜在受益、潜在承压、多空并存或方向待确认；
- 公司关系、映射可信度与可解释的传导机制；
- 判断假设、反向情景及事件发生前可用的行情时间；
- 人工审核状态。审核人员可在 `/review` 批准或驳回；可信度 70% 以上仍待审核的映射会阻止发布，发布后的市场头条完整研究 PDF 会保存同一份已审核结果。

映射可信度表示“新闻与公司之间的关系是否充分”，不是上涨概率。仅有 Reddit/X 的单一传闻会把可信度限制在 45，不能进入首页的潜在受益列表。完整同步、接口与调用说明见 [美股情报接口文档](docs/stock-intelligence-api.md)。

## 第四版流程

1. RSS 与 Playwright 采集公开内容；GitHub Actions 另以 [crawl4ai](https://github.com/unclecode/crawl4ai) 打开 Official/News 条目的文章页面，保存全文的不可变捕获与逐句引用证据（见 [crawl4ai 全文采集器](docs/crawl4ai-collector.md)），同一篇文章的全文捕获在排序时优先于 RSS 摘要。
2. 保存来源原始发布时间，并统一显示到“年、月、日、时、分”（北京时间）；来源没有精确时间时明确标为采集时间。
3. 先过滤例行 SEC 公告，再以事件相似度合并素材。
4. 从每个事件提取摘要、2–4 个重要信息与市场影响，再依时效性、跨来源层数、可信度及互动计分。
5. 套用分类配额与来源上限，避免单一来源占满版面。
6. 动态新闻在排序后自动翻译成简体中文，并为 FOMC、ETF、SEC、GPU 等缩写补充中文术语说明。翻译服务会自动重试，并可在配置 OpenAI 后使用备用翻译；标题、摘要、重要信息与市场影响未完成翻译时，该轮实时快照会被拒绝并保留上一份完整简体中文内容。
7. 有 `OPENAI_API_KEY` 时，使用 Responses API 做事实重点提取、AI 摘要、事件再合并与市场影响判断，并统一输出简体中文。
8. 每次成功采集、手动刷新、人工审核与发布都建立不可变快照；事件使用永久 ID，并以 `previous_version_id` 保存实质变化链。
9. 每天建立“草稿”，由 `/review` 人工编辑后按下“发布日报”；过期审核页面不能覆盖更新后的草稿。
10. 发布时由服务器把 `brief.headlines` 中的全部市场头条排版成完整研究 PDF；每个事件可依内容自动延伸至多页，再与日报内容一起存入 PostgreSQL。首页只显示最新已发布版本，`/archive` 提供历史 PDF。
11. Reddit 与 X 浏览器采集器记录每次尝试、失败原因与实际使用的降级来源；凭证与敏感参数不会进入日志或对外状态说明。

## 市场头条完整研究 PDF

发布后的日报不是网页截图，而是完整导出 `brief.headlines` 中的全部市场头条。报告先汇总当日结论与事件目录，再逐项说明每个事件的方向、关键事实、市场影响、相关美股传导、实际 1 日／5 日行情、证据缺口、下一确认点及可点击来源；单一事件内容较多时会自动延伸至后续页面，不再限制固定六页。版面以深色品牌页首配合浅色打印内容，兼顾屏幕阅读、打印与中文字体清晰度。

封面会直接摘要每则事件的潜在利好、潜在利空、多空并存及方向待确认标的；事件页则分栏列出股票代码、公司名称、关联可信度、方向证据、人工审核状态与完整传导逻辑。PDF 预览接口会在输出前重新补算与市场头条页面相同的股票映射，避免网页有标的而报告遗漏。

## 本机启动

```bash
npm install
copy .env.example .env.local
npm run dev
```

未设置 `DATABASE_URL` 时会使用程序内存，适合界面测试但重启即消失。正式部署必须使用 PostgreSQL。

## 必要环境变量

- `DATABASE_URL`：PostgreSQL 连接字符串。
- `ADMIN_TOKEN`：登录人工审核台并保护写入接口。
- `AUDIT_HMAC_KEY`：至少 32 个字符的独立服务端密钥，用来把管理员凭证转换为不可逆、可关联的匿名审计身份；不得与 `ADMIN_TOKEN` 相同，也不得传到浏览器。
- `CRON_SECRET`：保护 `/api/cron/daily` 与 `/api/cron/stocks/sync`。
- `REDDIT_SEARCH_API_TOKEN`：保护公开 Reddit 搜索接口；调用方使用 Bearer Token 或 `X-API-Key`。
- `STOCK_SEARCH_API_TOKEN`：保护美股搜索与新闻关联美股接口；调用方使用 Bearer Token 或 `X-API-Key`。
- `OPENAI_API_KEY`：启用 AI 摘要、事件合并与影响判断；未设置时自动翻译仍会运行。
- `X_AUTH_TOKEN`：可选；放在 GitHub Actions repository secret。未设置时 X Playwright 会安全跳过登录限定搜索。
- `ENABLE_BROWSER_COLLECTORS=true`：只供本机测试直接启用 Playwright；Render 正式环境保持 `false`。

## 每日排程

`.github/workflows/daily-brief.yml` 每天北京时间 07:00 在 GitHub Actions 先用 crawl4ai 采集文章全文（失败不阻塞日报），再执行 Playwright，把全文与 Reddit/X 素材一起传给 Render 生成草稿。请把与 Render 相同的 `CRON_SECRET` 加入 GitHub Actions repository secret；需要登录 X 搜索时，再加入 `X_AUTH_TOKEN`。

`.github/workflows/sync-stocks.yml` 每天北京时间 05:30 使用 yfinance 更新美股主档与近三个月日线，再分批写入 Render。它同样使用 `CRON_SECRET`，可用 GitHub repository variable `STOCK_SYNC_ENDPOINT` 覆盖目标网址。

`.github/workflows/etf-topics.yml` 每小时采集 Reddit ETF 社区的热门讨论并提交整点评审：选出流量最高的前五篇、翻译成简体中文并整理重点，入选帖持续追踪 24 小时（同时最多 120 篇）；每天北京时间 00:00 统整前一天为历史日报，每周一再统整 7 天为周报。完整设计见 [ETFs 热门话题](docs/etf-hot-topics.md)。

Playwright 不直接运行在 Render，避免免费方案的内存被 Chromium 耗尽而重启服务。

## 部署注意

Render 免费 Web Service 没有持久磁盘，因此 PDF 直接存入 PostgreSQL。免费 Render Postgres 目前 30 天到期，只适合测试；长期使用需选择付费 Render Postgres 或外部持久 PostgreSQL。

Render 的自动健康检查只调用不访问数据库的 `/api/health`，避免持续唤醒可休眠的免费 PostgreSQL；需要人工检查数据库、股票数量与凭证配置时，使用带 `ADMIN_TOKEN` Bearer 凭证的 `/api/readiness`。未授权请求不会连接数据库，因此也不会唤醒 Neon。

yfinance 官方将 Yahoo Finance 数据定位为个人研究用途。当前实现适合内部原型与产品验证；若要公开销售、展示或再分发行情，正式上线前应确认 Yahoo 条款，或替换为具有商业与再分发授权的数据供应商。数据库和辨识引擎已经把资料来源隔离，未来可替换行情提供方而不必重写日报界面。
