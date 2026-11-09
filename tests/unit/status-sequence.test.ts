import { describe, expect, it } from "vitest";
import {
	STATUS_SEQUENCE,
	isClosed,
	nextStatus,
	statusKind,
} from "../../src/domain/status-sequence";

describe("STATUS_SEQUENCE", () => {
	it("is the fixed cycle and frozen", () => {
		expect([...STATUS_SEQUENCE]).toEqual([" ", "/", "x", "-"]);
		expect(Object.isFrozen(STATUS_SEQUENCE)).toBe(true);
	});
});

describe("nextStatus", () => {
	it("goes round the full cycle twice", () => {
		const seen: string[] = [];
		let c: string = " ";
		for (let i = 0; i < 8; i++) {
			c = nextStatus(c);
			seen.push(c);
		}
		expect(seen).toEqual(["/", "x", "-", " ", "/", "x", "-", " "]);
	});

	it("treats X as x", () => {
		expect(nextStatus("X")).toBe("-");
	});

	it.each(["?", ">", "!", "", "xx", "  ", "✅"])(
		"sends unknown status %j to a space",
		(c) => {
			expect(nextStatus(c)).toBe(" ");
		}
	);
});

describe("statusKind and isClosed", () => {
	const table: [string, string, boolean][] = [
		[" ", "open", false],
		["/", "inProgress", false],
		["x", "done", true],
		["X", "done", true],
		["-", "cancelled", true],
		["?", "open", false],
		[">", "open", false],
		["", "open", false],
	];
	it.each(table)("%j is %s (closed: %s)", (c, kind, closed) => {
		expect(statusKind(c)).toBe(kind);
		expect(isClosed(c)).toBe(closed);
	});
});
