// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskLifecyclePlugin from "../../src/main";
import { STATUS_CHANGED_EVENT } from "../../src/events/event-bus";
import { CHECKBOX_ICONS_CLASS } from "../../src/settings/checkbox-icons";
import { Modal, type App, type MockElement, type Setting } from "../__mocks__/obsidian";
import type { TaskLifecycleSettingTab } from "../../src/settings/settings-tab";

/** A minimal editor over a line array that records `transaction` calls. */
class FakeEditor {
	transactions: unknown[] = [];
	constructor(public lines: string[]) {}
	lineCount() {
		return this.lines.length;
	}
	getLine(n: number) {
		return this.lines[n];
	}
	transaction(tx: { changes?: Array<{ from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }> }) {
		this.transactions.push(tx);
		for (const c of tx.changes ?? []) {
			const line = this.lines[c.from.line];
			this.lines[c.from.line] = line.slice(0, c.from.ch) + c.text + line.slice((c.to ?? c.from).ch);
		}
	}
}

const FILE = { path: "Scratch/lifecycle-demo.md" };

type TestPlugin = TaskLifecyclePlugin & { app: App; unload(): void };

function makePlugin(lines: string[], data?: unknown) {
	const plugin = new (TaskLifecyclePlugin as unknown as new () => TestPlugin & { dataFile: unknown })();
	plugin.dataFile = data;
	const editor = new FakeEditor(lines);
	(plugin.app.workspace as { leaves: unknown[] }).leaves = [{ view: { file: FILE, editor } }];
	return { plugin, editor };
}

const closeParent = (plugin: TestPlugin, line: number, lineText: string) =>
	plugin.events.emit(STATUS_CHANGED_EVENT, { file: FILE as never, line, lineText, from: " ", to: "x" });

const tick = () => new Promise((r) => setTimeout(r, 0));
const containers = () => document.querySelectorAll(".modal-container");
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-container button"));

const PARENT = "- [x] p ✅ 2026-11-09";

