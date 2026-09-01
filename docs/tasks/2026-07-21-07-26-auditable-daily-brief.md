# 7/21–7/26｜可稽核投資晨報迭代任務

> Canonical task（正式任務）：[GitHub Issue #12](https://github.com/kk1030-bit/analystarena-daily-intelligence/issues/12)<br>
> Execution branch（執行分支）：`agent/auditable-brief-0721-0726`<br>
> Period（期間）：2026-07-21 至 2026-07-26<br>
> Current status（目前狀態）：7/23 What Changed 已完成正式站部署、真實採集、人工審核、發布、PDF 與歷史歸檔驗收；下一項為 7/24 Thesis Impact 與待驗證問題。

## 使用方式

後續開發者或 Agent 在開始本週任務前，必須先讀取本文件與 Issue #12。對話摘要、記憶或臨時說明不得取代這兩個正式來源。

每完成一天的項目，必須同步更新：

1. 本文件的任務勾選與交付紀錄。
2. Issue #12 的對應勾選項。
3. PR、commit、migration、測試與 Render 驗收證據。

缺少上述證據時，不得把任務標記為完成。

## 本週目標

把目前的「摘要型 Daily Brief」升級成「每個判斷都能追到證據、知道與上一版有何不同」的可稽核投資晨報。

```mermaid
gantt
    title 本週更新迭代計畫｜7/21－7/26
    dateFormat YYYY-MM-DD
    axisFormat %m/%d

    section 資料底座
    穩定事件 ID 與版本資料表       :crit, done, a1, 2026-07-21, 1d
    來源文件與引用片段保存          :crit, done, a2, after a1, 1d

    section 智能分析
    前後版本比較與 What Changed     :crit, done, a3, after a2, 1d
    Thesis Impact 與待驗證問題       :a4, after a3, 1d

    section 產品呈現
    市場頭條四區塊介面與逐句引用    :a5, after a4, 1d
    PDF 同步輸出全部市場頭條         :a6, after a4, 1d

    section 品質與部署
    資料回填、自動測試、正式站驗收   :crit, a7, after a5, 1d
```

## 每日更新內容

| 日期 | 更新方向 | 當天交付結果 | 狀態 |
|---|---|---|---|
| 7/21 | 資料庫底座 | 建立穩定事件 ID、事件版本、前一版本關聯；每次實際觸發的十分鐘更新不再覆蓋舊資料 | 已完成 |
| 7/22 | 來源證據鏈 | 同時保存原始發布時間、採集時間、網址、內容雜湊、引用片段及可驗證定位 | 已完成（正式站驗收） |
| 7/23 | What Changed | 自動比較上一版本，標記首次出現、新增證據、數字變動、方向與排名變化 | 已完成（正式站驗收） |
| 7/24 | 投資判斷 | 結構化記錄營收／獲利／估值／風險影響、利好與利空標的、原判斷與新判斷 | 待執行 |
| 7/25 | 網頁及 PDF | 每則市場頭條呈現「新增資訊、來源、判斷影響、待驗證問題」四區塊；PDF 包含全部頭條 | 待執行 |
| 7/26 | 驗收部署 | 測試十分鐘更新、歷史版本、來源連結、PDF、人工審核及 Render 正式站 | 待執行 |

## 執行清單

- [x] **7/21｜穩定事件 ID 與版本資料表**
  - 穩定來源文件 ID、永久事件 ID、事件 alias。
  - 來源版本、事件版本、採集批次與不可變日報快照。
  - `previous_version_id` 與 `previous_snapshot_id` 版本鏈。
  - 幂等批次、資料庫鎖、失敗回滾、發布凍結及舊資料回填。
  - 證據：[PR #11](https://github.com/kk1030-bit/analystarena-daily-intelligence/pull/11)、功能提交 `ba904c6`、正式合併 `a0e6022`。
  - 正式站驗證：PostgreSQL 快照序號 2，快照 `0e11329d-655d-4f25-9906-296ac69a9a62` 已連到上一份快照。
- [x] **7/22｜來源文件與引用片段保存**
  - [x] 為每條標題、摘要、重要資訊、市場影響及方向依據建立 claim 與 evidence record，不再只保存事件層來源清單。
  - [x] 分開保存原始發布時間、採集時間、原始時間文字、標準化網址、來源原文采集物、UTF-8 位元組數及 SHA-256。
  - [x] RSS／Atom、Reddit 及 X 的引用必須逐欄位回查原始采集物；引用、來源 ID、貼文 ID 或時間不一致時整批拒絕寫入。
  - [x] HTML 只接受可由采集物證明的精確 TextQuote；沒有結構化 DOM 證據時拒絕聲稱 CSS／段落位置。
  - [x] PDF 必須保存逐頁文字采集物，頁碼、頁內偏移及引用文字全部吻合才可使用；否則標記定位不可用。
  - [x] 引用內容改變時建立新 evidence version；A→B→A 仍保留三個依時間排序的不可變版本。
  - [x] 事件版本、完整證據集合、claim 引用、快照來源觀察及排名投影以複合外鍵綁定，發布前再與 PostgreSQL 權威資料逐欄核對。
  - [x] AI 選到有效引用不等於語義成立；AI claim 一律待確認，審核台新增逐條人工語義確認，編輯內容會清除確認。
  - [x] 歷史資料只回填為 `legacy_unverified`，不捏造原文、發布時間、段落或頁碼。
  - [x] 功能提交：`03aa498`、`18e41f6`、`e51362c`；Migration：`db/migrations/20260722_source_evidence_v2.sql`、`db/migrations/20260722_source_observation_evidence_time.sql`、`db/migrations/20260722_zz_snapshot_claim_presentations.sql`。
  - [x] Render 正式資料庫 migration、真實來源重採集、人工審核、正式發布、PDF 與歷史歸檔驗收。
- [x] **7/23｜前後版本比較與 What Changed**
  - [x] 事件內容差異與快照排名差異分表保存；排名、時效分及版面變化不建立新的事件內容版本。
  - [x] 同時建立 `previous_observation` 與 `previous_published` 雙基線：前者比較同日上一個實際快照，供營運監測；後者比較上一份已發布日報的凍結快照，供投資人閱讀。
  - [x] 精確分辨 `first_seen`、`entered` 與 `reentered`：資料庫沒有任何歷史觀察時才是首次發現；基線沒有但更早曾出現時只能標記重新進榜，不捏造內容變化。
  - [x] 分辨證據新增、證據修訂、claim 支持關係變化、數字變動、方向建立／改變及排名上升／下降；每個 change item 保存 before、after、reason code、證據版本及內容 hash。
  - [x] 暫時沒有抓到來源不視為證據移除；只有綁定確切事件版本、evidence version、原因及審計 actor 的明確撤回請求，才可建立新版本並顯示證據撤回。
  - [x] 數字只從有精確證據支持的原始 claim 提取，保存主體、指標、期間、數值、單位、幣別、原文偏移、parser version 及證據版本；日期、型號或缺少單位的數字不猜測為可比較財務數值。
  - [x] 比較演算法固定為 `what-changed/v1`，源碼實作 SHA-256 為 `f510adc0e7a9f8987d9ea5bba2e0a886e764745a0b7eed9ea2f20ad7bbe2c01c`；測試會重算該 hash，輸入、結果與每個差異項均保存 hash，不允許事後覆寫。
  - [x] 遷移前版本只標記 `legacy_unverified`，不回填推測性的證據、數字、方向或排名差異。
  - [x] 發布前從 PostgreSQL 重新載入兩個比較端點並重算；缺少權威比較、payload 與權威結果不一致或內部 hash／端點不完整時 fail closed，不得繞過證據閘門。
  - [x] 人工審核與明確證據撤回若建立新事件版本，版本保存 `actor_type`、服務端 keyed-HMAC `actor_id_hash`、修改原因及 request ID；即使事件內容未變，審核快照仍保存操作者。發布以同一事務保存精確快照 hash、PDF SHA-256 與同一組審計欄位，不保存管理員明文憑證。
  - [x] 最終驗證：隔離 PostgreSQL migration／不可變 trigger／雙基線／撤回／發布篡改回歸，全套 TypeScript、ESLint、build 與 Render 正式站驗收。
- [ ] **7/24｜Thesis Impact 與待驗證問題**
  - 結構化保存營收、獲利、估值、風險與催化劑影響。
  - 保存原判斷、新判斷、利好／利空標的與影響機制。
  - 每個待驗證問題包含驗證條件、期限、狀態與應查來源。
- [ ] **7/25｜市場頭條四區塊介面與 PDF**
  - 網頁每則事件顯示「新增資訊、來源、判斷影響、待驗證問題」。
  - 每條重要資訊可由引用編號打開原始網址、引用片段與位置。
  - PDF 同步輸出全部市場頭條及同一套引用、判斷與待驗證資料。
  - 現有「全部市場頭條 PDF」只是基礎；四區塊與逐句證據完成前，本項仍不得勾選。
- [ ] **7/26｜資料回填、自動測試與正式站驗收**
  - 回填既有來源與事件時不捏造引用、位置或昨日差異。
  - 驗證十分鐘更新、歷史版本、來源連結、PDF、人工審核與發布凍結。
  - 在全新 PostgreSQL 與正式 Render 資料庫都驗證 migration。

## 本週完成後的驗收標準

- [x] 每條「重要資訊」至少綁定一個證據來源。
- [ ] 點擊引用編號可以看到原始來源、引用片段與位置。
- [ ] 發布時間與採集時間分開顯示，統一為北京時間並精確到分鐘。
- [ ] 首次出現的事件明確標記「首次發現」，不捏造昨日差異。
- [ ] 已存在事件能顯示「上一版 → 當前版本 → 改變原因」。
- [ ] 利好、利空標的及影響機制都會寫入網站與 PDF。
- [ ] 每個待驗證問題包含驗證條件、期限及狀態。
- [x] 缺少證據的高影響判斷不能直接發布，只能降級為「待確認」。

## 不可跳過的品質規則

1. 先完成版本資料與證據鏈，再開發 What Changed、AI 判斷、介面及 PDF。
2. 每個判斷必須指向具體 evidence ID；只有事件層來源清單不算逐句證據。
3. 沒有上一版本時禁止產生「增加、下降、轉多、轉空」等差異敘述。
4. 原始發布時間與採集時間使用 UTC `TIMESTAMPTZ` 保存；只在顯示層轉成北京時間，精確到分鐘。
5. 缺少引用片段或位置的高影響判斷只能是「待確認」，不得通過發布閘門。
6. 人工修改必須建立新版本並保留修改前內容、操作者與時間。
7. 排名、時效分與版面文字不得誤觸發新的事件內容版本。

## 每日交付紀錄模板

完成後在本節追加，不得只修改上方勾選框。

```text
日期：YYYY-MM-DD
狀態：完成／部分完成／阻塞
PR：
Commit：
Migration：
自動測試：
正式站驗證：
已知限制：
下一項：
```

### 2026-07-21

- 狀態：完成並正式部署。
- PR：[PR #11](https://github.com/kk1030-bit/analystarena-daily-intelligence/pull/11)
- Commit：`ba904c6`，正式合併 `a0e6022`。
- Migration：`db/migrations/20260721_event_history.sql`。
- 自動測試：TypeScript、ESLint、日報回歸、Next.js build、PostgreSQL 17 並發與不可變歷史測試通過。
- 正式站驗證：匿名強制刷新 HTTP 200、無 fallback、PostgreSQL 成功寫入不可變快照序號 2。
- 已知限制：真正的背景十分鐘排程尚未建立；目前保證每次實際觸發的成功批次留存。
- 下一項：7/22 來源文件與引用片段保存。

### 2026-07-22

- 狀態：完成並正式部署；真實日報已通過證據閘門、人工審核、發布、PDF 與歸檔驗收。
- PR：[PR #13](https://github.com/kk1030-bit/analystarena-daily-intelligence/pull/13)。
- Commit：`03aa498`（Add auditable source evidence chain）、`18e41f6`（Expose publication authority blockers）、`e51362c`（Normalize snapshot claim presentation authority）。
- Migration：`db/migrations/20260722_source_evidence_v2.sql`、`db/migrations/20260722_source_observation_evidence_time.sql`、`db/migrations/20260722_zz_snapshot_claim_presentations.sql`；最後一項把事件版本的證據斷言與不可變日報快照的翻譯展示文字分開保存，並由快照 payload 幂等回填。
- 資料模型：新增來源版本 provenance、每次採集 observation、evidence item/version、event-version evidence、claim/evidence link 及 snapshot source observation；所有歷史表禁止更新或刪除。
- 精度規則：原始時間文字必須嚴格解析並與標準時間一致；模糊時區、無時區及不存在日期不當作發布時間。引用必須存在於來源采集物，且 feed 欄位、Reddit post ID、X status ID、HTML TextQuote 或 PDF 頁碼／偏移必須可驗證。
- 發布規則：頁面內容、事件版本、證據、來源、快照排名與股票影響均須匹配 PostgreSQL 權威資料；AI 判斷未逐條人工語義確認時不可發布，任何未審核股票影響也不可發布。
- 權威不一致修復：首次正式發布回傳 9 個 `CLAIM_AUTHORITY_MISMATCH`，精確對應排名 4–6 的 `title`、`summary`、`important_information:0`。根因是相同證據事件版本正確復用，但舊 `event_claims` 展示翻譯被拿來與新快照翻譯比較；修復後由 43 條不可變 snapshot claim presentation 管理 `statement`／`language`／`ordinal`，而原文、SHA-256、審核狀態、生成器與 57 條引用仍由事件版本逐欄核驗，未繞過證據閘門。
- 真實採集：[GitHub Actions Run 29917776918](https://github.com/kk1030-bit/analystarena-daily-intelligence/actions/runs/29917776918) 成功；94 則候選、73 個合併事件、8 則頭條，保存 15 份來源文件、30 份證據、43 條 claim 與 57 條 citation。
- 自動測試：`test:evidence:postgres`、`test:events:postgres` 在隔離 PostgreSQL 18 通過；完整 `test:brief`、TypeScript、ESLint、Next.js production build 與 `git diff --check` 全數通過。新增回歸覆蓋純翻譯不製造事件版本、展示文字／語言篡改阻擋、原文 hash／審核狀態／引用仍嚴格阻擋，以及 migration 完整回填與重跑幂等。
- 正式站驗證：Render deploy `dep-d9gcs458nd3s73euafog`（commit `e51362c`）為 Live；日報 `4d8bb0a7-67d3-4bee-8cb4-83ab2298091c` 狀態為 `published`，快照 `367ea385-796f-4b03-9133-c6503fafe63b`，8 則頭條、5/5 股票影響已批准、待審 0。[PDF](https://analystarena-daily-intelligence.onrender.com/api/briefs/4d8bb0a7-67d3-4bee-8cb4-83ab2298091c/pdf) 回傳 HTTP 200 `application/pdf`，19 頁無空白頁、缺頁碼、越界文字或壞占位符，含 29 個可點擊來源連結；[歷史歸檔](https://analystarena-daily-intelligence.onrender.com/archive) 已顯示本日報。
- 已知限制：Reddit RSS 本次受 429 限流且 Playwright 未取得結果；X 未設定原生 `X_AUTH_TOKEN`，本次由新聞索引回退取得 16 條線索。限制已明確保留，不把回退資料冒充原生平台資料。HTML／PDF 已定義 fail-closed 證據格式，但真正的詳情頁與 PDF 采集器仍屬後續工作；逐句引用投資人介面安排於 7/25。
- 下一項：7/23 前後版本比較與 What Changed。

### 2026-07-23

- 狀態：完成並正式部署；真實日報在發現語義聚類與部分重採集缺陷後，已按不可變更正鏈重新生成、人工審核及發布，並通過證據權威、PDF 與歷史歸檔驗收。
- PR：[PR #13](https://github.com/kk1030-bit/analystarena-daily-intelligence/pull/13)。
- Commit：`9cb2b67`（Build auditable What Changed comparisons）、`1128849`（Preserve auditable citation merges）、`5ca95e0`（Protect auditable event identity resolution）、`1d9547b`（Accept audited legacy rank context）、`14ed581`（Preserve 24/7 Wall St in Chinese translations）、`150a682`（Fail closed on event clustering and report corrections）、`c56d9df`（Authorize scoped semantic cluster corrections）、`7e0fc8f`（Replay published sources for same-day corrections）、`95b9c87`（Authorize exact retained-evidence claim corrections）、`831dfbb`（Remove retracted zero-evidence source links）、`4efe538`（Retain verified evidence across partial recaptures）、`a27032b`（Distinguish partial misses from evidence revisions）。
- Migration：`db/migrations/20260723_what_changed.sql`、`db/migrations/20260723_event_alias_primary_ownership.sql`、`db/migrations/20260723_what_changed_legacy_rank.sql`、`db/migrations/20260723_zzz_published_corrections.sql`。
- 比較模型：同時保存 `previous_observation` 與 `previous_published`，精確區分首次發現、進榜、重新進榜、證據新增／修訂／撤回、數字、方向與排名變化。輸入、結果及每個差異項均以 SHA-256 固定，歷史記錄只可新增，發布前從 PostgreSQL 權威端點重新載入並重算。
- 身分精度修復：只有 `role=primary` 的來源可建立事件 alias；次要佐證只可作語義提示，不能奪取或污染事件身分。Migration 會標記並隔離舊 collector ID、孤兒、混合角色及非 primary alias，保留不可變擁有權與重分配審計；解析前即 fail closed，避免先命中受污染 alias。
- 歷史資料規則：遷移前資料沒有足夠證據時只保存 `legacy_unverified`。`20260723_what_changed_legacy_rank.sql` 只容許具備同一事件／版本、確切基線快照及 `continued` 狀態的舊排名脈絡；缺少 delta、缺少基線或複合外鍵不完整的資料仍會被 PostgreSQL 拒絕。
- 缺陷處理紀錄：[Run 30015488862](https://github.com/kk1030-bit/analystarena-daily-intelligence/actions/runs/30015488862) 首次揭露舊排名約束不接受可稽核的 legacy baseline；[Run 30017205159](https://github.com/kk1030-bit/analystarena-daily-intelligence/actions/runs/30017205159) 發現 `24/7 Wall St` 被誤判為未翻譯文字；[Run 30020631210](https://github.com/kk1030-bit/analystarena-daily-intelligence/actions/runs/30020631210) 揭露語義聚類錯誤；[Run 30023248690](https://github.com/kk1030-bit/analystarena-daily-intelligence/actions/runs/30023248690) 揭露部分重採集會被誤判為未授權證據撤回。上述失敗均保持 fail closed，沒有繞過證據閘門。
- 根因與修復：聚類器原先會把出版商尾綴當作事件相似文字，且 union-find 的傳遞橋接可把兩個並不相同的事件合併；現改為「實體與事件謂詞同時成立」及 complete-linkage 群組驗證。更正流程只接受已確認、帶理由且精確鎖定既有日報／快照／payload hash 的請求，只可撤回具體次要證據或保留證據的舊 claim 關係，絕不撤回 primary evidence；當動態前八名已不含舊事件時，會重播已發布的不可變來源。部分重採集則只在新觀察是舊證據版本的精確子集時保留既有投影，真正的新版本或修訂仍必須進入可稽核更正流程。
- 初始真實採集：[GitHub Actions Run 30017746912](https://github.com/kk1030-bit/analystarena-daily-intelligence/actions/runs/30017746912) 成功；96 則候選、76 個合併事件、8 則頭條。最終例行重採集驗收：[GitHub Actions Run 30024630492](https://github.com/kk1030-bit/analystarena-daily-intelligence/actions/runs/30024630492) 成功。
- 更正發布鏈：舊日報 `9aa4b53c-673c-439d-8134-1dc33d8ccdfd` 已標記 `superseded`，並指向新日報 `9b04c217-dab8-4a03-840b-d268287d111d`；舊快照 `54e7ec70-9c99-41d9-8056-00c649e8ee58`、舊 payload SHA-256 `5435db09588bac98fba597bf6b087432541508b020495ee54b8ebc7f6e17a956` 均保持不可變。新日報狀態為 `published`，快照 `d938e09f-1fb9-4864-871e-6f87105205ac`（序號 7，前一快照 `8bd9dd5e-cfd7-4b29-8b71-ea5dd0aac4ce`），payload SHA-256 `bb23e4fa8275bf73da9f884e6f3d343ac54195237c36524305440f5779143398`。
- What Changed 結果：8 則頭條中 4 則 `changed`、2 則 `unchanged`、2 則 `legacy_unverified`，共保存 81 個差異項；首次出現與無可靠前版的事件不捏造差異。
- 人工審核：4 項股票影響全部批准、駁回 0、待審 0；排名 1 的無關 NVDA／TSLA 來源已從事件與投資影響中移除，而非只駁回股票映射。
- 自動測試：`test:events:postgres`、`test:evidence:postgres`、`test:what-changed:postgres` 均在全新 PostgreSQL 通過；`test:brief`、`test:stocks`、TypeScript、ESLint、Next.js production build 與 `git diff --check` 全數通過。回歸涵蓋雙基線、撤回授權、身份污染、alias 擁有權、複合外鍵、不可變 trigger、歷史排名及發布篡改。
- 正式站驗證：Render deploy `dep-d9h3tbjbc2fs73ag2260`（commit `a27032b`）為最終 Live 版本。新日報發布後 PATCH 回傳 409「已發布日報不可修改」。[更正後 PDF](https://analystarena-daily-intelligence.onrender.com/api/briefs/9b04c217-dab8-4a03-840b-d268287d111d/pdf) 回傳 HTTP 200 `application/pdf`，檔案 127413 bytes、18 頁，SHA-256 `0e78a9647a89d31bc905082df7a564dd544cebff66a836a7e83b7a440a5c1439`；無空白頁、越界文字或壞占位符，且被更正的無關來源不再出現。舊日報的公開 PDF 回傳 404，但管理端仍可按權限取得不可變舊 PDF 供稽核。[歷史歸檔](https://analystarena-daily-intelligence.onrender.com/archive) 只顯示更正後新日報，公開 `/api/brief` 與 `/api/briefs` 亦只提供新版本。
- 已知限制：正式站未設定付費 OpenAI 密鑰，故摘要、事件合併及市場影響仍使用可重現的規則流程；自動簡體中文翻譯正常啟用，網站也明確顯示此限制。7/23 完成的是可稽核差異資料與發布權威；投資人端四區塊及逐句引用互動仍依計畫於 7/25 完成，不提前宣稱。
- 下一項：7/24 Thesis Impact 與待驗證問題。
