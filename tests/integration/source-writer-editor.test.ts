import { undoDepth } from "@codemirror/commands";
import { describe, expect, it, vi } from "vitest";
import { createCascadeService } from "../../src/cascade/cascade-service";
import { SELF_WRITE_SUPPRESSION_MS } from "../../src/domain/constants";
import { createSourceWriter, type SourceWriter } from "../../src/rendered/source-writer";
import { makeCmEditor } from "../helpers/cm-editor";
import { fixtureFile } from "../fixtures/source-lines";

const TODAY = new Date(2026, 10, 20, 12, 0, 0);
type SourceFile = Parameters<SourceWriter["press"]>[0];
const file = (path: string): SourceFile => ({ path, name: path, extension: "md" }) as never;
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** `app` with the given open editors and a vault that knows only `process`. */
function appWith(open: Record<string, unknown>, texts: Record<string, string> = {}) {
	const store = new Map(Object.entries(texts));
	const vault = {
		store,
		process: vi.fn(async (f: SourceFile, fn: (d: string) => string) => {
			const next = fn(store.get(f.path) ?? "");
			store.set(f.path, next);
			return next;
		}),
	};
	const workspace = {
		getLeavesOfType: () => Object.entries(open).map(([path, editor]) => ({ view: { file: { path }, editor } })),
	};
	return { vault, workspace };
}

const COURSE = "- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n";

function setup(doc: string, texts: Record<string, string> = {}) {
	const cm = makeCmEditor(doc, { today: TODAY });
	const app = appWith({ "Course.md": cm.editor }, texts);
	const writer = createSourceWriter({
		app: app as never,
		getSettings: () => cm.settings,
		today: () => TODAY,
	});
	return { cm, app, writer };
}

