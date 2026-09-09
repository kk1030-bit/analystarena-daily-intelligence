-- ETFs 热门话题功能已取消：移除其全部数据表。
-- 该功能从未成功采集（一周的整点评审全部为 0 篇），表中没有有价值的数据。

DROP TABLE IF EXISTS etf_topic_observations;
DROP TABLE IF EXISTS etf_topic_selections;
DROP TABLE IF EXISTS etf_topic_digests;
DROP TABLE IF EXISTS etf_topic_posts;
