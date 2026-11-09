# Task Lifecycle

An Obsidian plugin for the life of a Markdown task line:

- **Status cycle.** Clicking a task checkbox steps through a status sequence instead of toggling done/undone; a long press cancels the task (`[-]`).
- **Close stamps.** Closing a task adds a ✅ date (done) or ❌ date (cancelled); reopening it removes the stamp.
- **Close cascade.** Closing a parent task offers to close its open subtasks too.

## Status

Being extracted from [agile-obsidian](https://github.com/danrfletcher/agile-obsidian) (`src/features/task-status-sequencer`, `task-close-manager`, `task-close-cascade`, plus the date helper from `task-date-manager`). Nothing else from Agile Obsidian comes across.

Planned stack: TypeScript, esbuild, the Obsidian plugin API (same toolchain as agile-obsidian).

Roadmap: Tooling Roadmap (dotpm), ticket "Task Lifecycle plugin".
