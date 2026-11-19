import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { loadAccountsConfig, parseAccountsConfig } from "../src/accounts.ts";
import { chooseAccount, isAccountLimitError, observeMessage } from "../src/auto-router.ts";
import { UsageStore, windowsFromRateLimit } from "../src/usage-store.ts";
import { claudeCodeEnv, createClaudeCodeProvider } from "../src/provider.ts";

test("without a config file only the upstream default account exists", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-accounts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadAccountsConfig(dir, {});
  assert.deepEqual(config.accounts.map((account) => account.providerId), ["claude-code"]);
  assert.equal(config.auto.enabled, false);
});

test("parses extra accounts, expands ~ and honours auto order", () => {
  const config = parseAccountsConfig(
    {
      default: { label: "Work" },
      accounts: [{ id: "personal", label: "Personal", configDir: "~/.claude_personal" }],
      auto: { order: ["personal"], cooldownMinutes: 10 },
    },
    "/base",
  );
  assert.deepEqual(
    config.accounts.map((account) => [account.providerId, account.label, account.configDir]),
    [
      ["claude-code", "Work", undefined],
      ["claude-code-personal", "Personal", join(homedir(), ".claude_personal")],
    ],
  );
  assert.deepEqual(config.auto.order, ["claude-code-personal", "claude-code"]);
  assert.equal(config.auto.enabled, true);
  assert.equal(config.auto.cooldownMs, 600_000);
});

test("rejects invalid account configuration", () => {
  assert.throws(() => parseAccountsConfig({ accounts: [{ id: "Bad Id", configDir: "/x" }] }, "/"), /invalid account id/);
  assert.throws(() => parseAccountsConfig({ accounts: [{ id: "p" }] }, "/"), /configDir/);
  assert.throws(
    () => parseAccountsConfig({ accounts: [{ id: "p", configDir: "/x" }, { id: "p", configDir: "/y" }] }, "/"),
    /duplicate/,
  );
  assert.throws(() => parseAccountsConfig({ auto: { order: ["nope"] } }, "/"), /unknown account/);
});

test("an explicit accounts file that is missing is an error", () => {
  assert.throws(() => loadAccountsConfig(undefined, { PI_CLAUDE_CODE_ACCOUNTS_FILE: "/does/not/exist.json" }), /not found/);
});

test("loads the accounts file from the agent directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-accounts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "claude-code-accounts.json"),
    JSON.stringify({ accounts: [{ id: "second", configDir: "./second" }] }),
  );
  const config = loadAccountsConfig(dir, {});
  assert.equal(config.accounts[1].configDir, join(dir, "second"));
});

test("each account provider uses its own id, models and Claude config directory", () => {
  const account = { id: "personal", providerId: "claude-code-personal", label: "Personal", configDir: "/tmp/claude-p" };
  const provider = createClaudeCodeProvider({ account });
  assert.equal(provider.id, "claude-code-personal");
  assert.ok(provider.getModels().length > 0);
  assert.ok(provider.getModels().every((model) => model.provider === "claude-code-personal"));
  const env = claudeCodeEnv(account);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude-p");
  assert.equal(env.PI_CLAUDE_CODE_CONFIG_DIR, "/tmp/claude-p");
  assert.ok(createClaudeCodeProvider().getModels().every((model) => model.provider === "claude-code"));
});

function message(provider: string, errorMessage?: string, details?: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "claude-code-stream-json",
    provider,
    model: "claude-sonnet-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: errorMessage ? "error" : "stop",
    errorMessage,
    diagnostics: details ? [{ type: "claude-code.rate-limit", timestamp: 0, details: details as never }] : undefined,
    timestamp: 0,
  };
}

test("classifies account limit errors but not ordinary server errors", () => {
  assert.equal(isAccountLimitError(message("a", "Claude Code upstream response (status 429, rate_limit_error)")), true);
  assert.equal(isAccountLimitError(message("a", "Claude Code billing: usage credits")), true);
  assert.equal(isAccountLimitError(message("a", "Claude Code upstream server error (status 529)")), false);
  assert.equal(isAccountLimitError(message("a")), false);
});

function twoAccounts(auto: Record<string, unknown> = {}) {
  return parseAccountsConfig({ accounts: [{ id: "personal", configDir: "/p" }], auto: { cooldownMinutes: 5, ...auto } }, "/");
}

const usage = (five: number, week: number, now: number) => ({
  unifiedWindows: {
    five_hour: { utilization: five, resetsAt: now / 1000 + 3600, status: "allowed" },
    seven_day: { utilization: week, resetsAt: now / 1000 + 86400, status: "allowed" },
  },
});

