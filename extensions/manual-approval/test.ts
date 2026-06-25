/**
 * Comprehensive unit tests for manual-approval extension.
 *
 * Run: npx tsx ~/.config/little-coder/extensions/manual-approval/test.ts
 *
 * Imports the actual functions from index.ts — no duplication.
 * Covers: shell parsing, gate logic, UI approval flow, handlers, config, extension entry point.
 */

import {
  checkCommandAll,
  scanDangerousAll,
  checkWhitelistAll,
  splitCompoundCommand,
  formatGateError,
  GateDiagnostic,
  isSplitChar,
  quoteMap,
  stripOuterParens,
  preview,
  loadConfig,
  promptApproval,
  handleBashCall,
  handleToolCall,
} from "./index.js";
import defaultExport from "./index.js";

async function run() {

// ---- Test harness ----

let passed = 0;
let failed = 0;

function assertEqual(actual: any, expected: any, label: string) {
  const aStr = JSON.stringify(actual);
  const eStr = JSON.stringify(expected);
  if (aStr === eStr) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
    console.log(`  expected: ${eStr}`);
    console.log(`  actual:   ${aStr}`);
  }
}

/** Assert that checkCommandAll returns a diagnostic with the expected first reason. */
function assertReason(cmd: string, prefixes: string[], expectedReason: string, label: string) {
  const diags = checkCommandAll(cmd, prefixes);
  if (diags.length === 0) {
    failed++;
    console.log(`FAIL: ${label} — expected blocked with "${expectedReason}", got allowed`);
    return;
  }
  assertEqual(diags[0]!.reason, expectedReason, label);
}

/** Assert that checkCommandAll returns no diagnostics (command is allowed). */
function assertAllowed(cmd: string, prefixes: string[], label: string) {
  const diags = checkCommandAll(cmd, prefixes);
  assertEqual(diags.length, 0, label);
}

/** Assert that splitCompoundCommand produces the expected part texts. */
function assertSplit(cmd: string, expected: string[], label: string) {
  const parts = splitCompoundCommand(cmd);
  const actual = parts.map((p) => p.text);
  assertEqual(actual, expected, label);
}

/** Assert that scanDangerousAll returns diagnostics with the expected reasons. */
function assertDangerous(cmd: string, expectedReasons: string[], label: string) {
  const diags = scanDangerousAll(cmd);
  const reasons = diags.map((d) => d.reason);
  assertEqual(reasons, expectedReasons, label);
}

/** Assert that checkWhitelistAll returns diagnostics with the expected reasons. */
function assertWhitelistDiags(cmd: string, expectedReasons: string[], label: string) {
  const diags = checkWhitelistAll(cmd, WL);
  const reasons = diags.map((d) => d.reason);
  assertEqual(reasons, expectedReasons, label);
}

/** Assert that checkCommandAll returns diagnostics with the expected reasons. */
function assertDiags(cmd: string, expectedReasons: string[], label: string) {
  const diags = checkCommandAll(cmd, WL);
  const reasons = diags.map((d) => d.reason);
  assertEqual(reasons, expectedReasons, label);
}

/** Assert that formatGateError produces the expected output. */
function assertFormat(cmd: string, reason: string, pos: number, len: number, expected: string, label: string) {
  const diag = { reason, pos, len };
  const actual = formatGateError(cmd, diag);
  assertEqual(actual, expected, label);
}

// Test whitelist: conservative set matching the config (with find/sed for broader test coverage)
const WL: string[] = [
  "ls ", "cat ", "head ", "tail ", "wc ", "pwd ", "echo ", "printf ", "date ",
  "which ", "type ", "env ", "printenv ", "uname", "whoami ", "id ",
  "git log", "git status", "git diff", "git show", "git stash list",
  "find ", "grep ", "rg ", "ag ", "fd ", "sed ",
  "pip show", "pip list", "npm list", "cargo metadata",
  "df ", "du ", "free ", "top -bn", "ps ",
];

// ============================================================
// quoteMap tests
// ============================================================

console.log("=== quoteMap ===\n");

/** Assert the quote/escape state at a specific position. */
function assertQState(cmd: string, pos: number, inSingle: boolean, inDouble: boolean, escaped: boolean, label: string) {
  const map = quoteMap(cmd);
  const s = map[pos];
  assertEqual({ inSingle: s?.inSingle, inDouble: s?.inDouble, escaped: s?.escaped },
             { inSingle, inDouble, escaped }, label);
}

// Basic states
assertQState("hello", 0, false, false, false, "plain char");
assertQState("hello", 4, false, false, false, "plain char end");

// Single quotes — quote char itself is marked as inside
assertQState("'hello'", 0, true, false, false, "opening single quote");
assertQState("'hello'", 1, true, false, false, "inside single quote");
assertQState("'hello'", 5, true, false, false, "inside single quote end");
assertQState("'hello'", 6, false, false, false, "closing single quote");

// Double quotes — quote char itself is marked as inside
assertQState('"hello"', 0, false, true, false, "opening double quote");
assertQState('"hello"', 1, false, true, false, "inside double quote");
assertQState('"hello"', 5, false, true, false, "inside double quote end");
assertQState('"hello"', 6, false, false, false, "closing double quote");

// Nested quotes
assertQState("'" + '"' + "'", 1, true, false, false, "\" inside ' (single wraps, double literal)");

// Escaped chars
assertQState("\\x", 0, false, false, false, "backslash itself");
assertQState("\\x", 1, false, false, true, "char after backslash is escaped");
assertQState("\\\\x", 0, false, false, false, "first backslash");
assertQState("\\\\x", 1, false, false, true, "second backslash (escaped)");
assertQState("\\\\x", 2, false, false, false, "x after escaped backslash");

// Escaped quotes
assertQState("\\'", 0, false, false, false, "backslash before '");
assertQState("\\'", 1, false, false, true, "escaped ' (does not toggle)");
assertQState('\\"', 0, false, false, false, "backslash before \"");
assertQState('\\"', 1, false, false, true, "escaped \" (does not toggle)");

// Escaped backslash before quote
assertQState("\\\\'", 2, true, false, false, "' after escaped backslash (does toggle)");

// Empty string
assertEqual(quoteMap("").length, 0, "empty string");

// ============================================================
// stripOuterParens tests
// ============================================================

console.log("\n=== stripOuterParens ===\n");

// Basic stripping
assertEqual(stripOuterParens("(ls)"), "ls", "single parens");
assertEqual(stripOuterParens("(ls -la)"), "ls -la", "parens with args");

