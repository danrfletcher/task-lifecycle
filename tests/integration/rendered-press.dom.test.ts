// @vitest-environment happy-dom
// (happy-dom, like checkbox-press.dom.test.ts and embed-press.dom.test.ts.)
/**
 * A hold and a touch on a task checkbox inside a Live Preview embed, through
 * the real code path: a real `TaskLifecyclePlugin` on the mock app, an embed
 * DOM as Obsidian 1.15.1 draws it (`.internal-embed.markdown-embed`, `src`,
 * `data-line`, `input.task-list-item-checkbox`), real pointer events and fake
 * timers for the clock. The closed-source route is the mock vault's
 * `process` (recorded in `vault.writes`); the open-source route is the real
 * CodeMirror state of `tests/helpers/cm-editor.ts` with the change detector
 * (not the editor stub of checkbox-press.dom.test.ts, which has no detector, so
 * it could not show the stamp or the single write).
 * IDs are this plan's (G2, G3, G9, G10, GP6, E2 to E6, E12, F3, F7, F9).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice } from "../__mocks__/obsidian";
import { makeCmEditor } from "../helpers/cm-editor";
import {
	TODAY,
	UNMAPPABLE,
	click,
	lessonSection,
	makeRig,
	mouseClick,
	pointer,
	settle,
	task,
	watchNative,
	type EmbedRig,
} from "../helpers/embed-rig";
import { COURSE_N1_CACHE, COURSE_N1_TEXT } from "../fixtures/rendered-notes";
import { fixtureFile } from "../fixtures/source-lines";

const STALE =
	"Task Lifecycle: this task changed since the embed was drawn, nothing changed. Press again to advance it";
const TODAY_DATE = new Date(2026, 10, 20, 12, 0, 0);
const SUBTASKS = "\t- [ ] Watch video\n\t- [ ] Take notes\n";
const course = (line0: string) => `${line0}\n${SUBTASKS}`;

let rig: EmbedRig;

afterEach(() => {
	rig?.plugin.unload();
	vi.useRealTimers();
	document.body.replaceChildren();
});

type PointerType = "mouse" | "touch";
const POINTERS: PointerType[] = ["mouse", "touch"];

const down = (box: Element, pointerType: PointerType, init: PointerEventInit = {}) =>
	pointer("pointerdown", box, { pointerType, clientX: 100, clientY: 100, ...init });
const move = (box: Element, pointerType: PointerType, dx: number, dy = 0) =>
	pointer("pointermove", box, { pointerType, clientX: 100 + dx, clientY: 100 + dy });
const up = (box: Element, pointerType: PointerType, dx = 0) =>
	pointer("pointerup", box, { pointerType, clientX: 100 + dx, clientY: 100 });
const cancel = (box: Element, pointerType: PointerType) => pointer("pointercancel", box, { pointerType });
const contextmenu = (box: Element) => {
	const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true });
	box.dispatchEvent(evt);
	return evt;
};
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const LESSON_OPEN = course("- [ ] Lesson 2 content ^l2");
const LESSON_STARTED = course("- [/] Lesson 2 content ^l2");
const LESSON_CANCELLED = course(`- [-] Lesson 2 content ❌ ${TODAY} ^l2`);

describe.each(POINTERS)("G2 + G3, %s: gestures on an embedded checkbox", (pointerType) => {
	/** A gesture, run to the end, and what Course.md reads afterwards. */
	type Gesture = {
		name: string;
		run: (box: HTMLInputElement) => Promise<{ click: boolean }>;
		expected: string;
		/** Writes to Course.md the gesture is allowed. */
		writes: number;
		/** The click that follows the release is prevented (the native toggle must not run). */
		clickPrevented: boolean;
	};

	const gestures: Gesture[] = [
		{
			name: "clean tap (release at 100 ms)",
			run: async (box) => {
				down(box, pointerType);
				await wait(100);
				up(box, pointerType);
				return { click: true };
			},
			expected: LESSON_STARTED,
			writes: 1,
			clickPrevented: true,
		},
		{
			name: "release at 499 ms is a tap",
			run: async (box) => {
				down(box, pointerType);
				await wait(499);
				up(box, pointerType);
				return { click: true };
			},
			expected: LESSON_STARTED,
			writes: 1,
			clickPrevented: true,
		},
		{
			name: "hold of 500 ms cancels",
			run: async (box) => {
				down(box, pointerType);
				await wait(500);
				up(box, pointerType);
				return { click: true };
			},
			expected: LESSON_CANCELLED,
			writes: 1,
			clickPrevented: true,
		},
		{
			name: "hold of 1200 ms still writes once",
			run: async (box) => {
				down(box, pointerType);
				await wait(1200);
				up(box, pointerType);
				return { click: true };
			},
			expected: LESSON_CANCELLED,
			writes: 1,
			clickPrevented: true,
		},
		{
			name: "moved 5 px, tap",
			run: async (box) => {
				down(box, pointerType);
				move(box, pointerType, 3, 4); // sqrt(25) = 5
				await wait(100);
				up(box, pointerType, 3);
				return { click: true };
			},
			expected: LESSON_STARTED,
			writes: 1,
			clickPrevented: true,
		},
		{
			name: "moved 5 px, then held 500 ms: cancels",
			run: async (box) => {
				down(box, pointerType);
				move(box, pointerType, 3, 4);
				await wait(500);
				up(box, pointerType, 3);
				return { click: true };
			},
			expected: LESSON_CANCELLED,
			writes: 1,
			clickPrevented: true,
		},
		{
			name: "moved 6 px, released at 100 ms: a swipe, nothing written",
			run: async (box) => {
				down(box, pointerType);
				move(box, pointerType, 6);
				await wait(100);
				up(box, pointerType, 6);
				return { click: true };
			},
			expected: LESSON_OPEN,
			writes: 0,
			clickPrevented: true,
		},
		{
			name: "moved 6 px, then held 600 ms: nothing written",
			run: async (box) => {
				down(box, pointerType);
				move(box, pointerType, 6);
				await wait(600);
				up(box, pointerType, 6);
				return { click: true };
			},
			expected: LESSON_OPEN,
			writes: 0,
			clickPrevented: true,
		},
		{
			name: "pointercancel at 100 ms (the browser took a scroll): nothing, no click",
			run: async (box) => {
				down(box, pointerType);
				await wait(100);
				cancel(box, pointerType);
				await wait(1000);
				return { click: false };
			},
			expected: LESSON_OPEN,
			writes: 0,
			clickPrevented: true,
		},
		{
			name: "pointercancel at 499 ms: nothing, no click",
			run: async (box) => {
				down(box, pointerType);
				await wait(499);
				cancel(box, pointerType);
				await wait(1000);
				return { click: false };
			},
			expected: LESSON_OPEN,
			writes: 0,
			clickPrevented: true,
		},
		{
			name: "a second finger at 200 ms cancels the press: nothing written",
			run: async (box) => {
				down(box, pointerType);
				await wait(200);
				down(box, pointerType, { isPrimary: false, pointerId: 2 });
				await wait(1000);
				up(box, pointerType);
				return { click: true };
			},
			expected: LESSON_OPEN,
			writes: 0,
			clickPrevented: true,
		},
	];

	it.each(gestures)("$name", async (g) => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		const gesture = await g.run(boxes[0]);
		let followUp: MouseEvent | null = null;
		if (gesture.click) followUp = click(boxes[0], 1);
		await settle();

		expect(rig.courseText()).toBe(g.expected);
		expect(rig.app.vault.writes).toHaveLength(g.writes);
		expect(native.count()).toBe(0);
		expect(Notice.shown).toEqual([]);
		if (followUp) expect(followUp.defaultPrevented).toBe(g.clickPrevented);
		// The hold timer never outlives its press.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("G3: the write lands at 500 ms, before the release, and the release writes nothing more", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", "- [/] Read ^b1\n");
		rig.app.metadataCache.caches.set("Course.md", {
			blocks: { b1: { position: { start: { line: 0 }, end: { line: 0 } } } },
			listItems: [{ position: { start: { line: 0 }, end: { line: 0 } }, parent: -1 }],
		});
		const { boxes } = rig.addEmbed("Course#^b1", [[task("Read ", 0)]]);
		boxes[0].closest("li")!.setAttribute("data-task", "/");

		down(boxes[0], pointerType);
		await wait(499);
		expect(rig.app.vault.writes).toEqual([]);
		await wait(1);
		// Still pressed: the source already reads cancelled, and the embed shows it.
		expect(rig.courseText()).toBe(`- [-] Read ❌ ${TODAY} ^b1\n`);
		expect(boxes[0].closest("li")?.getAttribute("data-task")).toBe("-");
		expect(rig.app.vault.writes).toHaveLength(1);

		const release = up(boxes[0], pointerType);
		const after = click(boxes[0], 1);
		await settle();
		expect(release.defaultPrevented).toBe(true);
		expect(after.defaultPrevented).toBe(true);
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(rig.courseText()).toBe(`- [-] Read ❌ ${TODAY} ^b1\n`);
	});

	it("G3: the click after a hold is swallowed up to 600 ms after the release, not after", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], pointerType);
		await wait(500);
		up(boxes[0], pointerType);
		await wait(600);
		const late = click(boxes[0], 1);
		await settle();
		// Past the swallow window the click is a fresh one with no press seen
		// (detail > 0): still suppressed as a stray drag, and writes nothing.
		expect(late.defaultPrevented).toBe(true);
		expect(rig.courseText()).toBe(LESSON_CANCELLED);
		expect(rig.app.vault.writes).toHaveLength(1);
	});

	it("G3: a hold on a [x] line writes [-] and swaps ✅ for ❌ with the date, ^blockid last", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", `- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n${SUBTASKS}`);
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		boxes[0].closest("li")!.setAttribute("data-task", "x");
		down(boxes[0], pointerType);
		await wait(500);
		expect(rig.courseText()).toBe(`- [-] Lesson 2 content ❌ 2026-11-20 ^l2\n${SUBTASKS}`);
		up(boxes[0], pointerType);
		click(boxes[0], 1);
		await settle();
		expect(rig.app.vault.writes).toHaveLength(1);
	});

	it("G3: a hold on a line already [-] writes nothing and shows no notice", async () => {
		rig = await makeRig();
		const text = `- [-] Lesson 2 content ❌ 2026-11-20 ^l2\n${SUBTASKS}`;
		rig.app.vault.texts.set("Course.md", text);
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		boxes[0].closest("li")!.setAttribute("data-task", "-");
		down(boxes[0], pointerType);
		await wait(800);
		up(boxes[0], pointerType);
		const after = click(boxes[0], 1);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(rig.courseText()).toBe(text);
		expect(Notice.shown).toEqual([]);
	});

	it("G3: a hold on a parent with open subtasks cancels the parent, asks about the 2 subtasks, and leaves them as they are until confirmed", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], pointerType);
		await wait(500);
		up(boxes[0], pointerType);
		click(boxes[0], 1);
		await settle();
		expect(rig.courseText()).toBe(LESSON_CANCELLED);
		expect(boxes[1].closest("li")?.getAttribute("data-task")).toBe(" ");
		expect(boxes[2].closest("li")?.getAttribute("data-task")).toBe(" ");
		// The parent is written first, then the dialog asks (the cascade, PR-6).
		expect(document.querySelector(".modal-container")?.textContent).toContain("This task has 2 open subtasks.");
	});
});

