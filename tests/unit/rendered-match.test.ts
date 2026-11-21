import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	findCandidateLines,
	matchRenderedTask,
	normalizeRenderedText,
	normalizeSourceTaskText,
} from "../../src/domain/rendered-match";

const fixture = readFileSync(join(__dirname, "..", "fixtures", "rendered-source.md"), "utf8").split(
	"\n"
);

/** 0-based index of the one fixture line that starts with `text`. */
function lineOf(text: string): number {
	const hits = fixture.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith(text));
	expect(hits.length, `fixture line "${text}"`).toBeGreaterThan(0);
	return hits[0][1];
}

/** 0-based index of the one fixture line that is exactly `text`. */
function exactLine(text: string): number {
	const hits = fixture.flatMap((l, i) => (l === text ? [i] : []));
	expect(hits, `fixture line "${text}"`).toHaveLength(1);
	return hits[0];
}

const WHOLE = { from: 0, to: Number.POSITIVE_INFINITY };

describe("normalizeSourceTaskText: what the content check strips (E17)", () => {
	const cases: Array<[string, string, string]> = [
		["a plain task", "- [ ] Plain task", "Plain task"],
		["a block id", "- [ ] Lesson 2 content ^l2", "Lesson 2 content"],
		["a block id with a hyphen", "- [ ] Item ^my-id-1", "Item"],
		["a done stamp", "- [x] Done thing ✅ 2026-11-20", "Done thing"],
		["a cancelled stamp", "- [-] Dropped ❌ 2026-11-20", "Dropped"],
		["a stamp before the block id", "- [x] Lesson ✅ 2026-11-20 ^l2", "Lesson"],
		["a stamp after the block id", "- [x] Lesson ^l2 ✅ 2026-11-20", "Lesson"],
		["a stamp with the emoji selector", "- [x] Lesson ✅\uFE0F 2026-11-20", "Lesson"],
		["a wikilink", "- [ ] See [[Course]] now", "See Course now"],
		["a wikilink alias", "- [ ] See [[Course|the course]] now", "See the course now"],
		["a wikilink with a heading", "- [ ] See [[Course#Intro]]", "See Course > Intro"],
		["a markdown link", "- [ ] Read [the docs](https://example.com/a_b) now", "Read the docs now"],
		["an image", "- [ ] Look ![alt](pic.png) here", "Look here"],
		["bold with stars", "- [ ] A **bold** word", "A bold word"],
		["bold with underscores", "- [ ] A __bold__ word", "A bold word"],
		["italic with a star", "- [ ] An *italic* word", "An italic word"],
		["italic with underscores", "- [ ] An _italic_ word", "An italic word"],
		["bold italic", "- [ ] A ***both*** word", "A both word"],
		["strikethrough", "- [ ] A ~~gone~~ word", "A gone word"],
		["highlight", "- [ ] A ==marked== word", "A marked word"],
		["inline code", "- [ ] Run `npm test` first", "Run npm test first"],
		["an inline field in brackets", "- [ ] Pay [due:: 2026-11-30]", "Pay"],
		["an inline field in parentheses", "- [ ] Pay (due:: 2026-11-30) now", "Pay now"],
		["a html tag", "- [ ] A <b>tagged</b> word", "A tagged word"],
		["an escaped star", "- [ ] Five \\* stars", "Five * stars"],
		["a code span holding bold syntax is drawn literally", "- [ ] Use `**x**` here", "Use **x** here"],
		["a code span holding italic stars", "- [ ] Use `*a*` and `*b*`", "Use *a* and *b*"],
		["a code span holding underscores", "- [ ] Use `_a_` here", "Use _a_ here"],
		["a code span holding a wikilink", "- [ ] Type `[[Note]]` now", "Type [[Note]] now"],
		["a code span holding a html tag", "- [ ] Type `<b>x</b>` now", "Type <b>x</b> now"],
		["emphasis around a code span", "- [ ] A **`code`** word", "A code word"],
		["a code span next to real bold", "- [ ] `*a*` and **b**", "*a* and b"],
		["an escaped star pair", "- [ ] Say \\*a\\* now", "Say *a* now"],
		["an escaped underscore pair", "- [ ] Say \\_a\\_ now", "Say _a_ now"],
		["an escaped bracket is not a link", "- [ ] See \\[a\\](b) now", "See [a](b) now"],
		["an escaped backtick does not open a code span", "- [ ] A \\`**b**\\` word", "A `b` word"],
		["a backslash inside a code span stays", "- [ ] Path `a\\*b` here", "Path a\\*b here"],
		["a private-use character in the source is ignored", "- [ ] A\uE000 `x` B", "A x B"],
		["a footnote reference", "- [ ] Call Sam[^1] today", "Call Sam today"],
		["a named footnote reference", "- [ ] Call Sam[^note] today", "Call Sam today"],
		["an inline footnote", "- [ ] Call Sam^[see notes] today", "Call Sam today"],
		["a footnote reference at the end", "- [ ] Call Sam[^1] ^t1", "Call Sam"],
		["a footnote reference held in a code span stays", "- [ ] Type `[^1]` now", "Type [^1] now"],
		["an escaped footnote reference is not a footnote", "- [ ] See \\[^1] now", "See [^1] now"],
		["inline math", "- [ ] Solve $x^2 + 1$ today", "Solve today"],
		["inline math at the end", "- [ ] Prove $a_1 * b_1$", "Prove"],
		["display math inside a task", "- [ ] Show $$\\sum_i x_i$$ holds", "Show holds"],
		["two prices are not math", "- [ ] Costs $5 and $6", "Costs $5 and $6"],
		["a lone dollar is not math", "- [ ] Pay $ now", "Pay $ now"],
		["an escaped dollar pair is not math", "- [ ] Pay \\$a and \\$b", "Pay $a and $b"],
		["math held in a code span stays", "- [ ] Type `$x$` now", "Type $x$ now"],
		["a snake_case word (no italics)", "- [ ] Fix some_var_name today", "Fix some_var_name today"],
		["a hash tag", "- [ ] Call #urgent", "Call #urgent"],
		["extra whitespace", "- [ ]   spaced \t  out  ", "spaced out"],
		["a blockquote task", "> - [ ] Quoted task", "Quoted task"],
		["a callout task", "> > - [/] Callout task ^c1", "Callout task"],
		["a numbered dot task", "1. [ ] Numbered", "Numbered"],
		["a numbered paren task", "2) [x] Numbered", "Numbered"],
		["a tab-indented task", "\t- [ ] Indented", "Indented"],
		["an empty task", "- [ ]", ""],
		["an empty task with a trailing space", "- [ ] ", ""],
		["a bare done emoji is text", "- [ ] Bare ✅ no date", "Bare ✅ no date"],
		["a bare cancelled emoji is text", "- [ ] Bare ❌ no date", "Bare ❌ no date"],
		["an emoji with a malformed date is text", "- [ ] Odd ✅ 2026-1-5", "Odd ✅ 2026-1-5"],
		["a CRLF line", "- [ ] Windows line\r", "Windows line"],
	];
	it.each(cases)("%s", (_name, line, expected) => {
		expect(normalizeSourceTaskText(line)).toBe(expected);
	});
});

