// @vitest-environment happy-dom
// (happy-dom, like checkbox-press.dom.test.ts.)
/**
 * A press on a task checkbox inside a Live Preview embed, through the real
 * code path: a real `TaskLifecyclePlugin` on the mock app, an embed DOM as
 * Obsidian 1.15.1 draws it, real DOM events, real note text in the mock vault
 * (or, for an open source, a real CodeMirror state with the change detector).
 * IDs are this plan's (G1, G4, G5, G9, G10, GP1 to GP8, E2, E3, E6, E12, F9).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTFile, Notice, type MockVault } from "../__mocks__/obsidian";
import { makeCmEditor } from "../helpers/cm-editor";
import { syncRenderedStatus } from "../../src/rendered/embed-press";
import {
	TODAY,
	UNMAPPABLE,
	click,
	keydown,
	lessonSection,
	makeRig,
	mouseClick,
	pointer,
	settle,
	task,
	watchNative,
	type EmbedRig,
} from "../helpers/embed-rig";

const TODAY_DATE = new Date(2026, 10, 20, 12, 0, 0);

let rig: EmbedRig;

afterEach(() => {
	rig?.plugin.unload();
	vi.useRealTimers();
	document.body.replaceChildren();
});

/** The Course.md text with line 0 replaced; the two subtask lines stay as written. */
const SUBTASKS = "\t- [ ] Watch video\n\t- [ ] Take notes\n";
const course = (line0: string) => `${line0}\n${SUBTASKS}`;

/** Rename as Obsidian does: the same TFile object, its `path` changed in place. */
function renameInPlace(r: EmbedRig, from: string, to: string): void {
	const vault = r.app.vault;
	const file = vault.files.get(from)!;
	vault.files.delete(from);
	file.path = to;
	vault.files.set(to, file);
	vault.texts.set(to, vault.texts.get(from)!);
	vault.texts.delete(from);
}

