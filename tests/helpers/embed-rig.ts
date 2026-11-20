/**
 * A rig for the embed press tests: a real `TaskLifecyclePlugin` on the mock
 * app, a Live Preview host note (`Learning Queue.md`) in the mock workspace,
 * and builders for embeds the way Obsidian 1.15.1 draws them
 * (`.cm-embed-block > .internal-embed.markdown-embed`, docs/probe-rendered-tasks.md).
 * Events are real DOM events dispatched at real elements.
 */
import { vi } from "vitest";
import TaskLifecyclePlugin from "../../src/main";
import { STATUS_CHANGED_EVENT } from "../../src/events/event-bus";
import { makeCmEditor, type CmEditorHandle } from "./cm-editor";
import { App, Notice, type MockTFile } from "../__mocks__/obsidian";
import { COURSE_CACHE, COURSE_TEXT, FORMS_CACHE, FORMS_TEXT } from "../fixtures/rendered-notes";
import { embed, mountHost, type TaskSpec } from "./rendered-dom";

/** The local date the rig's clock reads: 2026-11-20 12:00. */
export const TODAY = "2026-11-20";

export const UNMAPPABLE = "Task Lifecycle: couldn't find this task's source line, nothing changed";

export type RigPlugin = TaskLifecyclePlugin & {
	domListenerCount: number;
	unload(): void;
	dataFile: unknown;
};

export interface EmbedRig {
	app: App;
	plugin: RigPlugin;
	host: HTMLElement;
	hostFile: MockTFile;
	course: MockTFile;
	forms: MockTFile;
	/** `Course.md`'s text now. */
	courseText(): string;
	/** Put an embed of `src` with `sections` of tasks into the host, in a `.cm-embed-block`. */
	addEmbed(src: string, sections: TaskSpec[][]): { el: HTMLElement; boxes: HTMLInputElement[] };
}

export const task = (text: string, dataLine: number, children?: TaskSpec[]): TaskSpec => ({
	text,
	dataLine,
	children,
});

/** The three lines of `![[Course#^l2]]`, as rendered. */
export const lessonSection = (): TaskSpec[] => [
	task("Lesson 2 content ", 0, [task("Watch video", 1), task("Take notes", 2)]),
];

/** `settings` is what `data.json` holds: a partial settings object, or anything (a corrupt file). */
export async function makeRig(settings?: unknown): Promise<EmbedRig> {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0));
	document.body.replaceChildren();
	document.body.className = "";
	Notice.reset();

	const app = new App();
	const plugin = new (TaskLifecyclePlugin as unknown as new (a: App) => RigPlugin)(app);
	plugin.dataFile = settings;
	await plugin.onload();

	const course = app.addNote("Course.md", COURSE_TEXT, COURSE_CACHE);
	const forms = app.addNote("Forms.md", FORMS_TEXT, FORMS_CACHE);
	const hostFile = app.addNote("Learning Queue.md", "![[Course#^l2]]\n", { embeds: [] });
	const host = mountHost(app, hostFile);
	host.classList.add("is-live-preview");

	return {
		app,
		plugin,
		host,
		hostFile,
		course,
		forms,
		courseText: () => app.vault.texts.get("Course.md") ?? "",
		addEmbed(src, sections) {
			const built = embed(src, sections);
			const block = document.createElement("div");
			block.className = "cm-embed-block";
			block.append(built.el);
			host.append(block);
			return built;
		},
	};
}

export function pointer(
	type: string,
	target: Element,
	init: PointerEventInit = {}
): PointerEvent {
	const evt = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		composed: true,
		isPrimary: true,
		button: 0,
		pointerType: "mouse",
		...init,
	});
	target.dispatchEvent(evt);
	return evt;
}

export function click(target: Element, detail = 1): MouseEvent {
	const evt = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail });
	target.dispatchEvent(evt);
	return evt;
}

/** A keydown on the focused `target`, as the browser sends it (Enter sends no click). */
export function keydown(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const evt = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key, ...init });
	target.dispatchEvent(evt);
	return evt;
}

/** One physical mouse click: down, up, then the click the browser sends. */
export function mouseClick(target: Element): MouseEvent {
	pointer("pointerdown", target);
	pointer("pointerup", target);
	return click(target, 1);
}

/** Let every queued write and promise run. */
export async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

/** Count of `click`s that reach the checkbox itself, i.e. where Obsidian's native toggle would run. */
export function watchNative(box: Element): { count(): number } {
	let n = 0;
	box.addEventListener("click", () => {
		n += 1;
	});
	return { count: () => n };
}

/**
 * Open `Course.md` in a real CodeMirror editor (with the change detector) in
 * the rig's workspace, and pass the detector's status events on to the
 * plugin's own bus, as the editor extension does in the app, so the plugin's
 * cascade sees them. `closeStamps` is the detector's own setting: keep it the
 * same as the plugin's.
 */
export function openCourseInEditor(
	rig: EmbedRig,
	text: string,
	opts: { closeStamps?: boolean } = {}
): CmEditorHandle {
	const cm = makeCmEditor(text, { today: new Date(2026, 10, 20, 12, 0, 0), closeStamps: opts.closeStamps });
	cm.bus.on(STATUS_CHANGED_EVENT, (p) => rig.plugin.events.emit(STATUS_CHANGED_EVENT, p));
	rig.app.workspace.leaves.push({ view: { file: { path: "Course.md" }, editor: cm.editor } });
	return cm;
}
