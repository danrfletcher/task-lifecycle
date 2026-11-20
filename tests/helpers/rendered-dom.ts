/**
 * Builders for the DOM Obsidian draws for a rendered task, copied from what
 * the real app produced in the probe (docs/probe-rendered-tasks.md), and for
 * a mock workspace that holds the Markdown view the DOM sits in.
 */
import { App, type MockTFile } from "../__mocks__/obsidian";

export interface TaskSpec {
	/** The text drawn next to the checkbox (what `li.textContent` holds without children). */
	text: string;
	/** `data-line` of the list item and of its checkbox. */
	dataLine: number;
	children?: TaskSpec[];
}

function taskItem(spec: TaskSpec, boxes: HTMLInputElement[]): HTMLElement {
	const li = document.createElement("li");
	li.className = "task-list-item";
	li.setAttribute("data-task", " ");
	li.setAttribute("data-line", String(spec.dataLine));
	const bullet = document.createElement("span");
	bullet.className = "list-bullet";
	const box = document.createElement("input");
	box.className = "task-list-item-checkbox";
	box.type = "checkbox";
	box.setAttribute("data-line", String(spec.dataLine));
	boxes.push(box);
	li.append(bullet, box, document.createTextNode(spec.text));
	if (spec.children?.length) {
		const ul = document.createElement("ul");
		ul.className = "contains-task-list";
		for (const child of spec.children) ul.append(taskItem(child, boxes));
		li.append(document.createTextNode("\n"), ul);
	}
	return li;
}

/** One rendered list section: `div.el-ul > ul`. */
export function listSection(items: TaskSpec[], boxes: HTMLInputElement[]): HTMLElement {
	const div = document.createElement("div");
	div.className = "el-ul";
	const ul = document.createElement("ul");
	ul.className = "contains-task-list has-list-bullet";
	for (const item of items) ul.append(taskItem(item, boxes));
	div.append(ul);
	return div;
}

/** A `.markdown-preview-sizer` holding the given sections, inside a `.markdown-preview-view`. */
export function previewView(sections: HTMLElement[]): HTMLElement {
	const view = document.createElement("div");
	view.className = "markdown-preview-view markdown-rendered";
	const sizer = document.createElement("div");
	sizer.className = "markdown-preview-sizer markdown-preview-section";
	sizer.append(...sections);
	view.append(sizer);
	return view;
}

/**
 * An embed as Obsidian draws it. `sections` are the rendered list sections;
 * `inner` (an already built embed or node) goes in as extra content, which is
 * how a nested embed is made. Returns the embed and every checkbox in the
 * sections, in document order.
 */
export function embed(
	src: string,
	sections: TaskSpec[][],
	inner: HTMLElement[] = []
): { el: HTMLElement; boxes: HTMLInputElement[] } {
	const boxes: HTMLInputElement[] = [];
	const el = document.createElement("div");
	el.className = "internal-embed markdown-embed inline-embed is-loaded";
	el.setAttribute("src", src);
	const content = document.createElement("div");
	content.className = "markdown-embed-content";
	const rendered = sections.map((items) => listSection(items, boxes));
	content.append(previewView([...rendered, ...inner]));
	el.append(content);
	return { el, boxes };
}

/**
 * Register a Markdown view for `file` in the mock workspace and return its
 * content element, attached to the document.
 */
export function mountHost(app: App, file: MockTFile | null): HTMLElement {
	const contentEl = document.createElement("div");
	contentEl.className = "view-content";
	document.body.append(contentEl);
	app.workspace.leaves.push({ view: { contentEl, file } });
	return contentEl;
}

/** The checkboxes of a note's own Reading view. */
export function readingView(
	sections: TaskSpec[][]
): { el: HTMLElement; boxes: HTMLInputElement[] } {
	const boxes: HTMLInputElement[] = [];
	const el = document.createElement("div");
	el.className = "markdown-reading-view";
	el.append(previewView(sections.map((items) => listSection(items, boxes))));
	return { el, boxes };
}
