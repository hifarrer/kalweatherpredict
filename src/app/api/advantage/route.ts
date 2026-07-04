import { NextRequest, NextResponse } from "next/server";
import { getAdvantageScan } from "@/lib/advantage";
import { syncEventsIfNeeded } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const force = req.nextUrl.searchParams.get("refresh") === "1";
    // Make sure the events cache is reasonably fresh before scanning
    await syncEventsIfNeeded();
    const scan = await getAdvantageScan(force);
    return NextResponse.json(scan);
  } catch (err) {
    console.error("Advantage scan failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scan failed" },
      { status: 500 },
    );
  }
}
