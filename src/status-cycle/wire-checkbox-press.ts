/**
 * Live Preview checkbox press handler: DOM wiring.
 *
 * A short click advances the status (` ` -> `/` -> `x` -> `-` -> ` `), a
 * 500 ms hold cancels (`-`), and Obsidian's native toggle never also fires.
 * The handler only writes the status char (see `status-write.ts`); stamps
 * and, later, the cascade follow from the change detector, which sees the
 * write as an ordinary editor change.
 *
 * Only pointer events drive it (`pointerdown`, `pointermove`, `pointerup`,
 * `pointercancel`), plus a capture-phase `click` guard that swallows the
 * click of a handled press and blocks the native toggle, and a `contextmenu`
 * guard for touch holds. Every listener goes through
 * `plugin.registerDomEvent`, so unloading the plugin removes them all.
 *
 * What a gesture means is decided by `PressController` (pure). This file
 * only turns DOM events into controller inputs, keeps real time, and does
 * what the outputs say.
 *
 * Fence: no import from the cascade, no commands. This handler is the Live
 * Preview editor's own checkbox only; a checkbox that Obsidian draws outside
 * the editor (Reading view, an embed) belongs to `wire-embed-press.ts`.
 */
import type { App, Editor, Plugin } from "obsidian";

import { checkboxTokenRange, getCheckboxStatusChar, isTaskLine } from "../domain/line-classifier";
import {
	findLineInCalloutWidget,
	findLineOfElement,
	findPosFromEvent,
	isInBlockWidget,
	type WidgetElementLike,
} from "../editor/editor-interaction";
import type { SettingsStore } from "../settings/settings";
import {
	isCheckboxPress,
	isInLivePreview,
	isInsideEmbed,
	isNonCheckboxTarget,
	pathHitsWidget,
	type PathElement,
} from "./checkbox-hit-test";
import { PressController, type PressOutput } from "./press-controller";
import { writeStatus } from "./status-write";

/** The slice of a Markdown view the handler uses. */
interface PressView {
	contentEl?: { contains(node: Node | null): boolean };
	editor?: Editor;
}

export interface CheckboxPressDeps {
	plugin: Pick<Plugin, "registerDomEvent" | "registerEvent">;
	app: Pick<App, "workspace">;
	settings: Pick<SettingsStore, "get" | "subscribe">;
	/** Default `document`. */
	document?: Document;
	/** Default `Date.now`. */
	now?: () => number;
}

/** The press in progress: what was pressed, to check it is still there when we write. */
interface Press {
	editor: Editor;
	line0: number;
	lineText: string;
	startX: number;
	startY: number;
}

function isElement(node: unknown): node is PathElement {
	return typeof node === "object" && node !== null && (node as Node).nodeType === 1;
}

/** The event path, target first: `composedPath()` or, failing that, the parent chain. */
function eventPath(evt: Event): PathElement[] {
	const raw = typeof evt.composedPath === "function" ? evt.composedPath() : [];
	if (raw.length > 0) return (raw as unknown[]).filter(isElement);
	const out: PathElement[] = [];
	let el: unknown = evt.target;
	while (isElement(el)) {
		out.push(el);
		el = (el as unknown as { parentElement: unknown }).parentElement;
	}
	return out;
}

function swallow(evt: Event): void {
	evt.preventDefault();
	evt.stopImmediatePropagation();
	evt.stopPropagation();
}

/**
 * Wire the press handler. Returns a function that stops it: it clears the
 * pending timer and the settings subscription (the DOM listeners go with the
 * plugin's own unload).
 */
