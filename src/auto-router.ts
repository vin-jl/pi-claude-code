/**
 * Automatic account selection across Claude Code accounts.
 *
 * Policy:
 * - A conversation sticks to one account. Tool follow-ups always stay on the
 *   account that started the turn, so prompt caches and thinking signatures
 *   remain valid.
 * - An account that reports a rate or usage limit cools down until the reset
 *   time Claude Code reports (or a configured default). New turns and automatic
 *   retries then move to the next account in the configured order.
 * - Billing/usage-credit errors are never retried automatically (Pi treats them
 *   as non-retryable); the next prompt you send moves to another account.
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AccountsConfig, ClaudeAccount } from "./accounts.ts";

export interface AutoRouterState {
  /** Provider id of the account this conversation is pinned to. */
  account?: string;
}

/** Errors that mean "this account is out of capacity", not a transient server problem. */
const ACCOUNT_LIMIT_ERROR =
  /rate.?limit|usage.?limit|limit reached|too many requests|(?<![0-9])429(?![0-9])|extra usage|usage credits|quota|Claude Code billing/iu;

export function isAccountLimitError(message: Pick<AssistantMessage, "stopReason" | "errorMessage">): boolean {
  return message.stopReason === "error" && !!message.errorMessage && ACCOUNT_LIMIT_ERROR.test(message.errorMessage);
}

interface RateLimitDetails {
  status?: unknown;
  resetsAt?: unknown;
  isUsingOverage?: unknown;
}

function rateLimitDetails(message: AssistantMessage): RateLimitDetails | undefined {
  const diagnostic = message.diagnostics?.findLast((item) => item.type === "claude-code.rate-limit");
  return diagnostic?.details as RateLimitDetails | undefined;
}

/** Reset time reported by Claude Code, in epoch milliseconds. */
function resetTime(details: RateLimitDetails | undefined): number | undefined {
  const value = details?.resetsAt;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // Claude Code reports seconds; accept milliseconds too.
  return value < 1e12 ? value * 1000 : value;
}

export class AccountCooldowns {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly defaultCooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isCooling(providerId: string): boolean {
    const until = this.until.get(providerId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.until.delete(providerId);
    return false;
  }

  remainingMs(providerId: string): number {
    return this.isCooling(providerId) ? this.until.get(providerId)! - this.now() : 0;
  }

  coolDown(providerId: string, until?: number): void {
    const fallback = this.now() + this.defaultCooldownMs;
    const target = until !== undefined && until > this.now() ? until : fallback;
    this.until.set(providerId, Math.max(target, this.until.get(providerId) ?? 0));
  }

  clear(providerId?: string): void {
    if (providerId) this.until.delete(providerId);
    else this.until.clear();
  }

  /**
   * Learn from a finished assistant message. Returns true when the account was
   * put on cooldown by this message.
   */
  observe(message: AssistantMessage): boolean {
    const details = rateLimitDetails(message);
    if (isAccountLimitError(message)) {
      this.coolDown(message.provider, resetTime(details));
      return true;
    }
    // A successful response that reports a rejected window or overage use
    // means the next request on this account would fail or cost money.
    if (details && (details.status === "rejected" || details.isUsingOverage === true)) {
      this.coolDown(message.provider, resetTime(details));
      return true;
    }
    return false;
  }
}

export interface RouteChoice {
  account: ClaudeAccount;
  /** True when the preferred account was skipped because it is cooling down or not logged in. */
  switched: boolean;
}

/**
 * Pick the account for a new turn. `usable` filters out accounts without a
 * login or without the requested model.
 */
export function chooseAccount(
  config: AccountsConfig,
  cooldowns: AccountCooldowns,
  pinned: string | undefined,
  usable: (account: ClaudeAccount) => boolean,
  exclude?: string,
): RouteChoice | undefined {
  const byProvider = new Map(config.accounts.map((account) => [account.providerId, account]));
  const ordered = config.auto.order.map((id) => byProvider.get(id)).filter((account) => account !== undefined);
  const candidates = ordered.filter((account) => account.providerId !== exclude && usable(account));
  const preferred = (pinned && candidates.find((account) => account.providerId === pinned)) || undefined;
  if (preferred && !cooldowns.isCooling(preferred.providerId)) return { account: preferred, switched: false };

  const available = candidates.find((account) => !cooldowns.isCooling(account.providerId));
  if (available) return { account: available, switched: pinned !== undefined && available.providerId !== pinned };

  // Everything is cooling down: use the account that frees up first rather
  // than failing without trying.
  const soonest = candidates.sort(
    (left, right) => cooldowns.remainingMs(left.providerId) - cooldowns.remainingMs(right.providerId),
  )[0];
  return soonest ? { account: soonest, switched: pinned !== undefined && soonest.providerId !== pinned } : undefined;
}

export function accountForModel(config: AccountsConfig, model: Pick<Model<any>, "provider"> | undefined) {
  return model ? config.accounts.find((account) => account.providerId === model.provider) : undefined;
}
