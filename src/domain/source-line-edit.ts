/**
 * Edit one task line of a note's text (pure, no `obsidian` import).
 *
 * This is what a press on a rendered checkbox does to its source line: set
 * the status char (`targetStatus`) and add or remove the close stamp
 * (`applyStampTransition`). Nothing else on the line changes, and every
 * other line of the note stays byte-identical, including each line's own
 * ending (`\n` or `\r\n`, mixed in one file if it was).
 *
 * Both write routes of `src/rendered/source-writer.ts` use `planLineEdit`
 * on the note's lines, so the line they decide on is the same; the closed
 * route also uses `editTextLine` to rewrite the file text.
 */
import { checkboxTokenRange, classifyLines, getCheckboxStatusChar, setCheckboxStatusChar } from "./line-classifier";
import { applyStampTransition } from "./stamps";
import { targetStatus, type PressKind } from "./status-sequence";

/** One line of a note: its text without the line ending, and its own line ending. */
export interface SplitLine {
	text: string;
	/** `"\n"`, `"\r\n"`, or `""` for the last line of a note that does not end in a newline. */
	eol: string;
}

/**
 * Split note text into lines, keeping each line's own ending. A note that
 * ends in a newline has a final empty line with no ending, as an editor
 * counts it. `joinLines(splitLines(t)) === t` for every `t`.
 */
export function splitLines(text: string): SplitLine[] {
	const parts = text.split(/(\r\n|\n)/);
	const lines: SplitLine[] = [];
	for (let i = 0; i < parts.length; i += 2) {
		lines.push({ text: parts[i], eol: parts[i + 1] ?? "" });
	}
	return lines;
}

/** The inverse of `splitLines`. */
export function joinLines(lines: readonly SplitLine[]): string {
	let out = "";
	for (const l of lines) out += l.text + l.eol;
	return out;
}

/** Why a press changed nothing. */
export type SkipReason =
	/** The line index is outside the note. */
	| "out-of-range"
	/** The line is not a task line (moved, edited, or no checkbox). */
	| "not-a-task"
	/** The line is inside a fenced code block or frontmatter. */
	| "excluded"
	/** The press leaves the status as it is (a long press on `[-]`). */
	| "no-change";

export interface LineEdit {
	/** 0-based line. */
	line: number;
	/** Column of the status char (one past the `[`). */
	ch: number;
	/** The status char before, as in the line (e.g. `"X"`). */
	from: string;
	/** The status char after. */
	to: string;
	/** The line before, without its line ending. */
	before: string;
	/** The line after (status char and stamp), without its line ending. */
	after: string;
}

export type LineEditResult = { edit: LineEdit } | { skipped: SkipReason };

export interface LineEditOptions {
	/** The "Close stamps" setting. When false only the status char changes. */
	stampsOn: boolean;
	/** The date for a new stamp; its local date is used. */
	today: Date | string;
}

/**
 * Decide the edit for the task on `line0` of a note's lines (no line endings).
 * Nothing is changed here; `{ skipped }` says why no edit applies.
 */
export function planLineEdit(
	lines: readonly string[],
	line0: number,
	kind: PressKind,
	options: LineEditOptions
): LineEditResult {
	if (!Number.isInteger(line0) || line0 < 0 || line0 >= lines.length) {
		return { skipped: "out-of-range" };
	}
	const before = lines[line0];
	const from = getCheckboxStatusChar(before);
	const range = checkboxTokenRange(before);
	if (from === null || range === null) return { skipped: "not-a-task" };
	if (classifyLines(lines)[line0].excluded) return { skipped: "excluded" };

	const to = targetStatus(from, kind);
	if (to === from) return { skipped: "no-change" };

	const after = applyStampTransition(setCheckboxStatusChar(before, to), from, to, options.today, {
		stampsOn: options.stampsOn,
	});
	return { edit: { line: line0, ch: range.fromCh + 1, from, to, before, after } };
}

/**
 * `planLineEdit` on note text, returning the whole new text. When nothing
 * applies, `text` is the input string, unchanged.
 */
export function editTextLine(
	text: string,
	line0: number,
	kind: PressKind,
	options: LineEditOptions
): { text: string; result: LineEditResult } {
	const lines = splitLines(text);
	const result = planLineEdit(
		lines.map((l) => l.text),
		line0,
		kind,
		options
	);
	if (!("edit" in result)) return { text, result };
	lines[line0] = { text: result.edit.after, eol: lines[line0].eol };
	return { text: joinLines(lines), result };
}
