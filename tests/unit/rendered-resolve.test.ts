// @vitest-environment happy-dom
/**
 * The resolver through its real code path: a real DOM of the shape Obsidian
 * draws (tests/helpers/rendered-dom.ts), a mock workspace with the Markdown
 * view it sits in, and a hand-built `metadataCache` (`headings`, `blocks`,
 * `listItems`) plus `vault.getAbstractFileByPath` / `cachedRead` from
 * tests/__mocks__/obsidian.ts.
 */
import type { App as ObsidianApp } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { locateRenderedTask, resolveRenderedTask } from "../../src/rendered/resolve-rendered-task";
import { App } from "../__mocks__/obsidian";
import {
	COURSE_CACHE,
	COURSE_TEXT,
	FORMS_CACHE,
	FORMS_TEXT,
	SHAPES_CACHE,
	SHAPES_TEXT,
	TABS_CACHE,
	TABS_TEXT,
} from "../fixtures/rendered-notes";
import { embed, mountHost, readingView, type TaskSpec } from "../helpers/rendered-dom";

let app: App;
let host: HTMLElement;

beforeEach(() => {
	document.body.replaceChildren();
	app = new App();
	app.addNote("Course.md", COURSE_TEXT, COURSE_CACHE);
	app.addNote("Forms.md", FORMS_TEXT, FORMS_CACHE);
	app.addNote("Shapes.md", SHAPES_TEXT, SHAPES_CACHE);
	app.addNote("Tabs.md", TABS_TEXT, TABS_CACHE);
	const queue = app.addNote("Learning Queue.md", "![[Course#^l2]]\n");
	host = mountHost(app, queue);
});

const asApp = (): ObsidianApp => app as unknown as ObsidianApp;

/** Embed `src` in the host view and return the checkbox at `index` in document order. */
function boxIn(src: string, sections: TaskSpec[][], index = 0): HTMLInputElement {
	const { el, boxes } = embed(src, sections);
	host.append(el);
	return boxes[index];
}

const task = (text: string, dataLine: number, children?: TaskSpec[]): TaskSpec => ({
	text,
	dataLine,
	children,
});

describe("a resolved task is { file, line, rawLine, status }", () => {
	it("the golden path: the parent of ![[Course#^l2]] is Course.md line 0", async () => {
		const box = boxIn("Course#^l2", [
			[task("Lesson 2 content ", 0, [task("Watch video", 1), task("Take notes", 2)])],
		]);
		const out = await resolveRenderedTask(asApp(), box);
		expect(out).toEqual({
			file: app.vault.getAbstractFileByPath("Course.md"),
			line: 0,
			rawLine: "- [ ] Lesson 2 content ^l2",
			status: " ",
		});
	});

	it("a subtask checkbox in the same embed resolves to its own line", async () => {
		const sections = [[task("Lesson 2 content ", 0, [task("Watch video", 1), task("Take notes", 2)])]];
		const { el, boxes } = embed("Course#^l2", sections);
		host.append(el);
		const watch = await resolveRenderedTask(asApp(), boxes[1]);
		const notes = await resolveRenderedTask(asApp(), boxes[2]);
		expect(watch).toMatchObject({ line: 1, rawLine: "\t- [ ] Watch video", status: " " });
		expect(notes).toMatchObject({ line: 2, rawLine: "\t- [ ] Take notes", status: " " });
	});

	it("reports the status char on the line, and the line without its CR", async () => {
		app.vault.texts.set("Course.md", "- [/] Lesson 2 content ^l2\r\n\t- [ ] Watch video\r\n");
		const box = boxIn("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		expect(await resolveRenderedTask(asApp(), box)).toMatchObject({
			line: 0,
			rawLine: "- [/] Lesson 2 content ^l2",
			status: "/",
		});
	});

	it("reports a stamped line with its stamp in rawLine", async () => {
		app.vault.texts.set("Course.md", "- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n");
		const box = boxIn("Course#^l2", [[task("Lesson 2 content ✅ 2026-11-20 ", 0)]]);
		expect(await resolveRenderedTask(asApp(), box)).toMatchObject({
			line: 0,
			rawLine: "- [x] Lesson 2 content ✅ 2026-11-20 ^l2",
			status: "x",
		});
	});
});

