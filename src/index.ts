import { getSupportedThinkingLevels, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AUTO_PROVIDER_ID,
  DEFAULT_ACCOUNT_ID,
  loadAccountsConfig,
  singleAccountConfig,
  type AccountsConfig,
  type ClaudeAccount,
} from "./accounts.ts";
import { accountForModel, chooseAccount, observeMessage, type AutoRouterState } from "./auto-router.ts";
import { UsageStore } from "./usage-store.ts";
import { getClaudeStatus } from "./claude-cli.ts";
import { CLAUDE_CODE_MODELS } from "./model-catalog.ts";
import { claudeCodeEnv, createClaudeCodeProvider } from "./provider.ts";

const STATUS_KEY = "claude-code-account";

function providerName(account: ClaudeAccount, config: AccountsConfig): string {
  const base = "Claude Code Subscription (Experimental)";
  return config.accounts.length > 1 ? `${base} · ${account.label}` : base;
}

function formatDuration(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

function loadConfig(pi: ExtensionAPI): AccountsConfig {
  try {
    return loadAccountsConfig(getAgentDir());
  } catch (error) {
    // Keep the default account working; surface the problem once a UI exists.
    const message = error instanceof Error ? error.message : String(error);
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(message, "error"));
    return singleAccountConfig();
  }
}

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  const config = loadConfig(pi);
  for (const account of config.accounts) {
    pi.registerProvider(createClaudeCodeProvider({ account, name: providerName(account, config) }));
  }

  const store = new UsageStore(config.usageFile);
  const accountByProvider = new Map(config.accounts.map((account) => [account.providerId, account]));

  if (config.auto.enabled) registerAutoModels(pi, config, store);

  // Learn rate-limit state from every Claude Code response, whether the
  // account was picked by hand or by the auto router.
  pi.on("message_end", (event, ctx) => {
    const message = event.message as AssistantMessage;
    if (message.role !== "assistant" || !accountByProvider.has(message.provider)) return;
    const account = accountByProvider.get(message.provider)!;
    const observed = observeMessage(store, message, config.auto.cooldownMs);
    if (observed.limited && observed.until && config.auto.enabled) {
      const wait = formatDuration(observed.until - Date.now());
      ctx.ui.notify(`Claude account "${account.label}" hit its limit; auto routing avoids it for ~${wait}.`, "warning");
    }
    if (ctx.model?.provider === AUTO_PROVIDER_ID && message.stopReason !== "error") {
      ctx.ui.setStatus(STATUS_KEY, `claude: ${account.label}`);
    }
  });

  pi.on("model_select", (event, ctx) => {
    const account = accountForModel(config, event.model);
    if (event.model.provider === AUTO_PROVIDER_ID) ctx.ui.setStatus(STATUS_KEY, "claude: auto");
    else ctx.ui.setStatus(STATUS_KEY, account && config.accounts.length > 1 ? `claude: ${account.label}` : undefined);
  });

  pi.registerCommand("claude-code-status", {
    description: "Check Claude Code logins for every configured account",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      let ready = 0;
      for (const account of config.accounts) {
        const status = await getClaudeStatus(claudeCodeEnv(account), ctx.signal);
        const where = account.configDir ? ` [${account.configDir}]` : "";
        if (status.available && status.loggedIn) {
          ready++;
          const plan = status.plan ? ` (${status.plan})` : "";
          lines.push(`✓ ${account.label}${plan} → ${account.providerId}${where}`);
          lines.push(`    ${usageSummary(store, account.providerId)}`);
        } else {
          const login = account.configDir
            ? `CLAUDE_CONFIG_DIR=${JSON.stringify(account.configDir)} claude auth login`
            : "claude auth login";
          lines.push(`✗ ${account.label}: ${status.detail ?? "not logged in"} — run \`${login}\`${where}`);
        }
      }
      if (config.auto.enabled) {
        lines.push(
          `Auto routing: ${AUTO_PROVIDER_ID}/* · ${config.auto.strategy} · order ${config.auto.order.join(" → ")} · switch at ${Math.round(config.auto.switchAt * 100)}%`,
        );
      }
      if (config.source) lines.push(`Config: ${config.source}`);
      if (config.usageFile) lines.push(`Usage: ${config.usageFile}`);
      ctx.ui.notify(lines.join("\n"), ready === config.accounts.length ? "info" : "error");
    },
  });

  pi.registerCommand("claude-code-reset-limits", {
    description: "Forget remembered Claude account rate limits so auto routing tries them again",
    handler: async (_args, ctx) => {
      store.clearLimits();
      ctx.ui.notify("Cleared remembered Claude account limits.", "info");
    },
  });
}

