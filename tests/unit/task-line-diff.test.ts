import { describe, expect, it } from "vitest";
import {
	contentKey,
	diffTaskLines,
	mergeHunks,
	type LineHunk,
} from "../../src/domain/task-line-diff";

/**
 * One hunk from the first to the last line that differs, like a single
 * CodeMirror change would give. A pure insertion (or deletion) also touches
 * the line it lands in, because the range includes the line break.
 */
function hunkFor(oldLines: string[], newLines: string[]): LineHunk {
	let p = 0;
	while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
	let s = 0;
	while (
		s < oldLines.length - p &&
		s < newLines.length - p &&
		oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
	) {
		s++;
	}
	const clamp = (n: number, len: number) => Math.max(0, Math.min(n, len - 1));
	const oldEnd = oldLines.length - s - 1;
	const newEnd = newLines.length - s - 1;
	const oldHas = oldEnd >= p;
	const newHas = newEnd >= p;
	return {
		oldFrom: clamp(p, oldLines.length),
		oldTo: clamp(newHas ? Math.max(p, oldEnd) : oldEnd + 1, oldLines.length),
		newFrom: clamp(p, newLines.length),
		newTo: clamp(oldHas ? Math.max(p, newEnd) : newEnd + 1, newLines.length),
	};
}

function diff(oldLines: string[], newLines: string[]) {
	return diffTaskLines(oldLines, newLines, [hunkFor(oldLines, newLines)]);
}

describe("contentKey", () => {
	it("masks the status char and the stamps and trims the end", () => {
		expect(contentKey("- [x] Ship ✅ 2026-11-01  ")).toBe("- [ ] Ship");
		expect(contentKey("- [ ] Ship")).toBe("- [ ] Ship");
		expect(contentKey("\t- [-] a  b ❌ 2026-01-01 ^id")).toBe("\t- [ ] a  b ^id");
	});

	it("keeps a bare emoji", () => {
		expect(contentKey("- [x] a ✅")).toBe("- [ ] a ✅");
	});
});

describe("single and multi-line toggles", () => {
	it("one toggle", () => {
		expect(diff(["- [ ] a"], ["- [x] a"])).toEqual([
			{ line: 0, lineText: "- [x] a", from: " ", to: "x" },
		]);
	});

	it("only the toggled line of several", () => {
		const before = ["intro", "- [ ] a", "- [ ] b", "- [ ] c"];
		const after = ["intro", "- [ ] a", "- [/] b", "- [ ] c"];
		expect(diff(before, after)).toEqual([
			{ line: 2, lineText: "- [/] b", from: " ", to: "/" },
		]);
	});

	it("separate hunks, even given out of order: ascending line order", () => {
		const before = ["- [ ] a", "x", "- [ ] b", "y", "- [ ] c"];
		const after = ["- [x] a", "x", "- [x] b", "y", "- [x] c"];
		const hunks: LineHunk[] = [4, 0, 2].map((n) => ({
			oldFrom: n,
			oldTo: n,
			newFrom: n,
			newTo: n,
		}));
		expect(diffTaskLines(before, after, hunks).map((c) => [c.line, c.from, c.to])).toEqual([
			[0, " ", "x"],
			[2, " ", "x"],
			[4, " ", "x"],
		]);
	});

	it("one hunk across several lines", () => {
		const before = ["- [ ] a", "- [/] b", "- [-] c"];
		const after = ["- [x] a", "- [x] b", "- [x] c"];
		expect(diff(before, after).map((c) => [c.line, c.from, c.to])).toEqual([
			[0, " ", "x"],
			[1, "/", "x"],
			[2, "-", "x"],
		]);
	});

	it("x -> X is a char change", () => {
		expect(diff(["- [x] a"], ["- [X] a"])).toEqual([
			{ line: 0, lineText: "- [X] a", from: "x", to: "X" },
		]);
	});

	it("an unknown char is a char like any other", () => {
		expect(diff(["- [?] a"], ["- [ ] a"])[0]).toMatchObject({ from: "?", to: " " });
	});

	it("stamps do not make a line a different task", () => {
		expect(diff(["- [x] a ✅ 2026-01-01"], ["- [ ] a ✅ 2026-01-01"])).toEqual([
			{ line: 0, lineText: "- [ ] a ✅ 2026-01-01", from: "x", to: " " },
		]);
	});

	it("no change when only text differs", () => {
		expect(diff(["- [ ] a"], ["- [ ] ab"])).toEqual([]);
	});

	it("a status change together with a text edit is an insertion, not a change", () => {
		expect(diff(["- [ ] a"], ["- [x] ab"])).toEqual([]);
	});

	it("non-task lines never change", () => {
		expect(diff(["- a", "text"], ["- b", "text2"])).toEqual([]);
	});

	it("returns nothing for hunks past the end of the note", () => {
		expect(
			diffTaskLines(["- [ ] a"], ["- [x] a"], [{ oldFrom: 5, oldTo: 6, newFrom: 5, newTo: 6 }])
		).toEqual([]);
	});
});

