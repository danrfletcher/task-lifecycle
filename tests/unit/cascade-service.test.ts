import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createCascadeService,
	type CascadeEditor,
	type CascadeService,
} from "../../src/cascade/cascade-service";
import type { CascadeChoice, CascadePrompt } from "../../src/cascade/close-subtasks-modal";
import { STATUS_CHANGED_EVENT, TaskLifecycleEvents } from "../../src/events/event-bus";
import { SettingsStore, type TaskLifecycleSettings } from "../../src/settings/settings";

type Change = {
	from: { line: number; ch: number };
	to?: { line: number; ch: number };
	text: string;
};

/** An editor over a line array that records every `transaction` call and applies it. */
class FakeEditor implements CascadeEditor {
	transactions: Change[][] = [];
	constructor(public lines: string[]) {}
	lineCount(): number {
		return this.lines.length;
	}
	getLine(n: number): string {
		return this.lines[n];
	}
	transaction(tx: { changes?: Change[] }): void {
		const changes = tx.changes ?? [];
		this.transactions.push(changes);
		for (const c of changes) {
			const to = c.to ?? c.from;
			expect(to.line).toBe(c.from.line);
			const line = this.lines[c.from.line];
			this.lines[c.from.line] = line.slice(0, c.from.ch) + c.text + line.slice(to.ch);
		}
	}
}

/** A prompt that waits for the test to answer. A second `open` resolves the first as "leave". */
class FakePrompt implements CascadePrompt {
	counts: number[] = [];
	private pending: ((c: CascadeChoice) => void) | null = null;
	closeOpenCalls = 0;
	/** When true, `closeOpen` does nothing (a dialog that outlives the close request). */
	ignoreClose = false;
	/** When true, the next `open` rejects. */
	failNextOpen = false;
	get isOpen(): boolean {
		return this.pending !== null;
	}
	open(count: number): Promise<CascadeChoice> {
		if (this.failNextOpen) {
			this.failNextOpen = false;
			return Promise.reject(new Error("boom"));
		}
		this.pending?.("leave");
		this.counts.push(count);
		return new Promise((resolve) => {
			this.pending = (choice) => {
				this.pending = null;
				resolve(choice);
			};
		});
	}
	closeOpen(): void {
		this.closeOpenCalls += 1;
		if (this.ignoreClose) return;
		this.pending?.("leave");
	}
	answer(choice: CascadeChoice): void {
		this.pending?.(choice);
	}
}

const FILE = { path: "Scratch/lifecycle-demo.md" } as never;
const OTHER_FILE = { path: "Other.md" } as never;

const GP_CLOSED = [
	"- [x] Ship release ✅ 2026-11-09 ^rel1",
	"\t- [ ] Write notes",
	"\t- Notes",
	"\t\t- [ ] Proofread",
	"\t- [x] Tag build ✅ 2026-11-08",
	"- [ ] Book venue",
];

interface Rig {
	editor: FakeEditor;
	prompt: FakePrompt;
	events: TaskLifecycleEvents;
	settings: SettingsStore;
	service: CascadeService;
	/** What `getEditor` returns right now (null = note closed). */
	setEditor(e: CascadeEditor | null): void;
	close(line: number, lineText: string, from: string, to: string, file?: unknown): void;
}

function makeRig(lines: string[], settings: Partial<TaskLifecycleSettings> = {}): Rig {
	const editor = new FakeEditor([...lines]);
	const prompt = new FakePrompt();
	const events = new TaskLifecycleEvents();
	const store = new SettingsStore({
		loadData: async () => settings,
		saveData: async () => undefined,
	});
	// `load()` is async; seed the state synchronously through `update` semantics instead.
	void store.update(settings);
	let current: CascadeEditor | null = editor;
	const service = createCascadeService({
		events,
		settings: store,
		prompt,
		getEditor: () => current,
		today: () => new Date(2026, 10, 9, 12, 0),
	});
	return {
		editor,
		prompt,
		events,
		settings: store,
		service,
		setEditor: (e) => {
			current = e;
		},
		close: (line, lineText, from, to, file = FILE) =>
			events.emit(STATUS_CHANGED_EVENT, { file: file as never, line, lineText, from, to }),
	};
}

