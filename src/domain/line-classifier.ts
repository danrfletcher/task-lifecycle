/**
 * Line classifier (pure, no `obsidian` import).
 *
 * One task-line regex is shared by every read and write in this module.
 *
 * Task line: optional indent, zero or more ">" blockquote/callout prefixes,
 * a list marker ("-", "*", "+", "1." or "1)"), whitespace, "[c]" with
 * exactly one char, then whitespace or the end of the line.
 */

/** Optional indent plus any number of ">" blockquote/callout prefixes. */
const PREFIX = "[ \\t]*(?:>[ \\t]*)*";
const MARKER = "(?:[-*+]|\\d+[.)])";

/**
 * Group 1 is everything up to and including "["; group 2 is the one status
 * char. The "u" flag makes a status char one code point, not one UTF-16 unit.
 */
const TASK_LINE_RE = new RegExp(
	`^(${PREFIX}${MARKER}[ \\t]+\\[)([^\\]\\r\\n])\\](?=\\s|$)`,
	"u"
);

const LIST_LINE_RE = new RegExp(`^${PREFIX}${MARKER}[ \\t]+`);

/**
 * Opening or closing fence: a run of 3+ backticks or tildes. A trailing CR
 * (CRLF note) is allowed and kept out of the info string, as in the other
 * line regexes in this module.
 */
const FENCE_RE = new RegExp(`^${PREFIX}(\`{3,}|~{3,})(.*?)\\r?$`);

const FRONTMATTER_DELIMITER_RE = /^---\s*$/;

export type LineKind = "task" | "list" | "other";

export interface LineInfo {
	kind: LineKind;
	/** True inside fenced code (fence lines included) and frontmatter. */
	excluded: boolean;
}

/** True if the line is a task line (any single status char). */
export function isTaskLine(line: string): boolean {
	return TASK_LINE_RE.test(line);
}

/** True if the line is a bulleted or ordered list item, task or not. */
export function isListLine(line: string): boolean {
	return LIST_LINE_RE.test(line);
}

/**
 * The status char of a task line, or null if the line is not a task line.
 */
export function getCheckboxStatusChar(line: string): string | null {
	const m = TASK_LINE_RE.exec(line);
	return m ? m[2] : null;
}

/**
 * Replace the status char of a task line with `statusChar`.
 * Changes nothing else. Returns the line unchanged if it is not a task line
 * or if `statusChar` is not exactly one char that can sit inside "[ ]".
 */
export function setCheckboxStatusChar(
	line: string,
	statusChar: string
): string {
	if (!/^[^\]\r\n]$/u.test(statusChar)) return line;
	const m = TASK_LINE_RE.exec(line);
	if (!m) return line;
	const start = m[1].length;
	return line.slice(0, start) + statusChar + line.slice(start + m[2].length);
}

/**
 * Leading whitespace columns of a line. A space is 1 column, a tab is 4.
 */
export function indentWidth(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " ") width += 1;
		else if (ch === "\t") width += 4;
		else break;
	}
	return width;
}

function classifyOne(line: string): LineKind {
	if (isTaskLine(line)) return "task";
	if (isListLine(line)) return "list";
	return "other";
}

/**
 * Classify every line of a note.
 *
 * Lines inside a fenced code block (``` or ~~~; the closing fence must use
 * the same char and be at least as long as the opener) and inside a leading
 * "---" frontmatter block are `excluded` and never `task` or `list`. An
 * unclosed fence excludes everything to the end of the note. A leading "---"
 * with no closing "---" is not frontmatter.
 */
export function classifyLines(lines: readonly string[]): LineInfo[] {
	const out: LineInfo[] = [];
	let i = 0;

	if (lines.length > 0 && FRONTMATTER_DELIMITER_RE.test(lines[0])) {
		let close = -1;
		for (let j = 1; j < lines.length; j++) {
			if (FRONTMATTER_DELIMITER_RE.test(lines[j])) {
				close = j;
				break;
			}
		}
		if (close >= 0) {
			for (; i <= close; i++) out.push({ kind: "other", excluded: true });
		}
	}

	let fenceChar = "";
	let fenceLen = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const fence = FENCE_RE.exec(line);

		if (fenceChar === "") {
			// A backtick opener cannot carry backticks in its info string
			// (that would be inline code such as ```x```).
			if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
				fenceChar = fence[1][0];
				fenceLen = fence[1].length;
				out.push({ kind: "other", excluded: true });
			} else {
				out.push({ kind: classifyOne(line), excluded: false });
			}
			continue;
		}

		out.push({ kind: "other", excluded: true });
		if (
			fence &&
			fence[1][0] === fenceChar &&
			fence[1].length >= fenceLen &&
			fence[2].trim() === ""
		) {
			fenceChar = "";
			fenceLen = 0;
		}
	}
	return out;
}
