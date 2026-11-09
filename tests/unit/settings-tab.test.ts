import { describe, expect, it, vi } from "vitest";
import { App, MockElement, Setting } from "../__mocks__/obsidian";
import type { App as ObsidianApp, Plugin } from "obsidian";
import { SettingsStore, type TaskLifecycleSettings } from "../../src/settings/settings";
import { TaskLifecycleSettingTab } from "../../src/settings/settings-tab";

async function setup(initial?: unknown) {
	const saves: TaskLifecycleSettings[] = [];
	const store = new SettingsStore({
		loadData: async () => initial ?? null,
		saveData: async (data) => {
			saves.push(JSON.parse(JSON.stringify(data)) as TaskLifecycleSettings);
		},
	});
	await store.load();
	const tab = new TaskLifecycleSettingTab(
		new App() as unknown as ObsidianApp,
		{} as Plugin,
		store
	);
	const el = tab.containerEl as unknown as MockElement;
	return { store, tab, el, saves };
}

const rows = (el: MockElement) => el.children as Setting[];

describe("TaskLifecycleSettingTab.display", () => {
	it("creates four rows with the names, in order, each with a one-line description", async () => {
		const { tab, el } = await setup();
		tab.display();
		expect(rows(el).map((r) => r.name)).toEqual([
			"Status cycle",
			"Close stamps",
			"Close cascade",
			"Checkbox icons",
		]);
		for (const row of rows(el)) {
			expect(row.desc.length).toBeGreaterThan(0);
			expect(row.desc).not.toMatch(/\n/);
			expect(row.toggleCount).toBe(1);
		}
	});

	it("shows all four on in a fresh vault", async () => {
		const { tab, el } = await setup();
		tab.display();
		expect(rows(el).map((r) => r.toggle?.value)).toEqual([true, true, true, true]);
	});

	it("shows stored values", async () => {
		const { tab, el } = await setup({ closeStamps: false, checkboxIcons: false });
		tab.display();
		expect(rows(el).map((r) => r.toggle?.value)).toEqual([true, false, true, false]);
	});

	it("display() twice gives four rows, not eight", async () => {
		const { tab, el } = await setup();
		tab.display();
		tab.display();
		expect(rows(el)).toHaveLength(4);
	});

	it("redraws from the stored values when reopened, not the old toggle state", async () => {
		const { tab, el, store } = await setup();
		tab.display();
		await store.update({ closeCascade: false });
		tab.display();
		expect(rows(el).map((r) => r.toggle?.value)).toEqual([true, true, false, true]);
	});

	it("has no text or dropdown inputs (the mock throws if one is added)", async () => {
		const { tab } = await setup();
		expect(() => tab.display()).not.toThrow();
	});
});

describe("toggle onChange", () => {
	it.each([
		[0, "statusCycle"],
		[1, "closeStamps"],
		[2, "closeCascade"],
		[3, "checkboxIcons"],
	] as const)("row %i updates the store and saves once (%s)", async (index, key) => {
		const { tab, el, store, saves } = await setup();
		tab.display();
		const listener = vi.fn();
		store.subscribe(listener);

		rows(el)[index].toggle?.flip(false);
		await Promise.resolve();
		await Promise.resolve();

		expect(store.get()[key]).toBe(false);
		expect(saves).toHaveLength(1);
		expect(saves[0][key]).toBe(false);
		expect(Object.keys(saves[0])).toHaveLength(4);
		expect(listener).toHaveBeenCalledTimes(1);
		const [next, prev] = listener.mock.calls[0] as [
			TaskLifecycleSettings,
			TaskLifecycleSettings,
		];
		expect(next[key]).toBe(false);
		expect(prev[key]).toBe(true);
	});

	it("a failed save is logged, not thrown", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const store = new SettingsStore({
			loadData: async () => null,
			saveData: async () => {
				throw new Error("read-only");
			},
		});
		await store.load();
		const tab = new TaskLifecycleSettingTab(
			new App() as unknown as ObsidianApp,
			{} as Plugin,
			store
		);
		tab.display();
		const el = tab.containerEl as unknown as MockElement;
		expect(() => rows(el)[1].toggle?.flip(false)).not.toThrow();
		await new Promise((r) => setTimeout(r, 0));
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
