/**
 * The in-agent `/side` command for Claude Code and `$side` for Codex. Both agents run a
 * `UserPromptSubmit` hook before a prompt reaches the model; the hook forks the session and
 * blocks the prompt, so the main thread spends no turn on it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { shQuote } from "./terminal";

export type HookHarness = "claude" | "codex";

/** Flags that take no value, so the prompt can follow them without `--`. */
const BARE_FLAGS = new Set(["--bg", "--no-focus", "--focus", "--tab", "--split", "--left", "--right", "--up", "--down", "--dry-run"]);

/**
 * `/side …` or `$side …` as `side` arguments, or undefined for any other prompt. The prompt text
 * is kept verbatim: no shell sits between the agent and the hook, so `?`, quotes, and newlines
 * need no escaping. Value-taking options (`--model sonnet`) still need `--` before the prompt.
 */
export function parseTrigger(prompt: string): string[] | undefined {
	const trigger = /^\s*[/$]side(?=\s|$)/.exec(prompt);
	if (!trigger) return undefined;
	let rest = prompt.slice(trigger[0].length).trim();
	const head: string[] = [];
	while (rest.startsWith("-")) {
		const separator = /^--(\s|$)/.exec(rest);
		if (separator) {
			rest = rest.slice(separator[0].length).trim();
			break;
		}
		const token = rest.split(/\s/, 1)[0] as string;
		if (!BARE_FLAGS.has(token)) {
			const split = /(^|\s)--(\s|$)/.exec(rest);
			head.push(...(split ? rest.slice(0, split.index) : rest).split(/\s+/).filter(Boolean));
			rest = split ? rest.slice(split.index + split[0].length).trim() : "";
			break;
		}
		head.push(token);
		rest = rest.slice(token.length).trim();
	}
	return [...head, "--", rest];
}

export interface HookInput {
	sessionId: string;
	prompt: string;
}

/** The fields side needs from a `UserPromptSubmit` payload, or undefined when they are missing. */
export function parseHookInput(raw: string): HookInput | undefined {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!data || typeof data !== "object") return undefined;
	const { session_id: sessionId, prompt } = data as Record<string, unknown>;
	if (typeof sessionId !== "string" || !sessionId || typeof prompt !== "string") return undefined;
	return { sessionId, prompt };
}

/** Stop the prompt before the model sees it, and show `message` instead. */
export function blockResponse(message: string): string {
	return JSON.stringify({ decision: "block", reason: message });
}

// Installation ------------------------------------------------------------------------------

const OWN_COMMAND = /(cli\.ts|\bside)'? hook (claude|codex)$/;
const COMMAND_MARKER = "<!-- installed by @wolfiesch/side; side uninstall-hook claude removes it -->";

const CLAUDE_COMMAND = `---
description: Fork this session into a pane beside it and ask the prompt there
argument-hint: "[--bg|--tab|--left|--right|--up|--down] <prompt>"
---
${COMMAND_MARKER}
The side hook did not run, so this session was not forked. Tell the user in one sentence to run \`side install-hook claude\` and restart Claude Code. Do nothing else.
`;

export interface HookPaths {
	/** The JSON file whose `hooks.UserPromptSubmit` list holds the hook. */
	config: string;
	/** Claude Code's `/side` command file; Codex rejects unknown slash commands, so it has none. */
	command?: string;
}

export function hookPaths(harness: HookHarness, env: NodeJS.ProcessEnv): HookPaths {
	if (harness === "claude") {
		const root = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
		return { config: join(root, "settings.json"), command: join(root, "commands", "side.md") };
	}
	return { config: join(env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json") };
}

/** The shell command the agent runs: this bun and this script, or a compiled side binary. */
export function hookCommand(harness: HookHarness, execPath: string, scriptPath: string): string {
	const self = scriptPath.startsWith("/$bunfs/") ? shQuote(execPath) : `${shQuote(execPath)} ${shQuote(scriptPath)}`;
	return `${self} hook ${harness}`;
}

type HookGroup = { hooks?: Array<Record<string, unknown>> } & Record<string, unknown>;

function readConfig(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	if (!text.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not valid JSON, so side left it alone: ${error instanceof Error ? error.message : error}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
	return parsed as Record<string, unknown>;
}

function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.side-${process.pid}`;
	writeFileSync(temporary, text, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o644 });
	renameSync(temporary, path);
}

/** The config with every side hook removed, and the `UserPromptSubmit` groups that remain. */
function withoutSideHooks(config: Record<string, unknown>, path: string): { hooks: Record<string, unknown>; groups: HookGroup[] } {
	const hooks = config.hooks ?? {};
	if (typeof hooks !== "object" || Array.isArray(hooks)) throw new Error(`"hooks" in ${path} is not an object`);
	const list = (hooks as Record<string, unknown>).UserPromptSubmit ?? [];
	if (!Array.isArray(list)) throw new Error(`"hooks.UserPromptSubmit" in ${path} is not a list`);
	const groups: HookGroup[] = [];
	for (const group of list as HookGroup[]) {
		if (!Array.isArray(group?.hooks)) {
			groups.push(group);
			continue;
		}
		const kept = group.hooks.filter((hook) => !(typeof hook?.command === "string" && OWN_COMMAND.test(hook.command)));
		if (kept.length > 0) groups.push(kept.length === group.hooks.length ? group : { ...group, hooks: kept });
	}
	return { hooks: hooks as Record<string, unknown>, groups };
}

function writeGroups(path: string, config: Record<string, unknown>, hooks: Record<string, unknown>, groups: HookGroup[]): void {
	const nextHooks = { ...hooks };
	if (groups.length > 0) nextHooks.UserPromptSubmit = groups;
	else delete nextHooks.UserPromptSubmit;
	const next = { ...config };
	if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
	else delete next.hooks;
	writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** Add the side hook (replacing an earlier one) and, for Claude Code, the `/side` command file. */
export function installHook(paths: HookPaths, command: string): void {
	if (paths.command && existsSync(paths.command) && !readFileSync(paths.command, "utf8").includes(COMMAND_MARKER)) {
		throw new Error(`${paths.command} already exists and was not written by side; move it aside first`);
	}
	const config = readConfig(paths.config);
	const { hooks, groups } = withoutSideHooks(config, paths.config);
	groups.push({ hooks: [{ type: "command", command, timeout: 30 }] });
	writeGroups(paths.config, config, hooks, groups);
	if (paths.command) writeAtomic(paths.command, CLAUDE_COMMAND);
}

/** Remove what `installHook` added and nothing else. Returns whether anything was there. */
export function uninstallHook(paths: HookPaths): boolean {
	let removed = false;
	if (existsSync(paths.config)) {
		const config = readConfig(paths.config);
		const { hooks, groups } = withoutSideHooks(config, paths.config);
		if (JSON.stringify(hooks.UserPromptSubmit ?? []) !== JSON.stringify(groups)) {
			writeGroups(paths.config, config, hooks, groups);
			removed = true;
		}
	}
	if (paths.command && existsSync(paths.command) && readFileSync(paths.command, "utf8").includes(COMMAND_MARKER)) {
		unlinkSync(paths.command);
		removed = true;
	}
	return removed;
}
