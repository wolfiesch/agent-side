/**
 * Harness adapters: how to recognize an agent process, which live session it is running, where
 * that session's transcript lives, and the command that forks it into a new interactive session.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { executablePath, type ProcessInfo } from "./process";
import type { Runner } from "./terminal";

export type HarnessName = "claude" | "codex" | "omp";

export interface SessionLocation {
	transcript: string;
	/** Working directory the session was recorded in; the fork starts there. */
	cwd: string;
}

export interface Harness {
	name: HarnessName;
	/** Session id exported to shell commands the agent runs, including user `!` commands. */
	sessionFromEnv(env: NodeJS.ProcessEnv): string | undefined;
	isAgentProcess(info: ProcessInfo): boolean;
	/** The session a running agent process is serving; throws when it cannot be named exactly. */
	sessionFromProcess(info: ProcessInfo, env: NodeJS.ProcessEnv, run: Runner): string | Promise<string>;
	locate(id: string, env: NodeJS.ProcessEnv): SessionLocation;
	/** Whether `path`, the binary an agent process runs, is the agent rather than a runtime hosting it. */
	isOwnBinary(path: string): boolean;
	forkArgv(executable: string, session: { id: string; transcript: string }, harnessArgs: readonly string[], prompt: string): string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First `cwd` recorded in a transcript, scanning at most the opening lines. */
function recordedCwd(transcript: string, pick: (entry: Record<string, unknown>) => unknown): string {
	const lines = readFileSync(transcript, "utf8").split("\n", 200);
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const cwd = pick(JSON.parse(line));
			if (typeof cwd === "string" && cwd) return cwd;
		} catch {
			// A partial trailing line; keep scanning.
		}
	}
	throw new Error(`no working directory recorded in ${transcript}`);
}

function argv0Name(info: ProcessInfo): string {
	return basename(info.args.split(" ", 1)[0] ?? "");
}

