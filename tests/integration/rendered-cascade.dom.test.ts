// @vitest-environment happy-dom
// (happy-dom, like embed-press.dom.test.ts and rendered-press.dom.test.ts.)
/**
 * The close cascade from a rendered checkbox (G6, G7, G8, E10, E18, F1, F3,
 * F9, GP3), through the real code path: a real `TaskLifecyclePlugin` on the
 * mock app with the real cascade service, the real `CloseSubtasksDialog` (on
 * the mock `Modal`), the real source writer and the real stamp and cascade
 * code; an embed DOM as Obsidian 1.15.1 draws it; real DOM events; the note's
 * text in the mock vault (`vault.process` is recorded in `vault.writes`) or,
 * for an open source, a real CodeMirror state with the change detector.
 * Fixtures: `tests/fixtures/lifecycle-demo.md` and `tests/fixtures/crlf-note.md`.
 *
 * Every expected note text is written out literally.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal, Notice } from "../__mocks__/obsidian";
import {
	TODAY,
	UNMAPPABLE,
	click,
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
import { syncRenderedStatus } from "../../src/rendered/embed-press";
import { fixtureFile } from "../fixtures/source-lines";

let rig: EmbedRig;

afterEach(() => {
	rig?.plugin.unload();
	vi.useRealTimers();
	document.body.replaceChildren();
	Modal.openModals = [];
});

const pos = (a: number, b = a) => ({ start: { line: a }, end: { line: b } });

/** `Course.md` with its parent at `[/]`, as it is on disk before the press that closes it. */
const COURSE_IN_PROGRESS = "- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n";
const COURSE_DONE_PARENT = `- [x] Lesson 2 content ✅ ${TODAY} ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n`;
const COURSE_ALL_DONE = `- [x] Lesson 2 content ✅ ${TODAY} ^l2\n\t- [x] Watch video ✅ ${TODAY}\n\t- [x] Take notes ✅ ${TODAY}\n`;
const COURSE_CANCELLED_PARENT = `- [-] Lesson 2 content ❌ ${TODAY} ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n`;
const COURSE_ALL_CANCELLED = `- [-] Lesson 2 content ❌ ${TODAY} ^l2\n\t- [-] Watch video ❌ ${TODAY}\n\t- [-] Take notes ❌ ${TODAY}\n`;

const text = () => rig.courseText();
const dialog = () => document.querySelector(".modal-container");
const dialogText = () => dialog()?.querySelector("p")?.textContent ?? null;
const button = (label: string) =>
	Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-container button")).find(
		(b) => b.textContent === label
	);

/** A rig with `Course.md` closed, holding `COURSE_IN_PROGRESS`, and an embed of `![[Course#^l2]]` showing `/`. */
async function closedCourse(settings?: unknown) {
	rig = await makeRig(settings);
	rig.app.vault.texts.set("Course.md", COURSE_IN_PROGRESS);
	const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
	syncRenderedStatus(boxes[0], "/");
	return boxes;
}