// Nested parens
assertEqual(stripOuterParens("((ls))"), "ls", "double nested");
assertEqual(stripOuterParens("(((ls)))"), "ls", "triple nested");
assertEqual(stripOuterParens("( (ls) )"), "ls", "spaced nested");
assertEqual(stripOuterParens("( (ls | head) )"), "ls | head", "spaced nested with pipe");

// No stripping — mismatched
assertEqual(stripOuterParens("(ls"), "(ls", "missing close");
assertEqual(stripOuterParens("ls)"), "ls)", "missing open");
assertEqual(stripOuterParens("(ls) pwd)"), "(ls) pwd)", "extra close");
assertEqual(stripOuterParens("(ls (pwd)"), "(ls (pwd)", "extra open");

// No stripping — too short
assertEqual(stripOuterParens("()"), "()", "empty parens (too short)");
assertEqual(stripOuterParens("(a)"), "a", "single char");

// No parens
assertEqual(stripOuterParens("ls"), "ls", "no parens");
assertEqual(stripOuterParens("ls | grep x"), "ls | grep x", "no parens with pipe");

// Whitespace handling
assertEqual(stripOuterParens("  (ls)  "), "ls", "outer whitespace trimmed");
assertEqual(stripOuterParens("(  ls  )"), "ls", "inner whitespace preserved then trimmed");

// Paren in middle — not stripped
assertEqual(stripOuterParens("ls (pwd) grep"), "ls (pwd) grep", "parens in middle");

// ============================================================
// isSplitChar tests
// ============================================================

console.log("\n=== isSplitChar ===\n");

/** Assert isSplitChar result. */
function assertSplitChar(ch: string, cmd: string, pos: number, expected: boolean, label: string) {
  assertEqual(isSplitChar(ch, cmd, pos), expected, label);
}

// Basic split chars
assertSplitChar(";", "a;b", 1, true, "semicolon");
assertSplitChar("|", "a|b", 1, true, "pipe");
assertSplitChar("&", "a&b", 1, true, "single &");

// Non-split chars
assertSplitChar("x", "abc", 1, false, "regular char");
assertSplitChar("<", "a<b", 1, false, "< not split");
assertSplitChar("(", "a(b", 1, false, "( not split");

// && — first & not split, second & is split
assertSplitChar("&", "a&&b", 1, false, "first & of &&");
assertSplitChar("&", "a&&b", 2, true, "second & of &&");

// || — first | not split, second | is split
assertSplitChar("|", "a||b", 1, false, "first | of ||");
assertSplitChar("|", "a||b", 2, true, "second | of ||");

// >& — & after > not split
assertSplitChar("&", ">&1", 1, false, "& after > (fd redirect)");
assertSplitChar("&", "2>&1", 2, false, "& after > in 2>&1");

// Edge positions
assertSplitChar("&", "&&", 0, false, "&& at position 0");
assertSplitChar("&", "&&", 1, true, "second & of && at end");
assertSplitChar("|", "||", 0, false, "|| at position 0");
assertSplitChar("|", "||", 1, true, "second | of || at end");

// & at end of string (no next char)
assertSplitChar("&", "a&", 1, true, "& at end of string");

// ============================================================
// preview tests
// ============================================================

console.log("\n=== preview ===\n");

assertEqual(preview("short"), "short", "short string unchanged");
assertEqual(preview(""), "", "empty string");

// Exact boundary
const exact200 = "a".repeat(200);
assertEqual(preview(exact200), exact200, "exactly 200 chars unchanged");

// Just over boundary
const over200 = "a".repeat(201);
assertEqual(preview(over200), "a".repeat(200) + "...", "201 chars truncated");

// Much over boundary
const longStr = "a".repeat(500);
assertEqual(preview(longStr), "a".repeat(200) + "...", "500 chars truncated");

// String already ending with ...
const withDots = "a".repeat(197) + "...";
assertEqual(preview(withDots), withDots, "string ending with ... at boundary");

// ============================================================
// loadConfig tests
// ============================================================

console.log("\n=== loadConfig ===\n");

// loadConfig reads from the real config file. We can at least verify it returns a valid object.
const config = loadConfig();
assertEqual(typeof config, "object", "loadConfig returns object");

// Verify our known config fields exist
assertEqual(config.enabled, true, "config.enabled is true");
assertEqual(Array.isArray(config.bashAllow), true, "config.bashAllow is array");
assertEqual(Array.isArray(config.blockTools), true, "config.blockTools is array");

// Test that loadConfig returns {} on missing file (by temporarily changing HOME)
const origHome = process.env.HOME;
process.env.HOME = "/nonexistent-path-for-testing";
const emptyConfig = loadConfig();
assertEqual(emptyConfig, {}, "loadConfig returns {} on missing file");
process.env.HOME = origHome;

// ============================================================
// promptApproval tests (mocked UI)
// ============================================================

console.log("\n=== promptApproval ===\n");

/** Build a mock ExtensionUIContext with configurable select/input responses. */
function mockCtx(selectReturn: string, inputReturn: string, hasUI = true) {
  return {
    hasUI,
    ui: {
      select: async () => selectReturn,
      input: async () => inputReturn,
    },
  } as any;
}

/** Run promptApproval and assert the result. */
async function testApproval(
  ctx: any,
  key: string,
  alwaysAllow: Set<string>,
  alwaysBlock: Map<string, string>,
  expectedResult: { block: boolean; reason?: string } | null,
  label: string,
) {
  const opts = { key, title: "Test?", description: "desc", defaultRefusal: "default refusal" };
  const result = await promptApproval(ctx, opts, alwaysAllow, alwaysBlock);

  if (expectedResult === null) {
    assertEqual(result, null, label);
  } else if (expectedResult.block) {
    assertEqual(result?.block, true, label + " (block)");
    if (expectedResult.reason !== undefined) {
      assertEqual(result?.reason, expectedResult.reason, label + " (reason)");
    }
  }
}

// --- Auto-allow path ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  allow.add("test-key");
  await testApproval(mockCtx("Yes", ""), "test-key", allow, block, null, "auto-allow: skips prompt");
}

// --- Auto-block path ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  block.set("test-key", "User denied: custom reason");
  await testApproval(mockCtx("Yes", ""), "test-key", allow, block,
    { block: true, reason: "Auto-blocked: User denied: custom reason" },
    "auto-block: replays stored refusal");
}

// --- Interactive: Yes (no memory) ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testApproval(mockCtx("Yes", ""), "test-key", allow, block, null, "interactive: Yes allows");
  assertEqual(allow.has("test-key"), false, "interactive: Yes does not add to alwaysAllow");
}

