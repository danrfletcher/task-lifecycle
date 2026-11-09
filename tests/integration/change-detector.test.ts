import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	history,
	moveLineDown,
	moveLineUp,
	redo,
	undo,
	undoDepth,
} from "@codemirror/commands";
import {
	EditorSelection,
	EditorState,
	Transaction,
	type ChangeSpec,
	type TransactionSpec,
} from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createChangeDetector,
	taskLifecycleSelfWrite,
} from "../../src/editor/change-detector";
import { STATUS_CHANGED_EVENT, TaskLifecycleEvents } from "../../src/events/event-bus";
import { editorInfoField } from "../__mocks__/obsidian";

const TODAY = new Date(2026, 10, 9, 12, 0, 0);
const fixture = (name: string) => readFileSync(join(__dirname, "..", "fixtures", name), "utf8");

interface Harness {
	state: EditorState;
	bus: TaskLifecycleEvents;
	emit: ReturnType<typeof vi.spyOn>;
	settings: { closeStamps: boolean };
	clock: { t: number };
	file: { path: string };
	/** Dispatch a user transaction (goes through the real filters). */
	dispatch(spec: TransactionSpec): Transaction;
	doc(): string;
	events(): Array<{ line: number; lineText: string; from: string; to: string; file: unknown }>;
}

function harness(
	doc: string,
	opts: { path?: string; extensions?: unknown[]; bus?: TaskLifecycleEvents } = {}
): Harness {
	const bus = opts.bus ?? new TaskLifecycleEvents();
	const emit = vi.spyOn(bus, "emit");
	const settings = { closeStamps: true };
	const clock = { t: 1_000_000 };
	const file = { path: opts.path ?? "Scratch/lifecycle-demo.md" };
	const h: Harness = {
		state: EditorState.create({
			doc,
			extensions: [
				history(),
				editorInfoField.init(() => ({ file })),
				createChangeDetector({
					events: bus,
					getSettings: () => settings,
					now: () => clock.t,
					today: () => TODAY,
				}),
				...((opts.extensions ?? []) as never[]),
			],
		}),
		bus,
		emit,
		settings,
		clock,
		file,
		dispatch(spec) {
			const tr = h.state.update(spec);
			h.state = tr.state;
			return tr;
		},
		doc: () => h.state.doc.toString(),
		events: () => emit.mock.calls.map((c) => ({ ...(c[1] as never as { file: unknown; line: number; lineText: string; from: string; to: string }) })),
	};
	return h;
}

/** Position of the status char of 0-based line `n`. */
function charPos(state: EditorState, n: number): number {
	const line = state.doc.line(n + 1);
	return line.from + line.text.indexOf("[") + 1;
}

