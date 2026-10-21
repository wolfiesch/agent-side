# Records demo/side.gif from the repository root. Run demo/setup.sh, open `claude` in
# /tmp/side-demo once to trust the folder, then run: vhs demo/side.tape
# The recording runs a real Claude Code session, so timing varies between runs.

Output demo/side.gif

Require claude
Require side
Require tmux

Set Shell "bash"
Set FontSize 16
Set Width 1600
Set Height 820
Set Padding 16
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

Hide
Type "export PS1='$ ' SIDE_MIN_COLS=70; cd /tmp/side-demo && tmux -L sidedemo kill-server 2>/dev/null; clear"
Enter
Type "tmux -L sidedemo -f tmux.conf new-session -s demo claude"
Enter
Wait+Screen@30s /Claude Code v/
Sleep 1s
Show

Sleep 1s
Type "Read cache.ts and summarize it in one sentence."
Sleep 500ms
Enter
Wait+Screen@90s /✻ \S+ for \d+s/
Sleep 2s

Type "/side in two sentences: how would I unit test expiry without sleeping?"
Sleep 500ms
Enter
# The fork replays the transcript first, so wait for its own prompt and the reply after it.
Wait+Screen@120s /(?s)❯ in two sentences.*✻ \S+ for \d+s/
Sleep 4s

Hide
Ctrl+B
Type ":kill-server"
Enter
