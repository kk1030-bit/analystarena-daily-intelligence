# AnalystArena Daily Intelligence

投資人每日市場情報 MVP。它會收集公開的官方 RSS、Google News 搜尋 RSS、Reddit RSS，以及 Google 對 X 貼文的搜尋索引，合併重複事件後產生影響分數、可信度、社群熱度與觀察清單。

## 第一版功能

- 內建一份完整示範日報，沒有任何金鑰也能使用。
- 點擊「立即更新」後蒐集公開來源並重新排序事件。
- 有 `OPENAI_API_KEY` 時，以 Responses API 產生繁體中文研究摘要；失敗時自動使用內建規則。
- 依總體經濟、AI、半導體、加密資產、ETF、財報及地緣政治篩選。
- 使用瀏覽器列印功能輸出 A4 PDF。
- 已包含 `render.yaml`、健康檢查與 Render 所需的啟動設定。

## 本機執行

```bash
npm install
copy .env.example .env.local
npm run dev
```

打開 `http://localhost:3000`。若不設定 OpenAI 金鑰，蒐集、合併、分類與評分仍可運作。

## Render

把此資料夾推到 GitHub 後，在 Render 建立 Blueprint 並選擇這個 repository。`render.yaml` 會建立 Web Service；在 Render 後台填入 `OPENAI_API_KEY` 即可啟用 AI 摘要。

## 第一版邊界

- Reddit 使用公開 RSS，X 使用搜尋引擎索引，不保存登入狀態。
- 目前按需產生日報，尚未加入資料庫與歷史版本。
- PDF 使用瀏覽器的列印/另存 PDF，以確保繁體中文字型與網頁版面一致。
- 正式上線前應加入排程、持久化儲存、來源權限檢查與人工審核流程。
