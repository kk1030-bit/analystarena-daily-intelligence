# AnalystArena Daily Intelligence

把官方公告、新闻、Reddit 与 X 的公开信号整理成“可审核、可发布、可保存 PDF”的每日投资情报。

## 在线入口

| 功能 | 网址 |
| --- | --- |
| 网站首页 | [analystarena-daily-intelligence.onrender.com](https://analystarena-daily-intelligence.onrender.com/) |
| 今日热搜榜 | [/trending](https://analystarena-daily-intelligence.onrender.com/trending) |
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
- 人工审核状态。审核人员可在 `/review` 批准或驳回；可信度 70% 以上仍待审核的映射会阻止发布，发布后的前五大新闻 PDF 会保存同一份已审核结果。

映射可信度表示“新闻与公司之间的关系是否充分”，不是上涨概率。仅有 Reddit/X 的单一传闻会把可信度限制在 45，不能进入首页的潜在受益列表。完整同步、接口与调用说明见 [美股情报接口文档](docs/stock-intelligence-api.md)。

## 第三版流程

1. RSS 与 Playwright 采集公开内容。
2. 保存来源原始发布时间，并统一显示到“年、月、日、时、分”（北京时间）；来源没有精确时间时明确标为采集时间。
3. 先过滤例行 SEC 公告，再以事件相似度合并素材。
4. 从每个事件提取摘要、2–4 个重要信息与市场影响，再依时效性、跨来源层数、可信度及互动计分。
5. 套用分类配额与来源上限，避免单一来源占满版面。
6. 动态新闻在排序后自动翻译成简体中文，并为 FOMC、ETF、SEC、GPU 等缩写补充中文术语说明。翻译服务会自动重试，并可在配置 OpenAI 后使用备用翻译；标题、摘要、重要信息与市场影响未完成翻译时，该轮实时快照会被拒绝并保留上一份完整简体中文内容。
7. 有 `OPENAI_API_KEY` 时，使用 Responses API 做事实重点提取、AI 摘要、事件再合并与市场影响判断，并统一输出简体中文。
8. 每天建立“草稿”，由 `/review` 人工编辑后按下“发布日报”。
9. 发布时由服务器把前五大事件排版成正式 PDF，与内容一起存入 PostgreSQL；首页只显示最新已发布版本，`/archive` 提供历史 PDF。

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
- `CRON_SECRET`：保护 `/api/cron/daily` 与 `/api/cron/stocks/sync`。
- `REDDIT_SEARCH_API_TOKEN`：保护公开 Reddit 搜索接口；调用方使用 Bearer Token 或 `X-API-Key`。
- `STOCK_SEARCH_API_TOKEN`：保护美股搜索与新闻关联美股接口；调用方使用 Bearer Token 或 `X-API-Key`。
- `OPENAI_API_KEY`：启用 AI 摘要、事件合并与影响判断；未设置时自动翻译仍会运行。
- `X_AUTH_TOKEN`：可选；放在 GitHub Actions repository secret。未设置时 X Playwright 会安全跳过登录限定搜索。
- `ENABLE_BROWSER_COLLECTORS=true`：只供本机测试直接启用 Playwright；Render 正式环境保持 `false`。

## 每日排程

`.github/workflows/daily-brief.yml` 每天北京时间 07:00 在 GitHub Actions 执行 Playwright，再把 Reddit/X 素材传给 Render 生成草稿。请把与 Render 相同的 `CRON_SECRET` 加入 GitHub Actions repository secret；需要登录 X 搜索时，再加入 `X_AUTH_TOKEN`。

`.github/workflows/sync-stocks.yml` 每天北京时间 05:30 使用 yfinance 更新美股主档与近三个月日线，再分批写入 Render。它同样使用 `CRON_SECRET`，可用 GitHub repository variable `STOCK_SYNC_ENDPOINT` 覆盖目标网址。

Playwright 不直接运行在 Render，避免免费方案的内存被 Chromium 耗尽而重启服务。

## 部署注意

Render 免费 Web Service 没有持久磁盘，因此 PDF 直接存入 PostgreSQL。免费 Render Postgres 目前 30 天到期，只适合测试；长期使用需选择付费 Render Postgres 或外部持久 PostgreSQL。

Render 的自动健康检查只调用不访问数据库的 `/api/health`，避免持续唤醒可休眠的免费 PostgreSQL；需要人工检查数据库、股票数量与凭证配置时，使用带 `ADMIN_TOKEN` Bearer 凭证的 `/api/readiness`。未授权请求不会连接数据库，因此也不会唤醒 Neon。

yfinance 官方将 Yahoo Finance 数据定位为个人研究用途。当前实现适合内部原型与产品验证；若要公开销售、展示或再分发行情，正式上线前应确认 Yahoo 条款，或替换为具有商业与再分发授权的数据供应商。数据库和辨识引擎已经把资料来源隔离，未来可替换行情提供方而不必重写日报界面。
