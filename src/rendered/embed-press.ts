/**
 * What a press on a task checkbox inside an embed does to its source note.
 *
 * This module decides and writes; it listens to nothing and never touches an
 * event (the click wiring is `status-cycle/wire-embed-press.ts`). Two steps,
 * matching the two moments of a click:
 *
 *  1. `begin(checkbox)` is synchronous and runs inside the capture-phase
 *     click. From the rendered DOM and `metadataCache` alone it says whether
 *     this plugin handles the checkbox (so the native toggle must be
 *     suppressed) or leaves it to Obsidian (canvas, hover preview, a
 *     non-markdown or unresolved embed, ...).
 *  2. `run(kind)` is the awaited write. The line is chosen at write time,
 *     inside the source writer's per-file queue and against the note's text
 *     as it is by then (the open editor's own lines, or what the vault's
 *     atomic process call hands over), so a second press 0 ms after the
 *     first reads what the first wrote, and a line that moved is found
 *     again by content.
 *
 * Outcomes that write nothing and say so with a notice:
 *  - unmappable (G10): no line, several lines, a line that is no longer a
 *    task, a deleted or renamed source, a write that failed;
 *  - stale (G9): the rendered status differs from the note's current char.
 *    The pressed checkbox is redrawn from the note and the next press
 *    advances from there.
 */
import type { App, TFile } from "obsidian";

import { getCheckboxStatusChar } from "../domain/line-classifier";
import { matchRenderedTask } from "../domain/rendered-match";
import {
	locateRenderedTask,
	renderedTextOf,
	type RenderedTaskLocation,
} from "./resolve-rendered-task";
import type { LineResolution, LineResolver, PressKind, PressResult, SourceWriter } from "./source-writer";

export const UNMAPPABLE_NOTICE =
	"Task Lifecycle: couldn't find this task's source line, nothing changed";
export const STALE_NOTICE =
	"Task Lifecycle: this task changed since the embed was drawn, nothing changed. Press again to advance it";

export type EmbedPressOutcome =
	| { status: "written"; route: "editor" | "vault"; from: string; to: string }
	| { status: "unmappable" }
	| { status: "stale"; fileStatus: string }
	/**
	 * Nothing to do: the press leaves the status as it is, the plugin was
	 * unloaded, or the "Close subtasks?" dialog is open (a press is ignored).
	 */
	| { status: "skipped"; reason: "no-change" | "disposed" | "dialog-open" };

/** A close this module wrote to a closed source note, for the close cascade. */
export interface RenderedClose {
	file: TFile;
	/** 0-based line of the task in the source note. */
	line: number;
	/** The task line as written (status char and stamp). */
	lineText: string;
	from: string;
	to: string;
}

export type EmbedPressBegin =
	| { handled: false }
	| { handled: true; run(kind: PressKind): Promise<EmbedPressOutcome> };

export interface EmbedPresser {
	/** Synchronous. Never throws, never writes. */
	begin(checkbox: Element): EmbedPressBegin;
	/** After this, `run` does nothing and shows nothing. */
	dispose(): void;
}

export interface EmbedPresserDeps {
	app: Pick<App, "vault" | "workspace" | "metadataCache">;
	writer: Pick<SourceWriter, "press">;
	/** Show a message to the user. */
	notify: (message: string) => void;
	/**
	 * Called after a press wrote to a note that is not open in any editor. An
	 * open note is written through its editor, and the change detector reports
	 * that close itself, so it is never reported here: the cascade would
	 * otherwise see it twice. The caller decides whether the change is a close.
	 */
	onClosedNoteWrite?: (write: RenderedClose) => void;
	/** True while the "Close subtasks?" dialog is open: a press then writes nothing. Read per press. */
	isDialogOpen?: () => boolean;
}

/** `data-task` as the status char: Obsidian leaves it empty for an open task. */
function normaliseStatus(raw: string): string {
	return raw === "" ? " " : raw;
}

/** The status the rendered list item says it has, or null if it does not say. */
function renderedStatusOf(checkbox: Element): string | null {
	const raw = checkbox.closest("li")?.getAttribute("data-task");
	return raw === null || raw === undefined ? null : normaliseStatus(raw);
}

