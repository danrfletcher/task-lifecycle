import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createCascadeService,
	type CascadeEditor,
	type CascadeFiles,
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

/**
 * The closed-note route: the source is not open in any editor, so the text
 * comes from `files.read` and every subtask is written in one `files.process`
 * call (a function over the note's string, like `vault.process`).
 */
const UNMAPPABLE = "Task Lifecycle: couldn't find this task's source line, nothing changed";

class FakeFiles implements CascadeFiles {
	processCalls = 0;
	reads = 0;
	/** When set, `read` and `process` reject, as for a note that was deleted or renamed. */
	gone = false;
	constructor(public text: string) {}
	async read(): Promise<string> {
		this.reads += 1;
		if (this.gone) throw new Error("ENOENT");
		return this.text;
	}
	async process(_file: unknown, fn: (data: string) => string): Promise<void> {
		this.processCalls += 1;
		if (this.gone) throw new Error("ENOENT");
		this.text = fn(this.text);
	}
}

interface FileRig {
	files: FakeFiles;
	prompt: FakePrompt;
	settings: SettingsStore;
	service: CascadeService;
	notices: string[];
	/** What `getEditor` returns right now (null = the note is closed). */
	setEditor(e: CascadeEditor | null): void;
	/** A rendered checkbox closed the task on `line`: what the embed presser reports. */
	report(line: number, lineText: string, from: string, to: string, file?: unknown): void;
}

function makeFileRig(text: string, settings: Partial<TaskLifecycleSettings> = {}): FileRig {
	const files = new FakeFiles(text);
	const prompt = new FakePrompt();
	const events = new TaskLifecycleEvents();
	const store = new SettingsStore({ loadData: async () => settings, saveData: async () => undefined });
	void store.update(settings);
	const notices: string[] = [];
	let current: CascadeEditor | null = null;
	const service = createCascadeService({
		events,
		settings: store,
		prompt,
		getEditor: () => current,
		files,
		notify: (m) => notices.push(m),
		today: () => new Date(2026, 10, 20, 12, 0),
	});
	return {
		files,
		prompt,
		settings: store,
		service,
		notices,
		setEditor: (e) => {
			current = e;
		},
		report: (line, lineText, from, to, file = FILE) =>
			service.reportClose({ file: file as never, line, lineText, from, to }),
	};
}

const COURSE = "- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n\t- [ ] Watch video\n\t- [/] Take notes ^n1\n";
const COURSE_CLOSED =
	"- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n\t- [x] Watch video ✅ 2026-11-20\n\t- [x] Take notes ✅ 2026-11-20 ^n1\n";
const PARENT = "- [x] Lesson 2 content ✅ 2026-11-20 ^l2";

