/**
 * manual-approval — Bash whitelist with interactive approval for non-whitelisted commands.
 *
 * Works alongside the built-in permission-gate (set LITTLE_CODER_PERMISSION_MODE=accept-all
 * so permission-gate passes everything through, then this extension gates what matters).
 *
 * Config: ~/.config/little-coder/manual-approval.json
 *   - bashAllow: array of command prefixes to allow silently
 *   - blockTools: tool names to gate (default: ["bash", "ShellSession"])
 *   - autoBlockHeadless: block in headless mode (default: true)
 *   - enabled: false to disable entirely
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent/dist/core/extensions/types.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent/dist/core/extensions/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============ Config ============

/** Extension configuration loaded from manual-approval.json. */
interface Config {
  enabled?: boolean;
  bashAllow?: string[] | null;
  autoBlockHeadless?: boolean;
  blockTools?: string[];
}

/** Load config from ~/.config/little-coder/manual-approval.json. Returns empty object on error. */
export function loadConfig(): Config {
  const configPath = join(process.env.HOME ?? "", ".config", "little-coder", "manual-approval.json");
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

// ============ Shell parsing ============

/** Redirection targets considered safe (no file overwrite risk). */
const SAFE_REDIRECT_TARGETS = ["/dev/null", "/dev/stdout", "/dev/stderr"];

/** Precompiled regex for safe fd redirects like &1, &2, &3. */
const SAFE_FD_REDIRECT = /^&\d+$/;

/** Precompiled regex to extract a redirect target word (stops at shell metacharacters). */
const REDIRECT_TARGET_RE = /[^\s)>;|]+/;

/** Precompiled regex to strip trailing &&/|| operator chars from a split part. */
const TRAILING_OPERATOR_RE = /[&|]+$/;

/**
 * Precompute quote/escape state for every character in a command string.
 * Returns an array indexed by character position.
 */
export function quoteMap(cmd: string): Array<{ inSingle: boolean; inDouble: boolean; escaped: boolean }> {
  const map: Array<{ inSingle: boolean; inDouble: boolean; escaped: boolean }> = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) {
      escaped = false;
      map.push({ inSingle, inDouble, escaped: true });
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      map.push({ inSingle, inDouble, escaped: false });
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }
    map.push({ inSingle, inDouble, escaped: false });
  }
  return map;
}

/**
 * Check if a character at a given position is a shell split operator.
 * - `;`, `|`, `&` are split operators
 * - First `&` of `&&` and first `|` of `||` are NOT (split on the second char)
 * - `&` after `>` is fd redirection, NOT a background operator
 * - `<` and `(` are excluded (input redirection and grouping)
 */
export function isSplitChar(ch: string, cmd: string, pos: number): boolean {
  if (ch === "&" && cmd[pos + 1] === "&") return false; // first & of &&
  if (ch === "&" && pos > 0 && cmd[pos - 1] === ">") return false; // >& fd redirect
  if (ch === "|" && cmd[pos + 1] === "|") return false; // first | of ||
  return ch === ";" || ch === "|" || ch === "&";
}

/**
 * Split a shell command into sub-commands on metacharacters.
 * Respects quotes and escapes — split chars inside quotes are ignored.
 * Returns each sub-command with its original character offset.
 */
export function splitCompoundCommand(cmd: string): { text: string; offset: number }[] {
  const parts: { text: string; offset: number }[] = [];
  let current = "";
  let start = 0;
  const qm = quoteMap(cmd);

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const { inSingle, inDouble, escaped } = qm[i];
    if (!inSingle && !inDouble && !escaped && isSplitChar(ch, cmd, i)) {
      flushPart();
      current = "";
      start = i + 1;
      continue;
    }
    current += ch;
  }
  flushPart();
  return parts;

  /** Flush the accumulated text as a part (if non-empty after trimming). */
  function flushPart() {
    const trimmed = current.trim();
    if (trimmed) {
      parts.push({ text: trimmed, offset: cmd.indexOf(trimmed, start) });
    }
  }
}

/**
 * Strip matching outer parentheses from a command (subshell grouping).
 * Handles nested parens: ((ls)) → ls, ( (ls | head) ) → ls | head
 */
export function stripOuterParens(cmd: string): string {
  let s = cmd.trim();
  while (s.startsWith("(") && s.endsWith(")") && s.length > 2) {
    let depth = 0;
    let matchEnd = -1;
    for (let j = 0; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")") depth--;
      if (depth === 0) { matchEnd = j; break; }
    }
    if (matchEnd === s.length - 1) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return s;
}

// ============ Gate diagnostics ============

/** Describes why a specific span of a command was flagged. */
export interface GateDiagnostic {
  reason: string;  // human-readable reason string (also used as "don't ask again" key)
  pos: number;     // character offset in the original command
  len: number;     // length of the flagged span
}