describe("open route with the real change detector", () => {
	it("stamps once: the detector reacts to the one-char transaction and nothing stamps again", async () => {
		const { cm, writer, app } = setup(COURSE);

		const r = await writer.press(file("Course.md"), 0, "click");

		expect(r).toMatchObject({ status: "written", route: "editor", from: "/", to: "x" });
		expect(cm.doc()).toBe(
			"- [x] Lesson 2 content ✅ 2026-11-20 ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n"
		);
		expect(cm.events).toEqual([{ line: 0, from: "/", to: "x" }]);
		expect(cm.transactions).toHaveLength(1);
		expect(cm.transactions[0].changes).toHaveLength(1);
		expect(app.vault.process).not.toHaveBeenCalled();

		// After the 1.2 s self-write window, an unrelated edit does not stamp again.
		cm.clock.t += SELF_WRITE_SUPPRESSION_MS + 800;
		cm.type(2, " more");
		expect(count(cm.doc(), "✅")).toBe(1);
		expect(cm.events).toHaveLength(1);
	});

	it("the cascade dedupe: the parent keeps one stamp while the dialog closes the subtasks", async () => {
		const { cm, writer } = setup(COURSE);
		const prompt = { open: vi.fn(async () => "close" as const), closeOpen: vi.fn() };
		const cascade = createCascadeService({
			events: cm.bus,
			settings: {
				get: () => ({ statusCycle: true, closeStamps: true, closeCascade: true, checkboxIcons: true }),
				subscribe: () => () => undefined,
			},
			prompt,
			getEditor: () => cm.editor,
			today: () => TODAY,
		});

		await writer.press(file("Course.md"), 0, "click");
		await new Promise((r) => setTimeout(r, 10)); // the cascade reads in a microtask, then the dialog resolves

		expect(prompt.open).toHaveBeenCalledWith(2);
		expect(cm.doc()).toBe(
			[
				"- [x] Lesson 2 content ✅ 2026-11-20 ^l2",
				"\t- [x] Watch video ✅ 2026-11-20",
				"\t- [x] Take notes ✅ 2026-11-20",
				"",
			].join("\n")
		);
		cm.clock.t += 5000;
		cm.type(0, " edited later"); // outside both windows: the parent line is not stamped again
		expect(cm.doc().split("\n")[0]).toBe("- [x] Lesson 2 content ✅ 2026-11-20 ^l2 edited later");
		cascade.dispose();
	});

	it("E11: one undo restores the line, status and stamp together", async () => {
		const { cm, writer } = setup(COURSE);
		await writer.press(file("Course.md"), 0, "click");
		expect(undoDepth(cm.state())).toBe(1);

		expect(cm.undo()).toBe(true);

		expect(cm.doc()).toBe(COURSE);
		expect(undoDepth(cm.state())).toBe(0);
	});

	it("E11: a cancel from [x] swaps the stamp, also in one undo step", async () => {
		const { cm, writer } = setup("- [x] Lesson 2 content ✅ 2026-11-08 ^l2\n");
		await writer.press(file("Course.md"), 0, "longPress");
		expect(cm.doc()).toBe("- [-] Lesson 2 content ❌ 2026-11-20 ^l2\n");
		cm.undo();
		expect(cm.doc()).toBe("- [x] Lesson 2 content ✅ 2026-11-08 ^l2\n");
	});

	it("E11: a write on a closed note adds nothing to any editor's history", async () => {
		const other = makeCmEditor("- [ ] Other note\n", { today: TODAY, path: "Other.md" });
		const app = appWith({ "Other.md": other.editor }, { "Course.md": COURSE });
		const writer = createSourceWriter({
			app: app as never,
			getSettings: () => other.settings,
			today: () => TODAY,
		});

		const r = await writer.press(file("Course.md"), 0, "click");

		expect(r).toMatchObject({ status: "written", route: "vault" });
		expect(app.vault.store.get("Course.md")).toContain("[x]");
		expect(undoDepth(other.state())).toBe(0);
		expect(other.undo()).toBe(false);
		expect(other.doc()).toBe("- [ ] Other note\n");
	});

	it("E4: typing not yet on disk is kept, only the task line changes, and undo of the press keeps the typing", async () => {
		const { cm, writer, app } = setup(COURSE, { "Course.md": COURSE });
		cm.type(1, " TYPED");
		const before = cm.doc().split("\n");

		await writer.press(file("Course.md"), 0, "click");

		const after = cm.doc().split("\n");
		expect(after[1]).toBe("\t- [ ] Watch video TYPED");
		expect(after.filter((_l, i) => before[i] !== after[i])).toEqual([
			"- [x] Lesson 2 content ✅ 2026-11-20 ^l2",
		]);
		expect(app.vault.process).not.toHaveBeenCalled();
		expect(app.vault.store.get("Course.md")).toBe(COURSE);
	});

	it("two quick presses on an open note advance twice, one stamp", async () => {
		const { cm, writer } = setup("- [ ] a ^id\n");
		await Promise.all([
			writer.press(file("Course.md"), 0, "click"),
			writer.press(file("Course.md"), 0, "click"),
		]);
		expect(cm.doc()).toBe("- [x] a ✅ 2026-11-20 ^id\n");
	});

	it("closed-route parity on the lifecycle demo fixture, every task line, every press", async () => {
		const text = fixtureFile("lifecycle-demo.md");
		const lines = text.split("\n");
		for (const [i, line] of lines.entries()) {
			if (!/\[.\]/.test(line)) continue;
			for (const kind of ["click", "longPress"] as const) {
				const cm = makeCmEditor(text, { today: TODAY });
				const open = createSourceWriter({
					app: appWith({ "Course.md": cm.editor }) as never,
					getSettings: () => cm.settings,
					today: () => TODAY,
				});
				const closedApp = appWith({}, { "Course.md": text });
				const closed = createSourceWriter({
					app: closedApp as never,
					getSettings: () => cm.settings,
					today: () => TODAY,
				});
				await open.press(file("Course.md"), i, kind);
				await closed.press(file("Course.md"), i, kind);
				expect(cm.doc()).toBe(closedApp.vault.store.get("Course.md"));
			}
		}
	});
});
