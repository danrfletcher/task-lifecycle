/**
 * Live Preview embed checkbox press: DOM wiring.
 *
 * A short click on a task checkbox inside an embed (`![[Note#^block]]`,
 * `![[Note#Heading]]`, `![[Note]]`) advances the status of the task in its
 * SOURCE note (` ` -> `/` -> `x` -> `-` -> ` `) and stamps or unstamps it as
 * an editor tick would. Obsidian's own toggle, which writes a bare `[x]`,
 * never also runs.
 *
 * The click is the trigger, because it is the one event a mouse, a tap and
 * the keyboard (Space on a focused box) all send:
 *  - in the capture-phase `click`, synchronously, the handler asks
 *    `EmbedPresser.begin` whether the box is one it handles. If so the click
 *    is swallowed (`preventDefault` + `stopImmediatePropagation`) at once, in
 *    every case below, and the write happens afterwards, awaited;
 *  - a click that follows a pointer press on the same box is a short click
 *    when `PressController` says so (released before 500 ms, moved at most
 *    5 px). A hold of 500 ms or more, or a drag, only suppresses the native
 *    toggle: cancel by long press and touch handling are not part of this
 *    file;
 *  - a click with `detail` 0 and no pointer press is a keyboard click: a
 *    short click, once. A click with `detail` > 0 and no press on this box
 *    (a drag that ended here) is only suppressed;
 *  - Space on a focused box already arrives as that click. Enter does not:
 *    the browser sends no click for it, so a capture-phase `keydown` for
 *    Enter on the box runs the same press, once (a key repeat or a modified
 *    Enter does nothing, and the box's own toggle is never reached).
 *
 * Only the checkbox itself is intercepted. Links, the embed title, fold
 * chevrons, bullets and the `li` padding keep their native behaviour.
 *
 * Every listener goes through `plugin.registerDomEvent`, so unloading the
 * plugin removes them. There is no timer: the hold is measured from the
 * clock at release.
 *
 * With "Status cycle" off nothing here acts and the native toggle stays.
 */
import type { Plugin } from "obsidian";

import { CLICK_SWALLOW_MS } from "../domain/constants";
import type { EmbedPresser } from "../rendered/embed-press";
import type { SettingsStore } from "../settings/settings";
import { isInLivePreview, isInsideEmbed, isNonCheckboxTarget, type PathElement } from "./checkbox-hit-test";
import { PressController, type PressOutput } from "./press-controller";

export interface EmbedPressDeps {
	plugin: Pick<Plugin, "registerDomEvent">;
	presser: EmbedPresser;
	settings: Pick<SettingsStore, "get" | "subscribe">;
	/** Default `document`. */
	document?: Document;
	/** Default `Date.now`. */
	now?: () => number;
}

/** A pointer press that ended on an embedded checkbox, waiting for its click. */
interface Released {
	box: Element;
	/** The press was a short click (not a hold, not a drag). */
	short: boolean;
	at: number;
}

function isElement(node: unknown): node is Element & PathElement {
	return typeof node === "object" && node !== null && (node as Node).nodeType === 1;
}

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

/**
 * The checkbox an event is on, when it is the task checkbox itself inside an
 * embed in a Live Preview editor. Null for anything else (a link, the title,
 * a chevron, a bullet, the `li` padding, a checkbox outside an embed).
 */
function embedCheckbox(evt: Event): Element | null {
	const target = evt.target;
	if (!isElement(target)) return null;
	if (target.tagName !== "INPUT" || (target as HTMLInputElement).type !== "checkbox") return null;
	if (!target.classList.contains("task-list-item-checkbox")) return null;
	const path = eventPath(evt);
	if (!isInLivePreview(path) || !isInsideEmbed(path) || isNonCheckboxTarget(path)) return null;
	return target;
}

function swallow(evt: Event): void {
	evt.preventDefault();
	evt.stopImmediatePropagation();
	evt.stopPropagation();
}

