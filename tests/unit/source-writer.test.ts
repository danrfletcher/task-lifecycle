import { afterEach, describe, expect, it, vi } from "vitest";
import { STATUS_SEQUENCE, type PressKind } from "../../src/domain/status-sequence";
import { createSourceWriter, type SourceWriter } from "../../src/rendered/source-writer";
import { makeCmEditor } from "../helpers/cm-editor";
import { fixtureFile, remainder, SHAPE_LINES } from "../fixtures/source-lines";

const TODAY = new Date(2026, 10, 20, 12, 0, 0);

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

type SourceFile = Parameters<SourceWriter["press"]>[0];
const file = (path: string): SourceFile => ({ path, name: path, extension: "md" }) as never;

/** A fake vault: `process(file, fn)` applies `fn` to the stored string. Nothing else is available. */
function fakeVault(texts: Record<string, string>) {
	const gates = new Map<string, Deferred[]>();
	const vault = {
		texts: new Map(Object.entries(texts)),
		process: vi.fn(async (f: SourceFile, fn: (data: string) => string): Promise<string> => {
			const gate = gates.get(f.path)?.shift();
			if (gate) await gate.promise;
			const next = fn(vault.texts.get(f.path) ?? "");
			vault.texts.set(f.path, next);
			return next;
		}),
		read: vi.fn(),
		cachedRead: vi.fn(),
		modify: vi.fn(),
		/** Make the next `process` call on `path` wait until the returned handle is resolved. */
		hold(path: string): Deferred {
			const d = deferred();
			gates.set(path, [...(gates.get(path) ?? []), d]);
			return d;
		},
	};
	return vault;
}

/** A fake editor over an array of lines, optionally with a scroller. */
function fakeEditor(text: string, scroller?: { scrollTop: number; scrollLeft: number }) {
	const lines = text.split("\n");
	const editor = {
		lineCount: vi.fn(() => lines.length),
		getLine: vi.fn((n: number) => lines[n]),
		transaction: vi.fn(
			(tx: { changes?: Array<{ from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }> }) => {
				for (const c of tx.changes ?? []) {
					const l = lines[c.from.line];
					lines[c.from.line] = l.slice(0, c.from.ch) + c.text + l.slice((c.to ?? c.from).ch);
				}
				if (scroller) scroller.scrollTop = 0; // Live Preview re-lays out and jumps
			}
		),
		cm: scroller ? { scrollDOM: scroller } : undefined,
		text: () => lines.join("\n"),
		/** Typing the editor has that the disk copy does not. */
		type: (n: number, s: string) => {
			lines[n] += s;
		},
	};
	return editor;
}

/** Leaves as `getLeavesOfType("markdown")` returns them: `{ view: { file, editor, dirty } }`. */
function workspace(
	leaves: Array<{ path: string; editor?: unknown; dirty?: boolean }>,
	activeEditor?: { path: string; editor: unknown } | null
) {
	return {
		activeEditor: activeEditor ? { file: { path: activeEditor.path }, editor: activeEditor.editor } : null,
		getLeavesOfType: vi.fn((_type: string) =>
			leaves.map((l) => ({ view: { file: { path: l.path }, editor: l.editor, dirty: l.dirty } }))
		),
	};
}