describe("GP6: hold on an embedded checkbox of a closed note", () => {
	it("Course.md reads [-] with ❌ before the release; the embed shows it; release changes nothing; one write in all", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", COURSE_N1_TEXT);
		rig.app.metadataCache.caches.set("Course.md", COURSE_N1_CACHE);
		const { boxes } = rig.addEmbed("Course#^n1", [[task("Take notes ", 0)]]);
		const li = boxes[0].closest("li")!;
		expect(li.getAttribute("data-task")).toBe(" ");

		down(boxes[0], "mouse");
		await wait(500);
		expect(rig.courseText()).toBe(`- [-] Take notes ❌ ${TODAY} ^n1\n`);
		expect(li.getAttribute("data-task")).toBe("-");
		expect(rig.app.vault.writes).toEqual(["process:Course.md"]);

		up(boxes[0], "mouse");
		click(boxes[0], 1);
		await settle();
		expect(rig.courseText()).toBe(`- [-] Take notes ❌ ${TODAY} ^n1\n`);
		expect(li.getAttribute("data-task")).toBe("-");
		expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
		expect(Notice.shown).toEqual([]);
	});
});

describe("write routing for a hold", () => {
	it("a closed source: exactly one vault.process call, and only the status char and the stamp change (F3)", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], "mouse");
		await wait(500);
		up(boxes[0], "mouse");
		click(boxes[0], 1);
		await settle();
		expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
		const before = LESSON_OPEN;
		const after = rig.courseText();
		// Only line 0 changed: `[ ]` -> `[-]` and ` ❌ date` before the anchor.
		expect(after.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
		expect(after.split("\n")[0]).toBe(`- [-] Lesson 2 content ❌ ${TODAY} ^l2`);
	});

	describe("E4: the source open in another pane", () => {
		function openCourse(text: string) {
			const cm = makeCmEditor(text, { today: TODAY_DATE });
			rig.app.workspace.leaves.push({ view: { file: { path: "Course.md" }, editor: cm.editor } });
			return cm;
		}

		it("one transaction on that editor, stamped once by the detector, unsaved typing kept, no vault write", async () => {
			rig = await makeRig();
			const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
			const cm = openCourse(LESSON_OPEN);
			cm.type(2, " TYPED, not saved yet");

			down(boxes[0], "mouse");
			await wait(500);
			// Before the release.
			expect(cm.transactions).toHaveLength(1);
			up(boxes[0], "mouse");
			click(boxes[0], 1);
			await settle();

			expect(cm.doc()).toBe(
				`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes TYPED, not saved yet\n`
			);
			expect(cm.transactions).toHaveLength(1);
			expect(cm.events.map((e) => `${e.from}>${e.to}`)).toEqual([" >-"]);
			expect(rig.app.vault.writes).toEqual([]);
			expect(rig.courseText()).toBe(LESSON_OPEN);
		});

		it("a hold on an open [x] line: the detector swaps the stamp, once, ^blockid last", async () => {
			rig = await makeRig();
			const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
			boxes[0].closest("li")!.setAttribute("data-task", "x");
			const cm = openCourse(`- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n${SUBTASKS}`);
			down(boxes[0], "touch");
			await wait(500);
			up(boxes[0], "touch");
			click(boxes[0], 1);
			await settle();
			expect(cm.doc()).toBe(`- [-] Lesson 2 content ❌ 2026-11-20 ^l2\n${SUBTASKS}`);
			expect(cm.transactions).toHaveLength(1);
		});
	});

	it("E5: a CRLF source keeps every line ending after a hold", async () => {
		rig = await makeRig();
		const crlf = fixtureFile("crlf-note.md");
		expect(crlf.split("\r\n")[2]).toBe("- [ ] Ship release ^rel1");
		rig.app.addNote("Crlf.md", crlf, {
			blocks: { rel1: { position: { start: { line: 2 }, end: { line: 2 } } } },
			listItems: [{ position: { start: { line: 2 }, end: { line: 2 } }, parent: -2 }],
		});
		const { boxes } = rig.addEmbed("Crlf#^rel1", [[task("Ship release ", 0)]]);
		down(boxes[0], "touch");
		await wait(500);
		up(boxes[0], "touch");
		click(boxes[0], 1);
		await settle();
		const after = rig.app.vault.texts.get("Crlf.md")!;
		expect(after).toBe(crlf.replace("- [ ] Ship release ^rel1", `- [-] Ship release ❌ ${TODAY} ^rel1`));
		expect(after.split("\r\n")).toHaveLength(crlf.split("\r\n").length);
		expect(after.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("a hold on the first task of tests/fixtures/lifecycle-demo.md cancels that line only: its subtasks, plain bullet and [x] stamp stay as they are", async () => {
		rig = await makeRig();
		const demo = fixtureFile("lifecycle-demo.md");
		const pos = (line: number) => ({ start: { line }, end: { line } });
		rig.app.addNote("Demo.md", demo, {
			blocks: { rel1: { position: pos(0) } },
			listItems: [
				{ position: pos(0), parent: -1 },
				{ position: pos(1), parent: 0 },
				{ position: pos(2), parent: 0 },
				{ position: pos(3), parent: 2 },
				{ position: pos(4), parent: 0 },
				{ position: pos(5), parent: -6 },
			],
		});
		const { boxes } = rig.addEmbed("Demo#^rel1", [[task("Ship release ", 0)]]);
		down(boxes[0], "mouse");
		await wait(500);
		up(boxes[0], "mouse");
		click(boxes[0], 1);
		await settle();
		expect(rig.app.vault.writes).toEqual(["process:Demo.md"]);
		expect(rig.app.vault.texts.get("Demo.md")).toBe(
			demo.replace("- [ ] Ship release ^rel1", `- [-] Ship release ❌ ${TODAY} ^rel1`)
		);
		expect(Notice.shown).toEqual([]);
	});

	it("E3: two embeds of the same block: a hold on one writes once and both re-render", async () => {
		rig = await makeRig();
		const a = rig.addEmbed("Course#^l2", [lessonSection()]);
		const b = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(a.boxes[0], "mouse");
		await wait(500);
		up(a.boxes[0], "mouse");
		click(a.boxes[0], 1);
		await settle();
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(a.boxes[0].closest("li")?.getAttribute("data-task")).toBe("-");
		expect(b.boxes[0].closest("li")?.getAttribute("data-task")).toBe("-");
		expect(b.boxes[1].closest("li")?.getAttribute("data-task")).toBe(" ");
	});

	it("E6/E18: a hold that fires while an earlier tap's write is in flight is queued, applied after it, and not dropped", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]); // the tap: running, held in the vault
		await settle();
		expect(rig.app.vault.writes).toHaveLength(1);

		down(boxes[0], "touch");
		await wait(500); // the hold is due, the tap's write is still in flight
		expect(rig.app.vault.writes).toHaveLength(1);
		release();
		up(boxes[0], "touch");
		click(boxes[0], 1);
		await settle();

		// Tap: [ ] -> [/]; then the hold re-read the fresh char and cancelled it.
		expect(rig.courseText()).toBe(LESSON_CANCELLED);
		expect(rig.app.vault.writes).toEqual(["process:Course.md", "process:Course.md"]);
		expect(Notice.shown).toEqual([]);
	});
});

