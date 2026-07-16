import { unstable_cache } from "next/cache";
import { buildLiveBrief } from "./pipeline";

export function hotSearchBatchKey(now = Date.now()): string {
  return String(Math.floor(now / 600_000));
}

export function normalizeHotSearchBatchKey(value?: string): string {
  const current = Number(hotSearchBatchKey());
  if (!value || !/^\d{1,16}$/.test(value)) return String(current);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return String(current);
  const bucket = numeric >= 100_000_000_000 ? Math.floor(numeric / 600_000) : numeric;
  // Public routes may only address the active or immediately previous batch.
  // This keeps shared deep links useful without letting arbitrary query values
  // create unbounded cache keys and trigger repeated collection work.
  return bucket === current || bucket === current - 1 ? String(bucket) : String(current);
}

export function getCachedHotSearchBrief(batchKey?: string) {
  const safeBatchKey = normalizeHotSearchBatchKey(batchKey);
  return unstable_cache(
    () => buildLiveBrief({ useAi: false, useBrowserCollectors: false }),
    ["analystarena-hot-search-v2", safeBatchKey],
    { revalidate: 600 },
  )();
}
