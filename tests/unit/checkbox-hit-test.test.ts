import { describe, expect, it } from "vitest";
import { checkboxTokenRange } from "../../src/domain/line-classifier";
import {
	NON_CHECKBOX_CLASSES,
	REJECTED_LEAF_TYPES,
	REJECTED_SURFACE_CLASSES,
	isCheckboxPress,
	isInLivePreview,
	isInReadingView,
	isNonCheckboxTarget,
	isPosOnCheckboxToken,
	isRenderedTaskSurface,
	pathHitsWidget,
	type PathElement,
} from "../../src/status-cycle/checkbox-hit-test";

/** A fake path element: tag plus classes. */
const el = (tagName: string, ...classes: string[]): PathElement => ({
	tagName,
	classList: { contains: (c: string) => classes.includes(c) },
});

/** A pane's `.workspace-leaf-content` with its `data-type`. */
const leafContent = (type: string): PathElement => ({
	...el("DIV", "workspace-leaf-content"),
	getAttribute: (name: string) => (name === "data-type" ? type : null),
});

describe("checkboxTokenRange", () => {
	// [line, fromCh, toCh] where fromCh is "[" and toCh is one past "]".
	const tokens: Array<[string, number, number]> = [
		["- [ ] a", 2, 5],
		["* [x] a", 2, 5],
		["+ [/] a", 2, 5],
		["1. [ ] a", 3, 6],
		["12) [-] a", 4, 7],
		["\t- [ ] a", 3, 6],
		["    - [ ] a", 6, 9],
		["\t\t- [X] a", 4, 7],
		["  \t- [?] a", 5, 8],
		["> - [ ] a", 4, 7],
		[">- [ ] a", 3, 6],
		["> > - [ ] a", 6, 9],
		["> [!note]", -1, -1],
		["> > 1) [ ] a", 7, 10],
		[">\t- [ ] a", 4, 7],
		["> \t\t* [ ] nested in callout", 6, 9],
		["- [ ]", 2, 5],
		["- [ ]\r", 2, 5],
	];
	it.each(tokens.filter(([, f]) => f >= 0))("%j -> [%i, %i)", (line, from, to) => {
		expect(checkboxTokenRange(line)).toEqual({ fromCh: from, toCh: to });
		expect(line[from]).toBe("[");
		expect(line[to - 1]).toBe("]");
	});

	it.each([
		["- [ ]x"],
		["- [ab]"],
		["-[ ]"],
		["- []"],
		["plain text"],
		[""],
		["- no box"],
		["> [!note] callout title"],
		["[ ] no marker"],
	])("%j is not a task: no token", (line) => {
		expect(checkboxTokenRange(line)).toBeNull();
	});
});

describe("isPosOnCheckboxToken (table: position x line shape)", () => {
	// For each line: the "[" index, and the answers at [, inside, ], just after ], before [.
	const lines = [
		"- [ ] a",
		"* [x] a",
		"+ [/] a",
		"1. [ ] a",
		"1) [-] a",
		"\t- [ ] a",
		"    - [ ] a",
		"> - [ ] a",
		"> > - [ ] a",
		"> > 1) [ ] callout body",
		"\t> * [ ] a",
	];
	it.each(lines)("%j", (line) => {
		const from = line.indexOf("[");
		expect(isPosOnCheckboxToken(line, from - 1)).toBe(false); // before "["
		expect(isPosOnCheckboxToken(line, from)).toBe(true); // on "["
		expect(isPosOnCheckboxToken(line, from + 1)).toBe(true); // inside
		expect(isPosOnCheckboxToken(line, from + 2)).toBe(true); // on "]"
		expect(isPosOnCheckboxToken(line, from + 3)).toBe(false); // just after "]" (exclusive bound)
		expect(isPosOnCheckboxToken(line, line.length)).toBe(false);
	});

	it.each(["- [ ]x", "- [ab]", "-[ ]", "plain text", "", "> [!note]"])(
		"non-task %j is never on a token",
		(line) => {
			for (let ch = 0; ch <= line.length; ch++) {
				expect(isPosOnCheckboxToken(line, ch)).toBe(false);
			}
		}
	);
});

