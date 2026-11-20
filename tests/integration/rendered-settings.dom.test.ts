// @vitest-environment happy-dom
// (happy-dom, like embed-press.dom.test.ts and rendered-press.dom.test.ts.)
/**
 * G7: the four settings on a press on a rendered checkbox (an embed in Live
 * Preview), through the real code path. A real `TaskLifecyclePlugin` with its
 * real `SettingsStore` (in-memory `data.json`) on the mock app; an embed DOM
 * as Obsidian 1.15.1 draws it; real DOM events; a fake source in the mock
 * vault (`vault.process` is recorded in `vault.writes`). The one stand-in is
 * the dialog: `CloseSubtasksDialog` is a spy that answers "close".
 * The source for most cases is `tests/fixtures/embed-lesson.md` (the `^l2`
 * block of the golden path); the whole-note embed uses
 * `tests/fixtures/embed-all-statuses.md`.
 *
 * Resolution of a flip during a press (stated here, tested below): the kind
 * of a short click is read from `settings.get()` when the click is
 * dispatched, so a flip between pointerdown and the click applies to that
 * click. A hold cancels (`-`) whatever the setting is when it fires. Either
 * way one press writes once and Obsidian's native toggle never runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice } from "../__mocks__/obsidian";
import { syncRenderedStatus } from "../../src/rendered/embed-press";
import { SETTING_KEYS } from "../../src/settings/settings";
import { TOGGLE_ROWS } from "../../src/settings/settings-tab";
import { fixtureFile } from "../fixtures/source-lines";
import { matchesIconRule } from "../helpers/css-rules";
import {
	TODAY,
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
import { readingView } from "../helpers/rendered-dom";

const dialog = vi.hoisted(() => ({
	open: vi.fn(async (_count: number): Promise<"close" | "leave"> => "close"),
	closeOpen: vi.fn(),
}));

vi.mock("../../src/cascade/close-subtasks-modal", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/cascade/close-subtasks-modal")>()),
	CloseSubtasksDialog: class {
		open = dialog.open;
		closeOpen = dialog.closeOpen;
	},
}));

const LESSON = fixtureFile("embed-lesson.md");
const SUBTASKS = LESSON.slice(LESSON.indexOf("\n") + 1);
const OLD = "2026-11-01";

/** `Course.md` with line 0 as given and the fixture's two subtasks after it. */
const course = (line0: string) => `${line0}\n${SUBTASKS}`;
const lesson = (status: string, stamp = "") => `- [${status}] Lesson 2 content${stamp} ^l2`;

let rig: EmbedRig;

afterEach(() => {
	rig?.plugin.unload();
	vi.useRealTimers();
	document.body.replaceChildren();
	dialog.open.mockClear();
	dialog.closeOpen.mockClear();
});