/**
 * Pick the line of a rendered task in the note's lines as they are now.
 * First where the embed says it is (position for a block embed, content
 * within the embed's range otherwise). If that finds nothing, the note has
 * changed since the cache was built, so the task is looked up by content in
 * the whole note; one match is the answer, none or several is unmappable.
 * Two matches inside the embed's own range are never widened: that is the
 * duplicate-lines case (G10).
 */
function placeTask(
	lines: readonly string[],
	loc: RenderedTaskLocation
): { line: number } | null {
	const { range, dataLine, renderedText } = loc;
	const inRange = matchRenderedTask(lines, renderedText, {
		from: range.from,
		to: range.to,
		sectionStart: range.sectionStart,
		dataLine,
	});
	if ("line" in inRange) return { line: inRange.line };
	if (inRange.unmappable === "ambiguous") return null;
	const wholeNote = matchRenderedTask(lines, renderedText, { from: 0, to: lines.length - 1 });
	return "line" in wholeNote ? { line: wholeNote.line } : null;
}

/**
 * The resolver the source writer runs at write time. `renderedStatus` null
 * skips the stale check. `alsoCurrent` is a second file char that is not
 * stale: the one this plugin's own last write left, when the embed has not
 * caught up with it.
 */
export function makeLineResolver(
	loc: RenderedTaskLocation,
	renderedStatus: string | null,
	alsoCurrent: string | null = null
): LineResolver {
	return (lines): LineResolution => {
		const placed = placeTask(lines, loc);
		if (!placed) return { skip: "unmappable" };
		const fileStatus = getCheckboxStatusChar(lines[placed.line]);
		if (fileStatus === null) return { skip: "unmappable" };
		if (renderedStatus !== null && renderedStatus !== fileStatus && alsoCurrent !== fileStatus) {
			return { skip: "stale", fileStatus };
		}
		return { line: placed.line };
	};
}

/** Draw `status` on a rendered task: `data-task`, the box and `is-checked`. */
export function syncRenderedStatus(checkbox: Element, status: string): void {
	const li = checkbox.closest("li");
	li?.setAttribute("data-task", status);
	li?.classList.toggle("is-checked", status !== " ");
	(checkbox as HTMLInputElement).checked = status !== " ";
}

/** Other embeds on the page that show this same task (same `src`, `data-line` and text). */
function twinsOf(checkbox: Element): Element[] {
	const embed = checkbox.closest(".internal-embed, .markdown-embed");
	const src = embed?.getAttribute("src");
	const line = checkbox.getAttribute("data-line");
	if (!embed || !src || line === null) return [];
	const text = renderedTextOf(checkbox);
	const out: Element[] = [];
	for (const other of Array.from(checkbox.ownerDocument.querySelectorAll(".internal-embed, .markdown-embed"))) {
		if (other === embed || other.getAttribute("src") !== src) continue;
		for (const box of Array.from(other.querySelectorAll("input.task-list-item-checkbox"))) {
			if (box.getAttribute("data-line") === line && renderedTextOf(box) === text) out.push(box);
		}
	}
	return out;
}