beforeEach(() => {
	document.body.className = "";
	document.body.innerHTML = "";
	Modal.openModals = [];
});
afterEach(() => {
	for (const m of [...Modal.openModals]) m.close();
	document.body.className = "";
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("cascade through the plugin", () => {
	it("a close event opens the dialog; Close subtasks writes one transaction", async () => {
		const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a", "\t- [ ] b"]);
		await plugin.onload();
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(1);
		expect(document.querySelector(".modal-container p")?.textContent).toBe(
			"This task has 2 open subtasks."
		);
		buttons()[0].click();
		await tick();
		expect(containers()).toHaveLength(0);
		expect(editor.transactions).toHaveLength(1);
		expect(editor.lines[1]).toMatch(/^\t- \[x\] a ✅ \d{4}-\d{2}-\d{2}$/);
		expect(editor.lines[2]).toMatch(/^\t- \[x\] b ✅ \d{4}-\d{2}-\d{2}$/);
	});

	it("Leave open changes nothing", async () => {
		const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		closeParent(plugin, 0, "- [x] p");
		await tick();
		buttons()[1].click();
		await tick();
		expect(editor.transactions).toHaveLength(0);
		expect(editor.lines).toEqual([PARENT, "\t- [ ] a"]);
	});

	it("E6: a second parent closed while the dialog is open replaces it; nothing is left behind", async () => {
		const { plugin, editor } = makePlugin([
			PARENT,
			"\t- [ ] a",
			"- [x] q ✅ 2026-11-09",
			"\t- [ ] b",
			"\t- [ ] c",
		]);
		await plugin.onload();
		closeParent(plugin, 0, "- [x] p");
		closeParent(plugin, 2, "- [x] q");
		await tick();
		expect(containers()).toHaveLength(1);
		expect(document.querySelector(".modal-container p")?.textContent).toBe(
			"This task has 2 open subtasks."
		);
		expect(Modal.openModals).toHaveLength(1);
		buttons()[1].click();
		await tick();
		expect(containers()).toHaveLength(0);
		expect(Modal.openModals).toHaveLength(0);
		expect(editor.transactions).toHaveLength(0);
	});

	it("E12: unloading with the dialog open closes it with no edit and stops listening", async () => {
		const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		expect(document.body.classList.contains(CHECKBOX_ICONS_CLASS)).toBe(true);
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(1);

		plugin.unload();
		await tick();
		expect(containers()).toHaveLength(0);
		expect(editor.transactions).toHaveLength(0);
		expect(document.body.classList.contains(CHECKBOX_ICONS_CLASS)).toBe(false);

		// A later close does nothing, even through a bus handler that was left behind.
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(0);
	});

	it("E12: unloading removes the cascade's own status-changed listener", async () => {
		const { plugin } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		const handlers = () =>
			(plugin.events as unknown as { handlers: Map<string, unknown[]> }).handlers.get(
				STATUS_CHANGED_EVENT
			)?.length ?? 0;
		expect(handlers()).toBe(1);
		// Stop the bus from clearing itself, so only the cascade's own unsubscribe counts.
		plugin.events.clear = () => undefined;
		plugin.onunload();
		expect(handlers()).toBe(0);
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(0);
	});

	it("G14: turning Close cascade off closes the dialog as Leave open", async () => {
		const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(1);

		await plugin.settings.update({ closeCascade: false });
		await tick();
		expect(containers()).toHaveLength(0);
		expect(editor.transactions).toHaveLength(0);

		// And with it off no dialog opens for a close.
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(0);
	});

	it("C36: the Close cascade toggle in the plugin's settings tab stops the dialog opening", async () => {
		const { plugin, editor } = makePlugin([PARENT, "	- [ ] a", "	- [ ] b"]);
		await plugin.onload();

		// The tab main.ts registered, drawn as Obsidian does when Settings opens it.
		const tab = (plugin as unknown as { settingTabs: TaskLifecycleSettingTab[] }).settingTabs[0];
		tab.display();
		const row = (tab.containerEl as unknown as MockElement).children.find(
			(r: unknown) => (r as Setting).name === "Close cascade"
		) as Setting;
		expect(row.toggle?.value).toBe(true);

		// Click the toggle off, as in Settings → Task Lifecycle.
		row.toggle?.flip(false);
		await tick();
		expect(plugin.settings.get().closeCascade).toBe(false);

		// Off: closing the parent shows no dialog and writes nothing.
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(0);
		expect(editor.transactions).toHaveLength(0);

		// Control: the same close event opens the dialog once the toggle is back on.
		row.toggle?.flip(true);
		await tick();
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(1);
	});

	it("G14: stamps toggled off while the dialog is open: it stays and the cascade adds no emoji", async () => {
		const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		closeParent(plugin, 0, "- [x] p");
		await tick();
		await plugin.settings.update({ closeStamps: false });
		expect(containers()).toHaveLength(1);
		buttons()[0].click();
		await tick();
		expect(editor.lines[1]).toBe("\t- [x] a");
	});

	it.each(["active-leaf-change", "file-open"])(
		"G14: %s (switching or closing the note) closes the dialog as Leave open",
		async (name) => {
			const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a"]);
			await plugin.onload();
			closeParent(plugin, 0, "- [x] p");
			await tick();
			expect(containers()).toHaveLength(1);
			plugin.app.workspace.trigger(name);
			await tick();
			expect(containers()).toHaveLength(0);
			expect(editor.transactions).toHaveLength(0);
		}
	);

	it("G8: the dialog's own note shown by file-open or active-leaf-change keeps the dialog; another note closes it", async () => {
		const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(1);

		plugin.app.workspace.trigger("file-open", FILE);
		plugin.app.workspace.trigger("active-leaf-change", { view: { file: FILE, editor } });
		await tick();
		expect(containers()).toHaveLength(1);

		// Unsaved typing in the editor survives the apply: it goes in as an editor transaction.
		editor.lines.push("typed, not saved");
		buttons()[0].click();
		await tick();
		expect(containers()).toHaveLength(0);
		expect(editor.transactions).toHaveLength(1);
		expect(editor.lines[1]).toMatch(/^\t- \[x\] a ✅ \d{4}-\d{2}-\d{2}$/);
		expect(editor.lines[2]).toBe("typed, not saved");
	});

	it.each([
		["file-open", [{ path: "Other.md" }]],
		["active-leaf-change", [{ view: { file: { path: "Other.md" } } }]],
		["active-leaf-change", [null]],
		["active-leaf-change", [{ view: {} }]],
	])("G14: %s showing another note or none (%j) closes the dialog", async (name, args) => {
		const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		closeParent(plugin, 0, "- [x] p");
		await tick();
		expect(containers()).toHaveLength(1);
		plugin.app.workspace.trigger(name, ...args);
		await tick();
		expect(containers()).toHaveLength(0);
		expect(editor.transactions).toHaveLength(0);
	});

	it("the dialog is not closed by workspace events after unload registered them away", async () => {
		const { plugin } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		plugin.unload();
		expect(() => plugin.app.workspace.trigger("active-leaf-change")).not.toThrow();
	});

	it("an editor for another note is not written to", async () => {
		const { plugin, editor } = makePlugin([PARENT, "\t- [ ] a"]);
		await plugin.onload();
		closeParent(plugin, 0, "- [x] p");
		await tick();
		// The note under the dialog is replaced by a different one.
		(plugin.app.workspace as { leaves: unknown[] }).leaves = [
			{ view: { file: { path: "Other.md" }, editor: new FakeEditor(["x"]) } },
		];
		buttons()[0].click();
		await tick();
		expect(editor.transactions).toHaveLength(0);
	});
});
