import { App, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { SettingKey, SettingsStore } from "./settings";

interface ToggleRow {
	key: SettingKey;
	name: string;
	desc: string;
}

/** The four rows, in display order. No other fields exist in v1. */
export const TOGGLE_ROWS: readonly ToggleRow[] = [
	{
		key: "statusCycle",
		name: "Status cycle",
		desc: "Clicking a task checkbox steps through open, in progress, done and cancelled; holding it cancels the task.",
	},
	{
		key: "closeStamps",
		name: "Close stamps",
		desc: "Add a ✅ or ❌ date when a task is closed, and remove it when the task is reopened.",
	},
	{
		key: "closeCascade",
		name: "Close cascade",
		desc: "When a task with open subtasks is closed, ask whether to close the subtasks too.",
	},
	{
		key: "checkboxIcons",
		name: "Checkbox icons",
		desc: "Show icons for in-progress, done and cancelled checkboxes.",
	},
];

export class TaskLifecycleSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly store: SettingsStore
	) {
		super(app, plugin);
	}

	/** Redraws from the stored values every time the tab is opened. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const current = this.store.get();

		for (const row of TOGGLE_ROWS) {
			new Setting(containerEl)
				.setName(row.name)
				.setDesc(row.desc)
				.addToggle((toggle) =>
					toggle.setValue(current[row.key]).onChange((value) => {
						this.store.update({ [row.key]: value }).catch((err) => {
							console.error("Task Lifecycle: could not save settings", err);
						});
					})
				);
		}
	}
}
