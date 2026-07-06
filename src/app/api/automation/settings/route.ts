import { NextRequest, NextResponse } from "next/server";
import {
  getAutomationSettings,
  saveAutomationSettings,
} from "@/lib/autoSettings";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getAutomationSettings();
  return NextResponse.json({ settings });
}

/** Partial update — unknown keys are ignored, values are clamped server-side. */
export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const settings = await saveAutomationSettings(body as Record<string, never>);
  return NextResponse.json({ settings });
}
