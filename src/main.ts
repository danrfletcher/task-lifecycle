import { Plugin } from "obsidian";

import { wireCascade } from "./cascade/wire-cascade";
import { createChangeDetector } from "./editor/change-detector";
import { TaskLifecycleEvents } from "./events/event-bus";
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

	private disposeCheckboxIcons: (() => void) | null = null;
	private disposeCheckboxPress: (() => void) | null = null;
	private disposeCascade: (() => void) | null = null;

	async onload(): Promise<void> {
		this.settings = new SettingsStore({
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		});
		await this.settings.load();

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
