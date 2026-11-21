// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskLifecyclePlugin from "../../src/main";
import { STATUS_CHANGED_EVENT } from "../../src/events/event-bus";
import { syncRenderedStatus } from "../../src/rendered/embed-press";
import { fixtureFile } from "../fixtures/source-lines";
import {
	TODAY,
	lessonSection,
	makeRig,
	mouseClick,
	openCourseInEditor,
	settle,
	watchNative,
	type EmbedRig,
} from "../helpers/embed-rig";

const dialog = vi.hoisted(() => ({ open: vi.fn(async (_count: number): Promise<"close" | "leave"> => "leave") }));

// The cascade dialog is PR-6's; here it is a spy that answers "Leave open".
vi.mock("../../src/cascade/close-subtasks-modal", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/cascade/close-subtasks-modal")>()),
	CloseSubtasksDialog: class {
		open = dialog.open;
		closeOpen = vi.fn();
	},
}));

type MockedPlugin = TaskLifecyclePlugin & {
	dataFile: unknown;
	editorExtensions: Extension[];
};

/** The real plugin (through the mock `obsidian`), loaded, with its registered editor extension. */
async function loadPlugin(dataFile?: unknown) {
	const plugin = new (TaskLifecyclePlugin as unknown as new () => MockedPlugin)();
	plugin.dataFile = dataFile;
	await plugin.onload();
	const received: Array<{ line: number; from: string; to: string }> = [];
	plugin.events.on(STATUS_CHANGED_EVENT, (e) => received.push({ line: e.line, from: e.from, to: e.to }));
	let state = EditorState.create({
		doc: "- [ ] Call caterer\n- [x] Old task ✅ 2026-11-01\n- [ ] Later",
		extensions: plugin.editorExtensions,
	});
	const type = (n: number, c: string) => {
		const line = state.doc.line(n + 1);
		const p = line.from + line.text.indexOf("[") + 1;
		state = state.update({ changes: { from: p, to: p + 1, insert: c }, userEvent: "input.type" }).state;
	};
	return { plugin, received, type, doc: () => state.doc.toString() };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 10, 9, 12));
	document.body.className = "";
});
afterEach(() => {
	vi.useRealTimers();
	document.body.className = "";
});

describe("plugin wiring", () => {
	it("registers exactly one editor extension on load", async () => {
		const { plugin } = await loadPlugin();
		expect(plugin.editorExtensions).toHaveLength(1);
	});

	it("unload drops the bus handlers", async () => {
		const { plugin } = await loadPlugin();
		const handler = vi.fn();
		plugin.events.on(STATUS_CHANGED_EVENT, handler);
		plugin.onunload();
		plugin.events.emit(STATUS_CHANGED_EVENT, { file: null, line: 0, lineText: "", from: " ", to: "x" });
		expect(handler).not.toHaveBeenCalled();
	});
});

describe("G20: Close stamps toggled at runtime on the same editor state", () => {
	it("on: stamps and events", async () => {
		const { type, doc, received } = await loadPlugin();
		type(0, "x");
		expect(doc().split("\n")[0]).toBe("- [x] Call caterer ✅ 2026-11-09");
		expect(received).toEqual([{ line: 0, from: " ", to: "x" }]);
	});

	it("GP8: off, [ ] -> [x] stays unstamped but the event still fires", async () => {
		const { plugin, type, doc, received } = await loadPlugin({ closeStamps: false });
		type(0, "x");
		expect(doc().split("\n")[0]).toBe("- [x] Call caterer");
		expect(received).toEqual([{ line: 0, from: " ", to: "x" }]);
		expect(plugin.settings.get().closeStamps).toBe(false);
	});

	it("off: no stamp is added, swapped or removed on any transition", async () => {
		const { plugin, type, doc, received } = await loadPlugin();
		await plugin.settings.update({ closeStamps: false });
		type(0, "-"); // open -> cancelled: nothing added
		type(1, " "); // done -> open: existing stamp stays
		type(2, "/");
		type(2, "x");
		expect(doc()).toBe("- [-] Call caterer\n- [ ] Old task ✅ 2026-11-01\n- [x] Later");
		expect(received.map((e) => [e.line, e.from, e.to])).toEqual([
			[0, " ", "-"],
			[1, "x", " "],
			[2, " ", "/"],
			[2, "/", "x"],
		]);
	});

	it("flipped on and off on the same state, with no retroactive stamping", async () => {
		const { plugin, type, doc, received } = await loadPlugin();
		await plugin.settings.update({ closeStamps: false });
		type(0, "x");
		expect(doc().split("\n")[0]).toBe("- [x] Call caterer");

		await plugin.settings.update({ closeStamps: true });
		// Turning it back on touches nothing...
		expect(doc().split("\n")[0]).toBe("- [x] Call caterer");
		// ...and neither does a same-kind change (x -> X) on that line.
		type(0, "X");
		expect(doc().split("\n")[0]).toBe("- [X] Call caterer");
		// A later real transition stamps again.
		type(2, "x");
		expect(doc().split("\n")[2]).toBe("- [x] Later ✅ 2026-11-09");

		await plugin.settings.update({ closeStamps: false });
		type(2, " ");
		expect(doc().split("\n")[2]).toBe("- [ ] Later ✅ 2026-11-09");
		expect(received).toHaveLength(4);
	});
});

