/**
 * The plugin's own event bus. It is a plain object owned by the plugin
 * instance: nothing is dispatched on `document`, `window` or Obsidian's
 * workspace, and nothing is exposed to other plugins.
 */
import type { TFile } from "obsidian";

export const STATUS_CHANGED_EVENT = "task-lifecycle:status-changed";

export interface StatusChangedPayload {
	/** The note the editor belongs to; null if the editor has no file. */
	file: TFile | null;
	/** 0-based line number in the note after the change. */
	line: number;
	/** The line as the user's change left it (status char changed, stamps not yet applied). */
	lineText: string;
	/** Status char before. */
	from: string;
	/** Status char after. */
	to: string;
}

export interface TaskLifecycleEventMap {
	[STATUS_CHANGED_EVENT]: StatusChangedPayload;
}

export type TaskLifecycleEventName = keyof TaskLifecycleEventMap;

type Handler<K extends TaskLifecycleEventName> = (payload: TaskLifecycleEventMap[K]) => void;

export class TaskLifecycleEvents {
	private handlers = new Map<TaskLifecycleEventName, Array<Handler<never>>>();

	/** Subscribe. Returns a function that removes the handler. */
	on<K extends TaskLifecycleEventName>(name: K, handler: Handler<K>): () => void {
		const list = this.handlers.get(name) ?? [];
		list.push(handler);
		this.handlers.set(name, list);
		return () => {
			const current = this.handlers.get(name) ?? [];
			this.handlers.set(
				name,
				current.filter((h) => h !== (handler as Handler<never>))
			);
		};
	}

	/**
	 * Call every handler for `name`, in subscription order, synchronously. A
	 * handler that throws is logged and does not stop the others.
	 */
	emit<K extends TaskLifecycleEventName>(name: K, payload: TaskLifecycleEventMap[K]): void {
		for (const handler of [...(this.handlers.get(name) ?? [])]) {
			try {
				(handler as Handler<K>)(payload);
			} catch (err) {
				console.error(`Task Lifecycle: a ${name} handler threw`, err);
			}
		}
	}

	/** Drop every handler (plugin unload). */
	clear(): void {
		this.handlers.clear();
	}
}
