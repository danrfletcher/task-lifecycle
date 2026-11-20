// @vitest-environment happy-dom
// (happy-dom, not jsdom: it is the DOM environment already in package.json.)
/**
 * The press handler through the real code path: a real `TaskLifecyclePlugin`
 * (so the real wiring, settings store and change detector), real DOM events
 * dispatched at a Live Preview DOM, and a fake `Editor` that writes into a
 * real CodeMirror `EditorState`, so a click's write goes through the change
 * detector exactly as in Obsidian.
 *
 * Coordinates encode the editor position: `clientX` is the column and
 * `clientY / 10` the line, and the fake `cm.posAtCoords` decodes them.
 */
import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskLifecyclePlugin from "../../src/main";
import { STATUS_CHANGED_EVENT } from "../../src/events/event-bus";
import { editorInfoField, App, Notice } from "../__mocks__/obsidian";

const TODAY = "2026-11-09";

interface Seen {
	file: unknown;
	line: number;
	from: string;
	to: string;
}

class FakeEditor {
	state: EditorState;
	replaceCalls = 0;
	scrollDOM: HTMLElement;
	/** When set, every write throws the scroll position to 0 (the jump a re-layout can cause). */
	jumpOnWrite = false;
	/**
	 * When set, `posAtCoords` answers with this line whatever the pointer is
	 * over: a layout that has not been re-measured since the last write (the
	 * second of two presses 0 ms apart in the real app maps to the wrong line).
	 */
	staleCoordsLine: number | null = null;
	/** The rendered `.cm-line` element of each source line, set by `buildView`. */
	lineEls: HTMLElement[] = [];
	cm: unknown;
	/**
	 * A rendered block widget: CM6 answers `posAtCoords` for a pointer over it
	 * with the widget's `from` (top half) or `to` (bottom half), whatever
	 * is under the pointer; `posAtDOM(widget)` is its `from`.
	 */
	widget: { from: number; to: number; el: HTMLElement; top: number; bottom: number } | null =
		null;

	constructor(
		doc: string,
		file: { path: string },
		extensions: unknown[],
		scrollDOM: HTMLElement
	) {
		this.scrollDOM = scrollDOM;
		this.state = EditorState.create({
			doc,
			extensions: [editorInfoField.init(() => ({ file })), ...(extensions as never[])],
		});
		const cm = {
			scrollDOM,
			viewport: { from: 0, to: this.state.doc.length },
			state: { doc: undefined as unknown },
			lineBlockAt: () => ({ top: 0 }),
			posAtCoords: ({ x, y }: { x: number; y: number }) => {
				const w = this.widget;
				if (w && y >= w.top && y <= w.bottom) return y < (w.top + w.bottom) / 2 ? w.from : w.to;
				const line =
					this.staleCoordsLine ?? Math.min(Math.round(y / 10), this.state.doc.lines - 1);
				return this.state.doc.line(line + 1).from + x;
			},
			posAtDOM: (node: Node) => {
				if (this.widget?.el.contains(node)) return this.widget.from;
				const row = this.lineEls.findIndex((el) => el.contains(node));
				if (row >= 0) return this.state.doc.line(row + 1).from;
				throw new RangeError("not in the document");
			},
		};
		Object.defineProperty(cm.state, "doc", { get: () => this.state.doc });
		this.cm = cm;
	}
	getLine(n: number): string {
		return this.state.doc.line(n + 1).text;
	}
	lineCount(): number {
		return this.state.doc.lines;
	}
	offsetToPos(offset: number): { line: number; ch: number } {
		const l = this.state.doc.lineAt(offset);
		return { line: l.number - 1, ch: offset - l.from };
	}
	private off(p: { line: number; ch: number }): number {
		return this.state.doc.line(p.line + 1).from + p.ch;
	}
	replaceRange(
		text: string,
		from: { line: number; ch: number },
		to?: { line: number; ch: number }
	): void {
		this.replaceCalls++;
		const f = this.off(from);
		const t = to ? this.off(to) : f;
		this.state = this.state.update({ changes: { from: f, to: t, insert: text } }).state;
		if (this.jumpOnWrite) this.scrollDOM.scrollTop = 0;
	}
	doc(): string {
		return this.state.doc.toString();
	}
}

interface View {
	contentEl: HTMLElement;
	editor: FakeEditor;
	file: { path: string };
	scroller: HTMLElement;
	checkbox(line: number): HTMLElement;
	li(line: number): HTMLElement;
	text(line: number): HTMLElement;
	/** Add an element with `className` inside the line's `li`, and return it. */
	child(line: number, tag: string, className: string): HTMLElement;
}

const TASK_RE = /^[\s>]*(?:[-*+]|\d+[.)])\s+\[.\]/;

function buildView(
	lines: string[],
	path: string,
	extensions: unknown[],
	mode: "live-preview" | "source" | "reading" = "live-preview"
): View {
	const contentEl = document.createElement("div");
	contentEl.className = "view-content";
	const surface = document.createElement("div");
	surface.className =
		mode === "live-preview"
			? "markdown-source-view cm-s-obsidian mod-cm6 is-live-preview"
			: mode === "source"
				? "markdown-source-view cm-s-obsidian mod-cm6"
				: "markdown-reading-view";
	const scroller = document.createElement("div");
	scroller.className = "cm-scroller";
	surface.append(scroller);
	contentEl.append(surface);
	document.body.append(contentEl);

	const rows: Array<{ li: HTMLElement; input: HTMLElement | null; text: HTMLElement }> = [];
	lines.forEach((line) => {
		const row = document.createElement("div");
		row.className = "cm-line";
		const ul = document.createElement("ul");
		const li = document.createElement("li");
		li.className = "task-list-item";
		const text = document.createElement("span");
		text.className = "cm-text";
		text.textContent = line;
		let input: HTMLElement | null = null;
		if (TASK_RE.test(line)) {
			input = document.createElement("input");
			input.className = "task-list-item-checkbox";
			input.setAttribute("type", "checkbox");
			li.append(input);
		}
		li.append(text);
		ul.append(li);
		row.append(ul);
		scroller.append(row);
		rows.push({ li, input, text });
	});

	const file = { path };
	const editor = new FakeEditor(lines.join("\n"), file, extensions, scroller);
	editor.lineEls = Array.from(scroller.querySelectorAll<HTMLElement>(":scope > .cm-line"));
	return {
		contentEl,
		editor,
		file,
		scroller,
		checkbox: (n) => rows[n].input as HTMLElement,
		li: (n) => rows[n].li,
		text: (n) => rows[n].text,
		child(n, tag, className) {
			const e = document.createElement(tag);
			e.className = className;
			rows[n].li.prepend(e);
			return e;
		},
	};
}

