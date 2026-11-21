// @vitest-environment happy-dom
// (happy-dom, like embed-press.dom.test.ts and rendered-cascade.dom.test.ts.)
/**
 * A press on a task checkbox in Reading view, through the real code path: a
 * real `TaskLifecyclePlugin` on the mock app (real wiring, settings store,
 * source writer, stamp code and cascade), DOM as Obsidian 1.15.1 draws it
 * (docs/probe-rendered-tasks.md), real DOM events, the note's text in the
 * in-memory vault (`vault.process` recorded in `vault.writes`) or, for a
 * source open in an editor, a real CodeMirror state with the change detector.
 *
 * Two Reading surfaces: a note's own Reading view (`.markdown-reading-view`)
 * and an embed in a Reading-view note. IDs are this plan's (G1, G3, G4, G5,
 * G8, G9, G10, GP3, GP7, E1, E3, E5, E8, E14, E16, F4).
 * Fixtures: `tests/fixtures/reading-course.md` and its CRLF twin.
 *
 * Every expected note text is written out literally.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { Modal, Notice } from "../__mocks__/obsidian";
import { fixtureFile } from "../fixtures/source-lines";
import { READING_COURSE_CACHE } from "../fixtures/rendered-notes";
import {
	TODAY,
	UNMAPPABLE,
	click,
	keydown,
	lessonSection,
	makeRig,
	mouseClick,
	openCourseInEditor,
	pointer,
	settle,
	task,
	watchNative,
	type EmbedRig,
} from "../helpers/embed-rig";
import { embed, readingView, type TaskSpec } from "../helpers/rendered-dom";
import { STALE_NOTICE, syncRenderedStatus } from "../../src/rendered/embed-press";

let rig: EmbedRig;

afterEach(() => {
	rig?.plugin.unload();
	vi.useRealTimers();
	document.body.replaceChildren();
	Modal.openModals = [];
});

/** `reading-course.md` as it is on disk: the three changing lines are parameters, the rest is literal. */
const note = (
	parent = "- [ ] Lesson 2 content ^l2",
	watch = "\t- [ ] Watch video",
	notes = "\t- [ ] Take notes",
	solo = "- [ ] Standalone task ^solo"
): string =>
	[
		"# Course",
		"",
		parent,
		watch,
		notes,
		"",
		solo,
		"",
		"```",
		"- [ ] fenced task",
		"```",
		"",
		"| Task | Owner |",
		"|---|---|",
		"| - [ ] table task | me |",
		"",
	].join("\n");