describe("embed forms (E13)", () => {
	interface FormCase {
		name: string;
		src: string;
		sections: TaskSpec[][];
		/** Index of the checkbox in document order. */
		box: number;
		expected: { file: string; line: number } | { unmappable: string } | { notIntercepted: string };
	}

	const SUB_SECTIONS = [
		[task("Read chapter 3", 0), task("Read chapter 3", 1), task("Unique in sub", 2)],
		[task("Deep task", 0)],
	];

	const cases: FormCase[] = [
		{
			name: "block id on a list item, parent",
			src: "Forms#^li",
			sections: [[task("Item one ", 0, [task("Child task ", 1), task("Child two", 2)])]],
			box: 0,
			expected: { file: "Forms.md", line: 4 },
		},
		{
			name: "block id on a list item, its child without a block id",
			src: "Forms#^li",
			sections: [[task("Item one ", 0, [task("Child task ", 1), task("Child two", 2)])]],
			box: 2,
			expected: { file: "Forms.md", line: 6 },
		},
		{
			name: "block id on a nested child",
			src: "Forms#^child",
			sections: [[task("Child task ", 0)]],
			box: 0,
			expected: { file: "Forms.md", line: 5 },
		},
		{
			name: "block id on a paragraph covers only the paragraph (no task there)",
			src: "Forms#^para",
			sections: [[task("Item one ", 0)]],
			box: 0,
			expected: { unmappable: "position-mismatch" },
		},
		{
			name: "block id with a size, Course#^l2|300",
			src: "Course#^l2|300",
			sections: [[task("Lesson 2 content ", 0, [task("Watch video", 1)])]],
			box: 0,
			expected: { file: "Course.md", line: 0 },
		},
		{
			name: "block id with an alias, Course#^l2|the lesson",
			src: "Course#^l2|the lesson",
			sections: [[task("Lesson 2 content ", 0)]],
			box: 0,
			expected: { file: "Course.md", line: 0 },
		},
		{
			name: "heading, a unique task",
			src: "Forms#Sub",
			sections: SUB_SECTIONS,
			box: 2,
			expected: { file: "Forms.md", line: 12 },
		},
		{
			name: "heading, a task in a deeper heading's section",
			src: "Forms#Sub",
			sections: SUB_SECTIONS,
			box: 3,
			expected: { file: "Forms.md", line: 16 },
		},
		{
			name: "nested heading Forms#Top#Sub",
			src: "Forms#Top#Sub",
			sections: SUB_SECTIONS,
			box: 2,
			expected: { file: "Forms.md", line: 12 },
		},
		{
			name: "nested heading Forms#Other#Sub is the second Sub",
			src: "Forms#Other#Sub",
			sections: [[task("Other sub task", 0)]],
			box: 0,
			expected: { file: "Forms.md", line: 22 },
		},
		{
			name: "nested heading does not reach a task of a different Sub",
			src: "Forms#Top#Sub",
			sections: [[task("Other sub task", 0)]],
			box: 0,
			expected: { unmappable: "no-candidate" },
		},
		{
			name: "a heading that is not in the cache",
			src: "Forms#Missing",
			sections: [[task("Unique in sub", 0)]],
			box: 0,
			expected: { unmappable: "target-not-found" },
		},
		{
			name: "a block id that is not in the cache",
			src: "Forms#^nope",
			sections: [[task("Item one ", 0)]],
			box: 0,
			expected: { unmappable: "target-not-found" },
		},
		{
			name: "whole note, a unique task",
			src: "Forms",
			sections: [[task("Unique in sub", 2)], [task("Deep task", 0)]],
			box: 1,
			expected: { file: "Forms.md", line: 16 },
		},
		{
			name: "whole note, a task that is written twice",
			src: "Forms",
			sections: [[task("Read chapter 3", 0)]],
			box: 0,
			expected: { unmappable: "ambiguous" },
		},
		{
			name: "heading, a task that is written twice (E7)",
			src: "Forms#Sub",
			sections: SUB_SECTIONS,
			box: 0,
			expected: { unmappable: "ambiguous" },
		},
		{
			name: "the path with the extension, Forms.md#Sub",
			src: "Forms.md#Sub",
			sections: SUB_SECTIONS,
			box: 2,
			expected: { file: "Forms.md", line: 12 },
		},
		{
			name: "a rendered task whose text is in no source line",
			src: "Forms#Sub",
			sections: [[task("Something else entirely", 0)]],
			box: 0,
			expected: { unmappable: "no-candidate" },
		},
	];

	it.each(cases)("$name", async ({ src, sections, box, expected }) => {
		const checkbox = boxIn(src, sections, box);
		const out = await resolveRenderedTask(asApp(), checkbox);
		if ("file" in expected) {
			expect(out).toMatchObject({
				file: app.vault.getAbstractFileByPath(expected.file),
				line: expected.line,
			});
		} else {
			expect(out).toEqual(expected);
		}
	});
});

