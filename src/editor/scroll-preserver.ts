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

/** What `restoreNow` left behind, so a later frame can tell a layout shift from a user scroll. */
interface Applied {
	/** `scrollTop` after the restore. */
	scrollTop: number;
	/** The anchor line's top at that moment; null when there is no anchor to compare. */
	blockTop: number | null;
}

/**
 * Put the scroll position back. With `previous` (a later frame), do nothing
 * and return null if the user scrolled since: the scroller moved but the
 * anchor line did not (a layout shift moves the anchor line, a user scroll
 * moves only `scrollTop`).
 */
function restoreNow(snap: ScrollSnapshot, previous?: Applied): Applied | null {
	const { el, view, anchorLine, anchorTop, scrollTop, top, left } = snap;
	if (!el) return null;
	const plain = (): Applied => {
		el.scrollTop = top;
		el.scrollLeft = left;
		return { scrollTop: el.scrollTop, blockTop: null };
	};
	try {
		const doc = view?.state?.doc;
		if (!view?.lineBlockAt || !doc || anchorLine == null || anchorTop == null) return plain();
		const line = doc.line(Math.min(Math.max(0, anchorLine), doc.lines - 1) + 1);
		const blockNow = view.lineBlockAt(line.from);
		if (!blockNow || typeof blockNow.top !== "number") return plain();
		if (
			previous &&
			previous.blockTop !== null &&
			el.scrollTop !== previous.scrollTop &&
			blockNow.top === previous.blockTop
		) {
			return null;
		}
		el.scrollTop = (scrollTop ?? top) + (blockNow.top - anchorTop);
		el.scrollLeft = left;
		return { scrollTop: el.scrollTop, blockTop: blockNow.top };
	} catch {
		return plain();
	}
}

/**
 * Put the scroll position back now and again on the next two animation
 * frames (Live Preview re-lays out after a write and can move it later). A
 * later frame stops at once if the user scrolled in between (see
 * `restoreNow`), so a scroll started right after a click is not snapped back.
 */
export function restoreEditorScrollLater(snap: ScrollSnapshot): void {
	let applied = restoreNow(snap);
	const raf = (
		globalThis as { requestAnimationFrame?: (cb: () => void) => number }
	).requestAnimationFrame;
	if (typeof raf !== "function" || applied === null) return;
	const again = (next?: () => void) => () => {
		const result = restoreNow(snap, applied ?? undefined);
		if (result === null) return;
		applied = result;
		next?.();
	};
	raf(again(() => raf(again())));
}
