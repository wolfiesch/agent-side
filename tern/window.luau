--!strict
-- side, window half: one command that forks the Claude Code, Codex, or omp session
-- in the focused pane into a pane beside it, through the `side` CLI. It works
-- while the agent is busy, since nothing is typed into the agent's pane.

local HOME = tern.getenv("HOME") or ""

-- Tern's own environment is the app's, which a Finder or Dock launch leaves
-- without the user's shell PATH; these are where `side`, `bun` and `tern` live.
local EXTRA_PATH = {
	HOME .. "/.bun/bin",
	HOME .. "/.local/bin",
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/Applications/Tern.app/Contents/MacOS",
	"/usr/bin",
	"/bin",
}

local function search_path(): string
	local parts = {}
	local inherited = tern.getenv("PATH")
	if inherited and inherited ~= "" then
		table.insert(parts, inherited)
	end
	for _, dir in EXTRA_PATH do
		table.insert(parts, dir)
	end
	return table.concat(parts, ":")
end

-- Runs `argv` through env(1) with PATH set, so the program itself is found on it.
local function run(argv: { string }, env: { string }, done: (ProcessResult, WindowCx?) -> ())
	local full = { "/usr/bin/env", "PATH=" .. search_path() }
	for _, assignment in env do
		table.insert(full, assignment)
	end
	for _, arg in argv do
		table.insert(full, arg)
	end
	tern.process.run(full, { timeout_ms = 30000 }, done)
end

local function failure(result: ProcessResult): string
	local text = result.stderr ~= "" and result.stderr or result.stdout
	text = string.gsub(text, "^side: ", "")
	text = string.gsub(text, "%s+$", "")
	if result.timed_out then
		return "timed out"
	end
	return text ~= "" and text or ("exit " .. tostring(result.status))
end

local function finish(ui: WindowCx, result: ProcessResult)
	if result.status == 0 then
		ui:toast("success", "Side", (string.gsub(string.gsub(result.stdout, "^side: ", ""), "%s+$", "")))
	else
		ui:toast("error", "Side failed", failure(result))
	end
end

-- The pane `side` should fork, as the `tern` CLI names it.
type Target = { key: string?, block: string, pid: number }

-- `tern` CLI arguments for one window: `--window KEY`, or none for the first window.
local function in_window(argv: { string }, key: string?): { string }
	if key ~= nil then
		table.insert(argv, "--window")
		table.insert(argv, key)
	end
	return argv
end

-- What this window shows, to recognise it in a `tern inspect` tree.
type Shown = { session: number, position: number, tabs: number }

-- A window `tern inspect` describes that matches `shown`: the focused block of
-- its shown tab, and whether its session id matched too.
type Match = { block: number, exact: boolean }

-- A window key, nil for the first window, and what that window shows.
type Found = { key: string?, match: Match }

local function match_window(tree: any, shown: Shown): Match?
	if type(tree) ~= "table" or type(tree.sessions) ~= "table" then
		return nil
	end
	for _, s in tree.sessions do
		if type(s) == "table" and s.shown == true and type(s.tabs) == "table" then
			if #s.tabs ~= shown.tabs then
				return nil
			end
			for _, tab in s.tabs do
				if type(tab) == "table" and tab.shown == true then
					if tab.number ~= shown.position or type(tab.blocks) ~= "table" then
						return nil
					end
					local block: number? = nil
					for _, b in tab.blocks do
						if type(b) == "table" and b.focused == true and type(b.id) == "number" then
							block = b.id
						end
					end
					local only = tab.blocks[1]
					if block == nil and #tab.blocks == 1 and type(only) == "table" and type(only.id) == "number" then
						block = only.id
					end
					return block and { block = block, exact = s.id == shown.session } or nil
				end
			end
			return nil
		end
	end
	return nil
end

