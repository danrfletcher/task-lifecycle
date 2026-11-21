/**
 * Find the editor a note is open in, in any Markdown leaf: the main window,
 * a split, a popout window, or the host note itself. A leaf that shows the
 * note in Reading view is not an editor (see `editorOf`).
 *
 * Shared by the close cascade and the source writer. Read-only: it looks at
 * `workspace.getLeavesOfType("markdown")` and writes nothing.
 */
import type { App, EditorChange } from "obsidian";

/** The slice of Obsidian's `Editor` that the cascade and the source writer use. */
export interface OpenEditor {
	lineCount(): number;
	getLine(line: number): string;
	transaction(tx: { changes?: EditorChange[] }): void;
}

/** The slice of a Markdown view the lookup reads. */
interface NoteView {
	file?: { path: string } | null;
	editor?: OpenEditor;
	/** Set by Obsidian while the view holds changes that are not saved yet (not in the public typings). */
	dirty?: boolean;
	/** `"source"` (Source mode or Live Preview) or `"preview"` (Reading view). Absent in older fakes. */
	getMode?: () => string;
}

/**
 * The view's editor, if it is one the note is being edited in. A leaf showing
 * the note in Reading view keeps an editor object that is not on screen:
 * writing through it is not a transaction on an open editor, so such a leaf
 * counts as the note being closed (the write goes through the vault's atomic process call).
 */
function editorOf(view: NoteView): OpenEditor | null {
	if (!view.editor) return null;
	if (view.getMode?.() === "preview") return null;
	return view.editor;
}

/** The first Markdown leaf showing `file` with an editor, or null if the note is not open. */
export function findOpenEditor(app: App, file: { path: string }): OpenEditor | null {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view as unknown as NoteView;
		const editor = editorOf(view);
		if (view.file?.path === file.path && editor) return editor;
	}
	return null;
}

/**
 * The editor to write through when the note may be open in more than one pane.
 *
 * Two panes on one note are separate editors that Obsidian keeps in step. A
 * change made through the pane that is not being edited can corrupt the file
 * when the autosave runs, so the pick is, in order:
 *  1. the active editor, when it shows `file` (the pane being typed in);
 *  2. a pane Obsidian marks as holding changes not yet saved (`view.dirty`);
 *  3. the first Markdown leaf showing `file`, as `findOpenEditor`.
 * Null if the note is not open in any editor. Read-only.
 */
export function findEditorToWrite(app: App, file: { path: string }): OpenEditor | null {
	const active = app.workspace.activeEditor as unknown as NoteView | null | undefined;
	const activeEditor = active ? editorOf(active) : null;
	if (active?.file?.path === file.path && activeEditor) return activeEditor;

	let first: OpenEditor | null = null;
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view as unknown as NoteView;
		const editor = editorOf(view);
		if (view.file?.path !== file.path || !editor) continue;
		if (view.dirty) return editor;
		first ??= editor;
	}
	return first;
}
