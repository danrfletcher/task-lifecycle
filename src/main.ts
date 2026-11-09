import { Plugin } from "obsidian";

import { bindCheckboxIcons } from "./settings/checkbox-icons";
import { SettingsStore } from "./settings/settings";
import { TaskLifecycleSettingTab } from "./settings/settings-tab";

export default class TaskLifecyclePlugin extends Plugin {
	/**
	 * The settings store. Other features read `settings.get()` and react to
	 * changes with `settings.subscribe((next, prev) => ...)`.
	 */
	settings!: SettingsStore;

	private disposeCheckboxIcons: (() => void) | null = null;

	async onload(): Promise<void> {
		this.settings = new SettingsStore({
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		});
		await this.settings.load();

		this.disposeCheckboxIcons = bindCheckboxIcons(this.settings);
		this.addSettingTab(new TaskLifecycleSettingTab(this.app, this, this.settings));
	}

	onunload(): void {
		this.disposeCheckboxIcons?.();
		this.disposeCheckboxIcons = null;
		this.settings?.clear();
	}
}