const NOTE_DONE_PARENT = (watch = "\t- [ ] Watch video", notes = "\t- [ ] Take notes") =>
	note(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`, watch, notes);

const text = () => rig.courseText();
const button = (label: string) =>
	Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-container button")).find(
		(b) => b.textContent === label
	);
const dialogText = () => document.querySelector(".modal-container p")?.textContent ?? null;
const status = (box: Element) => box.closest("li")?.getAttribute("data-task");

/** The rendered sections of the note's own Reading view (data-line is relative to each section). */
const courseSections = (): TaskSpec[][] => [
	[task("Lesson 2 content ", 0, [task("Watch video", 1), task("Take notes", 2)])],
	[task("Standalone task ", 0)],
];

/** A rig whose `Course.md` is the fixture, closed everywhere. */
async function closedCourse(fixture: string = fixtureFile("reading-course.md"), settings?: unknown) {
	rig = await makeRig(settings);
	rig.app.vault.texts.set("Course.md", fixture);
	rig.app.metadataCache.caches.set("Course.md", READING_COURSE_CACHE);
	return rig;
}

/** Open `Course.md` in Reading view in its own pane: the note's own Reading view. Returns its boxes in document order. */
function openOwnReading(r: EmbedRig, sections = courseSections()) {
	const built = readingView(sections);
	const contentEl = document.createElement("div");
	contentEl.className = "view-content";
	contentEl.append(built.el);
	document.body.append(contentEl);
	r.app.workspace.leaves.push({ view: { contentEl, file: r.course, getMode: () => "preview" } });
	return { contentEl, ...built };
}

/** Turn the rig's host note (`Learning Queue.md`) from Live Preview into Reading view, as a pane switch does. */
function hostToReading(r: EmbedRig): void {
	r.host.classList.remove("is-live-preview");
	r.host.classList.add("markdown-reading-view");
	const leaf = (r.app.workspace.leaves as Array<{ view: { contentEl: HTMLElement; getMode?: () => string } }>).find(
		(l) => l.view.contentEl === r.host
	);
	if (leaf) leaf.view.getMode = () => "preview";
}

function hostToLivePreview(r: EmbedRig): void {
	r.host.classList.remove("markdown-reading-view");
	r.host.classList.add("is-live-preview");
	const leaf = (r.app.workspace.leaves as Array<{ view: { contentEl: HTMLElement; getMode?: () => string } }>).find(
		(l) => l.view.contentEl === r.host
	);
	if (leaf) leaf.view.getMode = () => "source";
}

/** An embed of `src` inside the Reading-view host (as in Reading view there is no `.cm-embed-block`). */
function embedInReading(r: EmbedRig, src: string, sections: TaskSpec[][]) {
	const built = embed(src, sections);
	r.host.append(built.el);
	return built;
}

describe("the fixtures", () => {
	it("reading-course.md is the literal note, and its CRLF twin holds the same lines", () => {
		expect(fixtureFile("reading-course.md")).toBe(note());
		expect(fixtureFile("reading-course-crlf.md")).toBe(note().replace(/\n/g, "\r\n"));
	});
});

describe("G1 + G5 + GP7: the cycle from a note's own Reading view, Course.md closed", () => {
	it("GP7: four clicks on 'Watch video' go [/], [x] + ✅, [-] + ❌, [ ] with no stamp; the parent and ^l2 are untouched", async () => {
		await closedCourse();
		const view = openOwnReading(rig);
		const watch = view.boxes[1];
		const native = watchNative(watch);
		const steps = [
			note("- [ ] Lesson 2 content ^l2", "\t- [/] Watch video"),
			note("- [ ] Lesson 2 content ^l2", `\t- [x] Watch video ✅ ${TODAY}`),
			note("- [ ] Lesson 2 content ^l2", `\t- [-] Watch video ❌ ${TODAY}`),
			note("- [ ] Lesson 2 content ^l2", "\t- [ ] Watch video"),
		];
		const shown = ["/", "x", "-", " "];
		for (const [i, expected] of steps.entries()) {
			const evt = mouseClick(watch);
			expect(evt.defaultPrevented).toBe(true);
			await settle();
			expect(text()).toBe(expected);
			expect(status(watch)).toBe(shown[i]);
			// One write per press, and the note is closed, so it is a vault.process call.
			expect(rig.app.vault.writes).toHaveLength(i + 1);
		}
		expect(rig.app.vault.writes).toEqual(Array(4).fill("process:Course.md"));
		expect(native.count()).toBe(0);
		expect(Notice.shown).toEqual([]);
	});

	it("Space (a click with detail 0) and Enter (a keydown, no click) on a focused rendered box are one short click each", async () => {
		await closedCourse();
		const view = openOwnReading(rig);
		const watch = view.boxes[1];
		const native = watchNative(watch);
		const space = click(watch, 0);
		expect(space.defaultPrevented).toBe(true);
		await settle();
		expect(text()).toBe(note("- [ ] Lesson 2 content ^l2", "\t- [/] Watch video"));
		const enter = keydown(watch, "Enter");
		expect(enter.defaultPrevented).toBe(true);
		await settle();
		expect(text()).toBe(note("- [ ] Lesson 2 content ^l2", `\t- [x] Watch video ✅ ${TODAY}`));
		expect(native.count()).toBe(0);
		expect(rig.app.vault.writes).toHaveLength(2);
	});

	it("the standalone task with a ^solo anchor is stamped before the anchor (E1), the rest of the note byte-for-byte", async () => {
		await closedCourse();
		const view = openOwnReading(rig);
		const solo = view.boxes[3];
		mouseClick(solo);
		await settle();
		mouseClick(solo);
		await settle();
		expect(text()).toBe(note(undefined, undefined, undefined, `- [x] Standalone task ✅ ${TODAY} ^solo`));
		mouseClick(solo);
		await settle();
		mouseClick(solo);
		await settle();
		expect(text()).toBe(note());
	});

	it("G5: a reopen removes the stamp, and a bare ✅ in the text is not one", async () => {
		await closedCourse(note(undefined, "\t- [x] Watch ✅ video ✅ 2026-11-01"));
		const view = openOwnReading(rig, [[task("Watch ✅ video", 0)]]);
		syncRenderedStatus(view.boxes[0], "x");
		mouseClick(view.boxes[0]);
		await settle();
		expect(text()).toBe(note(undefined, `\t- [-] Watch ✅ video ❌ ${TODAY}`));
		mouseClick(view.boxes[0]);
		await settle();
		expect(text()).toBe(note(undefined, "\t- [ ] Watch ✅ video"));
	});

	it("with Status cycle off a Reading-view click is the plain toggle written by the plugin, not Obsidian's", async () => {
		await closedCourse(undefined, { statusCycle: false });
		const view = openOwnReading(rig);
		const watch = view.boxes[1];
		const native = watchNative(watch);
		const evt = mouseClick(watch);
		expect(evt.defaultPrevented).toBe(true);
		await settle();
		expect(text()).toBe(note(undefined, `\t- [x] Watch video ✅ ${TODAY}`));
		expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
		mouseClick(watch);
		await settle();
		expect(text()).toBe(note());
		expect(native.count()).toBe(0);
	});

	it("an unknown character goes to a space and X counts as x", async () => {
		await closedCourse(note(undefined, "\t- [?] Watch video", "\t- [X] Take notes ✅ 2026-11-01"));
		const view = openOwnReading(rig);
		view.boxes[1].closest("li")!.setAttribute("data-task", "?");
		view.boxes[2].closest("li")!.setAttribute("data-task", "X");
		mouseClick(view.boxes[1]);
		await settle();
		mouseClick(view.boxes[2]);
		await settle();
		expect(text()).toBe(note(undefined, "\t- [ ] Watch video", `\t- [-] Take notes ❌ ${TODAY}`));
	});
});

describe("G1 + GP7: the same click in an embed inside a Reading-view note", () => {
	it("GP7: ![[Course#^l2]] in a Reading-view Learning Queue.md gives the same result in Course.md", async () => {
		await closedCourse();
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		const watch = boxes[1];
		const native = watchNative(watch);
		const steps = [
			note("- [ ] Lesson 2 content ^l2", "\t- [/] Watch video"),
			note("- [ ] Lesson 2 content ^l2", `\t- [x] Watch video ✅ ${TODAY}`),
			note("- [ ] Lesson 2 content ^l2", `\t- [-] Watch video ❌ ${TODAY}`),
			note("- [ ] Lesson 2 content ^l2", "\t- [ ] Watch video"),
		];
		for (const [i, expected] of steps.entries()) {
			expect(mouseClick(watch).defaultPrevented).toBe(true);
			await settle();
			expect(text()).toBe(expected);
			expect(rig.app.vault.writes).toHaveLength(i + 1);
		}
		expect(native.count()).toBe(0);
		expect(Notice.shown).toEqual([]);
	});

	it("E1 + G5: the embedded parent is stamped before ^l2 (its subtasks are asked about, left open here)", async () => {
		await closedCourse();
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		await settle();
		expect(text()).toBe(note("- [/] Lesson 2 content ^l2"));
		mouseClick(boxes[0]);
		await settle();
		await settle();
		expect(text()).toBe(NOTE_DONE_PARENT());
		button("Leave open")!.click();
		await settle();
		expect(text()).toBe(NOTE_DONE_PARENT());
	});

	it("Space and Enter on a focused embedded box in Reading view", async () => {
		await closedCourse();
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		expect(click(boxes[1], 0).defaultPrevented).toBe(true);
		await settle();
		expect(keydown(boxes[1], "Enter").defaultPrevented).toBe(true);
		await settle();
		expect(text()).toBe(note("- [ ] Lesson 2 content ^l2", `\t- [x] Watch video ✅ ${TODAY}`));
	});
});

describe("G3: a 500 ms hold on a Reading-view checkbox", () => {
	async function hold(box: Element): Promise<{ up: PointerEvent; click: MouseEvent }> {
		pointer("pointerdown", box, { clientX: 100, clientY: 100 });
		await vi.advanceTimersByTimeAsync(500);
		const up = pointer("pointerup", box, { clientX: 100, clientY: 100 });
		const c = click(box, 1);
		await settle();
		return { up, click: c };
	}

	it("sets '-' on an open task and swallows the release and the click after it", async () => {
		await closedCourse();
		const view = openOwnReading(rig);
		const native = watchNative(view.boxes[1]);
		const { up, click: c } = await hold(view.boxes[1]);
		expect(text()).toBe(note(undefined, `\t- [-] Watch video ❌ ${TODAY}`));
		expect(up.defaultPrevented).toBe(true);
		expect(c.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
	});

	it("swaps ✅ for ❌ on a [x] line, in an embed too", async () => {
		await closedCourse(note(undefined, "\t- [x] Watch video ✅ 2026-11-01"));
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		boxes[1].closest("li")!.setAttribute("data-task", "x");
		await hold(boxes[1]);
		expect(text()).toBe(note(undefined, `\t- [-] Watch video ❌ ${TODAY}`));
	});

	it("a hold on a task already [-] writes nothing", async () => {
		await closedCourse(note(undefined, `\t- [-] Watch video ❌ 2026-11-01`));
		const view = openOwnReading(rig);
		view.boxes[1].closest("li")!.setAttribute("data-task", "-");
		await hold(view.boxes[1]);
		// The press reaches the writer and changes nothing: the note is as it was.
		expect(text()).toBe(note(undefined, `\t- [-] Watch video ❌ 2026-11-01`));
	});

	it("a hold with Status cycle off still cancels", async () => {
		await closedCourse(undefined, { statusCycle: false });
		const view = openOwnReading(rig);
		await hold(view.boxes[1]);
		expect(text()).toBe(note(undefined, `\t- [-] Watch video ❌ ${TODAY}`));
	});
});

describe("GP3: closing a task with open subtasks from a Reading-view press", () => {
	it("own Reading view: the parent is written first, then 'This task has 2 open subtasks.'; Close subtasks closes both in one write", async () => {
		await closedCourse(note("- [/] Lesson 2 content ^l2"));
		const view = openOwnReading(rig);
		view.boxes[0].closest("li")!.setAttribute("data-task", "/");
		const native = watchNative(view.boxes[0]);
		const before = rig.app.vault.writes.length;
		mouseClick(view.boxes[0]);
		await settle();
		expect(text()).toBe(NOTE_DONE_PARENT());
		expect(rig.app.vault.writes.length - before).toBe(1);
		await settle();
		expect(dialogText()).toBe("This task has 2 open subtasks.");

		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe(
			note(
				`- [x] Lesson 2 content ✅ ${TODAY} ^l2`,
				`\t- [x] Watch video ✅ ${TODAY}`,
				`\t- [x] Take notes ✅ ${TODAY}`
			)
		);
		expect(rig.app.vault.writes.slice(before)).toEqual(["process:Course.md", "process:Course.md"]);
		expect(native.count()).toBe(0);
		expect(Notice.shown).toEqual([]);
	});

	it("an embed in a Reading-view note: the same dialog and the same single write", async () => {
		await closedCourse(note("- [/] Lesson 2 content ^l2"));
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		syncRenderedStatus(boxes[0], "/");
		mouseClick(boxes[0]);
		await settle();
		await settle();
		expect(text()).toBe(NOTE_DONE_PARENT());
		expect(dialogText()).toBe("This task has 2 open subtasks.");
		const before = rig.app.vault.writes.length;
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe(
			note(
				`- [x] Lesson 2 content ✅ ${TODAY} ^l2`,
				`\t- [x] Watch video ✅ ${TODAY}`,
				`\t- [x] Take notes ✅ ${TODAY}`
			)
		);
		expect(rig.app.vault.writes.slice(before)).toEqual(["process:Course.md"]);
	});

	it("a long press in Reading view cancels the parent and offers the cascade with ❌", async () => {
		await closedCourse();
		const view = openOwnReading(rig);
		pointer("pointerdown", view.boxes[0], { clientX: 1, clientY: 1 });
		await vi.advanceTimersByTimeAsync(500);
		pointer("pointerup", view.boxes[0], { clientX: 1, clientY: 1 });
		click(view.boxes[0], 1);
		for (let i = 0; i < 4; i++) await settle();
		expect(text()).toBe(note(`- [-] Lesson 2 content ❌ ${TODAY} ^l2`));
		expect(dialogText()).toBe("This task has 2 open subtasks.");
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe(
			note(
				`- [-] Lesson 2 content ❌ ${TODAY} ^l2`,
				`\t- [-] Watch video ❌ ${TODAY}`,
				`\t- [-] Take notes ❌ ${TODAY}`
			)
		);
	});

	it("a press while the dialog is open is swallowed and writes nothing", async () => {
		await closedCourse(note("- [/] Lesson 2 content ^l2"));
		const view = openOwnReading(rig);
		view.boxes[0].closest("li")!.setAttribute("data-task", "/");
		mouseClick(view.boxes[0]);
		await settle();
		await settle();
		const writes = rig.app.vault.writes.length;
		const evt = mouseClick(view.boxes[1]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(rig.app.vault.writes).toHaveLength(writes);
		expect(text()).toBe(NOTE_DONE_PARENT());
	});
});

describe("G4: only the checkbox is intercepted in Reading view", () => {
	function withExtras(inEmbed: boolean) {
		let boxes: HTMLInputElement[];
		let outer: HTMLElement;
		if (inEmbed) {
			hostToReading(rig);
			const built = embedInReading(rig, "Course#^l2", [lessonSection()]);
			boxes = built.boxes;
			outer = built.el;
		} else {
			const view = openOwnReading(rig);
			boxes = view.boxes;
			outer = view.el;
		}
		const li = boxes[0].closest("li") as HTMLElement;
		const link = document.createElement("a");
		link.className = "internal-link";
		link.textContent = "A link";
		li.append(link);
		const title = document.createElement("div");
		title.className = "markdown-embed-title";
		outer.prepend(title);
		const openSource = document.createElement("div");
		openSource.className = "markdown-embed-link";
		outer.prepend(openSource);
		const chevron = document.createElement("span");
		chevron.className = "collapse-indicator collapse-icon";
		li.prepend(chevron);
		const bullet = li.querySelector(".list-bullet") as HTMLElement;
		return { link, title, openSource, chevron, bullet, liPadding: li };
	}

	for (const inEmbed of [false, true]) {
		it.each(["link", "title", "openSource", "chevron", "bullet", "liPadding"] as const)(
			`${inEmbed ? "embed in Reading view" : "own Reading view"}: a press on the %s keeps its native behaviour, writes nothing, shows no notice`,
			async (name) => {
				await closedCourse();
				const target = withExtras(inEmbed)[name];
				const evt = mouseClick(target);
				const key = keydown(target, "Enter");
				await settle();
				expect(evt.defaultPrevented).toBe(false);
				expect(key.defaultPrevented).toBe(false);
				expect(rig.app.vault.writes).toEqual([]);
				expect(text()).toBe(note());
				expect(Notice.shown).toEqual([]);
			}
		);
	}
});

describe("F4: surfaces this plugin never handles are not intercepted", () => {
	const wrappers: Array<[string, string]> = [
		["a canvas card", "canvas-node"],
		["a hover preview", "popover hover-popover"],
		["a search result", "search-result"],
		["the backlinks pane", "backlink-pane"],
		["backlinks under a note", "embedded-backlinks"],
		["a Dataview query", "block-language-dataview"],
		["a Tasks query", "block-language-tasks"],
		["a Tasks query result", "plugin-tasks-query-result"],
	];

	it.each(wrappers)("%s: no write, no stamp, no notice, the click is left alone", async (_name, cls) => {
		await closedCourse();
		// A Reading view that holds the container, so only the container can be why it is left alone.
		const view = openOwnReading(rig);
		const wrap = document.createElement("div");
		wrap.className = cls;
		view.el.append(wrap);
		const built = embed("Course#^l2", [lessonSection()]);
		wrap.append(built.el);
		const plain = document.createElement("div");
		plain.className = cls;
		const listing = readingView([[task("Standalone task ", 0)]]);
		plain.append(listing.el);
		document.body.append(plain);

		for (const box of [built.boxes[1], listing.boxes[0]]) {
			const native = watchNative(box);
			const evt = mouseClick(box);
			const key = keydown(box, "Enter");
			await settle();
			expect(evt.defaultPrevented).toBe(false);
			expect(key.defaultPrevented).toBe(false);
			expect(native.count()).toBe(1);
		}
		expect(rig.app.vault.writes).toEqual([]);
		expect(text()).toBe(note());
		expect(Notice.shown).toEqual([]);
	});

	it("a search pane, a canvas pane and a backlinks leaf are not intercepted either", async () => {
		await closedCourse();
		for (const type of ["search", "canvas", "backlink", "outgoing-link"]) {
			const leaf = document.createElement("div");
			leaf.className = "workspace-leaf-content";
			leaf.setAttribute("data-type", type);
			const listing = readingView([[task("Standalone task ", 0)]]);
			leaf.append(listing.el);
			document.body.append(leaf);
			expect(mouseClick(listing.boxes[0]).defaultPrevented).toBe(false);
		}
		await settle();
		expect(rig.app.vault.writes).toEqual([]);
		expect(Notice.shown).toEqual([]);
	});

	it("a hover popover over a link is a preview: a tick there is not intercepted even when the popover holds a Reading view", async () => {
		await closedCourse();
		const pop = document.createElement("div");
		pop.className = "popover hover-popover";
		const view = readingView(courseSections());
		pop.append(view.el);
		document.body.append(pop);
		expect(mouseClick(view.boxes[1]).defaultPrevented).toBe(false);
		await settle();
		expect(rig.app.vault.writes).toEqual([]);
		expect(Notice.shown).toEqual([]);
	});

	it("a checkbox in a Reading view whose pane is in no Markdown view of the workspace is left native", async () => {
		await closedCourse();
		const stray = readingView(courseSections());
		document.body.append(stray.el);
		expect(mouseClick(stray.boxes[1]).defaultPrevented).toBe(false);
		await settle();
		expect(rig.app.vault.writes).toEqual([]);
		expect(Notice.shown).toEqual([]);
	});
});

describe("E8: code in Reading view", () => {
	it("a fenced '- [ ]' is rendered as code, not a checkbox: a click on it does nothing; the fence is never touched", async () => {
		await closedCourse();
		const view = openOwnReading(rig);
		const pre = document.createElement("pre");
		const code = document.createElement("code");
		code.textContent = "- [ ] fenced task";
		pre.append(code);
		view.el.append(pre);
		expect(mouseClick(code).defaultPrevented).toBe(false);
		// A real press elsewhere leaves the fenced line exactly as it was.
		mouseClick(view.boxes[3]);
		await settle();
		expect(text()).toBe(note(undefined, undefined, undefined, "- [/] Standalone task ^solo"));
	});

	it("a rendered checkbox whose text only a fenced line has is G10: nothing is written, the fence is intact", async () => {
		await closedCourse();
		const view = openOwnReading(rig, [[task("fenced task", 0)]]);
		const evt = mouseClick(view.boxes[0]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
		expect(text()).toBe(note());
	});
});

describe("E14: tasks in a table", () => {
	it("a checkbox in a table cell takes the G10 path in an own Reading view and in an embed", async () => {
		await closedCourse();
		const view = openOwnReading(rig, [[task("table task ", 0)]]);
		const cell = document.createElement("table");
		cell.append(document.createElement("tbody"));
		view.boxes[0].closest("ul")!.replaceWith(cell);
		cell.append(view.boxes[0]);

		hostToReading(rig);
		const inEmbed = embedInReading(rig, "Course", [[task("table task ", 0)]]);
		const embedTable = document.createElement("table");
		embedTable.append(document.createElement("tbody"));
		inEmbed.boxes[0].closest("ul")!.replaceWith(embedTable);
		embedTable.append(inEmbed.boxes[0]);

		for (const box of [view.boxes[0], inEmbed.boxes[0]]) {
			Notice.reset();
			const native = watchNative(box);
			const evt = mouseClick(box);
			await settle();
			expect(evt.defaultPrevented).toBe(true);
			expect(Notice.shown).toEqual([UNMAPPABLE]);
			expect(native.count()).toBe(0);
		}
		expect(rig.app.vault.writes).toEqual([]);
		expect(text()).toBe(note());
	});
});

describe("G10: unmappable or ambiguous", () => {
	it("a rendered task that is not in the note: nothing written, native toggle suppressed, the exact notice", async () => {
		await closedCourse();
		const view = openOwnReading(rig, [[task("A task nobody wrote", 0)]]);
		const native = watchNative(view.boxes[0]);
		const evt = mouseClick(view.boxes[0]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
		expect(UNMAPPABLE).toBe("Task Lifecycle: couldn't find this task's source line, nothing changed");
		expect(text()).toBe(note());
	});

	it("two identical lines in the note: ambiguous, nothing written", async () => {
		await closedCourse(
			["- [ ] Read chapter 3", "- [ ] Read chapter 3", ""].join("\n"),
			undefined
		);
		rig.app.metadataCache.caches.set("Course.md", {
			listItems: [
				{ position: { start: { line: 0 }, end: { line: 0 } }, parent: -1 },
				{ position: { start: { line: 1 }, end: { line: 1 } }, parent: -1 },
			],
		});
		const view = openOwnReading(rig, [[task("Read chapter 3", 0), task("Read chapter 3", 1)]]);
		for (const box of view.boxes) {
			Notice.reset();
			expect(mouseClick(box).defaultPrevented).toBe(true);
			await settle();
			expect(Notice.shown).toEqual([UNMAPPABLE]);
		}
		expect(text()).toBe("- [ ] Read chapter 3\n- [ ] Read chapter 3\n");
	});

	it("an embed whose source line is gone at write time, in Reading view", async () => {
		await closedCourse();
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[1]);
		await settle();
		rig.app.vault.texts.set("Course.md", "# Course\n");
		release();
		await settle();
		expect(Notice.shown).toEqual([UNMAPPABLE]);
		expect(text()).toBe("# Course\n");
	});
});

describe("G9: a stale Reading view", () => {
	it("writes nothing, shows a notice, redraws the box, and the next click advances from the file's char", async () => {
		await closedCourse(note(undefined, "\t- [/] Watch video"));
		const view = openOwnReading(rig);
		const watch = view.boxes[1];
		// The pane still draws an open box; the file says '/'.
		expect(status(watch)).toBe(" ");
		const evt = mouseClick(watch);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(Notice.shown).toEqual([STALE_NOTICE]);
		expect(text()).toBe(note(undefined, "\t- [/] Watch video"));
		expect(status(watch)).toBe("/");

		Notice.reset();
		mouseClick(watch);
		await settle();
		expect(text()).toBe(note(undefined, `\t- [x] Watch video ✅ ${TODAY}`));
		expect(Notice.shown).toEqual([]);
	});

	it("the same holds for an embed in a Reading-view note", async () => {
		await closedCourse(note(undefined, "\t- [x] Watch video ✅ 2026-11-01"));
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		mouseClick(boxes[1]);
		await settle();
		expect(Notice.shown).toEqual([STALE_NOTICE]);
		expect(status(boxes[1])).toBe("x");
		expect(text()).toBe(note(undefined, "\t- [x] Watch video ✅ 2026-11-01"));
	});
});

describe("G8: routing of a Reading-view press", () => {
	it("a source open in an editor in another pane: one editor transaction each, never vault.process, the detector stamps once", async () => {
		await closedCourse();
		const view = openOwnReading(rig);
		const cm = openCourseInEditor(rig, note());
		cm.type(4, " TYPED, not saved yet");
		mouseClick(view.boxes[1]);
		await settle();
		mouseClick(view.boxes[1]);
		await settle();
		expect(cm.doc()).toBe(note(undefined, `\t- [x] Watch video ✅ ${TODAY}`, "\t- [ ] Take notes TYPED, not saved yet"));
		expect(cm.transactions).toHaveLength(2);
		expect(cm.events.map((e) => `${e.from}>${e.to}`)).toEqual([" >/", "/>x"]);
		expect(rig.app.vault.writes).toEqual([]);
		expect(text()).toBe(note());
	});

	it("a Reading-view pane that holds an editor object it does not show is not 'open in an editor': one vault.process", async () => {
		await closedCourse();
		const view = openOwnReading(rig);
		const hidden = { lineCount: vi.fn(() => 0), getLine: vi.fn(() => ""), transaction: vi.fn() };
		const leaf = (rig.app.workspace.leaves as Array<{ view: Record<string, unknown> }>).at(-1)!;
		leaf.view.editor = hidden;
		mouseClick(view.boxes[1]);
		await settle();
		expect(hidden.transaction).not.toHaveBeenCalled();
		expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
		expect(text()).toBe(note(undefined, "\t- [/] Watch video"));
	});

	it("a Reading-view embed of a note open in Live Preview elsewhere is written through that editor", async () => {
		await closedCourse();
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		const cm = openCourseInEditor(rig, note());
		mouseClick(boxes[1]);
		await settle();
		expect(cm.doc()).toBe(note(undefined, "\t- [/] Watch video"));
		expect(rig.app.vault.writes).toEqual([]);
	});
});

describe("E5: CRLF", () => {
	it("a CRLF source ticked from Reading view keeps every line ending, on a closed note", async () => {
		const crlf = (s: string) => s.replace(/\n/g, "\r\n");
		await closedCourse(fixtureFile("reading-course-crlf.md"));
		const view = openOwnReading(rig);
		mouseClick(view.boxes[1]);
		await settle();
		expect(text()).toBe(crlf(note(undefined, "\t- [/] Watch video")));
		mouseClick(view.boxes[1]);
		await settle();
		expect(text()).toBe(crlf(note(undefined, `\t- [x] Watch video ✅ ${TODAY}`)));
		expect(text().includes("\r\n")).toBe(true);
		expect(text().replace(/\r\n/g, "").includes("\n")).toBe(false);
	});

	it("and in an embed, stamping before ^l2 on the parent", async () => {
		const crlf = (s: string) => s.replace(/\n/g, "\r\n");
		await closedCourse(fixtureFile("reading-course-crlf.md"));
		hostToReading(rig);
		const { boxes } = embedInReading(rig, "Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		await settle();
		mouseClick(boxes[0]);
		await settle();
		await settle();
		expect(text()).toBe(crlf(NOTE_DONE_PARENT()));
	});
});

describe("E3 + E16: several panes showing one task", () => {
	it("E3: two Reading-view embeds of the same block: one write per click, both re-render", async () => {
		await closedCourse();
		hostToReading(rig);
		const a = embedInReading(rig, "Course#^l2", [lessonSection()]);
		const b = embedInReading(rig, "Course#^l2", [lessonSection()]);
		mouseClick(a.boxes[1]);
		await settle();
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(status(a.boxes[1])).toBe("/");
		expect(status(b.boxes[1])).toBe("/");
		expect(status(b.boxes[2])).toBe(" ");
		mouseClick(b.boxes[1]);
		await settle();
		expect(rig.app.vault.writes).toHaveLength(2);
		expect(text()).toBe(note(undefined, `\t- [x] Watch video ✅ ${TODAY}`));
		expect(status(a.boxes[1])).toBe("x");
		expect(Notice.shown).toEqual([]);
	});

	it("E16 split: a Reading view of the note and a Reading-view embed of it: handled once, written once, the other pane re-renders", async () => {
		await closedCourse();
		const own = openOwnReading(rig);
		hostToReading(rig);
		const embedded = embedInReading(rig, "Course#^l2", [lessonSection()]);
		mouseClick(embedded.boxes[1]);
		await settle();
		expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
		expect(text()).toBe(note(undefined, "\t- [/] Watch video"));
		expect(status(embedded.boxes[1])).toBe("/");
		// The own Reading view is another pane of the same note. Obsidian redraws it
		// from the file; it is told so here, and its next press advances from the file.
		syncRenderedStatus(own.boxes[1], "/");
		mouseClick(own.boxes[1]);
		await settle();
		expect(text()).toBe(note(undefined, `\t- [x] Watch video ✅ ${TODAY}`));
		expect(rig.app.vault.writes).toHaveLength(2);
		expect(Notice.shown).toEqual([]);
	});

	it("E16 popout: a Reading view in a popout window is handled as in the main window, once", async () => {
		await closedCourse();
		const popout = new Window();
		const before = rig.plugin.domListenerCount;
		rig.app.workspace.trigger("window-open", {}, popout);
		const added = rig.plugin.domListenerCount - before;
		// One listener set per window: the same seven as the main document.
		expect(added).toBe(7);
		// A second report of the same window adds nothing.
		rig.app.workspace.trigger("window-open", {}, popout);
		expect(rig.plugin.domListenerCount - before).toBe(7);

		const doc = popout.document as unknown as Document;
		const built = readingView(courseSections());
		const contentEl = doc.createElement("div");
		contentEl.className = "view-content";
		contentEl.append(built.el);
		doc.body.append(contentEl);
		rig.app.workspace.leaves.push({ view: { contentEl, file: rig.course, getMode: () => "preview" } });

		const watch = built.boxes[1];
		const PopPointer = (popout as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
		const PopMouse = (popout as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
		const init = { bubbles: true, cancelable: true, composed: true, isPrimary: true, button: 0, pointerType: "mouse" };
		watch.dispatchEvent(new PopPointer("pointerdown", init));
		watch.dispatchEvent(new PopPointer("pointerup", init));
		const evt = new PopMouse("click", { bubbles: true, cancelable: true, composed: true, detail: 1 });
		watch.dispatchEvent(evt);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(text()).toBe(note(undefined, "\t- [/] Watch video"));
		expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
		expect(status(watch)).toBe("/");
		expect(Notice.shown).toEqual([]);
	});

	it("E16 popout windows that were already open when the plugin wired up are found from the workspace", async () => {
		const popout = new Window();
		const doc = popout.document as unknown as Document;
		const contentEl = doc.createElement("div");
		const { App } = await import("../__mocks__/obsidian");
		const app = new App();
		app.workspace.leaves.push({ view: { contentEl, file: null } });
		const { wireEmbedPress } = await import("../../src/status-cycle/wire-embed-press");
		const registered: unknown[] = [];
		const stop = wireEmbedPress({
			plugin: {
				registerDomEvent: (el: unknown) => registered.push(el),
				registerEvent: () => undefined,
			} as never,
			workspace: app.workspace as never,
			presser: { begin: () => ({ handled: false }), dispose: () => undefined },
			settings: { get: () => ({ statusCycle: true }) } as never,
		});
		// Seven for the main document, seven for the popout, none doubled.
		expect(registered.filter((el) => el === document)).toHaveLength(7);
		expect(registered.filter((el) => el === doc)).toHaveLength(7);
		stop();
	});
});

describe("mode switching: no duplicate or orphaned listener", () => {
	it("a pane switched Reading view -> Live Preview -> Reading view handles each click exactly once", async () => {
		await closedCourse();
		const listeners = rig.plugin.domListenerCount;
		const { boxes } = (() => {
			const built = embed("Course#^l2", [lessonSection()]);
			rig.host.append(built.el);
			return built;
		})();
		const watch = boxes[1];
		const expected = [
			["live-preview", note(undefined, "\t- [/] Watch video")],
			["reading", note(undefined, `\t- [x] Watch video ✅ ${TODAY}`)],
			["live-preview", note(undefined, `\t- [-] Watch video ❌ ${TODAY}`)],
			["reading", note()],
		] as const;
		for (const [i, [mode, want]] of expected.entries()) {
			if (mode === "reading") hostToReading(rig);
			else hostToLivePreview(rig);
			const native = watchNative(watch);
			expect(mouseClick(watch).defaultPrevented).toBe(true);
			await settle();
			expect(text()).toBe(want);
			expect(rig.app.vault.writes).toHaveLength(i + 1);
			expect(native.count()).toBe(0);
			expect(rig.plugin.domListenerCount).toBe(listeners);
		}
		expect(Notice.shown).toEqual([]);
	});

	it("the editor's own Live Preview checkbox is still not this handler's, and a Reading view in the same workspace does not change that", async () => {
		await closedCourse();
		hostToLivePreview(rig);
		const widget = document.createElement("input");
		widget.type = "checkbox";
		widget.className = "task-list-item-checkbox";
		rig.host.append(widget);
		expect(mouseClick(widget).defaultPrevented).toBe(false);
		await settle();
		expect(rig.app.vault.writes).toEqual([]);
	});

	it("unloading removes every listener, the popout's too, and a Reading-view click is native again", async () => {
		await closedCourse();
		const popout = new Window();
		rig.app.workspace.trigger("window-open", {}, popout);
		const view = openOwnReading(rig);
		rig.plugin.unload();
		expect(rig.plugin.domListenerCount).toBe(0);
		expect(rig.app.workspace.handlers.get("window-open") ?? []).toHaveLength(0);
		const evt = mouseClick(view.boxes[1]);
		await settle();
		expect(evt.defaultPrevented).toBe(false);
		expect(rig.app.vault.writes).toEqual([]);
	});
});
