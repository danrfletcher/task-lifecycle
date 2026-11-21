# Sourced by setup.sh. Not run on its own.
#
# prepare_scratch <dir> makes <dir> ready to build into and sets SCR to its
# absolute path. It only ever removes a directory that setup.sh made itself:
# one that holds the marker file below. A path that does not exist, or is an
# empty directory, is used as it is (nothing to remove). Anything else (a repo,
# $HOME, a typo that names real files, a symlink, a plain file) is refused and
# nothing is deleted.

PROBE_MARKER=.task-lifecycle-probe

prepare_scratch() {
	local dir=$1 parent
	[ -n "$dir" ] || { echo "refusing an empty scratch dir" >&2; return 1; }
	case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
	[ ! -L "$dir" ] || { echo "refusing scratch dir $dir: it is a symlink" >&2; return 1; }

	if [ -e "$dir" ]; then
		[ -d "$dir" ] || { echo "refusing scratch dir $dir: it is not a directory" >&2; return 1; }
		# Resolve ".", "..", a trailing slash and symlinked parents before anything else.
		dir=$(cd "$dir" && pwd -P)
		if [ -f "$dir/$PROBE_MARKER" ]; then
			[ "$dir" != "/" ] && [ "$dir" != "$(cd "$HOME" && pwd -P)" ] || { echo "refusing scratch dir $dir" >&2; return 1; }
			# Remove what a previous run left (dotfiles included), keep the directory itself.
			find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
		elif [ -n "$(ls -A "$dir")" ]; then
			echo "refusing scratch dir $dir: it is not empty and has no $PROBE_MARKER file from a previous setup.sh run." >&2
			echo "Pass a new path or an empty directory; nothing was deleted." >&2
			return 1
		fi
	else
		parent=$(dirname "$dir")
		[ -d "$parent" ] || { echo "refusing scratch dir $dir: $parent does not exist" >&2; return 1; }
		dir="$(cd "$parent" && pwd -P)/$(basename "$dir")"
		mkdir "$dir"
	fi
	: > "$dir/$PROBE_MARKER"
	SCR=$dir
}