/** Register `claude-code-auto/<model>` virtual models that pick an account per conversation. */
function usageSummary(store: UsageStore, providerId: string): string {
  const now = Date.now();
  const labels: Record<string, string> = { five_hour: "5h", seven_day: "week" };
  const windows = store.liveWindows(providerId);
  const parts = Object.entries(windows)
    .sort(([a], [b]) => (a === "five_hour" ? -1 : b === "five_hour" ? 1 : a.localeCompare(b)))
    .map(([id, window]) => {
      const reset = window.resetsAt && window.resetsAt > now ? ` (resets in ${formatDuration(window.resetsAt - now)})` : "";
      return `${labels[id] ?? id} ${Math.round(window.utilization * 100)}%${reset}`;
    });
  const limited = store.limitedUntil(providerId);
  if (limited) parts.push(`LIMITED for ~${formatDuration(limited - now)} (${store.get(providerId)?.limitedReason ?? "limit"})`);
  return parts.length ? parts.join(" · ") : "no usage seen yet";
}

function registerAutoModels(pi: ExtensionAPI, config: AccountsConfig, store: UsageStore): void {
  const physical = (ctx: ExtensionContext, account: ClaudeAccount, modelId: string) => {
    const model = ctx.modelRegistry.find(account.providerId, modelId);
    return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
  };

  for (const template of CLAUDE_CODE_MODELS) {
    const thinkingLevels = getSupportedThinkingLevels(template);
    pi.registerVirtualModel<AutoRouterState>({
      provider: AUTO_PROVIDER_ID,
      id: template.id,
      name: `${template.name} · Auto account`,
      thinkingLevels,
      contextWindow: template.contextWindow,
      maxTokens: template.maxTokens,
      input: template.input,
      route(request, ctx) {
        const thinkingLevel = request.thinkingLevel;
        const pinned = request.state?.account;

        // Tool follow-ups stay on the account that answered last, so caches and
        // signatures stay valid. Only a limit error moves a running turn.
        const sticky = request.previous?.model;
        if (request.reason === "continuation" && sticky && accountForModel(config, sticky)) {
          return { model: sticky, thinkingLevel };
        }

        const failedOn = request.reason === "retry" ? request.failed?.model.provider : undefined;
        const usable = (account: ClaudeAccount) => physical(ctx, account, template.id) !== undefined;
        const choice = chooseAccount(config, store, failedOn ? undefined : pinned, usable, failedOn);
        // A retry with no other account left goes back to the one that failed.
        const account = choice?.account ?? (failedOn ? accountForModel(config, { provider: failedOn }) : undefined);
        const model = account && physical(ctx, account, template.id);
        if (!account || !model) {
          throw new Error(
            `No logged-in Claude account offers ${template.id}. Run /claude-code-status to check the logins.`,
          );
        }

        if (choice?.switched || (failedOn && account.providerId !== failedOn)) {
          ctx.ui.notify(`Auto routing switched to Claude account "${account.label}".`, "info");
        }
        if (request.reason !== "direct") ctx.ui.setStatus(STATUS_KEY, `claude: ${account.label}`);
        if (pinned !== account.providerId && request.reason !== "direct") store.recordAssignment(account.providerId);
        const state = pinned === account.providerId ? request.state : { account: account.providerId };
        return { model: model as Model<any>, thinkingLevel, state };
      },
    });
  }
}

export { createClaudeCodeProvider } from "./provider.ts";
export { streamClaudeCode } from "./stream.ts";
export { DEFAULT_ACCOUNT_ID };
