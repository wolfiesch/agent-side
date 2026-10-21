import { describe, expect, spyOn, test } from "bun:test";
import { parseArgs, resolveSource } from "./cli";
import { omp } from "./harness";
import type { ProcessInfo, ProcessTable } from "./process";
import type { Runner } from "./terminal";

describe("parseArgs", () => {
	test("defaults to a focused automatic placement with no prompt", () => {
		expect(parseArgs([])).toEqual({
			request: { focus: true, placement: "auto" },
			dryRun: false,
			help: false,
			harnessArgs: [],
			prompt: "",
		});
	});

	test("bare words become the prompt without quoting", () => {
		const options = parseArgs(["why", "is", "this", "slow?"]);
		expect(options.prompt).toBe("why is this slow?");
		expect(options.harnessArgs).toEqual([]);
		expect(options.request).toEqual({ focus: true, placement: "auto" });
	});

	test("-- splits options from the prompt, including a prompt that starts with a dash", () => {
		const options = parseArgs(["--bg", "--tab", "--", "-why", "now?"]);
		expect(options.request).toEqual({ focus: false, placement: "tab" });
		expect(options.prompt).toBe("-why now?");
		expect(options.harnessArgs).toEqual([]);
	});

	test("without -- a leading option makes every argument an option", () => {
		const options = parseArgs(["--bg", "why"]);
		expect(options.request.focus).toBe(false);
		expect(options.harnessArgs).toEqual(["why"]);
		expect(options.prompt).toBe("");
	});

	test("unknown options pass through to harnessArgs in order", () => {
		const options = parseArgs(["--model", "opus", "--bg", "--effort=high", "--", "question"]);
		expect(options.harnessArgs).toEqual(["--model", "opus", "--effort=high"]);
		expect(options.request.focus).toBe(false);
		expect(options.prompt).toBe("question");
	});

	test("direction flags imply a split and record the direction", () => {
		for (const direction of ["left", "right", "up", "down"] as const) {
			expect(parseArgs([`--${direction}`]).request).toEqual({ focus: true, placement: "split", direction });
		}
		expect(parseArgs(["--split"]).request).toEqual({ focus: true, placement: "split" });
	});

	test("the last of --bg and --focus wins", () => {
		expect(parseArgs(["--bg", "--focus"]).request.focus).toBe(true);
		expect(parseArgs(["--focus", "--no-focus"]).request.focus).toBe(false);
	});

	test("reads harness, session, pid, pane-pid, dry-run, and help", () => {
		expect(parseArgs(["--harness", "codex", "--session", "abc", "--dry-run"])).toMatchObject({
			harness: "codex", session: "abc", dryRun: true,
		});
		expect(parseArgs(["--pid", "42"]).pid).toBe(42);
		expect(parseArgs(["--pane-pid", "43"]).panePid).toBe(43);
		expect(parseArgs(["-h"]).help).toBe(true);
		expect(parseArgs(["--help"]).help).toBe(true);
	});

	test("rejects more than one of --session, --pane-pid, and --pid", () => {
		expect(() => parseArgs(["--session", "abc", "--pid", "42"])).toThrow("use only one of");
		expect(() => parseArgs(["--pid", "42", "--pane-pid", "43"])).toThrow("use only one of");
		expect(() => parseArgs(["--session", "abc", "--pane-pid", "43"])).toThrow("use only one of");
	});

	test("rejects a bad pid, harness, or missing session id", () => {
		for (const bad of ["abc", "0", "-3", "1.5"]) {
			expect(() => parseArgs(["--pid", bad])).toThrow("needs a process id");
			expect(() => parseArgs(["--pane-pid", bad])).toThrow("needs a process id");
		}
		expect(() => parseArgs(["--pid"])).toThrow("needs a process id");
		expect(() => parseArgs(["--harness", "gemini"])).toThrow("--harness must be claude, codex, or omp");
		expect(() => parseArgs(["--session"])).toThrow("--session needs a session id");
	});
});

