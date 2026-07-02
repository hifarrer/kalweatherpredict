import { PredictionResult } from "@/types";

interface PredictionBadgeProps {
  prediction: PredictionResult | null;
}

export default function PredictionBadge({ prediction }: PredictionBadgeProps) {
  if (!prediction) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-kalshi-border text-xs text-kalshi-muted">
        <span className="inline-block w-2 h-2 rounded-full bg-gray-500" />
        No forecast available
      </div>
    );
  }

  const { verdict, forecastValue, detail } = prediction;

  const config = {
    YES: {
      bg: "bg-kalshi-green/15",
      border: "border-kalshi-green/40",
      text: "text-kalshi-green",
      dot: "bg-kalshi-green",
      label: "Forecast says: YES",
    },
    NO: {
      bg: "bg-kalshi-red/15",
      border: "border-kalshi-red/40",
      text: "text-kalshi-red",
      dot: "bg-kalshi-red",
      label: "Forecast says: NO",
    },
    UNCERTAIN: {
      bg: "bg-yellow-500/15",
      border: "border-yellow-500/40",
      text: "text-yellow-500",
      dot: "bg-yellow-500",
      label: "Uncertain",
    },
  } as const;

  const c = config[verdict];

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${c.bg} border ${c.border} text-xs font-semibold ${c.text} w-fit`}
      >
        <span className={`inline-block w-2 h-2 rounded-full ${c.dot}`} />
        {c.label}
        {forecastValue !== null && (
          <span className="ml-1 text-kalshi-text/80">({forecastValue}{prediction.unit})</span>
        )}
      </div>
      <p className="text-xs text-kalshi-muted">{detail}</p>
    </div>
  );
}