describe("E13: lines that only move or get new neighbours are not changes", () => {
	const parent = "- [x] Ship ✅ 2026-11-01";
	const child = "\t- [ ] Write notes";

	it("Enter above a closed parent", () => {
		expect(diff([parent, child], ["", parent, child])).toEqual([]);
	});

	it("Enter in the middle of a task line", () => {
		expect(diff(["- [x] ab"], ["- [x] a", "b"])).toEqual([]);
	});

	it("Enter at the end of a closed task adds an open one below", () => {
		expect(diff([parent], [parent, "- [ ] "])).toEqual([]);
	});

	it("deleting the line above", () => {
		expect(diff(["intro", parent, child], [parent, child])).toEqual([]);
	});

	it("deleting a task line above a stamped task", () => {
		expect(diff(["- [ ] gone", parent], [parent])).toEqual([]);
	});

	it("pasting lines above a stamped task", () => {
		expect(diff([parent, child], ["new 1", "new 2", parent, child])).toEqual([]);
	});

	it("pasting task lines above, one with the same text as the parent but open", () => {
		expect(diff([parent], ["- [ ] Ship", parent])).toEqual([]);
	});

	it("moving a line up (swap of two neighbours)", () => {
		const before = ["- [ ] Book venue", parent, child];
		const after = [parent, "- [ ] Book venue", child];
		expect(diff(before, after)).toEqual([]);
	});

	it("moving a line down", () => {
		const before = [parent, child, "- [ ] Book venue"];
		const after = [child, parent, "- [ ] Book venue"];
		expect(diff(before, after)).toEqual([]);
	});

	it("moved line in two separate hunks (deleted in one, inserted in another)", () => {
		const before = ["- [x] a ✅ 2026-01-01", "mid", "- [ ] b"];
		const after = ["mid", "- [ ] b", "- [x] a ✅ 2026-01-01"];
		const hunks: LineHunk[] = [
			{ oldFrom: 0, oldTo: 1, newFrom: 0, newTo: 0 },
			{ oldFrom: 2, oldTo: 2, newFrom: 1, newTo: 2 },
		];
		expect(diffTaskLines(before, after, hunks)).toEqual([]);
	});
});

describe("E14: identical task lines", () => {
	const doc = ["- [ ] Call caterer", "- [ ] Call caterer", "- [ ] Call caterer"];

	it.each([0, 1, 2])("toggle line %i of three identical lines (hunk on that line)", (i) => {
		const after = [...doc];
		after[i] = "- [x] Call caterer";
		const hunk = { oldFrom: i, oldTo: i, newFrom: i, newTo: i };
		expect(diffTaskLines(doc, after, [hunk])).toEqual([
			{ line: i, lineText: "- [x] Call caterer", from: " ", to: "x" },
		]);
	});

	it.each([0, 1, 2])("toggle line %i when the hunk covers all three lines", (i) => {
		const after = [...doc];
		after[i] = "- [x] Call caterer";
		expect(diff(doc, after)).toEqual([
			{ line: i, lineText: "- [x] Call caterer", from: " ", to: "x" },
		]);
	});

	it("duplicates separated by other lines, lower one toggled", () => {
		const before = ["- [ ] a", "text", "- [ ] a"];
		const after = ["- [ ] a", "text", "- [x] a"];
		expect(diff(before, after)).toEqual([
			{ line: 2, lineText: "- [x] a", from: " ", to: "x" },
		]);
	});

	it("an Enter between duplicates changes nothing", () => {
		expect(diff(["- [ ] a", "- [ ] a"], ["- [ ] a", "", "- [ ] a"])).toEqual([]);
	});
});