describe("closed note: the dialog and the one write (G6, E10)", () => {
	it("asks with the count from the file, then writes every open subtask in one process call", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2]);
		expect(r.files.processCalls).toBe(0);

		r.prompt.answer("close");
		await flush();
		expect(r.files.processCalls).toBe(1);
		expect(r.files.text).toBe(COURSE_CLOSED);
		expect(r.notices).toEqual([]);
	});

	it("a cancelled parent gives - and ❌ on the subtasks", async () => {
		const parent = "- [-] Lesson 2 content ❌ 2026-11-20 ^l2";
		const r = makeFileRig(parent + "\n\t- [ ] a\n");
		r.report(0, parent, " ", "-");
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe(parent + "\n\t- [-] a ❌ 2026-11-20\n");
	});

	it("Close stamps off: status only, no emoji (G7)", async () => {
		const r = makeFileRig("- [x] p ^l2\n\t- [ ] a ^a1\n", { closeStamps: false });
		r.report(0, "- [x] p ^l2", " ", "x");
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe("- [x] p ^l2\n\t- [x] a ^a1\n");
	});

	it("\"Leave open\" changes nothing and calls process zero times", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, "/", "x");
		await flush();
		r.prompt.answer("leave");
		await flush();
		expect(r.files.processCalls).toBe(0);
		expect(r.files.text).toBe(COURSE);
	});

	it("the singular count: one open subtask", async () => {
		const r = makeFileRig("- [x] p ✅ 2026-11-20\n\t- [ ] a\n\t- [x] done ✅ 2026-11-01\n");
		r.report(0, "- [x] p ✅ 2026-11-20", " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([1]);
	});

	it("CRLF (E5): the write keeps every \\r\\n", async () => {
		const text = "# T\r\n\r\n" + COURSE.replace(/\n/g, "\r\n");
		const r = makeFileRig(text);
		r.report(2, PARENT, " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2]);
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe("# T\r\n\r\n" + COURSE_CLOSED.replace(/\n/g, "\r\n"));
	});

	it("mixed line endings are kept as they were, line by line", async () => {
		const r = makeFileRig("- [x] p ✅ 2026-11-20\r\n\t- [ ] a\n\t- [ ] b\r\n");
		r.report(0, "- [x] p ✅ 2026-11-20", " ", "x");
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe(
			"- [x] p ✅ 2026-11-20\r\n\t- [x] a ✅ 2026-11-20\n\t- [x] b ✅ 2026-11-20\r\n"
		);
	});

	it("nothing is read or written during the report itself: the reading is deferred", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x");
		expect(r.files.reads).toBe(0);
		await flush();
		expect(r.files.reads).toBe(1);
	});
});

describe("closed note: which closes prompt (G6, G7)", () => {
	it("a parent with only closed subtasks, or none, or only plain bullets: no dialog and no write", async () => {
		for (const sub of ["", "\t- [x] a\n\t- [-] b\n", "\t- note\n"]) {
			const r = makeFileRig("- [x] p ✅ 2026-11-20\n" + sub);
			r.report(0, "- [x] p ✅ 2026-11-20", " ", "x");
			await flush();
			expect(r.prompt.counts).toEqual([]);
			expect(r.files.processCalls).toBe(0);
		}
	});

	it("x <-> - and every reopen never prompt", async () => {
		for (const [from, to] of [
			["x", "-"],
			["-", "x"],
			["x", " "],
			["-", " "],
			["x", "/"],
		]) {
			const r = makeFileRig(`- [${to}] p\n\t- [ ] a\n`);
			r.report(0, `- [${to}] p`, from, to);
			await flush();
			expect(r.prompt.counts).toEqual([]);
		}
	});

	it("Close cascade off: no dialog, no read, no write", async () => {
		const r = makeFileRig(COURSE, { closeCascade: false });
		r.report(0, PARENT, " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([]);
		expect(r.files.reads).toBe(0);
		expect(r.files.processCalls).toBe(0);
	});

	it("turning Close cascade off while the dialog is open closes it as Leave open; no write follows", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x");
		await flush();
		await r.settings.update({ closeCascade: false });
		await flush();
		expect(r.prompt.isOpen).toBe(false);
		expect(r.files.processCalls).toBe(0);
	});

	it("an event with no file, or a task that a later press already moved on, opens nothing and shows nothing", async () => {
		const r = makeFileRig("- [-] p ❌ 2026-11-20\n\t- [ ] a\n");
		r.report(0, PARENT, " ", "x", null);
		r.report(0, "- [x] p ✅ 2026-11-20", " ", "x"); // the file already says [-]
		r.report(9, "- [x] p", " ", "x"); // past the end
		await flush();
		expect(r.prompt.counts).toEqual([]);
		expect(r.notices).toEqual([]);
	});

	it("without a files port the service is editor-only: a closed note is ignored", async () => {
		const prompt = new FakePrompt();
		const store = new SettingsStore({ loadData: async () => ({}), saveData: async () => undefined });
		const service = createCascadeService({
			events: new TaskLifecycleEvents(),
			settings: store,
			prompt,
			getEditor: () => null,
		});
		service.reportClose({ file: FILE, line: 0, lineText: PARENT, from: " ", to: "x" });
		await flush();
		expect(prompt.counts).toEqual([]);
	});
});

