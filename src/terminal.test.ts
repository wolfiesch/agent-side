import { describe, expect, test } from "bun:test";
import {
	choosePlacement,
	cmuxLayout,
	commandWithRuntimePath,
	detectTerminal,
	launchInTerminal,
	paneTitle,
	pathWithExecutableDir,
	placementLimits,
	planPlacement,
	shQuote,
	type Direction,
	type ExecOutput,
	type LaunchRequest,
	type PaneGeometry,
	type PlacementPlan,
} from "./terminal";

interface Call {
	command: string;
	args: string[];
}

function runner(respond: (command: string, args: string[]) => { code?: number; stdout?: string; stderr?: string }): {
	calls: Call[];
	run: (command: string, args: string[]) => Promise<ExecOutput>;
} {
	const calls: Call[] = [];
	return {
		calls,
		run: async (command, args) => {
			calls.push({ command, args });
			const result = respond(command, args);
			return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		},
	};
}

const baseRequest: LaunchRequest = { focus: true, placement: "auto" };

const hostileArg = "a path/'quote'/$HOME; still one argument";
const argv = ["/opt/bin/claude", "--resume", "session's id", "--fork-session", hostileArg];

describe("repeat fork placement", () => {
	const limits = { cols: 80, rows: 30 };
	const auto = { placement: "auto" as const };

	test("stacks below an existing fork without dividing a roomy parent again", () => {
		const panes = [{ id: "parent", cols: 240, rows: 120 }, { id: "fork", cols: 200, rows: 120 }];
		expect(planPlacement(auto, "parent", panes, limits, 2, ["fork"])).toEqual({
			placement: "split", pane: "fork", direction: "down",
		});
	});

	test("uses another member of the group when the newest fork cannot stack", () => {
		const panes = [
			{ id: "parent", cols: 240, rows: 120 },
			{ id: "older", cols: 120, rows: 90 },
			{ id: "newer", cols: 120, rows: 40 },
		];
		expect(planPlacement(auto, "parent", panes, limits, 2, ["newer", "older"])).toEqual({
			placement: "split", pane: "older", direction: "down",
		});
	});

	test("opens a tab when the side group is full even if the parent has space", () => {
		const panes = [{ id: "parent", cols: 240, rows: 120 }, { id: "fork", cols: 200, rows: 60 }];
		expect(planPlacement(auto, "parent", panes, limits, 2, ["fork"])).toEqual({ placement: "tab" });
	});

	test("ignores closed, moved-to-another-tab, and self targets", () => {
		const panes = [{ id: "parent", cols: 240, rows: 80 }];
		expect(planPlacement(auto, "parent", panes, limits, 2, ["missing", "parent"])).toEqual({
			placement: "split", pane: "parent", direction: "right",
		});
	});

	test("explicit placement overrides automatic grouping", () => {
		const panes = [{ id: "parent", cols: 240, rows: 120 }, { id: "fork", cols: 200, rows: 120 }];
		const requests: Array<Pick<LaunchRequest, "placement" | "direction">> = [
			{ placement: "split" },
			{ placement: "split", direction: "left" },
		];
		for (const request of requests) {
			expect(planPlacement(request, "parent", panes, limits, 2, ["fork"])).toEqual({
				placement: "split", pane: "parent", direction: request.direction ?? "right",
			});
		}
		expect(planPlacement({ placement: "tab" }, "parent", panes, limits, 2, ["fork"])).toEqual({ placement: "tab" });
	});
});

