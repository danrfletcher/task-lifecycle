import type { SettingsStore } from "./settings";

/**
 * Body class that switches on the checkbox icon rules in styles.css.
 * The rules are static CSS shipped with the plugin; this class is the only
 * thing toggled at runtime. No style element is ever created.
 */
export const CHECKBOX_ICONS_CLASS = "task-lifecycle-checkboxes";

/** Add or remove the body class. Idempotent. */
export function applyCheckboxIcons(
	enabled: boolean,
	body: HTMLElement = document.body
): void {
	body.classList.toggle(CHECKBOX_ICONS_CLASS, enabled);
}

/**
 * Apply the stored `checkboxIcons` setting now, and keep the body class in
 * step with it. Returns a function that stops following the setting and
 * removes the class (call it on plugin unload).
 */
export function bindCheckboxIcons(
	store: SettingsStore,
	body: HTMLElement = document.body
): () => void {
	applyCheckboxIcons(store.get().checkboxIcons, body);
	const unsubscribe = store.subscribe((next) => {
		applyCheckboxIcons(next.checkboxIcons, body);
	});
	return () => {
		unsubscribe();
		applyCheckboxIcons(false, body);
	};
}
