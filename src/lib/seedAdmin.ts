import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/lib/auth";

/**
 * Ensure the admin user from ADMIN_EMAIL/ADMIN_PASSWORD exists.
 *
 * Runs on server startup (instrumentation). If the email already exists the
 * password is NOT overwritten — change it by updating the row or clearing it.
 */
export async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.warn(
      "seedAdmin: ADMIN_EMAIL/ADMIN_PASSWORD not set — no admin user seeded. Login will be impossible until they are set.",
    );
    return;
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing.length > 0) return;

  const passwordHash = await hashPassword(password);
  await db.insert(users).values({ email, passwordHash, role: "admin" });
  console.log(`seedAdmin: created admin user ${email}`);
}
