--!strict
-- side, window half: one command that forks the Claude Code or Codex session
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

-- `tern` commands act on one window's sessions and a plugin cannot read its own
-- window key, so ask each window in turn for the block; ids are unique across
-- windows, so only the window that owns it answers. That key is then handed to
-- `side`, whose `tern` calls inherit it.
local function fork(cx: WindowCx)
	local pane = cx.session:focused()
	if pane == nil then
		cx:toast("error", "Side", "No focused pane")
		return
	end
	local id = tostring(pane)
	run({ "tern", "inspect", "--json" }, {}, function(listed, cx1)
		local ui = cx1 or cx
		if listed.status ~= 0 then
			ui:toast("error", "Side: cannot list Tern windows", failure(listed))
			return
		end
		local ok, tree = pcall(tern.json.decode, listed.stdout)
		local windows: { string } = {}
		if ok and type(tree) == "table" and type(tree.clients) == "table" then
			for _, client in tree.clients do
				if type(client) == "table" and client.kind == "window" and type(client.conn) == "number" then
					table.insert(windows, tostring(client.conn))
				end
			end
		end
		local last: ProcessResult? = nil
		local function try(index: number, view: WindowCx)
			local key = windows[index]
			if key == nil then
				view:toast("error", "Side: cannot read the pane's process", last and failure(last) or "no Tern window")
				return
			end
			run({ "tern", "process", id, "--json", "--window", key }, {}, function(found, cx2)
				local here = cx2 or view
				if found.status ~= 0 then
					last = found
					try(index + 1, here)
					return
				end
				local decoded, info = pcall(tern.json.decode, found.stdout)
				local child = decoded and type(info) == "table" and info.child or nil
				if type(child) ~= "table" or type(child.pid) ~= "number" then
					here:toast("error", "Side", "The focused pane runs no process")
					return
				end
				run(
					{ "side", "--pane-pid", tostring(child.pid) },
					{ "TERM_PROGRAM=tern", "TERN_PANE=" .. id, "TERN_WINDOW_KEY=" .. key },
					function(result, cx3)
						finish(cx3 or here, result)
					end
				)
			end)
		end
		try(1, ui)
	end)
end

tern.command({
	id = "fork",
	title = "Fork this agent session beside it",
	icon = "sparkle",
	keys = { "ctrl+alt+shift+s" },
	run = fork,
})