/** Press the parent to done and let the dialog open. */
async function closeParent(box: HTMLInputElement): Promise<void> {
	mouseClick(box);
	for (let i = 0; i < 4; i++) await settle();
}

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("GP3 / G6: a close from a rendered checkbox on a closed source", () => {
	it("writes the parent first, then asks 'This task has 2 open subtasks.' with Close subtasks focused", async () => {
		const [box] = await closedCourse();
		const native = watchNative(box);
		const before = rig.app.vault.writes.length;

		const evt = mouseClick(box);
		expect(evt.defaultPrevented).toBe(true);
		await settle();
		// The parent is on disk before the dialog is answered, subtasks untouched.
		expect(text()).toBe(COURSE_DONE_PARENT);
		expect(rig.app.vault.writes.length - before).toBe(1);
		await settle();
		expect(dialogText()).toBe("This task has 2 open subtasks.");
		expect(document.activeElement).toBe(button("Close subtasks"));
		expect(document.querySelector(".modal-title")?.textContent).toBe("Close subtasks?");
		expect(native.count()).toBe(0);
		expect(Notice.shown).toEqual([]);
	});

	it("Close subtasks closes both in one more write and leaves the parent line as it was", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		const before = rig.app.vault.writes.length;

		button("Close subtasks")!.click();
		await settle();
		await settle();

		expect(text()).toBe(COURSE_ALL_DONE);
		// One write for both subtasks, not one per subtask.
		expect(rig.app.vault.writes.slice(before)).toEqual(["process:Course.md"]);
		expect(dialog()).toBeNull();
		expect(Notice.shown).toEqual([]);
	});

	it("Enter is Close subtasks", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		Modal.openModals[0].scope.press("Enter", { target: button("Close subtasks") });
		await settle();
		await settle();
		expect(text()).toBe(COURSE_ALL_DONE);
	});

	it("a cancelled parent (long press) gives the subtasks - and ❌", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", "- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		pointer("pointerdown", boxes[0], { clientX: 100, clientY: 100 });
		await wait(500);
		pointer("pointerup", boxes[0], { clientX: 100, clientY: 100 });
		click(boxes[0], 1);
		for (let i = 0; i < 4; i++) await settle();
		expect(text()).toBe(COURSE_CANCELLED_PARENT);
		expect(dialogText()).toBe("This task has 2 open subtasks.");

		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe(COURSE_ALL_CANCELLED);
	});

	// The close path takes no surface argument: PR-3's embed press and PR-4's
	// long press both end in the one `CascadeService.reportClose`, so the same
	// dialog and the same writes follow from either trigger.
	it("the embed press and the long press reach the one reportClose entry point and give the same dialog and writes", async () => {
		const seen: Record<string, { calls: unknown[]; dialog: string | null; writes: string[]; text: string }> = {};
		const OPEN = "- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n";

		for (const trigger of ["embed press", "long press"] as const) {
			rig = await makeRig();
			rig.app.vault.texts.set("Course.md", trigger === "embed press" ? COURSE_IN_PROGRESS : OPEN);
			const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
			if (trigger === "embed press") syncRenderedStatus(boxes[0], "/");
			const cascade = (rig.plugin as unknown as { cascade: { reportClose: (p: unknown) => void } }).cascade;
			const calls: unknown[] = [];
			const real = cascade.reportClose;
			cascade.reportClose = (payload) => {
				calls.push(payload);
				real(payload);
			};

			if (trigger === "embed press") {
				// `/` to `x`: the press closes the parent.
				mouseClick(boxes[0]);
			} else {
				pointer("pointerdown", boxes[0], { clientX: 100, clientY: 100 });
				await wait(500);
				pointer("pointerup", boxes[0], { clientX: 100, clientY: 100 });
				click(boxes[0], 1);
			}
			for (let i = 0; i < 4; i++) await settle();
			const dialogShown = dialogText();
			const parentText = text();
			const before = rig.app.vault.writes.length;
			button("Close subtasks")!.click();
			await settle();
			await settle();
			seen[trigger] = {
				calls,
				dialog: dialogShown,
				writes: [...rig.app.vault.writes.slice(before)],
				text: `${parentText}|${text()}`,
			};
			rig.plugin.unload();
			document.body.replaceChildren();
			Modal.openModals = [];
			vi.useRealTimers();
		}

		// One close reported from each trigger, with the same payload keys.
		expect(seen["embed press"].calls).toHaveLength(1);
		expect(seen["long press"].calls).toHaveLength(1);
		expect(Object.keys(seen["embed press"].calls[0] as object).sort()).toEqual(
			Object.keys(seen["long press"].calls[0] as object).sort()
		);
		expect(seen["embed press"].calls[0]).toMatchObject({ line: 0, to: "x" });
		expect(seen["long press"].calls[0]).toMatchObject({ line: 0, to: "-" });
		// The same dialog and the same single subtask write.
		expect(seen["embed press"].dialog).toBe("This task has 2 open subtasks.");
		expect(seen["long press"].dialog).toBe("This task has 2 open subtasks.");
		expect(seen["embed press"].writes).toEqual(["process:Course.md"]);
		expect(seen["long press"].writes).toEqual(["process:Course.md"]);
		// Only the status char and the stamp kind differ.
		expect(seen["embed press"].text).toBe(`${COURSE_DONE_PARENT}|${COURSE_ALL_DONE}`);
		expect(seen["long press"].text).toBe(`${COURSE_CANCELLED_PARENT}|${COURSE_ALL_CANCELLED}`);
	});

	it.each([
		["Leave open", () => button("Leave open")!.click()],
		["Escape", () => Modal.openModals[0].close()],
		["a click outside", () => Modal.openModals[0].close()],
	])("%s changes nothing after the parent write", async (_name, answer) => {
		const [box] = await closedCourse();
		await closeParent(box);
		const before = rig.app.vault.writes.length;
		answer();
		await settle();
		await settle();
		expect(text()).toBe(COURSE_DONE_PARENT);
		expect(rig.app.vault.writes.length).toBe(before);
		expect(dialog()).toBeNull();
	});

	it("the count comes from the source note, not from what the embed renders", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", COURSE_IN_PROGRESS);
		// An embed that draws the parent alone.
		const { boxes } = rig.addEmbed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		syncRenderedStatus(boxes[0], "/");
		await closeParent(boxes[0]);
		expect(dialogText()).toBe("This task has 2 open subtasks.");
	});

	it("singular: one open subtask", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set(
			"Course.md",
			"- [/] Lesson 2 content ^l2\n\t- [x] Watch video ✅ 2026-11-01\n\t- [ ] Take notes\n"
		);
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		syncRenderedStatus(boxes[0], "/");
		await closeParent(boxes[0]);
		expect(dialogText()).toBe("This task has 1 open subtask.");
	});

	it("a parent with only closed subtasks, or none: no dialog and no further write", async () => {
		for (const source of [
			"- [/] Lesson 2 content ^l2\n\t- [x] Watch video ✅ 2026-11-01\n\t- [-] Take notes ❌ 2026-11-01\n",
			"- [/] Lesson 2 content ^l2\n",
		]) {
			rig = await makeRig();
			rig.app.vault.texts.set("Course.md", source);
			const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
			syncRenderedStatus(boxes[0], "/");
			await closeParent(boxes[0]);
			expect(dialog()).toBeNull();
			expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
			rig.plugin.unload();
		}
	});

	it("x <-> - never prompts, and reopening never reopens the subtasks or prompts", async () => {
		const [box] = await closedCourse();
		// [/] -> x (dialog) -> Leave open, then x -> - -> ' ' with no further dialog.
		await closeParent(box);
		button("Leave open")!.click();
		await settle();
		for (const expected of [
			`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n`,
			"- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n",
		]) {
			mouseClick(box);
			for (let i = 0; i < 4; i++) await settle();
			expect(dialog()).toBeNull();
			expect(text()).toBe(expected);
		}
	});
});