function writerFor(
	vault: ReturnType<typeof fakeVault>,
	ws: ReturnType<typeof workspace>,
	opts: { closeStamps?: boolean } = {}
) {
	const settings = { closeStamps: opts.closeStamps ?? true };
	const writer = createSourceWriter({
		app: { vault, workspace: ws } as never,
		getSettings: () => settings,
		today: () => TODAY,
	});
	return { writer, settings };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("G8 source routing", () => {
	it("closed source: one vault.process call, no editor call", async () => {
		const vault = fakeVault({ "Course.md": "- [ ] Lesson 2 content ^l2\n" });
		const other = fakeEditor("- [ ] unrelated");
		const { writer } = writerFor(vault, workspace([{ path: "Other.md", editor: other }]));

		const r = await writer.press(file("Course.md"), 0, "click");

		expect(r).toEqual({ status: "written", route: "vault", line: 0, from: " ", to: "/", lineText: "- [/] Lesson 2 content ^l2" });
		expect(vault.process).toHaveBeenCalledTimes(1);
		expect(vault.texts.get("Course.md")).toBe("- [/] Lesson 2 content ^l2\n");
		expect(other.transaction).not.toHaveBeenCalled();
		expect(other.getLine).not.toHaveBeenCalled();
		expect(vault.modify).not.toHaveBeenCalled();
	});

	it.each([
		["a split", [{ path: "Main.md" }, { path: "Course.md", editor: "split" }]],
		["a popout window", [{ path: "Main.md" }, { path: "Other.md" }, { path: "Course.md", editor: "popout" }]],
	])("open source in %s: one editor transaction with a one-char change, no vault.process", async (_name, leaves) => {
		const editor = fakeEditor("# Course\n- [ ] Lesson 2 content ^l2");
		const ws = workspace(leaves.map((l) => (l.editor ? { ...l, editor } : l)));
		const vault = fakeVault({ "Course.md": "# Course\n- [ ] Lesson 2 content ^l2" });
		const { writer } = writerFor(vault, ws);

		const r = await writer.press(file("Course.md"), 1, "click");

		expect(r).toEqual({ status: "written", route: "editor", line: 1, from: " ", to: "/", lineText: "- [/] Lesson 2 content ^l2" });
		expect(ws.getLeavesOfType).toHaveBeenCalledWith("markdown");
		expect(editor.transaction).toHaveBeenCalledTimes(1);
		const tx = editor.transaction.mock.calls[0][0];
		expect(tx.changes).toEqual([{ from: { line: 1, ch: 3 }, to: { line: 1, ch: 4 }, text: "/" }]);
		expect(vault.process).not.toHaveBeenCalled();
		expect(editor.text()).toBe("# Course\n- [/] Lesson 2 content ^l2");
	});

	it("a leaf of the note without an editor (not a markdown view) falls to the vault route", async () => {
		const vault = fakeVault({ "Course.md": "- [ ] a" });
		const { writer } = writerFor(vault, workspace([{ path: "Course.md", editor: undefined }]));
		expect((await writer.press(file("Course.md"), 0, "click")).status).toBe("written");
		expect(vault.process).toHaveBeenCalledTimes(1);
	});

	it("stale disk copy: the edit is built from the editor's text, never from the vault", async () => {
		const vault = fakeVault({ "Course.md": "- [ ] old text ^l2" });
		const editor = fakeEditor("- [/] newer text in the editor ^l2");
		const { writer } = writerFor(vault, workspace([{ path: "Course.md", editor }]));

		const r = await writer.press(file("Course.md"), 0, "click");

		// The disk line says " " (would give "/"); the editor's says "/" (gives "x").
		expect(r).toEqual({
			status: "written",
			route: "editor",
			line: 0,
			from: "/",
			to: "x",
			lineText: "- [x] newer text in the editor ✅ 2026-11-20 ^l2",
		});
		expect(vault.read).not.toHaveBeenCalled();
		expect(vault.cachedRead).not.toHaveBeenCalled();
		expect(vault.process).not.toHaveBeenCalled();
		expect(editor.transaction.mock.calls[0][0].changes).toEqual([
			{ from: { line: 0, ch: 3 }, to: { line: 0, ch: 4 }, text: "x" },
		]);
		expect(vault.texts.get("Course.md")).toBe("- [ ] old text ^l2");
	});

	it("the route is chosen per write, when the write runs", async () => {
		const vault = fakeVault({ "Course.md": "- [ ] a" });
		const leaves: Array<{ path: string; editor?: unknown }> = [];
		const { writer } = writerFor(vault, workspace(leaves));
		const hold = vault.hold("Course.md");

		const first = writer.press(file("Course.md"), 0, "click"); // closed: vault
		await tick(); // the first write is now pending inside vault.process
		const second = writer.press(file("Course.md"), 0, "click"); // queued
		const editor = fakeEditor("- [/] a");
		leaves.push({ path: "Course.md", editor }); // the note is opened meanwhile
		hold.resolve();

		expect(await first).toMatchObject({ status: "written", route: "vault" });
		expect(await second).toEqual({
			status: "written",
			route: "editor",
			line: 0,
			from: "/",
			to: "x",
			lineText: "- [x] a ✅ 2026-11-20",
		});
		expect(vault.process).toHaveBeenCalledTimes(1);
	});
});

describe("E4 unsaved typing / E15 self-embed", () => {
	it("typing not yet on disk stays in the editor; only the task line differs; no vault.process", async () => {
		const editor = fakeEditor("- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video");
		editor.type(1, " (typed, not saved)");
		const before = editor.text().split("\n");
		const vault = fakeVault({ "Course.md": "- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video" });
		const { writer } = writerFor(vault, workspace([{ path: "Course.md", editor }]));

		await writer.press(file("Course.md"), 0, "click");

		const after = editor.text().split("\n");
		expect(after[1]).toBe("\t- [ ] Watch video (typed, not saved)");
		expect(after.filter((_l, i) => before[i] !== after[i])).toEqual(["- [/] Lesson 2 content ^l2"]);
		expect(vault.process).not.toHaveBeenCalled();
	});

	it("E15: the host note is the source and is open: written through its editor, scroll put back", async () => {
		const scroller = { scrollTop: 340, scrollLeft: 0 };
		const editor = fakeEditor("![[Self#^l2]]\n- [/] Lesson 2 content ^l2", scroller);
		const vault = fakeVault({ "Self.md": "unused" });
		const { writer } = writerFor(vault, workspace([{ path: "Self.md", editor }]));

		const r = await writer.press(file("Self.md"), 1, "click");

		expect(r).toMatchObject({ status: "written", route: "editor" });
		expect(editor.transaction).toHaveBeenCalledTimes(1);
		expect(vault.process).not.toHaveBeenCalled();
		// The fake editor jumped to 0 during the transaction; the writer restored it.
		expect(scroller.scrollTop).toBe(340);
	});

	describe("E15: the cursor does not jump (real CodeMirror state)", () => {
		const DOC = "![[Self#^l2]]\n- [/] Lesson 2 content ^l2\n\t- [ ] Watch video";
		const STAMPED = "- [x] Lesson 2 content ✅ 2026-11-20 ^l2";
		const press = async () => {
			const cm = makeCmEditor(DOC, { today: TODAY });
			return { cm, writer: writerFor(fakeVault({}), workspace([{ path: "Self.md", editor: cm.editor }])).writer };
		};

		it("a caret on another line stays where it was", async () => {
			const { cm, writer } = await press();
			cm.select({ line: 2, ch: 9 });

			expect((await writer.press(file("Self.md"), 1, "click")).status).toBe("written");

			expect(cm.doc().split("\n")[1]).toBe(STAMPED);
			expect(cm.selection()).toEqual({ anchor: { line: 2, ch: 9 }, head: { line: 2, ch: 9 } });
		});

		it("a caret in the task's text before the stamp stays on the same character", async () => {
			const { cm, writer } = await press();
			cm.select({ line: 1, ch: 11 }); // between "Lesson" and " 2"

			await writer.press(file("Self.md"), 1, "click");

			expect(cm.selection().head).toEqual({ line: 1, ch: 11 });
			expect(cm.doc().split("\n")[1].slice(0, 11)).toBe("- [x] Lesso");
		});

		it("a caret at the end of the task line follows its text past the stamp", async () => {
			const { cm, writer } = await press();
			cm.select({ line: 1, ch: "- [/] Lesson 2 content ^l2".length });

			await writer.press(file("Self.md"), 1, "click");

			expect(cm.selection().head).toEqual({ line: 1, ch: STAMPED.length });
		});

		it("a selection across the task line keeps both ends on their own text", async () => {
			const { cm, writer } = await press();
			cm.select({ line: 0, ch: 2 }, { line: 2, ch: 4 });

			await writer.press(file("Self.md"), 1, "click");

			expect(cm.selection()).toEqual({ anchor: { line: 0, ch: 2 }, head: { line: 2, ch: 4 } });
		});
	});
});

describe("E4 two panes on one note: write through the pane being edited", () => {
	const DISK = "- [/] Lesson 2 content ^l2\n\t- [ ] Watch video";
	const panes = () => {
		const first = fakeEditor(DISK); // not the pane being typed in
		const second = fakeEditor(DISK);
		second.type(1, " (typed, not saved)");
		return { first, second };
	};

	it("the active pane gets the transaction, not the first leaf", async () => {
		const { first, second } = panes();
		const ws = workspace(
			[
				{ path: "Course.md", editor: first },
				{ path: "Course.md", editor: second },
			],
			{ path: "Course.md", editor: second }
		);
		const vault = fakeVault({ "Course.md": DISK });
		const { writer } = writerFor(vault, ws);

		const r = await writer.press(file("Course.md"), 0, "click");

		expect(r).toMatchObject({ status: "written", route: "editor", from: "/", to: "x" });
		expect(first.transaction).not.toHaveBeenCalled();
		expect(second.transaction).toHaveBeenCalledTimes(1);
		expect(second.text()).toBe("- [x] Lesson 2 content ^l2\n\t- [ ] Watch video (typed, not saved)");
		expect(vault.process).not.toHaveBeenCalled();
	});

	it("no active pane on the note (the press came from another note): the pane with unsaved changes", async () => {
		const { first, second } = panes();
		const ws = workspace(
			[
				{ path: "Course.md", editor: first },
				{ path: "Course.md", editor: second, dirty: true },
			],
			{ path: "Host.md", editor: fakeEditor("![[Course#^l2]]") }
		);
		const { writer } = writerFor(fakeVault({ "Course.md": DISK }), ws);

		await writer.press(file("Course.md"), 0, "click");

		expect(first.transaction).not.toHaveBeenCalled();
		expect(second.transaction).toHaveBeenCalledTimes(1);
	});

	it("neither active nor dirty: the first pane, as before", async () => {
		const { first, second } = panes();
		const ws = workspace([
			{ path: "Course.md", editor: first },
			{ path: "Course.md", editor: second },
		]);
		const { writer } = writerFor(fakeVault({ "Course.md": DISK }), ws);

		await writer.press(file("Course.md"), 0, "click");

		expect(first.transaction).toHaveBeenCalledTimes(1);
		expect(second.transaction).not.toHaveBeenCalled();
	});
});

describe("G8 route parity", () => {
	const NOTE = (status: string, kind: "plain" | "stamped") =>
		[
			"# Course",
			"",
			kind === "stamped" && "xX-".includes(status)
				? `- [${status}] Lesson 2 content ${status === "-" ? "❌" : "✅"} 2026-11-08 ^l2`
				: `- [${status}] Lesson 2 content ^l2`,
			"\t- [ ] Watch video",
			"> - [/] In a quote ^q1",
			"text",
			"",
		].join("\n");

	const statuses = [...STATUS_SEQUENCE, "X", "?"];
	const kinds: PressKind[] = ["click", "longPress"];
	const rows = statuses.flatMap((s) =>
		kinds.flatMap((k) =>
			[true, false].flatMap((stamps) => (["plain", "stamped"] as const).map((n) => [s, k, stamps, n] as const))
		)
	);

	it("covers every status in the sequence, X and an unknown char", () => {
		expect(new Set(rows.map((r) => r[0]))).toEqual(new Set([" ", "/", "x", "-", "X", "?"]));
	});

	it.each(rows)(
		"status %j, %s, closeStamps %s, %s: the open and the closed route end on the same bytes",
		async (status, kind, stamps, flavour) => {
			const text = NOTE(status, flavour);

			// Closed route.
			const vault = fakeVault({ "Course.md": text });
			const closed = writerFor(vault, workspace([]), { closeStamps: stamps });
			const closedResult = await closed.writer.press(file("Course.md"), 2, kind);

			// Open route: a real editor state with the real change detector.
			const cm = makeCmEditor(text, { today: TODAY, closeStamps: stamps });
			const open = writerFor(fakeVault({}), workspace([{ path: "Course.md", editor: cm.editor }]), {
				closeStamps: stamps,
			});
			const openResult = await open.writer.press(file("Course.md"), 2, kind);

			expect(cm.doc()).toBe(vault.texts.get("Course.md"));
			expect(closedResult.status).toBe(openResult.status);
			if (closedResult.status === "written") {
				expect(closedResult.route).toBe("vault");
				expect(openResult).toMatchObject({ status: "written", route: "editor" });
			} else {
				expect(cm.doc()).toBe(text); // a long press on [-]: nothing written either way
			}
		}
	);
});

describe("G8 anchors and indentation", () => {
	it.each(SHAPE_LINES)("%j: only the status and the stamp change", async (line) => {
		const text = `before\r\n${line}\r\nafter\r\n`;
		const vault = fakeVault({ "N.md": text });
		const { writer } = writerFor(vault, workspace([]));

		await writer.press(file("N.md"), 1, "click");

		const out = vault.texts.get("N.md")!;
		const lines = out.split("\r\n");
		expect(lines).toHaveLength(4);
		expect([lines[0], lines[2], lines[3]]).toEqual(["before", "after", ""]);
		expect(remainder(lines[1])).toBe(remainder(line));
		expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
	});
});

describe("G8 a line that is not a task at write time", () => {
	const cases: Array<[string, string, number, string]> = [
		["a line that moved (now plain text)", "inserted above\n- [ ] a", 0, "not-a-task"],
		["a line that was edited into a non-task", "- not a task now", 0, "not-a-task"],
		["a task inside a fenced block", "```\n- [ ] a\n```", 1, "excluded"],
		["a task inside frontmatter", "---\n- [ ] a\n---\nbody", 1, "excluded"],
		["a line past the last line", "- [ ] a", 5, "out-of-range"],
	];

	it.each(cases)("%s (closed): nothing written, callback returns its input", async (_n, text, line, reason) => {
		const vault = fakeVault({ "N.md": text });
		const { writer } = writerFor(vault, workspace([]));

		expect(await writer.press(file("N.md"), line, "click")).toEqual({ status: "skipped", reason });

		expect(vault.process).toHaveBeenCalledTimes(1);
		const fn = vault.process.mock.calls[0][1];
		expect(fn(text)).toBe(text);
		expect(vault.texts.get("N.md")).toBe(text);
	});

	it.each(cases)("%s (open): no editor change issued", async (_n, text, line, reason) => {
		const editor = fakeEditor(text);
		const vault = fakeVault({});
		const { writer } = writerFor(vault, workspace([{ path: "N.md", editor }]));

		expect(await writer.press(file("N.md"), line, "click")).toEqual({ status: "skipped", reason });

		expect(editor.transaction).not.toHaveBeenCalled();
		expect(vault.process).not.toHaveBeenCalled();
		expect(editor.text()).toBe(text);
	});

	it("a vault.process that resolves without running the edit rejects the press, and the queue goes on", async () => {
		const vault = fakeVault({ "N.md": "- [ ] a" });
		vault.process.mockImplementationOnce(async () => "- [ ] a"); // resolves, never calls fn
		const { writer } = writerFor(vault, workspace([]));

		const first = writer.press(file("N.md"), 0, "click");
		const second = writer.press(file("N.md"), 0, "click");

		await expect(first).rejects.toThrow("vault.process did not run the edit");
		expect(await second).toMatchObject({ status: "written", route: "vault", from: " ", to: "/" });
		expect(vault.texts.get("N.md")).toBe("- [/] a");
	});

	it("a long press on [-] is skipped as no-change on both routes", async () => {
		const vault = fakeVault({ "N.md": "- [-] a ❌ 2026-11-08" });
		const { writer } = writerFor(vault, workspace([]));
		expect(await writer.press(file("N.md"), 0, "longPress")).toEqual({
			status: "skipped",
			reason: "no-change",
		});
		expect(vault.texts.get("N.md")).toBe("- [-] a ❌ 2026-11-08");
	});
});

describe("E1 stamp placement (closed route)", () => {
	it("closes before the id, and a long press cancels before the id", async () => {
		const vault = fakeVault({ "N.md": "- [/] Lesson 2 content ^l2\n- [/] Lesson 2 content ^l2" });
		const { writer } = writerFor(vault, workspace([]));
		await writer.press(file("N.md"), 0, "click");
		await writer.press(file("N.md"), 1, "longPress");
		expect(vault.texts.get("N.md")).toBe(
			"- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n- [-] Lesson 2 content ❌ 2026-11-20 ^l2"
		);
	});

	it("walks x -> - -> space and ends on exactly the original line", async () => {
		const vault = fakeVault({ "N.md": "- [x] Lesson 2 content ✅ 2026-11-20 ^l2" });
		const { writer } = writerFor(vault, workspace([]));
		await writer.press(file("N.md"), 0, "click");
		await writer.press(file("N.md"), 0, "click");
		expect(vault.texts.get("N.md")).toBe("- [ ] Lesson 2 content ^l2");
	});
});

describe("E5 CRLF (closed route)", () => {
	const crlf = fixtureFile("crlf-note.md");
	const variants: Array<[string, string, boolean]> = [
		["the fixture as it is (one final \\r\\n)", crlf, true],
		["an extra blank line at the end (two final \\r\\n)", `${crlf}\r\n`, true],
		["no final newline", crlf.replace(/\r\n$/, ""), false],
	];

	it.each(variants)(
		"%s: keeps every \\r\\n, the line count and the final line's ending",
		async (_name, text, endsWithCrlf) => {
			// Guard the fixture itself: the no-final-newline variant must really lack one.
			expect(text.endsWith("\r\n")).toBe(endsWithCrlf);
			const vault = fakeVault({ "N.md": text });
			const { writer } = writerFor(vault, workspace([]));
			const target = text.split("\r\n").findIndex((l) => l === "- [ ] Ship release ^rel1");

			await writer.press(file("N.md"), target, "click");
			await writer.press(file("N.md"), target, "click");

			const out = vault.texts.get("N.md")!;
			expect(out).toBe(text.replace("- [ ] Ship release ^rel1", "- [x] Ship release ✅ 2026-11-20 ^rel1"));
			expect(out.split("\r\n")).toHaveLength(text.split("\r\n").length);
			expect(out.endsWith("\r\n")).toBe(endsWithCrlf);
			expect(out.replace(/\r\n/g, "")).not.toContain("\n");
			expect(out).toContain("^rel1\r\n"); // the stamped line keeps its \r after ^id
		}
	);

	it("a mixed-ending note keeps each line's own ending", async () => {
		const text = "- [ ] a\r\n- [ ] b\n- [/] c ^c1\r\n- [ ] d";
		const vault = fakeVault({ "N.md": text });
		const { writer } = writerFor(vault, workspace([]));
		await writer.press(file("N.md"), 2, "click");
		expect(vault.texts.get("N.md")).toBe("- [ ] a\r\n- [ ] b\n- [x] c ✅ 2026-11-20 ^c1\r\n- [ ] d");
	});
});

describe("E18 serialised writes", () => {
	it("the second press waits for the first, re-reads, and both advances land in order", async () => {
		const vault = fakeVault({ "N.md": "- [ ] a ^id" });
		const { writer } = writerFor(vault, workspace([]));
		const hold = vault.hold("N.md");

		const first = writer.press(file("N.md"), 0, "click");
		const second = writer.press(file("N.md"), 0, "click");
		await tick();
		expect(vault.process).toHaveBeenCalledTimes(1); // the second has not started

		hold.resolve();
		expect(await first).toMatchObject({ from: " ", to: "/" });
		expect(await second).toMatchObject({ from: "/", to: "x" });
		expect(vault.process).toHaveBeenCalledTimes(2);
		expect(vault.texts.get("N.md")).toBe("- [x] a ✅ 2026-11-20 ^id");
	});

	it("a press on file B is not held back by a pending write on file A", async () => {
		const vault = fakeVault({ "A.md": "- [ ] a", "B.md": "- [ ] b" });
		const { writer } = writerFor(vault, workspace([]));
		const hold = vault.hold("A.md");

		const a = writer.press(file("A.md"), 0, "click");
		const b = await writer.press(file("B.md"), 0, "click");

		expect(b).toMatchObject({ status: "written" });
		expect(vault.texts.get("B.md")).toBe("- [/] b");
		expect(vault.texts.get("A.md")).toBe("- [ ] a");
		hold.resolve();
		await a;
		expect(vault.texts.get("A.md")).toBe("- [/] a");
	});

	it("a rejected write does not wedge the queue", async () => {
		const vault = fakeVault({ "N.md": "- [ ] a" });
		const { writer } = writerFor(vault, workspace([]));
		vault.process.mockRejectedValueOnce(new Error("disk full"));

		await expect(writer.press(file("N.md"), 0, "click")).rejects.toThrow("disk full");
		expect(await writer.press(file("N.md"), 0, "click")).toMatchObject({ status: "written" });
		expect(vault.texts.get("N.md")).toBe("- [/] a");
	});

	it("a write that throws synchronously does not wedge the queue either", async () => {
		const vault = fakeVault({ "N.md": "- [ ] a" });
		const { writer } = writerFor(vault, workspace([]));
		vault.process.mockImplementationOnce(() => {
			throw new Error("boom");
		});

		const first = writer.press(file("N.md"), 0, "click");
		const second = writer.press(file("N.md"), 0, "click"); // queued behind the failing one
		await expect(first).rejects.toThrow("boom");
		expect(await second).toMatchObject({ status: "written", from: " ", to: "/" });
	});

	it("an editor transaction that throws does not wedge the queue", async () => {
		const editor = fakeEditor("- [ ] a");
		const { writer } = writerFor(fakeVault({}), workspace([{ path: "N.md", editor }]));
		editor.transaction.mockImplementationOnce(() => {
			throw new Error("view destroyed");
		});
		await expect(writer.press(file("N.md"), 0, "click")).rejects.toThrow("view destroyed");
		expect(await writer.press(file("N.md"), 0, "click")).toMatchObject({ status: "written" });
	});

	it("process() joins the press queue: a press queued behind a held process waits for it, in order", async () => {
		const vault = fakeVault({ "N.md": "- [ ] a\n\t- [ ] b\n" });
		const { writer } = writerFor(vault, workspace([]));
		const hold = vault.hold("N.md");

		const cascade = writer.process(file("N.md"), (d) => d.replace("\t- [ ] b", "\t- [x] b"));
		await tick();
		const press = writer.press(file("N.md"), 0, "click");
		await tick();
		// The press has not started: only the held process call has reached the vault.
		expect(vault.process).toHaveBeenCalledTimes(1);
		hold.resolve();
		await cascade;
		expect(await press).toMatchObject({ status: "written", lineText: "- [/] a" });
		expect(vault.texts.get("N.md")).toBe("- [/] a\n\t- [x] b\n");
	});

	it("process() rejects with the vault's error (a deleted note) and does not hold up the queue", async () => {
		const vault = fakeVault({ "N.md": "- [ ] a" });
		vault.process.mockImplementationOnce(async () => {
			throw new Error("ENOENT");
		});
		const { writer } = writerFor(vault, workspace([]));
		await expect(writer.process(file("N.md"), (d) => d)).rejects.toThrow("ENOENT");
		expect(await writer.press(file("N.md"), 0, "click")).toMatchObject({ status: "written" });
	});

	it("process() after dispose rejects with 'disposed' and never reaches the vault; one queued before dispose does too", async () => {
		const vault = fakeVault({ "N.md": "- [ ] a" });
		const { writer } = writerFor(vault, workspace([]));
		const hold = vault.hold("N.md");
		const running = writer.press(file("N.md"), 0, "click");
		await tick();
		const queued = writer.process(file("N.md"), (d) => d + "!");
		const queuedRejects = expect(queued).rejects.toThrow("disposed");
		writer.dispose();
		hold.resolve();
		await running;
		await queuedRejects;
		await expect(writer.process(file("N.md"), (d) => d)).rejects.toThrow("disposed");
		expect(vault.process).toHaveBeenCalledTimes(1);
		expect(vault.texts.get("N.md")).toBe("- [/] a");
	});

	it("dispose() drops queued writes: none runs after unload", async () => {
		const vault = fakeVault({ "N.md": "- [ ] a" });
		const { writer } = writerFor(vault, workspace([]));
		const hold = vault.hold("N.md");

		const first = writer.press(file("N.md"), 0, "click");
		await tick(); // the first write is running (held inside vault.process)
		const second = writer.press(file("N.md"), 0, "click");
		const third = writer.press(file("N.md"), 0, "click");
		writer.dispose();
		hold.resolve();

		await first; // the write that was already running finishes
		expect(await second).toEqual({ status: "skipped", reason: "disposed" });
		expect(await third).toEqual({ status: "skipped", reason: "disposed" });
		expect(vault.process).toHaveBeenCalledTimes(1);
		expect(vault.texts.get("N.md")).toBe("- [/] a");

		// A press after dispose is dropped too.
		expect(await writer.press(file("N.md"), 0, "click")).toEqual({ status: "skipped", reason: "disposed" });
		expect(vault.process).toHaveBeenCalledTimes(1);
	});
});

describe("local date", () => {
	it("at 23:59 local on 2026-11-20 the stamp reads 2026-11-20 (not a UTC date)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 10, 20, 23, 59, 0));
		const vault = fakeVault({ "N.md": "- [/] a ^id" });
		// No `today` injected: the default clock is used.
		const writer = createSourceWriter({
			app: { vault, workspace: workspace([]) } as never,
			getSettings: () => ({ closeStamps: true }),
		});
		await writer.press(file("N.md"), 0, "click");
		expect(vault.texts.get("N.md")).toBe("- [x] a ✅ 2026-11-20 ^id");
	});

	it("also reads the date at write time, not at queue time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 10, 20, 23, 59, 59));
		const vault = fakeVault({ "N.md": "- [/] a" });
		const writer = createSourceWriter({
			app: { vault, workspace: workspace([]) } as never,
			getSettings: () => ({ closeStamps: true }),
		});
		const hold = vault.hold("N.md");
		const p = writer.press(file("N.md"), 0, "click");
		vi.setSystemTime(new Date(2026, 10, 21, 0, 0, 1));
		hold.resolve();
		await p;
		expect(vault.texts.get("N.md")).toBe("- [x] a ✅ 2026-11-21");
	});
});

describe("settings", () => {
	it("Close stamps is read on every write", async () => {
		const vault = fakeVault({ "N.md": "- [/] a\n- [/] b" });
		const { writer, settings } = writerFor(vault, workspace([]));
		settings.closeStamps = false;
		await writer.press(file("N.md"), 0, "click");
		settings.closeStamps = true;
		await writer.press(file("N.md"), 1, "click");
		expect(vault.texts.get("N.md")).toBe("- [x] a\n- [x] b ✅ 2026-11-20");
	});
});
