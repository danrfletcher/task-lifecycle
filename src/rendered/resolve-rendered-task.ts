/**
 * Resolve a rendered task checkbox to exactly one (file, source line).
 *
 * Read-only by design: this module reads the DOM, `app.metadataCache` and the
 * source file's text (`vault.cachedRead`). It never writes a note, never
 * registers a listener and never touches an event, so Obsidian's native
 * toggle is left exactly as it was.
 *
 * Three answers:
 *  - a resolved task `{ file, line, rawLine, status }`;
 *  - `{ unmappable: reason }`: it is a task this plugin would handle, but it
 *    cannot be placed on one line (no match, several matches, a stale cache,
 *    a task in a table cell, ...). The caller decides what to do (G10).
 *  - `{ notIntercepted: reason }`: not a surface this plugin handles at all
 *    (canvas, hover preview, search, backlinks, a non-markdown or unresolved
 *    embed, the editor's own checkbox widget). Native behaviour stays and
 *    there is nothing to stamp. Distinct from `unmappable`.
 *
 * The DOM facts this relies on are recorded in docs/probe-rendered-tasks.md:
 * the nearest `.internal-embed` / `.markdown-embed` carries the embed `src`
 * (the innermost one for an embed inside an embed); `data-line` is 0-based and
 * relative to the rendered section, so it is used as a position only for a
 * block embed, which is exactly one section.
 */
import type { App, CachedMetadata, MarkdownView, TFile } from "obsidian";

import {
	parseEmbedSrc,
	resolveEmbedRange,
	type EmbedRange,
	type EmbedTarget,
} from "../domain/embed-range";
import { getCheckboxStatusChar } from "../domain/line-classifier";
import { matchRenderedTask, type MatchFailure } from "../domain/rendered-match";

export interface ResolvedRenderedTask {
	file: TFile;
	/** 0-based line in the source note. */
	line: number;
	/** The line as it is in the file, without its line ending. */
	rawLine: string;
	/** The checkbox character on that line. */
	status: string;
}

export type UnmappableReason =
	| MatchFailure
	| "table-cell"
	| "no-embed-src"
	| "no-cache"
	| "target-not-found"
	| "stale-cache"
	| "read-failed"
	| "error";

export type NotInterceptedReason =
	| "not-a-checkbox"
	| "unsupported-surface"
	| "no-markdown-view"
	| "editor-checkbox"
	| "unresolved-link"
	| "non-markdown-embed";

export interface Unmappable {
	unmappable: UnmappableReason;
}

export interface NotIntercepted {
	notIntercepted: NotInterceptedReason;
}

export type RenderedTaskResult = ResolvedRenderedTask | Unmappable | NotIntercepted;

/** What the DOM and the cache say about a rendered checkbox, before the file is read. */
export interface RenderedTaskLocation {
	file: TFile;
	/** The source lines the embed (or the whole note) shows. */
	range: EmbedRange;
	/** `data-line` of the checkbox, or null if it has none. */
	dataLine: number | null;
	/** The text Obsidian drew next to the checkbox. */
	renderedText: string;
}

export type LocateResult = { located: RenderedTaskLocation } | Unmappable | NotIntercepted;

/** Surfaces this plugin never handles (F4), matched by an ancestor. */
const UNSUPPORTED_SURFACE = [
	".canvas-node",
	".popover",
	".hover-popover",
	".search-result",
	".search-results-container",
	".backlink-pane",
	".embedded-backlinks",
	'.workspace-leaf-content[data-type="search"]',
	'.workspace-leaf-content[data-type="backlink"]',
	'.workspace-leaf-content[data-type="outgoing-link"]',
	'.workspace-leaf-content[data-type="canvas"]',
	// Query renderings draw their own checkboxes from an index, not from one note.
	".block-language-dataview",
	".block-language-tasks",
	".plugin-tasks-query-result",
].join(", ");

const EMBED_SELECTOR = ".internal-embed, .markdown-embed";
const READING_VIEW_SELECTOR = ".markdown-preview-view, .markdown-reading-view";

/** The Markdown view whose content element holds `el`, or null (canvas, search, a popover, ...). */
function hostView(app: App, el: Element): MarkdownView | null {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view as MarkdownView | undefined;
		if (view?.contentEl?.contains(el)) return view;
	}
	return null;
}

/**
 * The text Obsidian drew next to the checkbox: its list item without the
 * checkbox, the bullet and any nested list (the children's own text).
 */
