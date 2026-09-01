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

## What Changed：不可变比较模型

7/23 的差异不是在读取日报时临时拼接的摘要，而是和比较端点一起永久保存的审计记录：

- `event_version_comparisons` 保存当前事件版本、前一事件版本、比较状态、算法版本、输入／结果 hash 与比较时间；`event_version_change_items` 保存每个可独立核查的 before、after、reason code、证据版本及 change hash。
- `event_version_numeric_facts` 保存从原始 claim 提取的结构化数值；`event_version_numeric_fact_evidence` 以外键保证每个数值确实由同一事件版本、同一 claim 的精确 evidence version 支持。
- `brief_snapshot_event_changes` 保存快照层的在榜状态与排名比较；`brief_snapshot_event_change_items` 保存排名上升、下降、进入或重新进入等差异。排名变化不会创建事件内容版本。
- 上述比较表、算法表、数值事实及明确撤回请求全部由数据库 trigger 拒绝 `UPDATE`／`DELETE`。

事件版本只与确定的比较端点比较。v1 没有前一版本时只能产生 `first_seen`；v2 必须指向同一事件的相邻 v1，不能跨过版本或在版本链缺口上生成差异。系统可辨识：

- 证据新增、同一 evidence item 的内容修订，以及 claim 与证据支持关系的新增、移除或改变；
- 有精确单位及证据绑定的数值变化；
- 明确市场方向从未建立到建立，或由原方向改变；
- 其他 claim 或结构化状态的实质改变。

数值比较采用保守规则：只解析有精确证据支持的原始 claim，并保存主体系、指标、期间、规范数值、单位、币别、原始 token、文字偏移、parser version 与不可比较原因。日期、年份、产品型号及缺少明确单位或上下文的数字不会被猜成财务指标。

### 双基线

同一快照为每个事件保存两份不同用途的比较，不能互相替代：

| 基线 | 精确定义 | 用途 |
| --- | --- | --- |
| `previous_observation` | 同一日报日期、序号相邻的上一份成功快照 | 说明本轮采集／审核相对上一轮发生了什么，供营运排错与十分钟更新监测 |
| `previous_published` | 当前日报之前最近一份已发布日报所冻结的 `current_snapshot_id` | 说明投资人相对上一份正式报告真正新看到什么，不会因中间草稿或审核快照而被清零 |

基线快照含有同一事件时，内容比较使用该基线实际引用的事件版本，而排名比较使用两份快照中的排名。基线没有该事件时：

- 数据库从未观察过该事件：`first_seen`；
- 基线未包含、历史也未出现：`entered`；
- 基线未包含，但更早存在同一正式事件 ID 的观察：`reentered`。

`entered`／`reentered` 只说明榜单存在性，不能自行推导“证据增加”“方向转多”或排名变化。没有可比较排名时，`previous_rank` 与 `rank_delta` 必须为空，`rank_movement` 为 `not_comparable`。排名差定义为 `previous_rank - current_rank`，正数表示排名上升，负数表示下降。

### 证据撤回不是采集缺失

来源暂时超时、限流或本轮未抓到时，旧证据仍保留，不会产生 `evidence_removed`。撤回必须建立不可变的 `evidence_retraction_requests`，并精确指定：

- 事件、from／to 事件版本、evidence item 及 evidence version；
- 若仅撤回某条判断的支持关系，还要指定同一版本中的 claim ID 与 claim key；
- `source_retracted`、`invalid_locator`、`duplicate`、`review_rejected` 或 `superseded` 原因，以及非空说明；
- 应用该操作的 collection run、时间、`actor_type` 与服务端 keyed-HMAC `actor_id_hash`；如有替代证据则记录 replacement evidence version。

撤回会建立新的事件版本。若某条 claim 的最后一份支持证据被撤回，该 claim 必须降级为待确认，不能让旧的已确认状态继续通过发布。

### 算法身份、旧数据与发布闸门

比较算法由不可变的 `comparison_algorithms` 注册。当前版本为 `what-changed/v1`，实作 hash 为：

```text
f510adc0e7a9f8987d9ea5bba2e0a886e764745a0b7eed9ea2f20ad7bbe2c01c
```

该值是把 `lib/what-changed.ts` 中 hash 字面值替换成固定占位符、统一 LF 后计算的 SHA-256；测试会从源文件重新计算并核对。每笔比较同时保存 `algorithm_version`、`input_hash`、`result_hash`，每个 change item 另存 `change_hash`。应用启动与发布核验发现数据库注册 hash 和执行中实作不一致时会失败，不能用同一版本号静默替换算法。

迁移前的事件版本与快照只回填 `legacy_unverified`／`no_baseline`；它们没有运行当时不存在的算法，所以不会伪造证据、数字、方向或排名差异。旧资料若要取得可验证差异，必须由新采集建立有完整证据链的新版本。

发布时不信任请求 payload 内的 `whatChanged`。服务器会从 PostgreSQL 重新载入当前快照、两个基线快照、事件版本、比较项与算法注册，重算并核对端点及 hash。出现下列任一情况即 fail closed：

- `WHAT_CHANGED_AUTHORITY_MISSING`：权威比较记录缺失；
- `WHAT_CHANGED_AUTHORITY_MISMATCH`：payload 与数据库权威结果不一致；
- `WHAT_CHANGED_INTERNAL_INTEGRITY_INVALID`：算法、端点、输入或结果的内部完整性不成立。

人工审核或明确撤回若建立新事件版本，该版本同时记录 `actor_type`（`system`／`admin`／`legacy`）、不可逆 keyed-HMAC `actor_id_hash`、修改原因与服务端 request ID；即使审核没有改变事件内容，审核快照仍保存同一组操作者字段。明确撤回请求另存同一审计身份，并以不可变关联表逐项绑定实际产生的 `evidence_removed`／`claim_support_removed`。

发布不再重跑持久化流程，而是在单一事务锁定 `daily_briefs`，核对提交内容、草稿 payload 与 `current_snapshot_id` 都指向同一份已审核快照，再原地提升。`brief_publication_audits` 永久保存该快照的 payload hash、PDF SHA-256、匿名操作者、原因、request ID 及发布时间；该表和撤回关联表都禁止更新或删除。管理员明文 token 与 `AUDIT_HMAC_KEY` 均不写入数据库、payload 或日志。

## 交易及不可变保证

事件解析、版本新增、日报快照、快照事件关系、每日草稿更新及 collection run 成功状态会在同一个 PostgreSQL transaction 中提交。使用 advisory lock、事件行锁、唯一约束及幂等 batch key，避免多个 Render instance 同时写入时产生分叉。

以下表由数据库 trigger 拒绝 `UPDATE`／`DELETE`：

- `source_document_versions`
- `event_versions`
- `brief_snapshots`
- `brief_snapshot_events`
- `comparison_algorithms`
- `event_version_comparisons`
- `event_version_change_items`
- `event_version_numeric_facts`
- `event_version_numeric_fact_evidence`
- `evidence_retraction_requests`
- `brief_snapshot_event_changes`
- `brief_snapshot_event_change_items`

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
DATABASE_URL=postgresql://... npm run test:what-changed:postgres
```

目前的十分钟刷新仍由打开中的网页触发。现在可以保证“任何实际触发且成功的批次都会永久保存”，但不能声称“没有访客时也会每十分钟自动采集”；真正的全天候十分钟排程属于后续自动排程迭代。