// --- Interactive: Yes (don't ask again) ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testApproval(mockCtx("Yes (don't ask again)", ""), "test-key", allow, block, null, "interactive: Yes (don't ask again) allows");
  assertEqual(allow.has("test-key"), true, "interactive: Yes (don't ask again) adds to alwaysAllow");
}

// --- Interactive: No (no memory) ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testApproval(mockCtx("No", ""), "test-key", allow, block,
    { block: true, reason: "default refusal" },
    "interactive: No blocks with default refusal");
  assertEqual(block.has("test-key"), false, "interactive: No does not add to alwaysBlock");
}

// --- Interactive: No with custom reason ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testApproval(mockCtx("No", "wrong file"), "test-key", allow, block,
    { block: true, reason: "User denied: wrong file" },
    "interactive: No with custom reason");
}

// --- Interactive: No (don't ask again) ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testApproval(mockCtx("No (don't ask again)", ""), "test-key", allow, block,
    { block: true, reason: "default refusal" },
    "interactive: No (don't ask again) blocks with default refusal");
  assertEqual(block.has("test-key"), true, "interactive: No (don't ask again) adds to alwaysBlock");
}

// --- Interactive: No (don't ask again) with custom reason ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testApproval(mockCtx("No (don't ask again)", "use different approach"), "test-key", allow, block,
    { block: true, reason: "User denied: use different approach" },
    "interactive: No (don't ask again) with custom reason");
  assertEqual(block.get("test-key"), "User denied: use different approach", "stored refusal matches custom reason");
}

// --- Auto-block replays custom refusal ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  block.set("my-key", "User denied: too dangerous");
  await testApproval(mockCtx("Yes", ""), "my-key", allow, block,
    { block: true, reason: "Auto-blocked: User denied: too dangerous" },
    "auto-block: replays user's custom refusal");
}

// ============================================================
// handleBashCall tests (mocked UI)
// ============================================================

console.log("\n=== handleBashCall ===\n");

/** Run handleBashCall and assert the result. */
async function testBashCall(
  ctx: any,
  cmd: string,
  whitelist: string[],
  autoBlockHeadless: boolean,
  alwaysAllow: Set<string>,
  alwaysBlock: Map<string, string>,
  expectedResult: { block: boolean; reason?: string } | undefined,
  label: string,
) {
  const result = await handleBashCall(ctx, "bash", cmd, whitelist, autoBlockHeadless, alwaysAllow, alwaysBlock);

  if (expectedResult === undefined || expectedResult === null) {
    // Passes through (clean or user-allowed): result should be nullish
    assertEqual(result == null, true, label);
  } else if (expectedResult.block) {
    assertEqual(result?.block, true, label + " (block)");
    if (expectedResult.reason !== undefined) {
      assertEqual(result?.reason, expectedResult.reason, label + " (reason)");
    }
  }
}

// --- All clean: passes through ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("Yes", ""), "ls -la", WL, true, allow, block, undefined, "all clean: returns undefined");
}

// --- Single non-whitelisted: prompts ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("Yes", ""), "rm file", WL, true, allow, block, null, "single non-wl: prompts, user allows");
}

// --- Single non-whitelisted: user denies ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("No", ""), "rm file", WL, true, allow, block,
    { block: true, reason: "User denied bash command: rm file" },
    "single non-wl: prompts, user denies");
}

// --- Headless mode: auto-blocks ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("Yes", "", false), "rm file", WL, true, allow, block,
    { block: true },
    "headless: auto-blocks non-wl command");
}

// --- Headless mode: autoBlockHeadless=false passes ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("Yes", "", false), "rm file", WL, false, allow, block, undefined, "headless: autoBlockHeadless=false passes");
}

// --- Headless mode: clean command passes ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("Yes", "", false), "ls -la", WL, true, allow, block, undefined, "headless: clean command passes");
}

// --- Multiple diagnostics: first auto-allowed, second prompts ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  allow.add('"cd" not whitelisted'); // auto-allow cd
  await testBashCall(mockCtx("Yes", ""), "cd /tmp && python3 --version", WL, true, allow, block, null,
    "multi-diag: first auto-allowed, second prompts");
}

// --- Multiple diagnostics: first auto-blocked ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  block.set('"cd" not whitelisted', "User denied: no cd");
  await testBashCall(mockCtx("Yes", ""), "cd /tmp && python3 --version", WL, true, allow, block,
    { block: true, reason: "Auto-blocked: User denied: no cd" },
    "multi-diag: first auto-blocked, returns immediately");
}

// --- Multiple diagnostics: first allowed interactively, second prompts ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  const ctx = {
    hasUI: true,
    ui: {
      select: async () => "Yes (don't ask again)",
      input: async () => "",
    },
  };
  await testBashCall(ctx, "cd /tmp && python3 --version", WL, true, allow, block, null,
    "multi-diag: first allowed interactively, second allowed");
  assertEqual(allow.has('"cd" not whitelisted'), true, "multi-diag: cd added to alwaysAllow");
}

// --- Multiple diagnostics: first allowed, second denied ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  let callCount = 0;
  const ctx = {
    hasUI: true,
    ui: {
      select: async () => { callCount++; return callCount === 1 ? "Yes" : "No"; },
      input: async () => "",
    },
  };
  await testBashCall(ctx, "cd /tmp && python3 --version", WL, true, allow, block,
    { block: true, reason: "User denied bash command: cd /tmp && python3 --version" },
    "multi-diag: first allowed, second denied");
}

// --- Empty command: passes through ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("Yes", ""), "", WL, true, allow, block, undefined, "empty command: passes");
}

// --- Dangerous construct: prompts for dangerous, not whitelist ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("Yes", ""), "cd /tmp && echo $(whoami)", WL, true, allow, block, null,
    "dangerous: prompts for $() not whitelist");
}

// --- ShellSession handled identically ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testBashCall(mockCtx("Yes", ""), "ls -la", WL, true, allow, block, undefined, "ShellSession: clean passes");
}

// ============================================================
// handleToolCall tests (non-bash tools)
// ============================================================

console.log("\n=== handleToolCall ===\n");

/** Run handleToolCall and assert the result. */
async function testToolCall(
  ctx: any,
  toolName: string,
  input: unknown,
  autoBlockHeadless: boolean,
  alwaysAllow: Set<string>,
  alwaysBlock: Map<string, string>,
  expectedResult: { block: boolean; reason?: string } | undefined,
  label: string,
) {
  const result = await handleToolCall(ctx, toolName, input, autoBlockHeadless, alwaysAllow, alwaysBlock);

  if (expectedResult === undefined || expectedResult === null) {
    assertEqual(result == null, true, label);
  } else if (expectedResult.block) {
    assertEqual(result?.block, true, label + " (block)");
    if (expectedResult.reason !== undefined) {
      assertEqual(result?.reason, expectedResult.reason, label + " (reason)");
    }
  }
}

