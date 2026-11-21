/**
 * The one place that changes a task line in a source note on behalf of a
 * rendered checkbox.
 *
 * `press(file, line, kind)` applies a short click (cycle) or a long press
 * (cancel) to the task on the 0-based source `line`, with the status char and
 * the close stamp. It does not decide which line a click means (the resolver
 * does), does not listen to clicks and does not run the cascade.
 *
 * Two routes, chosen per write:
 *  - the note is open in any Markdown leaf (with several panes on it, the one
 *    being edited: the active editor, else one with unsaved changes, else the
 *    first; see `findEditorToWrite`): the status char goes in as one
 *    `editor.transaction` change. The change detector then stamps it, as for
 *    a typed edit (one undo step), and unsaved typing in that editor is never
 *    overwritten, because the new line is built from the editor's own text;
 *  - the note is closed: one `app.vault.process` call writes status and stamp
 *    together. This and the cascade's `process` (below) share the one
 *    `vault.process` call site in the plugin.
 * Both routes give the same bytes for the same note text.
 *
 * Writes are serialised per file: a press that arrives while an earlier one
 * on the same file is still running waits for it, then reads the text as it
 * is by then. A write that throws rejects its own `press` promise and does
 * not hold up the next one. A press on another file is never held back.
 *
 * A line that is no longer a task at write time (moved, edited, in a fenced
 * block or frontmatter, past the last line) is skipped: nothing is written
 * (the `vault.process` callback returns its input unchanged) and the result
 * says why.
 */
import type { App, Editor, TFile } from "obsidian";

import {
	editTextLine,
	planLineEdit,
	type LineEdit,
	type LineEditResult,
	type SkipReason,
} from "../domain/source-line-edit";
import type { PressKind } from "../domain/status-sequence";
import { captureEditorScroll, restoreEditorScrollLater } from "../editor/scroll-preserver";
import { findEditorToWrite, type OpenEditor } from "./editor-lookup";

export type { PressKind };

/**
 * What a `LineResolver` says: the line to change, or why none is.
 *  - `unmappable`: the rendered task is on no line, or on several.
 *  - `stale`: the rendered status differs from the note's current one;
 *    `fileStatus` is the char the note has.
 *  - `disposed`: the caller was shut down while the write was waiting.
 */
export type LineResolution =
	| { line: number }
	| { skip: "unmappable" | "stale" | "disposed"; fileStatus?: string };

/**
 * Picks the line to change from the note's lines as they are at write time
 * (the open editor's own text, or what `vault.process` hands over), so a
 * line that moved or changed after the click is found again, never guessed.
 * Must be synchronous and must not write.
 */
export type LineResolver = (lines: readonly string[]) => LineResolution;

export type PressSkipReason = SkipReason | "disposed" | "unmappable" | "stale";

export type PressResult =
	| {
			status: "written";
			/** `editor`: one transaction on an open editor. `vault`: one `vault.process` call. */
			route: "editor" | "vault";
			line: number;
			/** The status char before (raw, e.g. "X") and after. */
			from: string;
			to: string;
			/** The task line as written (status char and stamp), without its line ending. */
			lineText: string;
	  }
	| {
			status: "skipped";
			reason: PressSkipReason;
			/** For `stale`: the status char the note has. */
			fileStatus?: string;
	  };

export interface SourceWriterDeps {
	app: Pick<App, "vault" | "workspace">;
	/** Read on every write, so the "Close stamps" toggle applies without reload. */
	getSettings: () => { closeStamps: boolean };
	/** "Today" for a stamp; its local date is used. Default `new Date()`. */
	today?: () => Date;
}

export interface SourceWriter {
	/**
	 * Apply a press to the task on `line` (0-based) of `file`. See the file
	 * comment. With `resolve`, the line is chosen at write time from the
	 * note's lines (`line` is then unused) and a skip it returns is the result.
	 */
	press(file: TFile, line: number, kind: PressKind, resolve?: LineResolver): Promise<PressResult>;
	/**
	 * One atomic `vault.process` of `file` (the close cascade's write to a
	 * closed note), in the same per-file queue as `press`: it starts after the
	 * earlier writes on the note finish, and a later `press` waits for it. The
	 * caller's `fn` does the editing and must return its input to change
	 * nothing. Rejects with `Error("disposed")` if the writer is shut down
	 * before it starts, and with whatever `vault.process` rejects with (a
	 * deleted note); a rejection does not hold up the queue.
	 */
	process(file: TFile, fn: (data: string) => string): Promise<void>;
	/** Drop writes that have not started. A write already running finishes. */
	dispose(): void;
}

