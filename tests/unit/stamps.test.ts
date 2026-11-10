import { describe, expect, it } from "vitest";
import {
	addStamp,
	applyStampTransition,
	findStamps,
	removeStamps,
} from "../../src/domain/stamps";
import { getCheckboxStatusChar } from "../../src/domain/line-classifier";
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

	it("takes every space and tab before the stamp, so none is left trailing", () => {
		expect(removeStamps("a   ✅ 2026-11-01 ^id")).toBe("a ^id");
		expect(removeStamps("- [x] a   ✅ 2026-11-01")).toBe("- [x] a");
		expect(removeStamps("- [x] a \t ✅ 2026-11-01")).toBe("- [x] a");
	});

	it("keeps the whitespace of the text after the stamp", () => {
		expect(removeStamps("a   ✅ 2026-11-01   b")).toBe("a   b");
	});

	it("finds and removes a stamp typed with the emoji presentation selector (U+FE0F)", () => {
		expect(findStamps("- [x] a ✅\uFE0F 2026-11-01")).toEqual([
			{ kind: "done", date: "2026-11-01", index: 8, length: 13 },
		]);
		expect(findStamps("- [-] a ❌\uFE0F 2026-11-01")[0]).toMatchObject({ kind: "cancelled" });
		expect(removeStamps("- [x] a ✅\uFE0F 2026-11-01 ^id")).toBe("- [x] a ^id");
		expect(removeStamps("- [x] a ❌\uFE0F 2026-11-01")).toBe("- [x] a");
	});

	it("reopening or re-closing a task with a U+FE0F stamp leaves exactly one stamp", () => {
		const line = "- [x] a ✅\uFE0F 2026-11-01 ^id";
		expect(applyStampTransition(line, "x", " ", TODAY)).toBe("- [ ] a ^id".replace("[ ]", "[x]"));
		expect(applyStampTransition(line, "x", "-", TODAY)).toBe("- [x] a ❌ 2026-11-09 ^id");
	});

	it("still treats a bare emoji with a selector and no date as no stamp", () => {
		expect(findStamps("- [x] a ✅\uFE0F")).toEqual([]);
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

// ---------------------------------------------------------------------------
// Rule table: every (from, to) pair x every line shape, with the expected text
// written out by hand (G7-G11, E1, E2, E4). "{c}" stands for the status char
// the line already carries (the `to` char); the date is the fixed 2026-11-09.
// ---------------------------------------------------------------------------

const CHARS = [" ", "/", "x", "X", "-", "?"] as const;
const KIND: Record<string, "open" | "progress" | "done" | "cancelled"> = {
	" ": "open",
	"?": "open",
	"/": "progress",
	x: "done",
	X: "done",
	"-": "cancelled",
};

interface Shape {
	name: string;
	input: string;
	/** Expected result when the new status is done / cancelled / open-or-in-progress. */
	done: string;
	cancelled: string;
	reopened: string;
}

const SHAPES: Shape[] = [
	{
		name: "plain",
		input: "- [{c}] Task",
		done: "- [{c}] Task ✅ 2026-11-09",
		cancelled: "- [{c}] Task ❌ 2026-11-09",
		reopened: "- [{c}] Task",
	},
	{
		name: "block id (E1)",
		input: "- [{c}] Ship release ^rel1",
		done: "- [{c}] Ship release ✅ 2026-11-09 ^rel1",
		cancelled: "- [{c}] Ship release ❌ 2026-11-09 ^rel1",
		reopened: "- [{c}] Ship release ^rel1",
	},
	{
		name: "^ that is not the last token is not a block id (E1)",
		input: "- [{c}] a ^b c",
		done: "- [{c}] a ^b c ✅ 2026-11-09",
		cancelled: "- [{c}] a ^b c ❌ 2026-11-09",
		reopened: "- [{c}] a ^b c",
	},
	{
		name: "chip with a bare emoji (G11/E2)",
		input: '- [{c}] Task <span class="chip">✅ Approved</span>',
		done: '- [{c}] Task <span class="chip">✅ Approved</span> ✅ 2026-11-09',
		cancelled: '- [{c}] Task <span class="chip">✅ Approved</span> ❌ 2026-11-09',
		reopened: '- [{c}] Task <span class="chip">✅ Approved</span>',
	},
	{
		name: "chip and a dated stamp (E2)",
		input: '- [{c}] Task <span class="chip">❌ Blocked</span> ✅ 2026-11-01',
		done: '- [{c}] Task <span class="chip">❌ Blocked</span> ✅ 2026-11-09',
		cancelled: '- [{c}] Task <span class="chip">❌ Blocked</span> ❌ 2026-11-09',
		reopened: '- [{c}] Task <span class="chip">❌ Blocked</span>',
	},
	{
		name: "trailing spaces (E4)",
		input: "- [{c}] Task  ",
		done: "- [{c}] Task ✅ 2026-11-09",
		cancelled: "- [{c}] Task ❌ 2026-11-09",
		reopened: "- [{c}] Task  ",
	},
	{
		name: "double spaces inside the line are kept (E4)",
		input: "- [{c}] a  b   c",
		done: "- [{c}] a  b   c ✅ 2026-11-09",
		cancelled: "- [{c}] a  b   c ❌ 2026-11-09",
		reopened: "- [{c}] a  b   c",
	},
	{
		name: "indentation is kept (E4)",
		input: "\t  - [{c}] Task",
		done: "\t  - [{c}] Task ✅ 2026-11-09",
		cancelled: "\t  - [{c}] Task ❌ 2026-11-09",
		reopened: "\t  - [{c}] Task",
	},
	{
		name: "existing done stamp",
		input: "- [{c}] Task ✅ 2026-11-01",
		done: "- [{c}] Task ✅ 2026-11-09",
		cancelled: "- [{c}] Task ❌ 2026-11-09",
		reopened: "- [{c}] Task",
	},
	{
		name: "existing cancelled stamp",
		input: "- [{c}] Task ❌ 2026-11-01",
		done: "- [{c}] Task ✅ 2026-11-09",
		cancelled: "- [{c}] Task ❌ 2026-11-09",
		reopened: "- [{c}] Task",
	},
	{
		name: "both stamps",
		input: "- [{c}] Task ✅ 2026-11-01 ❌ 2026-10-01",
		done: "- [{c}] Task ✅ 2026-11-09",
		cancelled: "- [{c}] Task ❌ 2026-11-09",
		reopened: "- [{c}] Task",
	},
	{
		name: "existing stamp before a block id",
		input: "- [{c}] Task ✅ 2026-11-01 ^id",
		done: "- [{c}] Task ✅ 2026-11-09 ^id",
		cancelled: "- [{c}] Task ❌ 2026-11-09 ^id",
		reopened: "- [{c}] Task ^id",
	},
	{
		name: "stamp in the middle of the line",
		input: "- [{c}] Task ✅ 2026-11-01 more text ^id",
		done: "- [{c}] Task more text ✅ 2026-11-09 ^id",
		cancelled: "- [{c}] Task more text ❌ 2026-11-09 ^id",
		reopened: "- [{c}] Task more text ^id",
	},
];

describe("applyStampTransition: rule table (every pair x every line shape)", () => {
	for (const shape of SHAPES) {
		describe(shape.name, () => {
			for (const from of CHARS) {
				for (const to of CHARS) {
					it(`${JSON.stringify(from)} -> ${JSON.stringify(to)}`, () => {
						const fill = (t: string) => t.replace("{c}", to);
						const input = fill(shape.input);
						let want: string;
						if (KIND[from] === KIND[to]) want = input; // G10: no kind change
						else if (KIND[to] === "done") want = fill(shape.done);
						else if (KIND[to] === "cancelled") want = fill(shape.cancelled);
						else want = fill(shape.reopened);
						expect(applyStampTransition(input, from, to, "2026-11-09")).toBe(want);
					});
				}
			}
		});
	}

	it("stampsOn:false changes nothing for any pair or shape (G20)", () => {
		for (const shape of SHAPES) {
			for (const from of CHARS) {
				for (const to of CHARS) {
					const input = shape.input.replace("{c}", to);
					expect(
						applyStampTransition(input, from, to, "2026-11-09", { stampsOn: false })
					).toBe(input);
				}
			}
		}
	});

	it("stampsOn:true is the default", () => {
		expect(
			applyStampTransition("- [x] a", " ", "x", "2026-11-09", { stampsOn: true })
		).toBe("- [x] a ✅ 2026-11-09");
	});

	it("zero-pads month and day from a Date", () => {
		expect(
			applyStampTransition("- [x] a", " ", "x", new Date(2026, 0, 5))
		).toBe("- [x] a ✅ 2026-01-05");
	});

	it("G10: a repeated close keeps the old date", () => {
		expect(
			applyStampTransition("- [X] a ✅ 2026-11-01", "x", "X", "2026-11-09")
		).toBe("- [X] a ✅ 2026-11-01");
	});
});

// ---------------------------------------------------------------------------
// F4 property: for random task lines and transitions the result differs from
// the input only in stamp tokens and the whitespace right before them.
// ---------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("applyStampTransition: property (F4)", () => {
	const stampToken = /[ \t]*(?:✅|❌)\uFE0F? \d{4}-\d{2}-\d{2}\b/g;
	/** Drop stamp tokens, then the whitespace run right before the end or a trailing block id. */
	const canon = (s: string) =>
		s.replace(stampToken, "").replace(/\s+(?=(?:\^[A-Za-z0-9-]+\s*)?$)/, "");

	const markers = ["-", "*", "+", "1.", "1)", "> -", "> > 2."];
	const indents = ["", "  ", "\t", "\t\t "];
	const pieces = [
		"word",
		"a  b",
		"café",
		"🎉",
		"日本語",
		'<span class="chip">✅ ok</span>',
		"✅",
		"❌ nope",
		"✅ 2026-11-01",
		"❌ 2026-10-31",
		"^b",
		"  ",
		"2026-11-09",
	];
	const ends = ["", " ", "   ", " ^rel1", "  ^id-2  ", "\r", " ✅ 2026-11-01", " ❌ 2026-11-01 ^x"];

	it("2000 random lines and transitions", () => {
		const rand = rng(61);
		const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
		for (let i = 0; i < 2000; i++) {
			const text = Array.from({ length: Math.floor(rand() * 5) }, () => pick(pieces)).join(" ");
			const from = pick(CHARS);
			const to = pick(CHARS);
			const before = `${pick(indents)}${pick(markers)} [${to}] ${text}${pick(ends)}`;
			const after = applyStampTransition(before, from, to, "2026-11-09");
			const ctx = JSON.stringify({ before, from, to, after });

			// The status char is never written.
			expect(getCheckboxStatusChar(after), ctx).toBe(getCheckboxStatusChar(before));
			// Only stamp tokens and the space before them differ.
			expect(canon(after), ctx).toBe(canon(before));
			// No kind change: nothing at all changes.
			if (KIND[from] === KIND[to]) expect(after, ctx).toBe(before);
			// A close leaves exactly one stamp, dated today; a reopen leaves none.
			const stamps = findStamps(after);
			if (KIND[from] !== KIND[to]) {
				if (KIND[to] === "done") expect(stamps.map((s) => [s.kind, s.date]), ctx).toEqual([["done", "2026-11-09"]]);
				else if (KIND[to] === "cancelled") expect(stamps.map((s) => [s.kind, s.date]), ctx).toEqual([["cancelled", "2026-11-09"]]);
				else expect(stamps, ctx).toEqual([]);
			}
			// Idempotent: applying the same transition to its own result changes nothing more.
			expect(applyStampTransition(after, to, to, "2026-11-10"), ctx).toBe(after);
		}
	});
});