describe("G6: a press while the dialog is open is ignored", () => {
	it("is swallowed (no native toggle), writes nothing, and the dialog still works", async () => {
		const [box] = await closedCourse();
		const native = watchNative(box);
		await closeParent(box);
		const before = rig.app.vault.writes.length;

		const evt = mouseClick(box);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(rig.app.vault.writes.length).toBe(before);
		expect(text()).toBe(COURSE_DONE_PARENT);
		expect(Notice.shown).toEqual([]);
		expect(document.querySelectorAll(".modal-container")).toHaveLength(1);

		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe(COURSE_ALL_DONE);
	});

	it("a long press while the dialog is open is ignored too", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		const before = rig.app.vault.writes.length;
		pointer("pointerdown", box, { clientX: 100, clientY: 100 });
		await wait(600);
		pointer("pointerup", box, { clientX: 100, clientY: 100 });
		click(box, 1);
		await settle();
		expect(rig.app.vault.writes.length).toBe(before);
		expect(text()).toBe(COURSE_DONE_PARENT);
	});

	it("after the dialog ends a press works again", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		button("Leave open")!.click();
		await settle();
		mouseClick(box);
		await settle();
		expect(text()).toBe(`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n`);
	});
});

describe("G7: the settings guard the cascade", () => {
	it("Close cascade off: the parent is written, no dialog opens", async () => {
		const [box] = await closedCourse({ closeCascade: false });
		await closeParent(box);
		expect(dialog()).toBeNull();
		expect(text()).toBe(COURSE_DONE_PARENT);
	});

	it("Close stamps off: the parent gets no stamp and the cascade sets status only, with no emoji", async () => {
		const [box] = await closedCourse({ closeStamps: false });
		await closeParent(box);
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe("- [x] Lesson 2 content ^l2\n\t- [x] Watch video\n\t- [x] Take notes\n");
		expect(text()).not.toMatch(/[✅❌]/);
	});

	it("Close cascade turned off while the dialog is open closes it as Leave open", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		await rig.plugin.settings.update({ closeCascade: false });
		await settle();
		expect(dialog()).toBeNull();
		expect(text()).toBe(COURSE_DONE_PARENT);
	});
});