export function createEmbedPresser(deps: EmbedPresserDeps): EmbedPresser {
	let disposed = false;
	/** Presses per source path that have started and not finished. */
	const pending = new Map<string, number>();
	/** The last status change this plugin wrote per task (path + rendered text). */
	const lastWrite = new Map<string, { from: string; to: string }>();

	const drawEverywhere = (checkbox: Element, status: string): void => {
		syncRenderedStatus(checkbox, status);
		for (const twin of twinsOf(checkbox)) syncRenderedStatus(twin, status);
	};

	const finish = (checkbox: Element, result: PressResult): EmbedPressOutcome => {
		if (result.status === "written") {
			drawEverywhere(checkbox, result.to);
			return { status: "written", route: result.route, from: result.from, to: result.to };
		}
		switch (result.reason) {
			case "disposed":
				return { status: "skipped", reason: "disposed" };
			case "no-change":
				return { status: "skipped", reason: "no-change" };
			case "stale": {
				const fileStatus = result.fileStatus ?? " ";
				deps.notify(STALE_NOTICE);
				drawEverywhere(checkbox, fileStatus);
				return { status: "stale", fileStatus };
			}
			default:
				// unmappable, a line that is no longer a task, out of range, excluded.
				deps.notify(UNMAPPABLE_NOTICE);
				return { status: "unmappable" };
		}
	};

	const unmappable = (): EmbedPressOutcome => {
		if (!disposed) deps.notify(UNMAPPABLE_NOTICE);
		return disposed ? { status: "skipped", reason: "disposed" } : { status: "unmappable" };
	};

	const runLocated = async (
		checkbox: Element,
		file: TFile,
		path: string,
		loc: RenderedTaskLocation,
		kind: PressKind
	): Promise<EmbedPressOutcome> => {
		const key = path;
		// The dialog holds the cascade for one task: a press meanwhile is
		// swallowed by the caller (the native toggle never runs) and does nothing.
		if (deps.isDialogOpen?.()) return { status: "skipped", reason: "dialog-open" };
		// A press that follows one still in flight is not compared with the
		// drawn status: the embed has not caught up with our own earlier write.
		const queued = (pending.get(key) ?? 0) > 0;
		const drawn = renderedStatusOf(checkbox);
		// A press after one that has already landed, on an embed Obsidian has
		// not redrawn yet (or redrew from the old text): the embed is behind
		// only by this plugin's own last write, so it counts as showing what
		// that write left. Any other difference is still a stale embed (G9).
		// The file may equally still agree with the drawn status (the task was
		// put back to what the embed shows): then it is not stale either.
		const taskKey = `${path}\n${loc.renderedText}`;
		const mine = lastWrite.get(taskKey);
		const forgiven = mine && drawn === mine.from ? mine.to : null;
		// The record is good for this one press: whatever the file says, the
		// next press compares with what the embed then shows.
		lastWrite.delete(taskKey);
		const place = makeLineResolver(loc, queued ? null : drawn, forgiven);
		// Runs when the write happens, which may be after an unload: then it writes nothing.
		// Obsidian renames by changing the same TFile's `path`, so a held TFile is
		// not proof it is still the note that was clicked: it must still be at the
		// clicked path, and the vault must still map that path to it.
		const resolve: LineResolver = (lines) => {
			if (disposed) return { skip: "disposed" };
			if (file.path !== path || deps.app.vault.getAbstractFileByPath(path) !== file) {
				return { skip: "unmappable" };
			}
			return place(lines);
		};
		pending.set(key, (pending.get(key) ?? 0) + 1);
		try {
			const result = await deps.writer.press(file, 0, kind, resolve);
			if (disposed) return { status: "skipped", reason: "disposed" };
			if (result.status === "written") {
				lastWrite.set(taskKey, { from: result.from, to: result.to });
				if (result.route === "vault") {
					deps.onClosedNoteWrite?.({
						file: loc.file,
						line: result.line,
						lineText: result.lineText,
						from: result.from,
						to: result.to,
					});
				}
			}
			return finish(checkbox, result);
		} catch {
			// The source was deleted or renamed, or the write failed: nothing was written.
			return unmappable();
		} finally {
			const left = (pending.get(key) ?? 1) - 1;
			if (left <= 0) pending.delete(key);
			else pending.set(key, left);
		}
	};

	return {
		begin(checkbox) {
			if (disposed) return { handled: false };
			const located = locateRenderedTask(deps.app as App, checkbox);
			if ("notIntercepted" in located) return { handled: false };
			if ("unmappable" in located) {
				return { handled: true, run: () => Promise.resolve(unmappable()) };
			}
			const loc = located.located;
			// The path at click time; the write checks the note is still there.
			const path = loc.file.path;
			return {
				handled: true,
				run: (kind) => runLocated(checkbox, loc.file, path, loc, kind),
			};
		},
		dispose() {
			disposed = true;
			pending.clear();
			lastWrite.clear();
		},
	};
}
