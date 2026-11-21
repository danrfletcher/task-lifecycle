/**
 * Rendered-task matcher (pure, no `obsidian` import, no DOM).
 *
 * A rendered checkbox gives two facts about its source line: the text Obsidian
 * drew next to it and, for a block embed, its `data-line` offset inside the
 * block. This module turns those into exactly one source line or into a
 * verdict that it cannot be placed. It never picks a "nearest" line.
 *
 * The content check compares the rendered text with a source line after
 * both lose what Obsidian does not draw or what a later write changes:
 *  - the trailing `^blockid`;
 *  - stamps (an emoji followed by a date; a bare emoji is text and stays);
 *  - inline fields such as `[due:: 2026-11-30]` (Obsidian draws them raw, a
 *    query plugin may draw them differently, so neither side keeps them);
 *  - for the source only, markdown syntax: wikilinks and aliases, markdown
 *    links, images, bold, italics, strikethrough, highlight, inline code,
 *    HTML tags, backslash escapes, footnote references and inline math.
 *    Footnote numbers and typeset math cannot be rebuilt from the line, so
 *    the rendered side leaves them out too (see `renderedTextOf`).
 * Whitespace runs collapse to one space and the ends are trimmed.
 */
import { checkboxTokenRange, classifyLines } from "./line-classifier";
import { removeStamps } from "./stamps";

/** Why a rendered task could not be placed on exactly one line. */
export type MatchFailure =
	/** No task line in the search range has the rendered text. */
	| "no-candidate"
	/** More than one task line has it and nothing else picks one. */
	| "ambiguous"
	/** `data-line` plus the section start names a line that is not that task. */
	| "position-mismatch";

export type MatchResult = { line: number } | { unmappable: MatchFailure };

export interface MatchOptions {
	/** First source line (0-based, inclusive) that may hold the task. */
	from: number;
	/** Last source line (0-based, inclusive). May be past the end of the note. */
	to: number;
	/**
	 * Source line the rendered section starts on, when the section is known
	 * exactly (a block embed). With `dataLine` it names the one candidate.
	 */
	sectionStart?: number | null;
	/** `data-line` of the checkbox: 0-based, relative to the section. */
	dataLine?: number | null;
}

const BLOCK_ID_RE = /(?:^|\s)\^[A-Za-z0-9-]+\s*$/;
const INLINE_FIELD_RE = /[[(][A-Za-z][\w -]*::[^\])]*[\])]/g;

/** The part of a task line after its "[c]" token. Whole line if it has no token. */
function textAfterCheckbox(line: string): string {
	const range = checkboxTokenRange(line);
	return range ? line.slice(range.toCh) : line;
}

function stripBlockId(text: string): string {
	return text.replace(BLOCK_ID_RE, "");
}

function collapse(text: string): string {
	return text
		.normalize("NFC")
		.replace(/[\s\u00a0]+/g, " ")
		.trim();
}

/** What both sides lose: block id, stamps, inline fields, extra whitespace. */
function stripCommon(text: string): string {
	return collapse(stripBlockId(removeStamps(text).replace(INLINE_FIELD_RE, "")));
}

