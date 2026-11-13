/**
 * Close cascade (pure, no `obsidian` import).
 *
 * The descendant walk and the subtask rewrite behind the "Close subtasks?"
 * dialog. Everything here works on an array of note lines and returns plain
 * values; the clock is an argument (`today`), never read from here.
 *
 * Subtask rule: a subtask is a task line inside the parent's block. The block
 * is the run of lines after the parent that are indented deeper than it. Blank
 * lines, deeper non-list text, fenced code and frontmatter are skipped; the
 * block ends at the first other line indented at or shallower than the parent.
 * Indent is measured in columns before the list marker: a space is 1, a tab is
 * 4 and each blockquote ">" is 1, so `> - [ ]` and `>   - [ ]` compare like
 * `- [ ]` and `  - [ ]`. A line with more blockquote markers than the parent
 * opens a nested quote, which belongs to the parent's item only if it is
 * indented deeper than the parent's marker: `- [x] p` then `> - [ ] q` (the
 * quote starts at the margin and ends the list) is not a subtask, while
 * `- [x] p` then `  > - [ ] q` is.
 *
 * Open-status rule: a task is closed only if its status char is "x", "X" or
 * "-". Every other char is open, whatever stamps are on the line.
 */
import { classifyLines, getCheckboxStatusChar, setCheckboxStatusChar } from "./line-classifier";
import { applyStampTransition } from "./stamps";
import { isClosed } from "./status-sequence";

/** One rewritten line. `line` is 0-based. */
export interface CascadeEdit {
	line: number;
	before: string;
	after: string;
}

export interface CascadeOptions {
	/** The "Close stamps" setting: false means status char only, no emoji. */
	stampsOn: boolean;
	/** "Today" for new stamps: a YYYY-MM-DD string or a local Date. */
	today: string | Date;
}

/** Leading run of whitespace and blockquote markers. */
const PREFIX_RE = /^[ \t>]*/;

/** Indent columns and blockquote depth of a line (see the file comment). */
function measure(line: string): { columns: number; depth: number } {
	const prefix = PREFIX_RE.exec(line)?.[0] ?? "";
	let columns = 0;
	let depth = 0;
	for (const ch of prefix) {
		if (ch === "\t") columns += 4;
		else {
			columns += 1;
			if (ch === ">") depth += 1;
		}
	}
	return { columns, depth };
}

/**
 * Columns of whitespace right after the `n`-th blockquote marker (after the
 * line start for n = 0), up to the next marker or text. This is the indent of
 * whatever sits at quote level `n`.
 */
function indentAtQuoteLevel(line: string, n: number): number {
	const prefix = PREFIX_RE.exec(line)?.[0] ?? "";
	let seen = 0;
	let columns = 0;
	for (const ch of prefix) {
		if (ch === ">") {
			if (seen > n) break;
			seen += 1;
			continue;
		}
		if (seen === n) columns += ch === "\t" ? 4 : 1;
	}
	return columns;
}

const BLANK_RE = /^[ \t>\r]*$/;

/**
 * Indices of the list lines (tasks and plain bullets, at any depth) in the
 * block under `parentLine0`, in order. Empty if the parent is not a list item
 * or sits inside fenced code or frontmatter.
 */
export function collectDescendantIndices(
	lines: readonly string[],
	parentLine0: number
): number[] {
	const out: number[] = [];
	if (parentLine0 < 0 || parentLine0 >= lines.length) return out;
	const info = classifyLines(lines);
	const parentInfo = info[parentLine0];
	if (parentInfo.excluded || parentInfo.kind === "other") return out;

	const parent = measure(lines[parentLine0]);
	for (let i = parentLine0 + 1; i < lines.length; i++) {
		if (info[i].excluded) continue;
		const line = lines[i];
		if (BLANK_RE.test(line)) continue;
		const here = measure(line);
		if (here.depth < parent.depth || here.columns <= parent.columns) break;
		// A deeper quote must itself be indented past the parent's marker.
		if (
			here.depth > parent.depth &&
			indentAtQuoteLevel(line, parent.depth) <= indentAtQuoteLevel(lines[parentLine0], parent.depth)
		) {
			break;
		}
		if (info[i].kind !== "other") out.push(i);
	}
	return out;
}

/** Indices of the open task lines in the block under `parentLine0`. */
function openSubtaskIndices(lines: readonly string[], parentLine0: number): number[] {
	return collectDescendantIndices(lines, parentLine0).filter((i) => {
		const status = getCheckboxStatusChar(lines[i]);
		return status !== null && !isClosed(status);
	});
}

/** How many open subtasks the task on `parentLine0` has. */
export function countOpenSubtasks(lines: readonly string[], parentLine0: number): number {
	return openSubtaskIndices(lines, parentLine0).length;
}

/**
 * The status char the subtasks get: the parent's, lowercased. Null if the
 * line is not a task line or is not closed ("x", "X" or "-").
 */
export function cascadeStatus(parentLine: string): string | null {
	const status = getCheckboxStatusChar(parentLine);
	if (status === null || !isClosed(status)) return null;
	return status.toLowerCase();
}

/**
 * The new text of one open subtask: the checkbox char becomes `status` and,
 * if stamps are on, every existing stamp is replaced by one of the matching
 * kind dated `today`, placed before a trailing " ^blockid". With stamps off
 * only the checkbox char changes. A bare emoji (no date) is never touched.
 */
export function rewriteSubtask(line: string, status: string, options: CascadeOptions): string {
	const from = getCheckboxStatusChar(line);
	if (from === null) return line;
	const updated = setCheckboxStatusChar(line, status);
	return applyStampTransition(updated, from, status, options.today, {
		stampsOn: options.stampsOn,
	});
}

/**
 * The edits that close every open subtask of the task on `parentLine0` with
 * the parent's status. Nothing changes (empty result) if the parent line is
 * not a closed task. Closed tasks, plain bullets, fenced lines and lines
 * after the block are never edited. Line text is rewritten as given, so a
 * trailing "\r" on a CRLF-terminated line stays.
 */
export function computeCascadeEdits(
	lines: readonly string[],
	parentLine0: number,
	options: CascadeOptions
): CascadeEdit[] {
	if (parentLine0 < 0 || parentLine0 >= lines.length) return [];
	const status = cascadeStatus(lines[parentLine0]);
	if (status === null) return [];

	const edits: CascadeEdit[] = [];
	for (const i of openSubtaskIndices(lines, parentLine0)) {
		const after = rewriteSubtask(lines[i], status, options);
		if (after !== lines[i]) edits.push({ line: i, before: lines[i], after });
	}
	return edits;
}

/**
 * The smallest single replacement that turns `before` into `after`, as
 * character offsets in `before`. Null if they are equal. A shared trailing
 * "\r" is never part of the span.
 */
export function lineSpan(
	before: string,
	after: string
): { fromCh: number; toCh: number; text: string } | null {
	if (before === after) return null;
	let start = 0;
	const max = Math.min(before.length, after.length);
	while (start < max && before[start] === after[start]) start++;
	let endBefore = before.length;
	let endAfter = after.length;
	while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}
	return { fromCh: start, toCh: endBefore, text: after.slice(start, endAfter) };
}
