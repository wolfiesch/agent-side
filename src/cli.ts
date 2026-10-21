#!/usr/bin/env bun
/**
 * side: fork the coding-agent session you are in into a nearby terminal pane.
 *
 *   !side why would that cache miss?          from inside Claude Code, Codex, or omp
 *   side --pane-pid 4242                      from a terminal keybinding, outside the agent
 */
import { basename } from "node:path";
import { agentExecutable, HARNESSES, type Harness, type HarnessName } from "./harness";
import { ancestors, descendants, executablePath, readProcessTable, type ProcessInfo, type ProcessTable } from "./process";
import {
	createRunner, detectTerminal, launchInTerminal, paneTitle,
	type Direction, type LaunchRequest, type Runner,
} from "./terminal";

const USAGE = `usage: side [options] [harness options] [-- prompt]
       side <prompt>

Fork the Claude Code, Codex, or omp session you are in into a nearby pane and ask <prompt> there.

Run it from inside the agent (!side ... in its shell), or from a terminal
keybinding with --pane-pid. Options that side does not know pass through to the agent,
so --model and friends work. Put -- before a prompt when you pass any options.

  --bg                      keep focus here
  --tab                     open a new tab instead of a split
  --split                   split even when no pane has room
  --left|--right|--up|--down  split in that direction only
  --harness claude|codex|omp  which agent to fork when it cannot be detected
  --session <id>            fork this session id (omp: id or transcript path) instead of detecting one
  --pane-pid <pid>          find the agent running under this pane's shell
  --pid <pid>               fork the session of this agent process
  --dry-run                 print the plan as JSON and launch nothing
  -h, --help                show this help

Environment: SIDE_MIN_COLS, SIDE_MIN_ROWS (default 80x30) set the smallest pane a split may leave.`;

export interface SideOptions {
	request: LaunchRequest;
	harness?: HarnessName;
	session?: string;
	panePid?: number;
	pid?: number;
	dryRun: boolean;
	help: boolean;
	harnessArgs: string[];
	prompt: string;
}

function pidValue(flag: string, raw: string | undefined): number {
	const pid = Number(raw);
	if (!raw || !Number.isSafeInteger(pid) || pid < 1) throw new Error(`${flag} needs a process id, got "${raw ?? ""}"`);
	return pid;
}

/**
 * `--` separates options from the prompt. Without it, a leading `-` means every argument is an
 * option, and anything else is the prompt, so `side why is this slow` needs no quoting.
 */
export function parseArgs(argv: readonly string[]): SideOptions {
	const options: SideOptions = {
		request: { focus: true, placement: "auto" },
		dryRun: false,
		help: false,
		harnessArgs: [],
		prompt: "",
	};
	const separator = argv.indexOf("--");
	let head: readonly string[];
	if (separator !== -1) {
		head = argv.slice(0, separator);
		options.prompt = argv.slice(separator + 1).join(" ").trim();
	} else if (argv[0]?.startsWith("-")) {
		head = argv;
	} else {
		head = [];
		options.prompt = argv.join(" ").trim();
	}
	for (let index = 0; index < head.length; index++) {
		const token = head[index];
		switch (token) {
			case "--bg":
			case "--no-focus":
				options.request.focus = false;
				break;
			case "--focus":
				options.request.focus = true;
				break;
			case "--tab":
				options.request.placement = "tab";
				break;
			case "--split":
				options.request.placement = "split";
				break;
			case "--right":
			case "--left":
			case "--up":
			case "--down":
				options.request.direction = token.slice(2) as Direction;
				options.request.placement = "split";
				break;
			case "--harness": {
				const name = head[++index];
				if (name !== "claude" && name !== "codex" && name !== "omp") {
					throw new Error(`--harness must be claude, codex, or omp, got "${name ?? ""}"`);
				}
				options.harness = name;
				break;
			}
			case "--session": {
				const id = head[++index];
				if (!id) throw new Error("--session needs a session id");
				options.session = id;
				break;
			}
			case "--pane-pid":
				options.panePid = pidValue(token, head[++index]);
				break;
			case "--pid":
				options.pid = pidValue(token, head[++index]);
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				options.harnessArgs.push(token);
		}
	}
	if ([options.session, options.panePid, options.pid].filter((value) => value !== undefined).length > 1) {
		throw new Error("use only one of --session, --pane-pid, and --pid");
	}
	return options;
}

