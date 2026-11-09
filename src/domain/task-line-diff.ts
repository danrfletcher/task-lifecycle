/**
 * Task line diff (pure).
 *
 * Finds the task lines whose status char really changed between two versions
 * of a note, comparing lines by CONTENT and not by position. A line that only
 * moved, or that got new neighbours (Enter, delete, paste, Alt+Up/Down), is
 * not a change. A task line that has no counterpart on the other side (a
 * pasted block, a newly typed line) is an insertion, not a change.
 *
 * Content key of a task line: the line with its status char masked and every
 * stamp removed, without trailing whitespace. Two lines with the same key are
 * "the same task" whatever their status or stamps.
 *
 * Line numbers are 0-based. Input lines carry no line break.
 */
import { classifyLines, getCheckboxStatusChar, setCheckboxStatusChar } from "./line-classifier";
import { removeStamps } from "./stamps";

/**
 * One changed region: inclusive 0-based line ranges on the old and the new
 * side. Each side always holds at least one line (a pure insertion touches
 * the line it lands in; a pure deletion touches the line it joins).
 */
export interface LineHunk {
	oldFrom: number;
	oldTo: number;
	newFrom: number;
	newTo: number;
}

export interface TaskStatusChange {
	/** 0-based line number in the NEW note. */
	line: number;
	/** The line's text in the new note (status char already changed). */
	lineText: string;
	/** Status char before. */
	from: string;
	/** Status char after. */
	to: string;
}

interface Candidate {
	line: number;
	key: string;
	char: string;
}

/** The line with its status char masked and stamps removed (see file comment). */
export function contentKey(taskLine: string): string {
	return removeStamps(setCheckboxStatusChar(taskLine, " ")).replace(/\s+$/, "");
}

/** Overlapping hunks (on either side) become one hunk. Sorted by new line. */
export function mergeHunks(hunks: readonly LineHunk[]): LineHunk[] {
	const sorted = [...hunks].sort((a, b) => a.newFrom - b.newFrom || a.oldFrom - b.oldFrom);
	const out: LineHunk[] = [];
	for (const h of sorted) {
		const last = out[out.length - 1];
		if (last && (h.newFrom <= last.newTo || h.oldFrom <= last.oldTo)) {
			last.newTo = Math.max(last.newTo, h.newTo);
			last.oldTo = Math.max(last.oldTo, h.oldTo);
		} else {
			out.push({ ...h });
		}
	}
	return out;
}

function candidates(
	lines: readonly string[],
	from: number,
	to: number,
	usable: (i: number) => boolean
): Candidate[] {
	const out: Candidate[] = [];
	const end = Math.min(to, lines.length - 1);
	for (let i = Math.max(from, 0); i <= end; i++) {
		const char = getCheckboxStatusChar(lines[i]);
		if (char === null || !usable(i)) continue;
		out.push({ line: i, key: contentKey(lines[i]), char });
	}
	return out;
}

/**
 * Pair old and new candidates of one hunk. First every identical line (same
 * key, same char) pairs with its twin, so unchanged neighbours never absorb a
 * change; then what is left pairs by key in order. Returns the pairs whose
 * status char differs, as [old, new].
 */
function pairChanges(olds: Candidate[], news: Candidate[]): Array<[Candidate, Candidate]> {
	const usedOld = new Set<Candidate>();
	const usedNew = new Set<Candidate>();

	for (const n of news) {
		const o = olds.find((c) => !usedOld.has(c) && c.key === n.key && c.char === n.char);
		if (o) {
			usedOld.add(o);
			usedNew.add(n);
		}
	}

	const changed: Array<[Candidate, Candidate]> = [];
	for (const n of news) {
		if (usedNew.has(n)) continue;
		const o = olds.find((c) => !usedOld.has(c) && c.key === n.key);
		if (!o) continue;
		usedOld.add(o);
		usedNew.add(n);
		changed.push([o, n]);
	}
	return changed;
}

function collect(
	hunks: readonly LineHunk[],
	oldLines: readonly string[],
	newLines: readonly string[],
	oldUsable: (i: number) => boolean,
	newUsable: (i: number) => boolean
): Array<[Candidate, Candidate]> {
	const out: Array<[Candidate, Candidate]> = [];
	for (const h of hunks) {
		const olds = candidates(oldLines, h.oldFrom, h.oldTo, oldUsable);
		const news = candidates(newLines, h.newFrom, h.newTo, newUsable);
		if (olds.length === 0 || news.length === 0) continue;
		out.push(...pairChanges(olds, news));
	}
	return out;
}

/**
 * The task lines whose status char changed, top to bottom (ascending new line).
 *
 * `oldLines` / `newLines` are the whole note before and after; `hunks` say
 * where it changed. Only lines inside a hunk are looked at. Task lines inside
 * fenced code or frontmatter (on either side) never count.
 */
export function diffTaskLines(
	oldLines: readonly string[],
	newLines: readonly string[],
	hunks: readonly LineHunk[]
): TaskStatusChange[] {
	const merged = mergeHunks(hunks);

	// Cheap pass without the fence/frontmatter classifier: most edits change
	// no status char, and then the whole-note classification is skipped.
	const quick = collect(merged, oldLines, newLines, () => true, () => true);
	if (quick.length === 0) return [];

	const oldInfo = classifyLines(oldLines);
	const newInfo = classifyLines(newLines);
	const usableOld = (i: number) => oldInfo[i]?.kind === "task" && !oldInfo[i].excluded;
	const usableNew = (i: number) => newInfo[i]?.kind === "task" && !newInfo[i].excluded;

	return collect(merged, oldLines, newLines, usableOld, usableNew)
		.map(([o, n]) => ({
			line: n.line,
			lineText: newLines[n.line],
			from: o.char,
			to: n.char,
		}))
		.sort((a, b) => a.line - b.line);
}
