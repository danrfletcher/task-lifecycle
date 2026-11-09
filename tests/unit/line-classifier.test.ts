import { describe, expect, it } from "vitest";
import {
	classifyLines,
	getCheckboxStatusChar,
	indentWidth,
	isListLine,
	isTaskLine,
	setCheckboxStatusChar,
} from "../../src/domain/line-classifier";

const markers = ["-", "*", "+", "1.", "1)", "12."];
const prefixes: [string, string][] = [
	["none", ""],
	["indent spaces", "    "],
	["tabs", "\t\t"],
	["quote", "> "],
	["nested quote", "> > "],
	["callout body", "> "],
	["indented quote", "  > "],
];
const chars = [" ", "/", "x", "X", "-", "?"];

describe("task lines: marker x prefix x status char", () => {
	for (const marker of markers) {
		for (const [pname, prefix] of prefixes) {
			for (const c of chars) {
				const line = `${prefix}${marker} [${c}] text`;
				it(`${pname} | ${marker} | ${JSON.stringify(c)}`, () => {
					expect(isTaskLine(line)).toBe(true);
					expect(isListLine(line)).toBe(true);
					expect(getCheckboxStatusChar(line)).toBe(c);
					// round trip through every other status char
					for (const other of chars) {
						const set = setCheckboxStatusChar(line, other);
						expect(set).toBe(`${prefix}${marker} [${other}] text`);
						expect(getCheckboxStatusChar(set)).toBe(other);
					}
				});
			}
		}
	}

	it("accepts a task with nothing after the checkbox", () => {
		expect(isTaskLine("- [ ]")).toBe(true);
		expect(getCheckboxStatusChar("- [x]")).toBe("x");
	});

	it("accepts a callout body line", () => {
		expect(isTaskLine("> - [/] in a callout")).toBe(true);
	});

	it("accepts a tab after the checkbox and a trailing \\r", () => {
		expect(isTaskLine("- [ ]\ttext")).toBe(true);
		expect(isTaskLine("- [ ]\r")).toBe(true);
	});

	it("accepts any single char, including an astral one", () => {
		expect(getCheckboxStatusChar("- [>] fwd")).toBe(">");
		expect(getCheckboxStatusChar("- [😀] fun")).toBe("😀");
		expect(setCheckboxStatusChar("- [😀] fun", "x")).toBe("- [x] fun");
		expect(setCheckboxStatusChar("- [ ] fun", "😀")).toBe("- [😀] fun");
	});
});

describe("not task lines", () => {
	const negatives: [string, string][] = [
		["no space after marker", "-[ ] text"],
		["no space after bracket", "- [ ]x"],
		["two chars", "- [xx] text"],
		["empty brackets", "- [] text"],
		["no marker", "[ ] text"],
		["plain bullet", "- text"],
		["heading", "# Heading"],
		["plain text", "just text"],
		["empty line", ""],
		["marker with no space", "1.[ ] text"],
		["bold not a bullet", "**[ ] text**"],
	];
	it.each(negatives)("%s: %j", (_name, line) => {
		expect(isTaskLine(line)).toBe(false);
		expect(getCheckboxStatusChar(line)).toBeNull();
		expect(setCheckboxStatusChar(line, "x")).toBe(line);
	});

	it("still sees a plain bullet and an ordered item as list lines", () => {
		expect(isListLine("- text")).toBe(true);
		expect(isListLine("\t1) text")).toBe(true);
		expect(isListLine("> * text")).toBe(true);
		expect(isListLine("# Heading")).toBe(false);
		expect(isListLine("-text")).toBe(false);
		expect(isListLine("---")).toBe(false);
	});
});

describe("setCheckboxStatusChar", () => {
	it("changes only the status char", () => {
		const line = "  \t> 1.   [ ]   spaced   text ✅ 2026-11-01 ^id";
		expect(setCheckboxStatusChar(line, "x")).toBe(
			"  \t> 1.   [x]   spaced   text ✅ 2026-11-01 ^id"
		);
	});

	it("rejects a value that is not exactly one char", () => {
		const line = "- [ ] a";
		expect(setCheckboxStatusChar(line, "")).toBe(line);
		expect(setCheckboxStatusChar(line, "xx")).toBe(line);
		expect(setCheckboxStatusChar(line, "]")).toBe(line);
		expect(setCheckboxStatusChar(line, "\n")).toBe(line);
	});

	it("keeps a trailing \\r (E8)", () => {
		expect(setCheckboxStatusChar("- [ ] a\r", "x")).toBe("- [x] a\r");
		expect(setCheckboxStatusChar("- [ ]\r", "-")).toBe("- [-]\r");
	});

	it("keeps trailing whitespace", () => {
		expect(setCheckboxStatusChar("- [ ] a   ", "/")).toBe("- [/] a   ");
	});
});

describe("indentWidth", () => {
	it.each([
		["", 0],
		["x", 0],
		["  x", 2],
		["\tx", 4],
		["\t\tx", 8],
		[" \tx", 5],
		["\t x", 5],
		["  \t  x", 8],
		["   ", 3],
		["- [ ] a", 0],
		["  - [ ] a", 2],
	])("%j is %i", (line, width) => {
		expect(indentWidth(line)).toBe(width);
	});
});

function kinds(lines: string[]) {
	return classifyLines(lines).map((l) =>
		l.excluded ? "excluded" : l.kind
	);
}

