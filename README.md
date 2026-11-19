# pi-claude-code

This Pi extension lets you use your Claude Pro or Max subscription in Pi by
routing all Claude model requests through the official Claude Code CLI.

Pi still handles conversation history, approvals, compaction, and tool
execution. Claude Code only talks to the model. It never runs tools itself.

> [!NOTE]
> **This is a fork** of
> [earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code)
> that adds:
>
> - **Multiple Claude accounts**, each with its own Claude Code login, selectable
>   in `/model`.
> - **Automatic account routing** (`claude-code-auto/<model>`) that spreads
>   conversations across accounts and moves away from accounts that hit their
>   limits.
> - **Shared, persistent usage tracking**: 5-hour and weekly plan usage per
>   account, shared by every Pi process and kept across restarts.
>
> Without a `claude-code-accounts.json` file the fork behaves exactly like
> upstream. See [Multiple accounts](#multiple-accounts-fork-addition).

> [!WARNING]
> **The future of this extension is uncertain.** Right now it works by running
> Pi's requests through the official Claude Code CLI in non-interactive mode
> (`claude -p`), and that usage counts against your normal Claude subscription
> limits. In May 2026 Anthropic
> [announced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
> that `claude -p`, Agent SDK, and third-party usage would move to a separate,
> smaller "Agent SDK credit" billed at API rates. Anthropic has since put that
> change on hold and says it will give advance notice before any future change.
>
> Until then the extension keeps working as described here, but that could
> change at any time. If Anthropic changes how `claude -p` usage is billed, this
> extension may cost more, stop drawing from your subscription, or stop working
> altogether. See Zed's
> [write-up](https://zed.dev/blog/anthropic-subscription-changes) for more
> background.

## Requirements

- Pi
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), installed and
  on your `PATH`:

  ```sh
  npm install -g @anthropic-ai/claude-code
  ```

- A Claude subscription that you are logged into with Claude Code

## Installation

```sh
pi install https://github.com/vin-jl/pi-claude-code
```

(Upstream, without the multi-account features:
`pi install https://github.com/earendil-works/pi-claude-code`.)

Then pick a model from the **Claude Code Subscription (Experimental)** provider
in Pi. With several accounts configured, each provider name ends in the
account label, for example **Claude Code Subscription (Experimental) · Personal**.

## Login and logout

Claude Code handles authentication. Log in and out with the Claude Code CLI:

```sh
claude auth login
claude auth logout
```

The extension uses whatever login Claude Code currently has. You don't need
Pi's `/login` or `/logout` for this provider. The extension doesn't read, copy,
or store your Claude Code credentials.

Run `/claude-code-status` in Pi to check that Claude Code is installed and
logged in.

## Multiple accounts (fork addition)

Use several Claude subscriptions from one Pi installation. Every account is a
separate Claude Code config directory with its own login; the extension never
reads or copies the credentials.

### Setup

1. Log each account in once with Claude Code:

   ```sh
   claude auth login                                          # default account (~/.claude)
   CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login     # second account
   ```

   On macOS, Claude Code stores the login in the keychain keyed by the config
   directory, so different directories really are different logins. Check both
   with `CLAUDE_CONFIG_DIR=... claude auth status`.

2. Create `claude-code-accounts.json` in Pi's agent directory (`~/.pi/agent/`
   by default, or `$PI_CODING_AGENT_DIR`), or point
   `PI_CLAUDE_CODE_ACCOUNTS_FILE` at it:

   ```json
   {
     "default": { "label": "Main" },
     "accounts": [
       { "id": "personal", "label": "Personal", "configDir": "~/.claude_personal" }
     ],
     "auto": {
       "strategy": "spread",
       "order": ["default", "personal"],
       "switchAtPercent": 95,
       "cooldownMinutes": 30
     }
   }
   ```

3. Restart Pi (or `/reload`) and run `/claude-code-status` to confirm every
   account is logged in.

### Providers

| Provider | Uses |
|---|---|
| `claude-code/<model>` | the default Claude Code login (unchanged from upstream) |
| `claude-code-<id>/<model>` | that account's `configDir` login |
| `claude-code-auto/<model>` | picks an account per conversation (see below) |

Pick any of them in `/model`, `--model`, or a client such as T3 Code. A specific
account never switches: if it hits a limit, the request fails and you choose
what to do. Only the auto models switch accounts.

### Configuration reference

| Key | Default | Meaning |
|---|---|---|
| `default.label` | `"Default"` | Display name of the default Claude Code login. |
| `default.enabled` | `true` | Set `false` to offer only the accounts listed in `accounts`. |
| `accounts[].id` | required | Lowercase letters, digits and dashes. The provider becomes `claude-code-<id>`. `default` and `auto` are reserved. |
| `accounts[].label` | the id | Display name. |
| `accounts[].configDir` | required | Claude Code config directory. `~` and paths relative to the accounts file are expanded. |
| `auto.enabled` | `true` with 2+ accounts | Set `false` to hide the `claude-code-auto` models. |
| `auto.strategy` | `"spread"` | `spread`: new conversations go to the account with the most headroom. `fallback`: use the first account in `order` that still has headroom. |
| `auto.order` | accounts in file order | Account ids (`default` included) in preference order. Tie-breaker for `spread`, priority for `fallback`. Unlisted accounts are appended. |
| `auto.switchAtPercent` | `95` | A 5-hour or weekly window at or above this utilization counts as exhausted. |
| `auto.cooldownMinutes` | `30` | How long an account stays marked limited when Claude Code reports no reset time. |
| `usageFile` | `claude-code-usage.json` in Pi's agent directory | Where shared usage and limits are stored. |

Environment variables:

- `PI_CLAUDE_CODE_ACCOUNTS_FILE`: path to the accounts file (overrides the
  agent-directory lookup; a missing file is an error).
- For a configured account, its `configDir` always wins over
  `PI_CLAUDE_CODE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR`. The default account still
  honours them.

An invalid accounts file is reported in Pi and the extension falls back to the
default account only.

### Auto routing

#### Where usage numbers come from

Claude Code reports plan usage with every response (a `rate_limit_event`): the
utilization and reset time of the 5-hour and weekly windows, the same numbers
Claude Code's `/usage` and T3 Code show. The extension records them per
account in the shared usage file. Every Pi process (for example every T3 Code
thread, which each run their own Pi process) reads and updates that file, so
all of them route on the same picture, and it survives restarts. Windows whose
reset time has passed count as empty again.

#### How an account is chosen

| Request | Account |
|---|---|
| First prompt of a conversation | `spread`: the account with the lowest load (highest 5-hour/weekly utilization, plus a small weight for each conversation started on it in the last 15 minutes). `fallback`: the first account in `order` with headroom. |
| Later prompts | The conversation's account, unless it is limited or past `switchAtPercent`. |
| Tool results and other follow-ups | Always the account that answered last, so prompt caches and thinking signatures stay valid. |
| Automatic retry after an error | Another available account; if none, the same one. |
| Every account limited or exhausted | The least-used account that is not hard-limited, otherwise the one whose limit resets first. |

The recent-conversation weight means a burst of parallel threads (for example
several T3 Code threads opened together) is split across accounts even before
any usage numbers come back. The conversation's account is stored in the Pi
session, so resuming a session keeps it.

#### Limits

An account is marked limited, for every process, when:

- a response fails with a rate-limit, usage-limit, 429, quota or billing error,
- Claude Code reports a window as `rejected` or fully used, or
- a response was charged to usage credits instead of plan limits.

It stays limited until Claude Code's reported reset time, or `cooldownMinutes`
if none was reported. What happens to the failed turn:

- **Rate-limit errors** are retried by Pi on the other account, if Pi's retries
  are enabled (`"retry": { "enabled": true }` in Pi's settings).
- **Usage-credit (billing) errors** are never retried, so you are not charged
  again. The next prompt you send goes to another account.
- Ordinary server errors (overloaded, 5xx) do not mark the account limited;
  Pi retries them normally.

You see a notice when an account is limited or a conversation is moved, and the
footer shows the account in use (`claude: auto`, `claude: Personal`, ...).

#### Trade-offs

- Moving a conversation to another account replays it once and loses the
  prompt cache, so it is slower and uses more quota for that turn.
- Usage is only learned from responses. An account that has not been used for
  a while shows its last known numbers until their reset time passes.
- Concurrent processes write the usage file with atomic replace; two writes at
  the same instant can drop one sample, which the next response refreshes.

#### Commands

- `/claude-code-status`: every account's login and plan, 5-hour and weekly
  usage with reset times, remembered limits, the routing strategy and the
  config and usage file paths. Example:

  ```
  ✓ Main (pro) → claude-code
      5h 22% (resets in 3h 10m) · week 54% (resets in 2d 4h)
  ✓ Personal (pro) → claude-code-personal [/Users/you/.claude_personal]
      5h 0% · week 0%
  Auto routing: claude-code-auto/* · spread · order claude-code → claude-code-personal · switch at 95%
  ```

- `/claude-code-reset-limits`: forget remembered limits so auto routing tries
  every account again.

The usage-credit guard applies to every account. Each account's requests count
against that account's own subscription limits.

## Configuration

These environment variables are optional:

- `PI_CLAUDE_CODE_COMMAND`: path or name of the Claude Code executable
  (default: `claude`).
- `PI_CLAUDE_CODE_CONFIG_DIR`: Claude Code config directory to use. The
  extension passes it to Claude Code as `CLAUDE_CONFIG_DIR`.
- `PI_CLAUDE_CODE_POWERSHELL`: PowerShell executable used to run a `.ps1`
  `PI_CLAUDE_CODE_COMMAND` (default: `pwsh` when installed, otherwise
  `powershell.exe`).

### Windows

npm installs Claude Code as `claude.cmd` (and a `claude.ps1` for PowerShell).
Both forms work as `PI_CLAUDE_CODE_COMMAND`:

- `.cmd` and `.bat` launchers run through `cmd.exe` with their arguments
  escaped once and passed verbatim, so installation paths with spaces and
  arguments containing quotes or `&` reach Claude Code unchanged.
- `.ps1` launchers run in a noninteractive PowerShell session with
  `-NoProfile` and `-ExecutionPolicy Bypass`. The extension prefers `pwsh`
  (PowerShell 7) because Windows PowerShell 5.1 cannot forward every quoted
  argument from a script to a native program.

### Model discovery and privacy

The extension asks Claude Code for the account's model catalog automatically.
The discovery probe allows Claude Code's normal feature-flag and catalog traffic,
including its usage telemetry, because disabling feature flags hides models such
as Mythos and previous-generation models. This is a
[known Claude Code issue](https://github.com/anthropics/claude-code/issues/105923).
The probe sends no conversation history or generation request. Automatic CLI
updates, official marketplace auto-install, feedback uploads, and error reporting
remain disabled.

To opt out of discovery telemetry, set `DISABLE_TELEMETRY=1` before starting Pi.
Discovery also preserves inherited `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
`DO_NOT_TRACK`, and `DISABLE_GROWTHBOOK` settings. These can reduce the discovered
catalog; the extension does not remove them to restore missing models. Claude
Code treats any non-empty `DISABLE_TELEMETRY` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` value as enabled, including `0` or
`false`; unset them to allow normal discovery again. See
[Claude Code's environment variables](https://code.claude.com/docs/en/env-vars#features-that-need-feature-flag-fetching).

Conversation workers still disable telemetry and nonessential traffic regardless
of the discovery settings.

## Usage and billing

Requests made through this extension count against your Claude subscription's
usage quota and rate limits, the same as any other Claude Code usage. The
extension does not give you separate or unlimited usage.

The extension ignores `ANTHROPIC_API_KEY` in Claude Code child processes without
changing your environment. To avoid silently changing how you're authenticated
or billed, it still rejects auth-token, proxy, Bedrock, Vertex, or Foundry
overrides for Claude Code.

## Limitations

- The extension is experimental.
- Multi-account auto routing learns usage only from responses, and has been
  tested against simulated limits, not every real Anthropic limit message. A
  limit error worded differently may not be retried automatically; the account
  is still avoided once Claude Code reports the window.
- Branching, editing earlier messages, or changing settings mid-conversation
  starts a fresh Claude Code process that replays the conversation. The first
  response after that can be slower and may use more quota.
- Complex tool schemas (nullable types, `oneOf`, `allOf`, `anyOf`) may be
  simplified before Claude sees them.
- On Windows, Windows PowerShell 5.1 mangles quoted arguments (such as the
  inline MCP configuration JSON) when a `.ps1` launcher forwards them to a
  native program. Install PowerShell 7 or use the `claude.cmd` launcher in that
  case.
- Adding or removing tools in the middle of a conversation keeps the prompt
  cache only on supported models. On other models it may use more quota.

For details on how the extension works internally, see
[ARCHITECTURE.md](ARCHITECTURE.md).

## Development

```sh
npm ci --ignore-scripts
npm run check
npx -y node@22 --experimental-transform-types --test tests/*.test.ts
```

The test script relies on `--experimental-transform-types`, which Node 26
removed; run the tests with Node 22 as above. To pull upstream changes:

```sh
git remote add upstream https://github.com/earendil-works/pi-claude-code.git
git fetch upstream && git merge upstream/main
```

Fork-specific code lives in `src/accounts.ts` (configuration),
`src/usage-store.ts` (shared usage file), `src/auto-router.ts` (routing policy)
and `src/index.ts` (registration and commands).
