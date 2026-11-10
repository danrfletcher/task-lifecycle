import type { Editor } from "obsidian";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEditorScroll, restoreEditorScrollLater } from "../../src/editor/scroll-preserver";

type Raf = (cb: () => void) => number;
const g = globalThis as { requestAnimationFrame?: Raf };

let frames: Array<() => void> = [];
let savedRaf: Raf | undefined;

/** Run the queued animation frame callbacks, one frame's worth. */
function nextFrame(): void {
	const run = frames;
	frames = [];
	run.forEach((cb) => cb());
}

beforeEach(() => {
	frames = [];
	savedRaf = g.requestAnimationFrame;
	g.requestAnimationFrame = (cb) => frames.push(cb);
});
afterEach(() => {
	g.requestAnimationFrame = savedRaf;
});

/** A CM-like editor whose anchor line sits at `block.top` and whose scroller is `scrollDOM`. */
function makeEditor(scrollTop: number, block: { top: number }) {
	const scrollDOM = { scrollTop, scrollLeft: 0 };
	const line = { number: 1, from: 0, to: 7 };
	const editor = {
		cm: {
			scrollDOM,
			viewport: { from: 0, to: 7 },
			state: { doc: { lines: 1, lineAt: () => line, line: () => line } },
			lineBlockAt: () => block,
		},
	} as unknown as Editor;
	return { editor, scrollDOM };
}

describe("restoreEditorScrollLater", () => {
	it("restores at once and again on the next two frames when layout moves the anchor", () => {
		const block = { top: 420 };
		const { editor, scrollDOM } = makeEditor(420, block);
		const snap = captureEditorScroll(editor);

		scrollDOM.scrollTop = 0; // the jump the write causes
		restoreEditorScrollLater(snap);
		expect(scrollDOM.scrollTop).toBe(420);

		// Live Preview re-lays out: content above the anchor grows by 30px.
		block.top = 450;
		nextFrame();
		expect(scrollDOM.scrollTop).toBe(450);

		block.top = 460;
		nextFrame();
		expect(scrollDOM.scrollTop).toBe(460);
	});

	it("does not snap back a scroll the user starts after the click", () => {
		const block = { top: 420 };
		const { editor, scrollDOM } = makeEditor(420, block);
		const snap = captureEditorScroll(editor);

		scrollDOM.scrollTop = 0;
		restoreEditorScrollLater(snap);
		expect(scrollDOM.scrollTop).toBe(420);

		scrollDOM.scrollTop = 500; // user scrolls; the anchor line did not move
		nextFrame();
		expect(scrollDOM.scrollTop).toBe(500);
		nextFrame();
		expect(scrollDOM.scrollTop).toBe(500);
	});

	it("falls back to the plain scrollTop when there is no anchor", () => {
		const scrollDOM = { scrollTop: 300, scrollLeft: 7 };
		const editor = { cm: { scrollDOM } } as unknown as Editor;
		const snap = captureEditorScroll(editor);

		scrollDOM.scrollTop = 0;
		scrollDOM.scrollLeft = 0;
		restoreEditorScrollLater(snap);
		expect(scrollDOM).toEqual({ scrollTop: 300, scrollLeft: 7 });

		scrollDOM.scrollTop = 0;
		nextFrame();
		expect(scrollDOM.scrollTop).toBe(300);
	});

	it("does nothing for an editor without a scroller", () => {
		const snap = captureEditorScroll({} as unknown as Editor);
		expect(() => restoreEditorScrollLater(snap)).not.toThrow();
		expect(frames).toHaveLength(0);
	});
});
