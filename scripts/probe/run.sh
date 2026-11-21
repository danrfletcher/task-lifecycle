#!/usr/bin/env bash
# Drive the throwaway Obsidian that setup.sh started.
#
#   scripts/probe/run.sh <scratch-dir> eval <name>   run eval/<name>.js, print its JSON
#   scripts/probe/run.sh <scratch-dir> enable        enable the task-lifecycle plugin
#   scripts/probe/run.sh <scratch-dir> disable       disable it
#   scripts/probe/run.sh <scratch-dir> stop          stop the Obsidian setup.sh started
#
# OBSIDIAN_CLI picks the CLI binary (default: obsidian-real if it is on PATH,
# else obsidian). HOME is pointed at the scratch dir so the CLI reaches the
# throwaway instance, not your own.
set -euo pipefail

SCR=${1:?usage: run.sh <scratch-dir> eval <name>|enable|disable|stop}
CMD=${2:?missing command}
HERE=$(cd "$(dirname "$0")" && pwd)
case "$SCR" in /*) ;; *) SCR="$PWD/$SCR" ;; esac
CLI=${OBSIDIAN_CLI:-$(command -v obsidian-real || command -v obsidian)}
ob() { HOME="$SCR/home" "$CLI" "$@"; }

case "$CMD" in
	eval)
		NAME=${3:?missing script name (a file in eval/ without .js)}
		ob eval code="$(cat "$HERE/eval/$NAME.js")"
		;;
	enable)
		ob plugins:restrict off
		ob plugin:enable id=task-lifecycle
		sleep 2
		;;
	disable)
		ob plugin:disable id=task-lifecycle
		sleep 2
		;;
	stop)
		# Only the PID setup.sh recorded: never a name or pattern match.
		kill "$(cat "$SCR/pid")"
		;;
	*)
		echo "unknown command: $CMD" >&2
		exit 2
		;;
esac