describe("E10 / G8: the closed-source write at apply time", () => {
	it("subtasks changed while the dialog is open: only tasks still open are closed", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		// A subtask is closed by hand and another is added, on disk, while the dialog shows.
		rig.app.vault.texts.set(
			"Course.md",
			`- [x] Lesson 2 content ✅ ${TODAY} ^l2\n\t- [x] Watch video ✅ 2026-11-01\n\t- [ ] Take notes\n\t- [/] Added later\n`
		);
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe(
			`- [x] Lesson 2 content ✅ ${TODAY} ^l2\n\t- [x] Watch video ✅ 2026-11-01\n\t- [x] Take notes ✅ ${TODAY}\n\t- [x] Added later ✅ ${TODAY}\n`
		);
	});

	it("parent no longer found at apply time: nothing is written and the notice shows", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		const edited = `- [x] Lesson 2 edited ✅ ${TODAY} ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n`;
		rig.app.vault.texts.set("Course.md", edited);
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe(edited);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("parent found more than once at apply time: nothing is written and the notice shows", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		const doubled = COURSE_DONE_PARENT + `- [x] Lesson 2 content ✅ ${TODAY} ^l2\n`;
		rig.app.vault.texts.set("Course.md", doubled);
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(text()).toBe(doubled);
		expect(Notice.shown).toEqual([UNMAPPABLE]);
	});

	it("source deleted while the dialog is open: a no-op with the notice and no unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", onUnhandled);
		try {
			const [box] = await closedCourse();
			await closeParent(box);
			rig.app.vault.texts.delete("Course.md");
			button("Close subtasks")!.click();
			await settle();
			await settle();
			expect(Notice.shown).toEqual([UNMAPPABLE]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("E18: a press on the same note while the cascade write is in flight is queued behind it, in order, and not dropped", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		const release = rig.app.vault.hold("Course.md");
		button("Close subtasks")!.click();
		await settle();
		await settle();
		// The cascade write has started and waits. The press is queued, not run.
		expect(rig.app.vault.writes).toHaveLength(2);
		mouseClick(box);
		await settle();
		expect(rig.app.vault.writes).toHaveLength(2);
		expect(text()).toBe(COURSE_DONE_PARENT);

		release();
		await settle();
		await settle();
		expect(rig.app.vault.writes).toHaveLength(3);
		// The subtasks closed first, then the parent went from x to -.
		expect(text()).toBe(
			`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n\t- [x] Watch video ✅ ${TODAY}\n\t- [x] Take notes ✅ ${TODAY}\n`
		);
		expect(Notice.shown).toEqual([]);
	});

	it("rapid double press on the parent opens one dialog", async () => {
		const [box] = await closedCourse();
		mouseClick(box);
		mouseClick(box);
		for (let i = 0; i < 4; i++) await settle();
		// The second press found the dialog not yet open, so it ran: x then -. Either way one dialog at most.
		expect(document.querySelectorAll(".modal-container").length).toBeLessThanOrEqual(1);
		expect(text()).toBe(
			`- [-] Lesson 2 content ❌ ${TODAY} ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n`
		);
		// x then - never asked a second time: nothing opened for the cancelled state.
		expect(dialog() === null || dialogText() === "This task has 2 open subtasks.").toBe(true);
	});

	it("plugin unloaded with the dialog open: it closes as Leave open, no write follows, no listener remains", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		const before = rig.app.vault.writes.length;
		rig.plugin.unload();
		await settle();
		await settle();
		expect(dialog()).toBeNull();
		expect(Modal.openModals).toHaveLength(0);
		expect(rig.app.vault.writes.length).toBe(before);
		expect(text()).toBe(COURSE_DONE_PARENT);
		expect(rig.plugin.domListenerCount).toBe(0);
	});

	it("two different parents closed in quick succession: the second dialog replaces the first", async () => {
		rig = await makeRig();
		const source =
			"- [/] One ^o1\n\t- [ ] one-a\n- [/] Two ^t2\n\t- [ ] two-a\n\t- [ ] two-b\n";
		rig.app.vault.texts.set("Lifecycle.md", source);
		const file = rig.app.addNote("Lifecycle.md", source, {
			blocks: { o1: { position: pos(0) }, t2: { position: pos(2) } },
			listItems: [
				{ position: pos(0), parent: -1 },
				{ position: pos(1), parent: 0 },
				{ position: pos(2), parent: -3 },
				{ position: pos(3), parent: 2 },
				{ position: pos(4), parent: 2 },
			],
		});
		expect(file.path).toBe("Lifecycle.md");
		const one = rig.addEmbed("Lifecycle#^o1", [[task("One ", 0, [task("one-a", 1)])]]);
		const two = rig.addEmbed("Lifecycle#^t2", [[task("Two ", 0, [task("two-a", 1), task("two-b", 2)])]]);
		syncRenderedStatus(one.boxes[0], "/");
		syncRenderedStatus(two.boxes[0], "/");

		// Both presses start before either dialog opens.
		mouseClick(one.boxes[0]);
		mouseClick(two.boxes[0]);
		for (let i = 0; i < 6; i++) await settle();
		expect(document.querySelectorAll(".modal-container")).toHaveLength(1);
		expect(dialogText()).toBe("This task has 2 open subtasks.");

		button("Close subtasks")!.click();
		await settle();
		await settle();
		// The first parent's subtask stays open; the second parent's both close.
		expect(rig.app.vault.texts.get("Lifecycle.md")).toBe(
			`- [x] One ✅ ${TODAY} ^o1\n\t- [ ] one-a\n- [x] Two ✅ ${TODAY} ^t2\n\t- [x] two-a ✅ ${TODAY}\n\t- [x] two-b ✅ ${TODAY}\n`
		);
	});
});