/** Wire the embed press handler. Returns a function that stops it. */
export function wireEmbedPress(deps: EmbedPressDeps): () => void {
	const { plugin, presser, settings } = deps;
	const doc = deps.document ?? document;
	const now = deps.now ?? (() => Date.now());

	const controller = new PressController();
	let lastTick = now();
	let active: { box: Element; startX: number; startY: number } | null = null;
	let released: Released | null = null;
	/** The box an Enter keydown just pressed, so a click it might also send is not a second press. */
	let enterPress: { box: Element; at: number } | null = null;

	const enabled = () => settings.get().statusCycle;

	const advance = (input: (c: PressController) => PressOutput[]): PressOutput[] => {
		const t = now();
		const outputs = [...controller.tick(t - lastTick), ...input(controller)];
		lastTick = t;
		return outputs;
	};

	const onPointerDown = (evt: PointerEvent): void => {
		if (!enabled()) return;
		const box = embedCheckbox(evt);
		if (evt.isPrimary === false || (evt.pointerType === "mouse" && evt.button !== 0) || !box) {
			// A press elsewhere ends a stale one whose release we never saw.
			if (active) advance((c) => c.cancel());
			active = null;
			return;
		}
		advance((c) => c.down());
		released = null;
		active = { box, startX: evt.clientX, startY: evt.clientY };
	};

	const onPointerMove = (evt: PointerEvent): void => {
		if (!active) return;
		const a = active;
		advance((c) => c.move(evt.clientX - a.startX, evt.clientY - a.startY));
	};

	const onPointerUp = (): void => {
		if (!active) return;
		const { box } = active;
		active = null;
		const outputs = advance((c) => c.up());
		released = { box, short: outputs.includes("advance"), at: now() };
	};

	const onPointerCancel = (): void => {
		active = null;
		released = null;
		advance((c) => c.cancel());
	};

	/** What the click on `box` is: a short click, or nothing to write. */
	const clickKind = (box: Element, evt: MouseEvent): "click" | null => {
		const r = released;
		released = null;
		if (r && r.box === box && now() - r.at <= CLICK_SWALLOW_MS) return r.short ? "click" : null;
		const e = enterPress;
		enterPress = null;
		if (e && e.box === box && now() - e.at <= CLICK_SWALLOW_MS) return null;
		// No press seen on this box: Space or Enter on a focused box sends a
		// click with detail 0. Any other click here is a drag that ended on it.
		return evt.detail === 0 ? "click" : null;
	};

	const onClick = (evt: MouseEvent): void => {
		if (!enabled()) return;
		const box = embedCheckbox(evt);
		if (!box) return;
		// Synchronous: the rendered DOM and the metadata cache decide it.
		const handle = presser.begin(box);
		if (!handle.handled) {
			released = null;
			return;
		}
		swallow(evt);
		const kind = clickKind(box, evt);
		if (kind === null) return;
		void handle.run(kind).catch(() => undefined);
	};

	const onKeyDown = (evt: KeyboardEvent): void => {
		if (!enabled() || evt.key !== "Enter") return;
		const box = embedCheckbox(evt);
		if (!box) return;
		const handle = presser.begin(box);
		if (!handle.handled) return;
		// Enter never toggles a native box, but nothing else may act on it either.
		swallow(evt);
		if (evt.repeat || evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) return;
		enterPress = { box, at: now() };
		void handle.run("click").catch(() => undefined);
	};

	const stopSettings = settings.subscribe((next, prev) => {
		if (prev.statusCycle && !next.statusCycle) {
			active = null;
			released = null;
			enterPress = null;
			controller.settingOff();
		}
	});

	const opts = { capture: true };
	plugin.registerDomEvent(doc, "pointerdown", onPointerDown, opts);
	plugin.registerDomEvent(doc, "pointermove", onPointerMove, opts);
	plugin.registerDomEvent(doc, "pointerup", onPointerUp, opts);
	plugin.registerDomEvent(doc, "pointercancel", onPointerCancel, opts);
	plugin.registerDomEvent(doc, "click", onClick, opts);
	plugin.registerDomEvent(doc, "keydown", onKeyDown, opts);

	return () => {
		stopSettings();
		controller.settingOff();
		active = null;
		released = null;
		enterPress = null;
	};
}
