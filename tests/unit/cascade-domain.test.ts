import { describe, expect, it } from "vitest";
import {
	cascadeStatus,
	collectDescendantIndices,
	computeCascadeEdits,
	countOpenSubtasks,
	lineSpan,
	rewriteSubtask,
} from "../../src/domain/cascade";

const TODAY = "2026-11-09";
const ON = { stampsOn: true, today: TODAY };
const OFF = { stampsOn: false, today: TODAY };

/** Apply the edits to `lines` and return the new lines. */
function applied(lines: string[], parent: number, options = ON): string[] {
	const out = [...lines];
	for (const e of computeCascadeEdits(lines, parent, options)) out[e.line] = e.after;
	return out;
}

describe("collectDescendantIndices: the subtask rule", () => {
	const cases: Array<{ name: string; lines: string[]; parent: number; want: number[] }> = [
		{
			name: "deeper list lines, plain bullets included, at any depth",
			lines: ["- [x] p", "\t- [ ] a", "\t- note", "\t\t- [ ] b", "- [ ] sibling"],
			parent: 0,
			want: [1, 2, 3],
		},
		{
			name: "no lines after the parent",
			lines: ["- [x] p"],
			parent: 0,
			want: [],
		},
		{
			name: "block ends at a line at the parent's indent",
			lines: ["- [x] p", "\t- [ ] a", "- [ ] sibling", "\t- [ ] belongs to sibling"],
			parent: 0,
			want: [1],
		},
		{
			name: "blank lines and deeper non-list text are skipped",
			lines: ["- [x] p", "", "\tsome text", "\t- [ ] a", "   ", "\t\tmore text", "\t- [ ] b"],
			parent: 0,
			want: [3, 6],
		},
		{
			name: "block ends at shallower non-list text",
			lines: ["\t- [x] p", "\t\t- [ ] a", "text at column 0", "\t\t- [ ] after"],
			parent: 0,
			want: [1],
		},
		{
			name: "block ends at non-list text at the parent's own indent",
			lines: ["- [x] p", "\t- [ ] a", "plain", "\t- [ ] b"],
			parent: 0,
			want: [1],
		},
		{
			name: "E5: four spaces equal one tab, so a 4-space list line is a sibling",
			lines: ["\t- [x] p", "    - [ ] sibling", "\t\t- [ ] later"],
			parent: 0,
			want: [],
		},
		{
			name: "E5: tab plus two spaces (6 columns) under a tab parent is a subtask",
			lines: ["\t- [x] p", "\t  - [ ] child"],
			parent: 0,
			want: [1],
		},
		{
			name: "E5: spaces under a space-indented parent, tab child deeper",
			lines: ["  - [x] p", "\t- [ ] child", "    - [ ] four spaces is deeper than two"],
			parent: 0,
			want: [1, 2],
		},
		{
			name: "E16: tasks in a backtick fence are not counted and the fence does not end the block",
			lines: ["- [x] p", "\t```", "\t- [ ] fake", "\t```", "\t- [ ] real"],
			parent: 0,
			want: [4],
		},
		{
			name: "E16: a tilde fence, with the fence lines at the parent's indent",
			lines: ["- [x] p", "~~~", "- [ ] fake", "~~~", "\t- [ ] real"],
			parent: 0,
			want: [4],
		},
		{
			name: "an unclosed fence hides the rest of the note",
			lines: ["- [x] p", "\t- [ ] a", "\t```", "\t- [ ] hidden"],
			parent: 0,
			want: [1],
		},
		{
			name: "a parent inside a fence has no subtasks",
			lines: ["```", "- [x] p", "\t- [ ] a", "```"],
			parent: 1,
			want: [],
		},
		{
			name: "frontmatter is skipped",
			lines: ["---", "- [ ] not a task", "---", "- [x] p", "\t- [ ] a"],
			parent: 3,
			want: [4],
		},
		{
			name: "blockquote prefix: children are deeper than the parent",
			lines: ["> - [x] p", ">   - [ ] child", "> - [ ] sibling"],
			parent: 0,
			want: [1],
		},
		{
			name: "blockquote with ordered markers",
			lines: ["> 1. [x] p", ">    1. [ ] child", ">    - [ ] other child"],
			parent: 0,
			want: [1, 2],
		},
		{
			name: "leaving the blockquote ends the block",
			lines: ["> - [x] p", ">   - [ ] child", "  - [ ] outside", "text"],
			parent: 0,
			want: [1],
		},
		{
			name: "a margin-level quote after a list parent is not part of the item",
			lines: ["- [x] p", "> - [ ] quoted"],
			parent: 0,
			want: [],
		},
		{
			name: "a quote indented past the parent's marker is part of the item",
			lines: ["- [x] p", "  > - [ ] quoted", "> - [ ] margin quote"],
			parent: 0,
			want: [1],
		},
		{
			name: "a nested quote at the parent's own indent inside a quote ends the block",
			lines: ["> - [x] p", "> > - [ ] nested"],
			parent: 0,
			want: [],
		},
		{
			name: "a nested quote indented past the parent's marker inside a quote is part of the item",
			lines: ["> - [x] p", ">   > - [ ] nested"],
			parent: 0,
			want: [1],
		},
		{
			name: "a bare '>' line is blank",
			lines: ["> - [x] p", ">", ">   - [ ] child"],
			parent: 0,
			want: [2],
		},
		{
			name: "ordered markers, both 1. and 1)",
			lines: ["1. [x] p", "   1) [ ] a", "   2. [ ] b"],
			parent: 0,
			want: [1, 2],
		},
		{
			name: "the parent is not a list item",
			lines: ["text", "\t- [ ] a"],
			parent: 0,
			want: [],
		},
		{
			name: "parent index out of range",
			lines: ["- [x] p"],
			parent: 5,
			want: [],
		},
		{
			name: "negative parent index",
			lines: ["- [x] p"],
			parent: -1,
			want: [],
		},
	];
	it.each(cases)("$name", ({ lines, parent, want }) => {
		expect(collectDescendantIndices(lines, parent)).toEqual(want);
	});
});