describe("non-markdown embeds and unresolved links are not intercepted (E13)", () => {
	beforeEach(() => {
		app.addNote("image.png", "");
		app.addNote("x.pdf", "");
	});

	it.each([
		["![[image.png]]", "image.png"],
		["![[x.pdf]]", "x.pdf"],
		["![[x.pdf#page=3]]", "x.pdf#page=3"],
		["an unresolved link", "Nonexistent"],
		["an unresolved block link", "Nonexistent#^id"],
	])("%s", async (_name, src) => {
		const out = await resolveRenderedTask(asApp(), boxIn(src, [[task("Anything", 0)]]));
		expect(out).toEqual({
			notIntercepted: src.startsWith("Nonexistent") ? "unresolved-link" : "non-markdown-embed",
		});
		expect("unmappable" in out).toBe(false);
	});
});

describe("task shapes (E14) resolve with the shared line classifier", () => {
	interface ShapeCase {
		name: string;
		note: string;
		src: string;
		text: string;
		dataLine: number;
		line: number;
		status: string;
	}
	const cases: ShapeCase[] = [
		{ name: "a callout task", note: "Shapes", src: "Shapes#^cal", text: "callout task ", dataLine: 1, line: 3, status: " " },
		{ name: "the next callout task, no block id", note: "Shapes", src: "Shapes#^cal", text: "callout two", dataLine: 2, line: 4, status: " " },
		{ name: "a blockquote task", note: "Shapes", src: "Shapes#^quo", text: "quote task ", dataLine: 0, line: 6, status: " " },
		{ name: "a numbered 1. task", note: "Shapes", src: "Shapes#^nd", text: "numbered dot ", dataLine: 0, line: 8, status: " " },
		{ name: "a numbered 1) task by content", note: "Shapes", src: "Shapes", text: "numbered paren", dataLine: 0, line: 9, status: " " },
		{ name: "an empty task by content", note: "Shapes", src: "Shapes", text: "\n\n", dataLine: 0, line: 11, status: " " },
		{
			name: "a task with bold, a wikilink alias, code and an inline field",
			note: "Shapes",
			src: "Shapes#^rich",
			text: "bold and alias and code [due:: 2026-11-30] ",
			dataLine: 0,
			line: 21,
			status: " ",
		},
		{ name: "a tab-indented task", note: "Tabs", src: "Tabs#^tp", text: "Tab child ", dataLine: 1, line: 1, status: " " },
		{ name: "a task two tabs deep", note: "Tabs", src: "Tabs#^tp", text: "Two tabs deep", dataLine: 2, line: 2, status: " " },
	];

	it.each(cases)("$name", async ({ note, src, text, dataLine, line, status }) => {
		const checkbox = boxIn(src, [[task(text, dataLine)]]);
		const out = await resolveRenderedTask(asApp(), checkbox);
		expect(out).toMatchObject({
			file: app.vault.getAbstractFileByPath(`${note}.md`),
			line,
			status,
		});
	});

	it("a task inside a table cell is unmappable", async () => {
		const { el, boxes } = embed("Shapes", [[task("in table", 0)]]);
		const table = document.createElement("table");
		const cell = document.createElement("td");
		const row = document.createElement("tr");
		table.append(row);
		row.append(cell);
		cell.append(boxes[0], document.createTextNode("in table"));
		el.querySelector(".el-ul")?.replaceWith(table);
		host.append(el);
		expect(boxes[0].closest("table")).not.toBeNull();
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({ unmappable: "table-cell" });
	});

	it("a task-looking line inside a code fence is never the answer", async () => {
		const checkbox = boxIn("Shapes", [[task("fenced", 0)]]);
		expect(await resolveRenderedTask(asApp(), checkbox)).toEqual({ unmappable: "no-candidate" });
	});
});