describe("isNonCheckboxTarget (G3 classes)", () => {
	it("covers exactly the seven G3 classes plus the LI padding", () => {
		expect([...NON_CHECKBOX_CLASSES]).toEqual([
			"cm-fold-indicator",
			"collapse-indicator",
			"collapse-icon",
			"cm-foldPlaceholder",
			"HyperMD-list-bullet",
			"list-bullet",
		]);
	});

	it.each([
		"cm-fold-indicator",
		"collapse-indicator",
		"collapse-icon",
		"cm-foldPlaceholder",
		"HyperMD-list-bullet",
		"list-bullet",
	])("%s as the target", (cls) => {
		expect(isNonCheckboxTarget([el("SPAN", cls), el("DIV", "cm-line")])).toBe(true);
	});

	it.each([
		"cm-fold-indicator",
		"collapse-indicator",
		"collapse-icon",
		"cm-foldPlaceholder",
		"HyperMD-list-bullet",
		"list-bullet",
	])("%s further up the path", (cls) => {
		expect(
			isNonCheckboxTarget([el("INPUT", "task-list-item-checkbox"), el("SPAN", cls)])
		).toBe(true);
	});

	it("an LI that is the target (its padding) is not ours", () => {
		expect(isNonCheckboxTarget([el("LI"), el("UL")])).toBe(true);
	});

	it("an LI that only contains the checkbox is fine", () => {
		expect(
			isNonCheckboxTarget([el("INPUT", "task-list-item-checkbox"), el("LI"), el("UL")])
		).toBe(false);
	});

	it("the checkbox widget on its own is not excluded", () => {
		expect(isNonCheckboxTarget([el("INPUT", "task-list-item-checkbox"), el("DIV", "cm-line")])).toBe(
			false
		);
	});

	it("`.bullet` alone is not in the list (only the G3 classes are)", () => {
		expect(isNonCheckboxTarget([el("SPAN", "bullet")])).toBe(false);
	});

	it("an empty path is not excluded", () => {
		expect(isNonCheckboxTarget([])).toBe(false);
	});
});

describe("pathHitsWidget / isInLivePreview", () => {
	it("finds the widget and the label", () => {
		expect(pathHitsWidget([el("INPUT", "task-list-item-checkbox")])).toEqual({
			hitsCheckbox: true,
			hitsLabel: false,
		});
		expect(pathHitsWidget([el("SPAN"), el("LABEL")])).toEqual({
			hitsCheckbox: false,
			hitsLabel: true,
		});
		expect(pathHitsWidget([el("SPAN", "task-list-label")]).hitsLabel).toBe(true);
	});

	it("a plain input or the source text is not the widget", () => {
		expect(pathHitsWidget([el("INPUT", "other")]).hitsCheckbox).toBe(false);
		expect(pathHitsWidget([el("SPAN", "cm-formatting-task"), el("DIV", "cm-line")])).toEqual({
			hitsCheckbox: false,
			hitsLabel: false,
		});
	});

	it("Live Preview needs .is-live-preview in the path", () => {
		expect(isInLivePreview([el("DIV", "markdown-source-view", "is-live-preview")])).toBe(true);
		expect(isInLivePreview([el("DIV", "markdown-source-view")])).toBe(false);
		expect(isInLivePreview([el("DIV", "markdown-reading-view")])).toBe(false);
	});
});

describe("isCheckboxPress", () => {
	const lp = el("DIV", "markdown-source-view", "is-live-preview");
	const widget = el("INPUT", "task-list-item-checkbox");
	const label = el("LABEL");
	const text = el("SPAN", "cm-list-1");

	it("the widget counts whatever column the editor reports", () => {
		expect(isCheckboxPress([widget, lp], "- [ ] a", 0)).toBe(true);
		expect(isCheckboxPress([widget, lp], "- [ ] a", 6)).toBe(true);
	});

	it("the widget on a non-task line does not count", () => {
		expect(isCheckboxPress([widget, lp], "- plain", 0)).toBe(false);
		expect(isCheckboxPress([widget, lp], "- [ ]x", 2)).toBe(false);
	});

	it("a label counts only on the token", () => {
		expect(isCheckboxPress([label, lp], "- [ ] a", 3)).toBe(true);
		expect(isCheckboxPress([label, lp], "- [ ] a", 5)).toBe(false);
	});

	it("text after the bracket is not a press", () => {
		expect(isCheckboxPress([text, lp], "- [ ] a", 6)).toBe(false);
	});

	it("Source mode and Reading view are not editor-line presses (Reading view is isRenderedTaskSurface's)", () => {
		const source = el("DIV", "markdown-source-view");
		const reading = el("DIV", "markdown-reading-view");
		expect(isCheckboxPress([widget, source], "- [ ] a", 2)).toBe(false);
		expect(isCheckboxPress([widget, reading], "- [ ] a", 2)).toBe(false);
	});

	it.each(NON_CHECKBOX_CLASSES)("%s in the path is not a press", (cls) => {
		expect(isCheckboxPress([el("SPAN", cls), widget, lp], "- [ ] a", 2)).toBe(false);
	});

	it.each(["1. [ ] a", "1) [ ] a", "* [ ] a", "+ [ ] a", "> - [ ] a", "> > 2) [ ] a"])(
		"works on %j",
		(line) => {
			expect(isCheckboxPress([label, lp], line, line.indexOf("[") + 1)).toBe(true);
		}
	);
});