describe("countOpenSubtasks: the open-status rule", () => {
	const cases: Array<[string, string[], number]> = [
		["none", ["- [x] p", "- [ ] other"], 0],
		["all closed (x, X, -)", ["- [x] p", "\t- [x] a", "\t- [X] b", "\t- [-] c"], 0],
		["only plain bullets", ["- [x] p", "\t- a", "\t- b"], 0],
		["' ', '/' and unknown chars are open", ["- [x] p", "\t- [ ] a", "\t- [/] b", "\t- [?] c"], 3],
		[
			"a stale stamp on an open task does not close it",
			["- [x] p", "\t- [ ] a ✅ 2026-10-01", "\t- [/] b ❌ 2026-10-01"],
			2,
		],
		["a closed task with a stamp is closed", ["- [x] p", "\t- [x] a ✅ 2026-10-01"], 0],
		[
			"open descendants under a closed subtask and a bullet count",
			["- [x] p", "\t- [x] done", "\t\t- [ ] deep", "\t- note", "\t\t- [ ] deeper"],
			2,
		],
		["fenced tasks do not count", ["- [x] p", "\t```", "\t- [ ] fake", "\t```"], 0],
		["after the block does not count", ["- [x] p", "\t- [ ] a", "- [ ] b"], 1],
		["a blockquote ordered subtask", ["> 1. [x] p", ">    1. [ ] a"], 1],
	];
	it.each(cases)("%s", (_name, lines, want) => {
		expect(countOpenSubtasks(lines, 0)).toBe(want);
	});

	it("G17: counts only the descendants of the subtask that closed", () => {
		const lines = [
			"- [ ] top",
			"\t- [x] mid",
			"\t\t- [ ] mid child",
			"\t- [ ] mid sibling",
			"\t\t- [ ] sibling child",
		];
		expect(countOpenSubtasks(lines, 1)).toBe(1);
		expect(countOpenSubtasks(lines, 3)).toBe(1);
		expect(countOpenSubtasks(lines, 0)).toBe(3);
	});
});

