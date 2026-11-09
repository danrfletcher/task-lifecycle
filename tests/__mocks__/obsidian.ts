/**
 * Minimal runtime stand-in for the `obsidian` module, wired in through the
 * alias in vitest.config.ts. The real package ships types only.
 */
import { StateField, type Extension } from "@codemirror/state";
import { vi } from "vitest";

/**
 * Stand-in for Obsidian's `editorInfoField`. Tests give a state a fake file
 * with `editorInfoField.init(() => ({ file }))`.
 */
export const editorInfoField = StateField.define<{ file: unknown } | null>({
	create: () => null,
	update: (value) => value,
});

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

type WorkspaceHandler = (...args: unknown[]) => void;

/** A stand-in for `app.workspace`: `on`/`trigger` and a settable list of markdown leaves. */
export class MockWorkspace {
	handlers = new Map<string, WorkspaceHandler[]>();
	/** Leaves returned by `getLeavesOfType("markdown")`: `{ view: { contentEl, editor, file } }`. */
	leaves: unknown[] = [];
	on(name: string, handler: WorkspaceHandler): { name: string; handler: WorkspaceHandler } {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
		return { name, handler };
	}
	offref(ref: { name: string; handler: WorkspaceHandler }): void {
		this.handlers.set(
			ref.name,
			(this.handlers.get(ref.name) ?? []).filter((h) => h !== ref.handler)
		);
	}
	getLeavesOfType(_type: string): unknown[] {
		return this.leaves;
	}
	trigger(name: string, ...args: unknown[]): void {
		for (const h of this.handlers.get(name) ?? []) h(...args);
	}
}

export class App {
	workspace = new MockWorkspace();
}

export class Plugin {
	/** In-memory `data.json`. Tests set this before `onload()` and read it after. */
	dataFile: unknown = undefined;
	settingTabs: unknown[] = [];
	addCommand = vi.fn();
	editorExtensions: Extension[] = [];
	/** Removers for everything registered through `registerDomEvent` / `registerEvent`. */
	private cleanups: Array<() => void> = [];
	/** How many DOM listeners are registered right now. */
	domListenerCount = 0;
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
	registerEditorExtension(extension: Extension): void {
		this.editorExtensions.push(extension);
	}
	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}
	registerDomEvent(
		el: EventTarget,
		type: string,
		callback: (evt: never) => unknown,
		options?: boolean | AddEventListenerOptions
	): void {
		el.addEventListener(type, callback, options);
		this.domListenerCount += 1;
		this.cleanups.push(() => {
			el.removeEventListener(type, callback, options);
			this.domListenerCount -= 1;
		});
	}
	registerEvent(ref: unknown): void {
		const ws = (this.app as App).workspace;
		this.cleanups.push(() => ws.offref(ref as never));
	}
	/** What Obsidian does when the plugin is disabled: `onunload`, then drop registrations. */
	unload(): void {
		this.onunload?.();
		for (const cleanup of this.cleanups.splice(0)) cleanup();
	}
	onunload?(): void;
}
