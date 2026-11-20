// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskLifecyclePlugin from "../../src/main";
import { CHECKBOX_ICONS_CLASS } from "../../src/settings/checkbox-icons";
import { TaskLifecycleSettingTab } from "../../src/settings/settings-tab";
import type { MockElement, Setting } from "../__mocks__/obsidian";

/** `new TaskLifecyclePlugin()` through the mock `obsidian` module. */
function makePlugin(dataFile?: unknown) {
	const plugin = new (TaskLifecyclePlugin as unknown as new () => TaskLifecyclePlugin & {
		dataFile: unknown;
		addCommand: ReturnType<typeof vi.fn>;
		settingTabs: unknown[];
	})();
	plugin.dataFile = dataFile;
	return plugin;
}

const has = () => document.body.classList.contains(CHECKBOX_ICONS_CLASS);

beforeEach(() => {
	document.body.className = "";
});
afterEach(() => {
	document.body.className = "";
	vi.restoreAllMocks();
});

describe("plugin.resolveRenderedTask (the console entry point)", () => {
	it("is a read-only method, and adds no command", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		const box = document.createElement("input");
		box.type = "checkbox";
		box.className = "task-list-item-checkbox";
		document.body.append(box);
		// Outside every Markdown view and embed: not our surface, and no throw.
		await expect(plugin.resolveRenderedTask(box)).resolves.toEqual({
			notIntercepted: "editor-checkbox",
		});
		const { addCommand } = plugin as unknown as { addCommand: ReturnType<typeof vi.fn> };
		expect(addCommand).not.toHaveBeenCalled();
		box.remove();
	});
});

describe("plugin.sourceWriter", () => {
	it("is null before load, created by load, disposed and cleared by unload, and a second load works", async () => {
		const plugin = makePlugin();
		expect(plugin.sourceWriter).toBeNull();

		await plugin.onload();
		const first = plugin.sourceWriter;
		expect(first).not.toBeNull();
		expect(typeof first?.press).toBe("function");
		const dispose = vi.spyOn(first!, "dispose");

		plugin.onunload();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(plugin.sourceWriter).toBeNull();
		// A writer that was disposed does nothing, even if something kept a reference.
		const dropped = await first!.press({ path: "Course.md" } as never, 0, "click");
		expect(dropped).toEqual({ status: "skipped", reason: "disposed" });

		const again = makePlugin(plugin.dataFile);
		await again.onload();
		expect(again.sourceWriter).not.toBeNull();
		expect(again.sourceWriter).not.toBe(first);
		again.onunload();
		expect(again.sourceWriter).toBeNull();
	});

	it("unload while settings are still loading leaves no writer", async () => {
		const plugin = makePlugin();
		const loading = plugin.onload();
		plugin.onunload();
		await loading;
		expect(plugin.sourceWriter).toBeNull();
	});

	it("writes through the plugin's own app and settings: a press on a closed note stamps it", async () => {
		const plugin = makePlugin();
		const app = plugin.app as unknown as { vault: Record<string, unknown> };
		const texts = new Map([["Course.md", "- [/] Lesson 2 content ^l2\n"]]);
		app.vault.process = async (f: { path: string }, fn: (d: string) => string) => {
			const next = fn(texts.get(f.path) ?? "");
			texts.set(f.path, next);
			return next;
		};
		await plugin.onload();

		await plugin.sourceWriter!.press({ path: "Course.md" } as never, 0, "click");
		expect(texts.get("Course.md")).toMatch(/^- \[x\] Lesson 2 content ✅ \d{4}-\d{2}-\d{2} \^l2\n$/);

		// Close stamps off is read at write time.
		await plugin.settings.update({ closeStamps: false });
		texts.set("Course.md", "- [/] Lesson 2 content ^l2\n");
		await plugin.sourceWriter!.press({ path: "Course.md" } as never, 0, "click");
		expect(texts.get("Course.md")).toBe("- [x] Lesson 2 content ^l2\n");
		plugin.onunload();
	});
});

describe("plugin lifecycle (settings part)", () => {
	it("fresh vault: all four on, class set, one settings tab, no commands", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		expect(plugin.settings.get()).toEqual({
			statusCycle: true,
			closeStamps: true,
			closeCascade: true,
			checkboxIcons: true,
		});
		expect(has()).toBe(true);
		expect(plugin.settingTabs).toHaveLength(1);
		expect(plugin.settingTabs[0]).toBeInstanceOf(TaskLifecycleSettingTab);
		const { addCommand } = plugin as unknown as { addCommand: ReturnType<typeof vi.fn> };
		expect(addCommand).not.toHaveBeenCalled();
	});

	it.each([[null], [[]], ["junk"], [42]])(
		"loads with defaults and doesn't throw when data.json holds %j",
		async (raw) => {
			const plugin = makePlugin(raw);
			await expect(plugin.onload()).resolves.toBeUndefined();
			expect(plugin.settings.get().checkboxIcons).toBe(true);
			expect(has()).toBe(true);
		}
	);

	it("a toggle change in the tab is saved to data.json and applied without reload", async () => {
		const plugin = makePlugin({ useBundledCheckboxes: true });
		await plugin.onload();
		const tab = plugin.settingTabs[0] as TaskLifecycleSettingTab;
		tab.display();
		const rows = (tab.containerEl as unknown as MockElement).children as Setting[];

		rows[3].toggle?.flip(false); // Checkbox icons
		expect(has()).toBe(false);
		await new Promise((r) => setTimeout(r, 0));
		expect(plugin.dataFile).toEqual({
			statusCycle: true,
			closeStamps: true,
			closeCascade: true,
			checkboxIcons: false,
		});
	});

	it("unload removes the class and clears subscribers; re-enable restores it from data.json", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		const listener = vi.fn();
		plugin.settings.subscribe(listener);

		plugin.onunload();
		expect(has()).toBe(false);
		await plugin.settings.update({ closeStamps: false });
		expect(listener).not.toHaveBeenCalled();

		// Re-enable: a new plugin instance reads the saved file.
		const again = makePlugin(plugin.dataFile);
		await again.onload();
		expect(has()).toBe(true);
		expect(again.settings.get().closeStamps).toBe(false);
	});

	it("off, unload, on again with icons off doesn't add the class", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		await plugin.settings.update({ checkboxIcons: false });
		plugin.onunload();
		expect(has()).toBe(false);

		const again = makePlugin(plugin.dataFile);
		await again.onload();
		expect(has()).toBe(false);
	});

	it("unload before load finished doesn't throw", () => {
		const plugin = makePlugin();
		expect(() => plugin.onunload()).not.toThrow();
	});

	it("unload while settings are still loading wires nothing afterwards", async () => {
		const plugin = makePlugin();
		const loading = plugin.onload(); // parked on `await settings.load()`
		plugin.onunload();
		await loading;

		expect(has()).toBe(false);
		expect(plugin.settingTabs).toHaveLength(0);
		// Nothing subscribed: a settings change reaches no listener and no icons class appears.
		await plugin.settings.update({ checkboxIcons: true });
		expect(has()).toBe(false);
	});
});