describe("cascadeStatus", () => {
	it.each([
		["- [x] a", "x"],
		["- [X] a", "x"],
		["- [-] a", "-"],
		["- [ ] a", null],
		["- [/] a", null],
		["- [?] a", null],
		["- not a task", null],
	])("%j -> %j", (line, want) => {
		expect(cascadeStatus(line)).toBe(want);
	});
});

describe("rewriteSubtask: the rewrite rule", () => {
	const cases: Array<[string, string, string, { stampsOn: boolean; today: string | Date }, string]> = [
		["done, stamps on", "\t- [ ] a", "x", ON, "\t- [x] a ✅ 2026-11-09"],
		["cancelled, stamps on", "\t- [ ] a", "-", ON, "\t- [-] a ❌ 2026-11-09"],
		["in progress becomes done", "- [/] a", "x", ON, "- [x] a ✅ 2026-11-09"],
		["unknown becomes done", "- [?] a", "x", ON, "- [x] a ✅ 2026-11-09"],
		["stamp goes before ^blockid", "- [ ] a ^b1", "x", ON, "- [x] a ✅ 2026-11-09 ^b1"],
		[
			"the opposite stamp is replaced (with its space)",
			"- [ ] a ❌ 2026-10-01",
			"x",
			ON,
			"- [x] a ✅ 2026-11-09",
		],
		[
			"a stale same-kind stamp is replaced by today's",
			"- [ ] a ✅ 2026-10-01",
			"x",
			ON,
			"- [x] a ✅ 2026-11-09",
		],
		[
			"a bare chip emoji is kept and not counted as a stamp",
			"- [ ] a <span>✅</span>",
			"x",
			ON,
			"- [x] a <span>✅</span> ✅ 2026-11-09",
		],
		["stamps off: status char only", "- [ ] a ^b1", "x", OFF, "- [x] a ^b1"],
		["stamps off: no emoji, trailing space kept", "- [ ] a  ", "-", OFF, "- [-] a  "],
		[
			"stamps off leaves a stale stamp alone",
			"- [ ] a ❌ 2026-10-01",
			"x",
			OFF,
			"- [x] a ❌ 2026-10-01",
		],
		["a Date for today uses the local date", "- [ ] a", "x", { stampsOn: true, today: new Date(2026, 10, 9, 23, 59) }, "- [x] a ✅ 2026-11-09"],
		["blockquote prefix intact", "> - [ ] a", "x", ON, "> - [x] a ✅ 2026-11-09"],
		["ordered marker intact", "   2) [ ] a", "x", ON, "   2) [x] a ✅ 2026-11-09"],
		["not a task: unchanged", "- a", "x", ON, "- a"],
	];
	it.each(cases)("%s", (_name, line, status, options, want) => {
		expect(rewriteSubtask(line, status, options)).toBe(want);
	});

	it("CRLF: a trailing CR stays at the end of the line", () => {
		expect(rewriteSubtask("\t- [ ] a\r", "x", ON)).toBe("\t- [x] a ✅ 2026-11-09\r");
		expect(rewriteSubtask("\t- [ ] a ^b1\r", "x", ON)).toBe("\t- [x] a ✅ 2026-11-09 ^b1\r");
		expect(rewriteSubtask("\t- [ ] a\r", "-", OFF)).toBe("\t- [-] a\r");
	});
});

