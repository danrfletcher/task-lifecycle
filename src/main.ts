import { Plugin } from "obsidian";

import { wireCascade } from "./cascade/wire-cascade";
import { createChangeDetector } from "./editor/change-detector";
import { TaskLifecycleEvents } from "./events/event-bus";
import { resolveRenderedTask, type RenderedTaskResult } from "./rendered/resolve-rendered-task";
import { bindCheckboxIcons } from "./settings/checkbox-icons";
import { SettingsStore } from "./settings/settings";
import { TaskLifecycleSettingTab } from "./settings/settings-tab";
import { wireCheckboxPress } from "./status-cycle/wire-checkbox-press";

export default class TaskLifecyclePlugin extends Plugin {
	/**
	 * The settings store. Other features read `settings.get()` and react to
	 * changes with `settings.subscribe((next, prev) => ...)`.
	 */
	settings!: SettingsStore;

	/** The plugin's own event bus (`task-lifecycle:status-changed`). No public API. */
	events = new TaskLifecycleEvents();

	/**
	 * Read-only: where a rendered task checkbox (in an embed or Reading view)
	 * is in its source note. For the dev console and for later features. It
	 * writes nothing and adds no command, hotkey or listener.
	 */
	resolveRenderedTask = (checkbox: Element): Promise<RenderedTaskResult> =>
		resolveRenderedTask(this.app, checkbox);

	private disposeCheckboxIcons: (() => void) | null = null;
	private disposeCheckboxPress: (() => void) | null = null;
	private disposeCascade: (() => void) | null = null;

	/** Set by `onunload`; stops an `onload` that is still awaiting from wiring anything. */
	private unloaded = false;

	async onload(): Promise<void> {
		this.settings = new SettingsStore({
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		});
		await this.settings.load();
		// Obsidian can unload the plugin while settings are still loading.
		// Wire nothing then: it would never be disposed.
		if (this.unloaded) return;

		this.disposeCheckboxIcons = bindCheckboxIcons(this.settings);
		this.registerEditorExtension(
			createChangeDetector({
				events: this.events,
				getSettings: () => this.settings.get(),
			})
		);
		this.disposeCheckboxPress = wireCheckboxPress({
			plugin: this,
			app: this.app,
			settings: this.settings,
		});
		this.disposeCascade = wireCascade({
			plugin: this,
			app: this.app,
			settings: this.settings,
			events: this.events,
		});
		this.addSettingTab(new TaskLifecycleSettingTab(this.app, this, this.settings));
	}

	onunload(): void {
		this.unloaded = true;
		this.disposeCascade?.();
		this.disposeCascade = null;
		this.disposeCheckboxPress?.();
		this.disposeCheckboxPress = null;
		this.disposeCheckboxIcons?.();
		this.disposeCheckboxIcons = null;
		this.settings?.clear();
		this.events.clear();
	}
}
