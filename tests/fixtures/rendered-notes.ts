/**
 * Notes and the metadata caches Obsidian 1.15.1 built for them in the probe
 * (docs/probe-rendered-tasks.md), written out by hand. Line numbers are
 * 0-based. `parent` is the line of the parent item, or negative for a
 * top-level item.
 */
const pos = (a: number, b = a) => ({ start: { line: a }, end: { line: b } });

export const COURSE_TEXT =
	"- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n";

export const COURSE_CACHE = {
	blocks: { l2: { position: pos(0) } },
	listItems: [
		{ position: pos(0), parent: -1 },
		{ position: pos(1), parent: 0 },
		{ position: pos(2), parent: 0 },
	],
};

/** A closed Course note with one lesson-content task ending in a block id (GP6). */
export const COURSE_N1_TEXT = "- [ ] Take notes ^n1\n";

export const COURSE_N1_CACHE = {
	blocks: { n1: { position: pos(0) } },
	listItems: [{ position: pos(0), parent: -1 }],
};

export const FORMS_TEXT = [
	"# Top",
	"",
	"Intro paragraph ^para",
	"",
	"- [ ] Item one ^li",
	"\t- [ ] Child task ^child",
	"\t- [ ] Child two",
	"",
	"## Sub",
	"",
	"- [ ] Read chapter 3",
	"- [ ] Read chapter 3",
	"- [ ] Unique in sub",
	"",
	"### Deep",
	"",
	"- [ ] Deep task",
	"",
	"# Other",
	"",
	"## Sub",
	"",
	"- [ ] Other sub task",
	"",
].join("\n");

export const FORMS_CACHE = {
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

export const SHAPES_TEXT = [
	"# S",
	"",
	"> [!note] Title",
	"> - [ ] callout task ^cal",
	"> - [ ] callout two",
	"",
	"> - [ ] quote task ^quo",
	"",
	"1. [ ] numbered dot ^nd",
	"2) [ ] numbered paren",
	"",
	"- [ ] ",
	"",
	"| a | b |",
	"|---|---|",
	"| - [ ] in table | x |",
	"",
	"```",
	"- [ ] fenced",
	"```",
	"",
	"- [ ] **bold** and [[Course|alias]] and `code` [due:: 2026-11-30] ^rich",
	"",
].join("\n");

export const SHAPES_CACHE = {
	headings: [{ heading: "S", level: 1, position: pos(0) }],
	blocks: {
		cal: { position: pos(2, 4) },
		quo: { position: pos(6) },
		nd: { position: pos(8) },
		rich: { position: pos(21) },
	},
	listItems: [
		{ position: pos(3), parent: -3 },
		{ position: pos(4), parent: -3 },
		{ position: pos(6), parent: -6 },
		{ position: pos(8), parent: -8 },
		{ position: pos(9), parent: -9 },
		{ position: pos(11), parent: -11 },
		{ position: pos(21), parent: -21 },
	],
};

export const TABS_TEXT = "- [ ] Parent ^tp\n\t- [ ] Tab child ^tc\n\t\t- [ ] Two tabs deep\n";

export const TABS_CACHE = {
	blocks: { tp: { position: pos(0) }, tc: { position: pos(1) } },
	listItems: [
		{ position: pos(0), parent: -1 },
		{ position: pos(1), parent: 0 },
		{ position: pos(2), parent: 1 },
	],
};
