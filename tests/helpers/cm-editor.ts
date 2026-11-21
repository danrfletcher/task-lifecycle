/**
 * A real CodeMirror `EditorState` (history + the plugin's change detector)
 * wrapped to look like the slice of Obsidian's `Editor` the source writer
 * uses. Tests share it to check the open-editor route against the real
 * stamping path.
 */
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import type { EditorChange } from "obsidian";
import { vi } from "vitest";
import { createChangeDetector } from "../../src/editor/change-detector";
import { STATUS_CHANGED_EVENT, TaskLifecycleEvents } from "../../src/events/event-bus";
import type { OpenEditor } from "../../src/rendered/editor-lookup";
import { editorInfoField } from "../__mocks__/obsidian";

export interface CmEditor extends OpenEditor {
	getValue(): string;
}

/** A position as Obsidian's editor gives it: 0-based line and column. */
export interface EditorPos {
	line: number;
	ch: number;
}

export interface CmEditorHandle {
	editor: CmEditor;
	/** The current document text. */
	doc(): string;
	state(): EditorState;
	/** One `undo` command; true if it did something. */
	undo(): boolean;
	/** Typed input at the end of line `line` (a user edit, not a press). */
	type(line: number, text: string): void;
	/** Put the selection from `anchor` to `head` (a caret when `head` is left out). */
	select(anchor: EditorPos, head?: EditorPos): void;
	/** The selection as it is now. */
	selection(): { anchor: EditorPos; head: EditorPos };
	/** Every `status-changed` event the detector emitted. */
	events: Array<{ line: number; from: string; to: string }>;
	/** Calls to `editor.transaction`. */
	transactions: Array<{ changes: unknown[] }>;
	settings: { closeStamps: boolean };
	/** The plugin event bus the detector emits on. */
	bus: TaskLifecycleEvents;
	/** The detector's clock in ms; advance it to leave the self-write window. */
	clock: { t: number };
}

export function makeCmEditor(
	doc: string,
	opts: { today: Date; closeStamps?: boolean; path?: string }
): CmEditorHandle {
	const bus = new TaskLifecycleEvents();
	const events: CmEditorHandle["events"] = [];
	bus.on(STATUS_CHANGED_EVENT, (p) => events.push({ line: p.line, from: p.from, to: p.to }));
	const settings = { closeStamps: opts.closeStamps ?? true };
	const clock = { t: 1_000_000 };
	const file = { path: opts.path ?? "Course.md" };

	let state = EditorState.create({
		doc,
		extensions: [
			history(),
			editorInfoField.init(() => ({ file })),
			createChangeDetector({
				events: bus,
				getSettings: () => settings,
				now: () => clock.t,
				today: () => opts.today,
			}),
		],
	});

	const offset = (pos: { line: number; ch: number }) => state.doc.line(pos.line + 1).from + pos.ch;
	const posOf = (at: number): EditorPos => {
		const line = state.doc.lineAt(at);
		return { line: line.number - 1, ch: at - line.from };
	};
	const transactions: CmEditorHandle["transactions"] = [];

	const editor: CmEditor = {
		lineCount: () => state.doc.lines,
		getLine: (n) => state.doc.line(n + 1).text,
		getValue: () => state.doc.toString(),
		transaction: vi.fn((tx: Parameters<OpenEditor["transaction"]>[0]) => {
			const changes = tx.changes ?? [];
			transactions.push({ changes });
			state = state.update({
				changes: changes.map((c: EditorChange) => ({
					from: offset(c.from),
					to: offset(c.to ?? c.from),
					insert: c.text,
				})),
			}).state;
		}),
	};

	return {
		editor,
		doc: () => state.doc.toString(),
		state: () => state,
		undo: () =>
			undo({
				state,
				dispatch: (tr) => {
					state = tr.state;
				},
			}),
		type(line, text) {
			const end = state.doc.line(line + 1).to;
			state = state.update({
				changes: { from: end, insert: text },
				userEvent: "input.type",
			}).state;
		},
		select(anchor, head = anchor) {
			state = state.update({ selection: { anchor: offset(anchor), head: offset(head) } }).state;
		},
		selection() {
			const { anchor, head } = state.selection.main;
			return { anchor: posOf(anchor), head: posOf(head) };
		},
		events,
		bus,
		transactions,
		settings,
		clock,
	};
}