describe("normalizeRenderedText: what Obsidian drew", () => {
	const cases: Array<[string, string, string]> = [
		["plain text with the li whitespace", "Plain task \n\n", "Plain task"],
		["an inline field Obsidian leaves raw", "Pay [due:: 2026-11-30] ", "Pay"],
		["a stamp drawn as text", "Done thing ✅ 2026-11-20", "Done thing"],
		["a bare emoji stays", "Bare ✅ no date", "Bare ✅ no date"],
		["a non-breaking space", "a\u00a0b", "a b"],
		["only whitespace (an empty task)", "\n\n", ""],
		["literal stars are kept (already drawn text)", "5 * 3 = 15", "5 * 3 = 15"],
	];
	it.each(cases)("%s", (_name, text, expected) => {
		expect(normalizeRenderedText(text)).toBe(expected);
	});

	it("normalizes composed and decomposed accents to the same text", () => {
		const composed = "caf\u00e9";
		const decomposed = "cafe\u0301";
		expect(normalizeRenderedText(decomposed)).toBe(normalizeSourceTaskText(`- [ ] ${composed}`));
	});
});

describe("matchRenderedTask: one source line or a verdict", () => {
	it("returns the one line with the rendered text", () => {
		expect(matchRenderedTask(fixture, "Plain task", WHOLE)).toEqual({ line: lineOf("- [ ] Plain task") });
	});

	it("matches the rendered text of a line with a stamp and a block id", () => {
		expect(matchRenderedTask(fixture, "Stamped task", WHOLE)).toEqual({
			line: lineOf("- [x] Stamped task"),
		});
	});

	it("matches a line whose markdown Obsidian turned into plain text, field kept raw", () => {
		const rendered = "Bold word and alias and text and code [due:: 2026-11-30] ";
		expect(matchRenderedTask(fixture, rendered, WHOLE)).toEqual({
			line: lineOf("- [ ] Bold **word**"),
		});
	});

	it("matches a task whose code span holds markdown, and an escaped star pair, to what Obsidian draws", () => {
		const lines = ["- [ ] Use `**x**` here ^c1", "- [ ] Say \\*a\\* now", "- [ ] Use x here"];
		expect(matchRenderedTask(lines, "Use **x** here", WHOLE)).toEqual({ line: 0 });
		expect(matchRenderedTask(lines, "Say *a* now", WHOLE)).toEqual({ line: 1 });
		expect(matchRenderedTask(lines, "Use x here", WHOLE)).toEqual({ line: 2 });
	});

	it("keeps a bare emoji in the comparison", () => {
		expect(matchRenderedTask(fixture, "Bare ✅ no date stays", WHOLE)).toEqual({
			line: lineOf("- [ ] Bare"),
		});
		expect(matchRenderedTask(fixture, "Bare no date stays", WHOLE)).toEqual({
			unmappable: "no-candidate",
		});
	});

	it("matches CJK, emoji and a 2,000 character body against themselves", () => {
		expect(matchRenderedTask(fixture, "日本語 emoji 🚀 text", WHOLE)).toEqual({
			line: lineOf("- [ ] 日本語"),
		});
		const long = `${"長いテキスト 🚀 long body ".repeat(100)}end`.slice(0, 2000);
		expect(long.length).toBe(2000);
		const lines = ["- [ ] short", `- [ ] ${long} ^long`, "- [ ] other"];
		expect(matchRenderedTask(lines, long, WHOLE)).toEqual({ line: 1 });
	});

	it("matches every task shape the classifier knows", () => {
		const shapes: Array<[string, string]> = [
			["Quote task", "> - [ ] Quote task"],
			["Callout task", "> - [ ] Callout task"],
			["Numbered dot", "1. [ ] Numbered dot"],
			["Numbered paren", "2) [ ] Numbered paren"],
			["Tab indented", "\t- [ ] Tab indented"],
		];
		for (const [text, source] of shapes) {
			expect(matchRenderedTask(fixture, text, WHOLE), text).toEqual({ line: exactLine(source) });
		}
	});

	it("matches an empty task only when exactly one empty task exists", () => {
		expect(matchRenderedTask(fixture, "\n\n", WHOLE)).toEqual({ line: exactLine("- [ ] ") });
		const two = ["- [ ]", "- [ ]"];
		expect(matchRenderedTask(two, "", WHOLE)).toEqual({ unmappable: "ambiguous" });
	});

	it("gives no-candidate, not the nearest line, when nothing matches", () => {
		expect(matchRenderedTask(fixture, "Plain tusk", WHOLE)).toEqual({ unmappable: "no-candidate" });
		expect(matchRenderedTask(fixture, "Plain task and more", WHOLE)).toEqual({
			unmappable: "no-candidate",
		});
	});

	it("does not match a non-task line with the same text", () => {
		const lines = ["- Plain note", "- [ ] other"];
		expect(matchRenderedTask(lines, "Plain note", WHOLE)).toEqual({ unmappable: "no-candidate" });
	});
});

