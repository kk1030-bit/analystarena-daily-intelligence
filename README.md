# AnalystArena Daily Intelligence

把官方公告、新聞、Reddit 與 X 的公開訊號整理成「可審核、可發布、可保存 PDF」的每日投資情報。

## 第二版流程

1. RSS 與 Playwright 蒐集公開內容。
2. 先過濾例行 SEC 公告，再以事件相似度合併素材。
3. 從每個事件提取摘要、2–4 個重要資訊與市場影響，再依時效性、跨來源層數、可信度及互動計分。
4. 套用分類配額與來源上限，避免單一來源洗版。
5. 有 `OPENAI_API_KEY` 時，使用 Responses API 做繁中翻譯、事實重點提取、AI 摘要、事件再合併與市場影響判斷。
6. 每天建立「草稿」，由 `/review` 人工編輯後按下「發布日報」。
7. 發布時由伺服器把前五大事件排版成正式 PDF，與內容一起存入 PostgreSQL；首頁只顯示最新已發布版本，`/archive` 提供歷史 PDF。

## 本機啟動

```bash
npm install
copy .env.example .env.local
npm run dev
```

未設定 `DATABASE_URL` 時會使用程序記憶體，適合介面測試但重啟即消失。正式部署必須使用 PostgreSQL。

## 必要環境變數

- `DATABASE_URL`：PostgreSQL 連線字串。
- `ADMIN_TOKEN`：登入人工審核台及保護寫入 API。
- `CRON_SECRET`：保護 `/api/cron/daily`。
- `OPENAI_API_KEY`：啟用 AI 摘要、翻譯、事件合併與影響判斷。
- `X_AUTH_TOKEN`：選用；放在 GitHub Actions repository secret。未設定時 X Playwright 會安全跳過登入限定搜尋。
- `ENABLE_BROWSER_COLLECTORS=true`：只供本機測試直接啟用 Playwright；Render 正式環境保持 `false`。

## 每日排程

`.github/workflows/daily-brief.yml` 每天台北時間 07:00 在 GitHub Actions 執行 Playwright，再把 Reddit/X 素材傳給 Render 產生草稿。請把與 Render 相同的 `CRON_SECRET` 加入 GitHub Actions repository secret；需要 X 登入搜尋時，再加入 `X_AUTH_TOKEN`。

Playwright 不直接跑在 Render，避免免費方案的記憶體被 Chromium 耗盡而重啟服務。

## 部署注意

Render 免費 Web Service 沒有持久磁碟，因此 PDF 直接存 PostgreSQL。免費 Render Postgres 目前 30 天到期，只適合測試；長期使用需選擇付費 Render Postgres 或外部持久 PostgreSQL。
