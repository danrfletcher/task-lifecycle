/**
 * The plugin's four settings and the store that owns them.
 *
 * Persistence: `data.json` holds exactly these four boolean keys and nothing
 * else. Anything else found in a loaded file is dropped on the next save.
 *
 * Change notification: `subscribe(listener)` is the one way for other parts of
 * the plugin to learn that a toggle changed. Listeners are called synchronously
 * from `update()` (same tick as the save is started) with `(next, prev)`, in
 * subscription order. Later features use it to react to a toggle being turned
 * off, e.g. cancelling an in-flight long press or closing an open dialog as
 * "Leave open".
 */

export interface TaskLifecycleSettings {
	statusCycle: boolean;
	closeStamps: boolean;
	closeCascade: boolean;
	checkboxIcons: boolean;
}

export type SettingKey = keyof TaskLifecycleSettings;

export const SETTING_KEYS: readonly SettingKey[] = Object.freeze([
	"statusCycle",
	"closeStamps",
	"closeCascade",
	"checkboxIcons",
] as SettingKey[]);

export const DEFAULT_SETTINGS: Readonly<TaskLifecycleSettings> = Object.freeze({
	statusCycle: true,
	closeStamps: true,
	closeCascade: true,
	checkboxIcons: true,
});

export type SettingsListener = (
	next: Readonly<TaskLifecycleSettings>,
	prev: Readonly<TaskLifecycleSettings>
) => void;

/** The slice of Obsidian's `Plugin` the store needs; tests pass an in-memory pair. */
export interface SettingsPersistence {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

/**
 * Turn whatever `loadData()` returned into a complete settings object.
 * Missing keys and non-boolean values become the default (true); unknown keys
 * are dropped; a non-object input gives all defaults.
 */
export function normalizeSettings(raw: unknown): TaskLifecycleSettings {
	const source: Record<string, unknown> =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const out = { ...DEFAULT_SETTINGS };
	for (const key of SETTING_KEYS) {
		const value = Object.prototype.hasOwnProperty.call(source, key)
			? source[key]
			: undefined;
		if (typeof value === "boolean") out[key] = value;
	}
	return out;
}

export class SettingsStore {
	private current: TaskLifecycleSettings = { ...DEFAULT_SETTINGS };
	private listeners: SettingsListener[] = [];
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly persistence: SettingsPersistence) {}

	/** Load from disk. Never throws: a missing, corrupt or unreadable file gives the defaults. */
	async load(): Promise<void> {
		let raw: unknown;
		try {
			raw = await this.persistence.loadData();
		} catch (err) {
			console.error("Task Lifecycle: could not read settings, using defaults", err);
			raw = null;
		}
		this.current = normalizeSettings(raw);
	}

	/** A copy of the current settings. */
	get(): TaskLifecycleSettings {
		return { ...this.current };
	}

	/**
	 * Apply `patch`, notify subscribers synchronously, then save.
	 * Saves are serialised and each writes the latest state, so rapid changes
	 * always leave `data.json` matching the final state. Rejects if this
	 * save's write fails; the in-memory state and subscribers are not rolled back.
	 */
	update(patch: Partial<TaskLifecycleSettings>): Promise<void> {
		const prev = this.get();
		const next = normalizeSettings({ ...prev, ...patch });
		this.current = next;
		const changed = SETTING_KEYS.some((key) => prev[key] !== next[key]);
		if (changed) this.notify(next, prev);

		const write = this.writeQueue.then(() =>
			this.persistence.saveData(normalizeSettings(this.current))
		);
		this.writeQueue = write.catch(() => undefined);
		return write;
	}

	/** Register a listener. Returns a function that removes it. */
	subscribe(listener: SettingsListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	/** Drop every subscriber (plugin unload). */
	clear(): void {
		this.listeners = [];
	}

	private notify(next: TaskLifecycleSettings, prev: TaskLifecycleSettings): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(Object.freeze({ ...next }), Object.freeze({ ...prev }));
			} catch (err) {
				console.error("Task Lifecycle: a settings listener threw", err);
			}
		}
	}
}
