# AnalystArena Daily Intelligence

把官方公告、新闻、Reddit 与 X 的公开信号整理成“可审核、可发布、可保存 PDF”的每日投资情报。

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
- `OPENAI_API_KEY`：启用 AI 摘要、事件合并与影响判断；未设置时自动翻译仍会运行。
- `X_AUTH_TOKEN`：可选；放在 GitHub Actions repository secret。未设置时 X Playwright 会安全跳过登录限定搜索。
- `ENABLE_BROWSER_COLLECTORS=true`：只供本机测试直接启用 Playwright；Render 正式环境保持 `false`。

## 每日排程

`.github/workflows/daily-brief.yml` 每天台北時間 07:00 在 GitHub Actions 執行 Playwright，再把 Reddit/X 素材傳給 Render 產生草稿。請把與 Render 相同的 `CRON_SECRET` 加入 GitHub Actions repository secret；需要 X 登入搜尋時，再加入 `X_AUTH_TOKEN`。

Playwright 不直接跑在 Render，避免免費方案的記憶體被 Chromium 耗盡而重啟服務。

## 部署注意

Render 免費 Web Service 沒有持久磁碟，因此 PDF 直接存 PostgreSQL。免費 Render Postgres 目前 30 天到期，只適合測試；長期使用需選擇付費 Render Postgres 或外部持久 PostgreSQL。