/** An embed of `![[Course#^l2]]` whose first box shows `status`, with the source holding `line0`. */
async function lessonRig(settings: unknown, line0: string, shows: string) {
	rig = await makeRig(settings);
	rig.app.vault.texts.set("Course.md", course(line0));
	const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
	syncRenderedStatus(boxes[0], shows);
	return { boxes, native: watchNative(boxes[0]) };
}

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("G7 Status cycle: a short click on the embedded box, on and off", () => {
	type Row = [cycle: boolean, from: string, stamp: string, expected: string];
	const rows: Row[] = [
		// on: the cycle ` ` -> `/` -> `x` -> `-` -> ` `, unknown to ` `
		[true, " ", "", lesson("/")],
		[true, "/", "", lesson("x", ` ✅ ${TODAY}`)],
		[true, "x", ` ✅ ${OLD}`, lesson("-", ` ❌ ${TODAY}`)],
		[true, "X", ` ✅ ${OLD}`, lesson("-", ` ❌ ${TODAY}`)],
		[true, "-", ` ❌ ${OLD}`, lesson(" ")],
		[true, "?", "", lesson(" ")],
		// off: the plain toggle, ` ` to `x` and any other status to ` `; stamp and unstamp still follow
		[false, " ", "", lesson("x", ` ✅ ${TODAY}`)],
		[false, "/", "", lesson(" ")],
		[false, "x", ` ✅ ${OLD}`, lesson(" ")],
		[false, "X", ` ✅ ${OLD}`, lesson(" ")],
		[false, "-", ` ❌ ${OLD}`, lesson(" ")],
		[false, "?", "", lesson(" ")],
	];

	it.each(rows)(
		"Status cycle %s, [%s] -> one write by the plugin, native toggle never runs",
		async (cycle, from, stamp, expected) => {
			const { boxes, native } = await lessonRig({ statusCycle: cycle }, lesson(from, stamp), from);
			const evt = mouseClick(boxes[0]);
			expect(evt.defaultPrevented).toBe(true);
			await settle();
			expect(rig.courseText()).toBe(course(expected));
			expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
			expect(native.count()).toBe(0);
			expect(Notice.shown).toEqual([]);
		}
	);

	it("off: the rendered path still intercepts, so Obsidian's bare [x] with no stamp is never written (F9, G10)", async () => {
		const { boxes, native } = await lessonRig({ statusCycle: false }, lesson(" "), " ");
		const evt = mouseClick(boxes[0]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		const line0 = rig.courseText().split("\n")[0];
		expect(line0).toBe(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`);
		expect(line0).not.toBe("- [x] Lesson 2 content ^l2");
	});

	it("off: the stamp is placed before the block id and the subtask lines are byte-identical", async () => {
		const { boxes } = await lessonRig({ statusCycle: false }, lesson(" "), " ");
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText().slice(rig.courseText().indexOf("\n") + 1)).toBe(SUBTASKS);
	});

	it("off: Space and Enter on the focused box are the same plain toggle, once each", async () => {
		const { boxes, native } = await lessonRig({ statusCycle: false }, lesson(" "), " ");
		boxes[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, composed: true }));
		await settle();
		expect(rig.courseText()).toBe(course(lesson("x", ` ✅ ${TODAY}`)));
		// Past the swallow window, so this click is a new press and not the Enter's own.
		await wait(700);
		boxes[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail: 0 }));
		await settle();
		expect(rig.courseText()).toBe(course(lesson(" ")));
		expect(rig.app.vault.writes).toHaveLength(2);
		expect(native.count()).toBe(0);
	});
});

describe("G7 Status cycle off: a long press still cancels, and a flip during a press resolves one way", () => {
	const down = (box: Element) => pointer("pointerdown", box, { clientX: 100, clientY: 100 });
	const up = (box: Element) => pointer("pointerup", box, { clientX: 100, clientY: 100 });
	const click = (box: Element) => {
		const evt = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail: 1 });
		box.dispatchEvent(evt);
		return evt;
	};

	it.each([true, false])("Status cycle %s: a 500 ms hold writes `-` with ❌, once; the release's click is swallowed", async (cycle) => {
		const { boxes, native } = await lessonRig({ statusCycle: cycle }, lesson(" "), " ");
		down(boxes[0]);
		await wait(500);
		expect(rig.courseText()).toBe(course(lesson("-", ` ❌ ${TODAY}`)));
		up(boxes[0]);
		const after = click(boxes[0]);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(rig.app.vault.writes).toHaveLength(1);
	});

	it("a hold already running when the setting flips off still cancels, once", async () => {
		const { boxes, native } = await lessonRig({}, lesson("/"), "/");
		down(boxes[0]);
		await wait(300);
		await rig.plugin.settings.update({ statusCycle: false });
		await wait(200);
		expect(rig.courseText()).toBe(course(lesson("-", ` ❌ ${TODAY}`)));
		up(boxes[0]);
		const after = click(boxes[0]);
		await settle();
		expect(after.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
		expect(rig.app.vault.writes).toHaveLength(1);
	});

	it("a tap whose setting flips between pointerdown and the click: the click's kind is the setting at the click, one write", async () => {
		const { boxes, native } = await lessonRig({}, lesson(" "), " ");
		down(boxes[0]);
		await wait(50);
		up(boxes[0]);
		await rig.plugin.settings.update({ statusCycle: false });
		const evt = click(boxes[0]);
		await settle();
		expect(evt.defaultPrevented).toBe(true);
		// The plain toggle (off at the click), not the cycle step ` ` -> `/`.
		expect(rig.courseText()).toBe(course(lesson("x", ` ✅ ${TODAY}`)));
		expect(rig.app.vault.writes).toHaveLength(1);
		expect(native.count()).toBe(0);
	});

	it("the setting flipped back on between two taps: the second tap is the cycle again", async () => {
		const { boxes } = await lessonRig({ statusCycle: false }, lesson(" "), " ");
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course(lesson("x", ` ✅ ${TODAY}`)));
		await rig.plugin.settings.update({ statusCycle: true });
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course(lesson("-", ` ❌ ${TODAY}`)));
		expect(rig.app.vault.writes).toHaveLength(2);
	});
});

describe("G7 Close stamps: on and off, for a tick, a reopen and a hold", () => {
	type Row = [name: string, stamps: boolean, cycle: boolean, from: string, stamp: string, expected: string];
	const rows: Row[] = [
		["a tick writes the status only", false, true, "/", "", lesson("x")],
		["a tick by the plain toggle writes the status only", false, false, " ", "", lesson("x")],
		["a tick on an open task stays unstamped", false, true, "/", "", lesson("x")],
		["done -> cancelled adds no ❌ and leaves the ✅", false, true, "x", ` ✅ ${OLD}`, lesson("-", ` ✅ ${OLD}`)],
		["reopening a stamped done task leaves its ✅ alone", false, false, "x", ` ✅ ${OLD}`, lesson(" ", ` ✅ ${OLD}`)],
		["reopening a stamped cancelled task leaves its ❌ alone", false, true, "-", ` ❌ ${OLD}`, lesson(" ", ` ❌ ${OLD}`)],
		// the same transitions with stamps on, for contrast
		["a tick stamps", true, true, "/", "", lesson("x", ` ✅ ${TODAY}`)],
		["a tick by the plain toggle stamps", true, false, " ", "", lesson("x", ` ✅ ${TODAY}`)],
		["done -> cancelled swaps the stamp", true, true, "x", ` ✅ ${OLD}`, lesson("-", ` ❌ ${TODAY}`)],
		["reopening removes the ✅", true, false, "x", ` ✅ ${OLD}`, lesson(" ")],
		["reopening removes the ❌", true, true, "-", ` ❌ ${OLD}`, lesson(" ")],
	];

	it.each(rows)("%s (stamps %s, cycle %s, [%s])", async (_name, stamps, cycle, from, stamp, expected) => {
		const { boxes } = await lessonRig({ closeStamps: stamps, statusCycle: cycle }, lesson(from, stamp), from);
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course(expected));
		expect(rig.app.vault.writes).toHaveLength(1);
	});

	it("off: a hold cancels with the status only, no ❌", async () => {
		const { boxes } = await lessonRig({ closeStamps: false }, lesson(" "), " ");
		pointer("pointerdown", boxes[0], { clientX: 100, clientY: 100 });
		await wait(500);
		expect(rig.courseText()).toBe(course(lesson("-")));
	});
});

describe("G7 Close stamps and Close cascade: the cascade on an open source", () => {
	/** Close the parent (`/` by the cycle, ` ` by the plain toggle) and let the dialog's answer be applied. */
	async function closeParent(settings: Record<string, boolean>) {
		const cycle = settings.statusCycle !== false;
		const stamps = settings.closeStamps !== false;
		rig = await makeRig(settings);
		const from = cycle ? "/" : " ";
		const text = course(lesson(from));
		rig.app.vault.texts.set("Course.md", text);
		const cm = openCourseInEditor(rig, text, { closeStamps: stamps });
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		syncRenderedStatus(boxes[0], from);
		mouseClick(boxes[0]);
		for (let i = 0; i < 4; i++) await settle();
		return { cm };
	}

	const sub = (name: string, stamp: string) => `\t- [x] ${name}${stamp}`;

	it.each([
		[true, true],
		[true, false],
		[false, true],
		[false, false],
	])(
		"Close cascade on, cycle %s, stamps %s: the dialog asks about 2 subtasks; \"Close subtasks\" closes them, with the stamp only if stamps are on",
		async (cycle, stamps) => {
			const { cm } = await closeParent({ statusCycle: cycle, closeStamps: stamps });
			expect(dialog.open).toHaveBeenCalledTimes(1);
			expect(dialog.open).toHaveBeenCalledWith(2);
			const stamp = stamps ? ` ✅ ${TODAY}` : "";
			expect(cm.doc()).toBe(
				[lesson("x", stamp), sub("Watch video", stamp), sub("Take notes", stamp), ""].join("\n")
			);
			if (!stamps) expect(cm.doc()).not.toMatch(/[✅❌]/);
		}
	);

	it.each([true, false])(
		"Close cascade off, cycle %s: the parent is written alone, no dialog opens, the subtasks are untouched",
		async (cycle) => {
			const { cm } = await closeParent({ statusCycle: cycle, closeCascade: false });
			expect(dialog.open).not.toHaveBeenCalled();
			expect(cm.doc()).toBe(course(lesson("x", ` ✅ ${TODAY}`)));
		}
	);

	it.each([true, false])(
		"Close cascade off, cycle %s, source closed: the parent only is written (one vault.process), no dialog",
		async (cycle) => {
			const from = cycle ? "/" : " ";
			const { boxes } = await lessonRig({ statusCycle: cycle, closeCascade: false }, lesson(from), from);
			mouseClick(boxes[0]);
			for (let i = 0; i < 4; i++) await settle();
			expect(dialog.open).not.toHaveBeenCalled();
			expect(rig.courseText()).toBe(course(lesson("x", ` ✅ ${TODAY}`)));
			expect(rig.app.vault.writes).toEqual(["process:Course.md"]);
		}
	);
});

describe("G7 Checkbox icons: the class on <body> decides, boxes already on screen follow at once", () => {
	const GLYPH = new Set(["-", "/"]);
	const STATUSES = [" ", "/", "x", "X", "-", "?"];

	/** An embed whose items show `STATUSES`, one box each. */
	function boxesOf(sections: ReturnType<EmbedRig["addEmbed"]>["boxes"]) {
		STATUSES.forEach((s, i) => syncRenderedStatus(sections[i], s));
		return sections;
	}

	it("on: [-] and [/] are drawn as glyphs with no native box, [x] [X] [ ] and [?] are not restyled", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [STATUSES.map((_, i) => task(`Item ${i}`, i))]);
		boxesOf(boxes);
		expect(document.body.classList.contains("task-lifecycle-checkboxes")).toBe(true);
		for (const [i, s] of STATUSES.entries()) expect(matchesIconRule(boxes[i]), `[${s}]`).toBe(GLYPH.has(s));
	});

	it.each(["theme-dark", "theme-light"])("%s: the rules do not depend on the theme class", async (theme) => {
		rig = await makeRig();
		document.body.classList.add(theme);
		const { boxes } = rig.addEmbed("Course#^l2", [[task("A", 0), task("B", 1)]]);
		syncRenderedStatus(boxes[0], "-");
		syncRenderedStatus(boxes[1], "/");
		expect(boxes.map(matchesIconRule)).toEqual([true, true]);
	});

	it("off: with the class absent no icon rule reaches any box, so the theme's own look applies", async () => {
		rig = await makeRig({ checkboxIcons: false });
		const { boxes } = rig.addEmbed("Course#^l2", [STATUSES.map((_, i) => task(`Item ${i}`, i))]);
		boxesOf(boxes);
		expect(document.body.classList.contains("task-lifecycle-checkboxes")).toBe(false);
		expect(boxes.map(matchesIconRule)).toEqual(STATUSES.map(() => false));
		const reading = readingView([[task("A", 0)]]);
		document.body.append(reading.el);
		syncRenderedStatus(reading.boxes[0], "-");
		expect(matchesIconRule(reading.boxes[0])).toBe(false);
	});

	it("two embeds of the same block, and a Reading view, all follow a flip at the moment it happens, with no re-render", async () => {
		rig = await makeRig();
		const a = rig.addEmbed("Course#^l2", [lessonSection()]);
		const b = rig.addEmbed("Course#^l2", [lessonSection()]);
		const reading = readingView([[task("Lesson 2 content ", 0)]]);
		document.body.append(reading.el);
		const watched = [a.boxes[0], b.boxes[0], reading.boxes[0]];
		for (const box of watched) syncRenderedStatus(box, "/");
		const lis = watched.map((box) => box.closest("li"));
		expect(watched.map(matchesIconRule)).toEqual([true, true, true]);

		await rig.plugin.settings.update({ checkboxIcons: false });
		expect(watched.map(matchesIconRule)).toEqual([false, false, false]);

		await rig.plugin.settings.update({ checkboxIcons: true });
		expect(watched.map(matchesIconRule)).toEqual([true, true, true]);
		// The very same nodes: nothing was re-rendered.
		expect(watched.map((box) => box.closest("li"))).toEqual(lis);
		expect(a.el.isConnected && b.el.isConnected).toBe(true);
	});

	it("an embed of a whole note with every status renders each as the rules say, and a click advances each from its own status", async () => {
		rig = await makeRig();
		const text = fixtureFile("embed-all-statuses.md");
		const lines = text.split("\n");
		rig.app.addNote("All.md", text, {
			listItems: lines.filter(Boolean).map((_, i) => ({
				position: { start: { line: i }, end: { line: i } },
				parent: -1,
			})),
		});
		const names = ["Open task", "In progress task", "Done task ", "Capital done task ", "Cancelled task ", "Unknown task"];
		const { boxes } = rig.addEmbed("All", [names.map((n, i) => task(n, i))]);
		boxesOf(boxes);
		expect(boxes.map(matchesIconRule)).toEqual(STATUSES.map((s) => GLYPH.has(s)));

		const expected = [
			"- [/] Open task",
			`- [x] In progress task ✅ ${TODAY}`,
			`- [-] Done task ❌ ${TODAY}`,
			`- [-] Capital done task ❌ ${TODAY}`,
			"- [ ] Cancelled task",
			"- [ ] Unknown task",
		];
		for (const [i, box] of boxes.entries()) {
			mouseClick(box);
			await settle();
			expect(rig.app.vault.texts.get("All.md")!.split("\n")[i], `[${STATUSES[i]}]`).toBe(expected[i]);
		}
		expect(Notice.shown).toEqual([]);
	});

	it("an unknown status such as [?] is left alone by the icon rules and cycles to a space on a click", async () => {
		const { boxes } = await lessonRig({}, lesson("?"), "?");
		expect(matchesIconRule(boxes[0])).toBe(false);
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course(lesson(" ")));
	});
});

describe("G7 a corrupt or missing data.json: all four on, and the rendered path works", () => {
	it.each<[string, unknown]>([
		["missing", undefined],
		["null", null],
		["a string", "not json {"],
		["a number", 42],
		["an array", [true, false]],
		["wrong types", { statusCycle: "no", closeStamps: 0, closeCascade: null, checkboxIcons: [] }],
	])("%s", async (_name, data) => {
		rig = await makeRig(data);
		expect(rig.plugin.settings.get()).toEqual({
			statusCycle: true,
			closeStamps: true,
			closeCascade: true,
			checkboxIcons: true,
		});
		expect(document.body.classList.contains("task-lifecycle-checkboxes")).toBe(true);
		rig.app.vault.texts.set("Course.md", course(lesson(" ")));
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		await settle();
		mouseClick(boxes[0]);
		await settle();
		expect(rig.courseText()).toBe(course(lesson("x", ` ✅ ${TODAY}`)));
	});
});

describe("F2: no new settings, commands or hotkeys from embed handling", () => {
	it("the saved data.json has only the four booleans after presses and flips of every setting", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		await settle();
		for (const key of SETTING_KEYS) await rig.plugin.settings.update({ [key]: false });
		mouseClick(boxes[0]);
		await settle();
		const saved = rig.plugin.dataFile as Record<string, unknown>;
		expect(Object.keys(saved).sort()).toEqual([...SETTING_KEYS].sort());
		expect(Object.values(saved).every((v) => typeof v === "boolean")).toBe(true);
	});

	it("SETTING_KEYS and TOGGLE_ROWS are the same four, in the same order", () => {
		expect([...SETTING_KEYS]).toEqual(["statusCycle", "closeStamps", "closeCascade", "checkboxIcons"]);
		expect(TOGGLE_ROWS.map((r) => r.key)).toEqual([...SETTING_KEYS]);
		expect(TOGGLE_ROWS.map((r) => r.name)).toEqual([
			"Status cycle",
			"Close stamps",
			"Close cascade",
			"Checkbox icons",
		]);
	});

	it("loading registers no command and one settings tab; a press adds none", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		mouseClick(boxes[0]);
		await settle();
		const addCommand = (rig.plugin as unknown as { addCommand: { mock: { calls: unknown[] } } }).addCommand;
		expect(addCommand.mock.calls).toEqual([]);
		expect((rig.plugin as unknown as { settingTabs: unknown[] }).settingTabs).toHaveLength(1);
	});
});