interface Rig {
	plugin: TaskLifecyclePlugin & {
		domListenerCount: number;
		unload(): void;
		editorExtensions: unknown[];
	};
	app: App;
	views: View[];
	seen: Seen[];
}

async function setup(
	docs: string[][],
	opts: { settings?: Record<string, boolean>; mode?: "live-preview" | "source" | "reading" } = {}
): Promise<Rig> {
	const app = new App();
	const plugin = new (TaskLifecyclePlugin as unknown as new (
		app: App
	) => Rig["plugin"] & { dataFile: unknown })(app);
	plugin.dataFile = opts.settings;
	await plugin.onload();
	const seen: Seen[] = [];
	plugin.events.on(STATUS_CHANGED_EVENT, (p) =>
		seen.push({ file: (p.file as { path: string } | null)?.path, line: p.line, from: p.from, to: p.to })
	);
	const views = docs.map((lines, i) =>
		buildView(lines, `note-${i}.md`, plugin.editorExtensions, opts.mode)
	);
	app.workspace.leaves = views.map((v) => ({
		view: { contentEl: v.contentEl, editor: v.editor, file: v.file },
	}));
	return { plugin, app, views, seen };
}

type Pos = { x: number; y: number };

/** Dispatch a pointer event at `target`; `pos` is the editor position it encodes. */
function pointer(
	type: string,
	target: Element,
	pos: Pos,
	init: PointerEventInit = {}
): PointerEvent {
	const evt = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		composed: true,
		isPrimary: true,
		button: 0,
		pointerType: "mouse",
		clientX: pos.x,
		clientY: pos.y,
		...init,
	});
	target.dispatchEvent(evt);
	return evt;
}

function click(target: Element, pos: Pos): MouseEvent {
	const evt = new MouseEvent("click", {
		bubbles: true,
		cancelable: true,
		composed: true,
		clientX: pos.x,
		clientY: pos.y,
	});
	target.dispatchEvent(evt);
	return evt;
}

/** Where the editor says a pointer over line `line` at column `ch` is. */
const at = (line: number, ch: number): Pos => ({ x: ch, y: line * 10 });

/** One physical click: down, up, then the click the browser sends. */
function physicalClick(target: Element, pos: Pos) {
	const down = pointer("pointerdown", target, pos);
	const up = pointer("pointerup", target, pos);
	const clk = click(target, pos);
	return { down, up, clk };
}

const DEMO = [
	"- [ ] Ship release ^rel1",
	"\t- [ ] Write notes",
	"\t- Notes",
	"\t\t- [ ] Proofread",
	"\t- [x] Tag build ✅ 2026-11-08",
	"- [ ] Book venue",
];

let rig: Rig;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 10, 9, 12, 0, 0));
	document.body.innerHTML = "";
	document.body.className = "";
});
afterEach(() => {
	rig?.plugin.unload();
	vi.useRealTimers();
	document.body.innerHTML = "";
	document.body.className = "";
});