describe("G6 / E1 / E5 / F3: lifecycle-demo.md and crlf-note.md", () => {
	const DEMO = fixtureFile("lifecycle-demo.md");
	const DEMO_CACHE = {
		blocks: { rel1: { position: pos(0) } },
		listItems: [
			{ position: pos(0), parent: -1 },
			{ position: pos(1), parent: 0 },
			{ position: pos(2), parent: 0 },
			{ position: pos(3), parent: 2 },
			{ position: pos(4), parent: 0 },
			{ position: pos(5), parent: -6 },
		],
	};

	async function demoRig(source: string) {
		rig = await makeRig();
		rig.app.addNote("Lifecycle.md", source, DEMO_CACHE);
		const { boxes } = rig.addEmbed("Lifecycle#^rel1", [[task("Ship release ", 0)]]);
		syncRenderedStatus(boxes[0], "/");
		return boxes[0];
	}

	const demoText = () => rig.app.vault.texts.get("Lifecycle.md");

	it("nested subtasks at any depth are closed, the plain bullet and the closed task are left as they are, the ^id stays after the stamp", async () => {
		const box = await demoRig(DEMO.replace("- [ ] Ship release", "- [/] Ship release"));
		await closeParent(box);
		expect(dialogText()).toBe("This task has 2 open subtasks.");
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(demoText()).toBe(
			[
				`- [x] Ship release ✅ ${TODAY} ^rel1`,
				`\t- [x] Write notes ✅ ${TODAY}`,
				"\t- Notes",
				`\t\t- [x] Proofread ✅ ${TODAY}`,
				"\t- [x] Tag build ✅ 2026-11-08",
				"- [ ] Book venue",
				"",
			].join("\n")
		);
	});

	it("CRLF closed source: every \\r\\n survives the parent write and the cascade write, and only status chars and stamps differ", async () => {
		const crlf = DEMO.replace("- [ ] Ship release", "- [/] Ship release").replace(/\n/g, "\r\n");
		const box = await demoRig(crlf);
		await closeParent(box);
		button("Close subtasks")!.click();
		await settle();
		await settle();
		const after = demoText()!;
		expect(after).toBe(
			[
				`- [x] Ship release ✅ ${TODAY} ^rel1`,
				`\t- [x] Write notes ✅ ${TODAY}`,
				"\t- Notes",
				`\t\t- [x] Proofread ✅ ${TODAY}`,
				"\t- [x] Tag build ✅ 2026-11-08",
				"- [ ] Book venue",
				"",
			].join("\r\n")
		);
		expect(after).not.toMatch(/[^\r]\n/);

		// F3: a byte diff shows only status chars, stamps and the one space before a stamp.
		const strip = (s: string) =>
			s.replace(/\[[ x/-]\]/g, "[?]").replace(/ ✅ \d{4}-\d{2}-\d{2}/g, "");
		expect(strip(after)).toBe(strip(crlf));
	});

	it("crlf-note.md: closing a task that has no subtasks gives no dialog and one write, with its CRLF intact", async () => {
		const note = fixtureFile("crlf-note.md").replace("- [ ] Ship release", "- [/] Ship release");
		rig = await makeRig();
		rig.app.addNote("Crlf.md", note, {
			blocks: { rel1: { position: pos(2) } },
			listItems: [
				{ position: pos(2), parent: -3 },
				{ position: pos(3), parent: -4 },
				{ position: pos(4), parent: -5 },
			],
		});
		const { boxes } = rig.addEmbed("Crlf#^rel1", [[task("Ship release ", 0)]]);
		syncRenderedStatus(boxes[0], "/");
		await closeParent(boxes[0]);
		expect(dialog()).toBeNull();
		expect(rig.app.vault.texts.get("Crlf.md")).toBe(
			note.replace("- [/] Ship release ^rel1", `- [x] Ship release ✅ ${TODAY} ^rel1`)
		);
		expect(rig.app.vault.writes).toEqual(["process:Crlf.md"]);
	});
});