describe("G1 + G5 + GP1 to GP5: the cycle on a closed source", () => {
	it("GP1, GP2, GP4, GP5: four clicks on ![[Course#^l2]], Course.md closed, subtask lines byte-identical", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		const steps = [
			course("- [/] Lesson 2 content ^l2"),
			course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`),
			course(`- [-] Lesson 2 content ❌ ${TODAY} ^l2`),
			course("- [ ] Lesson 2 content ^l2"),
		];
		const shown = [" ", "/", "x", "-", " "];
		for (const [i, expected] of steps.entries()) {
			const evt = mouseClick(boxes[0]);
			expect(evt.defaultPrevented).toBe(true);
			await settle();
			// The close (step 2) asks about the subtasks; "Leave open" keeps them as they are.
			const leave = Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-container button")).find(
				(b) => b.textContent === "Leave open"
			);
			leave?.click();
			await settle();
			expect(rig.courseText()).toBe(expected);
			// The embed shows what the file now has.
			expect(boxes[0].closest("li")?.getAttribute("data-task")).toBe(shown[i + 1]);
			// One write per press, and it is a vault.process call (the note is closed).
			expect(rig.app.vault.writes).toHaveLength(i + 1);
		}
		expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n" + SUBTASKS);
		expect(native.count()).toBe(0);
		expect(Notice.shown).toEqual([]);
	});

	it("the date before ^l2 is the local date, and a bare emoji in the text is not a stamp", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", "- [/] Lesson ✅ content ^l2\n");
		const { boxes } = rig.addEmbed("Course#^l2", [[task("Lesson ✅ content ", 0)]]);
		boxes[0].closest("li")!.setAttribute("data-task", "/");
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(`- [x] Lesson ✅ content ✅ ${TODAY} ^l2\n`);
	});

	it("a same-kind stamp is not refreshed and an old stamp is removed on reopen", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", "- [x] Lesson 2 content ✅ 2026-11-01 ^l2\n");
		const { boxes } = rig.addEmbed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		boxes[0].closest("li")!.setAttribute("data-task", "x");
		// x -> - swaps the stamp kind (old stamp removed)
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n`);
		// - -> ' ' removes it
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n");
	});

	it("X counts as x, and an unknown char goes to a space", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", "- [X] Lesson 2 content ✅ 2026-11-01 ^l2\n");
		const { boxes } = rig.addEmbed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		boxes[0].closest("li")!.setAttribute("data-task", "X");
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n`);

		rig.app.vault.texts.set("Course.md", "- [?] Lesson 2 content ^l2\n");
		boxes[0].closest("li")!.setAttribute("data-task", "?");
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n");
	});

	it("Close stamps off: the status char only", async () => {
		rig = await makeRig({ closeStamps: false });
		rig.app.vault.texts.set("Course.md", "- [/] Lesson 2 content ^l2\n");
		const { boxes } = rig.addEmbed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		boxes[0].closest("li")!.setAttribute("data-task", "/");
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe("- [x] Lesson 2 content ^l2\n");
	});

	it("a subtask line of the embed is advanced on its own line", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(boxes[2]);
		await settle();
		expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [/] Take notes\n");
	});

	it("a block embed with a size (src keeps Course#^l2) and the heading and whole-note forms resolve", async () => {
		rig = await makeRig();
		const heading = rig.addEmbed("Forms#Sub", [
			[task("Read chapter 3", 0), task("Read chapter 3", 1), task("Unique in sub", 2)],
		]);
		mouseClick(heading.boxes[2]);
		await settle();
		expect(rig.app.vault.texts.get("Forms.md")!.split("\n")[12]).toBe("- [/] Unique in sub");

		const whole = rig.addEmbed("Course", [lessonSection()]);
		mouseClick(whole.boxes[1]);
		await settle();
		expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n\t- [/] Watch video\n\t- [ ] Take notes\n");
	});
});

describe("G1: the suppress decision is synchronous, the write is awaited", () => {
	it("the click is prevented in the click itself, before any write has landed", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		const evt = mouseClick(boxes[0]);
		// Nothing has been awaited yet: the file is untouched, the native toggle is already blocked.
		expect(evt.defaultPrevented).toBe(true);
		expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n" + SUBTASKS);
		release();
		await settle();
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
	});

	it("Space or Enter on a focused box (a click with detail 0 and no pointerdown) is one short click", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		const evt = click(boxes[0], 0);
		expect(evt.defaultPrevented).toBe(true);
		await settle();
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(native.count()).toBe(0);
		// And again: one more step, not two.
		click(boxes[0], 0);
		await settle();
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(rig.app.vault.writes).toHaveLength(2);
	});

	it("T5: Enter on a focused box (a keydown, no click) is one short click, with no native toggle", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		const evt = keydown(boxes[0], "Enter");
		expect(evt.defaultPrevented).toBe(true);
		await settle();
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
		expect(rig.app.vault.writes).toHaveLength(1);
		keydown(boxes[0], "Enter");
		await settle();
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(rig.app.vault.writes).toHaveLength(2);
		expect(native.count()).toBe(0);
		expect(Notice.shown).toEqual([]);
	});

	it("T5: Enter then Space each advance one step; an Enter that also sends a click is still one step", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		keydown(boxes[0], "Enter");
		click(boxes[0], 0);
		await settle();
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
		click(boxes[0], 0);
		await settle();
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(rig.app.vault.writes).toHaveLength(2);
	});

	it("T5: a repeated or modified Enter, and other keys, write nothing", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const start = rig.courseText();
		expect(keydown(boxes[0], "Enter", { repeat: true }).defaultPrevented).toBe(true);
		expect(keydown(boxes[0], "Enter", { ctrlKey: true }).defaultPrevented).toBe(true);
		expect(keydown(boxes[0], "a").defaultPrevented).toBe(false);
		await settle();
		expect(rig.courseText()).toBe(start);
		expect(rig.app.vault.writes).toEqual([]);
	});

	it("T5 + G7: Enter with Status cycle off is the plain toggle, written by the plugin, native box never reached", async () => {
		rig = await makeRig({ statusCycle: false });
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		expect(keydown(boxes[0], "Enter").defaultPrevented).toBe(true);
		await settle();
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(native.count()).toBe(0);
	});

	it("G7: with Status cycle off a click on an embedded box is the plain toggle, not Obsidian's bare [x]", async () => {
		rig = await makeRig({ statusCycle: false });
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		const evt = mouseClick(boxes[0]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(rig.app.vault.writes).toHaveLength(1);
	});
});

describe("G4: only the checkbox is intercepted", () => {
	function withExtras() {
		const { el, boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const li = boxes[0].closest("li") as HTMLElement;
		const link = document.createElement("a");
		link.className = "internal-link";
		link.textContent = "A link";
		li.append(link);
		const title = document.createElement("div");
		title.className = "markdown-embed-title";
		el.prepend(title);
		const openSource = document.createElement("div");
		openSource.className = "markdown-embed-link";
		el.prepend(openSource);
		const chevron = document.createElement("span");
		chevron.className = "collapse-indicator collapse-icon";
		li.prepend(chevron);
		const bullet = li.querySelector(".list-bullet") as HTMLElement;
		return {
			targets: { link, title, openSource, chevron, bullet, liPadding: li },
			boxes,
		};
	}

	it.each(["link", "title", "openSource", "chevron", "bullet", "liPadding"] as const)(
		"a press on the %s keeps its native behaviour and writes nothing",
		async (name) => {
			rig = await makeRig();
			const { targets } = withExtras();
			const target = targets[name];
			const evt = mouseClick(target);
			await settle();
			expect(evt.defaultPrevented).toBe(false);
			expect(rig.app.vault.writes).toEqual([]);
			expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n" + SUBTASKS);
			expect(Notice.shown).toEqual([]);
		}
	);

	it("a click on the same note's own editor checkbox widget (not in an embed) is not this handler's", async () => {
		rig = await makeRig();
		const box = document.createElement("input");
		box.type = "checkbox";
		box.className = "task-list-item-checkbox";
		rig.host.append(box);
		const evt = mouseClick(box);
		await settle();
		expect(evt.defaultPrevented).toBe(false);
		expect(rig.app.vault.writes).toEqual([]);
	});

	it("an embed in a Reading view, a hover popover or a canvas card is left native", async () => {
		rig = await makeRig();
		// Reading view of the host: no `is-live-preview` (Reading view is a later change).
		rig.host.classList.remove("is-live-preview");
		const reading = rig.addEmbed("Course#^l2", [lessonSection()]);
		expect(mouseClick(reading.boxes[0]).defaultPrevented).toBe(false);

		rig.host.classList.add("is-live-preview");
		for (const cls of ["popover hover-popover", "canvas-node"]) {
			const wrap = document.createElement("div");
			wrap.className = cls;
			rig.host.append(wrap);
			const built = rig.addEmbed("Course#^l2", [lessonSection()]);
			wrap.append(built.el.parentElement!);
			expect(mouseClick(built.boxes[0]).defaultPrevented).toBe(false);
		}
		await settle();
		expect(rig.app.vault.writes).toEqual([]);
		expect(Notice.shown).toEqual([]);
	});
});

describe("G9: a stale embed", () => {
	it("writes nothing, shows a notice, redraws the box, and the next click advances from the file's char", async () => {
		rig = await makeRig();
		// The file moved on (done, stamped 2026-11-19); the embed still shows open.
		rig.app.vault.texts.set("Course.md", "- [x] Lesson 2 content ✅ 2026-11-19 ^l2\n");
		const { boxes } = rig.addEmbed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		const li = boxes[0].closest("li")!;
		expect(li.getAttribute("data-task")).toBe(" ");

		const evt = mouseClick(boxes[0]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(rig.courseText()).toBe("- [x] Lesson 2 content ✅ 2026-11-19 ^l2\n");
		expect(Notice.shown).toHaveLength(1);
		expect(Notice.shown[0]).not.toBe(UNMAPPABLE);
		// Re-rendered from the file.
		expect(li.getAttribute("data-task")).toBe("x");
		expect(boxes[0].checked).toBe(true);

		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n`);
		expect(Notice.shown).toHaveLength(1);
	});

	it("an empty data-task is an open task, not a mismatch", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		boxes[0].closest("li")!.setAttribute("data-task", "");
		mouseClick(boxes[0]);
		await settle();
		expect(Notice.shown).toEqual([]);
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
	});
});

