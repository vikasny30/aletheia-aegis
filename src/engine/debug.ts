/**
 * Aletheia Aegis: Opt-in local debug log (D6).
 *
 * Off by default. When the AEGIS_DEBUG_LOG environment variable names a file
 * path, check_output appends one JSON line per evaluation including the full
 * response text and findings — the one thing telemetry deliberately never
 * stores. This exists so a deployer can debug a false positive from the
 * record instead of guessing.
 *
 * Rules: local file only, appended by this process. Never exposed as an MCP
 * resource, never sent anywhere, and never enabled unless the operator sets
 * the variable. The log may contain secrets and sensitive user content:
 * keep the file local, restrict its permissions, and do not share it.
 * A write failure never breaks the guard — it is silently skipped.
 */

import fs from "node:fs";

export class DebugLogger {
  private readonly file: string | null;

  constructor(filePath?: string) {
    const target = filePath ?? process.env.AEGIS_DEBUG_LOG ?? "";
    this.file = target.trim().length > 0 ? target.trim() : null;
    // The log holds full responses, secrets included: owner-only permissions,
    // also for a file that already exists with looser ones.
    if (this.file) {
      try {
        if (fs.existsSync(this.file)) fs.chmodSync(this.file, 0o600);
      } catch {
        // Never break the guard over logging.
      }
    }
  }

  get enabled(): boolean {
    return this.file !== null;
  }

  log(record: Record<string, unknown>): void {
    if (!this.file) return;
    try {
      fs.appendFileSync(
        this.file,
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      // Debug logging must never break the guard.
    }
  }
}
