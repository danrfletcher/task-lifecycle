/**
 * The close cascade service.
 *
 * One instance per plugin. It listens only to the plugin's own
 * `task-lifecycle:status-changed` event. For a task that went from open, in
 * progress or unknown to done or cancelled, and has at least one open
 * subtask, it asks "Close subtasks?" through the prompt port. On "close" it
 * recomputes the subtasks from the note as it is then and writes every edit
 * in one `editor.transaction`.
 *
 * Timing: the detector emits the event inside the editor's dispatch, before
 * the change is in the document. The service therefore does its reading in a
 * microtask, after the dispatch has finished, and never edits during the
 * event.
 *
 * Dedupe: the same close reported twice for the same file and parent line
 * inside `CASCADE_DEDUPE_MS` opens one dialog. There is no per-file
 * suppression: two different parents closed in quick succession both prompt,
 * and the second dialog replaces the first (which closes as "Leave open").
 *
 * The cascade's own edit is seen by the change detector like any other editor
 * change: it is not annotated `taskLifecycleSelfWrite`, because it goes
 * through Obsidian's `Editor.transaction`, which takes no CodeMirror
 * annotation. Its stamp edit for those lines changes nothing (the cascade
 * already wrote the same stamp), and the subtasks it closed have no open
 * subtasks left, so the events it causes never open a dialog. They are
 * stopped by the dedupe map or by the zero-count check; this relies on both
 * staying true. The map entries expire after `CASCADE_DEDUPE_MS`.
 *
 * Nothing is edited unless the dialog resolves "close" and the parent line
 * is still found, closed, and the setting is still on.
 */
import type { EditorChange, TFile } from "obsidian";

import { CASCADE_DEDUPE_MS } from "../domain/constants";
import {
	cascadeStatus,
	computeCascadeEdits,
	countOpenSubtasks,
	lineSpan,
} from "../domain/cascade";
import { removeStamps } from "../domain/stamps";
import { statusKind } from "../domain/status-sequence";
import {
	STATUS_CHANGED_EVENT,
	type StatusChangedPayload,
	type TaskLifecycleEvents,
} from "../events/event-bus";
import type { SettingsStore } from "../settings/settings";
import type { CascadePrompt } from "./close-subtasks-modal";

/** The slice of Obsidian's `Editor` the cascade uses. */
export interface CascadeEditor {
	lineCount(): number;
	getLine(line: number): string;
	transaction(tx: { changes?: EditorChange[] }): void;
}

export interface CascadeDeps {
	events: Pick<TaskLifecycleEvents, "on">;
	settings: Pick<SettingsStore, "get" | "subscribe">;
	prompt: CascadePrompt;
	/** The open editor for a note, or null if it is not open. Looked up again at apply time. */
	getEditor: (file: TFile) => CascadeEditor | null;
	/** Clock in ms for the dedupe window. Default `Date.now`. */
	now?: () => number;
	/** "Today" for stamps. Default `new Date()`. */
	today?: () => Date;
	/** Run `fn` after the current dispatch. Default: a microtask. */
	defer?: (fn: () => void) => void;
}

export interface CascadeService {
	/** Close an open dialog as "Leave open" (note switched or closed). */
	cancelPrompt(): void;
	/** Stop listening, close an open dialog, and make any pending work a no-op. */
	dispose(): void;
}

function allLines(editor: CascadeEditor): string[] {
	const lines: string[] = [];
	for (let i = 0; i < editor.lineCount(); i++) lines.push(editor.getLine(i));
	return lines;
}

/** Same task, ignoring stamps and trailing whitespace (the detector may have stamped it since). */
function sameTask(current: string, recorded: string): boolean {
	return removeStamps(current).trimEnd() === removeStamps(recorded).trimEnd();
}

/** Where `text` is in `lines`: the original index if it still holds it, else the nearest match. */
function locate(lines: readonly string[], text: string, near: number): number | null {
	if (lines[near] === text) return near;
	let best: number | null = null;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== text) continue;
		if (best === null || Math.abs(i - near) < Math.abs(best - near)) best = i;
	}
	return best;
}

export function createCascadeService(deps: CascadeDeps): CascadeService {
	const now = deps.now ?? (() => Date.now());
	const today = deps.today ?? (() => new Date());
	const defer = deps.defer ?? ((fn: () => void) => {
		void Promise.resolve().then(fn);
	});

	let disposed = false;
	/** Last time a close was accepted for `path:line`. Only used for the 1500 ms window. */
	const seen = new Map<string, number>();

	const isDuplicate = (file: TFile, line: number): boolean => {
		const t = now();
		seen.forEach((at, k) => {
			if (t - at >= CASCADE_DEDUPE_MS) seen.delete(k);
		});
		const key = `${file.path}:${line}`;
		if (seen.has(key)) return true;
		seen.set(key, t);
		return false;
	};

	const apply = (file: TFile, line: number, recorded: string): void => {
		if (disposed || !deps.settings.get().closeCascade) return;
		const editor = deps.getEditor(file);
		if (!editor) return;
		const lines = allLines(editor);
		const parent = locate(lines, recorded, line);
		if (parent === null) return;
		if (cascadeStatus(lines[parent]) === null) return;

		const edits = computeCascadeEdits(lines, parent, {
			stampsOn: deps.settings.get().closeStamps,
			today: today(),
		});
		const changes: EditorChange[] = [];
		for (const edit of edits) {
			const span = lineSpan(edit.before, edit.after);
			if (!span) continue;
			changes.push({
				from: { line: edit.line, ch: span.fromCh },
				to: { line: edit.line, ch: span.toCh },
				text: span.text,
			});
		}
		if (changes.length > 0) editor.transaction({ changes });
	};

	const handle = async (p: StatusChangedPayload & { file: TFile }): Promise<void> => {
		if (disposed || !deps.settings.get().closeCascade) return;
		const editor = deps.getEditor(p.file);
		if (!editor || p.line >= editor.lineCount()) return;

		const lines = allLines(editor);
		const text = lines[p.line];
		// The line must still be the task that was closed. The detector may
		// have added its stamp since; its status char is the one reported.
		if (!sameTask(text, p.lineText) || cascadeStatus(text) === null) return;

		const count = countOpenSubtasks(lines, p.line);
		if (count === 0) return;

		const choice = await deps.prompt.open(count);
		if (choice === "close") apply(p.file, p.line, text);
	};

	const handleClose = (p: StatusChangedPayload): void => {
		if (disposed || !p.file) return;
		if (!deps.settings.get().closeCascade) return;
		const from = statusKind(p.from);
		const to = statusKind(p.to);
		if (from !== "open" && from !== "inProgress") return;
		if (to !== "done" && to !== "cancelled") return;
		if (isDuplicate(p.file, p.line)) return;

		const payload = { ...p, file: p.file };
		defer(() => {
			void handle(payload).catch((err) => {
				console.error("Task Lifecycle: close cascade failed", err);
			});
		});
	};

	const stopEvents = deps.events.on(STATUS_CHANGED_EVENT, handleClose);
	const stopSettings = deps.settings.subscribe((next, prev) => {
		if (prev.closeCascade && !next.closeCascade) deps.prompt.closeOpen();
	});

	return {
		cancelPrompt: () => deps.prompt.closeOpen(),
		dispose: () => {
			if (disposed) return;
			disposed = true;
			stopEvents();
			stopSettings();
			seen.clear();
			deps.prompt.closeOpen();
		},
	};
}
