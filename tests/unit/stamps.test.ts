import { describe, expect, it } from "vitest";
import {
	addStamp,
	applyStampTransition,
	findStamps,
	removeStamps,
} from "../../src/domain/stamps";
import { statusKind } from "../../src/domain/status-sequence";

const TODAY = "2026-11-09";

describe("findStamps", () => {
	it("finds done and cancelled stamps with position", () => {
		const line = "- [x] a ✅ 2026-11-01 b ❌ 2026-11-02";
		expect(findStamps(line)).toEqual([
			{ kind: "done", date: "2026-11-01", index: 8, length: 12 },
			{ kind: "cancelled", date: "2026-11-02", index: 23, length: 12 },
		]);
	});

	it("finds nothing on a line with no stamp", () => {
		expect(findStamps("- [ ] plain")).toEqual([]);
	});

	it("needs exactly one space and a full date", () => {
		expect(findStamps("a ✅2026-11-01")).toEqual([]);
		expect(findStamps("a ✅  2026-11-01")).toEqual([]);
		expect(findStamps("a ✅ 2026-11")).toEqual([]);
		expect(findStamps("a ✅ 26-11-01")).toEqual([]);
	});

	it("needs a word boundary after the date", () => {
		expect(findStamps("a ✅ 2026-11-01T10:00")).toEqual([]);
		expect(findStamps("a ✅ 2026-11-019")).toEqual([]);
		expect(findStamps("a ✅ 2026-11-01x")).toEqual([]);
		expect(findStamps("a ✅ 2026-11-01.")).toHaveLength(1);
		expect(findStamps("a ✅ 2026-11-01)")).toHaveLength(1);
	});

	it("does not find a bare emoji (G11/E2)", () => {
		expect(findStamps('- [ ] a <span class="chip">✅</span>')).toEqual([]);
		expect(findStamps("- [x] a ✅")).toEqual([]);
		expect(findStamps("- [x] a ✅ done")).toEqual([]);
		expect(findStamps("- [-] a ❌ no date")).toEqual([]);
	});
});

describe("removeStamps", () => {
	it("removes a stamp with the single space before it", () => {
		expect(removeStamps("- [x] a ✅ 2026-11-01")).toBe("- [x] a");
	});

	it("removes every stamp, duplicates included", () => {
		expect(
			removeStamps("- [x] a ✅ 2026-11-01 ✅ 2026-11-02 ❌ 2026-11-03 ^id")
		).toBe("- [x] a ^id");
	});

	it("removes adjacent stamps with no space between them", () => {
		expect(removeStamps("a ✅ 2026-11-01✅ 2026-11-02 z")).toBe("a z");
	});

	it("removes a stamp at the start of the text with no space before", () => {
		expect(removeStamps("✅ 2026-11-01 a")).toBe(" a");
	});

	it("takes only one of several spaces before the stamp", () => {
		expect(removeStamps("a   ✅ 2026-11-01 ^id")).toBe("a   ^id");
	});

	it("leaves a line with no stamp untouched, trailing spaces included", () => {
		expect(removeStamps("- [ ] a   ")).toBe("- [ ] a   ");
	});

	it("keeps bare-emoji chips (G11/E2)", () => {
		const line = '- [x] a <span class="chip">✅</span> ✅ 2026-11-01';
		expect(removeStamps(line)).toBe('- [x] a <span class="chip">✅</span>');
		expect(removeStamps("- [x] a ✅")).toBe("- [x] a ✅");
	});

	it("keeps a trailing \\r (E8)", () => {
		expect(removeStamps("- [x] a ✅ 2026-11-01\r")).toBe("- [x] a\r");
	});

	it("keeps unicode text and other emoji", () => {
		expect(removeStamps("- [x] café 🎉 日本語 ✅ 2026-11-01 ^id")).toBe(
			"- [x] café 🎉 日本語 ^id"
		);
	});
});

