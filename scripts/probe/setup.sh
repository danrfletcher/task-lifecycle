#!/usr/bin/env bash
# Build the plugin into a throwaway vault and start a throwaway Obsidian on it.
#
#   scripts/probe/setup.sh <scratch-dir>
#
# <scratch-dir> must not exist, be an empty directory, or be one an earlier
# setup.sh run made (it holds a .task-lifecycle-probe file); that last kind is
# emptied and reused. Any other path is refused and nothing is deleted.
# The throwaway Obsidian gets its own HOME and --user-data-dir under it, so
# your own vault and window are never touched.
# The Obsidian PID is written to <scratch-dir>/pid; run.sh stop uses only that.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
# shellcheck source=scratch.sh
. "$HERE/scratch.sh"
prepare_scratch "${1:?usage: setup.sh <scratch-dir>}"
DATA="$SCR/home/Library/Application Support/obsidian"
PLUGIN="$SCR/vault/.obsidian/plugins/task-lifecycle"
mkdir -p "$DATA" "$PLUGIN"

# The vault: the fixture notes plus the plugin, enabled.
cp "$HERE"/vault/*.md "$SCR/vault/"
echo '{}' > "$SCR/vault/.obsidian/app.json"
echo '["task-lifecycle"]' > "$SCR/vault/.obsidian/community-plugins.json"
(cd "$REPO" && node esbuild.config.mjs production "$PLUGIN/main.js")
cp "$REPO/manifest.json" "$REPO/styles.css" "$PLUGIN/"
echo '{}' > "$PLUGIN/data.json"

# Obsidian's own config: this vault only, CLI on.
cat > "$DATA/obsidian.json" <<EOF
{"cli":true,"vaults":{"probe0000000001":{"path":"$SCR/vault","ts":$(date +%s)000,"open":true}}}
EOF

open -g -n -a /Applications/Obsidian.app --env HOME="$SCR/home" --args --user-data-dir="$DATA"
for _ in $(seq 1 30); do
	PID=$(pgrep -f "MacOS/Obsidian --user-data-dir=$DATA" | head -n 1 || true)
	[ -n "$PID" ] && break
	sleep 1
done
[ -n "${PID:-}" ] || { echo "Obsidian did not start" >&2; exit 1; }
echo "$PID" > "$SCR/pid"
sleep 6
echo "started Obsidian pid $PID, vault $SCR/vault"
