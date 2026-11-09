import { afterEach, describe, expect, it, vi } from "vitest";
import { toYyyyMmDd } from "../../src/domain/dates";

afterEach(() => {
	vi.useRealTimers();
});

describe("toYyyyMmDd", () => {
	it("zero-pads a single-digit month and day", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0));
		expect(toYyyyMmDd(new Date())).toBe("2026-01-05");
	});

	it("formats 31 December", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 11, 31, 12, 0, 0));
		expect(toYyyyMmDd(new Date())).toBe("2026-12-31");
	});

	it("uses the local date just before midnight", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 10, 9, 23, 59, 59, 999));
		expect(toYyyyMmDd(new Date())).toBe("2026-11-09");
	});

	it("rolls over at local midnight", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59, 999));
		const before = toYyyyMmDd(new Date());
		vi.advanceTimersByTime(1);
		expect(before).toBe("2026-12-31");
		expect(toYyyyMmDd(new Date())).toBe("2027-01-01");
	});

	it("formats a date passed in, not the clock", () => {
		expect(toYyyyMmDd(new Date(2024, 1, 29, 0, 0, 0))).toBe("2024-02-29");
	});
});
