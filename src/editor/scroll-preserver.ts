/**
 * Scroll capture and restore around an editor write, anchored on the first
 * visible line with CM6 so the note does not jump.
 *
 * The scroller comes from `editor.cm.scrollDOM` (the view's own scroller, so
 * a second open note is never touched). The source's fallback of querying
 * the document for any `.cm-scroller` is not copied: with two views open it
 * could restore the wrong one.
 */
import type { Editor } from "obsidian";

export interface CmDocLike {
	lineAt(pos: number): { from: number; to: number; number: number };
	line(line: number): { from: number; to: number; number: number };
	readonly lines: number;
}

export interface CmEditorViewLike {
	state?: { doc: CmDocLike };
	viewport?: { from: number; to: number };
	scrollDOM?: ScrollerLike;
	lineBlockAt?(pos: number): { top: number };
	posAtDOM?(node: Node, offset?: number): number;
	posAtCoords?(
		coords: { x: number; y: number }
	): number | { pos: number } | { line: number; ch: number } | null;
}

/** The slice of an `HTMLElement` the scroller needs. */
export interface ScrollerLike {
	scrollTop: number;
	scrollLeft: number;
}

export interface ScrollSnapshot {
	el: ScrollerLike | null;
	top: number;
	left: number;
	view?: CmEditorViewLike;
	anchorLine?: number;
	anchorTop?: number;
	scrollTop?: number;
}

function isScroller(value: unknown): value is ScrollerLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ScrollerLike).scrollTop === "number" &&
		typeof (value as ScrollerLike).scrollLeft === "number"
	);
}

function cmOf(editor: Editor): CmEditorViewLike | undefined {
	return (editor as Editor & { cm?: CmEditorViewLike }).cm;
}

export function getEditorScroller(editor: Editor): ScrollerLike | null {
	const scroller = cmOf(editor)?.scrollDOM;
	return isScroller(scroller) ? scroller : null;
}

export function captureEditorScroll(editor: Editor): ScrollSnapshot {
	const el = getEditorScroller(editor);
	const snap: ScrollSnapshot = {
		el,
		top: el?.scrollTop ?? 0,
		left: el?.scrollLeft ?? 0,
	};

	try {
		const view = cmOf(editor);
		if (view?.state?.doc && view.viewport && view.lineBlockAt) {
			const doc = view.state.doc;
			const firstVisible = doc.lineAt(view.viewport.from).number - 1;
			const block = view.lineBlockAt(doc.line(firstVisible + 1).from);
			if (block && typeof block.top === "number") {
				snap.view = view;
				snap.anchorLine = firstVisible;
				snap.anchorTop = block.top;
				snap.scrollTop = el?.scrollTop ?? 0;
			}
		}
	} catch {
		// Soft fail: fall back to the plain scrollTop below.
	}
	return snap;
}

function restoreNow(snap: ScrollSnapshot): void {
	const { el, view, anchorLine, anchorTop, scrollTop, top, left } = snap;
	if (!el) return;
	try {
		const doc = view?.state?.doc;
		if (!view?.lineBlockAt || !doc || anchorLine == null || anchorTop == null) {
			el.scrollTop = top;
			el.scrollLeft = left;
			return;
		}
		const line = doc.line(Math.min(Math.max(0, anchorLine), doc.lines - 1) + 1);
		const blockNow = view.lineBlockAt(line.from);
		if (!blockNow || typeof blockNow.top !== "number") {
			el.scrollTop = top;
			el.scrollLeft = left;
			return;
		}
		el.scrollTop = (scrollTop ?? top) + (blockNow.top - anchorTop);
		el.scrollLeft = left;
	} catch {
		el.scrollTop = top;
		el.scrollLeft = left;
	}
}

/**
 * Put the scroll position back now and again on the next two animation
 * frames (Live Preview re-lays out after a write and can move it later).
 */
export function restoreEditorScrollLater(snap: ScrollSnapshot): void {
	restoreNow(snap);
	const raf = (
		globalThis as { requestAnimationFrame?: (cb: () => void) => number }
	).requestAnimationFrame;
	if (typeof raf !== "function") return;
	raf(() => {
		restoreNow(snap);
		raf(() => restoreNow(snap));
	});
}