describe("a stale or missing source is unmappable, never a throw", () => {
	it("the source has no metadata cache", async () => {
		app.metadataCache.caches.delete("Course.md");
		const box = boxIn("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		expect(await resolveRenderedTask(asApp(), box)).toEqual({ unmappable: "no-cache" });
	});

	it("the cache points past the end of the file", async () => {
		app.vault.texts.set("Course.md", "- [ ] Lesson 2 content ^l2\n");
		app.metadataCache.caches.set("Course.md", {
			blocks: { l2: { position: { start: { line: 40 }, end: { line: 40 } } } },
		});
		const box = boxIn("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		expect(await resolveRenderedTask(asApp(), box)).toEqual({ unmappable: "stale-cache" });
	});

	it("the file moved one line down since the cache was built", async () => {
		app.vault.texts.set("Course.md", "\n- [ ] Lesson 2 content ^l2\n");
		const box = boxIn("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		expect(await resolveRenderedTask(asApp(), box)).toEqual({ unmappable: "position-mismatch" });
	});

	it("the file was edited so the line says something else", async () => {
		app.vault.texts.set("Course.md", "- [ ] A different lesson ^l2\n");
		const box = boxIn("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		expect(await resolveRenderedTask(asApp(), box)).toEqual({ unmappable: "position-mismatch" });
	});

	it("the file cannot be read", async () => {
		app.vault.unreadable.add("Course.md");
		const box = boxIn("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		expect(await resolveRenderedTask(asApp(), box)).toEqual({ unmappable: "read-failed" });
	});

	it("the embed has no src", async () => {
		const { el, boxes } = embed("x", [[task("Lesson 2 content ", 0)]]);
		el.removeAttribute("src");
		host.append(el);
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({ unmappable: "no-embed-src" });
	});

	it("an app whose cache throws gives unmappable, not an exception", async () => {
		const box = boxIn("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		app.metadataCache.getFileCache = () => {
			throw new Error("boom");
		};
		await expect(resolveRenderedTask(asApp(), box)).resolves.toEqual({ unmappable: "error" });
		expect(locateRenderedTask(asApp(), box)).toEqual({ unmappable: "error" });
	});

	it("null and a non-element are not checkboxes, not exceptions", async () => {
		await expect(resolveRenderedTask(asApp(), null as unknown as Element)).resolves.toEqual({
			notIntercepted: "not-a-checkbox",
		});
		await expect(
			resolveRenderedTask(asApp(), document.createElement("div"))
		).resolves.toEqual({ notIntercepted: "not-a-checkbox" });
	});
});

describe("the note's own Reading view", () => {
	it("resolves a task by content in the host note", async () => {
		const course = app.vault.getAbstractFileByPath("Course.md");
		app.workspace.leaves.length = 0;
		const own = mountHost(app, course);
		const { el, boxes } = readingView([
			[task("Lesson 2 content ", 0, [task("Watch video", 1), task("Take notes", 2)])],
		]);
		own.append(el);
		expect(await resolveRenderedTask(asApp(), boxes[2])).toMatchObject({
			file: course,
			line: 2,
			rawLine: "\t- [ ] Take notes",
		});
	});

	it("gives unmappable for a task written twice (no section start is known)", async () => {
		const forms = app.vault.getAbstractFileByPath("Forms.md");
		app.workspace.leaves.length = 0;
		const own = mountHost(app, forms);
		const { el, boxes } = readingView([[task("Read chapter 3", 0)]]);
		own.append(el);
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({ unmappable: "ambiguous" });
	});
});

describe("surfaces this plugin does not handle are not intercepted (F4)", () => {
	function wrap(className: string, attrs: Record<string, string> = {}): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.className = className;
		for (const [k, v] of Object.entries(attrs)) wrapper.setAttribute(k, v);
		return wrapper;
	}

	const surfaces: Array<[string, () => HTMLElement]> = [
		["a canvas node", () => wrap("canvas-node")],
		["a hover popover", () => wrap("popover hover-popover")],
		["a search result", () => wrap("search-result")],
		["a backlinks pane", () => wrap("backlink-pane")],
		["the backlinks panel at the foot of a note", () => wrap("embedded-backlinks")],
		["a search leaf", () => wrap("workspace-leaf-content", { "data-type": "search" })],
		["a canvas leaf", () => wrap("workspace-leaf-content", { "data-type": "canvas" })],
		["a Dataview query result", () => wrap("block-language-dataview")],
		["a Tasks query result", () => wrap("plugin-tasks-query-result")],
	];

	it.each(surfaces)("%s, even with an embed and a Markdown view around it", async (_n, make) => {
		const { el, boxes } = embed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		const surface = make();
		surface.append(el);
		host.append(surface);
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({
			notIntercepted: "unsupported-surface",
		});
	});

	it.each(surfaces)("%s with no Markdown view at all", async (_n, make) => {
		app.workspace.leaves.length = 0;
		const { el, boxes } = embed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		const surface = make();
		surface.append(el);
		document.body.append(surface);
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({
			notIntercepted: "unsupported-surface",
		});
	});

	it("an embed drawn outside every Markdown view (a canvas card, a popover body)", async () => {
		const { el, boxes } = embed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		document.body.append(el);
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({
			notIntercepted: "no-markdown-view",
		});
	});

	it("a Markdown view with no file", async () => {
		app.workspace.leaves.length = 0;
		const bare = mountHost(app, null);
		const { el, boxes } = embed("Course#^l2", [[task("Lesson 2 content ", 0)]]);
		bare.append(el);
		expect(await resolveRenderedTask(asApp(), boxes[0])).toEqual({
			notIntercepted: "no-markdown-view",
		});
	});

	it("the editor's own checkbox widget (not rendered by an embed or Reading view)", async () => {
		const live = document.createElement("div");
		live.className = "cm-line";
		const box = document.createElement("input");
		box.type = "checkbox";
		box.className = "task-list-item-checkbox";
		live.append(box);
		host.append(live);
		expect(await resolveRenderedTask(asApp(), box)).toEqual({ notIntercepted: "editor-checkbox" });
	});

	it("canvas, popover and search DOM with no embed and no Reading view ancestor", async () => {
		for (const cls of ["canvas-node-content", "popover-body", "search-result-file-match"]) {
			const wrapper = document.createElement("div");
			wrapper.className = cls;
			const box = document.createElement("input");
			box.type = "checkbox";
			box.className = "task-list-item-checkbox";
			wrapper.append(box);
			document.body.append(wrapper);
			const out = await resolveRenderedTask(asApp(), box);
			expect("notIntercepted" in out, cls).toBe(true);
			expect("unmappable" in out, cls).toBe(false);
		}
	});

	it("an element that is not a task checkbox", async () => {
		const plain = document.createElement("input");
		plain.type = "checkbox";
		host.append(plain);
		expect(await resolveRenderedTask(asApp(), plain)).toEqual({
			notIntercepted: "not-a-checkbox",
		});
	});
});

describe("read-only and idempotent", () => {
	const sections = [[task("Lesson 2 content ", 0, [task("Watch video", 1)])]];

	it("resolving twice gives equal results and leaves the file's bytes unchanged", async () => {
		const { el, boxes } = embed("Course#^l2", sections);
		host.append(el);
		const before = app.vault.texts.get("Course.md");
		const first = await resolveRenderedTask(asApp(), boxes[1]);
		const second = await resolveRenderedTask(asApp(), boxes[1]);
		expect(second).toEqual(first);
		expect(first).toMatchObject({ line: 1 });
		expect(app.vault.texts.get("Course.md")).toBe(before);
		expect(app.vault.writes).toEqual([]);
	});

	it("an unmappable result is also stable", async () => {
		const box = boxIn("Forms", [[task("Read chapter 3", 0)]]);
		const first = await resolveRenderedTask(asApp(), box);
		expect(await resolveRenderedTask(asApp(), box)).toEqual(first);
		expect(first).toEqual({ unmappable: "ambiguous" });
	});

	it("calls no write method of the vault", async () => {
		const box = boxIn("Course#^l2", sections);
		await resolveRenderedTask(asApp(), box);
		expect(app.vault.writes).toEqual([]);
		expect(app.vault.reads).toBe(1);
	});

	it("does not change the DOM it reads", async () => {
		const { el, boxes } = embed("Course#^l2", sections);
		host.append(el);
		const html = host.innerHTML;
		await resolveRenderedTask(asApp(), boxes[0]);
		expect(host.innerHTML).toBe(html);
	});

	it("does not touch the click: it is not prevented, stopped or consumed", async () => {
		const { el, boxes } = embed("Course#^l2", sections);
		host.append(el);
		await resolveRenderedTask(asApp(), boxes[0]);

		let reachedDocument = false;
		document.addEventListener("click", () => (reachedDocument = true), { once: true });
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		boxes[0].dispatchEvent(click);
		expect(click.defaultPrevented).toBe(false);
		expect(reachedDocument).toBe(true);
	});
});
