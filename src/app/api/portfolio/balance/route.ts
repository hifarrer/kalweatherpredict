import { NextResponse } from "next/server";
import { getBalance, isTradingConfigured, KalshiTradeError } from "@/lib/kalshiTrade";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isTradingConfigured()) {
    return NextResponse.json({ configured: false, balanceCents: null });
  }
  try {
    const { balance } = await getBalance();
    return NextResponse.json({ configured: true, balanceCents: balance });
  } catch (err) {
    const message =
      err instanceof KalshiTradeError ? err.message : "Failed to fetch Kalshi balance";
    console.error("Balance fetch failed:", err);
    return NextResponse.json({ configured: true, balanceCents: null, error: message }, { status: 502 });
  }
}