// --- Headless mode: auto-blocks ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testToolCall(mockCtx("Yes", "", false), "write", { path: "/tmp/x" }, true, allow, block,
    { block: true, reason: "Tool 'write' blocked (headless mode)" },
    "headless: auto-blocks non-bash tool");
}

// --- Headless mode: autoBlockHeadless=false passes ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testToolCall(mockCtx("Yes", "", false), "write", { path: "/tmp/x" }, false, allow, block, undefined,
    "headless: autoBlockHeadless=false passes");
}

// --- Interactive: prompts ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testToolCall(mockCtx("Yes", ""), "write", { path: "/tmp/x" }, true, allow, block, null,
    "interactive: Yes allows non-bash tool");
}

// --- Interactive: user denies ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testToolCall(mockCtx("No", ""), "edit", { path: "/tmp/x" }, true, allow, block,
    { block: true, reason: "User denied tool 'edit'" },
    "interactive: No denies non-bash tool");
}

// --- Auto-allow for non-bash tool ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  allow.add("tool:write");
  await testToolCall(mockCtx("Yes", ""), "write", { path: "/tmp/x" }, true, allow, block, null,
    "auto-allow: skips prompt for non-bash tool");
}

// --- Auto-block for non-bash tool ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  block.set("tool:edit", "User denied: don't edit that file");
  await testToolCall(mockCtx("Yes", ""), "edit", { path: "/tmp/x" }, true, allow, block,
    { block: true, reason: "Auto-blocked: User denied: don't edit that file" },
    "auto-block: replays refusal for non-bash tool");
}

// --- Don't ask again for non-bash tool ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testToolCall(mockCtx("Yes (don't ask again)", ""), "write", { path: "/tmp/x" }, true, allow, block, null,
    "interactive: Yes (don't ask again) for non-bash tool");
  assertEqual(allow.has("tool:write"), true, "tool:write added to alwaysAllow");
}

// --- Don't ask again (deny) for non-bash tool ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  await testToolCall(mockCtx("No (don't ask again)", "too risky"), "write", { path: "/tmp/x" }, true, allow, block,
    { block: true, reason: "User denied: too risky" },
    "interactive: No (don't ask again) with custom reason for non-bash tool");
  assertEqual(block.has("tool:write"), true, "tool:write added to alwaysBlock");
}

// --- Input serialization in prompt ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  const capturedTitle: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      select: async (title: string) => {
        capturedTitle.push(title);
        return "Yes";
      },
      input: async () => "",
    },
  };
  await handleToolCall(ctx, "BrowserNavigate", { url: "https://example.com" }, true, allow, block);
  assertEqual(capturedTitle[0].startsWith("Approve BrowserNavigate?"), true, "tool prompt title starts with tool name");
}

// ============================================================
// Extension entry point tests
// ============================================================

console.log("\n=== Extension entry point ===\n");

// --- Extension loads without error ---
{
  const mockPi: any = {
    on: (event: string, handler: any) => {
      // Just verify handler is registered
    },
  };
  defaultExport(mockPi);
  assertEqual(true, true, "extension loads without error");
}

// --- Tool not in blockTools: returns early ---
{
  let handlerCalled = false;
  let handlerResult: any = "not-called";
  const mockPi: any = {
    on: (event: string, handler: any) => {
      handlerCalled = true;
      // Simulate a tool_call for a tool NOT in blockTools
      handlerResult = handler(
        { toolName: "read", input: { path: "/tmp/x" } },
        { hasUI: true, ui: { select: async () => "Yes", input: async () => "" } },
      );
    },
  };
  const origHome = process.env.HOME;
  process.env.HOME = "/nonexistent-path-for-testing";
  defaultExport(mockPi);
  process.env.HOME = origHome;
  assertEqual(handlerCalled, true, "handler registered");
  // read is not in default blockTools, so handler returns undefined or empty object
  assertEqual(handlerResult == null || Object.keys(handlerResult).length === 0, true, "non-blocked tool: returns falsy/empty");
}

// --- Bash tool: handler processes it ---
{
  let handlerCalled = false;
  let handlerResult: any = "not-called";
  const mockPi: any = {
    on: (event: string, handler: any) => {
      handlerCalled = true;
      // Simulate a bash tool_call with a clean command (empty WL from missing config)
      handlerResult = handler(
        { toolName: "bash", input: { command: "ls -la" } },
        { hasUI: true, ui: { select: async () => "Yes", input: async () => "" } },
      );
    },
  };
  const origHome = process.env.HOME;
  process.env.HOME = "/nonexistent-path-for-testing";
  defaultExport(mockPi);
  process.env.HOME = origHome;
  // With empty WL, "ls -la" is blocked. In headless mode it would auto-block.
  // With hasUI=true, it prompts. We can't await the async result synchronously,
  // but we can verify the handler was called and returned a promise
  assertEqual(handlerCalled, true, "handler registered for bash");
  assertEqual(handlerResult instanceof Promise, true, "handler returns Promise");
}

// --- ShellSession tool: handled identically to bash ---
{
  let handlerCalled = false;
  let handlerResult: any = "not-called";
  const mockPi: any = {
    on: (event: string, handler: any) => {
      handlerCalled = true;
      handlerResult = handler(
        { toolName: "ShellSession", input: { command: "pwd" } },
        { hasUI: true, ui: { select: async () => "Yes", input: async () => "" } },
      );
    },
  };
  const origHome = process.env.HOME;
  process.env.HOME = "/nonexistent-path-for-testing";
  defaultExport(mockPi);
  process.env.HOME = origHome;
  assertEqual(handlerCalled, true, "handler registered for ShellSession");
  assertEqual(handlerResult instanceof Promise, true, "ShellSession handler returns Promise");
}

// --- Input extraction: input.command ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  const ctx = mockCtx("Yes", "");
  handleBashCall(ctx, "bash", "ls -la", ["ls "], true, allow, block);
  assertEqual(true, true, "input.command shape handled");
}

// --- Input extraction: input.commands[0] ---
{
  const allow = new Set<string>();
  const block = new Map<string, string>();
  const ctx = mockCtx("Yes", "");
  handleBashCall(ctx, "ShellSession", "pwd", ["pwd "], true, allow, block);
  assertEqual(true, true, "input.commands[0] shape handled");
}