describe("closed note: locate by content at apply time (E10)", () => {
	async function open(text = COURSE) {
		const r = makeFileRig(text);
		r.report(0, PARENT, " ", "x");
		await flush();
		expect(r.prompt.isOpen).toBe(true);
		return r;
	}

	it("one match, moved by a line inserted above while the dialog is open: found and written", async () => {
		const r = await open();
		r.files.text = "new first line\n" + r.files.text;
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe("new first line\n" + COURSE_CLOSED);
		expect(r.notices).toEqual([]);
	});

	it("zero matches (the parent was edited): nothing is written, the notice shows, one process call that changed nothing", async () => {
		const r = await open();
		const edited = COURSE.replace("Lesson 2 content", "Lesson 2 edited");
		r.files.text = edited;
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe(edited);
		expect(r.notices).toEqual([UNMAPPABLE]);
	});

	it("many matches (the parent line was duplicated): nothing is written and the notice shows", async () => {
		const r = await open();
		const dup = COURSE + PARENT + "\n\t- [ ] other\n";
		r.files.text = dup;
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe(dup);
		expect(r.notices).toEqual([UNMAPPABLE]);
	});

	it("the parent reopened while the dialog is open: nothing is written, no notice", async () => {
		const r = await open();
		const reopened = COURSE.replace("[x]", "[ ]").replace(" ✅ 2026-11-20 ^l2", " ^l2");
		r.files.text = reopened;
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe(reopened);
		expect(r.files.processCalls).toBe(1);
		expect(r.notices).toEqual([UNMAPPABLE]);
	});

	it("subtasks changed between the dialog opening and Close subtasks: the walk is recomputed, only tasks still open close", async () => {
		const r = await open();
		r.files.text =
			"- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n\t- [x] Watch video ✅ 2026-11-01\n\t- [/] Take notes ^n1\n\t- [ ] Added later\n";
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe(
			"- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n\t- [x] Watch video ✅ 2026-11-01\n\t- [x] Take notes ✅ 2026-11-20 ^n1\n\t- [x] Added later ✅ 2026-11-20\n"
		);
		expect(r.files.processCalls).toBe(1);
	});

	it("every subtask closed meanwhile: one process call, no change, no notice", async () => {
		const r = await open();
		r.files.text = COURSE_CLOSED;
		r.prompt.answer("close");
		await flush();
		expect(r.files.text).toBe(COURSE_CLOSED);
		expect(r.notices).toEqual([]);
	});

	it("the source is deleted or renamed while the dialog is open: a no-op with the notice, no throw, no unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", onUnhandled);
		try {
			const r = await open();
			r.files.gone = true;
			r.prompt.answer("close");
			await flush();
			expect(r.notices).toEqual([UNMAPPABLE]);
			await flush();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("the source is gone when the dialog would open: the notice shows and no dialog opens", async () => {
		const r = makeFileRig(COURSE);
		r.files.gone = true;
		r.report(0, PARENT, " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([]);
		expect(r.notices).toEqual([UNMAPPABLE]);
	});

	it("the Close cascade setting went off before the answer: nothing is written", async () => {
		const r = await open();
		r.prompt.ignoreClose = true;
		await r.settings.update({ closeCascade: false });
		r.prompt.answer("close");
		await flush();
		expect(r.files.processCalls).toBe(0);
	});
});

describe("closed note: the editor is looked up again at apply time (G8)", () => {
	it("the source opened in a pane while the dialog is showing: the editor transaction path, not process", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2]);

		// The note is now open, with the same text plus unsaved typing at the end.
		const editor = new FakeEditor([...COURSE.split("\n").slice(0, 3), "typed, not saved"]);
		r.setEditor(editor);
		r.prompt.answer("close");
		await flush();
		expect(r.files.processCalls).toBe(0);
		expect(editor.transactions).toHaveLength(1);
		expect(editor.lines).toEqual([
			"- [x] Lesson 2 content ✅ 2026-11-20 ^l2",
			"\t- [x] Watch video ✅ 2026-11-20",
			"\t- [x] Take notes ✅ 2026-11-20 ^n1",
			"typed, not saved",
		]);
	});

	it("an open note keeps the editor path from the start: the file port is never touched", async () => {
		const r = makeFileRig(COURSE);
		const editor = new FakeEditor(COURSE.split("\n").slice(0, 3));
		r.setEditor(editor);
		r.report(0, PARENT, " ", "x");
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.files.reads).toBe(0);
		expect(r.files.processCalls).toBe(0);
		expect(editor.transactions).toHaveLength(1);
	});
});

