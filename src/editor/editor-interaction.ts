/**
 * Map a pointer event to an editor position (`findPosFromEvent`); the
 * token-range helpers live in `../status-cycle/checkbox-hit-test.ts`, which
 * uses the line classifier.
 */
import type { Editor } from "obsidian";

import type { CmEditorViewLike } from "./scroll-preserver";

export interface EditorOffsetPosition {
	line: number;
	ch: number;
}

type EditorWithCoords = Editor & {
	cm?: CmEditorViewLike;
	offsetToPos(offset: number): EditorOffsetPosition;
};

/**
 * The editor position under a pointer event, from `cm.posAtCoords`.
 * Null if the editor cannot say. It never falls back to the cursor: a click
 * that maps to nothing must not act on whatever line the cursor is on.
 */
export function findPosFromEvent(
	editor: Editor,
	evt: { clientX: number; clientY: number }
): EditorOffsetPosition | null {
	try {
		const ext = editor as EditorWithCoords;
		const cm = ext.cm;
		if (!cm?.posAtCoords) return null;
		const hit = cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
		if (hit == null) return null;
		if (typeof hit === "number") return ext.offsetToPos(hit);
		if ("pos" in hit) return ext.offsetToPos(hit.pos);
		if (typeof hit.line === "number" && typeof hit.ch === "number") {
			return { line: hit.line, ch: hit.ch };
		}
	} catch {
		// Unmappable: no position.
	}
	return null;
}

/** The slice of an `Element` the block-widget lookup reads. */
export interface WidgetElementLike {
	closest(selector: string): WidgetElementLike | null;
	getAttribute(name: string): string | null;
	querySelectorAll(selector: string): ArrayLike<WidgetElementLike>;
}

/** True if `target` sits inside a rendered CM6 block widget (a callout, an embed, ...). */
export function isInBlockWidget(target: WidgetElementLike | null): boolean {
	return !!target?.closest(".cm-embed-block");
}

/**
 * The source line of the rendered `.cm-line` that holds `target`, from the
 * DOM (`cm.posAtDOM`), which never depends on measured layout.
 *
 * `posAtCoords` goes through layout, and right after a write the layout can
 * be stale, so a second press 0 ms after the first maps to some other line.
 * The element that was pressed has no such lag. Null if `target` is not in
 * a `.cm-line` or the editor cannot place it: the caller leaves the event
 * alone rather than guess.
 */
export function findLineOfElement(editor: Editor, target: WidgetElementLike | null): number | null {
	try {
		const lineEl = target?.closest(".cm-line");
		if (!lineEl) return null;
		const ext = editor as EditorWithCoords;
		const cm = ext.cm;
		if (!cm?.posAtDOM) return null;
		const line = ext.offsetToPos(cm.posAtDOM(lineEl as unknown as Node)).line;
		return line >= 0 && line < editor.lineCount() ? line : null;
	} catch {
		return null;
	}
}

/** A source line that starts a list item, after any `>` quote prefix. */
const QUOTED_LIST_ITEM = /^[\s>]*(?:[-*+]|\d+[.)])\s/;

/**
 * The source line of each list item of the callout that starts on `start`,
 * in order. The callout is the run of `>` lines from `start`.
 */
function calloutListItemLines(editor: Editor, start: number): number[] {
	const lines: number[] = [];
	for (let n = start; n < editor.lineCount(); n++) {
		const text = editor.getLine(n);
		if (!/^\s*>/.test(text)) break;
		if (QUOTED_LIST_ITEM.test(text)) lines.push(n);
	}
	return lines;
}

/**
 * The editor line of a task rendered inside a Live Preview callout widget.
 *
 * `posAtCoords` cannot say: for a block widget CM6 answers with the widget's
 * `from` or `to`, so every task in a callout would map to its first or last
 * line. Instead the line comes from the DOM. `posAtDOM(widget root)` is the
 * callout's first line. The rendered `li` then says which of its lines it
 * is, in one of two ways:
 *
 *  - its `data-line`, the offset inside the callout, when it has one;
 *  - otherwise (Obsidian 1.15 renders no `data-line` on a callout's `li`)
 *    its place among the widget's rendered list items, matched with the
 *    callout's list-item lines in order. That is trusted only if the
 *    widget has exactly as many `li` as the callout has list-item lines;
 *    a code block or anything else that breaks the count leaves it null.
 *
 * Null (the caller must then leave the event alone, never guess) if the
 * target is not in a callout widget, is in an embed (its lines are another
 * note's), cannot be matched to a line, or the editor cannot place the
 * widget. `renderedStatus` is the `li`'s `data-task` (Obsidian's copy of
 * the status char, " " for an empty one), or null if the `li` has none: the
 * caller checks it against the source line before writing.
 */
export function findLineInCalloutWidget(
	editor: Editor,
	target: WidgetElementLike | null
): { line: number; renderedStatus: string | null } | null {
	try {
		if (!target) return null;
		const widget = target.closest(".cm-embed-block");
		if (!widget || !target.closest(".callout, .cm-callout")) return null;
		if (target.closest(".markdown-embed, .internal-embed")) return null;
		const li = target.closest("li");
		if (!li) return null;
		const ext = editor as EditorWithCoords;
		const cm = ext.cm;
		if (!cm?.posAtDOM) return null;
		const start = ext.offsetToPos(cm.posAtDOM(widget as unknown as Node));
		let line: number;
		const dataLine = li.getAttribute("data-line");
		if (dataLine !== null) {
			const rel = Number(dataLine);
			if (!Number.isInteger(rel) || rel < 0) return null;
			line = start.line + rel;
		} else {
			const rendered = Array.from(widget.querySelectorAll("li"));
			const sourceLines = calloutListItemLines(editor, start.line);
			if (rendered.length !== sourceLines.length) return null;
			const at = rendered.indexOf(li);
			if (at < 0) return null;
			line = sourceLines[at];
		}
		if (line >= editor.lineCount()) return null;
		const task = li.getAttribute("data-task");
		return { line, renderedStatus: task === null ? null : task === "" ? " " : task };
	} catch {
		return null;
	}
}