describe("pasted closed lines are insertions", () => {
	it("a block of new [x] lines", () => {
		const before = ["intro", "- [ ] a"];
		const after = ["intro", "- [x] b", "- [x] c", "- [ ] a"];
		expect(diff(before, after)).toEqual([]);
	});

	it("pasted [x] lines onto an empty line", () => {
		expect(diff([""], ["- [x] a", "- [x] b"])).toEqual([]);
	});

	it("a pasted [x] copy of an existing open task does not close that task", () => {
		expect(diff(["- [ ] a"], ["- [x] a", "- [ ] a"])).toEqual([]);
	});
});

describe("fences and frontmatter", () => {
	it("a task line inside a ``` fence never changes", () => {
		const before = ["```", "- [ ] a", "```"];
		expect(diff(before, ["```", "- [x] a", "```"])).toEqual([]);
	});

	it("a task line inside a ~~~ fence never changes", () => {
		const before = ["~~~", "- [ ] a", "~~~"];
		expect(diff(before, ["~~~", "- [x] a", "~~~"])).toEqual([]);
	});

	it("a task line in frontmatter never changes", () => {
		const before = ["---", "- [ ] a", "---", "- [ ] b"];
		expect(diff(before, ["---", "- [x] a", "---", "- [ ] b"])).toEqual([]);
	});

	it("a task line after the fence closed still does", () => {
		const before = ["```", "- [ ] a", "```", "- [ ] a"];
		const after = ["```", "- [ ] a", "```", "- [x] a"];
		expect(diff(before, after)).toEqual([
			{ line: 3, lineText: "- [x] a", from: " ", to: "x" },
		]);
	});

	it("a change that opens a fence above does not count", () => {
		// "```" typed above: the task line below is now code.
		expect(diffTaskLines(["- [ ] a"], ["```", "- [x] a"], [{ oldFrom: 0, oldTo: 0, newFrom: 0, newTo: 1 }])).toEqual([]);
	});

	it("a fenced twin does not take the place of the real task", () => {
		const before = ["- [ ] a", "```", "- [ ] a", "```"];
		const after = ["- [x] a", "```", "- [ ] a", "```"];
		expect(diff(before, after)).toEqual([
			{ line: 0, lineText: "- [x] a", from: " ", to: "x" },
		]);
	});
});

describe("markers and prefixes", () => {
	it.each([
		["- [ ] a", "- [x] a"],
		["* [ ] a", "* [x] a"],
		["+ [ ] a", "+ [x] a"],
		["1. [ ] a", "1. [x] a"],
		["1) [ ] a", "1) [x] a"],
		["> - [ ] a", "> - [x] a"],
		["> > * [ ] a", "> > * [x] a"],
		["\t- [ ] a", "\t- [x] a"],
		["  2. [ ] a", "  2. [x] a"],
	])("%s", (before, after) => {
		expect(diff([before], [after])).toEqual([
			{ line: 0, lineText: after, from: " ", to: "x" },
		]);
	});

	it("callout body task under a [!note] line", () => {
		const before = ["> [!note]", "> - [ ] a"];
		const after = ["> [!note]", "> - [x] a"];
		expect(diff(before, after)).toEqual([
			{ line: 1, lineText: "> - [x] a", from: " ", to: "x" },
		]);
	});

	it("a callout title line is not a task", () => {
		expect(diff(["> [!note]"], ["> [!todo]"])).toEqual([]);
	});
});

describe("mergeHunks", () => {
	it("merges overlapping hunks and keeps separate ones apart", () => {
		expect(
			mergeHunks([
				{ oldFrom: 5, oldTo: 6, newFrom: 5, newTo: 6 },
				{ oldFrom: 0, oldTo: 1, newFrom: 0, newTo: 1 },
				{ oldFrom: 1, oldTo: 2, newFrom: 1, newTo: 3 },
			])
		).toEqual([
			{ oldFrom: 0, oldTo: 2, newFrom: 0, newTo: 3 },
			{ oldFrom: 5, oldTo: 6, newFrom: 5, newTo: 6 },
		]);
	});

	it("does not change its input", () => {
		const input: LineHunk[] = [
			{ oldFrom: 0, oldTo: 1, newFrom: 0, newTo: 1 },
			{ oldFrom: 1, oldTo: 2, newFrom: 1, newTo: 2 },
		];
		mergeHunks(input);
		expect(input[0]).toEqual({ oldFrom: 0, oldTo: 1, newFrom: 0, newTo: 1 });
	});
});