describe("neighbor-aware fallback", () => {
	const limits = { cols: 80, rows: 30 };
	const auto = { placement: "auto" as const };

	test("prefers a fitting edge neighbor over a larger distant pane", () => {
		const panes = [
			{ id: "source", cols: 80, rows: 40, left: 0, top: 0 },
			{ id: "near", cols: 170, rows: 40, left: 81, top: 0 },
			{ id: "far", cols: 400, rows: 120, left: 252, top: 0 },
		];
		expect(planPlacement(auto, "source", panes, limits, 2)).toEqual({
			placement: "split", pane: "near", direction: "right",
		});
	});

	test("recognizes vertical adjacency and rejects corner-only contact", () => {
		const panes = [
			{ id: "source", cols: 100, rows: 40, left: 0, top: 0 },
			{ id: "corner", cols: 400, rows: 120, left: 101, top: 41 },
			{ id: "below", cols: 100, rows: 90, left: 0, top: 41 },
		];
		expect(planPlacement(auto, "source", panes, limits, 2)).toEqual({
			placement: "split", pane: "below", direction: "down",
		});
	});

	test("tries distant panes when neighbors do not fit the requested axis", () => {
		const panes = [
			{ id: "source", cols: 100, rows: 40, left: 0, top: 0 },
			{ id: "near", cols: 100, rows: 90, left: 101, top: 0 },
			{ id: "far", cols: 220, rows: 90, left: 202, top: 0 },
		];
		expect(planPlacement({ placement: "split", direction: "left" }, "source", panes, limits, 2)).toEqual({
			placement: "split", pane: "far", direction: "left",
		});
	});
});

