import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { loadAccountsConfig, parseAccountsConfig } from "../src/accounts.ts";
import { AccountCooldowns, chooseAccount, isAccountLimitError } from "../src/auto-router.ts";
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

test("auto routing sticks to the pinned account and fails over on limits", () => {
  let now = 1_000_000;
  const config = parseAccountsConfig(
    { accounts: [{ id: "personal", configDir: "/p" }], auto: { cooldownMinutes: 5 } },
    "/",
  );
  const cooldowns = new AccountCooldowns(config.auto.cooldownMs, () => now);
  const all = () => true;

  assert.equal(chooseAccount(config, cooldowns, undefined, all)?.account.providerId, "claude-code");
  const pinned = chooseAccount(config, cooldowns, "claude-code-personal", all);
  assert.deepEqual([pinned?.account.providerId, pinned?.switched], ["claude-code-personal", false]);

  // Limit with a reset time reported by Claude Code (seconds).
  assert.equal(cooldowns.observe(message("claude-code-personal", "429 rate limit", { resetsAt: now / 1000 + 3600 })), true);
  const moved = chooseAccount(config, cooldowns, "claude-code-personal", all);
  assert.deepEqual([moved?.account.providerId, moved?.switched], ["claude-code", true]);

  // A retry excludes the account that just failed.
  assert.equal(chooseAccount(config, cooldowns, undefined, all, "claude-code")?.account.providerId, "claude-code-personal");

  // Unusable (logged out) accounts are skipped.
  assert.equal(
    chooseAccount(config, cooldowns, undefined, (account) => account.id !== "default")?.account.providerId,
    "claude-code-personal",
  );

  // Both limited: pick the one that frees up first.
  cooldowns.observe(message("claude-code", "usage limit reached"));
  assert.equal(chooseAccount(config, cooldowns, undefined, all)?.account.providerId, "claude-code");

  // Cooldowns expire.
  now += 2 * 3600_000;
  assert.equal(chooseAccount(config, cooldowns, "claude-code-personal", all)?.switched, false);
});

test("successful responses reporting overage or rejection cool the account down", () => {
  const cooldowns = new AccountCooldowns(60_000);
  assert.equal(cooldowns.observe(message("a", undefined, { status: "allowed" })), false);
  assert.equal(cooldowns.observe(message("a", undefined, { isUsingOverage: true })), true);
  assert.equal(cooldowns.isCooling("a"), true);
});