const claudeDir = (env: NodeJS.ProcessEnv): string => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export const claude: Harness = {
	name: "claude",
	sessionFromEnv: (env) => env.CLAUDE_CODE_SESSION_ID || undefined,
	isAgentProcess(info) {
		const exe = basename(info.comm);
		return (
			exe === "claude" || exe === "claude.exe" || argv0Name(info) === "claude" ||
			info.comm.includes("/claude/versions/") || info.comm.includes("/@anthropic-ai/claude-code/")
		);
	},
	sessionFromProcess(info, env) {
		const registry = join(claudeDir(env), "sessions", `${info.pid}.json`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(registry, "utf8"));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Claude Code process ${info.pid} has no readable session registry at ${registry}: ${reason}`);
		}
		const id = parsed && typeof parsed === "object" && "sessionId" in parsed ? parsed.sessionId : undefined;
		if (typeof id !== "string" || !UUID.test(id)) throw new Error(`${registry} has no sessionId`);
		return id;
	},
	locate(id, env) {
		const projects = join(claudeDir(env), "projects");
		const name = `${id}.jsonl`;
		const transcript = (existsSync(projects) ? readdirSync(projects) : [])
			.map((project) => join(projects, project, name))
			.find((candidate) => existsSync(candidate));
		if (!transcript) {
			throw new Error(`no Claude Code transcript for session ${id} under ${projects}; a brand-new session has nothing to fork until its first message`);
		}
		return { transcript, cwd: recordedCwd(transcript, (entry) => entry.cwd) };
	},
	isOwnBinary: () => true,
	// The id form resolves against the launch directory's project, so the fork starts in the
	// recorded cwd. `--` keeps a prompt that begins with a dash from parsing as an option.
	forkArgv: (executable, session, harnessArgs, prompt) => [
		executable, "--resume", session.id, "--fork-session", ...harnessArgs, ...(prompt ? ["--", prompt] : []),
	],
};

const codexSessions = (env: NodeJS.ProcessEnv): string => join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

export const codex: Harness = {
	name: "codex",
	sessionFromEnv: (env) => env.CODEX_THREAD_ID || undefined,
	// `codex app-server` is the TUI's backend helper, not the agent the user is talking to.
	isAgentProcess: (info) =>
		(basename(info.comm) === "codex" || argv0Name(info) === "codex") && !/\sapp-server(\s|$)/.test(info.args),
	/**
	 * Codex TUIs share one per-user `codex app-server` daemon that outlives them and holds every
	 * open thread's rollout, and nothing on disk ties a TUI process to its thread. Only a TUI
	 * started as `codex resume <id>` names its thread; anything else is refused rather than guessed.
	 */
	sessionFromProcess(info) {
		const id = /(?:^|\s)resume\s+(\S+)/.exec(info.args)?.[1];
		if (id && UUID.test(id)) return id;
		throw new Error(
			`cannot tell which thread Codex process ${info.pid} is showing (Codex keeps no process-to-thread record); run !side inside that Codex session instead`,
		);
	},
	locate(id, env) {
		const root = codexSessions(env);
		const transcript = existsSync(root)
			? [...new Bun.Glob(`**/rollout-*${id}.jsonl`).scanSync({ cwd: root, absolute: true })][0]
			: undefined;
		if (!transcript) throw new Error(`no Codex rollout for thread ${id} under ${root}`);
		return {
			transcript,
			cwd: recordedCwd(transcript, (entry) => {
				const payload = entry.type === "session_meta" ? entry.payload : undefined;
				return payload && typeof payload === "object" && "cwd" in payload ? payload.cwd : undefined;
			}),
		};
	},
	isOwnBinary: () => true,
	forkArgv: (executable, session, harnessArgs, prompt) => [
		executable, "fork", ...harnessArgs, session.id, ...(prompt ? ["--", prompt] : []),
	],
};

const OMP_ENTRY = /^omp(\.[cm]?[jt]s)?$/;
const OMP_HEAD_BYTES = 64 * 1024;

const ompSessions = (env: NodeJS.ProcessEnv): string =>
	join(env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), "sessions");

/** The `{"type":"session"}` header near the top of an omp transcript, or undefined when there is none. */
export function ompHeader(transcript: string): { id: string; cwd: string } | undefined {
	let text: string;
	try {
		const fd = openSync(transcript, "r");
		try {
			const buffer = Buffer.alloc(OMP_HEAD_BYTES);
			text = buffer.toString("utf8", 0, readSync(fd, buffer, 0, OMP_HEAD_BYTES, 0));
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
	for (const line of text.split("\n", 8)) {
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "session" && typeof entry.id === "string" && typeof entry.cwd === "string" && entry.cwd) {
				return { id: entry.id, cwd: entry.cwd };
			}
		} catch {
			// A cut-off line at the end of the read; keep scanning.
		}
	}
	return undefined;
}

/** Paths of the files `pid` holds open: /proc on Linux, lsof elsewhere. */
export async function openFiles(pid: number, run: Runner, platform: NodeJS.Platform = process.platform): Promise<string[]> {
	if (platform === "linux") {
		const dir = `/proc/${pid}/fd`;
		const paths: string[] = [];
		for (const fd of readdirSync(dir)) {
			try {
				paths.push(readlinkSync(join(dir, fd)));
			} catch {
				// Closed while listing.
			}
		}
		return paths;
	}
	// Pane-launched helpers often run without /usr/sbin on PATH.
	const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
	const result = await run(lsof, ["-n", "-P", "-p", String(pid), "-Fn"]);
	if (result.code !== 0 && !result.stdout) {
		throw new Error(`lsof -p ${pid}: ${(result.stderr || `exit ${result.code}`).trim()}`);
	}
	return result.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
}

/**
 * The omp session a process is writing: the one session transcript it holds open. omp exports no
 * session id to shell commands, and keeps its transcript open for appending for as long as the
 * session is current. Subagent transcripts it also writes live in the session's artifacts
 * directory (the transcript path without `.jsonl`), so they are set aside.
 */
export function ompSessionFromOpenFiles(pid: number, paths: readonly string[]): string {
	const sessions = [...new Set(paths.filter((path) => path.endsWith(".jsonl") && ompHeader(path)))];
	const own = sessions.filter(
		(path) => !sessions.some((other) => other !== path && path.startsWith(`${other.slice(0, -".jsonl".length)}/`)),
	);
	if (own.length === 1) return own[0];
	if (own.length === 0) {
		throw new Error(
			`omp process ${pid} has no session transcript open; a brand-new session has nothing to fork until its first message, and --no-session runs have none`,
		);
	}
	throw new Error(`omp process ${pid} has several session transcripts open: ${own.join(", ")}`);
}

export const omp: Harness = {
	name: "omp",
	sessionFromEnv: () => undefined,
	// The compiled binary, an npm install (`bun …/bin/omp`), or a source checkout run as
	// `bun --preload …/scripts/omp.ts …/src/cli.ts`.
	isAgentProcess(info) {
		if (basename(info.comm) === "omp") return true;
		const [argv0 = "", ...rest] = info.args.split(/\s+/);
		const runtime = basename(argv0);
		if (runtime === "omp") return true;
		return (runtime === "bun" || runtime === "node") && rest.some((arg) => OMP_ENTRY.test(basename(arg)));
	},
	async sessionFromProcess(info, _env, run) {
		return ompSessionFromOpenFiles(info.pid, await openFiles(info.pid, run));
	},
	/** `id` is a transcript path, or a session id looked up under the default agent directory. */
	locate(id, env) {
		let transcript: string | undefined = id;
		if (!id.endsWith(".jsonl")) {
			const root = ompSessions(env);
			transcript = existsSync(root)
				? [...new Bun.Glob(`*/*_${id}.jsonl`).scanSync({ cwd: root, absolute: true })][0]
				: undefined;
			if (!transcript) throw new Error(`no omp transcript for session ${id} under ${root}`);
		}
		const header = ompHeader(transcript);
		if (!header) throw new Error(`${transcript} is not a readable omp session transcript`);
		return { transcript, cwd: header.cwd };
	},
	// omp runs under bun from a source checkout; only an `omp` binary is the agent itself.
	isOwnBinary: (path) => basename(path) === "omp",
	// A path forks that exact file, whatever profile or session directory it lives in.
	forkArgv: (executable, session, harnessArgs, prompt) => [
		executable, "--fork", session.transcript, ...harnessArgs, ...(prompt ? ["--", prompt] : []),
	],
};

export const HARNESSES: Record<HarnessName, Harness> = { claude, codex, omp };

/**
 * The executable to fork with: the agent's own binary when the process table names it, so
 * shell functions and PATH differences in the new pane cannot pick another install.
 */
export function agentExecutable(harness: Harness, agent: ProcessInfo | undefined, path: string | undefined): string {
	const own = agent && executablePath(agent);
	if (own && harness.isOwnBinary(own) && existsSync(own)) return own;
	for (const dir of (path ?? "").split(":")) {
		const candidate = join(dir, harness.name);
		if (dir && existsSync(candidate)) return candidate;
	}
	throw new Error(`cannot find the ${harness.name} executable: it is not in the process table or on PATH`);
}
