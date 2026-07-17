# 美股资料库与新闻影响辨识接口

## 数据范围

- 首批 89 支核心流动性美股，覆盖科技、半导体、金融、医疗、能源、工业、消费与航空等行业。
- 公司资料、股票代码、Yahoo 代码、公司别名、业务暴露标签。
- 最近三个月日线：开盘、最高、最低、收盘、复权收盘、成交量、股息及拆股。
- 数据库表：`stock_profiles`、`stock_prices_daily`、`stock_sync_runs`。
- 同步为幂等写入；同一股票同一交易日重复执行会更新，不会新增重复日线。

## 凭证

Render 设置 `STOCK_SEARCH_API_TOKEN` 后，调用方可任选一种请求头：

```http
Authorization: Bearer <STOCK_SEARCH_API_TOKEN>
```

```http
X-API-Key: <STOCK_SEARCH_API_TOKEN>
```

真实凭证不得提交到 GitHub。正式环境没有 PostgreSQL 时，查询接口会返回 `503`。

## 搜索股票

```bash
curl "https://analystarena-daily-intelligence.onrender.com/api/v1/stocks/search?q=Nvidia&limit=10" \
  -H "Authorization: Bearer $STOCK_SEARCH_API_TOKEN"
```

`q` 可搜索股票代码、公司名称、行业及业务暴露标签；`limit` 为 1–100。响应会附上该股票最新一条可用日线。

## 辨识新闻关联美股

```bash
curl -X POST "https://analystarena-daily-intelligence.onrender.com/api/v1/stocks/beneficiaries" \
  -H "Authorization: Bearer $STOCK_SEARCH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "NVIDIA raises Blackwell revenue guidance as demand surges",
    "summary": "The company cited stronger data-center orders.",
    "ticker": "NVDA",
    "sourceType": "News",
    "publishedAt": "2026-07-17T01:00:00Z"
  }'
```

输入字段：

- `title`：必填，最多 500 字符。
- `summary`、`marketImpact`：可选，用于补充语境。
- `keyPoints`：可选字符串数组，最多 8 项。
- `ticker`：可选的界面事件标签；辨识引擎不会把这个字段单独当成股票证据，股票代码或公司名必须实际出现在标题、摘要、要点或市场影响文字中。
- `sourceType`：`Official`、`News`、`Reddit` 或 `X`。
- `publishedAt`：可选 ISO 8601 时间。

输出最多五家公司，并提供方向、公司关系、映射可信度、传导机制、假设、反向情景、证据类型和可用行情时间。仅有社交媒体来源时，映射可信度最高为 45。

若提供 `publishedAt`，接口会使用事件发生日或之前的最近一个交易日行情，避免把事件后的价格倒灌进判断。时间必须是带时区的 RFC 3339 格式。

## 手动生成或同步资料

```powershell
python -m pip install -r scripts\requirements-yfinance.txt
python scripts\sync-yfinance.py --output data\us-stocks-core.json
```

直接写入 Render：

```powershell
$env:CRON_SECRET="与 Render 相同的排程密钥"
python scripts\sync-yfinance.py --endpoint "https://analystarena-daily-intelligence.onrender.com/api/cron/stocks/sync"
```

正式环境必须连接 PostgreSQL；同步程序会核对服务器回传的运行编号、存储模式与保存数量。行情覆盖不足、资料过旧或仅部分抓取成功时会以非零状态结束，让 GitHub Actions 明确报警；严重失败只登记失败运行，不会用残缺行情覆盖生产资料。

同步接口只接受 `CRON_SECRET` Bearer Token；单批最多 150 个公司资料与 5,000 条日线，并限制请求大小为 8 MB。

## 判断边界

- yfinance 只提供公司与行情资料，不会直接判断新闻利好或利空。
- 股票候选必须存在于数据库；模型或规则不得自由发明代码。
- 当日股价表现仅作为市场背景，不用于证明新闻因果。
- 只有映射可信度达到 70 的项目才显示在首页关联美股栏。
- 结果是研究线索，不构成投资建议或买卖指令。
