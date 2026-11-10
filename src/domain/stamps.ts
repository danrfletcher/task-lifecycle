/**
 * Close stamps (pure).
 *
 * A stamp is the emoji (optionally followed by the emoji presentation selector
 * U+FE0F, as typed or pasted from some keyboards), one space and a YYYY-MM-DD
 * date, with a word boundary after the date. A bare emoji with no date is
 * never a stamp.
 */
import { CANCELLED_EMOJI, DONE_EMOJI } from "./constants";
import { toYyyyMmDd } from "./dates";
import { isTaskLine } from "./line-classifier";
import { statusKind } from "./status-sequence";

export type StampKind = "done" | "cancelled";

export interface Stamp {
	kind: StampKind;
	/** The YYYY-MM-DD part. */
	date: string;
	/** Index of the emoji in the line. */
	index: number;
	/** Length of the stamp text (emoji, optional U+FE0F, space, date). */
	length: number;
}

const EMOJI_FOR_KIND: Readonly<Record<StampKind, string>> = Object.freeze({
	done: DONE_EMOJI,
	cancelled: CANCELLED_EMOJI,
});

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Source of the stamp pattern. Built per call because the regex is global. */
function stampRegex(): RegExp {
	return new RegExp(
		`(${DONE_EMOJI}|${CANCELLED_EMOJI})\\uFE0F? (\\d{4}-\\d{2}-\\d{2})\\b`,
		"g"
	);
}

/** Every stamp on the line, left to right. */
export function findStamps(line: string): Stamp[] {
	const stamps: Stamp[] = [];
	const re = stampRegex();
	let m: RegExpExecArray | null;
	while ((m = re.exec(line)) !== null) {
		stamps.push({
			kind: m[1] === DONE_EMOJI ? "done" : "cancelled",
			date: m[2],
			index: m.index,
			length: m[0].length,
		});
	}
	return stamps;
}

/**
 * Remove every stamp, each together with all the spaces and tabs directly
 * before it, so removing a stamp never leaves trailing whitespace behind
 * ("a   ✅ 2026-11-01" becomes "a"). Text that follows a stamp keeps its own
 * leading whitespace ("a   ✅ 2026-11-01 ^id" becomes "a ^id"). Nothing else on
 * the line changes.
 */
export function removeStamps(line: string): string {
	const stamps = findStamps(line);
	let out = "";
	let pos = 0;
	for (const s of stamps) {
		let end = s.index;
		while (end > pos && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
		out += line.slice(pos, end);
		pos = s.index + s.length;
	}
	return out + line.slice(pos);
}

/**
 * Add a stamp at the end of the line, before a trailing " ^blockid" if there
 * is one. Whitespace directly before the new stamp becomes one space. A
 * trailing "\r" stays at the very end. Does not remove existing stamps.
 */
export function addStamp(line: string, kind: StampKind, date: string): string {
	if (!DATE_ONLY_RE.test(date)) {
		throw new Error(`Stamp date must be YYYY-MM-DD, got "${date}"`);
	}
	const stamp = `${EMOJI_FOR_KIND[kind]} ${date}`;

	const cr = line.endsWith("\r") ? "\r" : "";
	const body = cr ? line.slice(0, -1) : line;

	const block = /(\s+)(\^[A-Za-z0-9-]+\s*)$/.exec(body);
	if (block) {
		const head = body.slice(0, block.index).replace(/\s+$/, "");
		return `${head} ${stamp}${block[1]}${block[2]}${cr}`;
	}
	return `${body.replace(/\s+$/, "")} ${stamp}${cr}`;
}

/**
 * The stamp changes for a status transition on a task line whose status char
 * is already `to`. Returns the new line. Only stamps and the space before
 * them change; the checkbox char is never touched here.
 *
 * - Same status kind before and after (e.g. "x" -> "X", " " -> "?"): unchanged.
 * - To done or cancelled: every existing stamp is removed, then a stamp of the
 *   new kind dated `today` is added (so "x" -> "-" swaps the emoji).
 * - To open or in progress: every stamp is removed.
 * - Not a task line: unchanged.
 *
 * `today` is a YYYY-MM-DD string or a Date (local date is used).
 *
 * `options.stampsOn` (default true) is the "Close stamps" setting: when false
 * nothing is added or removed and the line is returned unchanged.
 */
export function applyStampTransition(
	line: string,
	from: string,
	to: string,
	today: string | Date,
	options: { stampsOn?: boolean } = {}
): string {
	if (options.stampsOn === false) return line;
	if (!isTaskLine(line)) return line;

	const fromKind = statusKind(from);
	const toKind = statusKind(to);
	if (fromKind === toKind) return line;

	const stripped = removeStamps(line);
	if (toKind === "done" || toKind === "cancelled") {
		const date = typeof today === "string" ? today : toYyyyMmDd(today);
		return addStamp(stripped, toKind, date);
	}
	return stripped;
}