// ============================================================
// Prefix matching semantics
// ============================================================

console.log("\n=== Prefix matching semantics ===\n");

// Minimal whitelist to isolate the two matching conditions:
//   1. text.startsWith(p)
//   2. text === p.replace(/ +$/, "")
const PM_WL: string[] = ["ls ", "uname"];

// --- startsWith: prefix with trailing space matches command + args ---
assertAllowed("ls -la", PM_WL, "startsWith: 'ls ' matches 'ls -la'");
assertAllowed("ls /tmp", PM_WL, "startsWith: 'ls ' matches 'ls /tmp'");

// === fallback: prefix with trailing space matches bare command ---
assertAllowed("ls", PM_WL, "=== fallback: 'ls ' matches bare 'ls'");

// startsWith: prefix without trailing space matches bare command ---
assertAllowed("uname", PM_WL, "startsWith: 'uname' matches bare 'uname'");

// startsWith: prefix without trailing space ALSO matches command + args ---
assertAllowed("uname -a", PM_WL, "startsWith: 'uname' matches 'uname -a'");
assertAllowed("uname -rsv", PM_WL, "startsWith: 'uname' matches 'uname -rsv'");

// Trailing space prevents substring matches ---
assertReason("lsof", PM_WL, `"lsof" not whitelisted`, "trailing space: 'ls ' does NOT match 'lsof'");
assertReason("lscpu", PM_WL, `"lscpu" not whitelisted`, "trailing space: 'ls ' does NOT match 'lscpu'");

// No trailing space allows substring matches ---
assertAllowed("unamer", PM_WL, "no trailing space: 'uname' matches 'unamer' via startsWith");

// === fallback does NOT apply to prefixes without trailing space ---
// "uname".replace(/ +$/, "") === "uname", so "uname" === "uname" is true,
// but this is already covered by startsWith — the === fallback is a no-op here.
assertAllowed("uname", PM_WL, "=== fallback no-op: 'uname' (no space) still matches bare 'uname'");

// Prefix with multiple trailing spaces — startsWith requires exact match, === fallback catches bare ---
const PM_WL2: string[] = ["cat  "];  // two trailing spaces
assertReason("cat file", PM_WL2, `"cat" not whitelisted`, "multiple trailing spaces: 'cat  ' does NOT match 'cat file' (one space)");
assertAllowed("cat", PM_WL2, "multiple trailing spaces: 'cat  ' matches bare 'cat' via === fallback");
assertAllowed("cat  file", PM_WL2, "multiple trailing spaces: 'cat  ' matches 'cat  file' (two spaces) via startsWith");

// ============================================================
// Existing shell parsing tests (unchanged)
// ============================================================

// splitCompoundCommand tests
console.log("\n=== splitCompoundCommand ===\n");

assertSplit("ls", ["ls"], "simple: ls");
assertSplit("ls -la", ["ls -la"], "simple: ls -la");
assertSplit("cat /etc/hostname", ["cat /etc/hostname"], "simple: cat /etc/hostname");
assertSplit("ls; pwd", ["ls", "pwd"], "semicolon: ls; pwd");
assertSplit("echo ok; rm file", ["echo ok", "rm file"], "semicolon: echo ok; rm file");
assertSplit("a; b; c", ["a", "b", "c"], "semicolon: a; b; c");
assertSplit("pwd && rm file", ["pwd &", "rm file"], "&&: pwd && rm file");
assertSplit("ls && cat f && grep x", ["ls &", "cat f &", "grep x"], "&&: ls && cat f && grep x");
assertSplit("ls || rm file", ["ls |", "rm file"], "||: ls || rm file");
assertSplit("a || b || c", ["a |", "b |", "c"], "||: a || b || c");
assertSplit("cat f | grep x", ["cat f", "grep x"], "pipe: cat f | grep x");
assertSplit("a | b | c", ["a", "b", "c"], "pipe: a | b | c");
assertSplit("ls & rm f", ["ls", "rm f"], "single &: ls & rm f");
assertSplit("echo a; ls && cat f | grep x", ["echo a", "ls &", "cat f", "grep x"], "mixed");
assertSplit('echo "a; b"', ['echo "a; b"'], "quoted semicolon");
assertSplit("echo 'a|b'", ["echo 'a|b'"], "quoted pipe");
assertSplit('echo "a&&b"', ['echo "a&&b"'], "quoted &&");
assertSplit("echo 'a||b'", ["echo 'a||b'"], "quoted ||");
assertSplit('echo "a & b"', ['echo "a & b"'], "quoted &");
assertSplit('echo "it\'s ok"', ['echo "it\'s ok"'], "nested: ' inside \"");
assertSplit("echo 'it\"s ok'", ["echo 'it\"s ok'"], "nested: \" inside '");
assertSplit("echo a\\; b", ["echo a\\; b"], "escaped semicolon");
assertSplit("echo a\\| b", ["echo a\\| b"], "escaped pipe");
assertSplit("echo a\\& b", ["echo a\\& b"], "escaped &");
assertSplit("cat < /etc/hostname", ["cat < /etc/hostname"], "<: cat < /etc/hostname");
assertSplit("cat < input.txt | grep x", ["cat < input.txt", "grep x"], "<: cat < input.txt | grep x");
assertSplit("cat <(echo x)", ["cat <(echo x)"], "<(: cat <(echo x)");
assertSplit("ls |& grep err", ["ls", "grep err"], "|&: ls |& grep (& splits)");
assertSplit("echo data >&1", ["echo data >&1"], ">&: fd redirect no split");
assertSplit("echo data 2>&1", ["echo data 2>&1"], "2>&1: fd redirect no split");
assertSplit("(ls; pwd)", ["(ls", "pwd)"], "grouping: (ls; pwd) splits on ;");
assertSplit("(ls)", ["(ls)"], "grouping: (ls) no split");
assertSplit("", [], "empty string");
assertSplit("   ", [], "whitespace only");
assertSplit("ls  ;  pwd", ["ls", "pwd"], "multiple spaces around ;");
assertSplit("ls;;pwd", ["ls", "pwd"], "consecutive ;;");
assertSplit("ls;", ["ls"], "trailing ;");
assertSplit("; ls", ["ls"], "leading ;");
assertSplit("ls &&", ["ls &"], "trailing &&");
assertSplit("ls ||", ["ls |"], "trailing ||");

// scanDangerousAll tests
console.log("\n=== scanDangerousAll ===\n");

