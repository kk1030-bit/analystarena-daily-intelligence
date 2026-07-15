# Reddit 搜索接口

正式接口地址：`https://analystarena-daily-intelligence.onrender.com/api/v1/reddit/search`

接口读取 PostgreSQL 中由每日 Reddit RSS 与 Playwright 采集器持续写入的帖子。每次采集会更新相同帖子，并保留首次写入时间、最新采集时间、原始发布时间、来源与互动数。

## 身份验证

建议使用 Bearer Token：

```http
Authorization: Bearer <REDDIT_SEARCH_API_TOKEN>
```

也支持 `X-API-Key` 请求头。凭证只能放在团队服务器的环境变量或秘密管理工具内，不要写进浏览器前端或提交到 Git。

## 搜索示例

```bash
curl "https://analystarena-daily-intelligence.onrender.com/api/v1/reddit/search?q=Nvidia&subreddit=stocks&limit=20" \
  -H "Authorization: Bearer $REDDIT_SEARCH_API_TOKEN"
```

支持的查询参数：

- `q`：标题、正文与 subreddit 全文搜索，最多 200 字符。
- `subreddit`：例如 `stocks` 或 `r/stocks`。
- `from`、`to`：ISO 8601 日期或时间；只提供日期时会覆盖该日的完整 UTC 时间。
- `limit`：每页 1 至 100 条，默认 25 条。
- `cursor`：下一页请原样传回上一次响应中的 `pagination.nextCursor`。

## 响应格式

```json
{
  "data": [
    {
      "id": "abc123",
      "subreddit": "stocks",
      "title": "...",
      "description": "...",
      "url": "https://www.reddit.com/r/stocks/...",
      "source": "r/stocks RSS fallback",
      "engagement": 0,
      "publishedAt": "2026-07-15T01:23:45.000Z",
      "collectedAt": "2026-07-15T01:30:00.000Z",
      "timestampKind": "published",
      "createdAt": "2026-07-15T01:30:01.000Z",
      "updatedAt": "2026-07-15T01:30:01.000Z"
    }
  ],
  "pagination": { "limit": 20, "nextCursor": null },
  "query": { "q": "Nvidia", "subreddit": "stocks", "from": null, "to": null },
  "meta": { "count": 1, "storageMode": "postgres" }
}
```

状态码：`200` 成功、`400` 查询参数错误、`401` 凭证错误、`503` 凭证或 PostgreSQL 尚未配置。
