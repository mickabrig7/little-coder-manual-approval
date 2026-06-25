# manual-approval

A [little-coder](https://github.com/itayinbarr/little-coder) extension that gates shell commands and tool calls behind a configurable whitelist with interactive approval. Whitelisted commands pass silently; everything else triggers a Yes/No dialog with optional refusal reason and session-persistent "Don't ask again" memory.

## Features

- **Conservative whitelist** — only explicitly allowed commands pass without prompting
- **Compound command detection** — `echo ok; rm file` is caught, not just the first word
- **Dangerous construct scanning** — `$()`, backticks, `>` redirection, `<()` process substitution
- **GCC-style diagnostics** — caret underlining shows exactly which span triggered the gate
- **Quote-aware parsing** — `$()` inside single quotes is literal, `>` inside quotes is literal
- **Safe redirect auto-allow** — `>/dev/null`, `2>&1`, `>&1`, `>/dev/stdout` pass silently
- **Session-persistent memory** — "Don't ask again" choices persist for the session (cleared on restart)
- **Custom refusal reasons** — denied commands feed back a reason to the model as the tool-error message
- **Auto-block replay** — auto-blocked commands replay the user's original refusal reason
- **ShellSession parity** — `ShellSession` is gated identically to `bash`
- **Non-bash tool gating** — any tool in `blockTools` gets interactive approval
- **Headless mode** — auto-blocks non-whitelisted commands when no UI is available
- **388 unit tests** — comprehensive coverage of all parsing, gating, and UI logic

## Installation

### 1. Install the extension

```bash
mkdir -p ~/.config/little-coder/extensions/manual-approval
cp index.ts ~/.config/little-coder/extensions/manual-approval/
```

### 2. Create the config file

```bash
cp manual-approval.json ~/.config/little-coder/
```

Edit `~/.config/little-coder/manual-approval.json` to customize the whitelist and blocked tools:

```json
{
  "enabled": true,
  "bashAllow": [
    "ls ", "cat ", "head ", "tail ", "wc ", "pwd ", "echo ", "printf ", "date ",
    "which ", "type ", "env ", "printenv ", "uname ", "whoami ", "id ",
    "git log", "git status", "git diff", "git show", "git stash list",
    "grep ", "rg ", "ag ", "fd ",
    "pip show", "pip list", "npm list", "cargo metadata",
    "df ", "du ", "free ", "top -bn", "ps "
  ],
  "autoBlockHeadless": true,
  "blockTools": ["bash", "edit", "write", "ShellSession"]
}
```

### 3. Disable the built-in permission-gate

The built-in `permission-gate` extension uses simple prefix matching and doesn't handle compound commands. Set it to pass-through mode so this extension handles all gating:

```bash
export LITTLE_CODER_PERMISSION_MODE=accept-all
```

### 4. Enable the extension

Start little-coder by passing `manual-approval` as argument:

```jsonc
little-coder -e ~/.config/little-coder/extensions/manual-approval/index.ts
```

## Configuration

### `bashAllow` (string[])

Array of command prefixes that pass silently. A command is whitelisted if:

- It **starts with** a prefix (e.g. `"ls -la"` starts with `"ls "`)
- It **equals** the prefix with trailing spaces stripped (e.g. bare `"ls"` equals `"ls "` minus the space).

Both forms — with and without trailing space — match bare commands and commands with arguments; the trailing space additionally prevents substring matches (e.g. `"ls "` won't match `"lsof"`).

### `blockTools` (string[])

Tool names to gate. The shipped config defaults to `["bash", "edit", "write", "ShellSession"]`. Add any tool name to require approval before it runs:

```json
"blockTools": ["bash", "edit", "write", "ShellSession", "BrowserNavigate"]
```

### `autoBlockHeadless` (boolean)

When `true` (shipped default), non-whitelisted commands are auto-blocked in headless mode (no UI). When `false`, they pass through silently.

### `enabled` (boolean)

Set to `false` to disable the extension entirely without removing it.

## How it works

### Shell parsing pipeline

1. **`quoteMap(cmd)`** — precomputes quote/escape state for every character position. Tracks single quotes, double quotes, and backslash escapes.
2. **`stripOuterParens(cmd)`** — removes matching outer parentheses for subshell grouping: `(ls; pwd)` → `ls; pwd`, `((ls))` → `ls`.
3. **`splitCompoundCommand(cmd)`** — splits on `;`, `|`, `&&`, `||`, `&` while respecting quotes and escapes. Returns each sub-command with its original character offset.
4. **`scanDangerousAll(cmd)`** — scans for dangerous constructs: `$()`, backticks, `>` redirection, `<()`. Returns all violations found.
5. **`checkWhitelistAll(cmd, prefixes)`** — checks each sub-command against the whitelist. Returns all non-whitelisted sub-commands.
6. **`checkCommandAll(cmd, prefixes)`** — combines dangerous + whitelist checks. Dangerous constructs take priority.

### Diagnostic format

Each violation is a `GateDiagnostic` with `reason`, `pos`, and `len`. Formatted as GCC-style output:

```
echo ok; rm -rf /tmp/data
         ^^
    "rm" not whitelisted
```

### Approval flow

For each diagnostic in a command:

1. **Auto-allow** — if the reason is in `alwaysAllow`, skip to the next diagnostic
2. **Auto-block** — if the reason is in `alwaysBlock`, return immediately with the stored refusal reason (prefixed with `Auto-blocked:`)
3. **Headless** — if no UI and `autoBlockHeadless` is true, block with diagnostic
4. **Interactive** — prompt with `select()` offering: `Yes`, `Yes (don't ask again)`, `No`, `No (don't ask again)`
5. **Custom reason** — on `No` choices, prompt for an optional refusal reason via `input()`
6. **Memory update** — "don't ask again" choices update `alwaysAllow` or `alwaysBlock`

Multiple diagnostics in a single command are checked sequentially. Auto-allowing one reason does not skip remaining sub-commands.

### "Don't ask again" memory

- **Keyed by diagnostic reason**, not the exact command string
- Examples: `"rm" not whitelisted`, `command substitution $()`, `unsafe file-write redirection`
- **Session-persistent** — survives across tool calls within a session, cleared on restart
- **Applies to all tools** — non-bash tools use `tool:${toolName}` as the key
- **Auto-blocks replay the user's custom refusal reason**, not the diagnostic

## Security model

### What passes silently

- Commands matching a `bashAllow` prefix
- Safe redirections: `>/dev/null`, `>>/dev/null`, `>/dev/stdout`, `>/dev/stderr`, `>&1`, `>&2`, `2>&1`
- `$()` and backticks inside single quotes (literal strings)
- `>` inside single or double quotes (literal strings)
- `<` input redirection (not dangerous)
- Escaped characters: `\$()`, `` \` ``, `\>`

### What requires approval

- Non-whitelisted commands (any command not in `bashAllow`)
- `$()` command substitution (outside single quotes)
- `` `backtick` `` command substitution (outside single quotes)
- `>` file-write redirection to non-safe targets
- `<()` process substitution
- Compound commands with any non-whitelisted sub-command
- Any tool in `blockTools` that isn't bash/ShellSession

### What is NOT caught

This extension is a security improvement, not a complete sandbox. It does not catch:

- `eval`, `exec`, or other built-in shell commands that execute strings
- File reads via `cat`, `head`, `tail` (whitelisted by default)
- Network access via `grep`, `git` (whitelisted by default)
- Commands with dangerous flags (e.g. `rm -rf /` if `rm` were whitelisted)
- Obfuscated commands using variable expansion (`$CMD`)
- Heredocs with command substitution inside

**Always review what the agent is doing.** This extension is a guardrail, not a replacement for supervision.

## Testing

```bash
cd ~/.config/little-coder/extensions/manual-approval
npx tsx test.ts
```

The test suite covers 388 cases across:

| Section | Cases | Coverage |
|---|---|---|
| `quoteMap` | 16 | Quote/escape state tracking |
| `stripOuterParens` | 13 | Paren stripping, nesting, edge cases |
| `isSplitChar` | 13 | Split operator detection |
| `preview` | 5 | Command truncation |
| `loadConfig` | 4 | Config file loading, missing file |
| `promptApproval` | 10 | Auto-allow, auto-block, interactive, memory |
| `handleBashCall` | 11 | Clean pass, non-wl prompt, headless, multi-diag |
| `handleToolCall` | 8 | Non-bash tool gating, memory |
| Extension entry point | 5 | Handler registration, tool routing |
| `splitCompoundCommand` | 47 | All compound patterns, quotes, escapes |
| `scanDangerousAll` | 55 | `$()`, backticks, `>`, `<()`, safe redirects |
| Prefix matching semantics | 14 | `startsWith` vs `===` fallback, trailing space |
| Whitelist matching | 48 | All whitelist entries, bare commands, substring guards |
| Compound commands | 20 | `;`, `&&`, `||`, `|`, `&` combinations |
| Command grouping | 13 | `(…)`, nested, spaced, piped |
| Input redirection | 3 | `<` patterns |
| Edge cases | 12 | Quotes, escaping, long commands |
| `checkWhitelistAll` | 10 | Multi-diagnostic whitelist |
| `checkCommandAll` multi-diag | 7 | Combined dangerous + whitelist |
| `formatGateError` | 6 | GCC-style diagnostic formatting |

## Architecture

This extension hooks into little-coder's `tool_call` event via the `ExtensionAPI`. It runs before the tool executes and can short-circuit execution by returning `{ block: true, reason: "..." }`. The reason is fed back to the model as the tool-error message.

The extension is designed to be non-invasive — it doesn't modify little-coder or any other extension. It reads configuration from a JSON file and uses the `ExtensionUIContext` for interactive prompts.

## License

MIT
