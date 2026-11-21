# Probe scripts

The scripts behind `docs/probe-rendered-tasks.md`. They drive a throwaway
Obsidian with the real `obsidian` CLI (`eval`, `plugin:enable`,
`plugin:disable`), so the findings can be re-run when Obsidian updates.

Nothing here runs in `npm test`, and nothing here is bundled into the plugin.

## Run

```
scripts/probe/setup.sh /some/empty/scratch/dir      # build, make the vault, start Obsidian
scripts/probe/run.sh /some/empty/scratch/dir eval embed-sections
scripts/probe/run.sh /some/empty/scratch/dir disable
scripts/probe/run.sh /some/empty/scratch/dir eval native-tick
scripts/probe/run.sh /some/empty/scratch/dir enable
scripts/probe/run.sh /some/empty/scratch/dir stop   # stops only the PID in <dir>/pid
```

`setup.sh` only deletes a directory it made itself: one that holds the
`.task-lifecycle-probe` file it wrote on an earlier run (its contents are
cleared and the directory reused). A path that does not exist or is an empty
directory is used as it is. Any other path (a repo, `$HOME`, `.`, a typo that
names real files, a symlink) is refused and nothing is deleted. The Obsidian
it starts has its own `HOME` and `--user-data-dir` under that dir and opens
only the fixture vault, so your own vault and window
are left alone. It needs macOS, `/Applications/Obsidian.app` and the
`obsidian` CLI. Set `OBSIDIAN_CLI` if the CLI is not on `PATH` under the
default names.

## Which script gives which finding

| Script (`eval/`) | Finding in the doc | Plugin |
|---|---|---|
| `native-tick` | 1. Native embed tick | disabled |
| `embed-sections` | 2. `data-line` per embed form | either |
| `shapes` | 2. callout, quote, numbered, empty, table, fenced; rendered text | either |
| `cache-forms` | 2. `metadataCache` sections, blocks, list items | either |
| `detector-echo` | 3. Detector echo | enabled |
| `vault-process-open` | 4. `vault.process` with the file open | enabled |
| `live-preview-click` | 5. Click on an embedded checkbox in Live Preview | both, compare |

Each script is one expression (an async function called at once) that returns
a JSON string. The `app` object is Obsidian's. The scripts reset `Course.md`
to its golden-path text before and after they write to it.

Finding 7 (the resolver against the real app) is not here: it called a
`plugin.resolveRenderedTask` hook that was built in for that run and is not in
the plugin now.

## Provenance

These were recovered from the commands recorded when the probe was first run
(2026-11-20, Obsidian 1.15.1), tidied into files and given the fixture notes in
`vault/`. They were not re-run when they were checked in, so the first re-run
may need small fixes (a wait that is too short on a slow machine, a selector
that Obsidian changed). `vault/Shapes.md` has a task line with a trailing
space (the empty task): an editor that trims whitespace will change it.