describe("duplicate lines (E7)", () => {
	it("counts both identical lines and gives ambiguous", () => {
		const dupes = [lineOf("- [ ] Duplicate line"), lineOf("- [ ] Duplicate line") + 1];
		expect(findCandidateLines(fixture, "Duplicate line", WHOLE)).toEqual(dupes);
		expect(matchRenderedTask(fixture, "Duplicate line", WHOLE)).toEqual({ unmappable: "ambiguous" });
	});

	it("is not ambiguous when the range holds only one of the two", () => {
		const first = lineOf("- [ ] Duplicate line");
		expect(matchRenderedTask(fixture, "Duplicate line", { from: first, to: first })).toEqual({
			line: first,
		});
		expect(matchRenderedTask(fixture, "Duplicate line", { from: first + 1, to: first + 5 })).toEqual({
			line: first + 1,
		});
	});

	it("picks the line data-line names inside a known section, even with duplicates", () => {
		const first = lineOf("- [ ] Duplicate line");
		const range = { from: first - 1, to: first + 3 };
		expect(
			matchRenderedTask(fixture, "Duplicate line", { ...range, sectionStart: first - 1, dataLine: 1 })
		).toEqual({ line: first });
		expect(
			matchRenderedTask(fixture, "Duplicate line", { ...range, sectionStart: first - 1, dataLine: 2 })
		).toEqual({ line: first + 1 });
	});

	it("gives position-mismatch when the named line is a different task", () => {
		const first = lineOf("- [ ] Duplicate line");
		expect(
			matchRenderedTask(fixture, "Duplicate line", {
				from: first - 2,
				to: first + 3,
				sectionStart: first - 2,
				dataLine: 0,
			})
		).toEqual({ unmappable: "position-mismatch" });
	});

	it("gives position-mismatch when the named line is outside the range or the note", () => {
		const first = lineOf("- [ ] Duplicate line");
		const base = { from: first, to: first + 1 };
		expect(
			matchRenderedTask(fixture, "Duplicate line", { ...base, sectionStart: first, dataLine: 2 })
		).toEqual({ unmappable: "position-mismatch" });
		expect(
			matchRenderedTask(fixture, "Duplicate line", { ...base, sectionStart: 9999, dataLine: 0 })
		).toEqual({ unmappable: "position-mismatch" });
	});

	it("falls back to the content search when only one of sectionStart and dataLine is given", () => {
		const first = lineOf("- [ ] Duplicate line");
		expect(
			matchRenderedTask(fixture, "Duplicate line", { ...WHOLE, sectionStart: first, dataLine: null })
		).toEqual({ unmappable: "ambiguous" });
		expect(
			matchRenderedTask(fixture, "Plain task", { ...WHOLE, sectionStart: null, dataLine: 3 })
		).toEqual({ line: lineOf("- [ ] Plain task") });
	});
});