describe("isRenderedTaskSurface: the gate for a checkbox Obsidian draws outside the live editor (E16, F4)", () => {
	const box = el("INPUT", "task-list-item-checkbox");
	const embed = el("DIV", "internal-embed", "markdown-embed");
	const lp = el("DIV", "markdown-source-view", "is-live-preview");
	const source = el("DIV", "markdown-source-view");
	const reading = el("DIV", "markdown-reading-view");
	const preview = el("DIV", "markdown-preview-view");

	// [surface, path from the checkbox outwards, handled]
	const surfaces: Array<[string, PathElement[], boolean]> = [
		["Reading view, the note's own checkbox", [box, preview, reading], true],
		["Reading view, a checkbox in an embed", [box, embed, preview, reading], true],
		["Reading view in a popout window (same classes, other document)", [box, preview, reading, el("DIV", "mod-popout")], true],
		["Reading view in a split pane", [box, preview, reading, el("DIV", "workspace-split")], true],
		["Live Preview, a checkbox in an embed", [box, embed, lp], true],
		["Live Preview, the editor's own checkbox widget", [box, el("DIV", "cm-line"), lp], false],
		["Source mode", [box, el("DIV", "cm-line"), source], false],
		["Source mode, an embed-looking element", [box, embed, source], false],
		["a canvas card", [box, embed, el("DIV", "canvas-node")], false],
		["a canvas card showing a note in Reading view", [box, preview, reading, el("DIV", "canvas-node")], false],
		["a canvas pane", [box, embed, leafContent("canvas")], false],
		["a hover popover over a link", [box, embed, el("DIV", "popover", "hover-popover")], false],
		["a hover popover with a Reading view in it", [box, preview, reading, el("DIV", "hover-popover")], false],
		["a search result", [box, el("DIV", "search-result")], false],
		["the search pane", [box, preview, reading, leafContent("search")], false],
		["the backlinks pane", [box, el("DIV", "backlink-pane")], false],
		["the backlinks pane, as a leaf", [box, embed, leafContent("backlink")], false],
		["the outgoing links pane", [box, embed, leafContent("outgoing-link")], false],
		["backlinks drawn under a Reading view", [box, el("DIV", "embedded-backlinks"), reading], false],
		["a Dataview block in a Reading view", [box, el("DIV", "block-language-dataview"), reading], false],
		["a Tasks query block in a Reading view", [box, el("DIV", "block-language-tasks"), reading], false],
		["a Tasks query result in a Reading view", [box, el("DIV", "plugin-tasks-query-result"), reading], false],
		["a Dataview block in an embed in Live Preview", [box, el("DIV", "block-language-dataview"), embed, lp], false],
		["a pane of another type that holds a Reading view", [box, preview, reading, leafContent("markdown")], true],
		["no known container", [box, el("DIV")], false],
		["an empty path", [], false],
	];

	it.each(surfaces)("%s -> %s", (_name, path, handled) => {
		expect(isRenderedTaskSurface(path)).toBe(handled);
	});

	it("Reading view flips from \"no\" (the editor gate) to \"yes\" (the rendered gate); the rest do not", () => {
		const path = [box, preview, reading];
		expect(isInLivePreview(path)).toBe(false);
		expect(isInReadingView(path)).toBe(true);
		expect(isRenderedTaskSurface(path)).toBe(true);
		for (const [, other, handled] of surfaces.filter(([n]) => !/^Reading view|^Live Preview, a checkbox|pane of another type/.test(n))) {
			expect(isRenderedTaskSurface(other)).toBe(handled);
			expect(handled).toBe(false);
		}
	});

	it("F4: the rejected container classes and leaf types are exactly these", () => {
		expect([...REJECTED_SURFACE_CLASSES]).toEqual([
			"canvas-node",
			"popover",
			"hover-popover",
			"search-result",
			"search-results-container",
			"backlink-pane",
			"embedded-backlinks",
			"block-language-dataview",
			"block-language-tasks",
			"plugin-tasks-query-result",
		]);
		expect([...REJECTED_LEAF_TYPES]).toEqual(["search", "backlink", "outgoing-link", "canvas"]);
	});

	it.each(REJECTED_SURFACE_CLASSES)("%s rejects a Reading view and an embed in Live Preview", (cls) => {
		expect(isRenderedTaskSurface([box, el("DIV", cls), reading])).toBe(false);
		expect(isRenderedTaskSurface([box, embed, lp, el("DIV", cls)])).toBe(false);
	});

	it.each(REJECTED_LEAF_TYPES)("a %s pane rejects a Reading view", (type) => {
		expect(isRenderedTaskSurface([box, reading, leafContent(type)])).toBe(false);
	});

	it("the editor gate still answers no for Reading view (it needs an editor line)", () => {
		expect(isCheckboxPress([box, reading], "- [ ] a", 2)).toBe(false);
	});
});
