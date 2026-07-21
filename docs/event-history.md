# 事件身份与不可变版本历史

本项目把“当前日报工作副本”和“历史事实”分开保存：

- `daily_briefs` 继续保留每天一份草稿或正式日报，供审核与发布流程使用。
- `collection_runs` 记录每次 shared、manual、cron、review、publish 等写入尝试，并以 `(stream, batch_key)` 保证幂等。
- `brief_snapshots` 保存每次成功结果。每个日期使用连续 `sequence_number`，并通过 `previous_snapshot_id` 形成不可变链。
- `brief_snapshot_events` 保存当次排名、时效分、提及量及实际引用的事件版本；这些会变化的日报指标不会制造假的事件内容版本。
- `events` 保存一经建立便不再重算的正式事件 ID。
- `event_aliases` 把来源文件 ID、规范网址及旧 ID 绑定到正式事件；普通写入不能把已存在的 alias 转移给另一事件。
- `event_versions` 只在证据或结构化判断实质改变时新增，并以 `previous_version_id` 串成版本链。
- `source_documents` 与 `source_document_versions` 分开保存来源身份及原文修订历史。

## 身份规则

来源文件优先使用发布平台的原生身份：

1. X：`status` 数字 ID。
2. Reddit：贴文 ID。
3. SEC：accession number。
4. RSS／Atom：feed namespace 加 GUID／entry ID。
5. 其他来源：规范网址的 SHA-256。

网址规范化只统一协议与主机名，保留区分资源所必需的路径大小写和功能查询参数；只删除 fragment、`utm_*`、`gclid`、`fbclid` 等追踪参数。`twitter.com`／`x.com` 以及 Reddit 的常见主机名会统一处理。

事件解析顺序固定为：已有正式事件 ID → 已绑定来源 alias → 高置信语义比对 → 建立新事件。有两个既有事件同时被来源命中时，整次交易会以 `EVENT_IDENTITY_CONFLICT` 失败，不会自行挑选其中一个。

## 版本规则

事件版本把三种变化分开：

- `evidence_hash`：来源文件身份及来源内容修订。
- `state_hash`：分类、方向、影响程度及相关股票等结构化判断。
- `presentation_hash`：标题、摘要、重点及解释文案。

`content_hash` 由 evidence 与 state 计算。翻译、标题文案、排名、时效分或 `generatedAt` 不会单独制造事件版本；它们仍完整保存在每轮 `brief_snapshots`。若状态出现 A → B → A，会建立 v1 → v2 → v3，不会因为 v3 的 hash 曾出现而丢弃最后一次转变。

来源暂时采集失败时，既有事件证据会保留。需要撤销或标记失效的来源，必须在后续证据状态功能中明确处理，不能用“本轮没抓到”当作删除依据。

## 交易及不可变保证

事件解析、版本新增、日报快照、快照事件关系、每日草稿更新及 collection run 成功状态会在同一个 PostgreSQL transaction 中提交。使用 advisory lock、事件行锁、唯一约束及幂等 batch key，避免多个 Render instance 同时写入时产生分叉。

以下表由数据库 trigger 拒绝 `UPDATE`／`DELETE`：

- `source_document_versions`
- `event_versions`
- `brief_snapshots`
- `brief_snapshot_events`

正式日报只允许从 draft 发布一次。发布后的实时刷新会继续新增快照，但不会修改已发布 payload 或 PDF。

## 迁移与旧数据

启动时会取得 PostgreSQL advisory lock，依文件名顺序执行 `db/migrations/*.sql`，并写入 `schema_migrations`。失败的 schema 初始化会解除进程内缓存，下一次请求可以安全重试。

`20260721_event_history.sql` 会把原有 `daily_briefs` 回填为 `legacy` 快照与事件版本，但不会修改原始日报 JSON、发布状态或 PDF。无法用强来源确认的旧事件标为 `legacy_unmatched`，不会用相似标题强行串接。

## 验证

```bash
npm run test:brief
npm run lint
npm run build
```

真实 PostgreSQL 交易、并发、外键与不可变 trigger 必须另外验证：

```bash
DATABASE_URL=postgresql://... npm run test:events:postgres
```

目前的十分钟刷新仍由打开中的网页触发。现在可以保证“任何实际触发且成功的批次都会永久保存”，但不能声称“没有访客时也会每十分钟自动采集”；真正的全天候十分钟排程属于后续自动排程迭代。