describe("fenced code and frontmatter are never candidates (E8)", () => {
	const excluded = [
		"Frontmatter task",
		"Fenced backtick",
		"Fenced tilde",
		"Indented fence",
		"Unclosed fence task",
	];
	it.each(excluded)("%s has no candidate", (text) => {
		expect(findCandidateLines(fixture, text, WHOLE)).toEqual([]);
		expect(matchRenderedTask(fixture, text, WHOLE)).toEqual({ unmappable: "no-candidate" });
	});

	it("ignores a duplicate that sits in the unclosed fence at the end", () => {
		// "Plain task ^p1" appears again inside the unclosed fence; only the real one counts.
		expect(fixture.filter((l) => l.includes("Plain task ^p1")).length).toBe(2);
		expect(matchRenderedTask(fixture, "Plain task", WHOLE)).toEqual({
			line: lineOf("- [ ] Plain task"),
		});
	});

	it("still finds a task after a closed fence", () => {
		expect(matchRenderedTask(fixture, "After fences", WHOLE)).toEqual({
			line: lineOf("- [ ] After fences"),
		});
	});

	it("never places a position on an excluded line", () => {
		const fenced = lineOf("- [ ] Fenced backtick");
		expect(
			matchRenderedTask(fixture, "Fenced backtick", {
				...WHOLE,
				sectionStart: fenced,
				dataLine: 0,
			})
		).toEqual({ unmappable: "position-mismatch" });
	});
});