describe("stale and unmappable holds", () => {
	it("E2: the source line moved between the press and the 500 ms timer: re-found by content", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], "mouse");
		await wait(200);
		rig.app.vault.texts.set("Course.md", "# Course\n\n" + rig.courseText());
		await wait(300);
		up(boxes[0], "mouse");
		click(boxes[0], 1);
		await settle();
		expect(rig.courseText()).toBe("# Course\n\n" + LESSON_CANCELLED);
		expect(Notice.shown).toEqual([]);
	});

	it("E2: the line edited so two lines match: nothing written, the exact notice", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], "mouse");
		await wait(200);
		const moved = "# New\n" + rig.courseText() + "- [ ] Lesson 2 content ^copy\n";
		rig.app.vault.texts.set("Course.md", moved);
		await wait(300);
		up(boxes[0], "mouse");
		click(boxes[0], 1);
		await settle();
		expect(rig.courseText()).toBe(moved);
		expect(Notice.shown).toEqual(["Task Lifecycle: couldn't find this task's source line, nothing changed"]);
	});

	it("E2: the line edited so none matches: nothing written, the exact notice", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], "touch");
		await wait(200);
		const edited = "# New\n- [ ] Lesson 3 content ^l2\n";
		rig.app.vault.texts.set("Course.md", edited);
		await wait(300);
		up(boxes[0], "touch");
		click(boxes[0], 1);
		await settle();
		expect(rig.courseText()).toBe(edited);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("G9: a hold on an embed that shows a different status than the file writes nothing, shows the notice and re-renders", async () => {
		rig = await makeRig();
		const text = "- [x] Lesson 2 content ✅ 2026-11-19 ^l2\n";
		rig.app.vault.texts.set("Course.md", text);
		const { boxes } = rig.addEmbed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		const li = boxes[0].closest("li")!;
		expect(li.getAttribute("data-task")).toBe(" ");

		down(boxes[0], "mouse");
		await wait(500);
		up(boxes[0], "mouse");
		const after = click(boxes[0], 1);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(rig.courseText()).toBe(text);
		expect(Notice.shown).toEqual([STALE]);
		expect(li.getAttribute("data-task")).toBe("x");
		expect(boxes[0].checked).toBe(true);
	});

	it("G10: duplicate identical lines in a heading embed: nothing written, native suppressed, the exact notice once", async () => {
		rig = await makeRig();
		const before = rig.app.vault.texts.get("Forms.md");
		const { boxes } = rig.addEmbed("Forms#Sub", [
			[task("Read chapter 3", 0), task("Read chapter 3", 1), task("Unique in sub", 2)],
		]);
		const native = watchNative(boxes[1]);
		down(boxes[1], "touch");
		await wait(500);
		up(boxes[1], "touch");
		const after = click(boxes[1], 1);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		// The refusal happens inside the one atomic process call, which hands the text back unchanged.
		expect(rig.app.vault.texts.get("Forms.md")).toBe(before);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("G10: an embed that does not resolve (heading gone): nothing written, the click after the hold suppressed, the notice", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Forms#No such heading", [[task("Unique in sub", 0)]]);
		down(boxes[0], "mouse");
		await wait(500);
		up(boxes[0], "mouse");
		const after = click(boxes[0], 1);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(rig.app.vault.writes).toEqual([]);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("a box this plugin leaves to Obsidian (an embed in a canvas card) is not pressed: no timer, no notice, the event untouched", async () => {
		rig = await makeRig();
		const { el, boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		rig.host.classList.remove("is-live-preview");
		const canvas = document.createElement("div");
		canvas.className = "canvas-node-content";
		el.parentElement!.replaceWith(canvas);
		canvas.append(el);
		const evt = down(boxes[0], "mouse");
		expect(vi.getTimerCount()).toBe(0);
		await wait(600);
		const release = up(boxes[0], "mouse");
		const after = click(boxes[0], 1);
		expect(evt.defaultPrevented).toBe(false);
		expect(release.defaultPrevented).toBe(false);
		expect(after.defaultPrevented).toBe(false);
		expect(rig.app.vault.writes).toEqual([]);
		expect(Notice.shown).toEqual([]);
	});
});

describe("G2: the platform long-press menu", () => {
	it.each(POINTERS)("%s: contextmenu is prevented during the press and for 600 ms after a hold, not after, not with no press", async (pointerType) => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);

		expect(contextmenu(boxes[0]).defaultPrevented).toBe(false); // no press

		down(boxes[0], pointerType);
		expect(contextmenu(boxes[0]).defaultPrevented).toBe(true); // press in progress
		await wait(500);
		expect(contextmenu(boxes[0]).defaultPrevented).toBe(true); // hold fired, still pressed
		up(boxes[0], pointerType);
		await wait(599);
		expect(contextmenu(boxes[0]).defaultPrevented).toBe(true); // inside the swallow window
		await wait(2);
		expect(contextmenu(boxes[0]).defaultPrevented).toBe(false); // past it
		await settle();
	});

	it("a press that was cancelled leaves the menu alone afterwards", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], "touch");
		move(boxes[0], "touch", 20);
		cancel(boxes[0], "touch");
		expect(contextmenu(boxes[0]).defaultPrevented).toBe(false);
	});
});