/** Type `c` over the status char of line n (one replace-one-char transaction). */
function typeChar(h: Harness, n: number, c: string) {
	const p = charPos(h.state, n);
	return h.dispatch({ changes: { from: p, to: p + 1, insert: c }, userEvent: "input.type" });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("G6 / golden path (typed changes, stamp part)", () => {
	it("GP2: typing x over / stamps before the block id and emits one event", () => {
		const h = harness("- [/] Ship release ^rel1");
		typeChar(h, 0, "x");
		expect(h.doc()).toBe("- [x] Ship release ✅ 2026-11-09 ^rel1");
		expect(h.emit).toHaveBeenCalledTimes(1);
		expect(h.emit).toHaveBeenCalledWith(STATUS_CHANGED_EVENT, {
			file: h.file,
			line: 0,
			lineText: "- [x] Ship release ^rel1",
			from: "/",
			to: "x",
		});
	});

	it("GP5/GP6: - swaps to a cross before ^rel1, then a space gives the original line back byte for byte", () => {
		const original = fixture("lifecycle-demo.md");
		const h = harness(original);
		typeChar(h, 0, "/");
		expect(h.doc().split("\n")[0]).toBe("- [/] Ship release ^rel1");
		typeChar(h, 0, "x");
		expect(h.doc().split("\n")[0]).toBe("- [x] Ship release ✅ 2026-11-09 ^rel1");
		typeChar(h, 0, "-");
		expect(h.doc().split("\n")[0]).toBe("- [-] Ship release ❌ 2026-11-09 ^rel1");
		typeChar(h, 0, " ");
		expect(h.doc()).toBe(original);
		expect(h.events().map((e) => [e.line, e.from, e.to])).toEqual([
			[0, " ", "/"],
			[0, "/", "x"],
			[0, "x", "-"],
			[0, "-", " "],
		]);
	});

	it("a change without any userEvent annotation (native checkbox toggle) is detected too", () => {
		const h = harness("- [ ] Write notes");
		const p = charPos(h.state, 0);
		h.dispatch({ changes: { from: p, to: p + 1, insert: "x" } });
		expect(h.doc()).toBe("- [x] Write notes ✅ 2026-11-09");
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("G10: x -> X keeps the old date but still emits", () => {
		const h = harness("- [x] a ✅ 2026-11-01");
		typeChar(h, 0, "X");
		expect(h.doc()).toBe("- [X] a ✅ 2026-11-01");
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("a text edit on a stamped line changes nothing and emits nothing", () => {
		const h = harness("- [x] a ✅ 2026-11-01");
		h.dispatch({ changes: { from: 7, insert: "bc" }, userEvent: "input.type" });
		expect(h.doc()).toBe("- [x] abc ✅ 2026-11-01");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("uses the real local date when no clock is injected", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 0, 5, 23, 30));
		const bus = new TaskLifecycleEvents();
		let state = EditorState.create({
			doc: "- [ ] a",
			extensions: [createChangeDetector({ events: bus, getSettings: () => ({ closeStamps: true }) })],
		});
		state = state.update({ changes: { from: 3, to: 4, insert: "x" } }).state;
		expect(state.doc.toString()).toBe("- [x] a ✅ 2026-01-05");
	});
});

describe("G6: several lines in one transaction", () => {
	it("find/replace [ ] -> [x] across 3 lines: 3 events in ascending order, each line stamped", () => {
		const h = harness("- [ ] a\nnote\n- [ ] b ^b1\n\t- [ ] c");
		const changes: ChangeSpec[] = [0, 2, 3].map((n) => {
			const p = charPos(h.state, n);
			return { from: p, to: p + 1, insert: "x" };
		});
		h.dispatch({ changes, userEvent: "input.replace.all" });
		expect(h.doc()).toBe(
			"- [x] a ✅ 2026-11-09\nnote\n- [x] b ✅ 2026-11-09 ^b1\n\t- [x] c ✅ 2026-11-09"
		);
		expect(h.events().map((e) => e.line)).toEqual([0, 2, 3]);
		expect(h.events().map((e) => e.lineText)).toEqual([
			"- [x] a",
			"- [x] b ^b1",
			"\t- [x] c",
		]);
	});

	it("multi-cursor typing, changes given bottom to top: events still top to bottom", () => {
		const h = harness("- [ ] a\n- [ ] b");
		const p0 = charPos(h.state, 0);
		const p1 = charPos(h.state, 1);
		h.dispatch({
			changes: [
				{ from: p1, to: p1 + 1, insert: "-" },
				{ from: p0, to: p0 + 1, insert: "-" },
			],
			userEvent: "input.type",
		});
		expect(h.doc()).toBe("- [-] a ❌ 2026-11-09\n- [-] b ❌ 2026-11-09");
		expect(h.events().map((e) => [e.line, e.to])).toEqual([
			[0, "-"],
			[1, "-"],
		]);
	});

	it("a paste that changes one existing char and adds lines handles only the real change", () => {
		const h = harness("- [ ] a\n- [ ] b");
		const p = charPos(h.state, 1);
		h.dispatch({
			changes: [
				{ from: 0, insert: "- [x] new1\n- [x] new2\n" },
				{ from: p, to: p + 1, insert: "x" },
			],
			userEvent: "input.paste",
		});
		expect(h.doc()).toBe("- [x] new1\n- [x] new2\n- [ ] a\n- [x] b ✅ 2026-11-09");
		expect(h.events().map((e) => [e.line, e.from, e.to])).toEqual([[3, " ", "x"]]);
	});

	it("a pasted block of already-closed task lines is an insertion: no event, no stamp", () => {
		const h = harness("intro\n- [ ] a");
		h.dispatch({
			changes: { from: 6, insert: "- [x] p1\n- [-] p2\n\t- [x] p3\n" },
			userEvent: "input.paste",
		});
		expect(h.doc()).toBe("intro\n- [x] p1\n- [-] p2\n\t- [x] p3\n- [ ] a");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("pasting a closed copy of an existing open task does not close the original", () => {
		const h = harness("- [ ] a");
		h.dispatch({ changes: { from: 0, insert: "- [x] a\n" }, userEvent: "input.paste" });
		expect(h.doc()).toBe("- [x] a\n- [ ] a");
		expect(h.emit).not.toHaveBeenCalled();
	});
});

describe("task line shapes", () => {
	it.each([
		["* [ ] a", "* [x] a ✅ 2026-11-09"],
		["+ [ ] a", "+ [x] a ✅ 2026-11-09"],
		["1. [ ] a", "1. [x] a ✅ 2026-11-09"],
		["1) [ ] a", "1) [x] a ✅ 2026-11-09"],
		["> - [ ] a", "> - [x] a ✅ 2026-11-09"],
		["> [!note]\n> - [ ] a", "> [!note]\n> - [x] a ✅ 2026-11-09"],
		["> > 1. [ ] a ^q", "> > 1. [x] a ✅ 2026-11-09 ^q"],
	])("%j", (doc, want) => {
		const h = harness(doc);
		typeChar(h, doc.split("\n").length - 1, "x");
		expect(h.doc()).toBe(want);
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("tasks inside ``` and ~~~ fences never emit and are not stamped", () => {
		for (const fence of ["```", "~~~"]) {
			const doc = `${fence}\n- [ ] a\n${fence}\n- [ ] b`;
			const h = harness(doc);
			typeChar(h, 1, "x");
			expect(h.doc()).toBe(`${fence}\n- [x] a\n${fence}\n- [ ] b`);
			expect(h.emit).not.toHaveBeenCalled();
			typeChar(h, 3, "x");
			expect(h.doc()).toBe(`${fence}\n- [x] a\n${fence}\n- [x] b ✅ 2026-11-09`);
			expect(h.events().map((e) => e.line)).toEqual([3]);
		}
	});

	it("a task-looking line in frontmatter never emits", () => {
		const h = harness("---\n- [ ] a\n---\n- [ ] b");
		typeChar(h, 1, "x");
		expect(h.doc()).toBe("---\n- [x] a\n---\n- [ ] b");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("E2: a chip with a bare emoji is kept when the task is reopened", () => {
		const chip = '<span class="chip">✅ Approved</span>';
		const h = harness(`- [x] a ${chip} ✅ 2026-11-01`);
		typeChar(h, 0, " ");
		expect(h.doc()).toBe(`- [ ] a ${chip}`);
	});

	it("E4: trailing whitespace is normalised only before the stamp; indentation and inner double spaces stay", () => {
		const h = harness("\t  - [ ] a  b   ");
		typeChar(h, 0, "x");
		expect(h.doc()).toBe("\t  - [x] a  b ✅ 2026-11-09");
	});
});

describe("E14: identical task lines", () => {
	const row = "- [ ] Call caterer";
	it.each([
		["duplicates above", ["- [ ] Call caterer", "- [ ] Call caterer", "- [ ] Other"], 2],
		["duplicates below", ["- [ ] Other", "- [ ] Call caterer", "- [ ] Call caterer"], 1],
		["next to each other, first", [row, row, "text"], 0],
		["next to each other, second", [row, row, "text"], 1],
		["three in a row, middle", [row, row, row], 1],
		["separated", [row, "text", row], 2],
	] as Array<[string, string[], number]>)("%s", (_name, lines, target) => {
		const h = harness(lines.join("\n"));
		typeChar(h, target, "x");
		const want = [...lines];
		want[target] = "- [x] Call caterer ✅ 2026-11-09";
		if (lines[target] !== row) want[target] = lines[target].replace("[ ]", "[x]") + " ✅ 2026-11-09";
		expect(h.doc()).toBe(want.join("\n"));
		expect(h.events().map((e) => e.line)).toEqual([target]);
	});

	it("select-all-and-retype with one duplicate toggled still gives the right line", () => {
		const h = harness(`${row}\n${row}`);
		h.dispatch({
			changes: { from: 0, to: h.state.doc.length, insert: "- [x] Call caterer\n- [ ] Call caterer" },
			userEvent: "input.paste",
		});
		expect(h.doc()).toBe("- [x] Call caterer ✅ 2026-11-09\n- [ ] Call caterer");
		expect(h.events().map((e) => e.line)).toEqual([0]);
	});
});

describe("E13: Enter, delete, paste and Alt+Up/Down above closed or stamped tasks", () => {
	const doc = "intro\n- [x] Ship release ✅ 2026-11-01 ^rel1\n\t- [ ] Write notes\n- [ ] Book venue";

	it("Enter above a closed parent", () => {
		const h = harness(doc);
		const at = h.state.doc.line(2).from;
		h.dispatch({ changes: { from: at, insert: "\n" }, userEvent: "input" });
		expect(h.doc()).toBe(`intro\n\n${doc.split("\n").slice(1).join("\n")}`);
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("Enter three times at the start of the document", () => {
		const h = harness(doc);
		for (let i = 0; i < 3; i++) h.dispatch({ changes: { from: 0, insert: "\n" }, userEvent: "input" });
		expect(h.doc()).toBe(`\n\n\n${doc}`);
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("Enter at the end of a task line (list continuation adds an open task)", () => {
		const h = harness(doc);
		const at = h.state.doc.line(2).to;
		h.dispatch({ changes: { from: at, insert: "\n- [ ] " }, userEvent: "input" });
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.doc().split("\n")[1]).toBe("- [x] Ship release ✅ 2026-11-01 ^rel1");
	});

	it("deleting the line above", () => {
		const h = harness(doc);
		h.dispatch({ changes: { from: 0, to: h.state.doc.line(2).from }, userEvent: "delete.line" });
		expect(h.doc()).toBe(doc.split("\n").slice(1).join("\n"));
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("deleting a whole task line above a stamped task", () => {
		const h = harness("- [ ] gone\n- [x] kept ✅ 2026-11-01");
		h.dispatch({ changes: { from: 0, to: h.state.doc.line(2).from }, userEvent: "delete.line" });
		expect(h.doc()).toBe("- [x] kept ✅ 2026-11-01");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("pasting lines above a stamped task", () => {
		const h = harness(doc);
		const at = h.state.doc.line(2).from;
		h.dispatch({ changes: { from: at, insert: "- [ ] pasted\n- [x] pasted2\n" }, userEvent: "input.paste" });
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.doc()).toContain("- [x] Ship release ✅ 2026-11-01 ^rel1");
	});

	it("Alt+Up on 'Book venue' (real moveLineUp command)", () => {
		const h = harness(doc);
		h.state = h.state.update({ selection: EditorSelection.cursor(h.state.doc.line(4).from) }).state;
		const moved = moveLineUp({
			state: h.state,
			dispatch: (tr) => {
				h.state = tr.state;
			},
		});
		expect(moved).toBe(true);
		expect(h.doc()).toBe(
			"intro\n- [x] Ship release ✅ 2026-11-01 ^rel1\n- [ ] Book venue\n\t- [ ] Write notes"
		);
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("Alt+Down on the closed parent line (real moveLineDown command)", () => {
		const h = harness(doc);
		h.state = h.state.update({ selection: EditorSelection.cursor(h.state.doc.line(2).from) }).state;
		moveLineDown({
			state: h.state,
			dispatch: (tr) => {
				h.state = tr.state;
			},
		});
		expect(h.doc()).toBe(
			"intro\n\t- [ ] Write notes\n- [x] Ship release ✅ 2026-11-01 ^rel1\n- [ ] Book venue"
		);
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("moving a line that is a stamped task: stamp stays, nothing emitted", () => {
		const h = harness("- [x] a ✅ 2026-11-01\n- [-] b ❌ 2026-11-02");
		h.state = h.state.update({ selection: EditorSelection.cursor(h.state.doc.line(2).from) }).state;
		moveLineUp({ state: h.state, dispatch: (tr) => (h.state = tr.state) });
		expect(h.doc()).toBe("- [-] b ❌ 2026-11-02\n- [x] a ✅ 2026-11-01");
		expect(h.emit).not.toHaveBeenCalled();
	});
});

describe("E11: undo and redo", () => {
	function undoOnce(h: Harness): boolean {
		return undo({ state: h.state, dispatch: (tr) => (h.state = tr.state) });
	}
	function redoOnce(h: Harness): boolean {
		return redo({ state: h.state, dispatch: (tr) => (h.state = tr.state) });
	}

	it("the status change and its stamp are one undo step; undo and redo emit nothing and stamp nothing", () => {
		const h = harness("- [ ] Ship release ^rel1");
		expect(undoDepth(h.state)).toBe(0);
		typeChar(h, 0, "x");
		expect(h.doc()).toBe("- [x] Ship release ✅ 2026-11-09 ^rel1");
		expect(undoDepth(h.state)).toBe(1);
		expect(h.emit).toHaveBeenCalledTimes(1);

		expect(undoOnce(h)).toBe(true);
		expect(h.doc()).toBe("- [ ] Ship release ^rel1");
		expect(undoDepth(h.state)).toBe(0);

		expect(redoOnce(h)).toBe(true);
		expect(h.doc()).toBe("- [x] Ship release ✅ 2026-11-09 ^rel1");
		expect(h.emit).toHaveBeenCalledTimes(1);

		expect(undoOnce(h)).toBe(true);
		expect(h.doc()).toBe("- [ ] Ship release ^rel1");
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("undoing a reopen (stamp removal) brings back status and stamp together", () => {
		const h = harness("- [x] a ✅ 2026-11-01");
		typeChar(h, 0, " ");
		expect(h.doc()).toBe("- [ ] a");
		undoOnce(h);
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-01");
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("a multi-line change is also one undo step", () => {
		const h = harness("- [ ] a\n- [ ] b");
		const changes = [0, 1].map((n) => ({ from: charPos(h.state, n), to: charPos(h.state, n) + 1, insert: "x" }));
		h.dispatch({ changes, userEvent: "input.replace.all" });
		expect(undoDepth(h.state)).toBe(1);
		undoOnce(h);
		expect(h.doc()).toBe("- [ ] a\n- [ ] b");
	});

	it("a transaction marked undo or redo is never detected", () => {
		const h = harness("- [ ] a");
		for (const ev of ["undo", "redo", "undo.selection"]) {
			h.dispatch({ changes: { from: 3, to: 4, insert: "x" }, userEvent: ev });
			expect(h.doc()).toBe("- [x] a");
			h.dispatch({ changes: { from: 3, to: 4, insert: " " }, userEvent: ev });
		}
		expect(h.emit).not.toHaveBeenCalled();
	});
});

describe("self-writes and other non-typed sources", () => {
	it("an annotated self-write emits nothing and is not stamped", () => {
		const h = harness("- [ ] a\n- [ ] b");
		h.dispatch({
			changes: { from: 3, to: 4, insert: "x" },
			annotations: taskLifecycleSelfWrite.of(true),
		});
		expect(h.doc()).toBe("- [x] a\n- [ ] b");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("suppression is per line: that line is ignored for 1200 ms, other lines are not", () => {
		const h = harness("- [ ] a\n- [ ] b");
		h.dispatch({
			changes: { from: 3, to: 4, insert: "x" },
			annotations: taskLifecycleSelfWrite.of(true),
		});
		h.clock.t += 1199;
		typeChar(h, 0, "-"); // same line, inside the window
		expect(h.doc()).toBe("- [-] a\n- [ ] b");
		expect(h.emit).not.toHaveBeenCalled();

		typeChar(h, 1, "x"); // other line: not suppressed
		expect(h.doc()).toBe("- [-] a\n- [x] b ✅ 2026-11-09");
		expect(h.events().map((e) => e.line)).toEqual([1]);

		h.clock.t += 1; // 1200 ms after the self-write
		typeChar(h, 0, "x");
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-09\n- [x] b ✅ 2026-11-09");
		expect(h.events().map((e) => e.line)).toEqual([1, 0]);
	});

	it("the suppressed line follows its text when lines are inserted above it", () => {
		const h = harness("- [ ] a\n- [ ] b");
		h.dispatch({
			changes: { from: 3, to: 4, insert: "x" },
			annotations: taskLifecycleSelfWrite.of(true),
		});
		h.dispatch({ changes: { from: 0, insert: "new\n\n" }, userEvent: "input" });
		typeChar(h, 2, "-");
		expect(h.emit).not.toHaveBeenCalled();
		typeChar(h, 3, "x");
		expect(h.events().map((e) => e.line)).toEqual([3]);
	});

	it("a user toggle's own stamp does not suppress the next toggle of that line", () => {
		const h = harness("- [ ] a");
		typeChar(h, 0, "x");
		typeChar(h, 0, "-");
		expect(h.doc()).toBe("- [-] a ❌ 2026-11-09");
		expect(h.emit).toHaveBeenCalledTimes(2);
	});

	it("a remote transaction (not from this editor) is ignored", () => {
		const h = harness("- [ ] a");
		h.dispatch({
			changes: { from: 3, to: 4, insert: "x" },
			annotations: Transaction.remote.of(true),
		});
		expect(h.doc()).toBe("- [x] a");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("a transaction that changes no text is ignored", () => {
		const h = harness("- [x] a");
		h.dispatch({ selection: EditorSelection.cursor(2) });
		h.dispatch({ changes: { from: 3, to: 4, insert: "x" } });
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("a throwing handler on the bus does not break the edit or the other handlers", () => {
		const h = harness("- [ ] a");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const second = vi.fn();
		h.bus.on(STATUS_CHANGED_EVENT, () => {
			throw new Error("boom");
		});
		h.bus.on(STATUS_CHANGED_EVENT, second);
		typeChar(h, 0, "x");
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-09");
		expect(second).toHaveBeenCalledTimes(1);
		error.mockRestore();
	});
});

describe("E10: the stamp goes through the editor that produced the change", () => {
	it("two editors on two notes: each event names its own file and each stamp lands in its own doc", () => {
		const bus = new TaskLifecycleEvents();
		const a = harness("- [ ] same line", { path: "A.md", bus });
		const b = harness("- [ ] same line", { path: "B.md", bus });
		const seen: Array<{ path: string; lineText: string }> = [];
		bus.on(STATUS_CHANGED_EVENT, (e) =>
			seen.push({ path: (e.file as unknown as { path: string }).path, lineText: e.lineText })
		);
		typeChar(b, 0, "x");
		expect(seen).toEqual([{ path: "B.md", lineText: "- [x] same line" }]);
		expect(b.doc()).toBe("- [x] same line ✅ 2026-11-09");
		expect(a.doc()).toBe("- [ ] same line");
		typeChar(a, 0, "-");
		expect(seen[1]).toEqual({ path: "A.md", lineText: "- [-] same line" });
		expect(a.doc()).toBe("- [-] same line ❌ 2026-11-09");
		expect(b.doc()).toBe("- [x] same line ✅ 2026-11-09");
	});

	it("the event's lineText is the line in the doc that produced it", () => {
		const h = harness("a\n- [ ] b ^id");
		const tr = typeChar(h, 1, "x");
		const [{ lineText, line }] = h.events();
		expect(tr.startState.doc.line(line + 1).text).toBe("- [ ] b ^id");
		expect(lineText).toBe("- [x] b ^id");
	});

	it("a state with no file info still works and reports file null", () => {
		const bus = new TaskLifecycleEvents();
		const emit = vi.spyOn(bus, "emit");
		const state = EditorState.create({
			doc: "- [ ] a",
			extensions: [createChangeDetector({ events: bus, getSettings: () => ({ closeStamps: true }), today: () => TODAY })],
		});
		state.update({ changes: { from: 3, to: 4, insert: "x" } });
		expect(emit).toHaveBeenCalledWith(STATUS_CHANGED_EVENT, expect.objectContaining({ file: null }));
	});
});

describe("E8: CRLF notes", () => {
	it("a stamp and an unstamp keep \\r\\n on every line and give the file back byte for byte", () => {
		const original = fixture("crlf-note.md");
		expect(original.split("\r\n").length).toBeGreaterThan(3);
		expect(original.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);

		const h = harness(original, { extensions: [EditorState.lineSeparator.of("\r\n")] });
		const text = () => h.state.sliceDoc(0, h.state.doc.length);
		expect(text()).toBe(original);

		typeChar(h, 2, "x");
		const stamped = text();
		expect(stamped).toContain("- [x] Ship release ✅ 2026-11-09 ^rel1\r\n");
		expect(stamped.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);

		typeChar(h, 2, " ");
		expect(text()).toBe(original);
	});
});

describe("F4: the detector writes nothing but stamps", () => {
	it("over random transitions the doc differs only by the typed char and the stamp tokens", () => {
		const base = [
			"- [ ] Ship release ^rel1",
			"\t- [ ] Write notes",
			"- [x] Tag build ✅ 2026-11-08",
			"> - [-] cancelled ❌ 2026-11-01  ",
			"1. [ ] a  b   ",
		];
		const chars = [" ", "/", "x", "X", "-", "?"];
		const stampToken = / ?(?:✅|❌) \d{4}-\d{2}-\d{2}\b/g;
		const canon = (s: string) => s.replace(stampToken, "").replace(/\s+(?=(?:\^[A-Za-z0-9-]+\s*)?$)/, "");
		let seed = 61;
		const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
		for (let i = 0; i < 300; i++) {
			const h = harness(base.join("\n"));
			for (let step = 0; step < 4; step++) {
				const n = Math.floor(rand() * base.length);
				const c = chars[Math.floor(rand() * chars.length)];
				const before = h.doc().split("\n");
				typeChar(h, n, c);
				const after = h.doc().split("\n");
				expect(after).toHaveLength(before.length);
				after.forEach((line, k) => {
					const expectedChar = k === n ? c : undefined;
					const b = before[k];
					if (k !== n) expect(line).toBe(b);
					else {
						expect(canon(line)).toBe(canon(b.replace(/\[.\]/u, `[${expectedChar}]`)));
					}
				});
			}
		}
	});
});

describe("R1: an on-disk change applied to the open editor (userEvent \"set\") is never detected", () => {
	it("an external [ ] -> [x] swap dispatched as userEvent set: no event, no stamp", () => {
		const h = harness("- [ ] Ship release ^rel1\n- [ ] b");
		const p = charPos(h.state, 0);
		h.dispatch({ changes: { from: p, to: p + 1, insert: "x" }, userEvent: "set" });
		expect(h.doc()).toBe("- [x] Ship release ^rel1\n- [ ] b");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("a set that reopens a stamped task leaves its stamp alone, and 'set.x' subtypes count too", () => {
		const h = harness("- [x] a ✅ 2026-11-01");
		h.dispatch({ changes: { from: 3, to: 4, insert: " " }, userEvent: "set" });
		expect(h.doc()).toBe("- [ ] a ✅ 2026-11-01");
		h.dispatch({ changes: { from: 3, to: 4, insert: "-" }, userEvent: "set.external" });
		expect(h.doc()).toBe("- [-] a ✅ 2026-11-01");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("a set does not leave a pending change behind for the next typed edit", () => {
		const h = harness("- [ ] a");
		// external edit breaks the checkbox, then another external edit restores it as [x]
		h.dispatch({ changes: { from: 3, to: 4 }, userEvent: "set" });
		expect(h.doc()).toBe("- [] a");
		h.dispatch({ changes: { from: 3, insert: "x" }, userEvent: "set" });
		expect(h.doc()).toBe("- [x] a");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("typed edits right after a set are still detected", () => {
		const h = harness("- [ ] a\n- [ ] b");
		h.dispatch({ changes: { from: charPos(h.state, 0), to: charPos(h.state, 0) + 1, insert: "x" }, userEvent: "set" });
		typeChar(h, 1, "x");
		expect(h.doc()).toBe("- [x] a\n- [x] b ✅ 2026-11-09");
		expect(h.events().map((e) => e.line)).toEqual([1]);
	});
});

describe("R2: typing a status char across several keystrokes", () => {
	let tick = 0;
	/** One keystroke. Each gets its own time, so history keeps them as separate undo events. */
	function key(h: Harness, spec: TransactionSpec) {
		tick += 10_000;
		return h.dispatch({ ...spec, annotations: Transaction.time.of(tick) });
	}
	const backspace = (h: Harness, at: number) =>
		key(h, { changes: { from: at - 1, to: at }, userEvent: "delete.backward" });
	const del = (h: Harness, at: number) =>
		key(h, { changes: { from: at, to: at + 1 }, userEvent: "delete.forward" });
	const type = (h: Harness, at: number, c: string) =>
		key(h, { changes: { from: at, insert: c }, userEvent: "input.type" });
	const undoOnce = (h: Harness) => undo({ state: h.state, dispatch: (tr) => (h.state = tr.state) });
	const redoOnce = (h: Harness) => redo({ state: h.state, dispatch: (tr) => (h.state = tr.state) });

	it("Backspace the space, then type x: one event, stamped", () => {
		const h = harness("- [ ] Ship release ^rel1");
		backspace(h, 4); // "- [] Ship..."
		expect(h.doc()).toBe("- [] Ship release ^rel1");
		expect(h.emit).not.toHaveBeenCalled();
		type(h, 3, "x");
		expect(h.doc()).toBe("- [x] Ship release ✅ 2026-11-09 ^rel1");
		expect(h.emit).toHaveBeenCalledTimes(1);
		expect(h.emit).toHaveBeenCalledWith(STATUS_CHANGED_EVENT, {
			file: h.file,
			line: 0,
			lineText: "- [x] Ship release ^rel1",
			from: " ",
			to: "x",
		});
	});

	it("type x before the space, then Delete the space: one event, stamped", () => {
		const h = harness("- [ ] Ship release ^rel1");
		type(h, 3, "x"); // "- [x ] Ship..."
		expect(h.doc()).toBe("- [x ] Ship release ^rel1");
		expect(h.emit).not.toHaveBeenCalled();
		del(h, 4);
		expect(h.doc()).toBe("- [x] Ship release ✅ 2026-11-09 ^rel1");
		expect(h.events().map((e) => [e.line, e.from, e.to])).toEqual([[0, " ", "x"]]);
	});

	it("type x after the space, then Backspace the space: one event", () => {
		const h = harness("- [ ] a");
		type(h, 4, "x"); // "- [ x] a"
		backspace(h, 4);
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-09");
		expect(h.events().map((e) => [e.from, e.to])).toEqual([[" ", "x"]]);
	});

	it("each keystroke route also gives - and / (swap and in-progress)", () => {
		const h = harness("- [x] a ✅ 2026-11-01\n- [ ] b");
		backspace(h, 4);
		type(h, 3, "-");
		expect(h.doc().split("\n")[0]).toBe("- [-] a ❌ 2026-11-09");
		const b = h.state.doc.line(2).from;
		backspace(h, b + 4);
		type(h, b + 3, "/");
		expect(h.doc().split("\n")[1]).toBe("- [/] b");
		expect(h.events().map((e) => [e.line, e.from, e.to])).toEqual([
			[0, "x", "-"],
			[1, " ", "/"],
		]);
	});

	it("reopening: Backspace the x of a stamped task, then type a space removes the stamp", () => {
		const h = harness("- [x] a ✅ 2026-11-01");
		backspace(h, 4);
		expect(h.doc()).toBe("- [] a ✅ 2026-11-01");
		type(h, 3, " ");
		expect(h.doc()).toBe("- [ ] a");
		expect(h.events().map((e) => [e.from, e.to])).toEqual([["x", " "]]);
	});

	it("breaking the checkbox and putting the same char back is not a change", () => {
		const h = harness("- [x] a ✅ 2026-11-01");
		backspace(h, 4);
		type(h, 3, "x");
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-01");
		expect(h.emit).not.toHaveBeenCalled();
		// and the memory is gone: a plain select-and-replace later is a normal change
		typeChar(h, 0, " ");
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("text typed in the broken line meanwhile is a different task: no event, no stamp", () => {
		const h = harness("- [ ] a");
		backspace(h, 4);
		type(h, h.state.doc.length, "b"); // "- [] ab"
		type(h, 3, "x");
		expect(h.doc()).toBe("- [x] ab");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("with Close stamps off: the event fires on the second keystroke, no stamp", () => {
		const h = harness("- [ ] Call caterer");
		h.settings.closeStamps = false;
		backspace(h, 4);
		type(h, 3, "x");
		expect(h.doc()).toBe("- [x] Call caterer");
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("the second keystroke is part of the same undo step chain: undo and redo emit nothing and stamp nothing more", () => {
		const h = harness("- [ ] a");
		backspace(h, 4);
		type(h, 3, "x");
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-09");
		expect(undoDepth(h.state)).toBe(2);
		undoOnce(h); // back to "- [] a"
		expect(h.doc()).toBe("- [] a");
		undoOnce(h); // back to "- [ ] a"
		expect(h.doc()).toBe("- [ ] a");
		redoOnce(h);
		redoOnce(h);
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-09");
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("undoing the break does not leave a pending change: the next select-and-replace is a normal one", () => {
		const h = harness("- [ ] a");
		backspace(h, 4);
		undoOnce(h);
		expect(h.doc()).toBe("- [ ] a");
		typeChar(h, 0, "x");
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-09");
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("undo that restores a task line from a broken state does not fire, and a later change is measured fresh", () => {
		const h = harness("- [ ] a");
		backspace(h, 4);
		type(h, 3, "x");
		undoOnce(h);
		undoOnce(h);
		h.dispatch({ changes: { from: 3, to: 4, insert: "-" } });
		expect(h.events().map((e) => [e.from, e.to])).toEqual([
			[" ", "x"],
			[" ", "-"],
		]);
	});

	it("redo that breaks and restores a checkbox does not fire", () => {
		const h = harness("- [ ] a");
		backspace(h, 4);
		undoOnce(h);
		redoOnce(h); // "- [] a" again, by redo
		expect(h.doc()).toBe("- [] a");
		type(h, 3, "x");
		// the break came from redo, so nothing is remembered and the typed x is not a change
		expect(h.doc()).toBe("- [x] a");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("pasting a closed copy of a broken task elsewhere does not close the broken one", () => {
		const h = harness("- [ ] a\nintro");
		backspace(h, 4); // "- [] a"
		const end = h.state.doc.length;
		key(h, { changes: { from: end, insert: "\n- [x] a" }, userEvent: "input.paste" });
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.doc()).toBe("- [] a\nintro\n- [x] a");
	});

	it("pasting a task line over the broken line's text is not a status change either", () => {
		const h = harness("- [ ] a\nintro");
		backspace(h, 4);
		key(h, { changes: { from: 0, to: 6, insert: "- [x] z" }, userEvent: "input.paste" });
		expect(h.doc()).toBe("- [x] z\nintro");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("deleting the broken line forgets it: the same text typed in its place later is a new line", () => {
		const h = harness("- [ ] a\nintro");
		backspace(h, 4); // "- [] a\nintro"
		key(h, { changes: { from: 0, to: 7 }, userEvent: "delete.selection" });
		expect(h.doc()).toBe("intro");
		key(h, { changes: { from: 0, to: 5, insert: "- [x] a" }, userEvent: "input.paste" });
		expect(h.doc()).toBe("- [x] a");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("Enter and line moves above a broken line keep it tied to its line", () => {
		const h = harness("- [ ] a");
		backspace(h, 4);
		key(h, { changes: { from: 0, insert: "\n\n" }, userEvent: "input" });
		type(h, 5, "x"); // "\n\n- [] a" -> x at index 3+2
		expect(h.doc()).toBe("\n\n- [x] a ✅ 2026-11-09");
		expect(h.events().map((e) => [e.line, e.from, e.to])).toEqual([[2, " ", "x"]]);
	});

	it("two identical task lines: only the one that was broken and retyped fires", () => {
		const h = harness("- [ ] same\n- [ ] same");
		const b = h.state.doc.line(2).from;
		backspace(h, b + 4);
		type(h, b + 3, "x");
		expect(h.doc()).toBe("- [ ] same\n- [x] same ✅ 2026-11-09");
		expect(h.events().map((e) => [e.line, e.from, e.to])).toEqual([[1, " ", "x"]]);
	});

	it("several broken lines restored by one find/replace emit top to bottom", () => {
		const h = harness("- [ ] a\n- [ ] b\n- [ ] c");
		for (const n of [3, 2, 1]) backspace(h, h.state.doc.line(n).from + 4);
		const changes = [1, 2, 3].map((n) => ({ from: h.state.doc.line(n).from + 3, insert: "x" }));
		key(h, { changes, userEvent: "input.replace.all" });
		expect(h.doc()).toBe("- [x] a ✅ 2026-11-09\n- [x] b ✅ 2026-11-09\n- [x] c ✅ 2026-11-09");
		expect(h.events().map((e) => e.line)).toEqual([0, 1, 2]);
	});

	it("a task line in a fence never fires when its checkbox is retyped", () => {
		const h = harness("```\n- [ ] a\n```");
		backspace(h, 8);
		type(h, 7, "x");
		expect(h.doc()).toBe("```\n- [x] a\n```");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("a plugin self-write that restores the checkbox is not detected", () => {
		const h = harness("- [ ] a");
		backspace(h, 4);
		h.dispatch({ changes: { from: 3, insert: "x" }, annotations: taskLifecycleSelfWrite.of(true) });
		expect(h.doc()).toBe("- [x] a");
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("random text edits on non-task lines never fire", () => {
		const h = harness("a\n- [] b\n- [x] c ✅ 2026-11-01");
		type(h, 0, "z");
		type(h, h.state.doc.line(2).from + 3, "x");
		expect(h.doc().split("\n")[1]).toBe("- [x] b");
		expect(h.emit).not.toHaveBeenCalled();
	});
});