describe("computeCascadeEdits", () => {
	it("GP fixture: Ship release closed as done", () => {
		const lines = [
			"- [x] Ship release ✅ 2026-11-09 ^rel1",
			"\t- [ ] Write notes",
			"\t- Notes",
			"\t\t- [ ] Proofread",
			"\t- [x] Tag build ✅ 2026-11-08",
			"- [ ] Book venue",
		];
		const edits = computeCascadeEdits(lines, 0, ON);
		expect(edits.map((e) => e.line)).toEqual([1, 3]);
		expect(applied(lines, 0)).toEqual([
			"- [x] Ship release ✅ 2026-11-09 ^rel1",
			"\t- [x] Write notes ✅ 2026-11-09",
			"\t- Notes",
			"\t\t- [x] Proofread ✅ 2026-11-09",
			"\t- [x] Tag build ✅ 2026-11-08",
			"- [ ] Book venue",
		]);
	});

	it("an upper-case X parent gives a lower-case x", () => {
		expect(applied(["- [X] p", "\t- [ ] a"], 0)[1]).toBe("\t- [x] a ✅ 2026-11-09");
	});

	it("a cancelled parent gives '-' and a cancelled stamp", () => {
		expect(applied(["- [-] p", "\t- [ ] a", "\t- [/] b"], 0)).toEqual([
			"- [-] p",
			"\t- [-] a ❌ 2026-11-09",
			"\t- [-] b ❌ 2026-11-09",
		]);
	});

	it("an open, in-progress or unknown parent changes nothing", () => {
		for (const status of [" ", "/", "?"]) {
			expect(computeCascadeEdits([`- [${status}] p`, "\t- [ ] a"], 0, ON)).toEqual([]);
		}
	});

	it("not a task, or an out-of-range parent: nothing", () => {
		expect(computeCascadeEdits(["- p", "\t- [ ] a"], 0, ON)).toEqual([]);
		expect(computeCascadeEdits(["- [x] p"], 3, ON)).toEqual([]);
		expect(computeCascadeEdits(["- [x] p"], -1, ON)).toEqual([]);
	});

	it("stamps off: only the status char changes and no emoji appears", () => {
		const lines = ["- [x] p", "\t- [ ] a ^b1", "\t- [/] b"];
		expect(applied(lines, 0, OFF)).toEqual(["- [x] p", "\t- [x] a ^b1", "\t- [x] b"]);
	});

	it("E16: a fenced '- [ ]' under the parent is untouched and a real subtask after it closes", () => {
		const lines = ["- [x] p", "\t```", "\t- [ ] fake", "\t```", "\t- [ ] real"];
		expect(applied(lines, 0)).toEqual([
			"- [x] p",
			"\t```",
			"\t- [ ] fake",
			"\t```",
			"\t- [x] real ✅ 2026-11-09",
		]);
	});

	it("lines after the block and a following sibling stay untouched", () => {
		const lines = ["- [x] p", "\t- [ ] a", "", "text", "\t- [ ] after text", "- [ ] sibling"];
		expect(applied(lines, 0)).toEqual([
			"- [x] p",
			"\t- [x] a ✅ 2026-11-09",
			"",
			"text",
			"\t- [ ] after text",
			"- [ ] sibling",
		]);
	});

	it("G17: closing a subtask edits only its own descendants", () => {
		const lines = ["- [ ] top", "\t- [x] mid", "\t\t- [ ] mid child", "\t- [ ] mid sibling"];
		expect(applied(lines, 1)).toEqual([
			"- [ ] top",
			"\t- [x] mid",
			"\t\t- [x] mid child ✅ 2026-11-09",
			"\t- [ ] mid sibling",
		]);
	});

	it("blockquote and ordered subtasks close with their prefix intact", () => {
		const lines = ["> - [x] p", ">   - [ ] a", ">   1. [ ] b", "> 1. [ ] sibling"];
		expect(applied(lines, 0)).toEqual([
			"> - [x] p",
			">   - [x] a ✅ 2026-11-09",
			">   1. [x] b ✅ 2026-11-09",
			"> 1. [ ] sibling",
		]);
	});

	it("frontmatter lines are never edited", () => {
		const lines = ["---", "- [ ] in yaml", "---", "- [x] p", "\t- [ ] a"];
		expect(applied(lines, 3)).toEqual([
			"---",
			"- [ ] in yaml",
			"---",
			"- [x] p",
			"\t- [x] a ✅ 2026-11-09",
		]);
	});

	it("F4: each edited line differs only in the checkbox char, a stamp and the space before it", () => {
		const lines = [
			"- [x] p",
			"\t- [ ] a",
			"\t- [ ] b ^blk",
			"\t- [ ] c ❌ 2026-10-01",
			"\t- [/] d  ",
		];
		const edits = computeCascadeEdits(lines, 0, ON);
		expect(edits.map((e) => [e.before, e.after])).toEqual([
			["\t- [ ] a", "\t- [x] a ✅ 2026-11-09"],
			["\t- [ ] b ^blk", "\t- [x] b ✅ 2026-11-09 ^blk"],
			["\t- [ ] c ❌ 2026-10-01", "\t- [x] c ✅ 2026-11-09"],
			["\t- [/] d  ", "\t- [x] d ✅ 2026-11-09"],
		]);
		// With the status char put back and the new stamp taken out, only the
		// old stamp (c) and the whitespace before the new stamp (d) can differ.
		for (const e of edits) {
			const char = e.before.match(/\[(.)\]/)![1];
			const back = e.after.replace("[x]", `[${char}]`).replace(" ✅ 2026-11-09", "");
			expect(back.replace(/\s+$/, "")).toBe(
				e.before.replace(" ❌ 2026-10-01", "").replace(/\s+$/, "")
			);
		}
		// Stamps off: the only change is the status char, trailing space kept.
		const off = computeCascadeEdits(lines, 0, OFF);
		expect(off.map((e) => e.after)).toEqual([
			"\t- [x] a",
			"\t- [x] b ^blk",
			"\t- [x] c ❌ 2026-10-01",
			"\t- [x] d  ",
		]);
	});

	it("CRLF: every edited line keeps its trailing CR", () => {
		const lines = ["- [x] p\r", "\t- [ ] a\r", "\t- [ ] b ^id\r", "\t- plain\r"];
		const edits = computeCascadeEdits(lines, 0, ON);
		expect(edits.map((e) => e.after)).toEqual([
			"\t- [x] a ✅ 2026-11-09\r",
			"\t- [x] b ✅ 2026-11-09 ^id\r",
		]);
		for (const e of edits) expect(e.after.endsWith("\r")).toBe(true);
		const off = computeCascadeEdits(lines, 0, OFF);
		expect(off.map((e) => e.after)).toEqual(["\t- [x] a\r", "\t- [x] b ^id\r"]);
	});

	it("does not read the clock: the same input gives the same output", () => {
		const lines = ["- [x] p", "\t- [ ] a"];
		expect(computeCascadeEdits(lines, 0, ON)).toEqual(computeCascadeEdits(lines, 0, ON));
		expect(computeCascadeEdits(lines, 0, { stampsOn: true, today: "2030-01-02" })[0].after).toBe(
			"\t- [x] a ✅ 2030-01-02"
		);
	});
});

