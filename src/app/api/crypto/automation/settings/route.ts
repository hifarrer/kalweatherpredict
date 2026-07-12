import { NextRequest, NextResponse } from "next/server";
import {
  getCryptoAutomationSettings,
  saveCryptoAutomationSettings,
} from "@/lib/crypto/cryptoSettings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ settings: await getCryptoAutomationSettings() });
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  // saveCryptoAutomationSettings sanitizes/clamps every field server-side
  const settings = await saveCryptoAutomationSettings(
    (body ?? {}) as Record<string, never>,
  );
  return NextResponse.json({ settings });
}
