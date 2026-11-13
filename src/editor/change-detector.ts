/**
 * The change detector and the close-stamp writer (CodeMirror 6).
 *
 * One `EditorState.transactionFilter`, registered with
 * `Plugin.registerEditorExtension`, sees every transaction of every markdown
 * editor (Live Preview and Source mode). For a transaction that changes the
 * document it:
 *
 *  1. diffs the task lines in the changed ranges by content
 *     (`diffTaskLines`: a line that only moved or got new neighbours is not a
 *     change, a pasted task line is an insertion);
 *  2. adds the stamp edit for every changed task line to the user's own
 *     transaction (`[tr, { changes, sequential: true }]`), so the status change
 *     and its stamp are one undo step; "Close stamps" is read from the
 *     settings on every transaction;
 *  3. emits `task-lifecycle:status-changed` for every changed task line, top to
 *     bottom, whether or not stamps are on.
 *
 * Typing a status char takes more than one keystroke when the checkbox has to
 * be opened first (`[ ]` -> Backspace -> `[]` -> `x`, or `[x ]` -> Delete).
 * The line is not a task line in between, so a per-transaction diff sees
 * nothing. The detector therefore remembers the status char of a task line
 * whose checkbox an edit broke (`broken`, below). When a later edit makes the
 * line a task line again with the same content, the change is measured
 * against the remembered char.
 *
 * It reacts to nothing else: not to undo/redo, not to the plugin's own
 * annotated writes (`taskLifecycleSelfWrite`), not to transactions marked
 * `Transaction.remote`, not to `userEvent: "set"` (how Obsidian applies a
 * change made to the file outside the editor, e.g. from a shell or by sync),
 * and never to files changed outside the editor. It writes stamps and the
 * single space before them and never the status char.
 *
 * Handlers of the event run synchronously inside the dispatch, before the
 * transaction is applied. A handler that needs to edit the note must not
 * dispatch right away: queue the work, then dispatch through the same view
 * with the `taskLifecycleSelfWrite` annotation.
 *
 * The close cascade (`cascade-service.ts`) is the one writer that does NOT
 * annotate: it edits through Obsidian's `Editor.transaction`, which cannot
 * carry a CodeMirror annotation. The detector therefore re-diffs the cascade's
 * write and emits `status-changed` for each subtask it closed. That is safe
 * because those events change nothing: the cascade already wrote the stamp
 * (restamping is idempotent) and a closed subtask has no open subtasks left,
 * so no dialog opens. Any new writer must annotate, not rely on this.
 */
import {
	Annotation,
	EditorState,
	MapMode,
	StateField,
	Transaction,
	type ChangeSpec,
	type Extension,
	type TransactionSpec,
} from "@codemirror/state";
import { editorInfoField } from "obsidian";

import { SELF_WRITE_SUPPRESSION_MS } from "../domain/constants";
import { classifyLines, getCheckboxStatusChar, isTaskLine } from "../domain/line-classifier";
import { applyStampTransition } from "../domain/stamps";
import {
	contentKey,
	diffTaskLines,
	mergeHunks,
	type LineHunk,
	type TaskStatusChange,
} from "../domain/task-line-diff";
import { STATUS_CHANGED_EVENT, type TaskLifecycleEvents } from "../events/event-bus";

/**
 * Put this on every transaction the plugin dispatches itself. The detector
 * skips such a transaction and ignores the lines it touched for
 * `SELF_WRITE_SUPPRESSION_MS`. The suppression is per line, never per file.
 */
export const taskLifecycleSelfWrite = Annotation.define<boolean>();

export interface ChangeDetectorDeps {
	events: Pick<TaskLifecycleEvents, "emit">;
	/** Read on every transaction, so a toggle applies without reload. */
	getSettings: () => { closeStamps: boolean };
	/** Clock for the self-write window (ms). Default `Date.now`. */
	now?: () => number;
	/** "Today" for stamps. Default `new Date()`. */
	today?: () => Date;
}

interface Mark {
	/** End of the suppressed line; maps with the text and stays inside that line. */
	pos: number;
	until: number;
}