describe("G7: each toggle flipped between two presses on a rendered box, on one loaded plugin", () => {
	const LESSON = fixtureFile("embed-lesson.md");
	const SUBTASKS = LESSON.slice(LESSON.indexOf("\n") + 1);
	const course = (line0: string) => `${line0}\n${SUBTASKS}`;
	let rig: EmbedRig;

	afterEach(() => {
		rig?.plugin.unload();
		dialog.open.mockClear();
		document.body.replaceChildren();
	});

	/** Press the box once and let the write and any dialog run. */
	async function press(box: HTMLInputElement, shows: string) {
		syncRenderedStatus(box, shows);
		const native = watchNative(box);
		const evt = mouseClick(box);
		for (let i = 0; i < 4; i++) await settle();
		expect(evt.defaultPrevented).toBe(true);
		expect(native.count()).toBe(0);
	}

	it("Status cycle: on gives the cycle step, off the plain toggle, on again the cycle step", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		await press(boxes[0], " ");
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2")); // cycle: ` ` -> `/`
		await rig.plugin.settings.update({ statusCycle: false });
		await press(boxes[0], "/");
		expect(rig.courseText()).toBe(course("- [ ] Lesson 2 content ^l2")); // toggle: `/` -> ` `
		await rig.plugin.settings.update({ statusCycle: true });
		await press(boxes[0], " ");
		expect(rig.courseText()).toBe(course("- [/] Lesson 2 content ^l2")); // cycle again
		expect(rig.app.vault.writes).toHaveLength(3);
	});

	it("Close stamps: off gives an unstamped tick, on stamps the next one, off again leaves the stamp when reopening", async () => {
		rig = await makeRig({ statusCycle: false, closeStamps: false });
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		await press(boxes[0], " ");
		expect(rig.courseText()).toBe(course("- [x] Lesson 2 content ^l2"));
		await rig.plugin.settings.update({ closeStamps: true });
		await press(boxes[0], "x"); // reopen
		await press(boxes[0], " "); // tick again, now stamped
		expect(rig.courseText()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));
		await rig.plugin.settings.update({ closeStamps: false });
		await press(boxes[0], "x"); // reopen: the stamp stays
		expect(rig.courseText()).toBe(course(`- [ ] Lesson 2 content ✅ ${TODAY} ^l2`));
	});

	it("Close cascade: off writes the parent alone with no dialog, then on asks on the next close", async () => {
		rig = await makeRig({ statusCycle: false, closeCascade: false });
		const text = course("- [ ] Lesson 2 content ^l2");
		rig.app.vault.texts.set("Course.md", text);
		const cm = openCourseInEditor(rig, text);
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);

		await press(boxes[0], " "); // close, cascade off
		expect(dialog.open).not.toHaveBeenCalled();
		expect(cm.doc()).toBe(course(`- [x] Lesson 2 content ✅ ${TODAY} ^l2`));

		await rig.plugin.settings.update({ closeCascade: true });
		await press(boxes[0], "x"); // reopen: no cascade for a reopen
		expect(dialog.open).not.toHaveBeenCalled();
		await press(boxes[0], " "); // close again, cascade on
		expect(dialog.open).toHaveBeenCalledTimes(1);
		expect(dialog.open).toHaveBeenCalledWith(2);
	});

	it("Checkbox icons: the body class follows each flip while the same plugin and the same box stay loaded", async () => {
		rig = await makeRig();
		const { boxes } = rig.addEmbed("Course#^l2", [lessonSection()]);
		const has = () => document.body.classList.contains("task-lifecycle-checkboxes");
		expect(has()).toBe(true);
		await rig.plugin.settings.update({ checkboxIcons: false });
		expect(has()).toBe(false);
		await press(boxes[0], " ");
		await rig.plugin.settings.update({ checkboxIcons: true });
		expect(has()).toBe(true);
		expect(document.head.innerHTML).toBe("");
	});

	it("unloading the plugin removes the body class and leaves nothing in <head>", async () => {
		rig = await makeRig();
		const head = document.head.innerHTML;
		expect(document.body.classList.contains("task-lifecycle-checkboxes")).toBe(true);
		rig.plugin.unload();
		expect(document.body.classList.contains("task-lifecycle-checkboxes")).toBe(false);
		expect(document.head.innerHTML).toBe(head);
		expect(document.head.querySelector("style, link")).toBeNull();
	});
});
