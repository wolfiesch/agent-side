/**
 * Harness adapters: how to recognize an agent process, which live session it is running, where
 * that session's transcript lives, and the command that forks it into a new interactive session.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { executablePath, type ProcessInfo } from "./process";

export type HarnessName = "claude" | "codex";

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
	sessionFromProcess(info: ProcessInfo, env: NodeJS.ProcessEnv): string;
	locate(id: string, env: NodeJS.ProcessEnv): SessionLocation;
	forkArgv(executable: string, id: string, harnessArgs: readonly string[], prompt: string): string[];
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
	// The id form resolves against the launch directory's project, so the fork starts in the
	// recorded cwd. `--` keeps a prompt that begins with a dash from parsing as an option.
	forkArgv: (executable, id, harnessArgs, prompt) => [
		executable, "--resume", id, "--fork-session", ...harnessArgs, ...(prompt ? ["--", prompt] : []),
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
	forkArgv: (executable, id, harnessArgs, prompt) => [
		executable, "fork", ...harnessArgs, id, ...(prompt ? ["--", prompt] : []),
	],
};

export const HARNESSES: Record<HarnessName, Harness> = { claude, codex };

/**
 * The executable to fork with: the agent's own binary when the process table names it, so
 * shell functions and PATH differences in the new pane cannot pick another install.
 */
export function agentExecutable(harness: Harness, agent: ProcessInfo | undefined, path: string | undefined): string {
	const own = agent && executablePath(agent);
	if (own && existsSync(own)) return own;
	for (const dir of (path ?? "").split(":")) {
		const candidate = join(dir, harness.name);
		if (dir && existsSync(candidate)) return candidate;
	}
	throw new Error(`cannot find the ${harness.name} executable: it is not in the process table or on PATH`);
}
