import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Side-effect module: load .env/.env.local into process.env BEFORE any module
 * that creates the pg Pool at import time (replay-weather → tradeCommon →
 * db/client). Must be the FIRST import of the CLI entrypoint.
 */
for (const file of [".env.local", ".env"]) {
  try {
    const txt = readFileSync(join(process.cwd(), file), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // missing file is fine
  }
}