describe("closed note: dedupe, replacement, dispose (E7, E9, E12)", () => {
	it("the same close reported twice within 1500 ms opens one dialog; 1500 ms later it is a new close", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x");
		await vi.advanceTimersByTimeAsync(700);
		r.report(0, PARENT, " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2]);
		await vi.advanceTimersByTimeAsync(800);
		r.report(0, PARENT, " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([2, 2]);
	});

	it("two different parents closed in quick succession: the second dialog replaces the first, which settles as Leave open", async () => {
		const text = "- [x] one ✅ 2026-11-20 ^o\n\t- [ ] one-a\n- [x] two ✅ 2026-11-20 ^t\n\t- [ ] two-a\n\t- [ ] two-b\n";
		const r = makeFileRig(text);
		r.report(0, "- [x] one ✅ 2026-11-20 ^o", " ", "x");
		r.report(2, "- [x] two ✅ 2026-11-20 ^t", " ", "x");
		await flush();
		expect(r.prompt.counts).toEqual([1, 2]);
		expect(r.files.processCalls).toBe(0);
		r.prompt.answer("close");
		await flush();
		expect(r.files.processCalls).toBe(1);
		expect(r.files.text).toBe(
			"- [x] one ✅ 2026-11-20 ^o\n\t- [ ] one-a\n- [x] two ✅ 2026-11-20 ^t\n\t- [x] two-a ✅ 2026-11-20\n\t- [x] two-b ✅ 2026-11-20\n"
		);
	});

	it("isDialogOpen is true only while a dialog is showing, and a replaced dialog's late settle does not clear the new one", async () => {
		const text = "- [x] one ✅ 2026-11-20 ^o\n\t- [ ] one-a\n- [x] two ✅ 2026-11-20 ^t\n\t- [ ] two-a\n";
		const r = makeFileRig(text);
		expect(r.service.isDialogOpen()).toBe(false);
		r.report(0, "- [x] one ✅ 2026-11-20 ^o", " ", "x");
		r.report(2, "- [x] two ✅ 2026-11-20 ^t", " ", "x");
		await flush();
		expect(r.service.isDialogOpen()).toBe(true);
		r.prompt.answer("leave");
		await flush();
		expect(r.service.isDialogOpen()).toBe(false);
	});

	it("dispose with the dialog open closes it as Leave open, writes nothing and stops reporting", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x");
		await flush();
		r.service.dispose();
		expect(r.prompt.isOpen).toBe(false);
		expect(r.service.isDialogOpen()).toBe(false);
		await flush();
		expect(r.files.processCalls).toBe(0);

		r.report(0, PARENT, " ", "x", OTHER_FILE);
		await flush();
		expect(r.prompt.counts).toEqual([2]);
	});

	it("an answer of close that arrives after dispose writes nothing and shows nothing", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x");
		await flush();
		r.prompt.ignoreClose = true;
		r.service.dispose();
		r.prompt.answer("close");
		await flush();
		expect(r.files.processCalls).toBe(0);
		expect(r.notices).toEqual([]);
	});

	it("a failure to write after dispose (the writer was shut down first) shows no notice", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x");
		await flush();
		r.prompt.ignoreClose = true;
		r.files.process = async () => {
			r.service.dispose();
			throw new Error("disposed");
		};
		r.prompt.answer("close");
		await flush();
		expect(r.notices).toEqual([]);
	});
});