/**
 * Scan a command for dangerous shell constructs.
 * Returns ALL diagnostics found (not just the first).
 *
 * Dangerous constructs:
 * - $() command substitution (executes arbitrary code)
 * - `backtick` command substitution (executes arbitrary code)
 * - > / >> file-write redirection (can overwrite files)
 * - <() process substitution (executes arbitrary code)
 *
 * Safe patterns that pass through:
 * - $() and ` inside single quotes (literal)
 * - > inside single or double quotes (literal)
 * - > /dev/null, > /dev/stdout, > /dev/stderr (safe targets)
 * - >&N, 2>&1 (fd redirects, no file write)
 * - < input redirection (not dangerous)
 * - Escaped characters: \$(), \` , \>
 */
export function scanDangerousAll(cmd: string): GateDiagnostic[] {
  const diags: GateDiagnostic[] = [];
  const qm = quoteMap(cmd);

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const { inSingle, inDouble, escaped } = qm[i];
    if (escaped) continue;

    // $() and backticks execute inside double quotes — only single quotes protect
    if (!inSingle) {
      if (ch === "$" && cmd[i + 1] === "(") {
        diags.push({ reason: "command substitution $()", pos: i, len: 2 });
        continue;
      }
      if (ch === "`") {
        const end = cmd.indexOf("`", i + 1);
        diags.push({
          reason: "backtick command substitution",
          pos: i,
          len: end > 0 ? end - i + 1 : 1,
        });
        if (end > 0) i = end; // skip past closing backtick
        continue;
      }
    }

    // > redirection — literal inside both single and double quotes
    if (!inSingle && !inDouble && ch === ">") {
      let end = i + 1;
      if (cmd[end] === ">") end++; // handle >>

      // Find the redirect target (skip whitespace)
      let targetStart = end;
      while (targetStart < cmd.length && cmd[targetStart] === " ") targetStart++;

      // Extract the target word (stops at shell metacharacters)
      const target = cmd.slice(targetStart).match(REDIRECT_TARGET_RE)?.[0] ?? "";

      // Check if it's a safe target
      if (!SAFE_REDIRECT_TARGETS.includes(target) && !SAFE_FD_REDIRECT.test(target)) {
        diags.push({ reason: "unsafe file-write redirection", pos: i, len: end - i });
      }

      // Skip past the target to continue scanning
      i = targetStart - 1;
      continue;
    }

    // <() process substitution
    if (!inSingle && !inDouble && ch === "<" && cmd[i + 1] === "(") {
      diags.push({ reason: "process substitution <()", pos: i, len: 2 });
    }
  }
  return diags;
}

/**
 * Check each sub-command against the whitelist.
 * Returns ALL diagnostics for non-whitelisted sub-commands.
 */
export function checkWhitelistAll(cmd: string, prefixes: string[]): GateDiagnostic[] {
  const diags: GateDiagnostic[] = [];
  const effective = stripOuterParens(cmd);
  const parts = splitCompoundCommand(effective);

  for (const part of parts) {
    // Strip trailing &&/|| operator chars, then strip grouping parens
    let text = part.text.replace(TRAILING_OPERATOR_RE, "").trim();
    text = stripOuterParens(text);

    // Match: "ls -la" starts with "ls ", OR bare "ls" equals prefix without trailing space
    if (prefixes.some((p) => text.startsWith(p) || text === p.replace(/ +$/, ""))) {
      continue;
    }

    const firstWord = text.split(/\s+/)[0];
    diags.push({
      reason: `"${firstWord}" not whitelisted`,
      pos: part.offset,
      len: firstWord.length,
    });
  }
  return diags;
}

/**
 * Full gate check: returns ALL diagnostics for a command.
 * Dangerous constructs take priority over whitelist violations.
 */
export function checkCommandAll(cmd: string, prefixes: string[]): GateDiagnostic[] {
  const dangerous = scanDangerousAll(cmd);
  if (dangerous.length > 0) return dangerous;
  return checkWhitelistAll(cmd, prefixes);
}

/** Format a GCC-style diagnostic: command line + caret underline + reason. */
export function formatGateError(cmd: string, diag: GateDiagnostic): string {
  const line = cmd.slice(0, 200);
  const pad = " ".repeat(diag.pos);
  const caret = "^".repeat(Math.max(1, diag.len));
  return `${line}\n${pad}${caret}\n    ${diag.reason}`;
}

// ============ Extension ============

/** Truncate long strings for display in UI dialogs. */
export function preview(s: string): string {
  return s.length <= 200 ? s : s.slice(0, 200) + "...";
}

/** Options for the approval prompt. */
export interface ApprovalOptions {
  key: string;                 // "don't ask again" memory key
  title: string;               // dialog title
  description: string;         // text shown below the title
  defaultRefusal: string;      // fallback refusal message if no custom reason given
}

/**
 * Shared UI approval flow for both bash and non-bash tools.
 * Handles auto-allow, auto-block, and interactive prompt with optional refusal reason.
 *
 * @returns null if allowed, { block: true, reason } if denied
 */
