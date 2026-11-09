import { describe, expect, it } from "vitest";
import { PressController, type PressOutput } from "../../src/status-cycle/press-controller";

/** Drive a controller like the wire does: inputs in, outputs collected. */
function rig() {
	const c = new PressController();
	const all: PressOutput[] = [];
	const take = (out: PressOutput[]) => {
		all.push(...out);
		return out;
	};
	return {
		c,
		all,
		down: () => take(c.down()),
		move: (dx: number, dy: number) => take(c.move(dx, dy)),
		up: () => take(c.up()),
		cancel: () => take(c.cancel()),
		click: () => take(c.click()),
		contextmenu: () => take(c.contextmenu()),
		tick: (ms: number) => take(c.tick(ms)),
		settingOff: () => take(c.settingOff()),
	};
}

describe("short press", () => {
	it("release before 500 ms advances once and swallows the release", () => {
		const r = rig();
		r.down();
		r.tick(499);
		expect(r.up()).toEqual(["advance", "swallowClick"]);
		expect(r.all.filter((o) => o === "advance")).toHaveLength(1);
		expect(r.all).not.toContain("cancelTask");
	});

	it("an immediate release (0 ms) advances", () => {
		const r = rig();
		r.down();
		expect(r.up()).toContain("advance");
	});

	it("nothing more happens after the release", () => {
		const r = rig();
		r.down();
		r.up();
		expect(r.tick(5000)).toEqual([]);
		expect(r.up()).toEqual([]);
	});

	it("the click that follows is swallowed once", () => {
		const r = rig();
		r.down();
		r.up();
		expect(r.click()).toEqual(["swallowClick"]);
		expect(r.click()).toEqual([]);
	});
});

describe("long press", () => {
	it("cancelTask fires exactly once at 500 ms, before release", () => {
		const r = rig();
		r.down();
		expect(r.tick(499)).toEqual([]);
		expect(r.tick(1)).toEqual(["cancelTask"]);
		expect(r.tick(2000)).toEqual([]);
		expect(r.all.filter((o) => o === "cancelTask")).toHaveLength(1);
	});

	it("fires on a single 500 ms tick, and on an overshoot", () => {
		const a = rig();
		a.down();
		expect(a.tick(500)).toEqual(["cancelTask"]);
		const b = rig();
		b.down();
		expect(b.tick(731)).toEqual(["cancelTask"]);
	});

	it("the release after it is swallowed and does not advance", () => {
		const r = rig();
		r.down();
		r.tick(500);
		expect(r.up()).toEqual(["swallowClick"]);
		expect(r.all).not.toContain("advance");
	});

	it("the release of a very long hold still swallows its click (window counts from release)", () => {
		const r = rig();
		r.down();
		r.tick(500);
		r.tick(3000);
		r.up();
		expect(r.click()).toEqual(["swallowClick"]);
	});

	it("reports how long until it fires", () => {
		const r = rig();
		expect(r.c.msUntilLongPress()).toBeNull();
		r.down();
		expect(r.c.msUntilLongPress()).toBe(500);
		r.tick(120);
		expect(r.c.msUntilLongPress()).toBe(380);
		r.tick(380);
		expect(r.c.msUntilLongPress()).toBeNull();
	});

	it("a move within 5 px (and exactly 5) does not cancel it", () => {
		const r = rig();
		r.down();
		r.move(3, 4); // distance exactly 5
		r.move(-2, 1);
		expect(r.tick(500)).toEqual(["cancelTask"]);
	});
});

describe("movement cancels", () => {
	it.each([
		[6, 0],
		[0, -6],
		[4, 4], // sqrt(32) = 5.66
		[3.1, 4], // just over 5
	])("move(%f, %f) > 5 px: no advance, no cancelTask", (dx, dy) => {
		const r = rig();
		r.down();
		r.move(dx, dy);
		expect(r.c.isActive()).toBe(false);
		expect(r.c.msUntilLongPress()).toBeNull();
		expect(r.tick(1000)).toEqual([]);
		expect(r.up()).toEqual([]);
		expect(r.all).toEqual([]);
	});

	it("a move > 5 px after 300 ms still cancels", () => {
		const r = rig();
		r.down();
		r.tick(300);
		r.move(0, 20);
		r.tick(300);
		expect(r.up()).toEqual([]);
		expect(r.all).toEqual([]);
	});

	it("after a cancelled drag a release swallows nothing and no click is swallowed", () => {
		const r = rig();
		r.down();
		r.move(10, 0);
		r.up();
		expect(r.click()).toEqual([]);
	});

	it("a move after the long press fired does not undo it and the release is still swallowed", () => {
		const r = rig();
		r.down();
		r.tick(500);
		r.move(50, 50);
		expect(r.up()).toEqual(["swallowClick"]);
	});

	it("a move with no press is ignored", () => {
		const r = rig();
		expect(r.move(100, 100)).toEqual([]);
	});
});