function renderedTextOf(checkbox: Element): string {
	const root = checkbox.closest("li") ?? checkbox.parentElement;
	if (!root) return "";
	const clone = root.cloneNode(true) as Element;
	clone.querySelectorAll("ul, ol, input, .list-bullet, .collapse-indicator").forEach((n) => n.remove());
	return clone.textContent ?? "";
}

/** `data-line` of the checkbox (or its list item), 0-based, or null. */
function dataLineOf(checkbox: Element): number | null {
	const raw =
		checkbox.getAttribute("data-line") ?? checkbox.closest("li")?.getAttribute("data-line") ?? null;
	if (raw === null || !/^\d+$/.test(raw)) return null;
	return Number(raw);
}

function isTaskCheckbox(el: Element): boolean {
	return (
		el.tagName === "INPUT" &&
		(el as HTMLInputElement).type === "checkbox" &&
		el.classList.contains("task-list-item-checkbox")
	);
}

/**
 * Everything that can be decided without reading the source file: which
 * surface the checkbox is on, which note and lines it belongs to, what it
 * says and where `data-line` points. Synchronous, never throws.
 */
export function locateRenderedTask(app: App, checkbox: Element): LocateResult {
	try {
		return locate(app, checkbox);
	} catch {
		return { unmappable: "error" };
	}
}

function locate(app: App, checkbox: Element): LocateResult {
	if (!checkbox || checkbox.nodeType !== 1 || !isTaskCheckbox(checkbox)) {
		return { notIntercepted: "not-a-checkbox" };
	}
	if (checkbox.closest(UNSUPPORTED_SURFACE)) return { notIntercepted: "unsupported-surface" };

	const embed = checkbox.closest(EMBED_SELECTOR);
	if (!embed && !checkbox.closest(READING_VIEW_SELECTOR)) {
		// The editor's own checkbox widget: the in-editor path handles it.
		return { notIntercepted: "editor-checkbox" };
	}

	const view = hostView(app, checkbox);
	const host = view?.file ?? null;
	if (!view || !host) return { notIntercepted: "no-markdown-view" };

	if (checkbox.closest("table")) return { unmappable: "table-cell" };

	let file: TFile | null = host;
	// No embed: the checkbox is in the note's own Reading view, the whole note.
	let target: EmbedTarget = { kind: "note", linkpath: "" };
	if (embed) {
		const src = embed.getAttribute("src");
		if (!src) return { unmappable: "no-embed-src" };
		target = parseEmbedSrc(src);
		if (target.linkpath !== "") {
			file = app.metadataCache.getFirstLinkpathDest(target.linkpath, host.path);
			if (!file) return { notIntercepted: "unresolved-link" };
		}
	}
	if (file.extension.toLowerCase() !== "md") return { notIntercepted: "non-markdown-embed" };

	const cache: CachedMetadata | null = app.metadataCache.getFileCache(file);
	if (!cache) return { unmappable: "no-cache" };

	const range = resolveEmbedRange(cache, target);
	if (!range) return { unmappable: "target-not-found" };

	return {
		located: {
			file,
			range,
			dataLine: dataLineOf(checkbox),
			renderedText: renderedTextOf(checkbox),
		},
	};
}

/**
 * Resolve a rendered task checkbox to its source file and line.
 *
 * Exactly one candidate line gives a result. Zero or several give
 * `{ unmappable }`. It never throws, never writes and never touches the
 * click: the same element resolved twice gives equal results and leaves the
 * file as it was.
 */
export async function resolveRenderedTask(app: App, checkbox: Element): Promise<RenderedTaskResult> {
	try {
		const located = locateRenderedTask(app, checkbox);
		if (!("located" in located)) return located;
		const { file, range, dataLine, renderedText } = located.located;

		let text: string;
		try {
			text = await app.vault.cachedRead(file);
		} catch {
			return { unmappable: "read-failed" };
		}
		const lines = text.split(/\r\n|\n/);
		if (range.from >= lines.length) return { unmappable: "stale-cache" };

		const match = matchRenderedTask(lines, renderedText, {
			from: range.from,
			to: range.to,
			sectionStart: range.sectionStart,
			dataLine,
		});
		if (!("line" in match)) return { unmappable: match.unmappable };

		const rawLine = lines[match.line];
		return { file, line: match.line, rawLine, status: getCheckboxStatusChar(rawLine) ?? "" };
	} catch {
		return { unmappable: "error" };
	}
}