/** `[[target#Heading|alias]]` is drawn as the alias, or as "target > Heading". */
function wikilinkText(target: string, alias: string | undefined): string {
	if (alias !== undefined) return alias;
	return target.replace(/^#/, "").replace(/#/g, " > ");
}

/** Brackets for a placeholder: private-use characters no markdown rule reads. */
const HOLD_OPEN = "\uE000";
const HOLD_CLOSE = "\uE001";
const HOLD_RE = /\uE000(\d+)\uE001/g;
/** One left-to-right pass, so an escaped backtick never opens a code span. */
const LITERAL_RE = /\\([\\`*_{}[\]()#+\-.!|~=<>^$])|`([^`]*)`/g;
/**
 * Math Obsidian draws as typeset output: `$$...$$`, or `$...$` whose opening
 * `$` is followed by a non-space, whose closing `$` follows a non-space and is
 * not followed by a digit (so "costs $5 and $6" is not math).
 */
const MATH_RE = /\$\$[^$]+\$\$|\$(?=[^\s$])(?:[^$\n]*?[^\s$])\$(?!\d)/g;
/** `[^id]` and the inline form `^[text]`: Obsidian draws both as a superscript number. */
const FOOTNOTE_RE = /\[\^[^\]\s]+\]|\^\[[^\]]*\]/g;

/**
 * Markdown syntax removed from a source line, in the order Obsidian reads it.
 *
 * Text Obsidian draws literally is held back first and put back last: the
 * body of a code span (`**x**` is drawn as the four characters) and an
 * escaped character (`\*a\*` is drawn `*a*`). Without that the emphasis
 * rules would read their `*` and `_` as syntax.
 */
function stripMarkdown(text: string): string {
	const held: string[] = [];
	const hold = (literal: string): string => `${HOLD_OPEN}${held.push(literal) - 1}${HOLD_CLOSE}`;
	const open = text
		.replace(/[\uE000\uE001]/g, "")
		.replace(LITERAL_RE, (_m, escaped: string | undefined, code: string | undefined) =>
			hold(escaped ?? code ?? "")
		);
	return stripSyntax(open).replace(HOLD_RE, (_m, i: string) => held[Number(i)]);
}

/** The syntax rules, run on text whose literal parts are already held back. */
function stripSyntax(text: string): string {
	return text
		.replace(MATH_RE, "")
		.replace(FOOTNOTE_RE, "")
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, t: string, a: string | undefined) =>
			wikilinkText(t, a)
		)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<\/?[A-Za-z][^>]*>/g, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/==(.+?)==/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1$2");
}

/**
 * The comparable text of a task line: what is left after the checkbox and
 * everything the rendered side does not show.
 */
export function normalizeSourceTaskText(line: string): string {
	// Stamps, then fields, then the id (a stamp may sit after the id), all
	// before markdown so a `[key:: v]` is never read as a link.
	const plain = stripBlockId(removeStamps(textAfterCheckbox(line)).replace(INLINE_FIELD_RE, ""));
	return collapse(stripMarkdown(plain));
}

/** The comparable text of what Obsidian drew next to the checkbox. */
export function normalizeRenderedText(text: string): string {
	return stripCommon(text);
}

/**
 * Every task line in `from..to` (inclusive, clamped to the note) outside
 * code and frontmatter whose comparable text equals `renderedText`'s.
 */
export function findCandidateLines(
	lines: readonly string[],
	renderedText: string,
	range: { from: number; to: number }
): number[] {
	const key = normalizeRenderedText(renderedText);
	const info = classifyLines(lines);
	return candidatesIn(lines, info, key, range.from, range.to);
}

function candidatesIn(
	lines: readonly string[],
	info: ReturnType<typeof classifyLines>,
	key: string,
	from: number,
	to: number
): number[] {
	const out: number[] = [];
	for (let i = Math.max(0, from); i <= Math.min(to, lines.length - 1); i++) {
		if (info[i].kind === "task" && !info[i].excluded && normalizeSourceTaskText(lines[i]) === key) {
			out.push(i);
		}
	}
	return out;
}

/**
 * Place a rendered task on exactly one source line.
 *
 * With `sectionStart` and `dataLine` (a block embed), the line is
 * `sectionStart + dataLine`. It is returned when it is a task line inside
 * the range with the rendered text, and is `position-mismatch` otherwise: a
 * line that moved or a stale cache is never papered over by a nearby match.
 * Without them, every task line in the range with the rendered text is a
 * candidate: one is the answer, none is `no-candidate`, several is
 * `ambiguous`.
 *
 * Lines inside fenced code and frontmatter are never candidates.
 */
export function matchRenderedTask(
	lines: readonly string[],
	renderedText: string,
	options: MatchOptions
): MatchResult {
	const key = normalizeRenderedText(renderedText);
	const info = classifyLines(lines);
	const { sectionStart, dataLine } = options;
	if (
		sectionStart !== undefined &&
		sectionStart !== null &&
		dataLine !== undefined &&
		dataLine !== null
	) {
		const at = sectionStart + dataLine;
		const hit =
			at >= options.from && candidatesIn(lines, info, key, at, Math.min(at, options.to)).length === 1;
		return hit ? { line: at } : { unmappable: "position-mismatch" };
	}

	const found = candidatesIn(lines, info, key, options.from, options.to);
	if (found.length === 1) return { line: found[0] };
	return { unmappable: found.length === 0 ? "no-candidate" : "ambiguous" };
}