describe("G1 + GP: a short click cycles, the native toggle never fires", () => {
	it("GP1, GP2, GP5, GP6 on 'Ship release'; every other line is byte-identical", async () => {
		rig = await setup([DEMO]);
		const v = rig.views[0];
		const others = (doc: string) => doc.split("\n").slice(1).join("\n");
		const seed = v.editor.doc();
		const steps = [
			"- [/] Ship release ^rel1",
			`- [x] Ship release ✅ ${TODAY} ^rel1`,
			`- [-] Ship release ❌ ${TODAY} ^rel1`,
			"- [ ] Ship release ^rel1",
		];
		for (const expected of steps) {
			const { down, up, clk } = physicalClick(v.checkbox(0), at(0, 3));
			expect(down.defaultPrevented).toBe(false); // selection can still start
			expect(up.defaultPrevented).toBe(true);
			expect(clk.defaultPrevented).toBe(true); // native toggle never runs
			expect(v.editor.getLine(0)).toBe(expected);
			expect(others(v.editor.doc())).toBe(others(seed));
			vi.advanceTimersByTime(1000);
		}
		expect(v.editor.doc()).toBe(seed);
		expect(rig.seen.map((e) => `${e.from}>${e.to}`)).toEqual([" >/", "/>x", "x>-", "-> "]);
	});

	it("one click is exactly one write and one status-changed event", async () => {
		rig = await setup([["- [ ] a", "- [ ] b"]]);
		const v = rig.views[0];
		physicalClick(v.checkbox(1), at(1, 3));
		expect(v.editor.replaceCalls).toBe(1);
		expect(rig.seen).toEqual([{ file: "note-0.md", line: 1, from: " ", to: "/" }]);
		expect(v.editor.getLine(0)).toBe("- [ ] a");
	});

	it("the write is one replaceRange of one char (line length unchanged before the stamp)", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		const spy = vi.spyOn(v.editor, "replaceRange");
		physicalClick(v.checkbox(0), at(0, 3));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith("/", { line: 0, ch: 3 }, { line: 0, ch: 4 });
	});

	it("X counts as x: [X] goes to [-]", async () => {
		rig = await setup([["- [X] a"]]);
		physicalClick(rig.views[0].checkbox(0), at(0, 3));
		expect(rig.views[0].editor.getLine(0)).toBe(`- [-] a ❌ ${TODAY}`);
		expect(rig.seen).toEqual([{ file: "note-0.md", line: 0, from: "X", to: "-" }]);
	});

	it("E3: [?] goes to [ ] with no stamp and the event {from:'?', to:' '}", async () => {
		rig = await setup([["- [?] Ask"]]);
		physicalClick(rig.views[0].checkbox(0), at(0, 3));
		expect(rig.views[0].editor.getLine(0)).toBe("- [ ] Ask");
		expect(rig.seen).toEqual([{ file: "note-0.md", line: 0, from: "?", to: " " }]);
	});

	it("GP8: with Close stamps off, two clicks give [x] and no stamp", async () => {
		rig = await setup([["- [ ] Call caterer"]], { settings: { closeStamps: false } });
		const v = rig.views[0];
		physicalClick(v.checkbox(0), at(0, 3));
		vi.advanceTimersByTime(1000);
		physicalClick(v.checkbox(0), at(0, 3));
		expect(v.editor.getLine(0)).toBe("- [x] Call caterer");
	});

	it("only pointer events drive it: mouse/touch duplicates do nothing", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		for (const type of ["mousedown", "mouseup", "touchstart", "touchend"]) {
			v.checkbox(0).dispatchEvent(
				new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 3, clientY: 0 })
			);
		}
		expect(v.editor.getLine(0)).toBe("- [ ] a");
		expect(rig.seen).toEqual([]);
	});

	it("two quick clicks (50 ms apart, each with its own pointerdown) advance two steps", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		physicalClick(v.checkbox(0), at(0, 3));
		vi.advanceTimersByTime(50);
		const second = physicalClick(v.checkbox(0), at(0, 3));
		expect(v.editor.getLine(0)).toBe(`- [x] a ✅ ${TODAY}`);
		expect(second.clk.defaultPrevented).toBe(true);
		expect(rig.seen.map((e) => e.to)).toEqual(["/", "x"]);
	});

	it("two presses with no gap at all (0 ms, as a scripted mouse sends them) advance two steps", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		const box = v.checkbox(0);
		// down, up, down, up, then the two clicks: nothing between them.
		pointer("pointerdown", box, at(0, 3));
		const up1 = pointer("pointerup", box, at(0, 3));
		pointer("pointerdown", box, at(0, 3));
		const up2 = pointer("pointerup", box, at(0, 3));
		const clk1 = click(box, at(0, 3));
		const clk2 = click(box, at(0, 3));
		expect(v.editor.getLine(0)).toBe(`- [x] a ✅ ${TODAY}`);
		expect(rig.seen.map((e) => `${e.from}>${e.to}`)).toEqual([" >/", "/>x"]);
		expect([up1, up2, clk1, clk2].map((e) => e.defaultPrevented)).toEqual([true, true, true, true]);
	});

	it("a press writes the task under the pointer when it went down, even 0 ms after another press (the page can scroll between them)", async () => {
		rig = await setup([["- [ ] a", "- [ ] b"]]);
		const v = rig.views[0];
		physicalClick(v.checkbox(0), at(0, 3));
		// The layout moved under a still pointer: the second press is on b's checkbox.
		physicalClick(v.checkbox(1), at(1, 3));
		expect(v.editor.getLine(0)).toBe("- [/] a");
		expect(v.editor.getLine(1)).toBe("- [/] b");
		expect(rig.seen.map((e) => `${e.line}:${e.from}>${e.to}`)).toEqual(["0: >/", "1: >/"]);
	});

	it("T5: the line comes from the pressed element, not from posAtCoords against a layout not yet re-measured", async () => {
		rig = await setup([["- [ ] a", "- [ ] b", "- [ ] c"]]);
		const v = rig.views[0];
		// Every press maps to line 2 ('c') through the coordinates, as in the app
		// right after a write; the pressed checkbox is a's, then b's.
		v.editor.staleCoordsLine = 2;
		const first = physicalClick(v.checkbox(0), at(2, 3));
		const second = physicalClick(v.checkbox(1), at(2, 3));
		expect(v.editor.doc()).toBe("- [/] a\n- [/] b\n- [ ] c");
		expect(rig.seen.map((e) => `${e.line}:${e.from}>${e.to}`)).toEqual(["0: >/", "1: >/"]);
		expect([first.clk, second.clk].map((e) => e.defaultPrevented)).toEqual([true, true]);
	});

	it("T5: the same two presses on one task, 0 ms apart, advance that task twice even if the coordinates name another line", async () => {
		rig = await setup([["- [ ] a", "- [ ] b", "- [ ] c"]]);
		const v = rig.views[0];
		v.editor.staleCoordsLine = 2;
		const box = v.checkbox(0);
		pointer("pointerdown", box, at(2, 3));
		pointer("pointerup", box, at(2, 3));
		pointer("pointerdown", box, at(2, 3));
		pointer("pointerup", box, at(2, 3));
		click(box, at(2, 3));
		click(box, at(2, 3));
		expect(v.editor.doc()).toBe(`- [x] a ✅ ${TODAY}\n- [ ] b\n- [ ] c`);
	});

	it("T5: a checkbox the editor cannot place from the DOM writes nothing, and no line is guessed from coordinates", async () => {
		rig = await setup([["- [ ] a", "- [ ] b"]]);
		const v = rig.views[0];
		(v.editor.cm as { posAtDOM: () => number }).posAtDOM = () => {
			throw new RangeError("not in the document");
		};
		const { down, up } = physicalClick(v.checkbox(1), at(1, 3));
		vi.advanceTimersByTime(1000);
		expect(down.defaultPrevented || up.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
		expect(v.editor.doc()).toBe("- [ ] a\n- [ ] b");
	});

	it("keeps .cm-scroller scrollTop when the write would move it", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		v.scroller.scrollTop = 300;
		v.editor.jumpOnWrite = true;
		physicalClick(v.checkbox(0), at(0, 3));
		vi.advanceTimersByTime(100);
		expect(v.editor.getLine(0)).toBe("- [/] a");
		expect(v.scroller.scrollTop).toBe(300);
	});
});