describe("lineSpan", () => {
	it("is null when nothing changed", () => {
		expect(lineSpan("- [ ] a", "- [ ] a")).toBeNull();
	});

	it("covers just the checkbox char for a status-only change", () => {
		expect(lineSpan("\t- [ ] a", "\t- [x] a")).toEqual({ fromCh: 4, toCh: 5, text: "x" });
	});

	it("covers the char through the stamp, never a shared CR", () => {
		const before = "\t- [ ] a\r";
		const after = "\t- [x] a ✅ 2026-11-09\r";
		const span = lineSpan(before, after);
		expect(span).not.toBeNull();
		const { fromCh, toCh, text } = span!;
		expect(before.slice(0, fromCh) + text + before.slice(toCh)).toBe(after);
		expect(toCh).toBeLessThanOrEqual(before.length - 1);
	});

	it("applying the span to the before text always gives the after text", () => {
		const pairs: Array<[string, string]> = [
			["- [ ] a ^b", "- [x] a ✅ 2026-11-09 ^b"],
			["- [ ] a ❌ 2026-10-01", "- [x] a ✅ 2026-11-09"],
			["- [ ] aa", "- [ ] aaa"],
			["- [ ] aaa", "- [ ] aa"],
			["", "x"],
		];
		for (const [before, after] of pairs) {
			const s = lineSpan(before, after)!;
			expect(before.slice(0, s.fromCh) + s.text + before.slice(s.toCh)).toBe(after);
		}
	});
});