export function wireCheckboxPress(deps: CheckboxPressDeps): () => void {
	const { plugin, app, settings } = deps;
	const doc = deps.document ?? document;
	const now = deps.now ?? (() => Date.now());

	const controller = new PressController();
	let press: Press | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastTick = now();

	const enabled = () => settings.get().statusCycle;

	/** The Markdown view whose own content element holds `target`. */
	const viewFor = (target: EventTarget | null): PressView | null => {
		if (!(target as Node | null)) return null;
		for (const leaf of app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as unknown as PressView;
			if (view.contentEl?.contains(target as Node) && view.editor) return view;
		}
		return null;
	};

	const perform = (kind: "click" | "longPress"): void => {
		const p = press;
		if (!p) return;
		// The line must still be the one that was pressed.
		if (p.line0 >= p.editor.lineCount()) return;
		const text = p.editor.getLine(p.line0);
		if (text !== p.lineText || !isTaskLine(text)) return;
		writeStatus(p.editor, p.line0, kind);
	};

	const apply = (outputs: PressOutput[], evt?: Event): void => {
		for (const out of outputs) {
			if (out === "advance") perform("click");
			else if (out === "cancelTask") perform("longPress");
			else if (out === "swallowClick") {
				if (evt) swallow(evt);
			} else if (out === "preventContextMenu") evt?.preventDefault();
		}
	};

	const reschedule = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		const ms = controller.msUntilLongPress();
		if (ms === null) return;
		timer = setTimeout(() => {
			timer = null;
			run(() => []);
		}, ms);
	};

	/** Advance the controller's clock, feed it `input`, act on its outputs. */
	const run = (input: (c: PressController) => PressOutput[], evt?: Event): PressOutput[] => {
		const t = now();
		const outputs = [...controller.tick(t - lastTick), ...input(controller)];
		lastTick = t;
		apply(outputs, evt);
		if (!controller.isActive()) press = null;
		reschedule();
		return outputs;
	};

	const onPointerDown = (evt: PointerEvent): void => {
		if (!enabled()) return;
		if (evt.isPrimary === false) {
			// A second finger: not a clean tap or hold.
			if (controller.isActive()) run((c) => c.cancel());
			return;
		}
		const target = evt.target as Node | null;
		// A checkbox inside an embed belongs to `wire-embed-press.ts`.
		if (isInsideEmbed(eventPath(evt))) return;
		const view = viewFor(target);
		const hit = view ? resolvePress(view, evt) : null;
		if (!view || !hit) {
			// A press elsewhere ends a stale one whose release we never saw.
			if (controller.isActive()) run((c) => c.cancel());
			return;
		}
		run((c) => c.down());
		press = { ...hit, startX: evt.clientX, startY: evt.clientY };
	};

	/** The editor, line and text under a pointerdown that lands on a checkbox, or null. */
	const resolvePress = (
		view: PressView,
		evt: PointerEvent
	): { editor: Editor; line0: number; lineText: string } | null => {
		if (evt.pointerType === "mouse" && evt.button !== 0) return null;
		const editor = view.editor;
		if (!editor) return null;
		const at = locate(editor, evt);
		if (!at) return null;
		const lineText = editor.getLine(at.line);
		if (!isCheckboxPress(eventPath(evt), lineText, at.ch)) return null;
		return { editor, line0: at.line, lineText };
	};

	/**
	 * The line and column an event maps to. The line always comes from the
	 * DOM element that was pressed, never from `posAtCoords`: that goes
	 * through layout, which is stale right after a write, so a press 0 ms
	 * after another could land on a different line.
	 *
	 *  - A task inside a rendered block widget (a Live Preview callout) is
	 *    placed from the widget (`findLineInCalloutWidget`); `posAtCoords`
	 *    only returns the widget's first or last position there.
	 *  - Otherwise the line is the one the pressed `.cm-line` renders. The
	 *    checkbox widget stands in for the "[c]" token, so its column is the
	 *    token's. A label has no such standing, so its column still comes
	 *    from `posAtCoords`, and only if that agrees on the line.
	 *
	 * Anything we cannot place maps to nothing: the event is left alone
	 * rather than a line guessed.
	 */
	const locate = (editor: Editor, evt: Event): { line: number; ch: number } | null => {
		const target = evt.target as unknown as WidgetElementLike | null;
		if (!isInBlockWidget(target)) {
			const line = findLineOfElement(editor, target);
			if (line === null) return null;
			if (pathHitsWidget(eventPath(evt)).hitsCheckbox) {
				const range = checkboxTokenRange(editor.getLine(line));
				return range ? { line, ch: range.fromCh } : null;
			}
			const pos = findPosFromEvent(editor, evt as MouseEvent);
			return pos && pos.line === line ? pos : null;
		}
		const found = findLineInCalloutWidget(editor, target);
		if (found === null) return null;
		const lineText = editor.getLine(found.line);
		const range = checkboxTokenRange(lineText);
		if (!range) return null;
		// The rendered checkbox must show the status the line has: if not,
		// the DOM line offset is off, and nothing is written.
		const status = getCheckboxStatusChar(lineText);
		if (found.renderedStatus !== null && found.renderedStatus !== status) return null;
		return { line: found.line, ch: range.fromCh };
	};

	const onPointerMove = (evt: PointerEvent): void => {
		if (!press || !controller.isActive()) return;
		const p = press;
		run((c) => c.move(evt.clientX - p.startX, evt.clientY - p.startY));
	};

	const onPointerUp = (evt: PointerEvent): void => {
		if (!controller.isActive()) return;
		run((c) => c.up(), evt);
	};

	const onPointerCancel = (): void => {
		if (!controller.isActive()) return;
		run((c) => c.cancel());
	};

	const onContextMenu = (evt: Event): void => {
		if (!enabled()) return;
		run((c) => c.contextmenu(), evt);
	};

	const onClick = (evt: MouseEvent): void => {
		if (!enabled()) return;
		const path = eventPath(evt);
		if (!isInLivePreview(path) || isNonCheckboxTarget(path)) return;
		// A checkbox inside an embed belongs to `wire-embed-press.ts`.
		if (isInsideEmbed(path)) return;
		const { hitsCheckbox, hitsLabel } = pathHitsWidget(path);
		if (!hitsCheckbox && !hitsLabel) return;
		const view = viewFor(evt.target);
		if (!view) return;

		// The click of a handled press: swallow it.
		const outputs = run((c) => c.click(), evt);
		if (outputs.includes("swallowClick")) return;

		// Any other click on the checkbox (a drag that ended on it, a click
		// after a press we ignored): the native toggle must not run either.
		// A widget task we cannot place is left to the native toggle.
		const at = view.editor ? locate(view.editor, evt) : null;
		const block =
			at && view.editor
				? isCheckboxPress(path, view.editor.getLine(at.line), at.ch)
				: hitsCheckbox && !isInBlockWidget(evt.target as unknown as WidgetElementLike);
		if (block) swallow(evt);
	};

	const stopSettings = settings.subscribe((next, prev) => {
		if (prev.statusCycle && !next.statusCycle) run((c) => c.settingOff());
	});

	// Switching note, or the active leaf: nothing is written in either note.
	plugin.registerEvent(
		app.workspace.on("active-leaf-change", () => {
			if (controller.isActive()) run((c) => c.cancel());
		})
	);

	plugin.registerDomEvent(doc, "pointerdown", onPointerDown);
	plugin.registerDomEvent(doc, "pointermove", onPointerMove);
	plugin.registerDomEvent(doc, "pointerup", onPointerUp);
	plugin.registerDomEvent(doc, "pointercancel", onPointerCancel);
	plugin.registerDomEvent(doc, "contextmenu", onContextMenu, { capture: true });
	plugin.registerDomEvent(doc, "click", onClick, { capture: true });

	return () => {
		stopSettings();
		controller.settingOff();
		press = null;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};
}