describe("cancel (pointercancel) and settingOff", () => {
	it.each([0, 100, 499])("cancel at %i ms writes nothing", (ms) => {
		const r = rig();
		r.down();
		r.tick(ms);
		r.cancel();
		expect(r.tick(2000)).toEqual([]);
		expect(r.up()).toEqual([]);
		expect(r.all).toEqual([]);
	});

	it("cancel never advances (the old release-or-cancel handler did)", () => {
		const r = rig();
		r.down();
		expect(r.cancel()).not.toContain("advance");
	});

	it("cancel after the long press fired leaves no swallow armed", () => {
		const r = rig();
		r.down();
		r.tick(500);
		r.cancel();
		expect(r.click()).toEqual([]);
	});

	it("settingOff mid-press writes nothing, at any time", () => {
		for (const ms of [0, 250, 499]) {
			const r = rig();
			r.down();
			r.tick(ms);
			expect(r.settingOff()).toEqual([]);
			expect(r.tick(2000)).toEqual([]);
			expect(r.up()).toEqual([]);
			expect(r.all).toEqual([]);
		}
	});

	it("settingOff drops the swallow of a finished press", () => {
		const r = rig();
		r.down();
		r.up();
		r.settingOff();
		expect(r.click()).toEqual([]);
	});

	it("works again after settingOff", () => {
		const r = rig();
		r.down();
		r.settingOff();
		r.down();
		expect(r.up()).toContain("advance");
	});
});

describe("swallow window", () => {
	it("a click 599 ms after a short press is swallowed", () => {
		const r = rig();
		r.down();
		r.up();
		r.tick(599);
		expect(r.click()).toEqual(["swallowClick"]);
	});

	it("expires after 600 ms (short press)", () => {
		const r = rig();
		r.down();
		r.up();
		r.tick(600);
		expect(r.click()).toEqual([]);
	});

	it("expires after 600 ms (long press)", () => {
		const r = rig();
		r.down();
		r.tick(500);
		r.up();
		r.tick(600);
		expect(r.click()).toEqual([]);
	});

	it("expires across several ticks", () => {
		const r = rig();
		r.down();
		r.up();
		r.tick(300);
		r.tick(299);
		expect(r.c.click()).toEqual(["swallowClick"]);
		const s = rig();
		s.down();
		s.up();
		s.tick(300);
		s.tick(300);
		expect(s.c.click()).toEqual([]);
	});

	it("two quick presses (each with its own down) advance twice; each click is swallowed once", () => {
		const r = rig();
		r.down();
		r.up();
		r.tick(100);
		r.down(); // second press, first click never seen
		r.up();
		expect(r.all.filter((o) => o === "advance")).toHaveLength(2);
		expect(r.click()).toEqual(["swallowClick"]);
		expect(r.click()).toEqual([]);
	});

	it("a new down clears the previous press's swallow", () => {
		const r = rig();
		r.down();
		r.up();
		r.tick(100);
		r.down();
		expect(r.click()).toEqual([]);
	});

	it("a click with no press at all is not swallowed", () => {
		expect(rig().click()).toEqual([]);
	});
});

describe("contextmenu", () => {
	it("is prevented while a press is active", () => {
		const r = rig();
		r.down();
		expect(r.contextmenu()).toEqual(["preventContextMenu"]);
		r.tick(500);
		expect(r.contextmenu()).toEqual(["preventContextMenu"]);
	});

	it("is not prevented with no press", () => {
		expect(rig().contextmenu()).toEqual([]);
	});

	it("is prevented right after a long press release (inside the window), not after a short press", () => {
		const long = rig();
		long.down();
		long.tick(500);
		long.up();
		expect(long.contextmenu()).toEqual(["preventContextMenu"]);
		long.tick(600);
		expect(long.contextmenu()).toEqual([]);

		const short = rig();
		short.down();
		short.up();
		expect(short.contextmenu()).toEqual([]);
	});

	it("is not prevented after the press was cancelled or the setting turned off", () => {
		const a = rig();
		a.down();
		a.cancel();
		expect(a.contextmenu()).toEqual([]);
		const b = rig();
		b.down();
		b.settingOff();
		expect(b.contextmenu()).toEqual([]);
	});
});

describe("ticks", () => {
	it("zero and negative ticks do nothing", () => {
		const r = rig();
		r.down();
		expect(r.tick(0)).toEqual([]);
		expect(r.tick(-10)).toEqual([]);
		expect(r.c.msUntilLongPress()).toBe(500);
	});

	it("time before a press does not count towards it", () => {
		const r = rig();
		r.tick(10_000);
		r.down();
		expect(r.tick(499)).toEqual([]);
	});
});
