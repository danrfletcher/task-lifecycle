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
 *    5 px). A drag only suppresses the native toggle;
 *  - a hold of 500 ms or more without moving more than 5 px cancels the task
 *    (`-`) once, as soon as the time is up and before the release (G3). The
 *    release, and the click that follows it within 600 ms, are swallowed, and
 *    the platform's long-press `contextmenu` is prevented during the press
 *    and in those 600 ms. A hold cancels even with "Status cycle" off;
 *  - touch is the same code path as the mouse (G2): a clean tap is a short
 *    click, a hold is a cancel, a move over 5 px, a `pointercancel` (the
 *    browser took a scroll) or a second finger (`isPrimary` false) ends the
 *    press and writes nothing;
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
 * plugin removes them. The one timer is the hold timer: the returned stop
 * function clears it. A short click is measured from the clock at release,
 * not by the timer.
 *
 * With "Status cycle" off a short click and Enter are left to the native
 * toggle (the plain toggle is the settings PR's job), but a hold still
 * cancels and the click after it is still swallowed.
 */
import type { Plugin } from "obsidian";

import { CLICK_SWALLOW_MS } from "../domain/constants";
import type { EmbedPressBegin, EmbedPresser } from "../rendered/embed-press";
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
	/** The press was a hold that has already cancelled the task. */
	held: boolean;
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
	/** The press in progress; `handle` is the presser's answer for its box, taken at pointerdown. */
	let active: {
		box: Element;
		startX: number;
		startY: number;
		handle: Extract<EmbedPressBegin, { handled: true }>;
		/** The hold has fired its cancel. */
		fired: boolean;
	} | null = null;
	let released: Released | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** The box an Enter keydown just pressed, so a click it might also send is not a second press. */
	let enterPress: { box: Element; at: number } | null = null;

	const enabled = () => settings.get().statusCycle;

	const clearTimer = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	/** Arm the timer for the moment the hold is due, or leave none when no press waits for it. */
	const reschedule = (): void => {
		clearTimer();
		const ms = controller.msUntilLongPress();
		if (ms === null) return;
		timer = setTimeout(() => {
			timer = null;
			run(() => []);
		}, ms);
	};

	/** Advance the controller's clock, feed it `input`; a hold that comes due cancels the task once. */
	const run = (input: (c: PressController) => PressOutput[]): PressOutput[] => {
		const t = now();
		const outputs = [...controller.tick(t - lastTick), ...input(controller)];
		lastTick = t;
		if (outputs.includes("cancelTask") && active && !active.fired) {
			active.fired = true;
			void active.handle.run("longPress").catch(() => undefined);
		}
		reschedule();
		return outputs;
	};

	const onPointerDown = (evt: PointerEvent): void => {
		const box = evt.isPrimary === false || (evt.pointerType === "mouse" && evt.button !== 0) ? null : embedCheckbox(evt);
		// A press elsewhere, a second finger, or a box this plugin leaves to
		// Obsidian ends a stale press whose release we never saw.
		const handle = box ? presser.begin(box) : null;
		if (active) run((c) => c.cancel());
		active = null;
		if (!box || !handle?.handled) return;
		released = null;
		active = { box, startX: evt.clientX, startY: evt.clientY, handle, fired: false };
		run((c) => c.down());
	};

	const onPointerMove = (evt: PointerEvent): void => {
		if (!active) return;
		const a = active;
		run((c) => c.move(evt.clientX - a.startX, evt.clientY - a.startY));
	};

	const onPointerUp = (evt: PointerEvent): void => {
		if (!active) return;
		const a = active;
		const outputs = run((c) => c.up());
		active = null;
		released = { box: a.box, short: outputs.includes("advance"), held: a.fired, at: now() };
		// The release of a hold is swallowed: it ends a gesture this plugin already acted on.
		if (a.fired) swallow(evt);
	};

	const onPointerCancel = (): void => {
		if (active) run((c) => c.cancel());
		active = null;
		released = null;
		clearTimer();
	};

	/** The platform's long-press menu: not over a press in progress, nor in the 600 ms after a hold. */
	const onContextMenu = (evt: Event): void => {
		if (run((c) => c.contextmenu()).includes("preventContextMenu")) evt.preventDefault();
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
		const box = embedCheckbox(evt);
		if (!box) return;
		if (!enabled()) {
			// Left to the native toggle, except the click that follows a hold
			// (which already cancelled the task).
			const r = released;
			released = null;
			if (r && r.box === box && r.held && now() - r.at <= CLICK_SWALLOW_MS) swallow(evt);
			return;
		}
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
			clearTimer();
		}
	});

	const opts = { capture: true };
	plugin.registerDomEvent(doc, "pointerdown", onPointerDown, opts);
	plugin.registerDomEvent(doc, "pointermove", onPointerMove, opts);
	plugin.registerDomEvent(doc, "pointerup", onPointerUp, opts);
	plugin.registerDomEvent(doc, "pointercancel", onPointerCancel, opts);
	plugin.registerDomEvent(doc, "contextmenu", onContextMenu, opts);
	plugin.registerDomEvent(doc, "click", onClick, opts);
	plugin.registerDomEvent(doc, "keydown", onKeyDown, opts);

	return () => {
		stopSettings();
		controller.settingOff();
		clearTimer();
		active = null;
		released = null;
		enterPress = null;
	};
}
