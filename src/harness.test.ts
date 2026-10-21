import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude, codex } from "./harness";
import type { ProcessInfo } from "./process";

const UUID = "0198a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_UUID = "11111111-2222-4333-8444-555555555555";

const proc = (pid: number, comm: string, args = comm): ProcessInfo => ({ pid, ppid: 1, comm, args });

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "side-harness-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("forkArgv", () => {
	test("claude puts -- before a prompt and omits it without one", () => {
		expect(claude.forkArgv("/bin/claude", UUID, ["--model", "opus"], "-why dash?")).toEqual([
			"/bin/claude", "--resume", UUID, "--fork-session", "--model", "opus", "--", "-why dash?",
		]);
		expect(claude.forkArgv("/bin/claude", UUID, [], "")).toEqual(["/bin/claude", "--resume", UUID, "--fork-session"]);
	});

	test("codex forks by id with the prompt after --", () => {
		expect(codex.forkArgv("/bin/codex", UUID, ["-m", "gpt-5"], "why?")).toEqual([
			"/bin/codex", "fork", "-m", "gpt-5", UUID, "--", "why?",
		]);
		expect(codex.forkArgv("/bin/codex", UUID, [], "")).toEqual(["/bin/codex", "fork", UUID]);
	});
});

describe("isAgentProcess", () => {
	test("codex rejects its app-server helper and accepts a TUI", () => {
		expect(codex.isAgentProcess(proc(10, "/opt/bin/codex", "/opt/bin/codex app-server --listen stdio://"))).toBe(false);
		expect(codex.isAgentProcess(proc(11, "/opt/bin/codex", "/opt/bin/codex"))).toBe(true);
		expect(codex.isAgentProcess(proc(12, "/opt/bin/codex", "/opt/bin/codex resume " + UUID))).toBe(true);
	});

	test("codex recognizes a node-hosted install by argv0 and ignores other programs", () => {
		expect(codex.isAgentProcess(proc(13, "/usr/bin/node", "codex --search"))).toBe(true);
		expect(codex.isAgentProcess(proc(14, "/bin/zsh", "-zsh"))).toBe(false);
	});

	test("claude accepts a versioned install path", () => {
		expect(
			claude.isAgentProcess(proc(20, "/Users/me/.local/share/claude/versions/2.1.84", "claude --resume")),
		).toBe(true);
		expect(claude.isAgentProcess(proc(21, "/Users/me/.local/share/claude/versions/2.1.84", "2.1.84"))).toBe(true);
	});

	test("claude accepts a plain binary and rejects unrelated processes", () => {
		expect(claude.isAgentProcess(proc(22, "/usr/local/bin/claude"))).toBe(true);
		expect(claude.isAgentProcess(proc(23, "/bin/bash", "bash"))).toBe(false);
		expect(claude.isAgentProcess(proc(24, "/opt/bin/codex", "/opt/bin/codex"))).toBe(false);
	});
});

describe("sessionFromEnv", () => {
	test("reads the id each harness exports and treats empty as unset", () => {
		expect(claude.sessionFromEnv({ CLAUDE_CODE_SESSION_ID: UUID })).toBe(UUID);
		expect(claude.sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "" })).toBeUndefined();
		expect(codex.sessionFromEnv({ CODEX_THREAD_ID: UUID })).toBe(UUID);
		expect(codex.sessionFromEnv({})).toBeUndefined();
	});
});

describe("codex.sessionFromProcess", () => {
	test("takes the thread id from `codex resume <uuid>`", () => {
		expect(codex.sessionFromProcess(proc(1, "/bin/codex", `/bin/codex resume ${UUID}`), {})).toBe(UUID);
		expect(codex.sessionFromProcess(proc(1, "/bin/codex", `/bin/codex --model x resume ${UUID}`), {})).toBe(UUID);
	});

	test("refuses a plain TUI, resume without an id, and a fork", () => {
		expect(() => codex.sessionFromProcess(proc(2, "/bin/codex"), {})).toThrow("cannot tell which thread");
		expect(() => codex.sessionFromProcess(proc(2, "/bin/codex", "/bin/codex resume --last"), {})).toThrow(
			"cannot tell which thread",
		);
		// A fork's own new thread id is unknown; the parent id in argv must not be mistaken for it.
		expect(() => codex.sessionFromProcess(proc(3, "/bin/codex", `/bin/codex fork ${UUID}`), {})).toThrow(
			"cannot tell which thread",
		);
	});
});

