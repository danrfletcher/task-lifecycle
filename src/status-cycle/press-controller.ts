/**
 * Press controller (pure state machine, no DOM, no timers, no `obsidian`).
 *
 * It decides what a pointer gesture on a task checkbox means. The caller
 * feeds it inputs and does what the returned outputs say:
 *
 *   inputs                      outputs
 *   down()                      advance        write the next status
 *   move(dx, dy)                cancelTask     write "-" (long press)
 *   up()                        swallowClick   preventDefault + stopImmediatePropagation
 *   cancel()                                   on this event (and, for `up`, on the
 *   click()                                    click that follows)
 *   contextmenu()               preventContextMenu
 *   tick(ms)
 *   settingOff()
 *
 * Time only moves when `tick(ms)` is called. The caller keeps real time
 * (see `wire-checkbox-press.ts`) and uses `msUntilLongPress()` to know when
 * the next `tick` is due.
 *
 * Rules:
 *  - up before 500 ms (no move > 5 px, not cancelled): `advance`, then the
 *    release and the click that follows are swallowed.
 *  - 500 ms without a move > 5 px: `cancelTask` exactly once, as soon as the
 *    time is up (before release). The release is then swallowed, and so is
 *    the click that follows it within 600 ms of the release.
 *  - move with sqrt(dx^2 + dy^2) > 5 (measured from where the press began),
 *    `cancel` (pointercancel) or `settingOff`: the press is over and nothing
 *    is written. A pointercancel never advances.
 *  - The swallow only covers the click of the press it belongs to: a new
 *    `down` clears it, and a click uses it up.
 *  - `contextmenu` is prevented while a press is active, and in the swallow
 *    window of a long press.
 */
import {
	CLICK_SWALLOW_MS,
	LONG_PRESS_MS,
	MOVE_TOLERANCE_PX,
} from "../domain/constants";

export type PressOutput =
	| "advance"
	| "cancelTask"
	| "swallowClick"
	| "preventContextMenu";

type Phase = "idle" | "pressing" | "fired";

export class PressController {
	private phase: Phase = "idle";
	/** Time since the press began (ms); counts only while `pressing`. */
	private heldMs = 0;
	/** ms left in which a click is swallowed; null when no swallow is armed. */
	private swallowLeftMs: number | null = null;
	/** The armed swallow belongs to a long press (the context menu is also blocked). */
	private swallowIsLong = false;

	/** True from `down` until the press ends (release, move, cancel, settingOff). */
	isActive(): boolean {
		return this.phase !== "idle";
	}

	/** ms until the long press fires, or null if no press is waiting for it. */
	msUntilLongPress(): number | null {
		return this.phase === "pressing" ? Math.max(0, LONG_PRESS_MS - this.heldMs) : null;
	}

	/** A pointer went down on a checkbox. A new press ends the previous one. */
	down(): PressOutput[] {
		this.phase = "pressing";
		this.heldMs = 0;
		this.clearSwallow();
		return [];
	}

	/** The pointer is `dx`, `dy` px from where the press began. */
	move(dx: number, dy: number): PressOutput[] {
		if (this.phase === "idle") return [];
		if (Math.sqrt(dx * dx + dy * dy) > MOVE_TOLERANCE_PX) {
			// A drag (text selection or a touch scroll): not a press any more.
			// After a long press the write is already done; nothing more to do.
			if (this.phase === "pressing") this.phase = "idle";
		}
		return [];
	}

	/** pointerup. */
	up(): PressOutput[] {
		const phase = this.phase;
		this.phase = "idle";
		if (phase === "pressing") {
			this.armSwallow(false);
			return ["advance", "swallowClick"];
		}
		if (phase === "fired") {
			this.armSwallow(true);
			return ["swallowClick"];
		}
		return [];
	}

	/** pointercancel: the browser took the gesture (a scroll, a system menu). */
	cancel(): PressOutput[] {
		this.phase = "idle";
		this.clearSwallow();
		return [];
	}

	/** A `click` event reached the document. */
	click(): PressOutput[] {
		if (this.swallowLeftMs === null) return [];
		this.clearSwallow();
		return ["swallowClick"];
	}

	/** A `contextmenu` event. */
	contextmenu(): PressOutput[] {
		if (this.phase !== "idle" || (this.swallowLeftMs !== null && this.swallowIsLong)) {
			return ["preventContextMenu"];
		}
		return [];
	}

	/** Let `ms` of real time pass. */
	tick(ms: number): PressOutput[] {
		if (ms <= 0) return [];
		if (this.swallowLeftMs !== null) {
			this.swallowLeftMs -= ms;
			if (this.swallowLeftMs <= 0) this.clearSwallow();
		}
		if (this.phase === "pressing") {
			this.heldMs += ms;
			if (this.heldMs >= LONG_PRESS_MS) {
				this.phase = "fired";
				return ["cancelTask"];
			}
		}
		return [];
	}

	/** The "Status cycle" setting went off: drop everything, write nothing. */
	settingOff(): PressOutput[] {
		this.phase = "idle";
		this.clearSwallow();
		return [];
	}

	private armSwallow(long: boolean): void {
		this.swallowLeftMs = CLICK_SWALLOW_MS;
		this.swallowIsLong = long;
	}

	private clearSwallow(): void {
		this.swallowLeftMs = null;
		this.swallowIsLong = false;
	}
}
