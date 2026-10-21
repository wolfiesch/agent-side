import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentExecutable, claude, codex, omp, ompSessionFromOpenFiles, openFiles } from "./harness";
import type { ProcessInfo } from "./process";
import type { Runner } from "./terminal";

const UUID = "0198a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_UUID = "11111111-2222-4333-8444-555555555555";

const proc = (pid: number, comm: string, args = comm): ProcessInfo => ({ pid, ppid: 1, comm, args });
const noRun: Runner = async () => {
	throw new Error("this harness must not shell out");
};
const session = (id: string, transcript = "/unused.jsonl") => ({ id, transcript });

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "side-harness-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("forkArgv", () => {
	test("claude puts -- before a prompt and omits it without one", () => {
		expect(claude.forkArgv("/bin/claude", session(UUID), ["--model", "opus"], "-why dash?")).toEqual([
			"/bin/claude", "--resume", UUID, "--fork-session", "--model", "opus", "--", "-why dash?",
		]);
		expect(claude.forkArgv("/bin/claude", session(UUID), [], "")).toEqual(["/bin/claude", "--resume", UUID, "--fork-session"]);
	});

	test("codex forks by id with the prompt after --", () => {
		expect(codex.forkArgv("/bin/codex", session(UUID), ["-m", "gpt-5"], "why?")).toEqual([
			"/bin/codex", "fork", "-m", "gpt-5", UUID, "--", "why?",
		]);
		expect(codex.forkArgv("/bin/codex", session(UUID), [], "")).toEqual(["/bin/codex", "fork", UUID]);
	});

	test("omp forks the transcript path, not the id, with the prompt after --", () => {
		expect(omp.forkArgv("/bin/omp", session(UUID, "/s/a b.jsonl"), ["--model", "@slow"], "-why?")).toEqual([
			"/bin/omp", "--fork", "/s/a b.jsonl", "--model", "@slow", "--", "-why?",
		]);
		expect(omp.forkArgv("/bin/omp", session(UUID, "/s/x.jsonl"), [], "")).toEqual(["/bin/omp", "--fork", "/s/x.jsonl"]);
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

	test("omp accepts the binary, an npm shim under bun or node, and a source checkout", () => {
		expect(omp.isAgentProcess(proc(30, "/usr/local/bin/omp", "omp --resume x"))).toBe(true);
		expect(omp.isAgentProcess(proc(31, "/opt/bin/bun", "bun /home/me/.bun/bin/omp"))).toBe(true);
		expect(omp.isAgentProcess(proc(32, "node", "node /usr/lib/node_modules/.bin/omp --model x"))).toBe(true);
		expect(
			omp.isAgentProcess(proc(33, "bun", "bun --preload /src/omp/packages/coding-agent/scripts/omp.ts /src/omp/packages/coding-agent/src/cli.ts")),
		).toBe(true);
	});

	test("omp rejects other bun programs, editors on omp files, and the other agents", () => {
		expect(omp.isAgentProcess(proc(34, "/opt/bin/bun", "bun /src/agent-side/src/cli.ts"))).toBe(false);
		expect(omp.isAgentProcess(proc(35, "/usr/bin/vim", "vim omp.ts"))).toBe(false);
		expect(omp.isAgentProcess(proc(36, "/opt/bin/claude", "claude"))).toBe(false);
		expect(claude.isAgentProcess(proc(37, "/usr/local/bin/omp", "omp"))).toBe(false);
		expect(codex.isAgentProcess(proc(38, "/usr/local/bin/omp", "omp"))).toBe(false);
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
		expect(codex.sessionFromProcess(proc(1, "/bin/codex", `/bin/codex resume ${UUID}`), {}, noRun)).toBe(UUID);
		expect(codex.sessionFromProcess(proc(1, "/bin/codex", `/bin/codex --model x resume ${UUID}`), {}, noRun)).toBe(UUID);
	});

	test("refuses a plain TUI, resume without an id, and a fork", () => {
		expect(() => codex.sessionFromProcess(proc(2, "/bin/codex"), {}, noRun)).toThrow("cannot tell which thread");
		expect(() => codex.sessionFromProcess(proc(2, "/bin/codex", "/bin/codex resume --last"), {}, noRun)).toThrow(
			"cannot tell which thread",
		);
		// A fork's own new thread id is unknown; the parent id in argv must not be mistaken for it.
		expect(() => codex.sessionFromProcess(proc(3, "/bin/codex", `/bin/codex fork ${UUID}`), {}, noRun)).toThrow(
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
		expect(claude.sessionFromProcess(proc(4242, "/bin/claude"), { CLAUDE_CONFIG_DIR: root }, noRun)).toBe(UUID);
	});

	test("throws when the registry file is missing", () => {
		expect(() => claude.sessionFromProcess(proc(4243, "/bin/claude"), { CLAUDE_CONFIG_DIR: root }, noRun)).toThrow(
			"no readable session registry",
		);
	});

	test("throws when the id is missing or not a UUID", () => {
		writeRegistry(1, JSON.stringify({ sessionId: "not-a-uuid" }));
		writeRegistry(2, JSON.stringify({ other: UUID }));
		writeRegistry(3, "{ not json");
		for (const pid of [1, 2]) {
			expect(() => claude.sessionFromProcess(proc(pid, "/bin/claude"), { CLAUDE_CONFIG_DIR: root }, noRun)).toThrow(
				"has no sessionId",
			);
		}
		expect(() => claude.sessionFromProcess(proc(3, "/bin/claude"), { CLAUDE_CONFIG_DIR: root }, noRun)).toThrow(
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

describe("omp sessions", () => {
	const OMP_ID = "01a15c4f-061d-7000-b434-73355c0b00ac";
	const writeSession = (dir: string, id: string, cwd: string): string => {
		mkdirSync(dir, { recursive: true });
		const transcript = join(dir, `2026-10-21T02-34-05-213Z_${id}.jsonl`);
		writeFileSync(
			transcript,
			[
				JSON.stringify({ type: "title", v: 1, title: "x", pad: " ".repeat(200) }),
				JSON.stringify({ type: "session", version: 3, id, cwd }),
				JSON.stringify({ type: "message", cwd: "/not/the/header" }),
			].join("\n"),
		);
		return transcript;
	};

	test("the one open session transcript names the session; subagent transcripts in its artifacts dir do not", () => {
		const main = writeSession(join(root, "sessions", "-work"), OMP_ID, "/work");
		const subagent = writeSession(main.slice(0, -".jsonl".length), OTHER_UUID, "/work");
		const notSession = join(root, "notes.jsonl");
		writeFileSync(notSession, JSON.stringify({ type: "log" }));
		expect(ompSessionFromOpenFiles(7, ["/dev/null", notSession, subagent, main, main])).toBe(main);
	});

	test("no open transcript and two unrelated ones are both refused", () => {
		const a = writeSession(join(root, "sessions", "-a"), OMP_ID, "/a");
		const b = writeSession(join(root, "sessions", "-b"), OTHER_UUID, "/b");
		expect(() => ompSessionFromOpenFiles(7, ["/dev/null"])).toThrow("has no session transcript open");
		expect(() => ompSessionFromOpenFiles(7, [a, b])).toThrow("has several session transcripts open");
	});

	test("openFiles reads lsof's name records outside Linux", async () => {
		const calls: string[][] = [];
		const run: Runner = async (command, args) => {
			calls.push([command, ...args]);
			return { code: 0, stdout: "p7\nfcwd\nn/work\nf31\nn/s/x.jsonl\n", stderr: "" };
		};
		expect(await openFiles(7, run, "darwin")).toEqual(["/work", "/s/x.jsonl"]);
		expect(calls[0]?.slice(1)).toEqual(["-n", "-P", "-p", "7", "-Fn"]);
	});

	test("locate takes a transcript path or an id under PI_CODING_AGENT_DIR, and reads the header cwd", () => {
		const transcript = writeSession(join(root, "sessions", "-work"), OMP_ID, "/work dir");
		writeSession(join(root, "sessions", "-other"), OTHER_UUID, "/other");
		expect(omp.locate(transcript, {})).toEqual({ transcript, cwd: "/work dir" });
		expect(omp.locate(OMP_ID, { PI_CODING_AGENT_DIR: root })).toEqual({ transcript, cwd: "/work dir" });
		expect(() => omp.locate(UUID, { PI_CODING_AGENT_DIR: root })).toThrow("no omp transcript for session");
		expect(() => omp.locate(join(root, "missing.jsonl"), {})).toThrow("not a readable omp session transcript");
	});
});

describe("agentExecutable", () => {
	test("omp running under bun forks with omp from PATH, not with bun", () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "omp"), "");
		writeFileSync(join(bin, "bun"), "");
		const agent = proc(9, join(bin, "bun"), "bun --preload /x/scripts/omp.ts /x/src/cli.ts");
		expect(agentExecutable(omp, agent, `/nowhere:${bin}`)).toBe(join(bin, "omp"));
		expect(agentExecutable(omp, proc(9, join(bin, "omp")), "")).toBe(join(bin, "omp"));
	});
});
