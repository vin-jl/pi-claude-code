/**
 * Automatic account selection across Claude Code accounts.
 *
 * Inputs come from the shared {@link UsageStore}: the 5-hour and weekly
 * utilization Claude Code reports with every response (the same numbers
 * Claude Code's /usage and T3 Code display), plus remembered hard limits.
 *
 * Policy:
 * - A conversation sticks to one account. Tool follow-ups always stay on the
 *   account that started the turn, so prompt caches and thinking signatures
 *   remain valid.
 * - New conversations go to the account with the most headroom ("spread"), or
 *   to the first account in the configured order that still has headroom
 *   ("fallback"). Conversations started in the last few minutes count as
 *   extra load, so a burst of parallel threads is split across accounts even
 *   before fresh usage numbers arrive.
 * - A pinned conversation moves only when its account is limited or nearly
 *   exhausted.
 * - Limit errors mark the account limited until Claude Code's reported reset
 *   time (or the configured cooldown) for every process sharing the store.
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AccountsConfig, ClaudeAccount } from "./accounts.ts";
import { windowsFromRateLimit, type UsageStore } from "./usage-store.ts";

export interface AutoRouterState {
  /** Provider id of the account this conversation is pinned to. */
  account?: string;
}

/** Errors that mean "this account is out of capacity", not a transient server problem. */
const ACCOUNT_LIMIT_ERROR =
  /rate.?limit|usage.?limit|limit reached|too many requests|(?<![0-9])429(?![0-9])|extra usage|usage credits|quota|Claude Code billing/iu;

/** Each conversation started recently on an account counts as this much extra utilization. */
const ASSIGNMENT_WEIGHT = 0.03;

export function isAccountLimitError(message: Pick<AssistantMessage, "stopReason" | "errorMessage">): boolean {
  return message.stopReason === "error" && !!message.errorMessage && ACCOUNT_LIMIT_ERROR.test(message.errorMessage);
}

function rateLimitInfo(message: AssistantMessage): Record<string, unknown> | undefined {
  const diagnostic = message.diagnostics?.findLast((item) => item.type === "claude-code.rate-limit");
  return diagnostic?.details as Record<string, unknown> | undefined;
}

function toMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

export interface ObserveResult {
  /** True when this message newly marked the account as limited. */
  limited: boolean;
  until?: number;
}

/**
 * Learn from a finished assistant message: record usage windows and mark the
 * account limited on limit errors, rejected windows or overage use.
 */
export function observeMessage(
  store: UsageStore,
  message: AssistantMessage,
  defaultCooldownMs: number,
  now = Date.now(),
): ObserveResult {
  const info = rateLimitInfo(message);
  const windows = windowsFromRateLimit(info);
  store.recordWindows(message.provider, windows);

  const wasLimited = store.limitedUntil(message.provider) !== undefined;
  const fallback = now + defaultCooldownMs;
  const resetOf = (value: unknown) => {
    const at = toMs(value);
    return at !== undefined && at > now ? at : undefined;
  };

  let until: number | undefined;
  let reason: string | undefined;
  if (isAccountLimitError(message)) {
    until = resetOf(info?.resetsAt) ?? fallback;
    reason = "limit error";
  } else if (info?.isUsingOverage === true) {
    until = resetOf(info.resetsAt) ?? fallback;
    reason = "using usage credits";
  } else {
    for (const [id, window] of Object.entries(windows)) {
      if (window.status === "rejected" || window.utilization >= 1) {
        const at = window.resetsAt !== undefined && window.resetsAt > now ? window.resetsAt : fallback;
        if (until === undefined || at > until) {
          until = at;
          reason = `${id} window exhausted`;
        }
      }
    }
  }
  if (until === undefined) return { limited: false };
  store.markLimited(message.provider, until, reason);
  return { limited: !wasLimited, until };
}

export interface RouteChoice {
  account: ClaudeAccount;
  /** True when the pinned account was left because it is limited or nearly exhausted. */
  switched: boolean;
}

export function isAvailable(store: UsageStore, config: AccountsConfig, providerId: string): boolean {
  return store.limitedUntil(providerId) === undefined && store.pressure(providerId) < config.auto.switchAt;
}

function load(store: UsageStore, providerId: string): number {
  return store.pressure(providerId) + store.recentAssignments(providerId) * ASSIGNMENT_WEIGHT;
}

/**
 * Pick the account for a turn. `usable` filters out accounts without a login or
 * without the requested model; `exclude` skips the account a retry failed on.
 */
export function chooseAccount(
  config: AccountsConfig,
  store: UsageStore,
  pinned: string | undefined,
  usable: (account: ClaudeAccount) => boolean,
  exclude?: string,
): RouteChoice | undefined {
  const byProvider = new Map(config.accounts.map((account) => [account.providerId, account]));
  const ordered = config.auto.order.map((id) => byProvider.get(id)).filter((account) => account !== undefined);
  const candidates = ordered.filter((account) => account.providerId !== exclude && usable(account));
  if (!candidates.length) return undefined;

  const preferred = pinned ? candidates.find((account) => account.providerId === pinned) : undefined;
  if (preferred && isAvailable(store, config, preferred.providerId)) return { account: preferred, switched: false };

  const available = candidates.filter((account) => isAvailable(store, config, account.providerId));
  let chosen: ClaudeAccount | undefined;
  if (available.length) {
    chosen =
      config.auto.strategy === "fallback"
        ? available[0]
        : // Stable sort keeps the configured order as the tie-breaker.
          [...available].sort((a, b) => load(store, a.providerId) - load(store, b.providerId))[0];
  } else {
    // Everything is limited or nearly exhausted: prefer an account that is not
    // hard-limited, otherwise the one whose limit resets first.
    const unlimited = candidates.filter((account) => store.limitedUntil(account.providerId) === undefined);
    chosen = unlimited.length
      ? [...unlimited].sort((a, b) => store.pressure(a.providerId) - store.pressure(b.providerId))[0]
      : [...candidates].sort(
          (a, b) => (store.limitedUntil(a.providerId) ?? 0) - (store.limitedUntil(b.providerId) ?? 0),
        )[0];
  }
  return { account: chosen, switched: pinned !== undefined && chosen.providerId !== pinned };
}

export function accountForModel(config: AccountsConfig, model: Pick<Model<any>, "provider"> | undefined) {
  return model ? config.accounts.find((account) => account.providerId === model.provider) : undefined;
}
