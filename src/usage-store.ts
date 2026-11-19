/**
 * Shared, persistent knowledge about each Claude account's plan usage.
 *
 * Claude Code reports a `rate_limit_event` with every response, including the
 * utilization and reset time of the 5-hour and weekly windows. Every Pi process
 * (for example each T3 Code thread) records the latest values in one JSON file,
 * so all processes route with the same picture and it survives restarts.
 *
 * Writes are best-effort and atomic (temp file + rename). Each process only
 * updates the account it just observed, merged into the latest file contents,
 * so concurrent writers lose at most one usage sample, which the next response
 * replaces anyway.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UsageWindow {
  /** 0..1 */
  utilization: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
  status?: string;
}

export interface AccountUsage {
  windows: Record<string, UsageWindow>;
  /** Epoch ms until which the account is known to be out of capacity. */
  limitedUntil?: number;
  limitedReason?: string;
  /** Recent conversations pinned to this account (epoch ms), for spreading bursts. */
  assignments?: number[];
  updatedAt?: number;
}

export interface UsageFile {
  version: 1;
  accounts: Record<string, AccountUsage>;
}

const ASSIGNMENT_WINDOW_MS = 15 * 60_000;
const MAX_ASSIGNMENTS = 50;

function toMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

function emptyFile(): UsageFile {
  return { version: 1, accounts: {} };
}

/** Parse Claude Code's `rate_limit_info` into usage windows. Exported for tests. */
export function windowsFromRateLimit(info: Record<string, unknown> | undefined): Record<string, UsageWindow> {
  const windows: Record<string, UsageWindow> = {};
  if (!info) return windows;
  const unified = info.unifiedWindows;
  if (unified && typeof unified === "object") {
    for (const [id, raw] of Object.entries(unified as Record<string, unknown>)) {
      const window = raw as Record<string, unknown> | null;
      if (!window || typeof window.utilization !== "number") continue;
      windows[id] = {
        utilization: window.utilization,
        resetsAt: toMs(window.resetsAt),
        status: typeof window.status === "string" ? window.status : undefined,
      };
    }
  }
  // Older payloads only describe the most constrained window.
  if (typeof info.rateLimitType === "string" && typeof info.utilization === "number" && !windows[info.rateLimitType]) {
    windows[info.rateLimitType] = {
      utilization: info.utilization,
      resetsAt: toMs(info.resetsAt),
      status: typeof info.status === "string" ? info.status : undefined,
    };
  }
  return windows;
}

export class UsageStore {
  private cache: UsageFile = emptyFile();
  private cacheMtime = -1;

  constructor(
    /** Undefined keeps the state in memory only (used in tests). */
    private readonly path: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): UsageFile {
    if (!this.path) return this.cache;
    try {
      const mtime = statSync(this.path).mtimeMs;
      if (mtime === this.cacheMtime) return this.cache;
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as UsageFile;
      this.cache = parsed && parsed.version === 1 && parsed.accounts ? parsed : emptyFile();
      this.cacheMtime = mtime;
    } catch {
      // Missing or half-written file: keep the last good snapshot.
    }
    return this.cache;
  }

  private update(providerId: string, change: (usage: AccountUsage) => void): void {
    const file = this.read();
    const next: UsageFile = { version: 1, accounts: { ...file.accounts } };
    const usage: AccountUsage = structuredClone(next.accounts[providerId] ?? { windows: {} });
    change(usage);
    usage.updatedAt = this.now();
    next.accounts[providerId] = usage;
    this.cache = next;
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(temp, this.path);
      this.cacheMtime = statSync(this.path).mtimeMs;
    } catch {
      // Routing still works from the in-memory copy.
    }
  }

  get(providerId: string): AccountUsage | undefined {
    return this.read().accounts[providerId];
  }

  all(): Record<string, AccountUsage> {
    return this.read().accounts;
  }

  recordWindows(providerId: string, windows: Record<string, UsageWindow>): void {
    if (!Object.keys(windows).length) return;
    this.update(providerId, (usage) => {
      usage.windows = { ...usage.windows, ...windows };
    });
  }

  markLimited(providerId: string, until: number, reason?: string): void {
    this.update(providerId, (usage) => {
      usage.limitedUntil = Math.max(until, usage.limitedUntil ?? 0);
      usage.limitedReason = reason;
    });
  }

  clearLimits(providerId?: string): void {
    for (const id of providerId ? [providerId] : Object.keys(this.all())) {
      this.update(id, (usage) => {
        delete usage.limitedUntil;
        delete usage.limitedReason;
      });
    }
  }

  recordAssignment(providerId: string): void {
    const now = this.now();
    this.update(providerId, (usage) => {
      usage.assignments = [...(usage.assignments ?? []).filter((at) => now - at < ASSIGNMENT_WINDOW_MS), now].slice(
        -MAX_ASSIGNMENTS,
      );
    });
  }

  limitedUntil(providerId: string): number | undefined {
    const until = this.get(providerId)?.limitedUntil;
    return until !== undefined && until > this.now() ? until : undefined;
  }

  /** Current utilization (0..1) per window, treating windows past their reset as empty. */
  liveWindows(providerId: string): Record<string, UsageWindow> {
    const now = this.now();
    const windows: Record<string, UsageWindow> = {};
    for (const [id, window] of Object.entries(this.get(providerId)?.windows ?? {})) {
      windows[id] = window.resetsAt !== undefined && window.resetsAt <= now ? { utilization: 0 } : window;
    }
    return windows;
  }

  /** Highest live utilization across windows, 0..1. Unknown accounts count as empty. */
  pressure(providerId: string): number {
    return Math.max(0, ...Object.values(this.liveWindows(providerId)).map((window) => window.utilization));
  }

  recentAssignments(providerId: string): number {
    const now = this.now();
    return (this.get(providerId)?.assignments ?? []).filter((at) => now - at < ASSIGNMENT_WINDOW_MS).length;
  }
}
