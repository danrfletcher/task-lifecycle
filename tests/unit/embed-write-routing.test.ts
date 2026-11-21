// @vitest-environment happy-dom
/**
 * Where a press on an embedded checkbox is written: the embed presser on
 * the real source writer, with a fake vault and workspace.
 *
 *  - source open in any Markdown leaf: one `editor.transaction`, never
 *    `vault.process`, never `replaceRange`;
 *  - source closed: one `vault.process` call (the PR-2 writer), no editor call;
 *  - presses on one file run in order; a failed write does not block the next;
 *    another file is never held back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbedPresser, UNMAPPABLE_NOTICE, type EmbedPresser } from "../../src/rendered/embed-press";
import { createSourceWriter } from "../../src/rendered/source-writer";
import { App, type MockTFile, type MockVault } from "../__mocks__/obsidian";
import { COURSE_CACHE, COURSE_TEXT } from "../fixtures/rendered-notes";
import { makeCmEditor } from "../helpers/cm-editor";
import { embed, mountHost, type TaskSpec } from "../helpers/rendered-dom";

const TODAY = new Date(2026, 10, 20, 12, 0, 0);
const lesson: TaskSpec[] = [
	{
		text: "Lesson 2 content ",
		dataLine: 0,
		children: [
			{ text: "Watch video", dataLine: 1 },
			{ text: "Take notes", dataLine: 2 },
		],
	},
];

let app: App;
let presser: EmbedPresser;
let messages: string[];
let host: HTMLElement;
let editorCalls: { replaceRange: number };

const tick = () => vi.advanceTimersByTimeAsync(0);

function setup() {
	document.body.replaceChildren();
	app = new App();
	messages = [];
	editorCalls = { replaceRange: 0 };
	app.addNote("Course.md", COURSE_TEXT, COURSE_CACHE);
	app.addNote(
		"Other.md",
		"- [ ] Other lesson ^o1\n",
		{ blocks: { o1: { position: { start: { line: 0 }, end: { line: 0 } } } } }
	);
	const hostFile = app.addNote("Learning Queue.md", "", { embeds: [] });
	host = mountHost(app, hostFile);
	host.classList.add("is-live-preview");
	const writer = createSourceWriter({
		app: app as never,
		getSettings: () => ({ closeStamps: true }),
		today: () => TODAY,
	});
	presser = createEmbedPresser({ app: app as never, writer, notify: (m) => messages.push(m) });
	return writer;
}

function box(src: string, sections: TaskSpec[][] = [lesson], index = 0): HTMLInputElement {
	const built = embed(src, sections);
	host.append(built.el);
	return built.boxes[index];
}

function press(checkbox: Element, kind: "click" | "longPress" = "click") {
	const begun = presser.begin(checkbox);
	if (!begun.handled) throw new Error("not handled");
	return begun.run(kind);
}

/** A leaf for Course.md with a real CM editor that records `replaceRange` as a failure. */
function openLeaf(path: string, text: string, extra: Record<string, unknown> = {}) {
	const cm = makeCmEditor(text, { today: TODAY, path });
	const editor = Object.assign(cm.editor, {
		replaceRange: () => {
			editorCalls.replaceRange += 1;
		},
	});
	app.workspace.leaves.push({ view: { file: { path }, editor, ...extra } });
	return cm;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(TODAY);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("G8 routing of an embed press", () => {
	it("closed source: one vault.process call through the PR-2 writer, and no editor call", async () => {
		const writer = setup();
		const spy = vi.spyOn(writer, "press");
		const other = openLeaf("Other.md", "- [ ] Other lesson ^o1\n");

		const outcome = await press(box("Course#^l2"));

		expect(outcome).toEqual({ status: "written", route: "vault", from: " ", to: "/" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(app.vault.writes).toEqual(["process:Course.md"]);
		expect(app.vault.texts.get("Course.md")).toBe(
			"- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n"
		);
		expect(other.transactions).toEqual([]);
		expect(editorCalls.replaceRange).toBe(0);
	});

	it.each([
		["a split", { dirty: false }],
		["a popout window", { dirty: true }],
	])("source open in %s: exactly one editor.transaction, no vault.process, no replaceRange", async (_name, extra) => {
		setup();
		openLeaf("Other.md", "- [ ] Other lesson ^o1\n"); // another note's editor is not touched
		const cm = openLeaf("Course.md", COURSE_TEXT, extra);

		const outcome = await press(box("Course#^l2"));

		expect(outcome).toEqual({ status: "written", route: "editor", from: " ", to: "/" });
		expect(cm.transactions).toHaveLength(1);
		expect(cm.transactions[0].changes).toEqual([
			{ from: { line: 0, ch: 3 }, to: { line: 0, ch: 4 }, text: "/" },
		]);
		expect(app.vault.writes).toEqual([]);
		expect(editorCalls.replaceRange).toBe(0);
		expect(cm.doc()).toBe("- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
	});

	it("the host note itself open, the embed a self-embed (E15): still one transaction on its editor", async () => {
		setup();
		// The host's own leaf has the editor; the embed shows a block of the same note.
		app.workspace.leaves.length = 0;
		const cm = makeCmEditor(COURSE_TEXT, { today: TODAY, path: "Course.md" });
		const courseFile = app.vault.getAbstractFileByPath("Course.md");
		const contentEl = document.createElement("div");
		contentEl.className = "is-live-preview";
		document.body.append(contentEl);
		app.workspace.leaves.push({ view: { contentEl, file: courseFile, editor: cm.editor } });
		const built = embed("#^l2", [lesson]);
		contentEl.append(built.el);

		await press(built.boxes[0]);

		expect(cm.transactions).toHaveLength(1);
		expect(app.vault.writes).toEqual([]);
		expect(cm.doc().split("\n")[0]).toBe("- [/] Lesson 2 content ^l2");
	});

	it("the route is chosen when the write runs: a note opened while an earlier press was waiting", async () => {
		setup();
		const release = app.vault.hold("Course.md");
		const b = box("Course#^l2");
		const first = press(b);
		const second = press(b);
		await tick();
		expect(app.vault.writes).toEqual(["process:Course.md"]);
		// Course.md is opened in a pane before the second press runs; the pane holds
		// the text the first write left.
		const cm = openLeaf("Course.md", "- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
		release();
		expect(await first).toMatchObject({ status: "written", route: "vault" });
		// The second press goes through that editor and advances from its char: [/] -> [x].
		expect(await second).toMatchObject({ status: "written", route: "editor", from: "/", to: "x" });
		expect(cm.transactions).toHaveLength(1);
		expect(app.vault.writes).toEqual(["process:Course.md"]);
	});
});

describe("per-file queue", () => {
	it("presses on one file reach vault.process in the order they were made", async () => {
		setup();
		const order: string[] = [];
		const original = app.vault.process.bind(app.vault) as MockVault["process"];
		app.vault.process = (f: MockTFile, fn?: (data: string) => string): Promise<string> =>
			original(f, (data: string) => {
				const next = fn ? fn(data) : data;
				order.push(next.split("\n")[0]);
				return next;
			});
		const b = box("Course#^l2");
		const results = await Promise.all([press(b), press(b), press(b), press(b)]);

		expect(results.map((r) => (r.status === "written" ? `${r.from}>${r.to}` : r.status))).toEqual([
			" >/",
			"/>x",
			"x>-",
			"-> ",
		]);
		expect(order).toEqual([
			"- [/] Lesson 2 content ^l2",
			"- [x] Lesson 2 content ✅ 2026-11-20 ^l2",
			"- [-] Lesson 2 content ❌ 2026-11-20 ^l2",
			"- [ ] Lesson 2 content ^l2",
		]);
	});

	it("a second press does not start until the first has landed", async () => {
		setup();
		const release = app.vault.hold("Course.md");
		const b = box("Course#^l2");
		const first = press(b);
		const second = press(b);
		await tick();
		await tick();
		expect(app.vault.writes).toHaveLength(1);
		release();
		await Promise.all([first, second]);
		expect(app.vault.writes).toHaveLength(2);
	});

	it("a write that throws does not block the next press, and shows the notice once", async () => {
		setup();
		const original = app.vault.process.bind(app.vault) as MockVault["process"];
		let calls = 0;
		app.vault.process = async (f: MockTFile, fn?: (data: string) => string) => {
			calls += 1;
			if (calls === 1) throw new Error("EIO");
			return original(f, fn);
		};
		const b = box("Course#^l2");
		const [failed, next] = await Promise.all([press(b), press(b)]);

		expect(failed).toEqual({ status: "unmappable" });
		expect(next).toMatchObject({ status: "written", from: " ", to: "/" });
		expect(messages).toEqual([UNMAPPABLE_NOTICE]);
		expect(app.vault.texts.get("Course.md")).toBe(
			"- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n"
		);
	});

	it("a press on another file is not held behind a write that has not landed", async () => {
		setup();
		const release = app.vault.hold("Course.md");
		const held = press(box("Course#^l2"));
		const o = box("Other#^o1", [[{ text: "Other lesson ", dataLine: 0 }]]);
		const free = await press(o);
		expect(free).toMatchObject({ status: "written", to: "/" });
		expect(app.vault.texts.get("Other.md")).toBe("- [/] Other lesson ^o1\n");
		expect(app.vault.texts.get("Course.md")).toBe(COURSE_TEXT);
		release();
		await held;
		expect(app.vault.texts.get("Course.md")).not.toBe(COURSE_TEXT);
	});
});

describe("write-time resolution", () => {
	it("an open editor's own text decides the line (a line inserted above in an unsaved editor)", async () => {
		setup();
		const cm = openLeaf("Course.md", "# New top line\n" + COURSE_TEXT);
		// The cache is stale (block at line 0) and the disk copy is the old text.
		const outcome = await press(box("Course#^l2"));
		expect(outcome).toMatchObject({ status: "written", route: "editor" });
		expect(cm.doc()).toBe("# New top line\n- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
	});

	it("an unresolvable press never reaches editor.transaction or the file", async () => {
		setup();
		const cm = openLeaf("Course.md", "- [ ] Different text ^l2\n");
		expect(await press(box("Course#^l2"))).toEqual({ status: "unmappable" });
		expect(cm.transactions).toEqual([]);
		expect(messages).toEqual([UNMAPPABLE_NOTICE]);
	});

	it("long press kind is carried to the writer: [ ] goes to [-] with a cancelled stamp", async () => {
		setup();
		await press(box("Course#^l2"), "longPress");
		expect(app.vault.texts.get("Course.md")!.split("\n")[0]).toBe("- [-] Lesson 2 content ❌ 2026-11-20 ^l2");
	});
});