/** Let the deferred (microtask) handling and the promise chain run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 10, 9, 12, 0));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("G12 / GP3 / GP4: close, prompt, confirm", () => {
	it("prompts with the open-subtask count and, on confirm, writes one transaction", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		expect(r.prompt.counts).toEqual([]); // nothing during the event: the read is deferred
		await flush();
		expect(r.prompt.counts).toEqual([2]);
		expect(r.editor.transactions).toHaveLength(0);

		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toHaveLength(1);
		expect(r.editor.lines).toEqual([
			"- [x] Ship release ✅ 2026-11-09 ^rel1",
			"\t- [x] Write notes ✅ 2026-11-09",
			"\t- Notes",
			"\t\t- [x] Proofread ✅ 2026-11-09",
			"\t- [x] Tag build ✅ 2026-11-08",
			"- [ ] Book venue",
		]);
	});

	it("writes line-local span edits, not whole-line replacements", async () => {
		const r = makeRig(["- [x] p", "\t- [ ] a"]);
		r.close(0, "- [x] p", " ", "x");
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toEqual([
			[{ from: { line: 1, ch: 4 }, to: { line: 1, ch: 8 }, text: "x] a ✅ 2026-11-09" }],
		]);
	});

	it("is a cancelled close: subtasks get '-' and a cancelled stamp", async () => {
		const r = makeRig(["- [-] p ❌ 2026-11-09", "\t- [ ] a"]);
		r.close(0, "- [-] p", " ", "-");
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines[1]).toBe("\t- [-] a ❌ 2026-11-09");
	});

	it("an upper-case X parent gives lower-case x subtasks", async () => {
		const r = makeRig(["- [X] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.close(0, "- [X] p", " ", "X");
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines[1]).toBe("\t- [x] a ✅ 2026-11-09");
	});

	it("stamps off: the cascade still runs and adds no emoji (G20)", async () => {
		const r = makeRig(["- [x] p", "\t- [ ] a ^b1"], { closeStamps: false });
		r.close(0, "- [x] p", " ", "x");
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines).toEqual(["- [x] p", "\t- [x] a ^b1"]);
	});

	it("G17: closing a subtask prompts for its block only", async () => {
		const lines = ["- [ ] top", "\t- [x] mid ✅ 2026-11-09", "\t\t- [ ] mid child", "\t- [ ] sibling"];
		const r = makeRig(lines);
		r.close(1, "\t- [x] mid", " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([1]);
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines).toEqual([
			"- [ ] top",
			"\t- [x] mid ✅ 2026-11-09",
			"\t\t- [x] mid child ✅ 2026-11-09",
			"\t- [ ] sibling",
		]);
	});

	it("a pasted/moved line is found by its text at apply time", async () => {
		const r = makeRig(["- [x] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.close(0, "- [x] p", " ", "x");
		await flush();
		// While the dialog is open, a line is inserted above: the parent moves to line 1.
		r.editor.lines = ["new first line", ...r.editor.lines];
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines).toEqual([
			"new first line",
			"- [x] p ✅ 2026-11-09",
			"\t- [x] a ✅ 2026-11-09",
		]);
		expect(r.editor.transactions).toHaveLength(1);
	});
});

describe("G12 / G16: which transitions prompt", () => {
	const lines = ["- [x] p", "\t- [ ] a"];

	it.each([
		[" ", "x"],
		[" ", "-"],
		["/", "x"],
		["/", "-"],
		["?", "x"],
		[">", "-"],
		[" ", "X"],
	])("%j -> %j prompts", async (from, to) => {
		const text = `- [${to}] p`;
		const r = makeRig([text, "\t- [ ] a"]);
		r.close(0, text, from, to);
		await flush();
		expect(r.prompt.counts).toEqual([1]);
	});

	it.each([
		["x", "-"],
		["-", "x"],
		["X", "-"],
		["x", "X"],
		["x", " "],
		["x", "/"],
		["-", " "],
		["-", "/"],
		[" ", "/"],
		["/", " "],
		[" ", "?"],
		["x", "?"],
	])("%j -> %j never prompts", async (from, to) => {
		const r = makeRig([`- [${to}] p`, "\t- [ ] a"]);
		r.close(0, `- [${to}] p`, from, to);
		await flush();
		expect(r.prompt.counts).toEqual([]);
		expect(r.editor.transactions).toHaveLength(0);
	});

	it("G16: reopening a parent changes no subtask and never prompts", async () => {
		const r = makeRig(["- [ ] p", "\t- [x] a ✅ 2026-11-09", "\t- [ ] b"]);
		r.close(0, "- [ ] p", "x", " ");
		await flush();
		expect(r.prompt.counts).toEqual([]);
		expect(r.editor.lines).toEqual(["- [ ] p", "\t- [x] a ✅ 2026-11-09", "\t- [ ] b"]);
	});

	it("G15: no subtasks, only closed subtasks, or only plain bullets: no dialog", async () => {
		for (const sub of [[], ["\t- [x] a", "\t- [-] b"], ["\t- note", "\t- another"]]) {
			const r = makeRig(["- [x] p", ...sub]);
			r.close(0, "- [x] p", " ", "x");
			await flush();
			expect(r.prompt.counts).toEqual([]);
		}
	});

	it("an event with no file is ignored", async () => {
		const r = makeRig(lines);
		r.close(0, "- [x] p", " ", "x", null);
		await flush();
		expect(r.prompt.counts).toEqual([]);
	});

	it("a reported line that is not the closed task is ignored", async () => {
		const r = makeRig(lines);
		r.close(0, "- [x] something else", " ", "x");
		r.close(1, "\t- [x] a", " ", "x"); // line 1 is an open task, not closed
		await flush();
		expect(r.prompt.counts).toEqual([]);
	});

	it("a line number past the end of the note is ignored", async () => {
		const r = makeRig(lines);
		r.close(9, "- [x] p", " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([]);
	});

	it("a stale stamp on the reported line text still matches the closed task", async () => {
		const r = makeRig(["- [x] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.close(0, "- [x] p ❌ 2026-10-01", " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([1]);
	});
});

describe("dedupe and timing (E7, E9)", () => {
	it("E7: the same close reported twice within 1500 ms opens one dialog", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await vi.advanceTimersByTimeAsync(700);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2]);
		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toHaveLength(1);
	});

	it("the same close 1500 ms later is a new close", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await vi.advanceTimersByTimeAsync(1499);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2]);
		await vi.advanceTimersByTimeAsync(1);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2, 2]);
	});

	it("the dedupe key is the file and the line", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		r.close(0, "- [x] Ship release ^rel1", "/", "x", OTHER_FILE);
		await flush();
		expect(r.prompt.counts).toEqual([2, 2]);
	});

	it("E9: two different parents closed quickly both prompt; the second replaces the first", async () => {
		const lines = [
			"- [x] one ✅ 2026-11-09",
			"\t- [ ] one-a",
			"- [x] two ✅ 2026-11-09",
			"\t- [ ] two-a",
			"\t- [ ] two-b",
		];
		const r = makeRig(lines);
		r.close(0, "- [x] one", " ", "x");
		r.close(2, "- [x] two", " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([1, 2]);
		// The first dialog was closed as "leave": nothing was written for it.
		expect(r.editor.transactions).toHaveLength(0);
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines).toEqual([
			"- [x] one ✅ 2026-11-09",
			"\t- [ ] one-a",
			"- [x] two ✅ 2026-11-09",
			"\t- [x] two-a ✅ 2026-11-09",
			"\t- [x] two-b ✅ 2026-11-09",
		]);
		expect(r.editor.transactions).toHaveLength(1);
	});

	it("the close is only noted after the dispatch: reading happens in a later tick", async () => {
		const r = makeRig(GP_CLOSED);
		const getLine = vi.spyOn(r.editor, "getLine");
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		expect(getLine).not.toHaveBeenCalled();
		await flush();
		expect(getLine).toHaveBeenCalled();
	});
});

describe("G13: recompute at apply time", () => {
	async function open(lines: string[], count = 1) {
		const r = makeRig(lines);
		r.close(0, "- [x] p", " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([count]);
		return r;
	}

	it("subtasks added while the dialog is open are closed too", async () => {
		const r = await open(["- [x] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.editor.lines.push("\t- [ ] b");
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines).toEqual([
			"- [x] p ✅ 2026-11-09",
			"\t- [x] a ✅ 2026-11-09",
			"\t- [x] b ✅ 2026-11-09",
		]);
	});

	it("a subtask closed by hand while the dialog is open is left alone", async () => {
		const r = await open(["- [x] p ✅ 2026-11-09", "\t- [ ] a", "\t- [ ] b"], 2);
		r.editor.lines[1] = "\t- [x] a ✅ 2026-11-01";
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines[1]).toBe("\t- [x] a ✅ 2026-11-01");
		expect(r.editor.lines[2]).toBe("\t- [x] b ✅ 2026-11-09");
	});

	it("the parent deleted while the dialog is open: nothing changes", async () => {
		const r = await open(["- [x] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.editor.lines = ["\t- [ ] a"];
		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toHaveLength(0);
		expect(r.editor.lines).toEqual(["\t- [ ] a"]);
	});

	it("the parent reopened while the dialog is open: nothing changes", async () => {
		const r = await open(["- [x] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.editor.lines[0] = "- [ ] p";
		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toHaveLength(0);
		expect(r.editor.lines).toEqual(["- [ ] p", "\t- [ ] a"]);
	});

	it("the parent's text changed while the dialog is open: nothing changes", async () => {
		const r = await open(["- [x] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.editor.lines[0] = "- [x] p edited ✅ 2026-11-09";
		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toHaveLength(0);
	});

	it("with two identical parent lines, the one nearest the original line is used", async () => {
		const r = await open(["- [x] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.editor.lines = ["- [x] p ✅ 2026-11-09", "\t- [ ] far", "x", "- [x] p ✅ 2026-11-09", "\t- [ ] a"];
		// The original line 0 still holds the recorded text, so it is the parent.
		r.prompt.answer("close");
		await flush();
		expect(r.editor.lines).toEqual([
			"- [x] p ✅ 2026-11-09",
			"\t- [x] far ✅ 2026-11-09",
			"x",
			"- [x] p ✅ 2026-11-09",
			"\t- [ ] a",
		]);
	});

	it("the note is no longer open at apply time: nothing changes", async () => {
		const r = await open(["- [x] p ✅ 2026-11-09", "\t- [ ] a"]);
		r.setEditor(null);
		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toHaveLength(0);
	});

	it("the note is no longer open when the deferred work runs: no dialog", async () => {
		const r = makeRig(["- [x] p", "\t- [ ] a"]);
		r.setEditor(null);
		r.close(0, "- [x] p", " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([]);
	});
});

describe("G14: leave", () => {
	it("Leave open changes nothing", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		r.prompt.answer("leave");
		await flush();
		expect(r.editor.transactions).toHaveLength(0);
		expect(r.editor.lines).toEqual(GP_CLOSED);
	});

	it("cancelPrompt (note switched) closes the dialog and nothing changes", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		expect(r.prompt.isOpen).toBe(true);
		r.service.cancelPrompt();
		await flush();
		expect(r.prompt.isOpen).toBe(false);
		expect(r.editor.transactions).toHaveLength(0);
	});
});

describe("G21: Close cascade off", () => {
	it("no dialog for any close", async () => {
		const r = makeRig(GP_CLOSED, { closeCascade: false });
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		r.close(0, "- [-] Ship release ^rel1", " ", "-");
		await flush();
		expect(r.prompt.counts).toEqual([]);
	});

	it("turning it off while the dialog is open closes the dialog as Leave open", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		expect(r.prompt.isOpen).toBe(true);
		await r.settings.update({ closeCascade: false });
		expect(r.prompt.isOpen).toBe(false);
		await flush();
		expect(r.editor.transactions).toHaveLength(0);
	});

	it("turning other settings off does not close the dialog", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		await r.settings.update({ closeStamps: false });
		expect(r.prompt.isOpen).toBe(true);
	});

	it("an answer of close after the setting went off writes nothing", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		// Setting flips without the listener closing the fake dialog first.
		r.prompt.ignoreClose = true;
		await r.settings.update({ closeCascade: false });
		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toHaveLength(0);
	});

	it("turning it back on works again", async () => {
		const r = makeRig(GP_CLOSED, { closeCascade: false });
		await r.settings.update({ closeCascade: true });
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2]);
	});
});

describe("dispose (E12)", () => {
	it("closes an open dialog, writes nothing and stops listening", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		r.service.dispose();
		expect(r.prompt.isOpen).toBe(false);
		await flush();
		expect(r.editor.transactions).toHaveLength(0);

		r.close(0, "- [x] Ship release ^rel1", "/", "x", OTHER_FILE);
		await flush();
		expect(r.prompt.counts).toEqual([2]);
	});

	it("a close reported before dispose but handled after it opens no dialog", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		r.service.dispose();
		await flush();
		expect(r.prompt.counts).toEqual([]);
	});

	it("an answer of close after dispose writes nothing", async () => {
		const r = makeRig(GP_CLOSED);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		r.prompt.ignoreClose = true;
		r.service.dispose();
		r.prompt.answer("close");
		await flush();
		expect(r.editor.transactions).toHaveLength(0);
	});

	it("dispose twice is harmless", () => {
		const r = makeRig(GP_CLOSED);
		r.service.dispose();
		expect(() => r.service.dispose()).not.toThrow();
	});
});

describe("failures are contained", () => {
	it("a throwing prompt is logged and does not break later closes", async () => {
		const r = makeRig(GP_CLOSED);
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		r.prompt.failNextOpen = true;
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		expect(err).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		r.close(0, "- [x] Ship release ^rel1", "/", "x");
		await flush();
		expect(r.prompt.isOpen).toBe(true);
		err.mockRestore();
	});
});
