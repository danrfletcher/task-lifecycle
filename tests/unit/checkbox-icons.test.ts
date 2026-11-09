// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CHECKBOX_ICONS_CLASS,
	applyCheckboxIcons,
	bindCheckboxIcons,
} from "../../src/settings/checkbox-icons";
import { SettingsStore } from "../../src/settings/settings";

async function storeWith(initial?: unknown) {
	const store = new SettingsStore({
		loadData: async () => initial ?? null,
		saveData: async () => {},
	});
	await store.load();
	return store;
}

const has = () => document.body.classList.contains(CHECKBOX_ICONS_CLASS);

beforeEach(() => {
	document.body.className = "";
});

afterEach(() => {
	document.body.className = "";
});

describe("applyCheckboxIcons", () => {
	it("uses the class name styles.css is scoped to", () => {
		expect(CHECKBOX_ICONS_CLASS).toBe("task-lifecycle-checkboxes");
	});

	it("true adds and false removes body.task-lifecycle-checkboxes", () => {
		applyCheckboxIcons(true);
		expect(has()).toBe(true);
		applyCheckboxIcons(false);
		expect(has()).toBe(false);
	});

	it("is idempotent", () => {
		applyCheckboxIcons(true);
		applyCheckboxIcons(true);
		expect(document.body.className.split(/\s+/).filter((c) => c === CHECKBOX_ICONS_CLASS)).toHaveLength(1);
		applyCheckboxIcons(false);
		applyCheckboxIcons(false);
		expect(has()).toBe(false);
	});

	it("leaves other body classes alone", () => {
		document.body.classList.add("theme-dark", "is-mobile");
		applyCheckboxIcons(true);
		applyCheckboxIcons(false);
		expect(document.body.classList.contains("theme-dark")).toBe(true);
		expect(document.body.classList.contains("is-mobile")).toBe(true);
	});

	it("adds nothing to document.head", () => {
		const before = document.head.innerHTML;
		const styles = document.querySelectorAll("head style").length;
		applyCheckboxIcons(true);
		applyCheckboxIcons(false);
		applyCheckboxIcons(true);
		expect(document.head.innerHTML).toBe(before);
		expect(document.querySelectorAll("head style").length).toBe(styles);
		expect(document.adoptedStyleSheets?.length ?? 0).toBe(0);
	});
});

describe("bindCheckboxIcons", () => {
	it("applies the stored value at once (on by default)", async () => {
		const store = await storeWith();
		bindCheckboxIcons(store);
		expect(has()).toBe(true);
	});

	it("with icons stored off, enabling the plugin doesn't add the class", async () => {
		const store = await storeWith({ checkboxIcons: false });
		bindCheckboxIcons(store);
		expect(has()).toBe(false);
	});

	it("follows the setting without a reload", async () => {
		const store = await storeWith();
		bindCheckboxIcons(store);
		await store.update({ checkboxIcons: false });
		expect(has()).toBe(false);
		await store.update({ checkboxIcons: true });
		expect(has()).toBe(true);
	});

	it("other settings changing doesn't touch the class", async () => {
		const store = await storeWith();
		bindCheckboxIcons(store);
		await store.update({ closeStamps: false });
		expect(has()).toBe(true);
	});

	it("ten quick flips leave the class matching the final value", async () => {
		const store = await storeWith();
		bindCheckboxIcons(store);
		const pending: Promise<void>[] = [];
		let value = true;
		for (let i = 0; i < 10; i++) {
			value = !value;
			pending.push(store.update({ checkboxIcons: value }));
		}
		await Promise.all(pending);
		expect(has()).toBe(value);
		expect(store.get().checkboxIcons).toBe(value);
	});

	it("dispose removes the class and stops following the setting", async () => {
		const store = await storeWith();
		const dispose = bindCheckboxIcons(store);
		expect(has()).toBe(true);
		dispose();
		expect(has()).toBe(false);
		await store.update({ checkboxIcons: true });
		expect(has()).toBe(false);
	});

	it("re-enabling after unload restores the class from the saved setting", async () => {
		const store = await storeWith();
		const dispose = bindCheckboxIcons(store);
		dispose();
		bindCheckboxIcons(store);
		expect(has()).toBe(true);
	});

	it("adds nothing to document.head", async () => {
		const before = document.head.innerHTML;
		const store = await storeWith();
		const dispose = bindCheckboxIcons(store);
		await store.update({ checkboxIcons: false });
		dispose();
		expect(document.head.innerHTML).toBe(before);
	});
});