describe("G2 + GP7: long press", () => {
	it("sets - when the timer fires, before release; release and click are swallowed", async () => {
		rig = await setup([DEMO]);
		const v = rig.views[0];
		const after = { up: vi.fn(), click: vi.fn() };
		document.addEventListener("pointerup", after.up);
		document.addEventListener("click", after.click, true);

		pointer("pointerdown", v.checkbox(5), at(5, 3));
		vi.advanceTimersByTime(499);
		expect(v.editor.getLine(5)).toBe("- [ ] Book venue");
		vi.advanceTimersByTime(1);
		expect(v.editor.getLine(5)).toBe(`- [-] Book venue ❌ ${TODAY}`);
		expect(rig.seen).toEqual([{ file: "note-0.md", line: 5, from: " ", to: "-" }]);

		vi.advanceTimersByTime(600); // still held
		const up = pointer("pointerup", v.checkbox(5), at(5, 3));
		expect(up.defaultPrevented).toBe(true);
		expect(after.up).not.toHaveBeenCalled(); // stopImmediatePropagation
		vi.advanceTimersByTime(100);
		const clk = click(v.checkbox(5), at(5, 3));
		expect(clk.defaultPrevented).toBe(true);
		expect(after.click).not.toHaveBeenCalled();

		// Release did not advance it, and nothing else was written.
		expect(v.editor.getLine(5)).toBe(`- [-] Book venue ❌ ${TODAY}`);
		expect(v.editor.replaceCalls).toBe(1);
		expect(rig.seen).toHaveLength(1);
		document.removeEventListener("pointerup", after.up);
		document.removeEventListener("click", after.click, true);
	});

	it("a long press on [x] writes [-]; PR-3 swaps ✅ for ❌; the event is {x, -}", async () => {
		rig = await setup([["- [x] Done ✅ 2026-11-01"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		vi.advanceTimersByTime(500);
		expect(v.editor.getLine(0)).toBe(`- [-] Done ❌ ${TODAY}`);
		expect(rig.seen).toEqual([{ file: "note-0.md", line: 0, from: "x", to: "-" }]);
	});

	it("a long press on [-] makes no write and emits no event", async () => {
		rig = await setup([["- [-] Gone ❌ 2026-11-01"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		vi.advanceTimersByTime(500);
		const up = pointer("pointerup", v.checkbox(0), at(0, 3));
		expect(v.editor.replaceCalls).toBe(0);
		expect(rig.seen).toEqual([]);
		expect(up.defaultPrevented).toBe(true); // release still swallowed: no advance
		expect(v.editor.getLine(0)).toBe("- [-] Gone ❌ 2026-11-01");
	});

	it.each([" ", "/", "?"])("a long press on [%s] writes [-]", async (ch) => {
		rig = await setup([[`- [${ch}] Task`]]);
		pointer("pointerdown", rig.views[0].checkbox(0), at(0, 3));
		vi.advanceTimersByTime(500);
		expect(rig.views[0].editor.getLine(0)).toBe(`- [-] Task ❌ ${TODAY}`);
		expect(rig.seen).toEqual([{ file: "note-0.md", line: 0, from: ch, to: "-" }]);
	});
});

describe("G3: targets that must pass through", () => {
	const classes = [
		"cm-fold-indicator",
		"collapse-indicator",
		"collapse-icon",
		"cm-foldPlaceholder",
		"HyperMD-list-bullet",
		"list-bullet",
	];

	it.each(classes)("a press on .%s is not intercepted", async (cls) => {
		rig = await setup([DEMO]);
		const v = rig.views[0];
		const target = v.child(0, "span", cls);
		// The editor maps the pointer onto the token: only the class excludes it.
		const { down, up, clk } = physicalClick(target, at(0, 3));
		vi.advanceTimersByTime(1000);
		expect(down.defaultPrevented).toBe(false);
		expect(up.defaultPrevented).toBe(false);
		expect(clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
		expect(rig.seen).toEqual([]);
	});

	it("a hold on a chevron writes nothing", async () => {
		rig = await setup([DEMO]);
		const target = rig.views[0].child(0, "span", "collapse-indicator");
		pointer("pointerdown", target, at(0, 3));
		vi.advanceTimersByTime(2000);
		expect(rig.views[0].editor.replaceCalls).toBe(0);
	});

	it("the LI padding (the li itself) is not intercepted", async () => {
		rig = await setup([DEMO]);
		const v = rig.views[0];
		const { down, up, clk } = physicalClick(v.li(0), at(0, 3));
		expect(down.defaultPrevented || up.defaultPrevented || clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("a click on the text after ] only places the cursor", async () => {
		rig = await setup([DEMO]);
		const v = rig.views[0];
		const { down, up, clk } = physicalClick(v.text(0), at(0, 8));
		vi.advanceTimersByTime(1000);
		expect(down.defaultPrevented || up.defaultPrevented || clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("a label click just after ] (exclusive bound) is not intercepted, on the token it is", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		const label = document.createElement("label");
		v.li(0).append(label);
		const after = physicalClick(label, at(0, 5)); // just after "]"
		expect(after.clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
		const on = physicalClick(label, at(0, 4)); // on "]"
		expect(on.clk.defaultPrevented).toBe(true);
		expect(v.editor.getLine(0)).toBe("- [/] a");
	});
});

describe("G4: every list marker, blockquotes, callouts, nesting", () => {
	const lines = [
		"1. [ ] ordered dot",
		"1) [ ] ordered paren",
		"* [ ] star",
		"+ [ ] plus",
		"> - [ ] blockquote",
		"> [!note] Callout",
		"> - [ ] callout body",
		"> > 2) [ ] nested callout",
		"\t\t\t- [ ] deep",
		"  \t* [ ] mixed indent",
	];

	it.each(lines.map((l, i) => [l, i] as const).filter(([l]) => /\[ \]/.test(l)))(
		"%j cycles",
		async (line, i) => {
			rig = await setup([lines]);
			const v = rig.views[0];
			const ch = line.indexOf("[") + 1;
			const { clk } = physicalClick(v.checkbox(i), at(i, ch));
			expect(clk.defaultPrevented).toBe(true);
			expect(v.editor.getLine(i)).toBe(line.replace("[ ]", "[/]"));
			expect(rig.seen).toEqual([{ file: "note-0.md", line: i, from: " ", to: "/" }]);
		}
	);

	it("the callout title line has no checkbox and nothing happens", async () => {
		rig = await setup([lines]);
		const v = rig.views[0];
		physicalClick(v.text(5), at(5, 3));
		expect(v.editor.replaceCalls).toBe(0);
	});
});

describe("G4: callout bodies rendered as a Live Preview block widget (R1)", () => {
	const lines = [
		"- [ ] before",
		"> [!note] Callout",
		"> - [ ] first",
		"> - [x] second ✅ 2026-11-08",
		"> - [ ] third",
		"- [ ] after",
	];
	const START = 1;
	const END = 4;
	const TOP = 1000;
	const BOTTOM = 1100;
	/** A pointer over the widget, in its top or its bottom half. */
	const overWidget = (half: "top" | "bottom"): Pos => ({ x: 3, y: half === "top" ? TOP + 5 : BOTTOM - 5 });

	interface Callout {
		el: HTMLElement;
		/** The checkbox of source line `n`. */
		checkbox(n: number): HTMLElement;
		li(n: number): HTMLElement;
	}

	/** Replace the plain rows of lines START..END with one `.cm-embed-block` callout widget. */
	async function calloutRig(
		opts: {
			settings?: Record<string, boolean>;
			embed?: boolean;
			dataLine?: (n: number) => string | null;
		} = {}
	): Promise<{ v: View; callout: Callout }> {
		rig = await setup([lines], { settings: opts.settings });
		const v = rig.views[0];
		const rows = Array.from(v.scroller.children);
		for (let i = START; i <= END; i++) rows[i].remove();

		const el = document.createElement("div");
		el.className = "cm-embed-block markdown-rendered cm-callout";
		const callout = document.createElement("div");
		callout.className = "callout";
		const body = document.createElement("div");
		body.className = "callout-content";
		const ul = document.createElement("ul");
		const boxes = new Map<number, HTMLElement>();
		const lis = new Map<number, HTMLElement>();
		for (let n = START + 1; n <= END; n++) {
			const li = document.createElement("li");
			li.className = "task-list-item";
			// The rendered li's line, counted from the callout's first line.
			const rel = opts.dataLine ? opts.dataLine(n) : String(n - START);
			if (rel !== null) li.setAttribute("data-line", rel);
			const status = lines[n].match(/\[(.)\]/)![1];
			li.setAttribute("data-task", status === " " ? "" : status);
			const label = document.createElement("label");
			label.className = "task-list-label";
			const input = document.createElement("input");
			input.className = "task-list-item-checkbox";
			input.setAttribute("type", "checkbox");
			label.append(input);
			li.append(label);
			ul.append(li);
			boxes.set(n, input);
			lis.set(n, li);
		}
		body.append(ul);
		callout.append(body);
		el.append(callout);
		if (opts.embed) {
			const embed = document.createElement("div");
			embed.className = "markdown-embed";
			embed.append(callout);
			el.append(embed);
		}
		v.scroller.append(el);

		const doc = v.editor.state.doc;
		v.editor.widget = {
			from: doc.line(START + 1).from,
			to: doc.line(END + 1).to,
			el,
			top: TOP,
			bottom: BOTTOM,
		};
		return { v, callout: { el, checkbox: (n) => boxes.get(n)!, li: (n) => lis.get(n)! } };
	}

	it.each([
		["top", 2, "> - [/] first"],
		["top", 4, "> - [/] third"],
		["bottom", 2, "> - [/] first"],
		["bottom", 4, "> - [/] third"],
	] as const)(
		"a click on callout task %s-half, line %i, cycles exactly that line even though posAtCoords says from/to",
		async (half, n, expected) => {
			const { v, callout } = await calloutRig();
			const before = v.editor.doc().split("\n");
			// posAtCoords really is the widget's from/to, never the pressed line.
			const hit = (v.editor.cm as { posAtCoords(c: Pos): number }).posAtCoords(overWidget(half));
			expect([v.editor.widget!.from, v.editor.widget!.to]).toContain(hit);

			const { down, clk } = physicalClick(callout.checkbox(n), overWidget(half));
			expect(down.defaultPrevented).toBe(false); // pointerdown is never prevented
			expect(clk.defaultPrevented).toBe(true); // native toggle blocked
			const after = v.editor.doc().split("\n");
			expect(after[n]).toBe(expected);
			// Only that one line changed.
			expect(after.filter((l, i) => l !== before[i])).toHaveLength(1);
			expect(v.editor.replaceCalls).toBe(1);
			expect(rig.seen).toEqual([{ file: "note-0.md", line: n, from: " ", to: "/" }]);
		}
	);

	it("a long press on a callout task writes `-` to that task's line and swallows the release and click", async () => {
		const { v, callout } = await calloutRig();
		const pos = overWidget("bottom");
		pointer("pointerdown", callout.checkbox(2), pos);
		vi.advanceTimersByTime(500);
		expect(v.editor.getLine(2)).toBe(`> - [-] first ❌ ${TODAY}`);
		const up = pointer("pointerup", callout.checkbox(2), pos);
		const clk = click(callout.checkbox(2), pos);
		expect(up.defaultPrevented).toBe(true);
		expect(clk.defaultPrevented).toBe(true);
		expect(v.editor.getLine(2)).toBe(`> - [-] first ❌ ${TODAY}`);
		expect(v.editor.getLine(4)).toBe("> - [ ] third");
		expect(v.editor.replaceCalls).toBe(1);
	});

	it("a click on a callout task cycles the stamped [x] line, not the callout's first or last line", async () => {
		const { v, callout } = await calloutRig();
		physicalClick(callout.checkbox(3), overWidget("top"));
		expect(v.editor.getLine(3)).toBe(`> - [-] second ❌ ${TODAY}`);
		expect(v.editor.getLine(1)).toBe("> [!note] Callout");
		expect(v.editor.getLine(4)).toBe("> - [ ] third");
	});

	it("tasks outside the widget still map through posAtCoords", async () => {
		const { v } = await calloutRig();
		const after = v.checkbox(5);
		physicalClick(after, at(5, 3));
		expect(v.editor.getLine(5)).toBe("- [/] after");
		expect(v.editor.getLine(4)).toBe("> - [ ] third");
	});

	it.each([
		[2, "> - [/] first"],
		[3, `> - [-] second ❌ ${TODAY}`],
		[4, "> - [/] third"],
	] as const)(
		"a widget li with no data-line (Obsidian 1.15) is placed by its order among the callout's list items: line %i",
		async (n, expected) => {
			const { v, callout } = await calloutRig({ dataLine: () => null });
			const before = v.editor.doc().split("\n");
			const { down, clk } = physicalClick(callout.checkbox(n), overWidget(n === 2 ? "top" : "bottom"));
			expect(down.defaultPrevented).toBe(false);
			expect(clk.defaultPrevented).toBe(true);
			const after = v.editor.doc().split("\n");
			expect(after[n]).toBe(expected);
			expect(after.filter((l, i) => l !== before[i])).toHaveLength(1);
			expect(v.editor.replaceCalls).toBe(1);
			expect(rig.seen.map((e) => e.line)).toEqual([n]);
		}
	);

	it("with no data-line, a long press on a callout task writes `-` to that task's line only", async () => {
		const { v, callout } = await calloutRig({ dataLine: () => null });
		const pos = overWidget("bottom");
		pointer("pointerdown", callout.checkbox(4), pos);
		vi.advanceTimersByTime(500);
		expect(v.editor.getLine(4)).toBe(`> - [-] third ❌ ${TODAY}`);
		expect(v.editor.getLine(2)).toBe("> - [ ] first");
		expect(v.editor.replaceCalls).toBe(1);
	});

	it("with no data-line, a widget whose li count differs from the callout's list-item lines is left alone", async () => {
		const { v, callout } = await calloutRig({ dataLine: () => null });
		// A rendered li the source has no list-item line for (e.g. one from a code block).
		callout.el.querySelector("ul")!.append(document.createElement("li"));
		const { down, up, clk } = physicalClick(callout.checkbox(2), overWidget("top"));
		vi.advanceTimersByTime(1000);
		expect(down.defaultPrevented || up.defaultPrevented || clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("with no data-line, a rendered status that disagrees with the matched source line is left alone", async () => {
		const { v, callout } = await calloutRig({ dataLine: () => null });
		callout.li(2).setAttribute("data-task", "x");
		const { clk } = physicalClick(callout.checkbox(2), overWidget("top"));
		expect(clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("a rendered status that disagrees with the source line (wrong offset) is left alone", async () => {
		// data-line 2 for the second task: that resolves to line 3 ([x]) while the rendered li says ` `.
		const { v, callout } = await calloutRig({ dataLine: (n) => String(n === 2 ? 2 : n - START) });
		const { clk } = physicalClick(callout.checkbox(2), overWidget("top"));
		expect(clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("an embed inside the widget is the embed handler's, not this one's: no write in the host note, native toggle suppressed, G10 notice (embed has no src)", async () => {
		// The embed press feature (this plan's G1, G10) owns every checkbox inside an
		// embed. Here the embed has no `src`, so it cannot be mapped: nothing is
		// written, the native toggle is still suppressed and the notice is shown.
		const { v, callout } = await calloutRig({ embed: true });
		Notice.reset();
		const before = v.editor.doc();
		const { clk } = physicalClick(callout.checkbox(2), overWidget("top"));
		expect(clk.defaultPrevented).toBe(true);
		expect(v.editor.replaceCalls).toBe(0);
		expect(v.editor.doc()).toBe(before);
		expect(Notice.shown).toEqual([
			"Task Lifecycle: couldn't find this task's source line, nothing changed",
		]);
	});

	it("with Status cycle off a callout click is left to the native toggle", async () => {
		const { v, callout } = await calloutRig({ settings: { statusCycle: false } });
		const box = callout.checkbox(2);
		const { down, up, clk } = physicalClick(box, overWidget("top"));
		expect(down.defaultPrevented || up.defaultPrevented || clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});
});

describe("G5 + E15: touch and drags", () => {
	const touch = { pointerType: "touch" };

	it("a clean tap behaves as a click", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3), touch);
		pointer("pointerup", v.checkbox(0), at(0, 3), touch);
		const clk = click(v.checkbox(0), at(0, 3));
		expect(v.editor.getLine(0)).toBe("- [/] a");
		expect(clk.defaultPrevented).toBe(true);
	});

	it("a 500 ms hold behaves as a long press, and the context menu is prevented", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3), touch);
		const early = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		v.checkbox(0).dispatchEvent(early);
		expect(early.defaultPrevented).toBe(true);
		vi.advanceTimersByTime(500);
		expect(v.editor.getLine(0)).toBe(`- [-] a ❌ ${TODAY}`);
		const late = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		v.checkbox(0).dispatchEvent(late);
		expect(late.defaultPrevented).toBe(true);
		pointer("pointerup", v.checkbox(0), at(0, 3), touch);
		expect(v.editor.getLine(0)).toBe(`- [-] a ❌ ${TODAY}`);
		expect(v.editor.replaceCalls).toBe(1);
	});

	it("the context menu is left alone when no press is active", async () => {
		rig = await setup([["- [ ] a"]]);
		const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		rig.views[0].checkbox(0).dispatchEvent(evt);
		expect(evt.defaultPrevented).toBe(false);
	});

	it("E15: pointerdown then pointercancel (a scroll) writes nothing, at any time", async () => {
		for (const wait of [0, 200, 499]) {
			rig = await setup([["- [ ] a"]]);
			const v = rig.views[0];
			pointer("pointerdown", v.checkbox(0), at(0, 3), touch);
			vi.advanceTimersByTime(wait);
			pointer("pointercancel", v.checkbox(0), at(0, 3), touch);
			vi.advanceTimersByTime(2000);
			expect(v.editor.getLine(0)).toBe("- [ ] a");
			expect(v.editor.replaceCalls).toBe(0);
			expect(rig.seen).toEqual([]);
			rig.plugin.unload();
			document.body.innerHTML = "";
		}
	});

	it("E15: pointerdown, a move of more than 5 px, then pointerup writes nothing", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3), touch);
		pointer("pointermove", v.checkbox(0), { x: 3, y: 12 }, touch);
		const up = pointer("pointerup", v.checkbox(0), { x: 3, y: 12 }, touch);
		vi.advanceTimersByTime(2000);
		expect(v.editor.replaceCalls).toBe(0);
		expect(rig.seen).toEqual([]);
		expect(up.defaultPrevented).toBe(false);
	});

	it("a move of more than 5 px during a hold stops the long press", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3), touch);
		vi.advanceTimersByTime(300);
		pointer("pointermove", v.checkbox(0), { x: 3 + 6, y: 0 }, touch);
		vi.advanceTimersByTime(2000);
		expect(v.editor.replaceCalls).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a small wobble (5 px) does not stop it", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3), touch);
		pointer("pointermove", v.checkbox(0), { x: 3 + 3, y: 4 }, touch);
		vi.advanceTimersByTime(500);
		expect(v.editor.getLine(0)).toBe(`- [-] a ❌ ${TODAY}`);
	});

	it("a second finger cancels the press", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3), touch);
		pointer("pointerdown", v.checkbox(0), at(0, 3), { ...touch, isPrimary: false });
		vi.advanceTimersByTime(1000);
		pointer("pointerup", v.checkbox(0), at(0, 3), touch);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("a mouse drag of more than 5 px that starts on a checkbox writes nothing and does not toggle", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		const down = pointer("pointerdown", v.checkbox(0), at(0, 3));
		pointer("pointermove", v.checkbox(0), { x: 40, y: 0 });
		const up = pointer("pointerup", v.checkbox(0), { x: 40, y: 0 });
		const clk = click(v.checkbox(0), at(0, 3)); // a drag that ended back on the box
		expect(down.defaultPrevented).toBe(false); // the selection proceeds
		expect(up.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
		expect(clk.defaultPrevented).toBe(true); // ...and the native toggle does not run
		expect(rig.seen).toEqual([]);
	});

	it("a right mouse button does nothing", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3), { button: 2 });
		vi.advanceTimersByTime(1000);
		expect(v.editor.replaceCalls).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("G19: Status cycle off", () => {
	it("no listener intercepts: click is native, the hold does nothing, PR-3 still stamps", async () => {
		rig = await setup([["- [ ] Task"]], { settings: { statusCycle: false } });
		const v = rig.views[0];
		const { down, up, clk } = physicalClick(v.checkbox(0), at(0, 3));
		expect(down.defaultPrevented || up.defaultPrevented || clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);

		// What Obsidian's native toggle then does.
		v.editor.replaceRange("x", { line: 0, ch: 3 }, { line: 0, ch: 4 });
		expect(v.editor.getLine(0)).toBe(`- [x] Task ✅ ${TODAY}`);
		expect(rig.seen).toEqual([{ file: "note-0.md", line: 0, from: " ", to: "x" }]);

		// A hold does nothing; the context menu is not touched.
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		v.checkbox(0).dispatchEvent(menu);
		vi.advanceTimersByTime(2000);
		pointer("pointerup", v.checkbox(0), at(0, 3));
		expect(menu.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("turning it off mid-press clears the pending timer; turning it on works without reload", async () => {
		rig = await setup([["- [ ] Task"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		vi.advanceTimersByTime(300);
		expect(vi.getTimerCount()).toBe(1);
		await rig.plugin.settings.update({ statusCycle: false });
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(2000);
		expect(v.editor.replaceCalls).toBe(0);
		pointer("pointerup", v.checkbox(0), at(0, 3));
		expect(v.editor.replaceCalls).toBe(0);

		await rig.plugin.settings.update({ statusCycle: true });
		const { clk } = physicalClick(v.checkbox(0), at(0, 3));
		expect(clk.defaultPrevented).toBe(true);
		expect(v.editor.getLine(0)).toBe("- [/] Task");
	});

	it("a click that follows a press is not swallowed once the setting is off", async () => {
		rig = await setup([["- [ ] Task"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		pointer("pointerup", v.checkbox(0), at(0, 3));
		await rig.plugin.settings.update({ statusCycle: false });
		expect(click(v.checkbox(0), at(0, 3)).defaultPrevented).toBe(false);
	});
});

describe("edge cases", () => {
	it("a line edited between pointerdown and release: nothing is written", async () => {
		rig = await setup([["- [ ] Task"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		v.editor.replaceRange("!", { line: 0, ch: 10 });
		vi.advanceTimersByTime(100);
		pointer("pointerup", v.checkbox(0), at(0, 3));
		expect(v.editor.getLine(0)).toBe("- [ ] Task!");
		expect(v.editor.replaceCalls).toBe(1); // only the edit above
	});

	it("a line edited between pointerdown and the long-press timer: nothing is written", async () => {
		rig = await setup([["- [ ] Task"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		v.editor.replaceRange("!", { line: 0, ch: 10 });
		vi.advanceTimersByTime(600);
		expect(v.editor.getLine(0)).toBe("- [ ] Task!");
		expect(rig.seen).toEqual([]);
	});

	it("the line removed during the hold: nothing is written and nothing throws", async () => {
		rig = await setup([["- [ ] one", "- [ ] two"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(1), at(1, 3));
		v.editor.replaceRange("", { line: 0, ch: 9 }, { line: 1, ch: 9 }); // drops the last line
		expect(v.editor.doc()).toBe("- [ ] one");
		expect(() => vi.advanceTimersByTime(600)).not.toThrow();
		expect(v.editor.doc()).toBe("- [ ] one");
	});

	it("the line no longer a task: nothing is written", async () => {
		rig = await setup([["- [ ] Task"]]);
		const v = rig.views[0];
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		v.editor.replaceRange("", { line: 0, ch: 3 }, { line: 0, ch: 4 }); // "- [] Task"
		vi.advanceTimersByTime(600);
		pointer("pointerup", v.checkbox(0), at(0, 3));
		expect(v.editor.getLine(0)).toBe("- [] Task");
	});

	it("switching note during a hold clears the timer; nothing is written in either note", async () => {
		rig = await setup([["- [ ] a"], ["- [ ] b"]]);
		const [a, b] = rig.views;
		pointer("pointerdown", a.checkbox(0), at(0, 3));
		expect(vi.getTimerCount()).toBe(1);
		rig.app.workspace.trigger("active-leaf-change", {});
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(2000);
		pointer("pointerup", a.checkbox(0), at(0, 3));
		expect(a.editor.replaceCalls + b.editor.replaceCalls).toBe(0);
	});

	it("with two views open the press acts only in the view that received the event", async () => {
		rig = await setup([["- [ ] a"], ["- [ ] b"]]);
		const [a, b] = rig.views;
		// View A is first in the leaf list (as if it were the active one).
		physicalClick(b.checkbox(0), at(0, 3));
		expect(b.editor.getLine(0)).toBe("- [/] b");
		expect(a.editor.getLine(0)).toBe("- [ ] a");
		expect(rig.seen).toEqual([{ file: "note-1.md", line: 0, from: " ", to: "/" }]);
		vi.advanceTimersByTime(1000);
		pointer("pointerdown", a.checkbox(0), at(0, 3));
		vi.advanceTimersByTime(500);
		expect(a.editor.getLine(0)).toBe(`- [-] a ❌ ${TODAY}`);
		expect(b.editor.getLine(0)).toBe("- [/] b");
	});

	it("an event outside every view's contentEl is ignored", async () => {
		rig = await setup([["- [ ] a"]]);
		const stray = document.createElement("input");
		stray.className = "task-list-item-checkbox";
		document.body.append(stray);
		const { clk } = physicalClick(stray, at(0, 3));
		expect(clk.defaultPrevented).toBe(false);
		expect(rig.views[0].editor.replaceCalls).toBe(0);
	});

	it("Source mode: the literal [ ] text only places the cursor", async () => {
		rig = await setup([["- [ ] a"]], { mode: "source" });
		const v = rig.views[0];
		const { down, up, clk } = physicalClick(v.text(0), at(0, 3));
		vi.advanceTimersByTime(1000);
		expect(down.defaultPrevented || up.defaultPrevented || clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("Source mode: even an input widget is not intercepted (only Live Preview is)", async () => {
		rig = await setup([["- [ ] a"]], { mode: "source" });
		const v = rig.views[0];
		const { clk } = physicalClick(v.checkbox(0), at(0, 3));
		expect(clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("F3: Reading view behaves exactly as native", async () => {
		rig = await setup([["- [ ] a"]], { mode: "reading" });
		const v = rig.views[0];
		const { down, up, clk } = physicalClick(v.checkbox(0), at(0, 3));
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		vi.advanceTimersByTime(1000);
		expect(down.defaultPrevented || up.defaultPrevented || clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a pointerdown on a label that maps to no editor position does nothing", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		const label = document.createElement("label");
		v.li(0).append(label);
		(v.editor.cm as { posAtCoords: () => null }).posAtCoords = () => null;
		pointer("pointerdown", label, at(0, 3));
		vi.advanceTimersByTime(1000);
		expect(v.editor.replaceCalls).toBe(0);
	});
});

describe("unload", () => {
	it("removes every DOM listener and workspace handler, and clears a pending timer", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		// 6 for the editor press handler, 6 for the embed press handler (five pointer/click, one keydown).
		expect(rig.plugin.domListenerCount).toBe(12);
		pointer("pointerdown", v.checkbox(0), at(0, 3));
		expect(vi.getTimerCount()).toBe(1);

		rig.plugin.unload();
		expect(rig.plugin.domListenerCount).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(rig.app.workspace.handlers.get("active-leaf-change") ?? []).toHaveLength(0);
		vi.advanceTimersByTime(2000);
		expect(v.editor.replaceCalls).toBe(0);
	});

	it("after unload clicks use the native toggle", async () => {
		rig = await setup([["- [ ] a"]]);
		const v = rig.views[0];
		rig.plugin.unload();
		const { down, up, clk } = physicalClick(v.checkbox(0), at(0, 3));
		expect(down.defaultPrevented || up.defaultPrevented || clk.defaultPrevented).toBe(false);
		expect(v.editor.replaceCalls).toBe(0);
	});
});

describe("fence", () => {
	it("registers no command", async () => {
		rig = await setup([["- [ ] a"]]);
		const { addCommand } = rig.plugin as unknown as { addCommand: ReturnType<typeof vi.fn> };
		expect(addCommand).not.toHaveBeenCalled();
	});
});
