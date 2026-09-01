import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { storageMode } from "@/lib/db";
import {
  getActiveEtfTracked,
  getEtfDigest,
  saveEtfDigest,
  saveEtfIngest,
  type EtfNewTrackedInput,
  type EtfObservation,
} from "@/lib/etf-db";
import { collectEtfServerSide } from "@/lib/etf-reddit-server";
import { buildEtfDailyDigest, buildEtfWeeklyDigest, enrichEtfPosts } from "@/lib/etf-summarize";
import {
  etfBeijingDate,
  etfBeijingHourKey,
  isEtfRelevant,
  lastCompletedBeijingWeek,
  previousBeijingDate,
  selectTopEtfPosts,
  validateEtfBatch,
  type EtfSelectionItem,
} from "@/lib/etf-topics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Digest catch-up: the 00:00 Beijing review consolidates the finished day, and
 * the first review of a new week consolidates the finished week. Because this
 * runs on every ingest and only fills gaps, a missed hourly run self-heals on
 * the next one instead of silently losing a day.
 */
async function catchUpDigests(observedAt: string): Promise<{ daily?: string; weekly?: string }> {
  const built: { daily?: string; weekly?: string } = {};
  const previousDate = previousBeijingDate(etfBeijingDate(new Date(observedAt)));
  if (!(await getEtfDigest("daily", previousDate))) {
    const daily = await buildEtfDailyDigest(previousDate);
    if (daily) {
      await saveEtfDigest(daily);
      built.daily = daily.periodKey;
    }
  }
  const week = lastCompletedBeijingWeek(new Date(observedAt));
  if (!(await getEtfDigest("weekly", week.periodKey))) {
    const weekly = await buildEtfWeeklyDigest(week.startDate, week.endDate);
    if (weekly) {
      await saveEtfDigest(weekly);
      built.weekly = weekly.periodKey;
    }
  }
  return built;
}

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "排程密钥（CRON_SECRET）尚未设置" }, { status: 503 });
  if (!isCronRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  try {
    const body = await request.json().catch(() => ({}));
    const batch = validateEtfBatch(body);
    const active = await getActiveEtfTracked(batch.observedAt);
    const activeById = new Map(active.map((post) => [post.id, post]));

    // Reddit blocks some collector network paths (GitHub Actions IPs), so an
    // empty remote batch triggers server-side collection before the review.
    let posts = batch.posts;
    let serverCollector: string | undefined;
    if (!posts.length) {
      const collected = await collectEtfServerSide(active.map((post) => post.url));
      posts = validateEtfBatch({ observedAt: batch.observedAt, posts: collected.posts }).posts;
      const status = collected.status;
      serverCollector = `${status.backend ?? status.name}：${status.ok ? `${posts.length} 篇` : status.note ?? "失败"}`;
    }

    const relevant = posts.filter((post) => isEtfRelevant(post.subreddit, post.title, post.body));
    const selection = selectTopEtfPosts(relevant);
    const selectedIds = new Set(selection.map((post) => post.id));

    const needsEnrichment = selection.filter((post) => !activeById.get(post.id)?.titleZh);
    const enrichment = await enrichEtfPosts(needsEnrichment);

    const selectionItems: EtfSelectionItem[] = selection.map((post, index) => {
      const tracked = activeById.get(post.id);
      const enriched = enrichment.get(post.id);
      return {
        postId: post.id,
        rank: index + 1,
        engagement: post.engagement,
        score: post.score,
        comments: post.comments,
        title: post.title,
        titleZh: enriched?.titleZh ?? tracked?.titleZh ?? "",
        keyPointsZh: enriched?.keyPointsZh ?? tracked?.keyPointsZh ?? [],
        url: post.url,
        subreddit: post.subreddit,
        author: post.author,
      };
    });

    const newTracked: EtfNewTrackedInput[] = selection
      .filter((post) => !activeById.has(post.id))
      .map((post) => {
        const enriched = enrichment.get(post.id);
        return {
          post,
          titleZh: enriched?.titleZh ?? "",
          keyPointsZh: enriched?.keyPointsZh ?? [],
          generator: enriched?.generator ?? "deterministic",
        };
      });

    // Selected posts and already-tracked posts seen this hour both get an
    // engagement observation; the relevance gate only guards new selections.
    const observations: EtfObservation[] = posts
      .filter((post) => selectedIds.has(post.id) || activeById.has(post.id))
      .map((post) => ({
        postId: post.id,
        observedAt: batch.observedAt,
        score: post.score,
        comments: post.comments,
        engagement: post.engagement,
        rank: selectedIds.has(post.id) ? selection.findIndex((item) => item.id === post.id) + 1 : null,
      }));

    const saved = await saveEtfIngest({
      observedAt: batch.observedAt,
      beijingHour: etfBeijingHourKey(new Date(batch.observedAt)),
      selection: selectionItems,
      newTracked,
      observations,
    });
    const digests = await catchUpDigests(batch.observedAt);

    return NextResponse.json({
      ok: true,
      storageMode: storageMode(),
      received: batch.posts.length,
      ...(serverCollector ? { serverCollector, collectedServerSide: posts.length } : {}),
      skipped: batch.skipped,
      relevant: relevant.length,
      selected: selectionItems.length,
      newlyTracked: newTracked.length,
      activeTracked: saved.activeTracked,
      observations: observations.length,
      ...(digests.daily ? { dailyDigest: digests.daily } : {}),
      ...(digests.weekly ? { weeklyDigest: digests.weekly } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "ETF 热门话题评审失败" }, { status: 500 });
  }
}