test("parses Claude Code rate-limit windows", () => {
  const windows = windowsFromRateLimit({
    rateLimitType: "seven_day",
    utilization: 0.8,
    resetsAt: 1794531600,
    unifiedWindows: { five_hour: { utilization: 0.71, resetsAt: 1794465000, status: "allowed" } },
  });
  assert.deepEqual(windows.five_hour, { utilization: 0.71, resetsAt: 1794465000_000, status: "allowed" });
  assert.equal(windows.seven_day.utilization, 0.8);
});

test("spread strategy sends new conversations to the account with most headroom", () => {
  const now = 1_000_000_000_000;
  const config = twoAccounts();
  const store = new UsageStore(undefined, () => now);
  const all = () => true;

  // Nothing known: configured order wins.
  assert.equal(chooseAccount(config, store, undefined, all)?.account.providerId, "claude-code");

  observeMessage(store, message("claude-code", undefined, usage(0.6, 0.8, now)), config.auto.cooldownMs, now);
  observeMessage(store, message("claude-code-personal", undefined, usage(0.2, 0.1, now)), config.auto.cooldownMs, now);
  assert.equal(chooseAccount(config, store, undefined, all)?.account.providerId, "claude-code-personal");

  // A pinned conversation stays put while its account has headroom.
  const pinned = chooseAccount(config, store, "claude-code", all);
  assert.deepEqual([pinned?.account.providerId, pinned?.switched], ["claude-code", false]);

  // Fallback strategy keeps using the first account while it has headroom.
  assert.equal(chooseAccount(twoAccounts({ strategy: "fallback" }), store, undefined, all)?.account.providerId, "claude-code");
});

test("a burst of new conversations is split across accounts", () => {
  const now = 1_000_000_000_000;
  const config = twoAccounts();
  const store = new UsageStore(undefined, () => now);
  const picks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const choice = chooseAccount(config, store, undefined, () => true)!;
    store.recordAssignment(choice.account.providerId);
    picks.push(choice.account.id);
  }
  assert.equal(picks.filter((id) => id === "default").length, 3);
  assert.equal(picks.filter((id) => id === "personal").length, 3);
});

test("limits are honoured until reset and shared through the usage file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-usage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1_000_000_000_000;
  const file = join(dir, "usage.json");
  const config = twoAccounts();
  const processA = new UsageStore(file, () => now);
  const processB = new UsageStore(file, () => now);
  const all = () => true;

  const result = observeMessage(
    processA,
    message("claude-code-personal", "429 rate limit", { resetsAt: now / 1000 + 3600 }),
    config.auto.cooldownMs,
    now,
  );
  assert.deepEqual(result, { limited: true, until: now + 3_600_000 });

  // Another process sees the limit immediately, even for a pinned conversation.
  const moved = chooseAccount(config, processB, "claude-code-personal", all);
  assert.deepEqual([moved?.account.providerId, moved?.switched], ["claude-code", true]);
  // A retry excludes the account that failed.
  assert.equal(chooseAccount(config, processB, undefined, all, "claude-code")?.account.providerId, "claude-code-personal");
  // Logged-out accounts are skipped.
  assert.equal(chooseAccount(config, processB, undefined, (a) => a.id !== "default")?.account.providerId, "claude-code-personal");

  // A fresh process (restart) still knows.
  assert.ok(new UsageStore(file, () => now).limitedUntil("claude-code-personal"));

  // Nearly exhausted windows also trigger a switch.
  observeMessage(processA, message("claude-code", undefined, usage(0.97, 0.5, now)), config.auto.cooldownMs, now);
  assert.equal(chooseAccount(config, processB, "claude-code", all)?.account.providerId, "claude-code");

  // Reset times pass: windows count as empty again and the limit expires.
  now += 2 * 86_400_000;
  assert.equal(processB.limitedUntil("claude-code-personal"), undefined);
  assert.equal(processB.pressure("claude-code"), 0);
  assert.equal(chooseAccount(config, processB, "claude-code-personal", all)?.switched, false);
});

test("rejected windows and overage use mark the account limited", () => {
  const now = 1_000_000_000_000;
  const store = new UsageStore(undefined, () => now);
  assert.equal(observeMessage(store, message("a", undefined, { status: "allowed" }), 60_000, now).limited, false);
  assert.equal(observeMessage(store, message("a", undefined, { isUsingOverage: true }), 60_000, now).limited, true);
  const rejected = {
    unifiedWindows: { five_hour: { utilization: 1, resetsAt: now / 1000 + 600, status: "rejected" } },
  };
  assert.equal(observeMessage(store, message("b", undefined, rejected), 60_000, now).until, now + 600_000);
});
