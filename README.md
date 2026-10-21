# side

Fork the Claude Code or Codex session you are in, at this exact point, into a nearby terminal pane. Ask the tangent there. Your main thread stays clean.

```
!side why would that cache miss?
```

The fork is a real session created by the agent's own fork command (`claude --resume <id> --fork-session`, `codex fork <id>`): it gets the whole transcript and its own session file, and nothing it does reaches the original conversation.

Placement comes from [omp-side](https://github.com/wolfiesch/omp-side), the `/side` command for Oh My Pi, with launch adapters for tmux, [Tern](https://stencil.so/tern), WezTerm, Kitty, [cmux](https://cmux.com), and Ghostty.

## Requirements

- [Bun](https://bun.sh)
- Claude Code or Codex
- One supported terminal: tmux, Tern, WezTerm (`wezterm cli`), Kitty (remote control through `kitten @`), cmux, or Ghostty
- macOS or Linux

## Install

From a checkout:

```sh
cd agent-side && bun install && bun link
```

`bun link` puts `side` on your `PATH`.

## Usage

From inside the agent, use its shell escape:

```
!side <prompt>                         fork and ask, placed automatically
!side --bg -- '<prompt>'               open without taking focus
!side --tab -- '<prompt>'              force a new tab
!side --down -- '<prompt>'             split below only
!side --model sonnet -- '<prompt>'     fork with a different model
```

Quote prompts that contain `?`, `*`, or quotes. The agent's shell expands them otherwise.

| Flag | Effect |
|---|---|
| `--bg` | Keep focus here. |
| `--tab` | New tab. In tmux, a new window. |
| `--split` | Split even when no pane meets the minimum size. |
| `--left` `--right` `--up` `--down` | Split in that direction only. |
| `--harness claude\|codex` | Choose the agent when it cannot be detected. |
| `--session <id>` | Fork that session id. |
| `--pane-pid <pid>` | Fork the agent running under that pane's shell. |
| `--pid <pid>` | Fork the session of that agent process. |
| `--dry-run` | Print the resolved session, transcript, working directory, and fork command as JSON. |
| anything else | Passed through to `claude` or `codex`. |

Use `--` to separate flags from the prompt. Without it, a leading `-` means flags only, and anything else is the prompt.

### While the agent is busy

`!side` waits for the current turn. To fork mid-turn, bind a key in your terminal that runs `side` against the pane. In tmux:

```tmux
bind-key S run-shell 'TMUX_PANE=#{pane_id} side --pane-pid #{pane_pid} --bg'
```

This finds the agent under the pane's shell and forks its session from the last saved point. The running turn continues undisturbed.

| Agent | `--pane-pid` finds the session from |
|---|---|
| Claude Code | `~/.claude/sessions/<pid>.json`, written by every interactive session |
| Codex | the TUI's `codex resume <id>` arguments only |

Codex TUIs share one background `codex app-server` that keeps every open thread, and Codex records no link from a TUI process to its thread. A Codex pane started with plain `codex` or `codex fork` therefore cannot be forked from outside; `side` says so and exits. Use `!side` in those panes.

## How it works

1. **Find the session.** Inside an agent, `side` reads the session id the agent exports to shell commands (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`). When both are set, the nearest agent process above `side` decides.
2. **Find the transcript** (`~/.claude/projects/*/<id>.jsonl` or `~/.codex/sessions/**/rollout-*<id>.jsonl`) and the working directory it recorded. The fork starts there.
3. **Find the agent binary** from the running agent process, so shell wrappers and version managers do not matter. `PATH` is the fallback.
4. **Place a pane** and run the fork command in it.

### Automatic placement

In tmux, Tern, and WezTerm, `side` reads each pane's size and splits only where both halves stay at least 80 columns wide and 30 rows tall.

1. **Your pane first.** Split along whichever axis leaves the roomier halves. Wide panes go side by side, tall panes stack, and ties go side by side.
2. **Another pane only when yours is too small.** In tmux, prefer a fitting pane that shares an edge with yours. Choose the roomiest split, preferring the largest pane on ties.
3. **A new tab** when nothing fits.

Direction flags restrict the search to that direction. `--split` without a fit divides your pane along its better axis. Set `SIDE_MIN_COLS` and `SIDE_MIN_ROWS` to change the minimum.

A cell is assumed to be twice as tall as it is wide, except in Tern, which reports pixel sizes. cmux and Kitty use a simpler rule: a one-pane tab gets a split, and an already split tab gets a new tab. Ghostty always opens a new window.

## Development

```sh
bun install
bun test
bunx tsc -p .
```

## License

MIT