describe("addStamp", () => {
	it("adds at the end of the line", () => {
		expect(addStamp("- [x] a", "done", TODAY)).toBe("- [x] a ✅ 2026-11-09");
		expect(addStamp("- [-] a", "cancelled", TODAY)).toBe(
			"- [-] a ❌ 2026-11-09"
		);
	});

	it("goes before a trailing block id (E1)", () => {
		expect(addStamp("- [x] Ship release ^rel1", "done", TODAY)).toBe(
			"- [x] Ship release ✅ 2026-11-09 ^rel1"
		);
		expect(addStamp("- [x] a ^b-2", "cancelled", TODAY)).toBe(
			"- [x] a ❌ 2026-11-09 ^b-2"
		);
	});

	it("does not treat a ^ in the middle of the text as a block id", () => {
		expect(addStamp("- [x] a ^b c", "done", TODAY)).toBe(
			"- [x] a ^b c ✅ 2026-11-09"
		);
	});

	it("keeps trailing whitespace after a block id and the gap before it", () => {
		expect(addStamp("- [x] a  ^id  ", "done", TODAY)).toBe(
			"- [x] a ✅ 2026-11-09  ^id  "
		);
	});

	it("collapses only the whitespace directly before the stamp (E4)", () => {
		expect(addStamp("- [x] a   b   ", "done", TODAY)).toBe(
			"- [x] a   b ✅ 2026-11-09"
		);
		expect(addStamp("- [x] a \t ^id", "done", TODAY)).toBe(
			"- [x] a ✅ 2026-11-09 \t ^id"
		);
	});

	it("keeps a trailing \\r at the very end (E8)", () => {
		expect(addStamp("- [x] a\r", "done", TODAY)).toBe(
			"- [x] a ✅ 2026-11-09\r"
		);
		expect(addStamp("- [x] a ^id\r", "done", TODAY)).toBe(
			"- [x] a ✅ 2026-11-09 ^id\r"
		);
		expect(addStamp("- [x] a  \r", "done", TODAY)).toBe(
			"- [x] a ✅ 2026-11-09\r"
		);
	});

	it("works on a task with no text", () => {
		expect(addStamp("- [x]", "done", TODAY)).toBe("- [x] ✅ 2026-11-09");
	});

	it("rejects a date that is not YYYY-MM-DD", () => {
		expect(() => addStamp("- [x] a", "done", "2026-1-9")).toThrow(/YYYY-MM-DD/);
		expect(() => addStamp("- [x] a", "done", "2026-11-09T10:00")).toThrow();
		expect(() => addStamp("- [x] a", "done", "")).toThrow();
	});

	it("produces something findStamps sees", () => {
		const out = addStamp("- [x] a ^id", "done", TODAY);
		expect(findStamps(out).map((s) => [s.kind, s.date])).toEqual([
			["done", TODAY],
		]);
	});
});

// One representative char per kind, plus an unknown char.
const SAMPLE: [string, string][] = [
	["open", " "],
	["inProgress", "/"],
	["done", "x"],
	["cancelled", "-"],
	["unknown", "?"],
];

function lineWith(c: string, stamp = "") {
	return `- [${c}] Task${stamp} ^id`;
}

