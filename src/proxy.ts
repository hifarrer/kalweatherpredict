import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Auth gate for the whole app (Next 16 proxy convention, formerly middleware).
 *
 * Unauthenticated requests: pages redirect to /login, API routes get 401.
 * /login and /api/login stay open; static assets are excluded by the matcher.
 */
export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  const isLoginPage = pathname === "/login";
  const isLoginApi = pathname === "/api/login";
  // External-cron endpoints authenticate with CRON_SECRET inside the route
  const isCronApi = pathname.startsWith("/api/cron/");

  if (isCronApi) {
    return NextResponse.next();
  }

  if (session) {
    // Already logged in: bounce off the login page back to the dashboard
    if (isLoginPage) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (isLoginPage || isLoginApi) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except Next internals and static files
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)",
  ],
};