describe("G10 + GP8: unmappable or ambiguous", () => {
	it("GP8: a heading embed with two identical lines: ticking one changes nothing and shows the exact notice", async () => {
		rig = await makeRig();
		const before = rig.app.vault.texts.get("Forms.md");
		const { boxes } = rig.addEmbed("Forms#Sub", [
			[task("Read chapter 3", 0), task("Read chapter 3", 1), task("Unique in sub", 2)],
		]);
		const native = watchNative(boxes[1]);
		const evt = mouseClick(boxes[1]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(rig.app.vault.texts.get("Forms.md")).toBe(before);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("an embed whose heading is gone: nothing written, native suppressed, notice", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Forms#No such heading", [[task("Unique in sub", 0)]]);
		const evt = mouseClick(boxes[0]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(rig.app.vault.writes).toEqual([]);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("an embed with no src, a source with no metadata cache, and a task in a table cell", async () => {
		rig = await makeRig();
		const noSrc = rig.addEmbed("Course#^l2", [lessonSection()]);
		noSrc.el.removeAttribute("src");
		const noCache = rig.addEmbed("Course#^l2", [lessonSection()]);
		rig.app.metadataCache.caches.delete("Course.md");
		const inTable = rig.addEmbed("Forms#Sub", [[task("Unique in sub", 2)]]);
		const cell = document.createElement("table");
		cell.append(document.createElement("tbody"));
		inTable.boxes[0].closest("ul")!.replaceWith(cell);
		cell.append(inTable.boxes[0]);

		for (const box of [noSrc.boxes[0], noCache.boxes[0], inTable.boxes[0]]) {
			Notice.reset();
			const evt = mouseClick(box);
			await settle();
			expect(evt.defaultPrevented).toBe(true);
			expect(Notice.shown).toEqual([UNMAPPABLE]);
		}
		expect(rig.app.vault.writes).toEqual([]);
	});

	it("a line that is gone from the source at write time is G10", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		const edited = "- [ ] Something else entirely ^l2\n" + SUBTASKS;
		rig.app.vault.texts.set("Course.md", edited);
		release();
		await settle();
		expect(rig.courseText()).toBe(edited);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("no task is written when the source is a markdown file Obsidian cannot read (deleted)", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		rig.app.vault.texts.delete("Course.md");
		release();
		await expect(settle()).resolves.toBeUndefined();
		expect(rig.app.vault.texts.has("Course.md")).toBe(false);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("a source renamed between click and write (the same TFile moves to a new path): nothing written, no throw, G10", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		renameInPlace(rig, "Course.md", "Renamed.md");
		release();
		await settle();
		// Obsidian keeps the TFile and changes its path: the renamed note is untouched.
		expect(rig.app.vault.texts.get("Renamed.md")).toBe(course("- [ ] Lesson 2 content ^l2"));
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("a rename done before the write queue runs (no hold) is caught the same way", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		renameInPlace(rig, "Course.md", "Renamed.md");
		await settle();
		expect(rig.app.vault.texts.get("Renamed.md")).toBe(course("- [ ] Lesson 2 content ^l2"));
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("a source renamed while open in an editor: the editor is not written, G10", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const file = rig.app.vault.files.get("Course.md")!;
		const cm = makeCmEditor(course("- [ ] Lesson 2 content ^l2"), {
			today: TODAY_DATE,
		});
		// The pane shows the same TFile object, as Obsidian's does.
		rig.app.workspace.leaves.push({ view: { file, editor: cm.editor } });
		mouseClick(boxes[0]);
		renameInPlace(rig, "Course.md", "Renamed.md");
		await settle();
		expect(cm.transactions).toHaveLength(0);
		expect(cm.doc()).toBe(course("- [ ] Lesson 2 content ^l2"));
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("a note deleted and another created at the old path (a different TFile): nothing written, G10", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		const text = rig.courseText();
		rig.app.vault.files.set("Course.md", new MockTFile("Course.md"));
		release();
		await settle();
		expect(rig.courseText()).toBe(text);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});
});

describe("E2: the source line moved or was edited between click and write", () => {
	it("lines inserted above: the task is found again by content and only it changes", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		// The metadata cache still says the block is at line 0.
		rig.app.vault.texts.set("Course.md", "# Course\n\n" + rig.courseText());
		release();
		await settle();
		expect(rig.courseText()).toBe("# Course\n\n" + course("- [/] Lesson 2 content ^l2"));
		expect(Notice.shown).toEqual([]);
	});

	it("the text edited but still the same task (a stamp and a markdown wrapper): re-found", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		rig.app.vault.texts.set("Course.md", "- [ ] **Lesson 2 content** ^l2\n" + SUBTASKS);
		release();
		await settle();
		expect(rig.courseText()).toBe(course("- [/] **Lesson 2 content** ^l2"));
	});

	it("two matches after the move: G10, nothing written", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		const moved = "# New\n" + rig.courseText() + "- [ ] Lesson 2 content ^copy\n";
		rig.app.vault.texts.set("Course.md", moved);
		release();
		await settle();
		expect(rig.courseText()).toBe(moved);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("zero matches after the edit: G10, nothing written", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		const edited = "# New\n- [ ] Lesson 3 content ^l2\n";
		rig.app.vault.texts.set("Course.md", edited);
		release();
		await settle();
		expect(rig.courseText()).toBe(edited);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});
});

describe("E3: two embeds of the same block", () => {
	it("one click writes once and both embeds show the new status", async () => {
		rig = await makeRig();
		const a = rig.addEmbed("Course#^l2", [lessonSection()]);
		const b = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(a.boxes[0]);
		await settle();
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
		expect(a.boxes[0].closest("li")?.getAttribute("data-task")).toBe("/");
		expect(b.boxes[0].closest("li")?.getAttribute("data-task")).toBe("/");
		// The other embed's second box (a different task) is untouched.
		expect(b.boxes[1].closest("li")?.getAttribute("data-task")).toBe(" ");

		// The click on the second embed now advances from the new status, not a stale one.
		mouseClick(b.boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(Notice.shown).toEqual([]);
	});
});

describe("E6: rapid presses", () => {
	it("two presses 0 ms apart, the first write not landed: both land in order, two steps", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]);
		mouseClick(boxes[0]);
		await settle();
		// The second waits behind the first and has not run.
		expect(rig.app.vault.writes).toHaveLength(1);
		release();
		await settle();
		expect(rig.app.vault.writes).toHaveLength(2);
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(Notice.shown).toEqual([]);
	});

	it("three presses 0 ms apart with nothing held: three steps, the second never reads a stale char", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		mouseClick(boxes[0]);
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course(`- [-] Lesson 2 content ❌ ${TODAY} ^l2`));
		expect(Notice.shown).toEqual([]);
	});

	it("E6 on a stale embed: the first of two presses 0 ms apart is refused (G9), the second reads the file's char and advances it", async () => {
		rig = await makeRig();
		// The file is at [/] (changed from outside); the embed still shows open.
		rig.app.vault.texts.set("Course.md", course("- [/] Lesson 2 content ^l2"));
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		expect(boxes[0].closest("li")!.getAttribute("data-task")).toBe(" ");
		mouseClick(boxes[0]);
		mouseClick(boxes[0]);
		await settle();
		// One stale notice for the first press; the second was queued behind it and not dropped.
		expect(Notice.shown).toHaveLength(1);
		expect(Notice.shown[0]).not.toBe(UNMAPPABLE);
		// The refused press called process but changed nothing; the second one advanced the file once.
		expect(rig.app.vault.writes).toHaveLength(2);
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(boxes[0].closest("li")!.getAttribute("data-task")).toBe("x");
	});

	it("T8: a second press after the first landed, on an embed still drawn open, advances from our write (no stale notice)", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
		// Obsidian has not caught up (or redrew from the old text): the embed shows open again.
		syncRenderedStatus(boxes[0], " ");
		expect(boxes[0].closest("li")!.getAttribute("data-task")).toBe(" ");
		mouseClick(boxes[0]);
		await settle();
		expect(Notice.shown).toEqual([]);
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		expect(boxes[0].closest("li")!.getAttribute("data-task")).toBe("x");
	});

	it("T8: the embed is only forgiven for our own write: a file changed from outside afterwards is still a stale embed (G9)", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		await settle();
		syncRenderedStatus(boxes[0], " ");
		// Another tool moves the task on to [x]; the embed still shows open.
		rig.app.vault.texts.set("Course.md", course("- [x] Lesson 2 content ✅ 2026-01-01 ^l2"));
		const writes = rig.app.vault.writes.length;
		mouseClick(boxes[0]);
		await settle();
		expect(Notice.shown).toHaveLength(1);
		expect(Notice.shown[0]).not.toBe(UNMAPPABLE);
		expect(rig.courseText()).toBe(course("- [x] Lesson 2 content ✅ 2026-01-01 ^l2"));
		expect(rig.app.vault.writes.length).toBe(writes + 1); // process ran, changed nothing
	});

	it("T11: the file put back to what the embed still shows is not stale: the first press advances from it, no notice", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const li = boxes[0].closest("li")!;
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
		// The embed has not caught up (it shows open again) and the note is put back to open from outside.
		syncRenderedStatus(boxes[0], " ");
		rig.app.vault.texts.set("Course.md", course("- [ ] Lesson 2 content ^l2"));

		mouseClick(boxes[0]);
		await settle();
		expect(Notice.shown).toEqual([]);
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
		expect(li.getAttribute("data-task")).toBe("/");
		mouseClick(boxes[0]);
		await settle();
		expect(Notice.shown).toEqual([]);
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
	});

	it("T11: a refused stale press drops our write record, so the next press compares with what the embed then shows", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const li = boxes[0].closest("li")!;
		mouseClick(boxes[0]);
		await settle();
		// Embed shows open (not caught up); another tool moved the file on to [x].
		syncRenderedStatus(boxes[0], " ");
		rig.app.vault.texts.set("Course.md", course("- [x] Lesson 2 content ✅ 2026-01-01 ^l2"));
		mouseClick(boxes[0]);
		await settle();
		expect(Notice.shown).toHaveLength(1);
		expect(li.getAttribute("data-task")).toBe("x");
		// The file goes back to open while the embed is made to show open again: they agree, so
		// the record of our old write (open to in progress) must not turn this into a stale press.
		syncRenderedStatus(boxes[0], " ");
		rig.app.vault.texts.set("Course.md", course("- [ ] Lesson 2 content ^l2"));
		mouseClick(boxes[0]);
		await settle();
		expect(Notice.shown).toHaveLength(1);
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
	});

	it("a failed write does not drop the press behind it", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const original = rig.app.vault.process.bind(rig.app.vault) as MockVault["process"];
		let calls = 0;
		rig.app.vault.process = async (f: MockTFile, fn?: (data: string) => string) => {
			calls += 1;
			if (calls === 1) throw new Error("disk full");
			return original(f, fn);
		};
		mouseClick(boxes[0]);
		mouseClick(boxes[0]);
		await settle();
		expect(calls).toBe(2);
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2"));
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});
});