/** A task line whose checkbox an edit broke, waiting to become a task line again. */
interface Broken {
	/**
	 * A position inside the line (one char after its start, so that deleting
	 * the whole line is seen as a deletion of the position). Maps with the
	 * text; the entry is dropped when the position is deleted.
	 */
	pos: number;
	/** `contentKey` of the line while it was a task line. */
	key: string;
	/** Its status char then. */
	char: string;
}

/** Most broken lines remembered at once (oldest dropped first). */
const MAX_BROKEN = 50;

/** The position a `Broken` entry keeps for `line`: inside it, not on its start. */
function insideLine(line: { from: number; to: number }): number {
	return Math.min(line.from + 1, line.to);
}

/** Merged changed line ranges of a transaction, 0-based, on both sides. */
function changedHunks(tr: Transaction): LineHunk[] {
	const oldDoc = tr.startState.doc;
	const newDoc = tr.newDoc;
	const hunks: LineHunk[] = [];
	tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
		hunks.push({
			oldFrom: oldDoc.lineAt(fromA).number - 1,
			oldTo: oldDoc.lineAt(toA).number - 1,
			newFrom: newDoc.lineAt(fromB).number - 1,
			newTo: newDoc.lineAt(toB).number - 1,
		});
	});
	return mergeHunks(hunks);
}

/** True for transactions the detector never reacts to (see the file comment). */
function isIgnored(tr: Transaction): boolean {
	return (
		tr.annotation(taskLifecycleSelfWrite) === true ||
		tr.isUserEvent("undo") ||
		tr.isUserEvent("redo") ||
		tr.isUserEvent("set") ||
		tr.annotation(Transaction.remote) === true
	);
}

/** The smallest single replacement that turns `before` into `after`. */
function minimalEdit(
	lineFrom: number,
	before: string,
	after: string
): { from: number; to: number; insert: string } | null {
	if (before === after) return null;
	let start = 0;
	const max = Math.min(before.length, after.length);
	while (start < max && before[start] === after[start]) start++;
	let endBefore = before.length;
	let endAfter = after.length;
	while (
		endBefore > start &&
		endAfter > start &&
		before[endBefore - 1] === after[endAfter - 1]
	) {
		endBefore--;
		endAfter--;
	}
	return {
		from: lineFrom + start,
		to: lineFrom + endBefore,
		insert: after.slice(start, endAfter),
	};
}