describe("applyStampTransition: every pair of kinds", () => {
	for (const [fromName, from] of SAMPLE) {
		for (const [toName, to] of SAMPLE) {
			const fromKind = statusKind(from);
			const toKind = statusKind(to);
			it(`${fromName} -> ${toName}`, () => {
				const bare = lineWith(to);
				const stamped = lineWith(to, " ✅ 2026-11-01");
				const crossStamped = lineWith(to, " ❌ 2026-11-01");

				if (fromKind === toKind) {
					// G10: no change of kind, nothing changes and no date refresh.
					expect(applyStampTransition(bare, from, to, TODAY)).toBe(bare);
					expect(applyStampTransition(stamped, from, to, TODAY)).toBe(stamped);
					expect(applyStampTransition(crossStamped, from, to, TODAY)).toBe(
						crossStamped
					);
				} else if (toKind === "done") {
					// G7
					const want = lineWith(to, ` ✅ ${TODAY}`);
					expect(applyStampTransition(bare, from, to, TODAY)).toBe(want);
					expect(applyStampTransition(stamped, from, to, TODAY)).toBe(want);
					expect(applyStampTransition(crossStamped, from, to, TODAY)).toBe(want);
				} else if (toKind === "cancelled") {
					// G8
					const want = lineWith(to, ` ❌ ${TODAY}`);
					expect(applyStampTransition(bare, from, to, TODAY)).toBe(want);
					expect(applyStampTransition(stamped, from, to, TODAY)).toBe(want);
					expect(applyStampTransition(crossStamped, from, to, TODAY)).toBe(want);
				} else {
					// G9: reopen strips every stamp
					expect(applyStampTransition(bare, from, to, TODAY)).toBe(bare);
					expect(applyStampTransition(stamped, from, to, TODAY)).toBe(bare);
					expect(applyStampTransition(crossStamped, from, to, TODAY)).toBe(
						bare
					);
				}
			});
		}
	}
});

