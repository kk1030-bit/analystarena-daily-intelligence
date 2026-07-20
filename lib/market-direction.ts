import type {
  EquityImpactAssessment,
  EquityImpactDirection,
  Headline,
  MarketDirection,
} from "./types";

export interface DirectionPresentation {
  direction: MarketDirection;
  label: string;
  compactLabel: string;
  symbol: "↑" | "↓" | "↕" | "—";
  explanation: string;
}

const presentations: Record<MarketDirection, Omit<DirectionPresentation, "direction">> = {
  bullish: {
    label: "潜在利好",
    compactLabel: "利好",
    symbol: "↑",
    explanation: "事件目前呈现较明确的正面传导，但不等同于股价一定上涨。",
  },
  bearish: {
    label: "潜在利空",
    compactLabel: "利空",
    symbol: "↓",
    explanation: "事件目前呈现较明确的负面传导，但不等同于股价一定下跌。",
  },
  mixed: {
    label: "多空并存",
    compactLabel: "多空",
    symbol: "↕",
    explanation: "事件同时包含正面与负面因素，不同公司可能出现相反影响。",
  },
  neutral: {
    label: "方向待确认",
    compactLabel: "待确认",
    symbol: "—",
    explanation: "现有证据不足以支持单一方向，应等待更多价格或官方信息。",
  },
};

export function equityDirectionPresentation(direction: EquityImpactDirection): DirectionPresentation {
  const marketDirection: MarketDirection = direction === "potential_upside"
    ? "bullish"
    : direction === "potential_downside"
      ? "bearish"
      : direction === "mixed"
        ? "mixed"
        : "neutral";
  return { direction: marketDirection, ...presentations[marketDirection] };
}

function visibleEquityImpacts(headline: Headline): EquityImpactAssessment[] {
  return (headline.equityImpacts ?? []).filter((item) => {
    const effectiveConfidence = Math.min(item.mappingConfidence, item.directionConfidence ?? item.mappingConfidence);
    return item.reviewStatus !== "rejected" && effectiveConfidence >= 60;
  });
}

export function headlineMarketDirection(headline: Headline): MarketDirection {
  const impacts = visibleEquityImpacts(headline);
  const upside = impacts.some((item) => item.direction === "potential_upside");
  const downside = impacts.some((item) => item.direction === "potential_downside");
  const mixed = impacts.some((item) => item.direction === "mixed");
  if (mixed || (upside && downside)) return "mixed";
  if (headline.marketDirection) return headline.marketDirection;
  if (upside) return "bullish";
  if (downside) return "bearish";
  return headline.sentiment === "positive" ? "bullish" : headline.sentiment === "negative" ? "bearish" : "neutral";
}

export function headlineDirectionConfidence(headline: Headline): number {
  const impacts = visibleEquityImpacts(headline);
  const confidences = impacts.map((item) => Math.min(item.mappingConfidence, item.directionConfidence ?? item.mappingConfidence));
  const inferredDirection = headlineMarketDirection(headline);
  const equityDirections = new Set(impacts.map((item) => item.direction));
  const equitiesOverrideHeadline = inferredDirection === "mixed"
    && (equityDirections.has("mixed") || (equityDirections.has("potential_upside") && equityDirections.has("potential_downside")));

  if (!equitiesOverrideHeadline && headline.directionConfidence !== undefined && Number.isFinite(headline.directionConfidence)) {
    return Math.max(1, Math.min(99, Math.round(headline.directionConfidence)));
  }
  if (confidences.length) return Math.max(1, Math.min(99, Math.round(Math.min(headline.confidence, Math.max(...confidences)))));
  return Math.max(1, Math.min(99, Math.round(Math.min(headline.confidence, headline.sentiment === "neutral" ? 55 : 52))));
}

export function headlineDirectionPresentation(headline: Headline): DirectionPresentation {
  const direction = headlineMarketDirection(headline);
  return { direction, ...presentations[direction] };
}

export function headlineDirectionRationale(headline: Headline): string {
  if (headline.directionRationale?.trim()) return headline.directionRationale.trim();
  const impacts = visibleEquityImpacts(headline);
  const upside = impacts.filter((item) => item.direction === "potential_upside").map((item) => item.symbol);
  const downside = impacts.filter((item) => item.direction === "potential_downside").map((item) => item.symbol);
  const mixed = impacts.filter((item) => item.direction === "mixed").map((item) => item.symbol);

  if (upside.length && downside.length) {
    return `影响因公司而异：${upside.join("、")} 潜在受益；${downside.join("、")} 潜在承压。`;
  }
  if (upside.length) return `${upside.join("、")} 的主要传导方向为潜在受益，仍需验证事件是否落实到订单、利润或估值。`;
  if (downside.length) return `${downside.join("、")} 的主要传导方向为潜在承压，仍需确认影响范围与持续时间。`;
  if (mixed.length) return `${mixed.join("、")} 同时存在正面与负面因素，暂不适合用单一涨跌结论概括。`;
  return presentations[headlineMarketDirection(headline)].explanation;
}

export function marketDirectionCounts(headlines: Headline[]): Record<MarketDirection, number> {
  return headlines.reduce<Record<MarketDirection, number>>((counts, headline) => {
    counts[headlineMarketDirection(headline)] += 1;
    return counts;
  }, { bullish: 0, bearish: 0, mixed: 0, neutral: 0 });
}

export function formatReturn(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(2)}%`;
}
