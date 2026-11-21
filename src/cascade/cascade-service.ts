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
 *
 * Two routes, chosen when the dialog opens and again when it is confirmed:
 *  - the source note is open in an editor: the lines are the editor's own and
 *    the subtasks go in as one `editor.transaction` (unsaved typing is never
 *    overwritten);
 *  - it is not open (a task closed from a rendered checkbox in an embed whose
 *    source is closed; `reportClose` brings that in): the text comes from
 *    `files.read`, the parent is located by content, and every subtask is
 *    written in one `files.process` call. The parent must match exactly one
 *    line: none or several writes nothing and shows the "couldn't find this
 *    task's source line" notice. Line endings of every line are kept as they were.
 *
 * A note that is deleted, or renamed (its path is no longer the one it had
 * when the close was reported), while the dialog is showing is not written
 * on either route: the same notice shows and nothing changes.
 *
 * The dialog stays up when the note it is about is opened in a pane
 * (`cancelPrompt(file)` ignores that note); the apply then finds the editor
 * and takes the editor route. Any other note being shown cancels it.
 * Without `files` the service is editor-only: a closed note is ignored.
 */
import type { EditorChange, TFile } from "obsidian";

import { CASCADE_DEDUPE_MS } from "../domain/constants";
import {
	cascadeStatus,
	computeCascadeEdits,
	countOpenSubtasks,
	lineSpan,
} from "../domain/cascade";
import { joinLines, splitLines } from "../domain/source-line-edit";
import { removeStamps } from "../domain/stamps";
import { statusKind } from "../domain/status-sequence";
import {
	STATUS_CHANGED_EVENT,
	type StatusChangedPayload,
	type TaskLifecycleEvents,
} from "../events/event-bus";
import { UNMAPPABLE_NOTICE } from "../rendered/embed-press";
import type { SettingsStore } from "../settings/settings";
import type { CascadeChoice, CascadePrompt } from "./close-subtasks-modal";

/** The slice of Obsidian's `Editor` the cascade uses. */
export interface CascadeEditor {
	lineCount(): number;
	getLine(line: number): string;
	transaction(tx: { changes?: EditorChange[] }): void;
}

/** Reading and writing a note that is not open in an editor. */
export interface CascadeFiles {
	/** The note's text as it is on disk now. Rejects if the note is gone. */
	read(file: TFile): Promise<string>;
	/** One atomic read-modify-write of the note's text, in the vault's atomic-write style. Rejects if the note is gone. */
	process(file: TFile, fn: (data: string) => string): Promise<unknown>;
}

export interface CascadeDeps {
	events: Pick<TaskLifecycleEvents, "on">;
	settings: Pick<SettingsStore, "get" | "subscribe">;
	prompt: CascadePrompt;
	/** The open editor for a note, or null if it is not open. Looked up again at apply time. */
	getEditor: (file: TFile) => CascadeEditor | null;
	/** The closed-note route. Omit for an editor-only cascade. */
	files?: CascadeFiles;
	/** Show a message to the user (the closed-note route only). */
	notify?: (message: string) => void;
	/** Clock in ms for the dedupe window. Default `Date.now`. */
	now?: () => number;
	/** "Today" for stamps. Default `new Date()`. */
	today?: () => Date;
	/** Run `fn` after the current dispatch. Default: a microtask. */
	defer?: (fn: () => void) => void;
}

export interface CascadeService {
	/**
	 * Report a task close that the change detector cannot see: a rendered
	 * checkbox closed a task in a note that is not open. Same rules as a
	 * detector event (setting, transition, 1500 ms dedupe). Never throws.
	 */
	reportClose(payload: StatusChangedPayload): void;
	/** True while the "Close subtasks?" dialog is open for a close. */
	isDialogOpen(): boolean;
	/**
	 * Close an open dialog as "Leave open" (note switched or closed).
	 * `shown` is the note now showing, if any: when it is the note the dialog
	 * is about, the dialog stays.
	 */
	cancelPrompt(shown?: TFile | null): void;
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

