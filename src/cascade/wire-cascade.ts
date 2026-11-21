/**
 * Plugin wiring for the close cascade: builds the one `CascadeService` with
 * the real dialog and the real editor lookup, and closes the dialog as
 * "Leave open" when the note is switched or closed.
 */
import type { App, Plugin, TFile } from "obsidian";

import { findOpenEditor } from "../rendered/editor-lookup";
import type { SourceWriter } from "../rendered/source-writer";
import type { TaskLifecycleEvents } from "../events/event-bus";
import type { SettingsStore } from "../settings/settings";
import {
	createCascadeService,
	type CascadeEditor,
	type CascadeFiles,
	type CascadeService,
} from "./cascade-service";
import { CloseSubtasksDialog, type CascadePrompt } from "./close-subtasks-modal";

export interface WireCascadeDeps {
	plugin: Pick<Plugin, "registerEvent">;
	app: App;
	settings: Pick<SettingsStore, "get" | "subscribe">;
	events: Pick<TaskLifecycleEvents, "on">;
	/**
	 * The source writer. The cascade's write to a closed note goes through its
	 * per-file queue, so a press on the same note waits for it and runs after.
	 */
	writer: Pick<SourceWriter, "process">;
	/** Show a message to the user. */
	notify: (message: string) => void;
	/** Default: the Obsidian modal dialog. */
	prompt?: CascadePrompt;
}

export interface WiredCascade extends Pick<CascadeService, "reportClose" | "isDialogOpen"> {
	/** Stop the cascade and close an open dialog as "Leave open". */
	dispose(): void;
}

/** Wire the cascade. `dispose` on the result stops it and closes an open dialog. */
export function wireCascade(deps: WireCascadeDeps): WiredCascade {
	const { plugin, app } = deps;

	const getEditor = (file: TFile): CascadeEditor | null => findOpenEditor(app, file);

	const files: CascadeFiles = {
		read: (file) => app.vault.read(file),
		process: (file, fn) => deps.writer.process(file, fn),
	};

	const service = createCascadeService({
		events: deps.events,
		settings: deps.settings,
		prompt: deps.prompt ?? new CloseSubtasksDialog(app),
		getEditor,
		files,
		notify: deps.notify,
	});

	// Switching to another note (or closing this one) leaves everything as it is.
	// Showing the dialog's own note (opened in a pane) keeps the dialog: the apply then writes through its editor.
	plugin.registerEvent(
		app.workspace.on("active-leaf-change", (leaf) => {
			const file = (leaf?.view as { file?: TFile | null } | undefined)?.file;
			service.cancelPrompt(file ?? null);
		})
	);
	plugin.registerEvent(app.workspace.on("file-open", (file) => service.cancelPrompt(file)));

	return {
		reportClose: (payload) => service.reportClose(payload),
		isDialogOpen: () => service.isDialogOpen(),
		dispose: () => service.dispose(),
	};
}
