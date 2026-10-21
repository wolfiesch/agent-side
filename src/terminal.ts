/**
 * Terminal detection, size-aware placement, and launch adapters for opening a command in a
 * nearby pane or tab. Harness-agnostic: callers pass the argv to run and the working directory.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

export type TerminalKind = "cmux" | "tmux" | "tern" | "wezterm" | "kitty" | "ghostty";
export type Direction = "right" | "left" | "up" | "down";
export type Placement = "auto" | "split" | "tab";

export interface LaunchRequest {
	focus: boolean;
	placement: Placement;
	/** Set only by an explicit direction flag; automatic placement may choose either axis. */
	direction?: Direction;
	/** Live panes holding earlier forks of the same source, stacked into before splitting anew. */
	sidePanes?: readonly string[];
}

export interface LaunchResult {
	target: string;
	terminal: TerminalKind;
	placement: "split" | "tab" | "window";
}

export interface ExecOutput {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (command: string, args: string[]) => Promise<ExecOutput>;

const TERMINAL_TIMEOUT_MS = 15_000;
const TERN_APP_BINARY = "/Applications/Tern.app/Contents/MacOS/tern";

export function createRunner(timeoutMs = TERMINAL_TIMEOUT_MS): Runner {
	return async (command, args) => {
		const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => child.kill(), timeoutMs);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	};
}

export async function checked(run: Runner, command: string, args: string[]): Promise<string> {
	const result = await run(command, args);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
		throw new Error(`${basename(command)} ${args[0] ?? ""}: ${detail}`.trim());
	}
	return result.stdout.trim();
}

export function resolveOnPath(names: string[], path = process.env.PATH ?? ""): string {
	for (const name of names) {
		for (const dir of path.split(delimiter)) {
			if (!dir) continue;
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// keep looking
			}
		}
	}
	return names[0];
}

function resolveTern(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	const onPath = resolveOnPath(["tern"], env.PATH);
	if (onPath !== "tern" || platform !== "darwin") return onPath;
	return existsSync(TERN_APP_BINARY) ? TERN_APP_BINARY : onPath;
}