describe("claude.sessionFromProcess", () => {
	const writeRegistry = (pid: number, contents: string) => {
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(join(root, "sessions", `${pid}.json`), contents);
	};

	test("reads the session id from the per-pid registry under CLAUDE_CONFIG_DIR", () => {
		writeRegistry(4242, JSON.stringify({ pid: 4242, sessionId: UUID }));
		expect(claude.sessionFromProcess(proc(4242, "/bin/claude"), { CLAUDE_CONFIG_DIR: root })).toBe(UUID);
	});

	test("throws when the registry file is missing", () => {
		expect(() => claude.sessionFromProcess(proc(4243, "/bin/claude"), { CLAUDE_CONFIG_DIR: root })).toThrow(
			"no readable session registry",
		);
	});

	test("throws when the id is missing or not a UUID", () => {
		writeRegistry(1, JSON.stringify({ sessionId: "not-a-uuid" }));
		writeRegistry(2, JSON.stringify({ other: UUID }));
		writeRegistry(3, "{ not json");
		for (const pid of [1, 2]) {
			expect(() => claude.sessionFromProcess(proc(pid, "/bin/claude"), { CLAUDE_CONFIG_DIR: root })).toThrow(
				"has no sessionId",
			);
		}
		expect(() => claude.sessionFromProcess(proc(3, "/bin/claude"), { CLAUDE_CONFIG_DIR: root })).toThrow(
			"no readable session registry",
		);
	});
});

describe("claude.locate", () => {
	test("finds the transcript in any project directory and reads the recorded cwd", () => {
		mkdirSync(join(root, "projects", "-tmp-other"), { recursive: true });
		mkdirSync(join(root, "projects", "-tmp-work"), { recursive: true });
		const transcript = join(root, "projects", "-tmp-work", `${UUID}.jsonl`);
		writeFileSync(
			transcript,
			[
				JSON.stringify({ type: "summary", summary: "no cwd on this line" }),
				"{ a truncated line",
				JSON.stringify({ type: "user", cwd: "/tmp/work dir", sessionId: UUID }),
				JSON.stringify({ type: "user", cwd: "/tmp/elsewhere" }),
			].join("\n"),
		);

		expect(claude.locate(UUID, { CLAUDE_CONFIG_DIR: root })).toEqual({ transcript, cwd: "/tmp/work dir" });
	});

	test("throws for an unknown session and for a transcript with no cwd", () => {
		mkdirSync(join(root, "projects", "-tmp-work"), { recursive: true });
		writeFileSync(join(root, "projects", "-tmp-work", `${UUID}.jsonl`), JSON.stringify({ type: "summary" }));

		expect(() => claude.locate(OTHER_UUID, { CLAUDE_CONFIG_DIR: root })).toThrow("no Claude Code transcript");
		expect(() => claude.locate(UUID, { CLAUDE_CONFIG_DIR: root })).toThrow("no working directory recorded");
	});

	test("an absent projects directory is an unknown session, not a crash", () => {
		expect(() => claude.locate(UUID, { CLAUDE_CONFIG_DIR: join(root, "missing") })).toThrow(
			"no Claude Code transcript",
		);
	});
});

describe("codex.locate", () => {
	test("finds the rollout by thread id and reads cwd from the session_meta payload", () => {
		const day = join(root, "sessions", "2026", "10", "20");
		mkdirSync(day, { recursive: true });
		const transcript = join(day, `rollout-2026-10-20T10-00-00-${UUID}.jsonl`);
		writeFileSync(join(day, `rollout-2026-10-20T11-00-00-${OTHER_UUID}.jsonl`), JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/other" } }));
		writeFileSync(
			transcript,
			[
				JSON.stringify({ type: "event_msg", payload: { cwd: "/tmp/not-meta" } }),
				JSON.stringify({ type: "session_meta", payload: { id: UUID, cwd: "/tmp/codex work" } }),
			].join("\n"),
		);

		expect(codex.locate(UUID, { CODEX_HOME: root })).toEqual({ transcript, cwd: "/tmp/codex work" });
	});

	test("throws for an unknown thread, an absent sessions directory, and a rollout without cwd", () => {
		const day = join(root, "sessions", "2026", "10", "20");
		mkdirSync(day, { recursive: true });
		writeFileSync(join(day, `rollout-2026-10-20T10-00-00-${UUID}.jsonl`), JSON.stringify({ type: "session_meta", payload: {} }));

		expect(() => codex.locate(OTHER_UUID, { CODEX_HOME: root })).toThrow("no Codex rollout");
		expect(() => codex.locate(UUID, { CODEX_HOME: join(root, "missing") })).toThrow("no Codex rollout");
		expect(() => codex.locate(UUID, { CODEX_HOME: root })).toThrow("no working directory recorded");
	});
});