function written(route: "editor" | "vault", edit: LineEdit): PressResult {
	return {
		status: "written",
		route,
		line: edit.line,
		from: edit.from,
		to: edit.to,
		lineText: edit.after,
	};
}

function skipped(result: { skipped: SkipReason }): PressResult {
	return { status: "skipped", reason: result.skipped };
}

function resolverSkip(skip: Exclude<LineResolution, { line: number }>): PressResult {
	return skip.fileStatus === undefined
		? { status: "skipped", reason: skip.skip }
		: { status: "skipped", reason: skip.skip, fileStatus: skip.fileStatus };
}

export function createSourceWriter(deps: SourceWriterDeps): SourceWriter {
	const { app } = deps;
	const today = deps.today ?? (() => new Date());
	let disposed = false;

	/** The last write queued per file path; never rejects. */
	const tails = new Map<string, Promise<void>>();

	/** The plugin's one call to `vault.process`. */
	const processNote = (file: TFile, fn: (data: string) => string): Promise<string> =>
		app.vault.process(file, fn);

	const allLines = (editor: OpenEditor): string[] => {
		const lines: string[] = [];
		for (let i = 0; i < editor.lineCount(); i++) lines.push(editor.getLine(i));
		return lines;
	};

	const writeToEditor = (
		editor: OpenEditor,
		line: number,
		kind: PressKind,
		stampsOn: boolean,
		resolve?: LineResolver
	): PressResult => {
		// Built from the editor's own text, never from the disk copy.
		const lines = allLines(editor);
		const target = resolve ? resolve(lines) : { line };
		if (!("line" in target)) return resolverSkip(target);
		const result = planLineEdit(lines, target.line, kind, { stampsOn, today: today() });
		if (!("edit" in result)) return skipped(result);
		const { edit } = result;
		const scroll = captureEditorScroll(editor as unknown as Editor);
		editor.transaction({
			changes: [
				{
					from: { line: edit.line, ch: edit.ch },
					to: { line: edit.line, ch: edit.ch + edit.from.length },
					text: edit.to,
				},
			],
		});
		restoreEditorScrollLater(scroll);
		return written("editor", edit);
	};

	const writeToVault = async (
		file: TFile,
		line: number,
		kind: PressKind,
		stampsOn: boolean,
		resolve?: LineResolver
	): Promise<PressResult> => {
		let outcome: LineEditResult | null = null;
		let refused: PressResult | null = null;
		await processNote(file, (data) => {
			const target = resolve ? resolve(data.split(/\r\n|\n/)) : { line };
			if (!("line" in target)) {
				refused = resolverSkip(target);
				return data;
			}
			const edited = editTextLine(data, target.line, kind, { stampsOn, today: today() });
			outcome = edited.result;
			return edited.text;
		});
		if (refused) return refused;
		const result = outcome as LineEditResult | null;
		if (result && "edit" in result) return written("vault", result.edit);
		return result ? skipped(result) : { status: "skipped", reason: "not-a-task" };
	};

	const run = async (
		file: TFile,
		line: number,
		kind: PressKind,
		resolve?: LineResolver
	): Promise<PressResult> => {
		if (disposed) return { status: "skipped", reason: "disposed" };
		// Looked up now, not when the press was queued: the note may have been
		// opened or closed while an earlier write was running.
		const stampsOn = deps.getSettings().closeStamps;
		const editor = findEditorToWrite(app as App, file);
		return editor
			? writeToEditor(editor, line, kind, stampsOn, resolve)
			: writeToVault(file, line, kind, stampsOn, resolve);
	};

	/** Put `task` behind everything queued on `key`. */
	const queue = <T>(key: string, task: () => Promise<T>): Promise<T> => {
		const previous = tails.get(key) ?? Promise.resolve();
		const result = previous.then(task);
		const tail = result.then(
			() => undefined,
			() => undefined
		);
		tails.set(key, tail);
		void tail.then(() => {
			if (tails.get(key) === tail) tails.delete(key);
		});
		return result;
	};

	return {
		press(file, line, kind, resolve) {
			if (disposed) return Promise.resolve({ status: "skipped", reason: "disposed" });
			return queue(file.path, () => run(file, line, kind, resolve));
		},
		process(file, fn) {
			if (disposed) return Promise.reject(new Error("disposed"));
			return queue(file.path, async () => {
				if (disposed) throw new Error("disposed");
				await processNote(file, fn);
			});
		},
		dispose() {
			disposed = true;
			tails.clear();
		},
	};
}
