# Task Lifecycle

An Obsidian plugin for the life of a Markdown task line. Private repo; not on the community store.

## What it does

- **Status cycle.** Clicking a task checkbox in Live Preview, in an embed, or in a note's Reading view steps through ` ` → `/` → `x` → `-` → ` ` (open, in progress, done, cancelled) instead of toggling done/undone. Holding a checkbox for half a second cancels the task (`[-]`).
- **Close stamps.** Closing a task adds `✅ YYYY-MM-DD` (done) or `❌ YYYY-MM-DD` (cancelled), placed at the end of the line and before a trailing `^blockid`. Reopening removes the stamp.
- **Close cascade.** Closing a parent task asks whether to close its open subtasks too ("Close subtasks" / "Leave open").

Only the checkbox character, the stamps and the single space before a stamp are ever changed.

## Settings

Settings → Task Lifecycle has four toggles, all on by default:

- **Status cycle**. Off, a click on a checkbox in an embed or in Reading view is the plain toggle (open to done, anything else to open), written by the plugin so the stamp and cascade still follow; a hold still cancels.
- **Close stamps**
- **Close cascade**
- **Checkbox icons**

## Install

Local build only:

```
npm ci
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/task-lifecycle/`, then enable **Task Lifecycle** in Settings → Community plugins.

## Known limits

- **Undo does not revert a tick made on a closed note.** A tick on a task whose note is not open in any pane is written to the file directly, not through an editor, so no undo history holds it. Undo in a pane (or Ctrl/Cmd+Z after opening the note) leaves that tick in place; change the task back by clicking it again. A tick on a note that is open in a pane is an editor change, and one undo reverts the status and its stamp together.

## Conflicts

Task Lifecycle does not detect or adapt to other plugins. Running it next to them would handle the same checkbox click twice, so:

- Disable **Agile Obsidian** (Agile Project Management).
- Turn off status toggling in the **Tasks** plugin.

## Development

```
npm ci
npm run lint
npm run typecheck
npm test        # vitest; src/domain/** must stay at 90% lines and branches
npm run build
```

`src/domain/` and `src/utils/` are pure (no `obsidian` import; enforced by lint and by a test).

## Status

Version 0.1.0 has all four features: the status cycle (click and long press), close stamps, the close cascade and the checkbox icons, with the four toggles saved in `data.json` and applied without a reload. The close cascade asks "Close subtasks?" once per close; "Close subtasks" closes every open subtask in one editor transaction (one undo step), and "Leave open", Escape, switching notes or turning the setting off change nothing.
