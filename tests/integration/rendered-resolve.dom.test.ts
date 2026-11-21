// @vitest-environment happy-dom
// (happy-dom, like checkbox-press.dom.test.ts.)
/**
 * The resolver against embed DOM: duplicate identical task lines (E7) and an
 * embed inside an embed (E9). The nesting and the heading-embed markup are
 * the shapes Obsidian 1.15.1 drew in the probe (docs/probe-rendered-tasks.md).
 */
import type { App as ObsidianApp } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveRenderedTask } from "../../src/rendered/resolve-rendered-task";
import { App } from "../__mocks__/obsidian";
import {
	COURSE_CACHE,
	COURSE_TEXT,
	FORMS_CACHE,
	FORMS_TEXT,
} from "../fixtures/rendered-notes";
import { embed, mountHost, type TaskSpec } from "../helpers/rendered-dom";

const pos = (a: number, b = a) => ({ start: { line: a }, end: { line: b } });
const task = (text: string, dataLine: number, children?: TaskSpec[]): TaskSpec => ({
	text,
	dataLine,
	children,
});

const DUPES_TEXT = "- [ ] Parent ^dp\n\t- [ ] Read chapter 3\n\t- [ ] Read chapter 3\n";
const DUPES_CACHE = {
	blocks: { dp: { position: pos(0) } },
	listItems: [
		{ position: pos(0), parent: -1 },
		{ position: pos(1), parent: 0 },
		{ position: pos(2), parent: 0 },
	],
};

let app: App;
let host: HTMLElement;
const asApp = (): ObsidianApp => app as unknown as ObsidianApp;

beforeEach(() => {
	document.body.replaceChildren();
	app = new App();
	app.addNote("Course.md", COURSE_TEXT, COURSE_CACHE);
	app.addNote("Forms.md", FORMS_TEXT, FORMS_CACHE);
	app.addNote("Dupes.md", DUPES_TEXT, DUPES_CACHE);
	app.addNote("Inner.md", "Inner:\n![[Course#^l2]]\n", { embeds: [] });
	const outer = app.addNote("Outer.md", "Outer:\n![[Inner]]\n", { embeds: [] });
	host = mountHost(app, outer);
});

describe("E7: duplicate identical task lines", () => {
	it("a heading embed with two identical lines: each of the two is unmappable, the others resolve", async () => {
		const { el, boxes } = embed("Forms#Sub", [
			[task("Read chapter 3", 0), task("Read chapter 3", 1), task("Unique in sub", 2)],
			[task("Deep task", 0)],
		]);
		el.setAttribute("data-type", "heading");
		host.append(el);
		expect(boxes).toHaveLength(4);

		const before = app.vault.texts.get("Forms.md");
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({ unmappable: "ambiguous" });
		expect(await resolveRenderedTask(asApp(), boxes[1])).toEqual({ unmappable: "ambiguous" });
		// The tasks that are written once still resolve.
		expect(await resolveRenderedTask(asApp(), boxes[2])).toMatchObject({ line: 12 });
		expect(await resolveRenderedTask(asApp(), boxes[3])).toMatchObject({ line: 16 });
		expect(app.vault.texts.get("Forms.md")).toBe(before);
		expect(app.vault.writes).toEqual([]);
	});

	it("a whole-note embed with two identical lines is unmappable too", async () => {
		const { el, boxes } = embed("Forms", [[task("Read chapter 3", 0), task("Read chapter 3", 1)]]);
		host.append(el);
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({ unmappable: "ambiguous" });
		expect(await resolveRenderedTask(asApp(), boxes[1])).toEqual({ unmappable: "ambiguous" });
	});

	it("two identical lines where data-line plus the section start picks one: that one, not unmappable", async () => {
		const { el, boxes } = embed("Dupes#^dp", [
			[task("Parent ", 0, [task("Read chapter 3", 1), task("Read chapter 3", 2)])],
		]);
		host.append(el);
		expect(await resolveRenderedTask(asApp(), boxes[1])).toMatchObject({
			line: 1,
			rawLine: "\t- [ ] Read chapter 3",
		});
		expect(await resolveRenderedTask(asApp(), boxes[2])).toMatchObject({
			line: 2,
			rawLine: "\t- [ ] Read chapter 3",
		});
	});

	it("the same two lines, embedded as the whole note, are unmappable", async () => {
		const { el, boxes } = embed("Dupes", [
			[task("Parent ", 0, [task("Read chapter 3", 1), task("Read chapter 3", 2)])],
		]);
		host.append(el);
		expect(await resolveRenderedTask(asApp(), boxes[1])).toEqual({ unmappable: "ambiguous" });
		expect(await resolveRenderedTask(asApp(), boxes[0])).toMatchObject({ line: 0 });
	});
});

describe("E9: an embed inside an embed", () => {
	const lesson = [task("Lesson 2 content ", 0, [task("Watch video", 1), task("Take notes", 2)])];

	it("the innermost embed's src is used, not the outer one", async () => {
		const inner = embed("Course#^l2", [lesson]);
		const outer = embed("Inner", [], [inner.el]);
		host.append(outer.el);
		expect(inner.el.closest(".internal-embed")).toBe(inner.el);
		expect(outer.el.contains(inner.el)).toBe(true);

		// With the outer `Inner` src the content check would find no task
		// ("Inner" has none); the answer comes from Course.md.
		expect(await resolveRenderedTask(asApp(), inner.boxes[0])).toMatchObject({
			file: app.vault.getAbstractFileByPath("Course.md"),
			line: 0,
			rawLine: "- [ ] Lesson 2 content ^l2",
		});
		expect(await resolveRenderedTask(asApp(), inner.boxes[2])).toMatchObject({
			file: app.vault.getAbstractFileByPath("Course.md"),
			line: 2,
		});
	});

	it("the nearest embed decides, whatever the outer embed's note would answer", async () => {
		// Same checkbox, but its nearest embed is the outer `Dupes` whole-note embed.
		const outerOnly = embed("Dupes", [[task("Read chapter 3", 1)]]);
		host.append(outerOnly.el);
		expect(await resolveRenderedTask(asApp(), outerOnly.boxes[0])).toEqual({
			unmappable: "ambiguous",
		});

		document.body.replaceChildren();
		host = mountHost(app, app.vault.getAbstractFileByPath("Outer.md"));
		const inner = embed("Course#^l2", [[task("Read chapter 3", 1)]]);
		const outer = embed("Dupes", [], [inner.el]);
		host.append(outer.el);
		// Innermost is Course#^l2, which has no such task: not the outer note's ambiguity.
		expect(await resolveRenderedTask(asApp(), inner.boxes[0])).toEqual({
			unmappable: "position-mismatch",
		});
	});

	it("three levels deep still uses the innermost src", async () => {
		const inner = embed("Course#^l2", [lesson]);
		const middle = embed("Inner", [], [inner.el]);
		const top = embed("Outer", [], [middle.el]);
		host.append(top.el);
		expect(await resolveRenderedTask(asApp(), inner.boxes[1])).toMatchObject({
			file: app.vault.getAbstractFileByPath("Course.md"),
			line: 1,
		});
	});

	it("a heading embed nested in a block embed uses the heading embed", async () => {
		const inner = embed("Forms#Sub", [[task("Unique in sub", 2)]]);
		const outer = embed("Course#^l2", [], [inner.el]);
		host.append(outer.el);
		expect(await resolveRenderedTask(asApp(), inner.boxes[0])).toMatchObject({
			file: app.vault.getAbstractFileByPath("Forms.md"),
			line: 12,
		});
	});
});