describe("G7 (hold only): Status cycle off", () => {
	it("a hold still cancels, and the release's click is still swallowed", async () => {
		rig = await makeRig({ statusCycle: false });
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		down(boxes[0], "touch");
		await wait(500);
		expect(rig.courseText()).toBe(LESSON_CANCELLED);
		up(boxes[0], "touch");
		const after = click(boxes[0], 1);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(rig.courseText()).toBe(LESSON_CANCELLED);
		expect(rig.app.vault.writes).toHaveLength(1);
	});

	it("a tap is the plain toggle (the settings matrix is in rendered-settings.dom.test.ts)", async () => {
		rig = await makeRig({ statusCycle: false });
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		const after = mouseClick(boxes[0]);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(rig.app.vault.writes).toHaveLength(1);
	});

	it("a swipe is not a hold: nothing written, and the click is still swallowed (the plugin handles this box)", async () => {
		rig = await makeRig({ statusCycle: false });
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], "touch");
		move(boxes[0], "touch", 30);
		await wait(800);
		up(boxes[0], "touch", 30);
		const after = click(boxes[0], 1);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(rig.app.vault.writes).toEqual([]);
	});
});

describe("E12 + F9: unloading the plugin", () => {
	it("clears the pending hold timer, removes the listeners, and the box is native again", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		down(boxes[0], "mouse");
		await wait(300);
		expect(vi.getTimerCount()).toBe(1);

		rig.plugin.unload();
		expect(vi.getTimerCount()).toBe(0);
		expect(rig.plugin.domListenerCount).toBe(0);
		await wait(1000);
		expect(rig.app.vault.writes).toEqual([]);
		expect(rig.courseText()).toBe(LESSON_OPEN);

		const native = watchNative(boxes[0]);
		const evt = mouseClick(boxes[0]);
		expect(evt.defaultPrevented).toBe(false);
		expect(native.count()).toBe(1);
	});

	it("a hold that fired and is waiting in the write queue when the plugin unloads writes nothing", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]); // in flight, held
		await settle();
		down(boxes[0], "mouse");
		await wait(500); // the hold is queued behind it
		rig.plugin.unload();
		release();
		await wait(1000);
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(Notice.shown).toEqual([]);
	});
});

describe("F9: the native toggle never runs on a handled hold or tap", () => {
	it.each(POINTERS)("%s: hold, tap and swipe all prevent the click and the source never gains a bare [x]", async (pointerType) => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		const clicks: MouseEvent[] = [];

		down(boxes[0], pointerType); // a hold
		await wait(500);
		up(boxes[0], pointerType);
		clicks.push(click(boxes[0], 1));
		await wait(700);

		down(boxes[0], pointerType); // a tap
		await wait(50);
		up(boxes[0], pointerType);
		clicks.push(click(boxes[0], 1));
		await settle();

		down(boxes[0], pointerType); // a swipe
		move(boxes[0], pointerType, 40);
		up(boxes[0], pointerType, 40);
		clicks.push(click(boxes[0], 1));
		await settle();

		for (const c of clicks) expect(c.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		const bare = rig.courseText().split("\n").filter((l) => /\[x\]/.test(l) && !/✅ \d{4}-\d{2}-\d{2}/.test(l));
		expect(bare).toEqual([]);
	});
});