export function createChangeDetector(deps: ChangeDetectorDeps): Extension {
	const now = deps.now ?? (() => Date.now());
	const today = deps.today ?? (() => new Date());

	/** Lines the plugin wrote itself, mapped through later edits. */
	const marks = StateField.define<Mark[]>({
		create: () => [],
		update(value, tr) {
			const t = now();
			let next = value.filter((m) => m.until > t);
			if (tr.docChanged) {
				next = next.map((m) => ({ pos: tr.changes.mapPos(m.pos, -1), until: m.until }));
				if (tr.annotation(taskLifecycleSelfWrite)) {
					tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
						const first = tr.newDoc.lineAt(fromB).number;
						const last = tr.newDoc.lineAt(toB).number;
						for (let n = first; n <= last; n++) {
							next.push({ pos: tr.newDoc.line(n).to, until: t + SELF_WRITE_SUPPRESSION_MS });
						}
					});
				}
			}
			return next.length === 0 && value.length === 0 ? value : next;
		},
	});

	/**
	 * Task lines whose checkbox was broken by an edit (`- [ ] a` -> `- [] a`),
	 * with the status char they had. An entry ends when its line is a task
	 * line again (whatever the cause) or is deleted.
	 */
	const broken = StateField.define<Broken[]>({
		create: () => [],
		update(value, tr) {
			if (!tr.docChanged) return value;
			const newDoc = tr.newDoc;
			const next: Broken[] = [];
			for (const b of value) {
				const pos = tr.changes.mapPos(b.pos, 1, MapMode.TrackDel);
				if (pos === null) continue;
				if (isTaskLine(newDoc.lineAt(pos).text)) continue;
				next.push({ ...b, pos: insideLine(newDoc.lineAt(pos)) });
			}
			if (!isIgnored(tr)) {
				const oldDoc = tr.startState.doc;
				for (const h of changedHunks(tr)) {
					if (h.oldTo - h.oldFrom !== h.newTo - h.newFrom) continue;
					for (let i = 0; i <= h.newTo - h.newFrom; i++) {
						const oldText = oldDoc.line(h.oldFrom + i + 1).text;
						const char = getCheckboxStatusChar(oldText);
						const newLine = newDoc.line(h.newFrom + i + 1);
						if (char === null || isTaskLine(newLine.text)) continue;
						next.push({ pos: insideLine(newLine), key: contentKey(oldText), char });
					}
				}
			}
			return next.slice(-MAX_BROKEN);
		},
	});

	/**
	 * Status changes of lines this transaction turned back into task lines:
	 * compared with the char remembered when the checkbox broke.
	 */
	const restored = (tr: Transaction): TaskStatusChange[] => {
		const entries = tr.startState.field(broken);
		if (entries.length === 0) return [];
		const newDoc = tr.newDoc;
		const found: TaskStatusChange[] = [];
		for (const b of entries) {
			const pos = tr.changes.mapPos(b.pos, 1, MapMode.TrackDel);
			if (pos === null) continue;
			const line = newDoc.lineAt(pos);
			const char = getCheckboxStatusChar(line.text);
			if (char === null || char === b.char || contentKey(line.text) !== b.key) continue;
			found.push({ line: line.number - 1, lineText: line.text, from: b.char, to: char });
		}
		if (found.length === 0) return [];
		// Fences and frontmatter never count (the classifier needs the whole note).
		const info = classifyLines(newDoc.toJSON());
		return found.filter((c) => info[c.line]?.kind === "task" && !info[c.line].excluded);
	};

	const filter = (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
		if (!tr.docChanged) return tr;
		if (isIgnored(tr)) return tr;

		const oldDoc = tr.startState.doc;
		const newDoc = tr.newDoc;

		// Changed line ranges on both sides, and a cheap test: a status change
		// needs a task line on both sides of some range.
		const hunks = changedHunks(tr);
		const hasTask = (doc: typeof oldDoc, from: number, to: number) => {
			for (let n = from; n <= to; n++) if (isTaskLine(doc.line(n + 1).text)) return true;
			return false;
		};
		const mayChange = hunks.some(
			(h) => hasTask(oldDoc, h.oldFrom, h.oldTo) && hasTask(newDoc, h.newFrom, h.newTo)
		);

		const direct = mayChange ? diffTaskLines(oldDoc.toJSON(), newDoc.toJSON(), hunks) : [];
		const lines = new Set(direct.map((c) => c.line));
		const changes = [...direct, ...restored(tr).filter((c) => !lines.has(c.line))].sort(
			(a, b) => a.line - b.line
		);
		if (changes.length === 0) return tr;

		// Lines the plugin wrote itself in the last 1200 ms are not re-detected.
		const t = now();
		const suppressed = tr.startState
			.field(marks)
			.filter((m) => m.until > t)
			.map((m) => newDoc.lineAt(tr.changes.mapPos(m.pos, -1)).from);
		const live = changes.filter((c) => !suppressed.includes(newDoc.line(c.line + 1).from));
		if (live.length === 0) return tr;

		const stampsOn = deps.getSettings().closeStamps;
		const date = today();
		const edits: ChangeSpec[] = [];
		for (const c of live) {
			const stamped = applyStampTransition(c.lineText, c.from, c.to, date, { stampsOn });
			const edit = minimalEdit(newDoc.line(c.line + 1).from, c.lineText, stamped);
			if (edit) edits.push(edit);
		}

		const file = tr.startState.field(editorInfoField, false)?.file ?? null;
		for (const c of live) {
			deps.events.emit(STATUS_CHANGED_EVENT, {
				file,
				line: c.line,
				lineText: c.lineText,
				from: c.from,
				to: c.to,
			});
		}

		return edits.length > 0 ? [tr, { changes: edits, sequential: true }] : tr;
	};

	return [marks, broken, EditorState.transactionFilter.of(filter)];
}
