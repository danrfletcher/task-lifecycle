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
 *    together. This is the only `vault.process` call in the plugin.
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

export type PressSkipReason = SkipReason | "disposed";

export type PressResult =
	| {
			status: "written";
			/** `editor`: one transaction on an open editor. `vault`: one `vault.process` call. */
			route: "editor" | "vault";
			line: number;
			/** The status char before (raw, e.g. "X") and after. */
			from: string;
			to: string;
	  }
	| { status: "skipped"; reason: PressSkipReason };

export interface SourceWriterDeps {
	app: Pick<App, "vault" | "workspace">;
	/** Read on every write, so the "Close stamps" toggle applies without reload. */
	getSettings: () => { closeStamps: boolean };
	/** "Today" for a stamp; its local date is used. Default `new Date()`. */
	today?: () => Date;
}

export interface SourceWriter {
	/** Apply a press to the task on `line` (0-based) of `file`. See the file comment. */
	press(file: TFile, line: number, kind: PressKind): Promise<PressResult>;
	/** Drop writes that have not started. A write already running finishes. */
	dispose(): void;
}

function written(route: "editor" | "vault", edit: LineEdit): PressResult {
	return { status: "written", route, line: edit.line, from: edit.from, to: edit.to };
}

function skipped(result: { skipped: SkipReason }): PressResult {
	return { status: "skipped", reason: result.skipped };
}

export function createSourceWriter(deps: SourceWriterDeps): SourceWriter {
	const { app } = deps;
	const today = deps.today ?? (() => new Date());
	let disposed = false;

	/** The last write queued per file path; never rejects. */
	const tails = new Map<string, Promise<void>>();

	const allLines = (editor: OpenEditor): string[] => {
		const lines: string[] = [];
		for (let i = 0; i < editor.lineCount(); i++) lines.push(editor.getLine(i));
		return lines;
	};

	const writeToEditor = (
		editor: OpenEditor,
		line: number,
		kind: PressKind,
		stampsOn: boolean
	): PressResult => {
		// Built from the editor's own text, never from the disk copy.
		const result = planLineEdit(allLines(editor), line, kind, { stampsOn, today: today() });
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
		stampsOn: boolean
	): Promise<PressResult> => {
		let outcome: LineEditResult | null = null;
		await app.vault.process(file, (data) => {
			const edited = editTextLine(data, line, kind, { stampsOn, today: today() });
			outcome = edited.result;
			return edited.text;
		});
		const result = outcome as LineEditResult | null;
		if (result && "edit" in result) return written("vault", result.edit);
		return result ? skipped(result) : { status: "skipped", reason: "not-a-task" };
	};

	const run = async (file: TFile, line: number, kind: PressKind): Promise<PressResult> => {
		if (disposed) return { status: "skipped", reason: "disposed" };
		// Looked up now, not when the press was queued: the note may have been
		// opened or closed while an earlier write was running.
		const stampsOn = deps.getSettings().closeStamps;
		const editor = findEditorToWrite(app as App, file);
		return editor ? writeToEditor(editor, line, kind, stampsOn) : writeToVault(file, line, kind, stampsOn);
	};

	return {
		press(file, line, kind) {
			if (disposed) return Promise.resolve({ status: "skipped", reason: "disposed" });
			const key = file.path;
			const previous = tails.get(key) ?? Promise.resolve();
			const result = previous.then(() => run(file, line, kind));
			const tail = result.then(
				() => undefined,
				() => undefined
			);
			tails.set(key, tail);
			void tail.then(() => {
				if (tails.get(key) === tail) tails.delete(key);
			});
			return result;
		},
		dispose() {
			disposed = true;
			tails.clear();
		},
	};
}