describe("closed note: rename and pane while the dialog is open (T1, T2)", () => {
	const fileAt = (path: string): { path: string } => ({ path });

	it("the source is renamed while the dialog is open: nothing is written and the notice shows", async () => {
		const r = makeFileRig(COURSE);
		const file = fileAt("Course.md");
		r.report(0, PARENT, " ", "x", file);
		await flush();
		expect(r.prompt.counts).toEqual([2]);

		// Obsidian renames the same TFile in place: the file still reads fine at its new path.
		file.path = "Course-renamed.md";
		r.prompt.answer("close");
		await flush();
		expect(r.files.processCalls).toBe(0);
		expect(r.files.text).toBe(COURSE);
		expect(r.notices).toEqual([UNMAPPABLE]);
	});

	it("the source is renamed while the dialog is open and is also open in an editor: no transaction, the notice shows", async () => {
		const r = makeFileRig(COURSE);
		const file = fileAt("Course.md");
		r.report(0, PARENT, " ", "x", file);
		await flush();
		const editor = new FakeEditor(COURSE.split("\n").slice(0, 3));
		r.setEditor(editor);
		file.path = "Course-renamed.md";
		r.prompt.answer("close");
		await flush();
		expect(editor.transactions).toHaveLength(0);
		expect(r.files.processCalls).toBe(0);
		expect(r.notices).toEqual([UNMAPPABLE]);
	});

	it("a note that is not renamed is still written (control)", async () => {
		const r = makeFileRig(COURSE);
		r.report(0, PARENT, " ", "x", fileAt("Course.md"));
		await flush();
		r.prompt.answer("close");
		await flush();
		expect(r.files.processCalls).toBe(1);
		expect(r.notices).toEqual([]);
	});

	it("cancelPrompt(the dialog's own note) keeps the dialog; the apply then takes the editor path with unsaved typing", async () => {
		const r = makeFileRig(COURSE);
		const file = fileAt("Course.md");
		r.report(0, PARENT, " ", "x", file);
		await flush();

		// The note is opened in a pane: the workspace says it is showing, and an editor now exists.
		const editor = new FakeEditor([...COURSE.split("\n").slice(0, 3), "typed, not saved"]);
		r.setEditor(editor);
		r.service.cancelPrompt(file as never);
		await flush();
		expect(r.prompt.closeOpenCalls).toBe(0);
		expect(r.prompt.isOpen).toBe(true);
		expect(r.service.isDialogOpen()).toBe(true);

		r.prompt.answer("close");
		await flush();
		expect(r.files.processCalls).toBe(0);
		expect(editor.transactions).toHaveLength(1);
		expect(editor.lines[3]).toBe("typed, not saved");
		expect(editor.lines[1]).toBe("\t- [x] Watch video ✅ 2026-11-20");
	});

	it("cancelPrompt(another note) closes the dialog as Leave open; so does cancelPrompt with no note", async () => {
		for (const shown of [fileAt("Other.md"), null, undefined]) {
			const r = makeFileRig(COURSE);
			r.report(0, PARENT, " ", "x", fileAt("Course.md"));
			await flush();
			r.service.cancelPrompt(shown as never);
			await flush();
			expect(r.prompt.isOpen).toBe(false);
			expect(r.files.processCalls).toBe(0);
			expect(r.service.isDialogOpen()).toBe(false);
		}
	});

	it("cancelPrompt(the note) with no dialog open does nothing", async () => {
		const r = makeFileRig(COURSE);
		r.service.cancelPrompt(fileAt("Course.md") as never);
		await flush();
		expect(r.service.isDialogOpen()).toBe(false);
	});
});