export interface Source {
	harness: Harness;
	id: string;
	/** The agent process, when one was found; its binary is reused for the fork. */
	agent?: ProcessInfo;
	/**
	 * Without an agent process, the nearest ancestor running the harness's binary. Codex runs `!`
	 * commands from its shared app-server daemon, not under the TUI, and gives them a PATH that
	 * need not contain `codex`; the daemon is that same binary.
	 */
	binaryHost?: ProcessInfo;
}

const ANY_AGENT = "Claude Code, Codex, or omp";

function harnessOf(info: ProcessInfo, only?: HarnessName): Harness | undefined {
	return Object.values(HARNESSES).find((harness) => (!only || harness.name === only) && harness.isAgentProcess(info));
}

/** Which session to fork: explicit id, a named process or pane, or the agent this shell runs under. */
export async function resolveSource(
	options: SideOptions,
	env: NodeJS.ProcessEnv,
	run: Runner,
	selfPid: number,
	readTable: (run: Runner) => Promise<ProcessTable> = readProcessTable,
): Promise<Source> {
	const table = await readTable(run);
	const nearestAgent = ancestors(table, selfPid).find((info) => harnessOf(info, options.harness));

	if (options.pid !== undefined || options.panePid !== undefined) {
		// A pane may run the agent directly rather than under a shell, so the pane process counts too.
		const paneProcess = options.panePid !== undefined ? table.get(options.panePid) : undefined;
		const agent =
			options.pid !== undefined
				? table.get(options.pid)
				: [...(paneProcess ? [paneProcess] : []), ...descendants(table, options.panePid as number)]
					.find((info) => harnessOf(info, options.harness));
		const harness = agent && harnessOf(agent, options.harness);
		if (!agent || !harness) {
			throw new Error(
				options.pid !== undefined
					? `process ${options.pid} is not a running ${options.harness ?? ANY_AGENT} agent`
					: `no ${options.harness ?? ANY_AGENT} agent is running under pane process ${options.panePid}`,
			);
		}
		return { harness, id: await harness.sessionFromProcess(agent, env, run), agent };
	}

	if (options.session !== undefined) {
		const harness = options.harness ? HARNESSES[options.harness] : nearestAgent && harnessOf(nearestAgent);
		if (!harness) throw new Error("--session needs --harness claude, codex, or omp outside an agent");
		return { harness, id: options.session, agent: nearestAgent && harnessOf(nearestAgent) === harness ? nearestAgent : undefined };
	}

	// Inside an agent the nearest agent ancestor decides between nested harnesses. Its exported
	// session id names the session; an agent that exports none (omp) is asked through its process.
	const ancestorHarness = nearestAgent && harnessOf(nearestAgent, options.harness);
	if (nearestAgent && ancestorHarness) {
		const id = ancestorHarness.sessionFromEnv(env) ?? (await ancestorHarness.sessionFromProcess(nearestAgent, env, run));
		return { harness: ancestorHarness, id, agent: nearestAgent };
	}
	const exported = Object.values(HARNESSES).filter(
		(harness) => (!options.harness || harness.name === options.harness) && harness.sessionFromEnv(env),
	);
	if (exported.length !== 1) {
		throw new Error(
			exported.length > 1
				? "both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are set; pass --harness"
				: `not inside a ${ANY_AGENT} session: run side from the agent (!side ...), or pass --pane-pid, --pid, or --session`,
		);
	}
	const harness = exported[0];
	const binaryHost = ancestors(table, selfPid).find((info) => {
		const path = executablePath(info);
		return path !== undefined && basename(path) === harness.name && harness.isOwnBinary(path);
	});
	return { harness, id: harness.sessionFromEnv(env) as string, agent: undefined, binaryHost };
}

async function main(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	const env = process.env;
	const run = createRunner();
	const source = await resolveSource(options, env, run, process.pid);
	const location = source.harness.locate(source.id, env);
	const executable = agentExecutable(source.harness, source.agent ?? source.binaryHost, env.PATH);
	const forkArgv = source.harness.forkArgv(
		executable, { id: source.id, transcript: location.transcript }, options.harnessArgs, options.prompt,
	);
	const terminal = detectTerminal(env);
	if (options.dryRun) {
		console.log(JSON.stringify({
			harness: source.harness.name,
			session: source.id,
			agentPid: source.agent?.pid,
			transcript: location.transcript,
			cwd: location.cwd,
			terminal,
			request: options.request,
			argv: forkArgv,
		}, null, 2));
		return 0;
	}
	const result = await launchInTerminal(
		run, env, process.platform, options.request, location.cwd, forkArgv, paneTitle(options.prompt),
	);
	console.log(`side: forked ${source.harness.name} session ${source.id} into ${result.terminal} ${result.placement} ${result.target}`);
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(`side: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		},
	);
}
