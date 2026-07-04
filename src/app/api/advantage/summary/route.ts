import { NextResponse } from "next/server";
import { getAdvantageScan, getAdvantageSummary } from "@/lib/advantage";
import { isAiConfigured } from "@/lib/analyze";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!isAiConfigured()) {
    return NextResponse.json(
      { error: "AI is not configured. Set ANTHROPIC_API_KEY." },
      { status: 503 },
    );
  }
  try {
    const scan = await getAdvantageScan();
    if (scan.rows.length === 0) {
      return NextResponse.json({ summary: "No opportunities to summarize right now." });
    }
    const summary = await getAdvantageSummary(scan);
    return NextResponse.json({ summary, generatedAt: scan.generatedAt });
  } catch (err) {
    console.error("Advantage summary failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Summary failed" },
      { status: 500 },
    );
  }
}
