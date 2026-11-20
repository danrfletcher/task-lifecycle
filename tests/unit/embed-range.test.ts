import { describe, expect, it } from "vitest";
import {
	parseEmbedSrc,
	resolveEmbedRange,
	type CacheSlice,
} from "../../src/domain/embed-range";

const pos = (a: number, b = a) => ({ start: { line: a }, end: { line: b } });

/**
 * The metadata cache Obsidian 1.15.1 built for the probe note `Forms.md`
 * (see docs/probe-rendered-tasks.md), copied from the live app.
 *
 *  0 # Top                       12 - [ ] Unique in sub
 *  2 Intro paragraph ^para       14 ### Deep
 *  4 - [ ] Item one ^li          16 - [ ] Deep task
 *  5 	- [ ] Child task ^child   18 # Other
 *  6 	- [ ] Child two           20 ## Sub
 *  8 ## Sub                      22 - [ ] Other sub task
 * 10 - [ ] Read chapter 3     11 - [ ] Read chapter 3
 */
const FORMS: CacheSlice = {
	headings: [
		{ heading: "Top", level: 1, position: pos(0) },
		{ heading: "Sub", level: 2, position: pos(8) },
		{ heading: "Deep", level: 3, position: pos(14) },
		{ heading: "Other", level: 1, position: pos(18) },
		{ heading: "Sub", level: 2, position: pos(20) },
	],
	blocks: {
		para: { position: pos(2) },
		li: { position: pos(4) },
		child: { position: pos(5) },
	},
	listItems: [
		{ position: pos(4), parent: -4 },
		{ position: pos(5), parent: 4 },
		{ position: pos(6), parent: 4 },
		{ position: pos(10), parent: -10 },
		{ position: pos(11), parent: -10 },
		{ position: pos(12), parent: -10 },
		{ position: pos(16), parent: -16 },
		{ position: pos(22), parent: -22 },
	],
};

describe("parseEmbedSrc", () => {
	const cases: Array<[string, ReturnType<typeof parseEmbedSrc>]> = [
		["Course", { kind: "note", linkpath: "Course" }],
		["folder/Course.md", { kind: "note", linkpath: "folder/Course.md" }],
		["Course#^l2", { kind: "block", linkpath: "Course", id: "l2" }],
		["Course#^l2|300", { kind: "block", linkpath: "Course", id: "l2" }],
		["Course#^l2|300x200", { kind: "block", linkpath: "Course", id: "l2" }],
		["Course|300", { kind: "note", linkpath: "Course" }],
		["Forms#Sub", { kind: "heading", linkpath: "Forms", path: ["Sub"] }],
		["Forms#Top#Sub", { kind: "heading", linkpath: "Forms", path: ["Top", "Sub"] }],
		["Forms#Top#Sub|alias", { kind: "heading", linkpath: "Forms", path: ["Top", "Sub"] }],
		["Forms#Top#^li", { kind: "block", linkpath: "Forms", id: "li" }],
		["#Heading", { kind: "heading", linkpath: "", path: ["Heading"] }],
		["#^id", { kind: "block", linkpath: "", id: "id" }],
		["Forms#", { kind: "note", linkpath: "Forms" }],
		["Forms#^", { kind: "heading", linkpath: "Forms", path: ["^"] }],
	];
	it.each(cases)("%s", (src, expected) => {
		expect(parseEmbedSrc(src)).toEqual(expected);
	});
});

describe("resolveEmbedRange", () => {
	const range = (src: string, cache: CacheSlice = FORMS) =>
		resolveEmbedRange(cache, parseEmbedSrc(src));

	it("a whole-note embed shows every line and has no known section", () => {
		expect(range("Forms")).toEqual({ from: 0, to: Number.POSITIVE_INFINITY, sectionStart: null });
	});

	it("a heading runs to the next heading of the same or a higher level, deeper headings included", () => {
		expect(range("Forms#Sub")).toEqual({ from: 8, to: 17, sectionStart: null });
		expect(range("Forms#Deep")).toEqual({ from: 14, to: 17, sectionStart: null });
		expect(range("Forms#Top")).toEqual({ from: 0, to: 17, sectionStart: null });
	});

	it("the last heading runs to the end of the note", () => {
		expect(range("Forms#Other")).toEqual({
			from: 18,
			to: Number.POSITIVE_INFINITY,
			sectionStart: null,
		});
	});

	it("a plain heading name finds the first heading with that name", () => {
		expect(range("Forms#Sub")?.from).toBe(8);
	});

	it("a nested heading path finds the name inside the section before it (E13)", () => {
		expect(range("Forms#Top#Sub")).toEqual({ from: 8, to: 17, sectionStart: null });
		expect(range("Forms#Other#Sub")).toEqual({
			from: 20,
			to: Number.POSITIVE_INFINITY,
			sectionStart: null,
		});
		expect(range("Forms#Top#Deep")).toEqual({ from: 14, to: 17, sectionStart: null });
	});

	it("a nested heading path does not find a name outside the first heading's section", () => {
		expect(range("Forms#Deep#Other")).toBeNull();
		expect(range("Forms#Sub#Top")).toBeNull();
		expect(range("Forms#Top#Missing")).toBeNull();
	});

	it("heading names compare without case, link punctuation or extra spaces", () => {
		const cache: CacheSlice = {
			headings: [{ heading: "Plan: Step  [1]", level: 2, position: pos(3) }],
		};
		expect(range("N#plan step 1", cache)).toEqual({
			from: 3,
			to: Number.POSITIVE_INFINITY,
			sectionStart: null,
		});
	});

	it("a block id on a paragraph covers the paragraph and is one section", () => {
		expect(range("Forms#^para")).toEqual({ from: 2, to: 2, sectionStart: 2 });
	});

	it("a block id on a list item covers the item and its whole subtree", () => {
		expect(range("Forms#^li")).toEqual({ from: 4, to: 6, sectionStart: 4 });
		expect(range("Forms#^li|300")).toEqual({ from: 4, to: 6, sectionStart: 4 });
	});

	it("a block id on a nested child covers only the child", () => {
		expect(range("Forms#^child")).toEqual({ from: 5, to: 5, sectionStart: 5 });
	});

	it("a block id matches without regard to case", () => {
		expect(range("Forms#^LI")).toEqual({ from: 4, to: 6, sectionStart: 4 });
	});

	it("a list item's subtree stops at the next sibling", () => {
		const cache: CacheSlice = {
			blocks: { a: { position: pos(0) } },
			listItems: [
				{ position: pos(0), parent: -1 },
				{ position: pos(1), parent: 0 },
				{ position: pos(2), parent: 1 },
				{ position: pos(3), parent: -1 },
				{ position: pos(4), parent: 3 },
			],
		};
		expect(range("N#^a", cache)).toEqual({ from: 0, to: 2, sectionStart: 0 });
	});

	it("a block that is not a list item keeps its own end line", () => {
		const cache: CacheSlice = { blocks: { b: { position: pos(2, 4) } } };
		expect(range("N#^b", cache)).toEqual({ from: 2, to: 4, sectionStart: 2 });
	});

	it("a missing heading, a missing block or an empty cache gives null", () => {
		expect(range("Forms#Nope")).toBeNull();
		expect(range("Forms#^nope")).toBeNull();
		expect(range("Forms#Sub", {})).toBeNull();
		expect(range("Forms#^li", {})).toBeNull();
	});
});
