/**
 * Minimal runtime stand-in for the `obsidian` module, wired in through the
 * alias in vitest.config.ts. The real package ships types only.
 */
import { vi } from "vitest";

export class MockElement {
	children: unknown[] = [];
	empty(): void {
		this.children = [];
	}
}

export class MockToggle {
	value = false;
	handler: ((value: boolean) => unknown) | null = null;
	setValue(value: boolean): this {
		this.value = value;
		return this;
	}
	onChange(handler: (value: boolean) => unknown): this {
		this.handler = handler;
		return this;
	}
	/** Simulate the user flipping the toggle. */
	flip(value: boolean): void {
		this.value = value;
		this.handler?.(value);
	}
}

export class Setting {
	name = "";
	desc = "";
	toggle: MockToggle | null = null;
	toggleCount = 0;
	constructor(public containerEl: MockElement) {
		containerEl.children.push(this);
	}
	setName(name: string): this {
		this.name = name;
		return this;
	}
	setDesc(desc: string): this {
		this.desc = desc;
		return this;
	}
	addToggle(cb: (toggle: MockToggle) => unknown): this {
		this.toggle = new MockToggle();
		this.toggleCount += 1;
		cb(this.toggle);
		return this;
	}
	addText(): never {
		throw new Error("Task Lifecycle settings must not have text inputs");
	}
	addDropdown(): never {
		throw new Error("Task Lifecycle settings must not have dropdowns");
	}
}

export class PluginSettingTab {
	containerEl = new MockElement();
	constructor(
		public app: unknown,
		public plugin: unknown
	) {}
	display(): void {}
	hide(): void {}
}

export class App {}

export class Plugin {
	/** In-memory `data.json`. Tests set this before `onload()` and read it after. */
	dataFile: unknown = undefined;
	settingTabs: unknown[] = [];
	addCommand = vi.fn();
	constructor(
		public app: unknown = new App(),
		public manifest: unknown = {}
	) {}
	async loadData(): Promise<unknown> {
		return this.dataFile === undefined ? null : JSON.parse(JSON.stringify(this.dataFile));
	}
	async saveData(data: unknown): Promise<void> {
		this.dataFile = JSON.parse(JSON.stringify(data));
	}
	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}
}