describe("resolveSource", () => {
	const CLAUDE_ID = "0198a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";
	const CODEX_ID = "11111111-2222-4333-8444-555555555555";
	const noRun: Runner = async () => {
		throw new Error("the fake process table must not shell out");
	};
	const table = (...infos: ProcessInfo[]): ProcessTable => new Map(infos.map((info) => [info.pid, info]));
	const proc = (pid: number, ppid: number, comm: string, args = comm): ProcessInfo => ({ pid, ppid, comm, args });
	const options = (...argv: string[]) => parseArgs(argv);
	const resolve = (argv: string[], env: NodeJS.ProcessEnv, processes: ProcessTable, selfPid: number) =>
		resolveSource(options(...argv), env, noRun, selfPid, async () => processes);

	test("env mode picks the nearest agent ancestor when both session ids are set", async () => {
		// claude -> sh -> codex -> sh -> side: the codex ancestor is nearest.
		const processes = table(
			proc(1, 0, "/sbin/launchd"),
			proc(100, 1, "/opt/bin/claude"),
			proc(101, 100, "/bin/sh"),
			proc(200, 101, "/opt/bin/codex"),
			proc(201, 200, "/bin/sh"),
			proc(300, 201, "/opt/bin/bun", "bun side"),
		);
		const env = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CODEX_THREAD_ID: CODEX_ID };

		const source = await resolve([], env, processes, 300);
		expect(source.harness.name).toBe("codex");
		expect(source.id).toBe(CODEX_ID);
		expect(source.agent?.pid).toBe(200);

		const claudeNearest = table(
			proc(1, 0, "/sbin/launchd"),
			proc(200, 1, "/opt/bin/codex"),
			proc(201, 200, "/bin/sh"),
			proc(100, 201, "/opt/bin/claude"),
			proc(300, 100, "/opt/bin/bun", "bun side"),
		);
		const other = await resolve([], env, claudeNearest, 300);
		expect(other.harness.name).toBe("claude");
		expect(other.id).toBe(CLAUDE_ID);
		expect(other.agent?.pid).toBe(100);
	});

	test("env mode with one exported id uses it, and --harness disambiguates when both are set without an ancestor", async () => {
		const processes = table(proc(1, 0, "/sbin/launchd"), proc(300, 1, "/opt/bin/bun", "bun side"));
		const single = await resolve([], { CODEX_THREAD_ID: CODEX_ID }, processes, 300);
		expect(single).toMatchObject({ id: CODEX_ID, agent: undefined });
		expect(single.harness.name).toBe("codex");

		const both = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CODEX_THREAD_ID: CODEX_ID };
		await expect(resolve([], both, processes, 300)).rejects.toThrow("pass --harness");
		expect((await resolve(["--harness", "claude"], both, processes, 300)).id).toBe(CLAUDE_ID);
	});

	// executablePath reads /proc/<pid>/exe on Linux, which the fake table cannot supply.
	test.skipIf(process.platform === "linux")(
		"a Codex `!` command runs under the app-server daemon, whose binary the fork reuses",
		async () => {
			const processes = table(
				proc(1, 0, "/sbin/launchd"),
				proc(400, 1, "/opt/Codex.app/Contents/MacOS/codex", "/opt/Codex.app/Contents/MacOS/codex app-server --listen x"),
				proc(401, 400, "/bin/zsh", "/bin/zsh -c side"),
				proc(402, 401, "/opt/bin/bun", "bun side"),
			);
			const source = await resolve([], { CODEX_THREAD_ID: CODEX_ID }, processes, 402);
			expect(source).toMatchObject({ id: CODEX_ID, agent: undefined });
			expect(source.binaryHost?.pid).toBe(400);
		},
	);

	test("errors outside any agent", async () => {
		const processes = table(proc(1, 0, "/sbin/launchd"), proc(300, 1, "/bin/zsh", "-zsh"));
		await expect(resolve([], {}, processes, 300)).rejects.toThrow("not inside a Claude Code, Codex, or omp session");
	});

	test("--pane-pid finds a descendant agent and asks its harness for the session", async () => {
		// The pane's shell runs codex resume <id>; the unrelated sibling shell is ignored.
		const processes = table(
			proc(1, 0, "/sbin/launchd"),
			proc(500, 1, "/bin/zsh", "-zsh"),
			proc(501, 500, "/opt/bin/codex", `/opt/bin/codex resume ${CODEX_ID}`),
			proc(600, 1, "/bin/zsh", "-zsh"),
			proc(300, 1, "/opt/bin/bun", "bun side"),
		);
		const source = await resolve(["--pane-pid", "500"], {}, processes, 300);
		expect(source.harness.name).toBe("codex");
		expect(source.id).toBe(CODEX_ID);
		expect(source.agent?.pid).toBe(501);
	});

	test("--pane-pid accepts a pane whose own process is the agent", async () => {
		const processes = table(
			proc(1, 0, "/sbin/launchd"),
			proc(500, 1, "/opt/bin/codex", `/opt/bin/codex resume ${CODEX_ID}`),
			proc(300, 1, "/opt/bin/bun", "bun side"),
		);
		const source = await resolve(["--pane-pid", "500"], {}, processes, 300);
		expect(source).toMatchObject({ id: CODEX_ID });
		expect(source.agent?.pid).toBe(500);
	});

	test("--pane-pid errors when no agent runs under the pane, and --pid when the process is not an agent", async () => {
		const processes = table(
			proc(1, 0, "/sbin/launchd"),
			proc(500, 1, "/bin/zsh", "-zsh"),
			proc(501, 500, "/usr/bin/vim"),
			proc(300, 1, "/opt/bin/bun", "bun side"),
		);
		await expect(resolve(["--pane-pid", "500"], {}, processes, 300)).rejects.toThrow(
			"no Claude Code, Codex, or omp agent is running under pane process 500",
		);
		await expect(resolve(["--pid", "501"], {}, processes, 300)).rejects.toThrow(
			"process 501 is not a running Claude Code, Codex, or omp agent",
		);
		await expect(resolve(["--harness", "codex", "--pid", "999"], {}, processes, 300)).rejects.toThrow(
			"process 999 is not a running codex agent",
		);
	});

	test("--harness filters descendants of the pane", async () => {
		const processes = table(
			proc(1, 0, "/sbin/launchd"),
			proc(500, 1, "/bin/zsh", "-zsh"),
			proc(501, 500, "/opt/bin/codex", `/opt/bin/codex resume ${CODEX_ID}`),
			proc(300, 1, "/opt/bin/bun", "bun side"),
		);
		await expect(resolve(["--harness", "claude", "--pane-pid", "500"], {}, processes, 300)).rejects.toThrow(
			"no claude agent is running under pane process 500",
		);
	});

	test("--session without --harness outside an agent throws", async () => {
		const processes = table(proc(1, 0, "/sbin/launchd"), proc(300, 1, "/bin/zsh", "-zsh"));
		await expect(resolve(["--session", CODEX_ID], {}, processes, 300)).rejects.toThrow(
			"--session needs --harness claude, codex, or omp outside an agent",
		);
	});

	test("--session uses the given harness, or the enclosing agent's when there is one", async () => {
		const outside = table(proc(1, 0, "/sbin/launchd"), proc(300, 1, "/bin/zsh", "-zsh"));
		const explicit = await resolve(["--session", "abc", "--harness", "codex"], {}, outside, 300);
		expect(explicit).toMatchObject({ id: "abc", agent: undefined });
		expect(explicit.harness.name).toBe("codex");

		const inside = table(
			proc(1, 0, "/sbin/launchd"),
			proc(100, 1, "/opt/bin/claude"),
			proc(300, 100, "/bin/sh"),
		);
		const detected = await resolve(["--session", "abc"], {}, inside, 300);
		expect(detected.harness.name).toBe("claude");
		expect(detected.agent?.pid).toBe(100);
	});

	test("an omp ancestor nearer than Claude Code is asked for its session despite the inherited Claude id", async () => {
		// claude -> sh -> omp (bun source checkout) -> sh -> side; omp exports no id of its own.
		const processes = table(
			proc(1, 0, "/sbin/launchd"),
			proc(100, 1, "/opt/bin/claude"),
			proc(101, 100, "/bin/sh"),
			proc(200, 101, "/opt/bin/bun", "bun --preload /src/omp/scripts/omp.ts /src/omp/src/cli.ts"),
			proc(201, 200, "/bin/zsh"),
			proc(300, 201, "/opt/bin/bun", "bun side"),
		);
		const asked = spyOn(omp, "sessionFromProcess").mockImplementation(async () => "/s/omp.jsonl");
		try {
			const source = await resolve([], { CLAUDE_CODE_SESSION_ID: CLAUDE_ID }, processes, 300);
			expect(source.harness.name).toBe("omp");
			expect(source.id).toBe("/s/omp.jsonl");
			expect(asked.mock.calls[0]?.[0].pid).toBe(200);
		} finally {
			asked.mockRestore();
		}
	});
});