/** POSIX single-quote escaping; cmux and tmux run their command string under `/bin/sh -c`. */
export function shQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function detectTerminal(env: NodeJS.ProcessEnv): TerminalKind | null {
	if (env.CMUX_WORKSPACE_ID) return "cmux";
	if (env.TMUX) return "tmux";
	if (env.TERM_PROGRAM?.toLowerCase() === "tern" && env.TERN_PANE) return "tern";
	if (env.WEZTERM_PANE) return "wezterm";
	if (env.KITTY_WINDOW_ID) return "kitty";
	if (env.TERM_PROGRAM?.toLowerCase() === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	return null;
}

export function pathWithExecutableDir(path: string | undefined, executable: string): string | undefined {
	if (path === undefined) return undefined;
	const executableDir = dirname(executable);
	if (path.split(delimiter).includes(executableDir)) return path;
	return path ? `${executableDir}${delimiter}${path}` : executableDir;
}

/**
 * New panes inherit the terminal server's environment rather than the caller's, so the
 * caller's PATH travels with the command, with the launched executable's directory first.
 */
export function commandWithRuntimePath(argv: string[], path: string | undefined, executable: string): string[] {
	const childPath = pathWithExecutableDir(path, executable);
	if (childPath === undefined) return argv;
	return ["/usr/bin/env", `PATH=${childPath}`, ...argv];
}

export function choosePlacement(requested: Placement, paneCount: number): "split" | "tab" {
	if (requested === "tab") return "tab";
	if (requested === "split") return "split";
	return paneCount > 1 ? "tab" : "split";
}

export interface PaneGeometry {
	id: string;
	cols: number;
	rows: number;
	left?: number;
	top?: number;
}

export interface PlacementLimits {
	cols: number;
	rows: number;
}

export type PlacementPlan = { placement: "tab" } | { placement: "split"; pane: string; direction: Direction };

const DEFAULT_MIN_COLS = 80;
const DEFAULT_MIN_ROWS = 30;

function positiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive whole number of terminal cells, got "${raw}"`);
	}
	return value;
}

export function placementLimits(env: NodeJS.ProcessEnv): PlacementLimits {
	return {
		cols: positiveIntEnv(env, "SIDE_MIN_COLS", DEFAULT_MIN_COLS),
		rows: positiveIntEnv(env, "SIDE_MIN_ROWS", DEFAULT_MIN_ROWS),
	};
}

/**
 * Cell height over cell width, for terminals that do not report pixel sizes. Common monospace
 * fonts land between 1.8 and 2.2; Tern reports the real value through `tern inspect`.
 */
const DEFAULT_CELL_ASPECT = 2;

/** Height over width of one cell, from a pane's pixel and cell sizes; undefined if unusable. */
function cellAspect(cols: number, rows: number, width: number, height: number): number | undefined {
	const aspect = height / rows / (width / cols);
	return Number.isFinite(aspect) && aspect > 0 ? aspect : undefined;
}

interface SplitOption {
	pane: string;
	direction: Direction;
	/** Both halves meet the minimum size; one cell goes to the divider. */
	fits: boolean;
	/** Shorter on-screen side of the smaller half, in cell widths. */
	shortSide: number;
}

function splitOption(
	pane: PaneGeometry,
	direction: Direction,
	limits: PlacementLimits,
	aspect: number,
): SplitOption {
	const horizontal = direction === "left" || direction === "right";
	const cols = horizontal ? Math.floor((pane.cols - 1) / 2) : pane.cols;
	const rows = horizontal ? pane.rows : Math.floor((pane.rows - 1) / 2);
	return {
		pane: pane.id,
		direction,
		fits: cols >= limits.cols && rows >= limits.rows,
		shortSide: Math.min(cols, rows * aspect),
	};
}

/** Longest short side wins; ties keep the earlier option, so side by side beats stacked. */
function roomiest(options: SplitOption[]): SplitOption | undefined {
	let best: SplitOption | undefined;
	for (const option of options) if (!best || option.shortSide > best.shortSide) best = option;
	return best;
}

/** Panes share an edge with one divider cell between them; corner contact is not adjacent. */
function panesTouch(a: PaneGeometry, b: PaneGeometry): boolean {
	if (a.left === undefined || a.top === undefined || b.left === undefined || b.top === undefined) return false;
	const verticalOverlap = Math.min(a.top + a.rows, b.top + b.rows) > Math.max(a.top, b.top);
	const horizontalOverlap = Math.min(a.left + a.cols, b.left + b.cols) > Math.max(a.left, b.left);
	return (
		(verticalOverlap && (a.left + a.cols + 1 === b.left || b.left + b.cols + 1 === a.left)) ||
		(horizontalOverlap && (a.top + a.rows + 1 === b.top || b.top + b.rows + 1 === a.top))
	);
}

/**
 * Automatic repeat forks stack in their existing group, leaving the parent alone. A full
 * group opens a tab. Otherwise prefer the source, then fitting neighbors (where coordinates
 * exist), then other fitting panes. Explicit placement bypasses grouping.
 */
export function planPlacement(
	request: Pick<LaunchRequest, "placement" | "direction">,
	sourceId: string,
	panes: PaneGeometry[],
	limits: PlacementLimits,
	aspect: number,
	sidePanes: readonly string[] = [],
): PlacementPlan {
	if (request.placement === "tab") return { placement: "tab" };
	if (request.placement === "auto" && !request.direction && sidePanes.length > 0) {
		const group = panes
			.filter(pane => pane.id !== sourceId && sidePanes.includes(pane.id))
			.sort((a, b) => b.cols * b.rows - a.cols * a.rows);
		if (group.length > 0) {
			const stacked = roomiest(group.map(pane => splitOption(pane, "down", limits, aspect)).filter(option => option.fits));
			return stacked
				? { placement: "split", pane: stacked.pane, direction: "down" }
				: { placement: "tab" };
		}
	}
	const directions: Direction[] = request.direction ? [request.direction] : ["right", "down"];
	const options = (pane: PaneGeometry): SplitOption[] =>
		directions.map((direction) => splitOption(pane, direction, limits, aspect));
	const source = panes.find((pane) => pane.id === sourceId);
	const sourceOptions = source ? options(source) : [];
	const others = panes
		.filter(pane => pane.id !== sourceId)
		.sort((a, b) => b.cols * b.rows - a.cols * a.rows);
	const neighboring = source ? others.filter(pane => panesTouch(source, pane)) : [];
	const chosen =
		roomiest(sourceOptions.filter(option => option.fits)) ??
		roomiest(neighboring.flatMap(options).filter(option => option.fits)) ??
		roomiest(others.flatMap(options).filter(option => option.fits));
	if (chosen) return { placement: "split", pane: chosen.pane, direction: chosen.direction };
	if (request.placement === "split") {
		return { placement: "split", pane: sourceId, direction: roomiest(sourceOptions)?.direction ?? directions[0] };
	}
	return { placement: "tab" };
}

export function cmuxLayout(tree: string, surface: string | undefined): {
	paneCount: number;
	ownerPane: string | null;
} {
	const panes = new Set<string>();
	let currentPane: string | null = null;
	let ownerPane: string | null = null;
	for (const line of tree.split("\n")) {
		const pane = /\bpane:\d+\b/.exec(line)?.[0];
		if (pane) {
			currentPane = pane;
			panes.add(pane);
		}
		if (surface && line.includes(surface)) ownerPane = currentPane;
	}
	return { paneCount: panes.size, ownerPane };
}

function surfaceRef(output: string): string {
	const ref = /\bsurface:\d+\b/.exec(output)?.[0];
	if (!ref) throw new Error(`unexpected cmux output: ${output}`);
	return ref;
}

async function launchCmux(
	run: Runner,
	env: NodeJS.ProcessEnv,
	request: LaunchRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	const workspace = env.CMUX_WORKSPACE_ID;
	if (!workspace) throw new Error("CMUX_WORKSPACE_ID is missing");
	const sourceSurface = env.CMUX_SURFACE_ID;
	const tree = await checked(run, "cmux", ["--id-format", "both", "tree", "--workspace", workspace]);
	const layout = cmuxLayout(tree, sourceSurface);
	let identity: {
		focused?: { pane_ref?: string; window_ref?: string };
	} | null = null;
	if (!layout.ownerPane || !request.focus) {
		identity = JSON.parse(await checked(run, "cmux", ["identify", "--no-caller"]));
	}
	const ownerPane = layout.ownerPane ?? identity?.focused?.pane_ref ?? null;
	const restore =
		!request.focus && identity?.focused?.pane_ref && identity.focused.window_ref
			? { pane: identity.focused.pane_ref, window: identity.focused.window_ref }
			: null;
	const placement = choosePlacement(request.placement, layout.paneCount);
	// cmux panes start in the source surface's directory; the fork must start where its session ran.
	const command = `cd ${shQuote(cwd)} && exec ${argv.map(shQuote).join(" ")}`;

	let target: string;
	if (placement === "tab") {
		if (!ownerPane) throw new Error("could not resolve the cmux pane containing this session");
		target = surfaceRef(
			await checked(run, "cmux", [
				"new-surface", "--type", "terminal", "--pane", ownerPane, "--workspace", workspace,
				"--focus", String(request.focus),
			]),
		);
	} else {
		target = surfaceRef(
			await checked(run, "cmux", [
				"new-split", request.direction ?? "right", "--workspace", workspace,
				...(sourceSurface ? ["--surface", sourceSurface] : []),
				"--focus", String(request.focus),
			]),
		);
	}
	await Promise.all([
		checked(run, "cmux", ["rename-tab", "--surface", target, title]),
		checked(run, "cmux", ["respawn-pane", "--surface", target, "--command", command]),
	]);
	if (restore) {
		try {
			await checked(run, "cmux", ["focus-pane", "--pane", restore.pane, "--window", restore.window]);
		} catch {
			// The source may have closed while the fork was starting.
		}
	}
	return { target, terminal: "cmux", placement };
}

async function launchTmux(
	run: Runner,
	env: NodeJS.ProcessEnv,
	request: LaunchRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	const listing = await checked(run, "tmux", [
		"list-panes",
		...(env.TMUX_PANE ? ["-t", env.TMUX_PANE] : []),
		"-F",
		"#{pane_id} #{pane_width} #{pane_height} #{pane_active} #{pane_left} #{pane_top} #{pane_dead}",
	]);
	let sourcePane = env.TMUX_PANE;
	const panes: PaneGeometry[] = [];
	for (const line of listing.split("\n")) {
		const [id, cols, rows, active, left, top, dead] = line.trim().split(/\s+/);
		if (!id || dead === "1") continue;
		const geometry = {
			id, cols: Number(cols), rows: Number(rows),
			left: left === undefined ? undefined : Number(left),
			top: top === undefined ? undefined : Number(top),
		};
		if (!Number.isFinite(geometry.cols) || !Number.isFinite(geometry.rows)) {
			throw new Error(`unexpected tmux list-panes line: ${line}`);
		}
		panes.push(geometry);
		if (!sourcePane && active === "1") sourcePane = id;
	}
	if (!sourcePane) throw new Error("tmux list-panes returned no active pane");
	const plan = planPlacement(request, sourcePane, panes, placementLimits(env), DEFAULT_CELL_ASPECT, request.sidePanes);
	const command = argv.map(shQuote).join(" ");
	const args =
		plan.placement === "tab"
			? [
					"new-window", "-P", "-F", "#{pane_id}", "-c", cwd, "-n", title,
					...(env.TMUX_PANE ? ["-t", `${env.TMUX_PANE}:`] : []),
					...(!request.focus ? ["-d"] : []),
					command,
				]
			: [
					"split-window", "-P", "-F", "#{pane_id}", "-c", cwd, "-t", plan.pane,
					...(plan.direction === "left" || plan.direction === "right" ? ["-h"] : []),
					...(plan.direction === "left" || plan.direction === "up" ? ["-b"] : []),
					...(!request.focus ? ["-d"] : []),
					command,
				];
	const target = await checked(run, "tmux", args);
	return { target, terminal: "tmux", placement: plan.placement };
}

interface TernBlock {
	id: number;
	cols?: number;
	rows?: number;
	live?: boolean;
	exited?: unknown;
	/** Set on picture-in-picture panes, which float over the tiled layout. */
	pip?: unknown;
}

interface TernTab {
	blocks?: TernBlock[];
}

interface TernSession {
	id: number;
	tabs?: TernTab[];
}

/** A pane as a window draws it; `width` and `height` are its pixel size. */
interface TernPane {
	pane: number;
	cols: number;
	rows: number;
	width: number;
	height: number;
}

function ternBlockId(output: string): number {
	const parsed: unknown = JSON.parse(output);
	const block = parsed && typeof parsed === "object" && "block" in parsed ? parsed.block : undefined;
	if (typeof block !== "number") throw new Error(`unexpected tern output: ${output}`);
	return block;
}

/**
 * Tern's CLI leaves focus where it is for both `split` and `new tab`, so `--bg` needs no
 * restore step and a focused fork is one explicit `tern focus`. `split` only goes right or
 * down; left and up are a right/down split followed by `move`. Picture-in-picture panes float
 * over the layout, so they are neither split candidates nor counted against it. The source
 * pane's pixel size gives the real cell shape for comparing split directions.
 */
async function launchTern(
	run: Runner,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	request: LaunchRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	const sourcePane = Number.parseInt(env.TERN_PANE ?? "", 10);
	if (!Number.isFinite(sourcePane)) throw new Error("TERN_PANE is invalid");
	const tern = resolveTern(env, platform);
	const tree = JSON.parse(await checked(run, tern, ["inspect", "--json"])) as {
		sessions?: TernSession[];
		panes?: TernPane[];
	};
	let session: TernSession | undefined;
	let tab: TernTab | undefined;
	for (const candidate of tree.sessions ?? []) {
		tab = candidate.tabs?.find((t) => t.blocks?.some((block) => block.id === sourcePane));
		if (tab) {
			session = candidate;
			break;
		}
	}
	if (!session || !tab) throw new Error(`Tern block ${sourcePane} was not returned by tern inspect`);
	const tiled: PaneGeometry[] = (tab.blocks ?? [])
		.filter((block) =>
			block.pip == null && block.live !== false && block.exited == null &&
			typeof block.cols === "number" && typeof block.rows === "number",
		)
		.map((block) => ({ id: String(block.id), cols: block.cols as number, rows: block.rows as number }));
	const pixels = tree.panes?.find((pane) => pane.pane === sourcePane);
	const aspect =
		(pixels && cellAspect(pixels.cols, pixels.rows, pixels.width, pixels.height)) ?? DEFAULT_CELL_ASPECT;
	const plan = planPlacement(
		request, String(sourcePane), tiled, placementLimits(env), aspect,
		request.sidePanes?.map(target => target.replace(/^block:/, "")),
	);
	const launch = ["--json", "--cwd", cwd, "--", ...argv];
	let target: number;
	if (plan.placement === "tab") {
		target = ternBlockId(await checked(run, tern, ["new", "tab", String(session.id), ...launch]));
		await checked(run, tern, ["rename", String(target), title]);
	} else {
		const horizontal = plan.direction === "left" || plan.direction === "right";
		target = ternBlockId(await checked(run, tern, ["split", plan.pane, horizontal ? "right" : "down", ...launch]));
		if (plan.direction === "left" || plan.direction === "up") {
			await checked(run, tern, ["move", String(target), plan.direction === "left" ? "left-of" : "above", plan.pane]);
		}
	}
	if (request.focus) await checked(run, tern, ["focus", String(target)]);
	return { target: `block:${target}`, terminal: "tern", placement: plan.placement };
}

interface WezPane {
	pane_id: number;
	tab_id: number;
	size?: { cols: number; rows: number };
}

async function launchWezTerm(
	run: Runner,
	env: NodeJS.ProcessEnv,
	request: LaunchRequest,
	cwd: string,
	argv: string[],
): Promise<LaunchResult> {
	const sourcePane = Number.parseInt(env.WEZTERM_PANE ?? "", 10);
	if (!Number.isFinite(sourcePane)) throw new Error("WEZTERM_PANE is invalid");
	const panes = JSON.parse(await checked(run, "wezterm", ["cli", "list", "--format", "json"])) as WezPane[];
	const source = panes.find((pane) => pane.pane_id === sourcePane);
	if (!source) throw new Error(`WezTerm pane ${sourcePane} was not returned by wezterm cli list`);
	const tabPanes: PaneGeometry[] = panes
		.filter((pane) => pane.tab_id === source.tab_id && pane.size)
		.map((pane) => ({ id: String(pane.pane_id), cols: pane.size?.cols ?? 0, rows: pane.size?.rows ?? 0 }));
	const plan = planPlacement(request, String(sourcePane), tabPanes, placementLimits(env), DEFAULT_CELL_ASPECT, request.sidePanes);
	const args =
		plan.placement === "tab"
			? ["cli", "spawn", "--pane-id", String(sourcePane), "--cwd", cwd, "--", ...argv]
			: ["cli", "split-pane", `--${plan.direction}`, "--pane-id", plan.pane, "--cwd", cwd, "--", ...argv];
	const target = await checked(run, "wezterm", args);
	if (!request.focus) {
		try {
			await checked(run, "wezterm", ["cli", "activate-pane", "--pane-id", String(sourcePane)]);
		} catch {
			// The source may have closed while the fork was starting.
		}
	}
	return { target, terminal: "wezterm", placement: plan.placement };
}

interface KittyWindow {
	id: number;
}

interface KittyTab {
	windows?: KittyWindow[];
}

interface KittyOsWindow {
	tabs?: KittyTab[];
}

async function launchKitty(
	run: Runner,
	env: NodeJS.ProcessEnv,
	request: LaunchRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	const sourceWindow = Number.parseInt(env.KITTY_WINDOW_ID ?? "", 10);
	if (!Number.isFinite(sourceWindow)) throw new Error("KITTY_WINDOW_ID is invalid");
	const executable = resolveOnPath(["kitten", "kitty"], env.PATH);
	const osWindows = JSON.parse(await checked(run, executable, ["@", "ls"])) as KittyOsWindow[];
	const sourceTab = osWindows
		.flatMap((osWindow) => osWindow.tabs ?? [])
		.find((tab) => tab.windows?.some((window) => window.id === sourceWindow));
	if (!sourceTab) throw new Error(`Kitty window ${sourceWindow} was not returned by kitten @ ls`);
	const placement = choosePlacement(request.placement, sourceTab.windows?.length ?? 1);
	const args = [
		"@", "launch", "--match", `id:${sourceWindow}`,
		"--type", placement === "tab" ? "tab" : "window",
		"--cwd", cwd,
		...(placement === "tab" ? ["--tab-title", title] : ["--title", title]),
		...(!request.focus ? ["--keep-focus"] : []),
		...(placement === "split"
			? ["--location", request.direction === "up" || request.direction === "down" ? "hsplit" : "vsplit"]
			: []),
		...argv,
	];
	const target = await checked(run, executable, args);
	return { target: target || `kitty:${sourceWindow}`, terminal: "kitty", placement };
}

async function launchGhostty(
	run: Runner,
	platform: NodeJS.Platform,
	cwd: string,
	argv: string[],
): Promise<LaunchResult> {
	if (platform === "darwin") {
		await checked(run, "/usr/bin/open", ["-na", "Ghostty.app", "--args", `--working-directory=${cwd}`, "-e", ...argv]);
	} else {
		await checked(run, "ghostty", [`--working-directory=${cwd}`, "-e", ...argv]);
	}
	return { target: "Ghostty window", terminal: "ghostty", placement: "window" };
}

/** Opens `argv` (whose first element is `executable`) beside the pane named by `env`. */
export async function launchInTerminal(
	run: Runner,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	request: LaunchRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	const command = commandWithRuntimePath(argv, env.PATH, argv[0]);
	switch (detectTerminal(env)) {
		case "cmux":
			return launchCmux(run, env, request, cwd, command, title);
		case "tmux":
			return launchTmux(run, env, request, cwd, command, title);
		case "tern":
			return launchTern(run, env, platform, request, cwd, command, title);
		case "wezterm":
			return launchWezTerm(run, env, request, cwd, command);
		case "kitty":
			return launchKitty(run, env, request, cwd, command, title);
		case "ghostty":
			return launchGhostty(run, platform, cwd, command);
		default:
			throw new Error(
				"unsupported terminal: use cmux, tmux, Tern, WezTerm, Kitty, or Ghostty (direct Ghostty opens a new window)",
			);
	}
}

export function paneTitle(prompt: string): string {
	const flat = prompt.replace(/\s+/g, " ").trim();
	if (!flat) return "⑂ side";
	return `⑂ ${flat.length <= 40 ? flat : `${flat.slice(0, 39)}…`}`;
}