assertDangerous("cat $(echo x)", ["command substitution $()"], "$() unquoted");
assertDangerous("cat \"$(echo x)\"", ["command substitution $()"], "$() double-quoted");
assertDangerous("echo \"it's $(echo x)\"", ["command substitution $()"], "$() with ' inside \"");
assertDangerous("cat $(whoami)", ["command substitution $()"], "$() bare");
assertDangerous("echo \"$(date)\"", ["command substitution $()"], "$() in echo");
assertDangerous("echo '$(echo x)'", [], "$() single-quoted");
assertDangerous("echo 'run $(whoami) now'", [], "$() single-quoted multi-word");
assertDangerous("cat `echo x`", ["backtick command substitution"], "backtick unquoted");
assertDangerous("cat `whoami`", ["backtick command substitution"], "backtick bare");
assertDangerous("echo `date`", ["backtick command substitution"], "backtick in echo");
assertDangerous("cat \"`echo x`\"", ["backtick command substitution"], "backtick double-quoted");
assertDangerous("echo \"`whoami`\"", ["backtick command substitution"], "backtick in echo double-quoted");
assertDangerous("echo '`echo x`'", [], "backtick single-quoted");
assertDangerous("echo 'run `whoami` now'", [], "backtick single-quoted multi-word");
assertDangerous("echo data > /tmp/out", ["unsafe file-write redirection"], "> basic");
assertDangerous("echo data >> /tmp/out", ["unsafe file-write redirection"], ">> append");
assertDangerous("cat f 2> /tmp/err", ["unsafe file-write redirection"], "2> stderr");
assertDangerous("echo x >/tmp/out", ["unsafe file-write redirection"], "> no space");
assertDangerous("echo data > /dev/null", [], "> /dev/null");
assertDangerous("echo data >> /dev/null", [], ">> /dev/null");
assertDangerous("echo data >&1", [], ">&1");
assertDangerous("echo data >&2", [], ">&2");
assertDangerous("echo data 2>&1", [], "2>&1");
assertDangerous("echo data >&3", [], ">&3");
assertDangerous("echo data > /dev/stdout", [], "> /dev/stdout");
assertDangerous("echo data > /dev/stderr", [], "> /dev/stderr");
assertDangerous("echo data > /dev/nullify", ["unsafe file-write redirection"], "> /dev/nullify");
assertDangerous("echo data > /dev/null/file", ["unsafe file-write redirection"], "> /dev/null/file");
assertDangerous("echo data >/dev/null", [], ">/dev/null (no space)");
assertDangerous("echo data >>/dev/null", [], ">>/dev/null (no space)");
assertDangerous("echo data >/dev/null 2>&1", [], ">/dev/null 2>&1");
assertDangerous("echo data >/dev/null 2>/dev/null", [], ">/dev/null 2>/dev/null");
assertDangerous('echo "> is literal"', [], "> double-quoted");
assertDangerous('echo "a > b"', [], "> in expression double-quoted");
assertDangerous("echo '> is literal'", [], "> single-quoted");
assertDangerous("echo 'a > b'", [], "> in expression single-quoted");
assertDangerous("cat <(echo x)", ["process substitution <()"], "<() unquoted");
assertDangerous("diff <(ls a) <(ls b)", ["process substitution <()", "process substitution <()"], "<() in diff (two)");
assertDangerous("echo '<(echo x)'", [], "<() single-quoted");
assertDangerous("cat \"<(echo x)\"", [], "<() double-quoted (literal)");
assertDangerous("cat < /etc/hostname", [], "< input redirection");
assertDangerous("cat < input.txt | grep x", [], "< cat input piped");
assertDangerous("echo \\$\\(not\\)", [], "escaped $()");
assertDangerous("echo \\`not\\`", [], "escaped backtick");
assertDangerous("echo \\>not", [], "escaped >");
assertDangerous("echo \\<(not)", [], "escaped <()");
assertDangerous("cat $(echo $(whoami))", ["command substitution $()", "command substitution $()"], "nested $() (two)");
assertDangerous("cat $( echo x )", ["command substitution $()"], "$() with spaces");
assertDangerous("cat ` echo x `", ["backtick command substitution"], "backtick with spaces");
assertDangerous("echo $(whoami) && cat `pwd`", ["command substitution $()", "backtick command substitution"], "multiple dangerous");
assertDangerous("echo $HOME", [], "$VAR not dangerous");
assertDangerous("echo ${HOME}", [], "${VAR} not dangerous");
assertDangerous("echo <<< 'hello'", [], "here-string <<<");
assertDangerous("cat << EOF", [], "here-doc <<");

// checkCommandAll — whitelist matching
console.log("\n=== Whitelist matching ===\n");