describe("applyStampTransition: named cases", () => {
	it("E1: done adds the stamp before the block id, reopen removes it", () => {
		const open = "- [ ] Ship release ^rel1";
		const done = applyStampTransition(
			"- [x] Ship release ^rel1",
			" ",
			"x",
			TODAY
		);
		expect(done).toBe("- [x] Ship release ✅ 2026-11-09 ^rel1");
		const reopened = applyStampTransition(
			"- [ ] Ship release ✅ 2026-11-09 ^rel1",
			"x",
			" ",
			TODAY
		);
		expect(reopened).toBe(open);
	});

	it("E3: an unknown status adds nothing", () => {
		expect(applyStampTransition("- [ ] a", "?", " ", TODAY)).toBe("- [ ] a");
		expect(applyStampTransition("- [?] a", " ", "?", TODAY)).toBe("- [?] a");
		expect(applyStampTransition("- [?] a", "x", "?", TODAY)).toBe("- [?] a");
	});

	it("G10: x -> X on a stamped line keeps the old date", () => {
		const line = "- [X] a ✅ 2026-11-01";
		expect(applyStampTransition(line, "x", "X", TODAY)).toBe(line);
		expect(applyStampTransition("- [x] a ✅ 2026-11-01", "X", "x", TODAY)).toBe(
			"- [x] a ✅ 2026-11-01"
		);
	});

	it("G8: x -> - swaps the check for a cross dated today", () => {
		expect(
			applyStampTransition("- [-] a ✅ 2026-11-01 ^id", "x", "-", TODAY)
		).toBe("- [-] a ❌ 2026-11-09 ^id");
	});

	it("G8: - -> x swaps the cross for a check dated today", () => {
		expect(
			applyStampTransition("- [x] a ❌ 2026-11-01", "-", "x", TODAY)
		).toBe("- [x] a ✅ 2026-11-09");
	});

	it("G9: reopening to a space or / strips every stamp including duplicates", () => {
		const line = "- [x] a ✅ 2026-11-01 ✅ 2026-11-02 ❌ 2026-11-03 ^id";
		expect(applyStampTransition(line, "x", " ", TODAY)).toBe("- [x] a ^id");
		expect(applyStampTransition(line, "-", "/", TODAY)).toBe("- [x] a ^id");
	});

	it("G7: closing replaces duplicate stamps with one", () => {
		expect(
			applyStampTransition(
				"- [x] a ✅ 2026-11-01 ✅ 2026-11-02",
				" ",
				"x",
				TODAY
			)
		).toBe("- [x] a ✅ 2026-11-09");
	});

	it("G11/E2: a bare emoji chip is not counted, removed or replaced", () => {
		const chip = '<span class="chip">✅</span>';
		expect(
			applyStampTransition(`- [x] a ${chip}`, " ", "x", TODAY)
		).toBe(`- [x] a ${chip} ✅ 2026-11-09`);
		expect(
			applyStampTransition(`- [ ] a ${chip} ✅ 2026-11-01`, "x", " ", TODAY)
		).toBe(`- [ ] a ${chip}`);
		expect(
			applyStampTransition(`- [ ] a ${chip}`, "x", " ", TODAY)
		).toBe(`- [ ] a ${chip}`);
	});

	it("keeps unicode text and emoji elsewhere on the line", () => {
		expect(
			applyStampTransition("- [x] café 🎉 ✅ done soon 日本語 ^id", " ", "x", TODAY)
		).toBe("- [x] café 🎉 ✅ done soon 日本語 ✅ 2026-11-09 ^id");
	});

	it("E4: trailing whitespace collapses only before an added stamp", () => {
		expect(applyStampTransition("- [x] a   b   ", " ", "x", TODAY)).toBe(
			"- [x] a   b ✅ 2026-11-09"
		);
		// nothing added, nothing changes
		expect(applyStampTransition("- [?] a   ", " ", "?", TODAY)).toBe(
			"- [?] a   "
		);
		expect(applyStampTransition("- [ ] a   ", "/", " ", TODAY)).toBe(
			"- [ ] a   "
		);
	});

	it("E8: a trailing \\r survives add and remove", () => {
		expect(applyStampTransition("- [x] a\r", " ", "x", TODAY)).toBe(
			"- [x] a ✅ 2026-11-09\r"
		);
		expect(
			applyStampTransition("- [ ] a ✅ 2026-11-01\r", "x", " ", TODAY)
		).toBe("- [ ] a\r");
	});

	it("accepts a Date for today and uses the local date", () => {
		expect(
			applyStampTransition("- [x] a", " ", "x", new Date(2026, 0, 5, 23, 59))
		).toBe("- [x] a ✅ 2026-01-05");
	});

	it("leaves a line that is not a task line unchanged", () => {
		expect(applyStampTransition("plain text", " ", "x", TODAY)).toBe("plain text");
		expect(applyStampTransition("- plain bullet", " ", "x", TODAY)).toBe(
			"- plain bullet"
		);
	});

	it("works on ordered and blockquote tasks", () => {
		expect(applyStampTransition("> 1. [x] a", " ", "x", TODAY)).toBe(
			"> 1. [x] a ✅ 2026-11-09"
		);
	});
});

describe("applyStampTransition: only stamps and the space before them change", () => {
	// Strip the stamp region (and the space before it) from both lines; what is
	// left must be identical.
	const stampRegion = / ?(?:✅|❌) \d{4}-\d{2}-\d{2}\b/g;
	const lines = [
		"- [ ] Ship release ^rel1",
		"- [ ] a   b   c",
		"\t- [ ] café 🎉 日本語 ^id",
		"> - [ ] callout task",
		"1) [ ] a <span>✅</span> b ^x-1",
		"- [ ] a\r",
	];
	const chars = [" ", "/", "x", "X", "-", "?"];
	for (const line of lines) {
		it(`${JSON.stringify(line)}`, () => {
			for (const from of chars) {
				for (const to of chars) {
					for (const startStamp of ["", " ✅ 2026-11-01", " ❌ 2026-10-01"]) {
						const input = line.replace(
							/( \^[\w-]+)?(\r?)$/,
							(_m, id: string | undefined, cr: string) =>
								`${startStamp}${id ?? ""}${cr}`
						);
						const out = applyStampTransition(input, from, to, TODAY);
						expect(out.replace(stampRegion, "")).toBe(
							input.replace(stampRegion, "")
						);
					}
				}
			}
		});
	}
});
