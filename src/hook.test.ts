import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli";
import { hookCommand, hookPaths, installHook, parseHookInput, parseTrigger, uninstallHook } from "./hook";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "side-hook-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("parseTrigger", () => {
	test("only /side and $side as the first word trigger", () => {
		for (const prompt of ["why /side?", "/sidebar now", "$sidecar", "side: why", "/ide"]) {
			expect(parseTrigger(prompt)).toBeUndefined();
		}
		expect(parseTrigger("/side")).toEqual(["--", ""]);
		expect(parseTrigger("  $side\nwhy?")).toEqual(["--", "why?"]);
	});

	test("the prompt is kept verbatim, with no shell expansion or word splitting", () => {
		const options = parseArgs(parseTrigger(`/side why does "a  b" * match?\nsecond line`) as string[]);
		expect(options.prompt).toBe(`why does "a  b" * match?\nsecond line`);
		expect(options.harnessArgs).toEqual([]);
	});

	test("bare side flags may precede the prompt without --", () => {
		const options = parseArgs(parseTrigger("/side --bg --down -why dashes?") as string[]);
		expect(options.request).toEqual({ focus: false, placement: "split", direction: "down" });
		// "-why" is not a known bare flag, so everything from it on is options until a `--`.
		expect(options.prompt).toBe("");
		expect(options.harnessArgs).toEqual(["-why", "dashes?"]);
	});

	test("value-taking agent options pass through up to --", () => {
		const options = parseArgs(parseTrigger("$side --tab --model gpt-5 -- --verbose is a flag?") as string[]);
		expect(options.request.placement).toBe("tab");
		expect(options.harnessArgs).toEqual(["--model", "gpt-5"]);
		expect(options.prompt).toBe("--verbose is a flag?");
	});
});

describe("parseHookInput", () => {
	test("needs a session id and a prompt string", () => {
		expect(parseHookInput(JSON.stringify({ session_id: "s", prompt: "/side x", cwd: "/w" }))).toEqual({ sessionId: "s", prompt: "/side x" });
		for (const raw of ["not json", "null", "[]", JSON.stringify({ prompt: "x" }), JSON.stringify({ session_id: "", prompt: "x" })]) {
			expect(parseHookInput(raw)).toBeUndefined();
		}
	});
});

describe("installHook and uninstallHook", () => {
	const COMMAND = hookCommand("claude", "/opt/bun", "/opt/side/src/cli.ts");
	const foreign = { matcher: "", hooks: [{ type: "command", command: "paseo hooks codex UserPromptSubmit" }] };

	test("installing keeps unrelated settings and hooks, and reinstalling replaces rather than duplicates", () => {
		const paths = hookPaths("claude", { CLAUDE_CONFIG_DIR: root });
		writeFileSync(paths.config, JSON.stringify({ model: "opus", hooks: { Stop: [foreign], UserPromptSubmit: [foreign] } }));

		installHook(paths, COMMAND);
		installHook(paths, hookCommand("claude", "/new/bun", "/new/side/src/cli.ts"));

		const settings = JSON.parse(readFileSync(paths.config, "utf8"));
		expect(settings.model).toBe("opus");
		expect(settings.hooks.Stop).toEqual([foreign]);
		expect(settings.hooks.UserPromptSubmit).toEqual([
			foreign,
			{ hooks: [{ type: "command", command: "'/new/bun' '/new/side/src/cli.ts' hook claude", timeout: 30 }] },
		]);
		expect(readFileSync(paths.command as string, "utf8")).toContain("side install-hook claude");
	});

	test("uninstalling removes only side's hook and command file, then reports nothing left", () => {
		const paths = hookPaths("claude", { CLAUDE_CONFIG_DIR: root });
		writeFileSync(paths.config, JSON.stringify({ hooks: { UserPromptSubmit: [foreign] } }));
		installHook(paths, COMMAND);

		expect(uninstallHook(paths)).toBe(true);
		expect(JSON.parse(readFileSync(paths.config, "utf8"))).toEqual({ hooks: { UserPromptSubmit: [foreign] } });
		expect(existsSync(paths.command as string)).toBe(false);
		expect(uninstallHook(paths)).toBe(false);
	});

	test("a side hook sharing a group with another hook leaves that hook in place", () => {
		const paths = hookPaths("codex", { CODEX_HOME: root });
		const shared = { hooks: [foreign.hooks[0], { type: "command", command: COMMAND.replace("claude", "codex") }] };
		writeFileSync(paths.config, JSON.stringify({ hooks: { UserPromptSubmit: [shared] } }));

		expect(uninstallHook(paths)).toBe(true);
		expect(JSON.parse(readFileSync(paths.config, "utf8")).hooks.UserPromptSubmit).toEqual([{ hooks: [foreign.hooks[0]] }]);
	});

	test("refuses to touch invalid JSON or a /side command the user wrote", () => {
		const paths = hookPaths("claude", { CLAUDE_CONFIG_DIR: root });
		writeFileSync(paths.config, "{ // comment\n}");
		expect(() => installHook(paths, COMMAND)).toThrow("is not valid JSON");
		expect(readFileSync(paths.config, "utf8")).toBe("{ // comment\n}");

		writeFileSync(paths.config, "{}");
		mkdirSync(join(root, "commands"));
		writeFileSync(paths.command as string, "my own /side");
		expect(() => installHook(paths, COMMAND)).toThrow("was not written by side");
		expect(readFileSync(paths.config, "utf8")).toBe("{}");
	});

	test("a compiled side binary is its own hook command", () => {
		expect(hookCommand("codex", "/usr/local/bin/side", "/$bunfs/root/side")).toBe("'/usr/local/bin/side' hook codex");
	});
});