describe("classifyLines", () => {
	it("classifies task, list and other lines", () => {
		expect(
			kinds(["# Title", "- [ ] a", "\t- note", "text", "1. [x] b", ""])
		).toEqual(["other", "task", "list", "other", "task", "other"]);
	});

	it("returns an empty array for no lines", () => {
		expect(classifyLines([])).toEqual([]);
	});

	it("excludes a leading frontmatter block, delimiters included", () => {
		expect(
			kinds(["---", "- [ ] in yaml", "tags: x", "---", "- [ ] real"])
		).toEqual(["excluded", "excluded", "excluded", "excluded", "task"]);
	});

	it("excludes frontmatter written with trailing spaces or \\r", () => {
		expect(kinds(["---\r", "a: b\r", "---  ", "- [ ] t"])).toEqual([
			"excluded",
			"excluded",
			"excluded",
			"task",
		]);
	});

	it("only treats --- on the first line as frontmatter", () => {
		expect(kinds(["", "---", "- [ ] a", "---"])).toEqual([
			"other",
			"other",
			"task",
			"other",
		]);
	});

	it("does not treat an unclosed leading --- as frontmatter", () => {
		expect(kinds(["---", "- [ ] a"])).toEqual(["other", "task"]);
	});

	it("excludes a backtick fence", () => {
		expect(
			kinds(["- [ ] a", "```ts", "- [ ] b", "```", "- [ ] c"])
		).toEqual(["task", "excluded", "excluded", "excluded", "task"]);
	});

	it("excludes a tilde fence", () => {
		expect(kinds(["~~~", "- [ ] b", "~~~", "- [ ] c"])).toEqual([
			"excluded",
			"excluded",
			"excluded",
			"task",
		]);
	});

	it("does not close a fence with the other fence char", () => {
		expect(kinds(["```", "- [ ] a", "~~~", "- [ ] b", "```", "- [ ] c"])).toEqual(
			["excluded", "excluded", "excluded", "excluded", "excluded", "task"]
		);
		expect(kinds(["~~~", "- [ ] a", "```", "- [ ] b", "~~~", "- [ ] c"])).toEqual(
			["excluded", "excluded", "excluded", "excluded", "excluded", "task"]
		);
	});

	it("does not close a fence with a shorter run", () => {
		expect(
			kinds(["````", "```", "- [ ] a", "````", "- [ ] b"])
		).toEqual(["excluded", "excluded", "excluded", "excluded", "task"]);
	});

	it("closes a fence with a longer run", () => {
		expect(kinds(["```", "- [ ] a", "`````", "- [ ] b"])).toEqual([
			"excluded",
			"excluded",
			"excluded",
			"task",
		]);
	});

	it("does not close a fence with a line that has text after the fence chars", () => {
		expect(kinds(["```", "```js", "- [ ] a", "```", "- [ ] b"])).toEqual([
			"excluded",
			"excluded",
			"excluded",
			"excluded",
			"task",
		]);
	});

	it("excludes to the end of the note when a fence is unclosed", () => {
		expect(kinds(["- [ ] a", "```", "- [ ] b", "- [ ] c"])).toEqual([
			"task",
			"excluded",
			"excluded",
			"excluded",
		]);
	});

	it("excludes a backtick fence in a CRLF note", () => {
		expect(
			kinds(["- [ ] p\r", "```\r", "- [ ] code\r", "```\r", "- [ ] after\r"])
		).toEqual(["task", "excluded", "excluded", "excluded", "task"]);
	});

	it("excludes a tilde fence in a CRLF note", () => {
		expect(
			kinds(["- [ ] p\r", "~~~\r", "- [ ] code\r", "~~~\r", "- [ ] after\r"])
		).toEqual(["task", "excluded", "excluded", "excluded", "task"]);
	});

	it("handles a CRLF fence with an info string, and does not close on one", () => {
		expect(
			kinds(["```ts\r", "- [ ] a\r", "```js\r", "- [ ] b\r", "```\r", "- [ ] c\r"])
		).toEqual([
			"excluded",
			"excluded",
			"excluded",
			"excluded",
			"excluded",
			"task",
		]);
	});

	it("still treats CRLF inline-code triple backticks as not a fence", () => {
		expect(kinds(["```x```\r", "- [ ] a\r"])).toEqual(["other", "task"]);
	});

	it("excludes a fence inside a list item (backtick and tilde)", () => {
		expect(
			kinds([
				"- [ ] parent",
				"\t```",
				"\t- [ ] code",
				"\t```",
				"\t~~~",
				"\t- [ ] more code",
				"\t~~~",
				"\t- [ ] real child",
			])
		).toEqual([
			"task",
			"excluded",
			"excluded",
			"excluded",
			"excluded",
			"excluded",
			"excluded",
			"task",
		]);
	});

	it("excludes a fence inside a callout", () => {
		expect(kinds(["> ```", "> - [ ] a", "> ```", "> - [ ] b"])).toEqual([
			"excluded",
			"excluded",
			"excluded",
			"task",
		]);
	});

	it("treats inline code with three backticks as normal text", () => {
		expect(kinds(["```code``` here", "- [ ] a"])).toEqual(["other", "task"]);
	});

	it("handles frontmatter followed by a fence", () => {
		expect(kinds(["---", "a: 1", "---", "```", "- [ ] x", "```", "- [ ] y"])).toEqual(
			["excluded", "excluded", "excluded", "excluded", "excluded", "excluded", "task"]
		);
	});

	it("gives excluded lines the kind other", () => {
		const info = classifyLines(["```", "- [ ] a", "```"]);
		for (const l of info) {
			expect(l).toEqual({ kind: "other", excluded: true });
		}
	});
});