describe("G8: an open source gets the subtask write as one editor transaction", () => {
	it("the parent is one transaction, the subtasks one more; vault.process is never called", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", COURSE_IN_PROGRESS);
		const cm = openCourseInEditor(rig, COURSE_IN_PROGRESS);
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		syncRenderedStatus(boxes[0], "/");

		await closeParent(boxes[0]);
		expect(cm.transactions).toHaveLength(1);
		expect(cm.doc()).toBe(COURSE_DONE_PARENT);
		expect(dialogText()).toBe("This task has 2 open subtasks.");

		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(cm.transactions).toHaveLength(2);
		expect(cm.doc()).toBe(COURSE_ALL_DONE);
		expect(rig.app.vault.writes).toEqual([]);
	});

	it("unsaved typing in the open editor survives the cascade", async () => {
		rig = await makeRig();
		rig.app.vault.texts.set("Course.md", COURSE_IN_PROGRESS);
		const cm = openCourseInEditor(rig, COURSE_IN_PROGRESS);
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		syncRenderedStatus(boxes[0], "/");
		cm.type(2, " typed");

		await closeParent(boxes[0]);
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(cm.doc()).toBe(
			`- [x] Lesson 2 content ✅ ${TODAY} ^l2\n\t- [x] Watch video ✅ ${TODAY}\n\t- [x] Take notes typed ✅ ${TODAY}\n`
		);
		expect(rig.app.vault.writes).toEqual([]);
	});

	it("the source opened in a pane while the dialog is showing: the subtasks go in through the editor, once", async () => {
		const [box] = await closedCourse();
		await closeParent(box);
		expect(rig.app.vault.writes).toHaveLength(1);

		// The note is opened (with its parent already closed on disk) and typed in.
		const cm = openCourseInEditor(rig, COURSE_DONE_PARENT);
		cm.type(2, " typed");
		button("Close subtasks")!.click();
		await settle();
		await settle();
		expect(rig.app.vault.writes).toHaveLength(1); // no second process call
		expect(cm.transactions).toHaveLength(1);
		expect(cm.doc()).toBe(
			`- [x] Lesson 2 content ✅ ${TODAY} ^l2\n\t- [x] Watch video ✅ ${TODAY}\n\t- [x] Take notes typed ✅ ${TODAY}\n`
		);
	});
});

describe("F1 / F9: no watcher, and an unplaceable press opens no dialog", () => {
	it("F1: a closed task written straight to disk opens no dialog and stamps nothing", async () => {
		await closedCourse();
		rig.app.vault.texts.set("Course.md", "- [x] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
		await wait(5000);
		await settle();
		expect(dialog()).toBeNull();
		expect(text()).toBe("- [x] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
		expect(rig.app.vault.writes).toEqual([]);
	});

	it("F9: a press that cannot be placed suppresses the native toggle, shows the notice and opens no dialog", async () => {
		rig = await makeRig();
		const before = rig.app.vault.texts.get("Forms.md");
		const { boxes } = rig.addEmbed("Forms#Sub", [
			[task("Read chapter 3", 0), task("Read chapter 3", 1), task("Unique in sub", 2)],
		]);
		const native = watchNative(boxes[0]);
		const evt = mouseClick(boxes[0]);
		for (let i = 0; i < 4; i++) await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(dialog()).toBeNull();
		expect(Notice.shown).toEqual([UNMAPPABLE]);
		expect(rig.app.vault.texts.get("Forms.md")).toBe(before);
	});
});
