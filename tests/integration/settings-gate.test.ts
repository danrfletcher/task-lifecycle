// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskLifecyclePlugin from "../../src/main";
import { STATUS_CHANGED_EVENT } from "../../src/events/event-bus";

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
