/**
 * The "Close subtasks?" dialog: an Obsidian `Modal` subclass.
 *
 * Title "Close subtasks?", text "This task has 1 open subtask." / "This task
 * has N open subtasks.", and two buttons: "Close subtasks" (the default: it has
 * focus and Enter presses it) and "Leave open" (Escape, the close button and
 * every other way of closing the dialog). `result` always settles, exactly
 * once, with "close" or "leave", however the dialog ends.
 *
 * It adds no style of its own: it uses Obsidian's modal classes.
 */
import { Modal, type App } from "obsidian";

export type CascadeChoice = "close" | "leave";

/** What the cascade needs from a dialog; tests pass a fake. */
export interface CascadePrompt {
	/** Show the dialog for `count` open subtasks. A dialog already open closes as "leave". */
	open(count: number): Promise<CascadeChoice>;
	/** Close the open dialog, if any, as "leave". */
	closeOpen(): void;
}

export function subtaskText(count: number): string {
	return count === 1
		? "This task has 1 open subtask."
		: `This task has ${count} open subtasks.`;
}

export class CloseSubtasksModal extends Modal {
	/** Settles when the dialog ends: "close" only for the default button or Enter. */
	readonly result: Promise<CascadeChoice>;

	private settle!: (choice: CascadeChoice) => void;
	private settled = false;
	private disposers: Array<() => void> = [];

	constructor(
		app: App,
		private readonly count: number
	) {
		super(app);
		this.result = new Promise<CascadeChoice>((resolve) => {
			this.settle = resolve;
		});
	}

	onOpen(): void {
		this.titleEl.setText("Close subtasks?");
		this.contentEl.empty();
		this.contentEl.createEl("p", { text: subtaskText(this.count) });

		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const confirm = row.createEl("button", { text: "Close subtasks", cls: "mod-cta" });
		const leave = row.createEl("button", { text: "Leave open" });

		const onConfirm = () => this.finish("close");
		const onLeave = () => this.finish("leave");
		confirm.addEventListener("click", onConfirm);
		leave.addEventListener("click", onLeave);
		this.disposers.push(
			() => confirm.removeEventListener("click", onConfirm),
			() => leave.removeEventListener("click", onLeave)
		);

		// Enter means "Close subtasks", unless "Leave open" has focus: then
		// Enter presses that button.
		const enter = this.scope.register([], "Enter", (evt: KeyboardEvent) => {
			if (evt.target === leave) return true;
			this.finish("close");
			return false;
		});
		this.disposers.push(() => this.scope.unregister(enter));

		confirm.focus();
	}

	onClose(): void {
		for (const dispose of this.disposers.splice(0)) dispose();
		this.contentEl.empty();
		this.settleOnce("leave");
	}

	private finish(choice: CascadeChoice): void {
		this.settleOnce(choice);
		this.close();
	}

	private settleOnce(choice: CascadeChoice): void {
		if (this.settled) return;
		this.settled = true;
		this.settle(choice);
	}
}

/**
 * Holds the one dialog that may be open. Opening a second closes the first as
 * "leave" before the new one shows, so there is never more than one modal and
 * nothing is left behind.
 */
export class CloseSubtasksDialog implements CascadePrompt {
	private current: CloseSubtasksModal | null = null;

	constructor(private readonly app: App) {}

	open(count: number): Promise<CascadeChoice> {
		this.current?.close();
		const modal = new CloseSubtasksModal(this.app, count);
		this.current = modal;
		modal.open();
		void modal.result.then(() => {
			if (this.current === modal) this.current = null;
		});
		return modal.result;
	}

	closeOpen(): void {
		this.current?.close();
	}
}