describe("terminal detection", () => {
	test("prefers an inner multiplexer over its host emulator", () => {
		expect(detectTerminal({ TMUX: "/tmp/tmux", KITTY_WINDOW_ID: "4" })).toBe("tmux");
		expect(detectTerminal({ CMUX_WORKSPACE_ID: "workspace:1", TMUX: "/tmp/tmux" })).toBe("cmux");
	});

	test("prefers tmux running inside a Tern pane", () => {
		expect(detectTerminal({ TMUX: "/tmp/tmux", TERM_PROGRAM: "tern", TERN_PANE: "9" })).toBe("tmux");
	});

	test("recognizes direct terminal integrations", () => {
		expect(detectTerminal({ WEZTERM_PANE: "2" })).toBe("wezterm");
		expect(detectTerminal({ KITTY_WINDOW_ID: "3" })).toBe("kitty");
		expect(detectTerminal({ TERM_PROGRAM: "ghostty" })).toBe("ghostty");
		expect(detectTerminal({ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty" })).toBe("ghostty");
		expect(detectTerminal({ TERM_PROGRAM: "tern", TERN_PANE: "9" })).toBe("tern");
	});

	test("Tern needs a pane id and no signal means no terminal", () => {
		expect(detectTerminal({ TERM_PROGRAM: "tern" })).toBeNull();
		expect(detectTerminal({})).toBeNull();
	});
});

describe("child command PATH", () => {
	test("prepends the active runtime directory once", () => {
		expect(pathWithExecutableDir("/usr/bin:/bin", "/opt/runtime/bin/bun")).toBe("/opt/runtime/bin:/usr/bin:/bin");
		expect(pathWithExecutableDir("/opt/runtime/bin:/usr/bin", "/opt/runtime/bin/bun")).toBe("/opt/runtime/bin:/usr/bin");
		expect(pathWithExecutableDir("", "/opt/runtime/bin/bun")).toBe("/opt/runtime/bin");
		expect(pathWithExecutableDir(undefined, "/opt/runtime/bin/bun")).toBeUndefined();
	});

	test("wraps the command in env only when the caller has a PATH", () => {
		expect(commandWithRuntimePath(["/opt/bin/claude", "--x"], "/usr/bin", "/opt/bin/claude")).toEqual([
			"/usr/bin/env", "PATH=/opt/bin:/usr/bin", "/opt/bin/claude", "--x",
		]);
		expect(commandWithRuntimePath(["/opt/bin/claude", "--x"], undefined, "/opt/bin/claude")).toEqual([
			"/opt/bin/claude", "--x",
		]);
	});

	test("quotes embedded single quotes for /bin/sh", () => {
		expect(shQuote("it's")).toBe("'it'\\''s'");
	});
});

describe("automatic placement", () => {
	test("pane-count fallback uses a tab once the current layout already has a split", () => {
		expect(choosePlacement("auto", 2)).toBe("tab");
		expect(choosePlacement("auto", 1)).toBe("split");
		expect(choosePlacement("split", 4)).toBe("split");
		expect(choosePlacement("tab", 1)).toBe("tab");
	});

	const limits = { cols: 80, rows: 30 };
	const aspect = 2;
	const pane = (id: string, cols: number, rows: number): PaneGeometry => ({ id, cols, rows });
	const auto: Pick<LaunchRequest, "placement" | "direction"> = { placement: "auto" };
	const split = (direction?: Direction): Pick<LaunchRequest, "placement" | "direction"> => ({ placement: "split", direction });

	const cases: Array<[string, Pick<LaunchRequest, "placement" | "direction">, PaneGeometry[], PlacementPlan]> = [
		["one wide pane splits beside itself", auto, [pane("s", 288, 85)], { placement: "split", pane: "s", direction: "right" }],
		[
			"a narrow but tall source stacks in place instead of moving to a wider pane",
			auto,
			[pane("s", 107, 93), pane("big", 208, 93)],
			{ placement: "split", pane: "s", direction: "down" },
		],
		[
			"a tall source that fits both ways splits along its roomier axis",
			auto,
			[pane("s", 211, 117)],
			{ placement: "split", pane: "s", direction: "down" },
		],
		[
			"a source too small for any split hands off to the roomiest other pane",
			auto,
			[pane("s", 107, 50), pane("mid", 170, 93), pane("big", 208, 120)],
			{ placement: "split", pane: "big", direction: "down" },
		],
		[
			"two full columns stack below the source before trying other panes",
			auto,
			[pane("s", 142, 85), pane("o", 142, 85)],
			{ placement: "split", pane: "s", direction: "down" },
		],
		[
			"a short source stacks below the largest tall pane",
			auto,
			[pane("s", 142, 40), pane("o", 142, 85)],
			{ placement: "split", pane: "o", direction: "down" },
		],
		["a pane too small for either half opens a tab", auto, [pane("s", 120, 40)], { placement: "tab" }],
		[
			"an explicit direction only searches its own axis",
			split("up"),
			[pane("s", 288, 85)],
			{ placement: "split", pane: "s", direction: "up" },
		],
		[
			"an explicit direction keeps left on another pane",
			split("left"),
			[pane("s", 100, 85), pane("o", 180, 85)],
			{ placement: "split", pane: "o", direction: "left" },
		],
		[
			"a forced split without a fit divides the source in the requested direction",
			split("left"),
			[pane("s", 142, 85), pane("o", 142, 85)],
			{ placement: "split", pane: "s", direction: "left" },
		],
		[
			"--split without a fit divides the source along its roomier axis",
			split(),
			[pane("s", 120, 40)],
			{ placement: "split", pane: "s", direction: "right" },
		],
		[
			"--split without a fit stacks a tall source",
			split(),
			[pane("s", 100, 59)],
			{ placement: "split", pane: "s", direction: "down" },
		],
		["--tab wins over available space", { placement: "tab" }, [pane("s", 288, 85)], { placement: "tab" }],
	];

	test.each(cases)("%s", (_name, request, panes, expected) => {
		expect(planPlacement(request, "s", panes, limits, aspect)).toEqual(expected);
	});

	test("the divider cell counts against each half", () => {
		const plan = (cols: number, rows: number) => planPlacement(auto, "s", [pane("s", cols, rows)], limits, aspect);
		expect(plan(161, 30)).toMatchObject({ direction: "right" });
		expect(plan(160, 30)).toEqual({ placement: "tab" });
		expect(plan(80, 61)).toMatchObject({ direction: "down" });
		expect(plan(80, 60)).toEqual({ placement: "tab" });
	});

	test("minimum pane size comes from the environment and rejects invalid values", () => {
		expect(placementLimits({})).toEqual({ cols: 80, rows: 30 });
		expect(placementLimits({ SIDE_MIN_COLS: "60", SIDE_MIN_ROWS: " 20 " })).toEqual({ cols: 60, rows: 20 });
		expect(() => placementLimits({ SIDE_MIN_COLS: "wide" })).toThrow(/SIDE_MIN_COLS/);
		expect(() => placementLimits({ SIDE_MIN_ROWS: "0" })).toThrow(/SIDE_MIN_ROWS/);
	});

	test("maps a cmux surface back to its owning pane", () => {
		expect(
			cmuxLayout(
				"├── pane pane:4\n│   └── surface surface:8\n└── pane pane:5\n    └── surface surface:9",
				"surface:8",
			),
		).toEqual({ paneCount: 2, ownerPane: "pane:4" });
	});
});

describe("pane title", () => {
	test("flattens whitespace, truncates long prompts, and labels an empty prompt", () => {
		expect(paneTitle("")).toBe("⑂ side");
		expect(paneTitle("  why\n  now?  ")).toBe("⑂ why now?");
		const title = paneTitle("x".repeat(80));
		expect(title).toBe(`⑂ ${"x".repeat(39)}…`);
	});
});

describe("terminal launch adapters", () => {
	test("cmux adds a terminal tab instead of a third split", async () => {
		const parentPath = "/Users/test/.local/bin:/usr/bin:/bin";
		const expectedPath = pathWithExecutableDir(parentPath, argv[0]);
		const fake = runner((_command, args) => {
			if (args.includes("tree")) {
				return {
					stdout:
						"├── pane pane:4 uuid-pane-4\n│   └── surface surface:8 uuid-surface-8\n└── pane pane:5 uuid-pane-5\n    └── surface surface:9 uuid-surface-9",
				};
			}
			if (args[0] === "new-surface") return { stdout: "surface:10" };
			return {};
		});
		const result = await launchInTerminal(
			fake.run,
			{ CMUX_WORKSPACE_ID: "workspace-uuid-2", CMUX_SURFACE_ID: "uuid-surface-8", PATH: parentPath },
			"darwin",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "surface:10", terminal: "cmux", placement: "tab" });
		expect(fake.calls.some((call) => call.args[0] === "new-split")).toBe(false);
		expect(fake.calls.find((call) => call.args[0] === "new-surface")?.args).toContain("pane:4");
		const command = fake.calls.find((call) => call.args[0] === "respawn-pane")?.args.at(-1);
		expect(command).toStartWith("cd '/tmp/a b' && exec '/usr/bin/env'");
		expect(command).toContain(`'PATH=${expectedPath}'`);
		expect(command).toContain("'a path/'\\''quote'\\''/$HOME; still one argument'");
		expect(command).toContain("'session'\\''s id'");
	});

	test("cmux splits the source surface when the workspace has one pane", async () => {
		const fake = runner((_command, args) => {
			if (args.includes("tree")) return { stdout: "└── pane pane:4\n    └── surface surface:8" };
			if (args[0] === "new-split") return { stdout: "surface:10" };
			return {};
		});
		const result = await launchInTerminal(
			fake.run,
			{ CMUX_WORKSPACE_ID: "workspace:2", CMUX_SURFACE_ID: "surface:8" },
			"darwin",
			{ ...baseRequest, direction: "down", placement: "split" },
			"/tmp",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "surface:10", terminal: "cmux", placement: "split" });
		expect(fake.calls.find((call) => call.args[0] === "new-split")?.args).toEqual([
			"new-split", "down", "--workspace", "workspace:2", "--surface", "surface:8", "--focus", "true",
		]);
	});

	test("cmux starts the child without waiting for the tab rename", async () => {
		const renameGate = Promise.withResolvers<void>();
		const renameStarted = Promise.withResolvers<void>();
		let respawnStarted = false;
		const run = async (_command: string, args: string[]): Promise<ExecOutput> => {
			if (args.includes("tree")) {
				return { code: 0, stdout: "└── pane pane:4\n    └── surface surface:8", stderr: "" };
			}
			if (args[0] === "new-surface") {
				return { code: 0, stdout: "surface:10", stderr: "" };
			}
			if (args[0] === "rename-tab") {
				renameStarted.resolve();
				await renameGate.promise;
			}
			if (args[0] === "respawn-pane") {
				respawnStarted = true;
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const launch = launchInTerminal(
			run,
			{ CMUX_WORKSPACE_ID: "workspace:2", CMUX_SURFACE_ID: "surface:8" },
			"darwin",
			{ ...baseRequest, placement: "tab" },
			"/tmp",
			argv,
			"side title",
		);
		await renameStarted.promise;
		expect(respawnStarted).toBe(true);
		renameGate.resolve();
		await launch;
	});

	test("cmux in the background restores focus to the previously focused pane", async () => {
		const fake = runner((_command, args) => {
			if (args.includes("tree")) return { stdout: "└── pane pane:4\n    └── surface surface:8" };
			if (args[0] === "identify") return { stdout: JSON.stringify({ focused: { pane_ref: "pane:4", window_ref: "window:1" } }) };
			if (args[0] === "new-surface") return { stdout: "surface:10" };
			return {};
		});
		await launchInTerminal(
			fake.run,
			{ CMUX_WORKSPACE_ID: "workspace:2", CMUX_SURFACE_ID: "surface:8" },
			"darwin",
			{ ...baseRequest, focus: false, placement: "tab" },
			"/tmp",
			argv,
			"side title",
		);

		expect(fake.calls.find((call) => call.args[0] === "new-surface")?.args).toContain("false");
		expect(fake.calls.at(-1)?.args).toEqual(["focus-pane", "--pane", "pane:4", "--window", "window:1"]);
	});

	test("tmux opens a new window when no pane in the window has room", async () => {
		const fake = runner((_command, args) =>
			args[0] === "list-panes" ? { stdout: "%1 100 40 1\n%2 100 40 0\n" } : { stdout: "%9" },
		);
		const result = await launchInTerminal(
			fake.run,
			{ TMUX: "/tmp/tmux", TMUX_PANE: "%1" },
			"linux",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "%9", terminal: "tmux", placement: "tab" });
		expect(fake.calls[0].args.slice(0, 3)).toEqual(["list-panes", "-t", "%1"]);
		expect(fake.calls[1].args).toEqual([
			"new-window", "-P", "-F", "#{pane_id}", "-c", "/tmp/a b", "-n", "side title", "-t", "%1:",
			argv.map(shQuote).join(" "),
		]);
	});

	test("tmux background tab omits the window target without TMUX_PANE and keeps the child detached", async () => {
		const fake = runner((_command, args) =>
			args[0] === "list-panes" ? { stdout: "%1 100 40 1\n" } : { stdout: "%9" },
		);
		await launchInTerminal(
			fake.run,
			{ TMUX: "/tmp/tmux" },
			"linux",
			{ ...baseRequest, focus: false, placement: "tab" },
			"/tmp",
			argv,
			"side title",
		);

		expect(fake.calls[0].args.includes("-t")).toBe(false);
		expect(fake.calls[1].args).toEqual([
			"new-window", "-P", "-F", "#{pane_id}", "-c", "/tmp", "-n", "side title", "-d",
			argv.map(shQuote).join(" "),
		]);
	});

	test("tmux splits a roomier sibling pane in the background", async () => {
		const fake = runner((_command, args) =>
			args[0] === "list-panes" ? { stdout: "%1 100 60 1\n%2 200 60 0\n" } : { stdout: "%9" },
		);
		const result = await launchInTerminal(
			fake.run,
			{ TMUX: "/tmp/tmux" },
			"linux",
			{ ...baseRequest, focus: false },
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "%9", terminal: "tmux", placement: "split" });
		expect(fake.calls[1].args.slice(0, -1)).toEqual([
			"split-window", "-P", "-F", "#{pane_id}", "-c", "/tmp/a b", "-t", "%2", "-h", "-d",
		]);
	});

	test("tmux splits left with -b and skips dead panes", async () => {
		const fake = runner((_command, args) =>
			args[0] === "list-panes"
				? { stdout: "%1 200 60 1 0 0 0\n%2 400 100 0 201 0 1\n" }
				: { stdout: "%9" },
		);
		const result = await launchInTerminal(
			fake.run,
			{ TMUX: "/tmp/tmux", TMUX_PANE: "%1" },
			"linux",
			{ ...baseRequest, placement: "split", direction: "left" },
			"/tmp",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "%9", terminal: "tmux", placement: "split" });
		expect(fake.calls[1].args.slice(0, -1)).toEqual([
			"split-window", "-P", "-F", "#{pane_id}", "-c", "/tmp", "-t", "%1", "-h", "-b",
		]);
	});

	test("tmux stacks below an existing fork named by sidePanes", async () => {
		const fake = runner((_command, args) =>
			args[0] === "list-panes" ? { stdout: "%1 240 120 1\n%5 200 120 0\n" } : { stdout: "%9" },
		);
		const result = await launchInTerminal(
			fake.run,
			{ TMUX: "/tmp/tmux", TMUX_PANE: "%1" },
			"linux",
			{ ...baseRequest, sidePanes: ["%5"] },
			"/tmp",
			argv,
			"side title",
		);

		expect(result.placement).toBe("split");
		expect(fake.calls[1].args.slice(4, 8)).toEqual(["-c", "/tmp", "-t", "%5"]);
		expect(fake.calls[1].args).not.toContain("-h");
	});

	test("tmux failures surface the command output", async () => {
		const fake = runner((_command, args) =>
			args[0] === "list-panes" ? { stdout: "%1 100 40 1\n" } : { code: 1, stderr: "no space for new pane" },
		);
		await expect(
			launchInTerminal(fake.run, { TMUX: "/tmp/tmux", TMUX_PANE: "%1" }, "linux", baseRequest, "/tmp", argv, "t"),
		).rejects.toThrow("tmux new-window: no space for new pane");
	});

	test("WezTerm splits a roomy single-pane tab with structured command arguments", async () => {
		const fake = runner((_command, args) =>
			args[1] === "list"
				? { stdout: JSON.stringify([{ pane_id: 7, tab_id: 3, size: { cols: 200, rows: 50 } }]) }
				: { stdout: "8" },
		);
		const result = await launchInTerminal(
			fake.run,
			{ WEZTERM_PANE: "7" },
			"linux",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "8", terminal: "wezterm", placement: "split" });
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[1].args).toEqual([
			"cli", "split-pane", "--right", "--pane-id", "7", "--cwd", "/tmp/a b", "--", ...argv,
		]);
	});

	test("WezTerm opens a tab when the current tab is full, then returns focus for a background fork", async () => {
		const fake = runner((_command, args) =>
			args[1] === "list"
				? {
					stdout: JSON.stringify([
						{ pane_id: 7, tab_id: 3, size: { cols: 100, rows: 40 } },
						{ pane_id: 8, tab_id: 3, size: { cols: 100, rows: 40 } },
						{ pane_id: 9, tab_id: 4, size: { cols: 400, rows: 120 } },
					]),
				}
				: { stdout: "10" },
		);
		const result = await launchInTerminal(
			fake.run,
			{ WEZTERM_PANE: "7" },
			"linux",
			{ ...baseRequest, focus: false },
			"/tmp",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "10", terminal: "wezterm", placement: "tab" });
		expect(fake.calls.slice(1).map((call) => call.args)).toEqual([
			["cli", "spawn", "--pane-id", "7", "--cwd", "/tmp", "--", ...argv],
			["cli", "activate-pane", "--pane-id", "7"],
		]);
	});

	test("WezTerm reports a source pane missing from its listing", async () => {
		const fake = runner(() => ({ stdout: JSON.stringify([{ pane_id: 1, tab_id: 1 }]) }));
		await expect(
			launchInTerminal(fake.run, { WEZTERM_PANE: "7" }, "linux", baseRequest, "/tmp", argv, "t"),
		).rejects.toThrow("WezTerm pane 7");
	});

	type TernFixtureBlock = [id: number, cols: number, rows: number, pip?: object];
	type TernFixturePixels = { pane: number; cols: number; rows: number; width: number; height: number };
	const ternTree = (blocks: TernFixtureBlock[], panes: TernFixturePixels[] = []) =>
		JSON.stringify({
			sessions: [
				{ id: 1, tabs: [{ blocks: [{ id: 2, cols: 300, rows: 90 }] }] },
				{
					id: 40,
					tabs: [{ blocks: blocks.map(([id, cols, rows, pip]) => ({ id, cols, rows, pip: pip ?? null })) }],
				},
			],
			panes,
		});

	const ternPixelCases: Array<[string, TernFixturePixels[], string]> = [
		["without pixel data the default 2:1 cell splits side by side", [], "right"],
		[
			"tall 8x17 px cells make the same pane taller on screen, so it stacks",
			[{ pane: 41, cols: 200, rows: 100, width: 1600, height: 1700 }],
			"down",
		],
	];

	test.each(ternPixelCases)("Tern uses the source pane's pixel size: %s", async (_name, pixels, direction) => {
		const fake = runner((_command, args) =>
			args[0] === "inspect"
				? { stdout: ternTree([[41, 200, 100]], pixels) }
				: args[0] === "split"
					? { stdout: JSON.stringify({ session: 40, tab: 50, block: 42 }) }
					: {},
		);
		await launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "tern", TERN_PANE: "41" },
			"linux",
			{ ...baseRequest, focus: false },
			"/tmp",
			argv,
			"side title",
		);
		expect(fake.calls[1].args.slice(0, 3)).toEqual(["split", "41", direction]);
	});

	test("Tern splits a single-pane tab to the left, then focuses the fork", async () => {
		const fake = runner((_command, args) =>
			args[0] === "inspect"
				? { stdout: ternTree([[41, 288, 85]]) }
				: args[0] === "split"
					? { stdout: JSON.stringify({ session: 40, tab: 50, block: 42 }) }
					: {},
		);
		const result = await launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "tern", TERN_PANE: "41" },
			"linux",
			{ ...baseRequest, direction: "left" },
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "block:42", terminal: "tern", placement: "split" });
		expect(fake.calls.slice(1).map((call) => call.args)).toEqual([
			["split", "41", "right", "--json", "--cwd", "/tmp/a b", "--", ...argv],
			["move", "42", "left-of", "41"],
			["focus", "42"],
		]);
	});

	test("Tern opens a background tab in the source session when no pane has room", async () => {
		const fake = runner((_command, args) =>
			args[0] === "inspect"
				? { stdout: ternTree([[41, 100, 40], [43, 100, 40]]) }
				: args[0] === "new"
					? { stdout: JSON.stringify({ session: 40, tab: 51, block: 44 }) }
					: {},
		);
		const result = await launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "tern", TERN_PANE: "41" },
			"linux",
			{ ...baseRequest, focus: false },
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "block:44", terminal: "tern", placement: "tab" });
		expect(fake.calls.slice(1).map((call) => call.args)).toEqual([
			["new", "tab", "40", "--json", "--cwd", "/tmp/a b", "--", ...argv],
			["rename", "44", "side title"],
		]);
	});

	test("Tern splits a wide sibling when the source is too small and ignores picture-in-picture panes", async () => {
		const fake = runner((_command, args) =>
			args[0] === "inspect"
				? { stdout: ternTree([[41, 107, 50], [43, 208, 93], [45, 300, 90, { owner: 43, corner: "br" }]]) }
				: args[0] === "split"
					? { stdout: JSON.stringify({ session: 40, tab: 50, block: 46 }) }
					: {},
		);
		const result = await launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "tern", TERN_PANE: "41" },
			"linux",
			{ ...baseRequest, focus: false },
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "block:46", terminal: "tern", placement: "split" });
		expect(fake.calls.slice(1).map((call) => call.args)).toEqual([
			["split", "43", "right", "--json", "--cwd", "/tmp/a b", "--", ...argv],
		]);
	});

	test("Tern stacks below an earlier fork given as a block target", async () => {
		const fake = runner((_command, args) =>
			args[0] === "inspect"
				? { stdout: ternTree([[41, 240, 120], [43, 200, 120]]) }
				: args[0] === "split"
					? { stdout: JSON.stringify({ session: 40, tab: 50, block: 44 }) }
					: {},
		);
		await launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "tern", TERN_PANE: "41" },
			"linux",
			{ ...baseRequest, focus: false, sidePanes: ["block:43"] },
			"/tmp",
			argv,
			"side title",
		);
		expect(fake.calls[1].args.slice(0, 3)).toEqual(["split", "43", "down"]);
	});

	test("Tern reports a source block missing from tern inspect", async () => {
		const fake = runner(() => ({ stdout: ternTree([[43, 100, 40]]) }));
		await expect(
			launchInTerminal(fake.run, { TERM_PROGRAM: "tern", TERN_PANE: "41" }, "linux", baseRequest, "/tmp", argv, "t"),
		).rejects.toThrow("Tern block 41");
	});

	test("Kitty opens a new tab and preserves each command argument", async () => {
		const fake = runner((_command, args) =>
			args[1] === "ls"
				? { stdout: JSON.stringify([{ tabs: [{ windows: [{ id: 11 }, { id: 12 }] }] }]) }
				: { stdout: "13" },
		);
		const result = await launchInTerminal(
			fake.run,
			{ KITTY_WINDOW_ID: "11", PATH: "/missing" },
			"linux",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "13", terminal: "kitty", placement: "tab" });
		expect(fake.calls[1].args.slice(-argv.length)).toEqual(argv);
		expect(fake.calls[1].args.slice(0, 7)).toEqual([
			"@", "launch", "--match", "id:11", "--type", "tab", "--cwd",
		]);
	});

	test("Kitty splits a lone window with the direction's axis and keeps focus in the background", async () => {
		const fake = runner((_command, args) =>
			args[1] === "ls"
				? { stdout: JSON.stringify([{ tabs: [{ windows: [{ id: 11 }] }] }]) }
				: { stdout: "" },
		);
		const result = await launchInTerminal(
			fake.run,
			{ KITTY_WINDOW_ID: "11", PATH: "/missing" },
			"linux",
			{ ...baseRequest, focus: false, direction: "down", placement: "split" },
			"/tmp",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "kitty:11", terminal: "kitty", placement: "split" });
		const args = fake.calls[1].args;
		expect(args).toContain("--keep-focus");
		expect(args[args.indexOf("--location") + 1]).toBe("hsplit");
		expect(args[args.indexOf("--type") + 1]).toBe("window");
	});

	test("direct Ghostty preserves PATH without shell interpolation", async () => {
		const parentPath = "/Users/a path/'quote'/$HOME:/usr/bin";
		const expectedPath = pathWithExecutableDir(parentPath, argv[0]);
		const fake = runner(() => ({}));
		const result = await launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "ghostty", PATH: parentPath },
			"darwin",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result.placement).toBe("window");
		expect(fake.calls[0]).toEqual({
			command: "/usr/bin/open",
			args: [
				"-na", "Ghostty.app", "--args", "--working-directory=/tmp/a b", "-e",
				"/usr/bin/env", `PATH=${expectedPath}`, ...argv,
			],
		});
	});

	test("direct Ghostty leaves its default environment when PATH is absent", async () => {
		const fake = runner(() => ({}));
		await launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "ghostty" },
			"darwin",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(fake.calls[0].args).toEqual(["-na", "Ghostty.app", "--args", "--working-directory=/tmp/a b", "-e", ...argv]);
	});

	test("Ghostty on Linux launches its own binary", async () => {
		const fake = runner(() => ({}));
		await launchInTerminal(fake.run, { TERM_PROGRAM: "ghostty" }, "linux", baseRequest, "/tmp", argv, "t");
		expect(fake.calls[0]).toEqual({ command: "ghostty", args: ["--working-directory=/tmp", "-e", ...argv] });
	});

	test("an unrecognized terminal is an error", async () => {
		const fake = runner(() => ({}));
		await expect(launchInTerminal(fake.run, {}, "linux", baseRequest, "/tmp", argv, "t")).rejects.toThrow(
			"unsupported terminal",
		);
		expect(fake.calls).toEqual([]);
	});
});