export async function promptApproval(
  ctx: ExtensionUIContext,
  opts: ApprovalOptions,
  alwaysAllow: Set<string>,
  alwaysBlock: Map<string, string>,
): Promise<{ block: boolean; reason: string } | null> {
  // Auto-allow: user previously chose "don't ask again" for this key
  if (alwaysAllow.has(opts.key)) return null;

  // Auto-block: user previously denied with "don't ask again"
  const blockedReason = alwaysBlock.get(opts.key);
  if (blockedReason !== undefined) {
    return { block: true, reason: `Auto-blocked: ${blockedReason}` };
  }

  const choice = await ctx.ui.select(
    `${opts.title}\n\n${opts.description}`,
    ["Yes", "Yes (don't ask again)", "No", "No (don't ask again)"],
  );

  // Allow
  if (choice === "Yes" || choice === "Yes (don't ask again)") {
    if (choice === "Yes (don't ask again)") alwaysAllow.add(opts.key);
    return null;
  }

  // Deny — ask for optional custom reason
  const isDontAsk = choice === "No (don't ask again)";
  const reason = await ctx.ui.input(
    "Reason for refusal (optional)",
    "e.g. wrong file, unsafe, use different approach",
  );
  const refusalMsg = reason?.trim()
    ? `User denied: ${reason.trim()}`
    : opts.defaultRefusal;

  if (isDontAsk) {
    alwaysBlock.set(opts.key, refusalMsg);
  }

  return { block: true, reason: refusalMsg };
}

/** Handle a bash/ShellSession tool call: check all diagnostics, iterate through memory. */
export async function handleBashCall(
  ctx: ExtensionUIContext,
  toolName: string,
  cmd: string,
  whitelist: string[],
  autoBlockHeadless: boolean,
  alwaysAllow: Set<string>,
  alwaysBlock: Map<string, string>,
): Promise<{ block: boolean; reason: string } | undefined> {
  const allDiags = checkCommandAll(cmd, whitelist);
  if (allDiags.length === 0) return; // all clean

  // Iterate through diagnostics: skip auto-allowed, block on auto-blocked, prompt on unknown
  for (const diag of allDiags) {
    // Auto-allow — skip to next diagnostic
    if (alwaysAllow.has(diag.reason)) continue;

    // Auto-block — return immediately
    const blockedReason = alwaysBlock.get(diag.reason);
    if (blockedReason !== undefined) {
      return { block: true, reason: `Auto-blocked: ${blockedReason}` };
    }

    // Headless mode — no UI available
    if (!ctx.hasUI) {
      if (autoBlockHeadless) {
        return { block: true, reason: `${toolName} blocked:\n${formatGateError(cmd, diag)}` };
      }
      return;
    }

    // Interactive prompt
    const result = await promptApproval(ctx, {
      key: diag.reason,
      title: `Approve ${toolName} command?`,
      description: formatGateError(cmd, diag),
      defaultRefusal: `User denied ${toolName} command: ${preview(cmd)}`,
    }, alwaysAllow, alwaysBlock);

    if (result?.block) return result;
    // If allowed (with or without "don't ask again"), continue to next diagnostic
  }
}

/** Handle a non-bash tool call: always prompt for approval. */
export async function handleToolCall(
  ctx: ExtensionUIContext,
  toolName: string,
  input: unknown,
  autoBlockHeadless: boolean,
  alwaysAllow: Set<string>,
  alwaysBlock: Map<string, string>,
): Promise<{ block: boolean; reason: string } | undefined> {
  // Headless mode
  if (!ctx.hasUI) {
    if (autoBlockHeadless) {
      return { block: true, reason: `Tool '${toolName}' blocked (headless mode)` };
    }
    return;
  }

  const result = await promptApproval(ctx, {
    key: `tool:${toolName}`,
    title: `Approve ${toolName}?`,
    description: preview(JSON.stringify(input ?? {}, null, 2)),
    defaultRefusal: `User denied tool '${toolName}'`,
  }, alwaysAllow, alwaysBlock);

  return result ?? undefined;
}

/** Extension entry point. */
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  if (config.enabled === false) return;

  const whitelist = config.bashAllow ?? [];
  const blockTools = config.blockTools ?? ["bash", "ShellSession"];
  const autoBlockHeadless = config.autoBlockHeadless ?? true;

  // Session-level "don't ask again" memory (cleared on restart).
  const alwaysBlock = new Map<string, string>(); // key → refusal message
  const alwaysAllow = new Set<string>();         // key → pass silently

  pi.on("tool_call", async (event, ctx) => {
    const toolName = (event as any).toolName;
    if (!blockTools.includes(toolName)) return;

    // Bash / ShellSession: whitelist + dangerous construct check
    if (toolName === "bash" || toolName === "ShellSession") {
      const cmd = (event as any).input?.command ?? (event as any).input?.commands?.[0];
      if (!cmd) return;
      return handleBashCall(ctx, toolName, cmd, whitelist, autoBlockHeadless, alwaysAllow, alwaysBlock);
    }

    // Non-bash tools: always prompt
    return handleToolCall(ctx, toolName, (event as any).input, autoBlockHeadless, alwaysAllow, alwaysBlock);
  });
}
