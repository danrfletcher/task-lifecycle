/**
 * The write behind a checkbox press.
 *
 * It changes the status char and nothing else: one `editor.replaceRange` of
 * exactly the status char, so the line length does not change. It does not
 * stamp and does not emit an event. The change detector sees the write as
 * an ordinary editor change, emits `task-lifecycle:status-changed` for it
 * and adds or removes the stamp.
 *
 * This module must not import anything from the cascade (a long press from
 * `x` never opens it; the `{from: 'x', to: '-'}` change it causes is
 * excluded by the cascade's own rule).
 */
import type { Editor } from "obsidian";

import { captureEditorScroll, restoreEditorScrollLater } from "../editor/scroll-preserver";
import { checkboxTokenRange, getCheckboxStatusChar } from "../domain/line-classifier";
import { targetStatus, type PressKind } from "../domain/status-sequence";

// Moved to the pure domain so the source-line edit shares them; re-exported here.
export { targetStatus };
export type { PressKind };

export interface StatusWriteResult {
	/** The status char before the write (raw, e.g. "X"); null if the line is not a task line. */
	from: string | null;
	/** The status char the line has after the write (or would have had, if nothing was written). */
	to: string | null;
	/** True if the editor was written to. */
	didChange: boolean;
}

/**
 * Write the new status char of the task on `line0`.
 *
 * Nothing is written when the line is not a task line, or when the target
 * equals the current char (a long press on `[-]`).
 */
export function writeStatus(editor: Editor, line0: number, kind: PressKind): StatusWriteResult {
	const text = editor.getLine(line0);
	const from = getCheckboxStatusChar(text);
	const range = checkboxTokenRange(text);
	if (from === null || range === null) return { from: null, to: null, didChange: false };

	const to = targetStatus(from, kind);
	if (to === from) return { from, to, didChange: false };

	const ch = range.fromCh + 1;
	const scroll = captureEditorScroll(editor);
	editor.replaceRange(to, { line: line0, ch }, { line: line0, ch: ch + from.length });
	restoreEditorScrollLater(scroll);
	return { from, to, didChange: true };
}
