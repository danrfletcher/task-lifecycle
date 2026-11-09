// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CloseSubtasksDialog,
	CloseSubtasksModal,
	subtaskText,
	type CascadeChoice,
} from "../../src/cascade/close-subtasks-modal";
import { App, Modal, type Scope } from "../__mocks__/obsidian";

const app = new App() as never;

const containers = () => document.querySelectorAll(".modal-container");
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-container button"));

/** Settle a result promise and return what it resolved to (or "pending"). */
async function state(p: Promise<CascadeChoice>): Promise<CascadeChoice | "pending"> {
	return Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 0))]);
}

beforeEach(() => {
	document.body.innerHTML = "";
	Modal.openModals = [];
});
afterEach(() => {
	for (const m of [...Modal.openModals]) m.close();
	document.body.innerHTML = "";
});

describe("CloseSubtasksModal content", () => {
	it("shows the title, the singular text and the two buttons", () => {
		const modal = new CloseSubtasksModal(app, 1);
		modal.open();
		expect(modal.titleEl.textContent).toBe("Close subtasks?");
		expect(modal.contentEl.querySelector("p")?.textContent).toBe("This task has 1 open subtask.");
		expect(buttons().map((b) => b.textContent)).toEqual(["Close subtasks", "Leave open"]);
	});

	it.each([
		[2, "This task has 2 open subtasks."],
		[7, "This task has 7 open subtasks."],
	])("plural text for %i", (count, text) => {
		const modal = new CloseSubtasksModal(app, count);
		modal.open();
		expect(modal.contentEl.querySelector("p")?.textContent).toBe(text);
		expect(subtaskText(count)).toBe(text);
	});

	it("\"Close subtasks\" is the call-to-action button and has focus; no inline style or style element", () => {
		const modal = new CloseSubtasksModal(app, 2);
		modal.open();
		const [confirm, leave] = buttons();
		expect(confirm.classList.contains("mod-cta")).toBe(true);
		expect(leave.classList.contains("mod-cta")).toBe(false);
		expect(document.activeElement).toBe(confirm);
		expect(document.querySelectorAll("style")).toHaveLength(0);
		expect(document.querySelector(".modal-container [style]")).toBeNull();
	});
});

describe("CloseSubtasksModal results", () => {
	it("Enter resolves \"close\" and closes the modal", async () => {
		const modal = new CloseSubtasksModal(app, 2);
		modal.open();
		expect((modal.scope as unknown as Scope).press("Enter", { target: buttons()[0] })).toBe(true);
		await expect(modal.result).resolves.toBe("close");
		expect(containers()).toHaveLength(0);
	});

	it("Enter while \"Leave open\" has focus is left to that button", async () => {
		const modal = new CloseSubtasksModal(app, 2);
		modal.open();
		const scope = modal.scope as unknown as Scope;
		expect(scope.press("Enter", { target: buttons()[1] })).toBe(false);
		expect(await state(modal.result)).toBe("pending");
		buttons()[1].click();
		await expect(modal.result).resolves.toBe("leave");
	});

	it("the \"Close subtasks\" button resolves \"close\"", async () => {
		const modal = new CloseSubtasksModal(app, 2);
		modal.open();
		buttons()[0].click();
		await expect(modal.result).resolves.toBe("close");
		expect(containers()).toHaveLength(0);
	});

	it("the \"Leave open\" button resolves \"leave\"", async () => {
		const modal = new CloseSubtasksModal(app, 2);
		modal.open();
		buttons()[1].click();
		await expect(modal.result).resolves.toBe("leave");
		expect(containers()).toHaveLength(0);
	});

	it("Escape and the close button (both `close()`) resolve \"leave\"", async () => {
		const modal = new CloseSubtasksModal(app, 2);
		modal.open();
		modal.close();
		await expect(modal.result).resolves.toBe("leave");
		expect(containers()).toHaveLength(0);
	});

	it("settles once: a later leave does not change \"close\"", async () => {
		const modal = new CloseSubtasksModal(app, 2);
		modal.open();
		buttons()[0].click();
		modal.close();
		await expect(modal.result).resolves.toBe("close");
	});

	it("onClose removes the key handler and both click listeners", () => {
		const remove = vi.spyOn(HTMLElement.prototype, "removeEventListener");
		const modal = new CloseSubtasksModal(app, 2);
		modal.open();
		const scope = modal.scope as unknown as Scope;
		expect(scope.handlers).toHaveLength(1);
		modal.close();
		expect(scope.handlers).toHaveLength(0);
		expect(remove.mock.calls.filter(([type]) => type === "click")).toHaveLength(2);
		remove.mockRestore();
	});
});

describe("CloseSubtasksDialog (E6)", () => {
	it("a second open resolves the first as \"leave\" and leaves exactly one modal", async () => {
		const dialog = new CloseSubtasksDialog(app);
		const first = dialog.open(1);
		expect(containers()).toHaveLength(1);
		const second = dialog.open(3);
		await expect(first).resolves.toBe("leave");
		expect(await state(second)).toBe("pending");
		expect(containers()).toHaveLength(1);
		expect(document.querySelector(".modal-container p")?.textContent).toBe(
			"This task has 3 open subtasks."
		);

		buttons()[0].click();
		await expect(second).resolves.toBe("close");
		expect(containers()).toHaveLength(0);
		expect(Modal.openModals).toHaveLength(0);
	});

	it("leaves no key handlers behind after both dialogs end", async () => {
		const dialog = new CloseSubtasksDialog(app);
		const first = dialog.open(1);
		const firstScope = Modal.openModals[0].scope;
		const second = dialog.open(2);
		const secondScope = Modal.openModals[0].scope;
		expect(firstScope.handlers).toHaveLength(0);
		expect(secondScope.handlers).toHaveLength(1);
		dialog.closeOpen();
		await Promise.all([first, second]);
		expect(secondScope.handlers).toHaveLength(0);
		expect(containers()).toHaveLength(0);
	});

	it("closeOpen resolves the open dialog as \"leave\"; with none open it does nothing", async () => {
		const dialog = new CloseSubtasksDialog(app);
		expect(() => dialog.closeOpen()).not.toThrow();
		const p = dialog.open(2);
		dialog.closeOpen();
		await expect(p).resolves.toBe("leave");
		expect(containers()).toHaveLength(0);
		expect(() => dialog.closeOpen()).not.toThrow();
	});

	it("can open again after a dialog ended", async () => {
		const dialog = new CloseSubtasksDialog(app);
		const a = dialog.open(1);
		buttons()[1].click();
		await a;
		const b = dialog.open(2);
		expect(containers()).toHaveLength(1);
		buttons()[0].click();
		await expect(b).resolves.toBe("close");
	});
});
