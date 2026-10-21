#!/bin/sh
# Builds /tmp/side-demo for demo/side.tape: the example project, a tmux config with
# nothing machine-specific in the status line, and the /side hook scoped to that project.
# Claude Code asks once whether to trust a new folder, so run `claude` there once first.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
demo=/tmp/side-demo
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$demo/.claude"
cp "$here/cache.ts" "$here/tmux.conf" "$demo/"
CLAUDE_CONFIG_DIR=$scratch side install-hook claude >/dev/null
cp "$scratch/settings.json" "$demo/.claude/settings.json"
mkdir -p "$demo/.claude/commands"
cp "$scratch/commands/side.md" "$demo/.claude/commands/side.md"
echo "ready: $demo"