-- Finds the focused pane as the `tern` CLI sees it. Pane and tab ids in a window
-- are local to its replica, and session ids agree only for sessions older than
-- the window, so the CLI cannot be handed the window's ids. The pressed key went
-- to the focused pane of the tab this window shows, which the CLI also reports
-- per window; what remains is choosing the window. CLI commands act on one window,
-- picked by `--window KEY`, and a plugin cannot read its own key, so every key a
-- pane shell carries in TERN_WINDOW_KEY is tried, then the first window, and the
-- one showing the same session, tab position and tab count wins.
local function locate(cx: WindowCx, done: (WindowCx, string?, Target?) -> ())
	local pane = cx.session:focused()
	if pane == nil then
		done(cx, "No focused pane")
		return
	end
	local shown: Shown? = nil
	for _, tab in cx.session:tabs() do
		if tab.pane == pane then
			shown = { session = tab.session, position = tab.position, tabs = 0 }
		end
	end
	if shown == nil then
		done(cx, "The focused pane is in no tab")
		return
	end
	local want = shown :: Shown
	for _, tab in cx.session:tabs() do
		if tab.session == want.session then
			want.tabs += 1
		end
	end
	tern.process.run({ "/bin/ps", "-A", "-ww", "-E", "-o", "command=" }, { timeout_ms = 10000 }, function(ps, cx1)
		local keys: { string } = {}
		local seen: { [string]: boolean } = {}
		for key in string.gmatch(ps.stdout, "TERN_WINDOW_KEY=(%S+)") do
			if not seen[key] then
				seen[key] = true
				table.insert(keys, key)
			end
		end
		local count = #keys
		local found: { Found } = {}
		local function decide(view: WindowCx)
			local exact: { Found }, loose: { Found } = {}, {}
			local blocks: { [number]: boolean } = {}
			for _, f in found do
				if not blocks[f.match.block] then
					blocks[f.match.block] = true
					if f.match.exact then
						table.insert(exact, f)
					else
						table.insert(loose, f)
					end
				end
			end
			local pick: Found
			if #exact == 1 then
				pick = exact[1]
			elseif #exact == 0 and #loose == 1 then
				pick = loose[1]
			else
				done(view, #found == 0 and "No Tern window shows this tab" or "Several Tern windows show the same tab position")
				return
			end
			local id = string.format("%d", pick.match.block)
			run(in_window({ "tern", "process", id, "--json" }, pick.key), {}, function(result, cx3)
				local there = cx3 or view
				if result.status ~= 0 then
					done(there, failure(result))
					return
				end
				local decoded, proc = pcall(tern.json.decode, result.stdout)
				local child = decoded and type(proc) == "table" and proc.child or nil
				if type(child) ~= "table" or type(child.pid) ~= "number" then
					done(there, "The focused pane runs no process")
					return
				end
				done(there, nil, { key = pick.key, block = id, pid = child.pid })
			end)
		end
		-- Index count + 1 is the first window, with no --window.
		local function try(index: number, view: WindowCx)
			if index > count + 1 then
				decide(view)
				return
			end
			local key: string? = keys[index]
			run(in_window({ "tern", "inspect", "--json" }, key), {}, function(listed, cx2)
				local ok, tree = pcall(tern.json.decode, listed.stdout)
				local match = listed.status == 0 and ok and match_window(tree, want) or nil
				if match then
					table.insert(found, { key = key, match = match })
				end
				try(index + 1, cx2 or view)
			end)
		end
		try(1, cx1 or cx)
	end)
end

local function fork(cx: WindowCx)
	locate(cx, function(ui, err, target)
		if target == nil then
			ui:toast("error", "Side: cannot find the pane's process", err or "")
			return
		end
		local env = { "TERM_PROGRAM=tern", "TERN_PANE=" .. target.block }
		if target.key ~= nil then
			table.insert(env, "TERN_WINDOW_KEY=" .. target.key)
		end
		run({ "side", "--pane-pid", string.format("%d", target.pid) }, env, function(result, cx2)
			finish(cx2 or ui, result)
		end)
	end)
end

tern.command({
	id = "fork",
	title = "Fork this agent session beside it",
	icon = "sparkle",
	keys = { "ctrl+alt+shift+s" },
	run = fork,
})