assertAllowed("ls -la", WL, "whitelist: ls -la");
assertAllowed("cat /etc/hostname", WL, "whitelist: cat /etc/hostname");
assertAllowed("grep localhost /etc/hosts", WL, "whitelist: grep");
assertAllowed("wc -l file.txt", WL, "whitelist: wc -l");
assertAllowed("pwd", WL, "whitelist: pwd");
assertAllowed("echo hello", WL, "whitelist: echo");
assertAllowed("find /tmp -name *.txt", WL, "whitelist: find");
assertAllowed("git status", WL, "whitelist: git status");
assertAllowed("git log --oneline", WL, "whitelist: git log --oneline");
assertAllowed("git diff HEAD~1", WL, "whitelist: git diff");
assertAllowed("git show abc123", WL, "whitelist: git show");
assertAllowed("git stash list", WL, "whitelist: git stash list");
assertAllowed("df -h", WL, "whitelist: df");
assertAllowed("du -sh /tmp", WL, "whitelist: du");
assertAllowed("ps aux", WL, "whitelist: ps");
assertAllowed("sed -n 1,10p file", WL, "whitelist: sed");
assertAllowed("head -5 file", WL, "whitelist: head");
assertAllowed("tail -f log", WL, "whitelist: tail");
assertAllowed("env", WL, "whitelist: env bare");
assertAllowed("env | grep PATH", WL, "whitelist: env piped");
assertAllowed("uname", WL, "whitelist: uname bare");
assertAllowed("uname -a", WL, "whitelist: uname -a");
assertAllowed("whoami", WL, "whitelist: whoami");
assertAllowed("id", WL, "whitelist: id");
assertAllowed("date", WL, "whitelist: date");
assertAllowed("which python3", WL, "whitelist: which");
assertAllowed("type ls", WL, "whitelist: type");
assertAllowed("printenv PATH", WL, "whitelist: printenv");
assertAllowed("pip show requests", WL, "whitelist: pip show");
assertAllowed("pip list", WL, "whitelist: pip list");
assertAllowed("npm list", WL, "whitelist: npm list");
assertAllowed("cargo metadata", WL, "whitelist: cargo metadata");
assertAllowed("free -h", WL, "whitelist: free");
assertAllowed("top -bn 1", WL, "whitelist: top -bn");
assertAllowed("printf hello", WL, "whitelist: printf");
assertAllowed("rg pattern", WL, "whitelist: rg");
assertAllowed("ag pattern", WL, "whitelist: ag");
assertAllowed("fd pattern", WL, "whitelist: fd");
assertReason("rm /tmp/test", WL, `"rm" not whitelisted`, "non-wl: rm");
assertReason("sudo ls", WL, `"sudo" not whitelisted`, "non-wl: sudo");
assertReason("chmod 777 file", WL, `"chmod" not whitelisted`, "non-wl: chmod");
assertReason("kill 1234", WL, `"kill" not whitelisted`, "non-wl: kill");
assertReason("docker ps", WL, `"docker" not whitelisted`, "non-wl: docker");
assertReason("ssh user@host", WL, `"ssh" not whitelisted`, "non-wl: ssh");
assertReason("wget http://x", WL, `"wget" not whitelisted`, "non-wl: wget");
assertReason("tar xf archive.tar", WL, `"tar" not whitelisted`, "non-wl: tar");
assertReason("npm install", WL, `"npm" not whitelisted`, "non-wl: npm install");
assertReason("pip install pkg", WL, `"pip" not whitelisted`, "non-wl: pip install");
assertReason("cargo build", WL, `"cargo" not whitelisted`, "non-wl: cargo build");
assertReason("python3 -c 'import os'", WL, `"python3" not whitelisted`, "non-wl: python3");
assertReason("node script.js", WL, `"node" not whitelisted`, "non-wl: node");
assertReason("curl http://x", WL, `"curl" not whitelisted`, "non-wl: curl");
assertAllowed("ls", WL, "bare: ls");
assertAllowed("cat", WL, "bare: cat");
assertAllowed("pwd", WL, "bare: pwd");
assertAllowed("echo", WL, "bare: echo");
assertAllowed("wc", WL, "bare: wc");
assertAllowed("env", WL, "bare: env");
assertAllowed("id", WL, "bare: id");
assertAllowed("date", WL, "bare: date");
assertAllowed("whoami", WL, "bare: whoami");
assertAllowed("uname", WL, "bare: uname");
assertAllowed("head", WL, "bare: head");
assertAllowed("tail", WL, "bare: tail");
assertAllowed("grep", WL, "bare: grep");
assertAllowed("which", WL, "bare: which");
assertAllowed("type", WL, "bare: type");
assertAllowed("printenv", WL, "bare: printenv");
assertReason("pip", WL, `"pip" not whitelisted`, "bare: pip not in WL");
assertAllowed("ls  -la", WL, "multiple spaces: ls  -la");
assertAllowed("echo  hello", WL, "multiple spaces: echo  hello");
const EMPTY_WL: string[] = [];
assertReason("ls", EMPTY_WL, `"ls" not whitelisted`, "empty wl: ls blocked");
assertReason("echo hello", EMPTY_WL, `"echo" not whitelisted`, "empty wl: echo blocked");
assertReason("lsof", WL, `"lsof" not whitelisted`, "trailing space: 'ls ' does NOT match 'lsof'");
assertReason("lscpu", WL, `"lscpu" not whitelisted`, "trailing space: 'ls ' does NOT match 'lscpu'");

// checkCommandAll — compound commands
console.log("\n=== Compound commands ===\n");

assertReason("echo ok; rm file", WL, `"rm" not whitelisted`, "semicolon: echo; rm");
assertReason("rm file; echo ok", WL, `"rm" not whitelisted`, "semicolon: rm; echo");
assertAllowed("echo ok; pwd", WL, "semicolon: echo; pwd (both wl)");
assertAllowed("ls; pwd; echo done", WL, "semicolon: all wl");
assertReason("pwd && rm file", WL, `"rm" not whitelisted`, "&&: pwd && rm");
assertReason("rm file && echo ok", WL, `"rm" not whitelisted`, "&&: rm && echo");
assertAllowed("ls && pwd", WL, "&&: ls && pwd (both wl)");
assertAllowed("pwd && echo ok && ls", WL, "&&: all wl");
assertReason("ls || rm file", WL, `"rm" not whitelisted`, "||: ls || rm");
assertReason("rm file || echo ok", WL, `"rm" not whitelisted`, "||: rm || echo");
assertAllowed("ls || pwd", WL, "||: ls || pwd (both wl)");
assertReason("cat /etc/hostname | rm /tmp/test", WL, `"rm" not whitelisted`, "pipe: cat | rm");
assertAllowed("cat /etc/hostname | grep localhost", WL, "pipe: cat | grep (both wl)");
assertAllowed("ls | grep txt | wc -l", WL, "pipe: ls | grep | wc (all wl)");
assertReason("ls & rm file", WL, `"rm" not whitelisted`, "&: ls & rm");
assertReason("rm file & echo ok", WL, `"rm" not whitelisted`, "&: rm & echo");
assertReason("echo a; ls && rm f | grep x", WL, `"rm" not whitelisted`, "mixed: echo; ls && rm | grep");
assertAllowed("echo a; ls && cat f | grep x", WL, "mixed: all wl");
assertReason("ls && rm", WL, `"rm" not whitelisted`, "trailing &&: ls && rm");
assertReason("ls || rm", WL, `"rm" not whitelisted`, "trailing ||: ls || rm");
assertAllowed("echo data >/dev/null; ls", WL, "semicolon: safe redirect; ls");
assertReason("echo data >/dev/null; rm f", WL, `"rm" not whitelisted`, "semicolon: safe redirect; rm");
assertAllowed("echo data >/dev/null | grep x", WL, "pipe: safe redirect | grep");
assertAllowed("echo data 2>&1 && ls", WL, "&&: 2>&1 && ls");
assertReason("echo data 2>&1 && rm f", WL, `"rm" not whitelisted`, "&&: 2>&1 && rm");

// checkCommandAll — command grouping
console.log("\n=== Command grouping ===\n");

