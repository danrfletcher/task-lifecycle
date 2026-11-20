/**
 * Plugin wiring for the close cascade: builds the one `CascadeService` with
 * the real dialog and the real editor lookup, and closes the dialog as
 * "Leave open" when the note is switched or closed.
 */
import type { App, Plugin, TFile } from "obsidian";

import { findOpenEditor } from "../rendered/editor-lookup";
import type { TaskLifecycleEvents } from "../events/event-bus";
import type { SettingsStore } from "../settings/settings";
import { createCascadeService, type CascadeEditor } from "./cascade-service";
import { CloseSubtasksDialog, type CascadePrompt } from "./close-subtasks-modal";

export interface WireCascadeDeps {
	plugin: Pick<Plugin, "registerEvent">;
	app: App;
	settings: Pick<SettingsStore, "get" | "subscribe">;
	events: Pick<TaskLifecycleEvents, "on">;
	/** Default: the Obsidian modal dialog. */
	prompt?: CascadePrompt;
}

/** Wire the cascade. Returns a function that stops it and closes an open dialog. */
export function wireCascade(deps: WireCascadeDeps): () => void {
	const { plugin, app } = deps;

	const getEditor = (file: TFile): CascadeEditor | null => findOpenEditor(app, file);

	const service = createCascadeService({
		events: deps.events,
		settings: deps.settings,
		prompt: deps.prompt ?? new CloseSubtasksDialog(app),
		getEditor,
	});

	// Switching to another note (or closing this one) leaves everything as it is.
	plugin.registerEvent(app.workspace.on("active-leaf-change", () => service.cancelPrompt()));
	plugin.registerEvent(app.workspace.on("file-open", () => service.cancelPrompt()));

	return () => service.dispose();
}