	/** The dialog now open, by sequence number; a replaced dialog's late settle must not clear the new one. */
	let dialogSeq = 0;
	let activeDialog: number | null = null;
	/** The note the open dialog is about. */
	let dialogFile: TFile | null = null;

	const applyToEditor = (editor: CascadeEditor, line: number, recorded: string): void => {
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

	const notifyUnmappable = (): void => {
		if (!disposed) deps.notify?.(UNMAPPABLE_NOTICE);
	};

	/** The closed-note write: locate the parent by content, then one `process` call for every subtask. */
	const applyToFile = async (files: CascadeFiles, file: TFile, recorded: string): Promise<void> => {
		let notFound = false;
		try {
			await files.process(file, (data) => {
				const parts = splitLines(data);
				const lines = parts.map((l) => l.text);
				const found: number[] = [];
				lines.forEach((text, i) => {
					if (text === recorded) found.push(i);
				});
				if (found.length !== 1) {
					notFound = true;
					return data;
				}
				const edits = computeCascadeEdits(lines, found[0], {
					stampsOn: deps.settings.get().closeStamps,
					today: today(),
				});
				if (edits.length === 0) return data;
				for (const edit of edits) parts[edit.line] = { text: edit.after, eol: parts[edit.line].eol };
				return joinLines(parts);
			});
		} catch {
			// The note was deleted or renamed, or the write failed: nothing was written.
			notifyUnmappable();
			return;
		}
		if (notFound) notifyUnmappable();
	};

	/** Looked up again now: the note may have been opened or closed while the dialog was showing. */
	const apply = async (file: TFile, path: string, line: number, recorded: string): Promise<void> => {
		if (disposed || !deps.settings.get().closeCascade) return;
		// A rename changes the same TFile's path in place: the note the close was reported on has moved.
		if (file.path !== path) {
			notifyUnmappable();
			return;
		}
		const editor = deps.getEditor(file);
		if (editor) {
			applyToEditor(editor, line, recorded);
			return;
		}
		if (deps.files) await applyToFile(deps.files, file, recorded);
	};

	/** The note's lines now, from its open editor or else from the file; null if there is no way to read them. */
	const readLines = async (file: TFile): Promise<{ lines: string[] } | null> => {
		const editor = deps.getEditor(file);
		if (editor) return { lines: allLines(editor) };
		if (!deps.files) return null;
		try {
			const text = await deps.files.read(file);
			return { lines: splitLines(text).map((l) => l.text) };
		} catch {
			// Deleted or renamed since the press.
			notifyUnmappable();
			return null;
		}
	};

	const handle = async (p: StatusChangedPayload & { file: TFile }): Promise<void> => {
		if (disposed || !deps.settings.get().closeCascade) return;
		const path = p.file.path;
		const read = await readLines(p.file);
		if (!read || disposed) return;
		const { lines } = read;
		if (p.line >= lines.length) return;
		const text = lines[p.line];
		// The line must still be the task that was closed. The detector may
		// have added its stamp since; its status char is the one reported. If a
		// later press already moved the task on (done to cancelled), there is
		// nothing to ask about, and nothing to report.
		if (!sameTask(text, p.lineText) || cascadeStatus(text) === null) return;

		const count = countOpenSubtasks(lines, p.line);
		if (count === 0) return;

		const seq = ++dialogSeq;
		activeDialog = seq;
		dialogFile = p.file;
		let choice: CascadeChoice;
		try {
			choice = await deps.prompt.open(count);
		} finally {
			if (activeDialog === seq) {
				activeDialog = null;
				dialogFile = null;
			}
		}
		if (choice === "close") await apply(p.file, path, p.line, text);
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
		reportClose: handleClose,
		isDialogOpen: () => activeDialog !== null,
		cancelPrompt: (shown) => {
			if (shown && dialogFile && (shown === dialogFile || shown.path === dialogFile.path)) return;
			deps.prompt.closeOpen();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			stopEvents();
			stopSettings();
			seen.clear();
			deps.prompt.closeOpen();
			activeDialog = null;
			dialogFile = null;
		},
	};
}