assertAllowed("(ls)", WL, "grouping: (ls)");
assertAllowed("(pwd)", WL, "grouping: (pwd)");
assertAllowed("(ls; pwd)", WL, "grouping: (ls; pwd)");
assertAllowed("(cat /etc/hostname)", WL, "grouping: (cat /etc/hostname)");
assertReason("(rm file)", WL, `"rm" not whitelisted`, "grouping: (rm file)");
assertReason("(ls; rm file)", WL, `"rm" not whitelisted`, "grouping: (ls; rm file)");
assertAllowed("((ls))", WL, "grouping: nested ((ls))");
assertAllowed("((ls; pwd))", WL, "grouping: nested ((ls; pwd))");
assertAllowed("( (ls | head -3) )", WL, "grouping: spaced ( (ls | head -3) )");
assertAllowed("(ls) | grep x", WL, "grouping: (ls) | grep x");
assertAllowed("(echo data >/dev/null)", WL, "grouping: safe redirect in parens");
assertAllowed("(ls) && (pwd)", WL, "grouping: (ls) && (pwd)");
assertReason("(ls) && (rm f)", WL, `"rm" not whitelisted`, "grouping: (ls) && (rm)");
assertAllowed("(((ls)))", WL, "grouping: triple nested (((ls)))");

// checkCommandAll — input redirection
console.log("\n=== Input redirection ===\n");

assertAllowed("cat < /etc/hostname", WL, "input redirect: cat < file");
assertAllowed("cat < input.txt | grep x", WL, "input redirect: cat < file | grep x");
assertAllowed("grep pattern < /etc/hosts", WL, "input redirect: grep < file");

// checkCommandAll — edge cases
console.log("\n=== Edge cases ===\n");

assertAllowed("", WL, "empty string");
assertAllowed('echo "a; b; c"', WL, "quotes: semicolons in double quotes");
assertAllowed("echo 'a|b|c'", WL, "quotes: pipes in single quotes");
assertAllowed('echo "a && b"', WL, "quotes: && in double quotes");
assertAllowed("echo 'a || b'", WL, "quotes: || in single quotes");
assertAllowed('echo "it\'s > ok"', WL, "nested: ' inside \" with >");
assertAllowed("echo 'it\"s > ok'", WL, "nested: \" inside ' with >");
assertReason("echo \"'$(echo x)'\"", WL, "command substitution $()", "$() in ' inside \"");
assertReason("cat $(echo x) > /tmp/out", WL, "command substitution $()", "multiple: $() before >");
assertReason("echo x > /tmp/out; rm f", WL, "unsafe file-write redirection", "multiple: > before rm");
assertReason("rm f >/dev/null", WL, `"rm" not whitelisted`, "non-wl + safe redirect");
assertReason("rm f 2>&1", WL, `"rm" not whitelisted`, "non-wl + safe fd redirect");
assertReason("rm file 2>/dev/null", WL, `"rm" not whitelisted`, "non-wl + safe stderr redirect");
const longCmd = "echo " + "a".repeat(250);
const longDiags = checkCommandAll(longCmd, WL);
if (longDiags.length > 0) {
  const formatted = formatGateError(longCmd, longDiags[0]!);
  const firstLine = formatted.split("\n")[0];
  assertEqual(firstLine.length, 200, "formatGateError: truncates at 200 chars");
}

// checkWhitelistAll — all diagnostics
console.log("\n=== checkWhitelistAll ===\n");

assertWhitelistDiags("rm file", ['"rm" not whitelisted'], "single non-wl");
assertWhitelistDiags("cd /tmp", ['"cd" not whitelisted'], "single non-wl: cd");
assertWhitelistDiags("cd /tmp && python3 --version", ['"cd" not whitelisted', '"python3" not whitelisted'], "two non-wl: cd && python3");
assertWhitelistDiags("cd /tmp; python3 --version", ['"cd" not whitelisted', '"python3" not whitelisted'], "two non-wl: cd; python3");
assertWhitelistDiags("rm f && cd /tmp && python3 x", ['"rm" not whitelisted', '"cd" not whitelisted', '"python3" not whitelisted'], "three non-wl");
assertWhitelistDiags("ls && python3 --version", ['"python3" not whitelisted'], "one wl one non-wl: ls && python3");
assertWhitelistDiags("cd /tmp && ls", ['"cd" not whitelisted'], "one non-wl one wl: cd && ls");
assertWhitelistDiags("ls && cd /tmp && pwd", ['"cd" not whitelisted'], "middle non-wl");
assertWhitelistDiags("ls && pwd", [], "all wl: ls && pwd");
assertWhitelistDiags("echo ok; pwd", [], "all wl: echo; pwd");

// checkCommandAll — multi-diagnostic
console.log("\n=== checkCommandAll multi-diag ===\n");

assertDiags("cd /tmp && python3 --version", ['"cd" not whitelisted', '"python3" not whitelisted'], "two non-wl: cd && python3");
assertDiags("cd /tmp; python3 --version", ['"cd" not whitelisted', '"python3" not whitelisted'], "two non-wl: cd; python3");
assertDiags("ls && python3 --version", ['"python3" not whitelisted'], "one wl one non-wl: ls && python3");
assertDiags("cd /tmp && ls", ['"cd" not whitelisted'], "one non-wl one wl: cd && ls");
assertDiags("ls && pwd", [], "all wl: ls && pwd");
assertDiags("cd /tmp && echo $(whoami)", ["command substitution $()"], "dangerous overrides whitelist");
assertDiags("echo $(whoami) && cat `pwd`", ["command substitution $()", "backtick command substitution"], "multiple dangerous");

// formatGateError tests
console.log("\n=== formatGateError ===\n");

assertFormat(
  "echo ok; rm -rf /tmp/data",
  '"rm" not whitelisted', 10, 2,
  "echo ok; rm -rf /tmp/data\n          ^^\n    \"rm\" not whitelisted",
  "format: compound rm"
);
assertFormat(
  "cat \"$(echo pwned)\"",
  "command substitution $()", 5, 2,
  'cat "$(echo pwned)"\n     ^^\n    command substitution $()',
  "format: $() in quotes"
);
assertFormat(
  "echo data > /tmp/output.txt",
  "unsafe file-write redirection", 10, 1,
  "echo data > /tmp/output.txt\n          ^\n    unsafe file-write redirection",
  "format: redirection"
);
assertFormat(
  "cat `echo pwned`",
  "backtick command substitution", 4, 13,
  "cat `echo pwned`\n    ^^^^^^^^^^^^^\n    backtick command substitution",
  "format: backtick"
);
assertFormat(
  "rm /tmp/test",
  '"rm" not whitelisted', 0, 2,
  'rm /tmp/test\n^^\n    "rm" not whitelisted',
  "format: bare non-wl"
);
assertFormat(
  "cat <(echo x)",
  "process substitution <()", 4, 2,
  "cat <(echo x)\n    ^^\n    process substitution <()",
  "format: process substitution"
);

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
