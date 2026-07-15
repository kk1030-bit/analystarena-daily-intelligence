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
| 服务健康检查 | [/api/health](https://analystarena-daily-intelligence.onrender.com/api/health) |
| GitHub 仓库 | [kk1030-bit/analystarena-daily-intelligence](https://github.com/kk1030-bit/analystarena-daily-intelligence) |

`/trending` 提供今日热搜榜：置顶当日焦点，并可切换热搜榜、财经榜与科技榜；榜单综合市场影响、发布时间、跨来源验证与讨论热度，每十分钟自动更新，也可手动刷新。

## Reddit 数据服务

采集到的 Reddit 帖子可保存到 PostgreSQL，并通过带凭证的公开搜索接口提供给团队程序。正式环境必须同时配置 `DATABASE_URL` 与 `REDDIT_SEARCH_API_TOKEN`；任何一项缺失时，搜索接口会返回 `503`，避免在未受保护或未持久化的状态下对外提供数据。

```bash
curl "https://analystarena-daily-intelligence.onrender.com/api/v1/reddit/search?q=Nvidia&subreddit=stocks&limit=20" \
  -H "Authorization: Bearer $REDDIT_SEARCH_API_TOKEN"
```

接口也支持 `X-API-Key` 请求头。查询参数、响应格式与状态码请参阅 [Reddit 搜索接口文档](docs/reddit-search-api.md)。仓库与文档不会保存真实凭证。

## 第三版流程

1. RSS 与 Playwright 采集公开内容。
2. 保存来源原始发布时间，并统一显示到“年、月、日、时、分”（台北时间）；来源没有精确时间时明确标为采集时间。
3. 先过滤例行 SEC 公告，再以事件相似度合并素材。
4. 从每个事件提取摘要、2–4 个重要信息与市场影响，再依时效性、跨来源层数、可信度及互动计分。
5. 套用分类配额与来源上限，避免单一来源占满版面。
6. 动态新闻在排序后自动翻译成简体中文，并为 FOMC、ETF、SEC、GPU 等缩写补充中文术语说明。未配置 OpenAI 时使用无需密钥的翻译通道与规则分析；翻译通道不可用时保留原文，不中断日报。
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
- `CRON_SECRET`：保护 `/api/cron/daily`。
- `REDDIT_SEARCH_API_TOKEN`：保护公开 Reddit 搜索接口；调用方使用 Bearer Token 或 `X-API-Key`。
- `OPENAI_API_KEY`：启用 AI 摘要、事件合并与影响判断；未设置时自动翻译仍会运行。
- `X_AUTH_TOKEN`：可选；放在 GitHub Actions repository secret。未设置时 X Playwright 会安全跳过登录限定搜索。
- `ENABLE_BROWSER_COLLECTORS=true`：只供本机测试直接启用 Playwright；Render 正式环境保持 `false`。

## 每日排程

`.github/workflows/daily-brief.yml` 每天台北时间 07:00 在 GitHub Actions 执行 Playwright，再把 Reddit/X 素材传给 Render 生成草稿。请把与 Render 相同的 `CRON_SECRET` 加入 GitHub Actions repository secret；需要登录 X 搜索时，再加入 `X_AUTH_TOKEN`。

Playwright 不直接运行在 Render，避免免费方案的内存被 Chromium 耗尽而重启服务。

## 部署注意

Render 免费 Web Service 没有持久磁盘，因此 PDF 直接存入 PostgreSQL。免费 Render Postgres 目前 30 天到期，只适合测试；长期使用需选择付费 Render Postgres 或外部持久 PostgreSQL。
