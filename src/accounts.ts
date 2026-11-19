/**
 * Multiple Claude Code accounts.
 *
 * Every account is a separate Claude Code configuration directory with its own
 * login. Each one is registered as its own Pi provider so it can be selected in
 * `/model`, and the optional auto router picks between them per conversation.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PROVIDER_ID } from "./model-catalog.ts";

export const DEFAULT_ACCOUNT_ID = "default";
export const AUTO_PROVIDER_ID = "claude-code-auto";
export const ACCOUNTS_FILE_ENV = "PI_CLAUDE_CODE_ACCOUNTS_FILE";
export const ACCOUNTS_FILE_NAME = "claude-code-accounts.json";
export const USAGE_FILE_NAME = "claude-code-usage.json";
const DEFAULT_COOLDOWN_MINUTES = 30;
const DEFAULT_SWITCH_AT_PERCENT = 95;

export type AutoStrategy = "spread" | "fallback";

export interface ClaudeAccount {
  /** Short id used in configuration, e.g. `default` or `personal`. */
  id: string;
  /** Pi provider id: `claude-code` for the default account, `claude-code-<id>` otherwise. */
  providerId: string;
  label: string;
  /**
   * Claude Code config directory, passed to Claude Code as `CLAUDE_CONFIG_DIR`.
   * Undefined keeps Claude Code's default login (or `PI_CLAUDE_CODE_CONFIG_DIR`).
   * An explicit `~/.claude` is a different login than the default one on macOS,
   * because Claude Code keys its keychain entry by the configured directory.
   */
  configDir?: string;
}

export interface AutoRouteConfig {
  enabled: boolean;
  /** Provider ids in preference order. */
  order: string[];
  cooldownMs: number;
  /**
   * `spread`: new conversations go to the account with the most headroom.
   * `fallback`: new conversations use the first account in `order` that has headroom.
   */
  strategy: AutoStrategy;
  /** Utilization (0..1) at which an account is treated as exhausted. */
  switchAt: number;
}

export interface AccountsConfig {
  accounts: ClaudeAccount[];
  auto: AutoRouteConfig;
  /** Shared usage file, or undefined to keep usage in memory. */
  usageFile?: string;
  /** Where the configuration came from, for status output. */
  source?: string;
}

interface RawAccount {
  id?: unknown;
  label?: unknown;
  configDir?: unknown;
}

interface RawConfig {
  default?: { label?: unknown; enabled?: unknown };
  accounts?: unknown;
  auto?: { enabled?: unknown; order?: unknown; cooldownMinutes?: unknown; strategy?: unknown; switchAtPercent?: unknown };
  usageFile?: unknown;
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u;

export function providerIdFor(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? PROVIDER_ID : `${PROVIDER_ID}-${accountId}`;
}

function expandPath(path: string, baseDir: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Validate a parsed configuration file. Exported for tests. */
export function parseAccountsConfig(raw: unknown, baseDir: string, source?: string): AccountsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("expected a JSON object");
  }
  const config = raw as RawConfig;
  const accounts: ClaudeAccount[] = [];
  if (config.default?.enabled !== false) {
    accounts.push({
      id: DEFAULT_ACCOUNT_ID,
      providerId: PROVIDER_ID,
      label: nonEmptyString(config.default?.label) ?? "Default",
    });
  }

  if (config.accounts !== undefined && !Array.isArray(config.accounts)) {
    throw new Error('"accounts" must be an array');
  }
  for (const entry of (config.accounts ?? []) as RawAccount[]) {
    const id = nonEmptyString(entry?.id);
    if (!id || !ACCOUNT_ID.test(id) || id === DEFAULT_ACCOUNT_ID || id === "auto") {
      throw new Error(`invalid account id ${JSON.stringify(entry?.id)}: use lowercase letters, digits and dashes`);
    }
    if (accounts.some((account) => account.id === id)) throw new Error(`duplicate account id "${id}"`);
    const configDir = nonEmptyString(entry.configDir);
    if (!configDir) throw new Error(`account "${id}" needs a "configDir"`);
    accounts.push({
      id,
      providerId: providerIdFor(id),
      label: nonEmptyString(entry.label) ?? id,
      configDir: expandPath(configDir, baseDir),
    });
  }

  const known = new Map(accounts.map((account) => [account.id, account.providerId]));
  let order = accounts.map((account) => account.providerId);
  if (config.auto?.order !== undefined) {
    if (!Array.isArray(config.auto.order)) throw new Error('"auto.order" must be an array of account ids');
    order = config.auto.order.map((id) => {
      const providerId = typeof id === "string" ? known.get(id) : undefined;
      if (!providerId) throw new Error(`"auto.order" names unknown account ${JSON.stringify(id)}`);
      return providerId;
    });
    // Accounts left out of the order are still used, after the listed ones.
    for (const account of accounts) if (!order.includes(account.providerId)) order.push(account.providerId);
  }

  const minutes = config.auto?.cooldownMinutes;
  if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0)) {
    throw new Error('"auto.cooldownMinutes" must be a non-negative number');
  }

  const strategy = config.auto?.strategy ?? "spread";
  if (strategy !== "spread" && strategy !== "fallback") throw new Error('"auto.strategy" must be "spread" or "fallback"');
  const switchAt = config.auto?.switchAtPercent ?? DEFAULT_SWITCH_AT_PERCENT;
  if (typeof switchAt !== "number" || !(switchAt > 0 && switchAt <= 100)) {
    throw new Error('"auto.switchAtPercent" must be a number between 1 and 100');
  }
  const usageFile = config.usageFile === undefined ? undefined : nonEmptyString(config.usageFile);
  if (config.usageFile !== undefined && !usageFile) throw new Error('"usageFile" must be a path');

  return {
    accounts,
    auto: {
      enabled: config.auto?.enabled !== false && accounts.length > 1,
      order,
      cooldownMs: (minutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000,
      strategy,
      switchAt: switchAt / 100,
    },
    usageFile: usageFile ? expandPath(usageFile, baseDir) : undefined,
    source,
  };
}

export function singleAccountConfig(): AccountsConfig {
  return parseAccountsConfig({}, process.cwd());
}

/**
 * Load accounts from `PI_CLAUDE_CODE_ACCOUNTS_FILE`, or `claude-code-accounts.json`
 * in Pi's agent directory. Without a file, only the default account exists and
 * the extension behaves exactly like upstream pi-claude-code.
 */
export function loadAccountsConfig(agentDir: string | undefined, env = process.env): AccountsConfig {
  const configured = nonEmptyString(env[ACCOUNTS_FILE_ENV]);
  const path = configured ? expandPath(configured, process.cwd()) : agentDir ? join(agentDir, ACCOUNTS_FILE_NAME) : undefined;
  if (!path || !existsSync(path)) {
    if (configured) throw new Error(`Claude Code accounts file not found: ${path}`);
    return singleAccountConfig();
  }
  const withUsageFile = (config: AccountsConfig): AccountsConfig =>
    config.usageFile || !agentDir ? config : { ...config, usageFile: join(agentDir, USAGE_FILE_NAME) };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Claude Code accounts file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return withUsageFile(parseAccountsConfig(raw, join(path, ".."), path));
  } catch (error) {
    throw new Error(`Invalid Claude Code accounts file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