describe("source open in an editor", () => {
	function openCourse(text: string) {
		const cm = makeCmEditor(text, { today: TODAY_DATE });
		rig.app.workspace.leaves.push({ view: { file: { path: "Course.md" }, editor: cm.editor } });
		return cm;
	}

	it("the write is an editor transaction, never vault.process; the detector stamps once; unsaved typing is kept", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const cm = openCourse("- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
		cm.type(2, " TYPED, not saved yet");

		mouseClick(boxes[0]);
		await settle();
		mouseClick(boxes[0]);
		await settle();

		expect(cm.doc()).toBe(
			`- [x] Lesson 2 content ✅ ${TODAY} ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes TYPED, not saved yet\n`
		);
		expect(cm.transactions).toHaveLength(2);
		expect(cm.events.map((e) => `${e.from}>${e.to}`)).toEqual([" >/", "/>x"]);
		expect(rig.app.vault.writes).toEqual([]);
		expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n" + SUBTASKS);
	});

	it("an indented task keeps its indentation, and the editor text is what is matched (not the disk copy)", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		// The disk copy and the editor differ: the editor already holds the first step.
		const cm = openCourse("- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
		boxes[1].closest("li")!.setAttribute("data-task", " ");
		mouseClick(boxes[1]);
		await settle();
		expect(cm.doc()).toBe("- [/] Lesson 2 content ^l2\n\t- [/] Watch video\n\t- [ ] Take notes\n");
		expect(rig.app.vault.writes).toEqual([]);
	});

	it("E15/E3: two presses 0 ms apart on an open note advance two steps with one stamp", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const cm = openCourse("- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
		mouseClick(boxes[0]);
		mouseClick(boxes[0]);
		await settle();
		expect(cm.doc().split("\n")[0]).toBe(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`);
		expect(Notice.shown).toEqual([]);
	});
});

describe("CRLF and indentation, closed source", () => {
	it("keeps every line ending byte-for-byte and the task's own indentation", async () => {
		rig = await makeRig();
		const crlf = readFileSync(join(__dirname, "..", "fixtures", "crlf-note.md"), "utf8");
		const lines = crlf.split("\r\n");
		expect(lines[2]).toBe("- [ ] Ship release ^rel1");
		const text = crlf.replace("- [ ] Book venue", "\t- [ ] Book venue");
		const indentedLine = text.split("\r\n").findIndex((l) => l.includes("Book venue"));
		rig.app.addNote("Crlf.md", text, {
			blocks: { rel1: { position: { start: { line: 2 }, end: { line: 2 } } } },
			listItems: [
				{ position: { start: { line: 2 }, end: { line: 2 } }, parent: -2 },
				{ position: { start: { line: indentedLine }, end: { line: indentedLine } }, parent: -2 },
			],
		});

		const { boxes } = rig.addEmbed("Crlf#^rel1", [[task("Ship release ", 0)]]);
		mouseClick(boxes[0]);
		await settle();
		expect(rig.app.vault.texts.get("Crlf.md")).toBe(text.replace("- [ ] Ship release", "- [/] Ship release"));

		const second = rig.addEmbed("Crlf", [[task("Book venue", 0)]]);
		mouseClick(second.boxes[0]);
		await settle();
		const after = rig.app.vault.texts.get("Crlf.md")!;
		expect(after).toBe(
			text.replace("- [ ] Ship release", "- [/] Ship release").replace("\t- [ ] Book venue", "\t- [/] Book venue")
		);
		expect(after.split("\r\n")).toHaveLength(text.split("\r\n").length);
		expect(after.replace(/\r\n/g, "")).not.toContain("\n");
	});
});

describe("C17: CRLF and an indented child task, block embed of the parent", () => {
	const TOP = "- [ ] Top CRLF ^top";
	const CHILD = "  - [ ] Indented CRLF ^ind";
	const noteOf = (top: string, child: string, eol: string) => [top, child, "tail"].join(eol) + eol;
	const cacheOf = {
		blocks: { top: { position: { start: { line: 0 }, end: { line: 1 } } } },
		listItems: [
			{ position: { start: { line: 0 }, end: { line: 1 } }, parent: -1 },
			{ position: { start: { line: 1 }, end: { line: 1 } }, parent: 0 },
		],
	};

	for (const [label, eol] of [["CRLF", "\r\n"], ["LF", "\n"]] as const) {
		it(`${label}: pressing the indented child in an embed of its parent changes only that char, indentation and every line ending kept`, async () => {
			rig = await makeRig();
			const text = noteOf(TOP, CHILD, eol);
			rig.app.addNote("Nested.md", text, cacheOf);
			const { boxes } = rig.addEmbed("Nested#^top", [
				[task("Top CRLF ", 0, [task("Indented CRLF ^ind", 1)])],
			]);
			const native = watchNative(boxes[1]);
			mouseClick(boxes[1]);
			await settle();
			expect(Notice.shown).toEqual([]);
			expect(rig.app.vault.texts.get("Nested.md")).toBe(noteOf(TOP, "  - [/] Indented CRLF ^ind", eol));
			mouseClick(boxes[1]);
			await settle();
			expect(rig.app.vault.texts.get("Nested.md")).toBe(
				noteOf(TOP, `  - [x] Indented CRLF ✅ ${TODAY} ^ind`, eol)
			);
			expect(native.count()).toBe(0);
		});
	}

	it("a child that Obsidian draws with a lazy continuation line ('last' after it) cannot be matched: G10, nothing written", async () => {
		rig = await makeRig();
		// "tail" has no blank line before it, so Markdown folds it into the child's text; the
		// rendered text is then not one line of the source (docs: multi-line items are G10).
		const text = noteOf(TOP, CHILD, "\r\n");
		rig.app.addNote("Nested.md", text, cacheOf);
		const { boxes } = rig.addEmbed("Nested#^top", [
			[task("Top CRLF ", 0, [task("Indented CRLF ^ind\ntail", 1)])],
		]);
		mouseClick(boxes[1]);
		await settle();
		expect(Notice.shown).toEqual([UNMAPPABLE]);
		expect(rig.app.vault.texts.get("Nested.md")).toBe(text);
	});
});

describe("E12: plugin unloaded", () => {
	it("the listeners are gone, a click is native again, and nothing fires afterwards", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const release = rig.app.vault.hold("Course.md");
		mouseClick(boxes[0]); // running, held
		mouseClick(boxes[0]); // queued behind it
		await settle();
		expect(rig.app.vault.writes).toHaveLength(1);

		rig.plugin.unload();
		expect(rig.plugin.domListenerCount).toBe(0);
		release();
		await vi.advanceTimersByTimeAsync(5000);
		// The held press was not applied and the queued one never ran.
		expect(rig.courseText()).toBe("- [ ] Lesson 2 content ^l2\n" + SUBTASKS);
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(Notice.shown).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);

		const native = watchNative(boxes[0]);
		const evt = mouseClick(boxes[0]);
		await settle();
		expect(evt.defaultPrevented).toBe(false);
		expect(native.count()).toBe(1);
		expect(rig.app.vault.writes).toHaveLength(1);
	});
});

describe("F9: the native toggle never leaves an unstamped [x]", () => {
	const noBareDone = (text: string) =>
		expect(text.split("\n").filter((l) => /\[x\]/.test(l) && !/✅ \d{4}-\d{2}-\d{2}/.test(l))).toEqual([]);

	type PressKind = "click" | "double click" | "keyboard click" | "Enter key" | "drag ending on the box" | "hold of 500 ms";
	const presses: Array<[PressKind, (box: HTMLInputElement, host: HTMLElement) => Promise<MouseEvent[]>]> = [
		["click", async (box) => [mouseClick(box)]],
		["double click", async (box) => [mouseClick(box), mouseClick(box)]],
		["keyboard click", async (box) => [click(box, 0)]],
		["Enter key", async (box) => [keydown(box, "Enter") as unknown as MouseEvent]],
		[
			"drag ending on the box",
			async (box, host) => {
				pointer("pointerdown", host, { clientX: 0, clientY: 0 });
				pointer("pointermove", box, { clientX: 40, clientY: 0 });
				pointer("pointerup", box, { clientX: 40, clientY: 0 });
				return [click(box, 1)];
			},
		],
		[
			"hold of 500 ms",
			async (box) => {
				pointer("pointerdown", box);
				await vi.advanceTimersByTimeAsync(500);
				pointer("pointerup", box);
				return [click(box, 1)];
			},
		],
	];

	it.each(presses)("%s: the native event is defaultPrevented and the source never gains a bare [x]", async (kind, press) => {
		rig = await makeRig();
		// A done parent next to the task would show a bare [x] if the native toggle ran.
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const native = watchNative(boxes[0]);
		const events = await press(boxes[0], rig.host);
		await settle();
		for (const evt of events) expect(evt.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		noBareDone(rig.courseText());
		// Only a short click or a keyboard click moves the task; a drag only suppresses;
		// a hold cancels it (G3, with the stamp).
		const stepped = kind === "double click" ? 2 : kind === "click" || kind === "keyboard click" || kind === "Enter key" ? 1 : 0;
		const expected =
			kind === "hold of 500 ms"
				? `- [-] Lesson 2 content ❌ ${TODAY} ^l2`
				: ["- [ ] Lesson 2 content ^l2", "- [/] Lesson 2 content ^l2", `- [x] Lesson 2 content ✅ ${TODAY} ^l2`][stepped];
		expect(rig.courseText()).toBe(`${expected}\n${SUBTASKS}`);
	});

	it("a hold on a task already [/] cancels it to [-] and the release's click never makes a bare [x]", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", "- [/] Lesson 2 content ^l2\n");
		const { boxes } = rig.addEmbed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		boxes[0].closest("li")!.setAttribute("data-task", "/");
		pointer("pointerdown", boxes[0]);
		await vi.advanceTimersByTimeAsync(1200);
		pointer("pointerup", boxes[0]);
		expect(click(boxes[0], 1).defaultPrevented).toBe(true);
		await settle();
		expect(rig.courseText()).toBe(`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n`);
	});
});
