/**
 * Minimal runtime stand-in for the `obsidian` module, wired in through the
 * alias in vitest.config.mts. The real package ships types only.
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

/** `Notice`: every message shown is recorded in `Notice.shown`. */
export class Notice {
	static shown: string[] = [];
	static reset(): void {
		Notice.shown = [];
	}
	constructor(
		public message: string,
		public timeout?: number
	) {
		Notice.shown.push(message);
	}
}

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

/** A `TFile` stand-in: the fields the plugin reads. */
export class MockTFile {
	name: string;
	basename: string;
	extension: string;
	constructor(public path: string) {
		this.name = path.slice(path.lastIndexOf("/") + 1);
		const dot = this.name.lastIndexOf(".");
		this.extension = dot >= 0 ? this.name.slice(dot + 1) : "";
		this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
	}
}

/**
 * A stand-in for `app.vault` with in-memory file text. Every write call is
 * recorded in `writes` (and does nothing else), so a test can prove that a
 * read-only module never wrote.
 */
export class MockVault {
	/** path -> file text. */
	texts = new Map<string, string>();
	files = new Map<string, MockTFile>();
	/** Paths that make `cachedRead` reject, as a file deleted behind the cache would. */
	unreadable = new Set<string>();
	/** One entry per write call, e.g. `process:Course.md`. */
	writes: string[] = [];
	reads = 0;
	getAbstractFileByPath(path: string): MockTFile | null {
		return this.files.get(path) ?? null;
	}
	async cachedRead(file: MockTFile): Promise<string> {
		this.reads += 1;
		const text = this.texts.get(file.path);
		if (text === undefined || this.unreadable.has(file.path)) throw new Error("ENOENT");
		return text;
	}
	/** Like `vault.read`: the stored text; a missing (deleted) file rejects. */
	async read(file: MockTFile): Promise<string> {
		this.reads += 1;
		const text = this.texts.get(file.path);
		if (text === undefined || this.unreadable.has(file.path)) throw new Error("ENOENT");
		return text;
	}
	/** Paths whose next `process` call waits for the release function `hold` returned. */
	private gates = new Map<string, Array<Promise<void>>>();
	/** Make the next `process` call on `path` wait until the returned function is called. */
	hold(path: string): () => void {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		this.gates.set(path, [...(this.gates.get(path) ?? []), gate]);
		return release;
	}
	/**
	 * Like `vault.process`: the callback gets the stored text and its result is
	 * stored. A missing (deleted) file rejects, as Obsidian's does.
	 */
	async process(file: MockTFile, fn?: (data: string) => string): Promise<string> {
		this.writes.push(`process:${file.path}`);
		const gate = this.gates.get(file.path)?.shift();
		if (gate) await gate;
		const text = this.texts.get(file.path);
		if (text === undefined || this.unreadable.has(file.path)) throw new Error("ENOENT");
		const next = fn ? fn(text) : text;
		this.texts.set(file.path, next);
		return next;
	}
	async modify(file: MockTFile): Promise<void> {
		this.writes.push(`modify:${file.path}`);
	}
}

/** A stand-in for `app.metadataCache`, with hand-built per-file caches. */
export class MockMetadataCache {
	/** path -> the cache the test built by hand (`headings`, `blocks`, `listItems`, ...). */
	caches = new Map<string, unknown>();
	constructor(private vault: MockVault) {}
	getFileCache(file: MockTFile): unknown {
		return this.caches.get(file.path) ?? null;
	}
	/** Like Obsidian: a path, a path without `.md`, or a bare name. */
	getFirstLinkpathDest(linkpath: string, _sourcePath: string): MockTFile | null {
		for (const f of this.vault.files.values()) {
			if (f.path === linkpath || f.path === `${linkpath}.md`) return f;
		}
		for (const f of this.vault.files.values()) {
			if (f.name === linkpath || f.basename === linkpath) return f;
		}
		return null;
	}
}

export class App {
	workspace = new MockWorkspace();
	vault = new MockVault();
	metadataCache = new MockMetadataCache(this.vault);
	/** Add a note to the mock vault, with the metadata cache a test built by hand for it. */
	addNote(path: string, text: string, cache?: unknown): MockTFile {
		const file = new MockTFile(path);
		this.vault.files.set(path, file);
		this.vault.texts.set(path, text);
		if (cache !== undefined) this.metadataCache.caches.set(path, cache);
		return file;
	}
}

type Decorated = HTMLElement;

interface ElementOpts {
	text?: string;
	cls?: string;
}

/** Give a DOM element the helpers Obsidian adds to `HTMLElement`. */
function decorate(el: HTMLElement): Decorated {
	const createEl = (tag: string, opts?: ElementOpts): HTMLElement => {
		const child = decorate(document.createElement(tag));
		if (opts?.text !== undefined) child.textContent = opts.text;
		if (opts?.cls) child.className = opts.cls;
		el.appendChild(child);
		return child;
	};
	return Object.assign(el, {
		createEl,
		createDiv: (opts?: ElementOpts) => createEl("div", opts),
		setText: (text: string) => {
			el.textContent = text;
		},
		empty: () => {
			el.replaceChildren();
		},
	});
}

export interface MockKeyHandler {
	modifiers: string[] | null;
	key: string | null;
	func: (evt: KeyboardEvent) => unknown;
}

/** `Scope`: `register` / `unregister`, and `press` to simulate a key. */
export class Scope {
	handlers: MockKeyHandler[] = [];
	register(
		modifiers: string[] | null,
		key: string | null,
		func: (evt: KeyboardEvent) => unknown
	): MockKeyHandler {
		const handler = { modifiers, key, func };
		this.handlers.push(handler);
		return handler;
	}
	unregister(handler: MockKeyHandler): void {
		this.handlers = this.handlers.filter((h) => h !== handler);
	}
	/** Run the handlers for `key`; true if one handled it (returned false). */
	press(key: string, evt: Partial<KeyboardEvent> = {}): boolean {
		for (const h of [...this.handlers]) {
			if (h.key === key && h.func({ key, ...evt } as KeyboardEvent) === false) return true;
		}
		return false;
	}
}

/**
 * `Modal` for tests that run under happy-dom: `open()` puts a
 * `.modal-container` in the body, `close()` calls `onClose` and removes it.
 * Escape and the close button are `close()`.
 */
export class Modal {
	/** Every modal that is open right now. */
	static openModals: Modal[] = [];
	scope = new Scope();
	containerEl!: Decorated;
	modalEl!: Decorated;
	titleEl!: Decorated;
	contentEl!: Decorated;
	isOpen = false;
	constructor(public app: unknown) {
		if (typeof document === "undefined") return;
		this.containerEl = decorate(document.createElement("div"));
		this.containerEl.className = "modal-container";
		this.modalEl = this.containerEl.createDiv({ cls: "modal" });
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
	}
	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		Modal.openModals.push(this);
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}
	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		Modal.openModals = Modal.openModals.filter((m) => m !== this);
		this.onClose();
		this.containerEl.remove();
	}
	onOpen(): void {}
	onClose(): void {}
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
