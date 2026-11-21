import { describe, expect, it } from "vitest";
import { checkboxTokenRange } from "../../src/domain/line-classifier";
import {
	editTextLine,
	joinLines,
	planLineEdit,
	splitLines,
	type LineEditOptions,
} from "../../src/domain/source-line-edit";
import { STATUS_SEQUENCE, type PressKind } from "../../src/domain/status-sequence";
import { DEMO_TASK_LINES, fixtureFile, remainder, SHAPE_LINES, TODAY } from "../fixtures/source-lines";

const ON: LineEditOptions = { stampsOn: true, today: TODAY };
const OFF: LineEditOptions = { stampsOn: false, today: TODAY };

describe("planLineEdit: the plain toggle (Status cycle off)", () => {
	it("open to done stamps the line before its block id", () => {
		const r = planLineEdit(["- [ ] Lesson 2 content ^l2"], 0, "toggle", ON);
		expect(r).toMatchObject({ edit: { from: " ", to: "x", after: "- [x] Lesson 2 content ✅ 2026-11-20 ^l2" } });
	});

	it.each(["x", "X", "-"])("[%s] goes back to open and loses its stamp", (from) => {
		const line = `- [${from}] Lesson ✅ 2026-11-01 ^l2`;
		const r = planLineEdit([line], 0, "toggle", ON);
		expect(r).toMatchObject({ edit: { to: " ", after: "- [ ] Lesson ^l2" } });
	});

	it.each(["/", "?"])("[%s] goes to open; the open kinds carry no stamp to remove", (from) => {
		expect(planLineEdit([`- [${from}] Lesson ^l2`], 0, "toggle", ON)).toMatchObject({
			edit: { to: " ", after: "- [ ] Lesson ^l2" },
		});
	});

	it("with stamps off only the status char changes, and an existing stamp stays", () => {
		expect(planLineEdit(["- [ ] Lesson ^l2"], 0, "toggle", OFF)).toMatchObject({
			edit: { after: "- [x] Lesson ^l2" },
		});
		expect(planLineEdit(["- [x] Lesson ✅ 2026-11-01 ^l2"], 0, "toggle", OFF)).toMatchObject({
			edit: { after: "- [ ] Lesson ✅ 2026-11-01 ^l2" },
		});
	});
});

describe("splitLines / joinLines", () => {
	it.each([
		["", [{ text: "", eol: "" }]],
		["a", [{ text: "a", eol: "" }]],
		["a\n", [{ text: "a", eol: "\n" }, { text: "", eol: "" }]],
		["a\r\n", [{ text: "a", eol: "\r\n" }, { text: "", eol: "" }]],
		[
			"a\r\nb\nc\r\nd",
			[
				{ text: "a", eol: "\r\n" },
				{ text: "b", eol: "\n" },
				{ text: "c", eol: "\r\n" },
				{ text: "d", eol: "" },
			],
		],
		["\n\n", [{ text: "", eol: "\n" }, { text: "", eol: "\n" }, { text: "", eol: "" }]],
	])("splits %j keeping each line's own ending", (text, expected) => {
		expect(splitLines(text)).toEqual(expected);
	});

	it.each(["", "a", "a\n", "a\r\nb\nc\r\n", "\r\n\r\n", "x\ny\r\nz", "a\rb"])(
		"joinLines(splitLines(t)) gives t back for %j",
		(text) => {
			expect(joinLines(splitLines(text))).toBe(text);
		}
	);

	it("round-trips the CRLF fixture byte for byte", () => {
		const crlf = fixtureFile("crlf-note.md");
		expect(joinLines(splitLines(crlf))).toBe(crlf);
		expect(splitLines(crlf).filter((l) => l.eol === "\r\n")).toHaveLength(5);
	});
});

describe("planLineEdit: status and stamp per status char (E1)", () => {
	// [base line, click result, long press result]; null = nothing to write.
	const table: Array<[string, string, string | null]> = [
		["- [ ] Task ^id", "- [/] Task ^id", "- [-] Task ❌ 2026-11-20 ^id"],
		["- [/] Task ^id", "- [x] Task ✅ 2026-11-20 ^id", "- [-] Task ❌ 2026-11-20 ^id"],
		["- [x] Task ✅ 2026-11-08 ^id", "- [-] Task ❌ 2026-11-20 ^id", "- [-] Task ❌ 2026-11-20 ^id"],
		["- [-] Task ❌ 2026-11-08 ^id", "- [ ] Task ^id", null],
		["- [X] Task ✅ 2026-11-08 ^id", "- [-] Task ❌ 2026-11-20 ^id", "- [-] Task ❌ 2026-11-20 ^id"],
		["- [?] Task ^id", "- [ ] Task ^id", "- [-] Task ❌ 2026-11-20 ^id"],
	];

	it.each(table)("%s", (base, click, longPress) => {
		for (const [kind, expected] of [
			["click", click],
			["longPress", longPress],
		] as Array<[PressKind, string | null]>) {
			const r = planLineEdit([base], 0, kind, ON);
			if (expected === null) expect(r).toEqual({ skipped: "no-change" });
			else expect("edit" in r && r.edit.after).toBe(expected);
		}
	});

	it("the table covers every status in the sequence plus X and one unknown char", () => {
		const covered = table.map(([base]) => /\[(.)\]/.exec(base)![1]);
		for (const c of [...STATUS_SEQUENCE, "X", "?"]) expect(covered).toContain(c);
	});

	it("E1: the stamp goes before the block id with one space on each side", () => {
		const closed = planLineEdit(["- [/] Lesson 2 content ^l2"], 0, "click", ON);
		expect(closed).toEqual({
			edit: {
				line: 0,
				ch: 3,
				from: "/",
				to: "x",
				before: "- [/] Lesson 2 content ^l2",
				after: "- [x] Lesson 2 content ✅ 2026-11-20 ^l2",
			},
		});
		const cancelled = planLineEdit(["- [/] Lesson 2 content ^l2"], 0, "longPress", ON);
		expect("edit" in cancelled && cancelled.edit.after).toBe(
			"- [-] Lesson 2 content ❌ 2026-11-20 ^l2"
		);
	});

	it("E1: reopening x -> - -> space removes the stamp and leaves no stray space", () => {
		let line = "- [x] Lesson 2 content ✅ 2026-11-20 ^l2";
		const step = () => {
			const r = planLineEdit([line], 0, "click", ON);
			if (!("edit" in r)) throw new Error("expected an edit");
			line = r.edit.after;
		};
		step();
		expect(line).toBe("- [-] Lesson 2 content ❌ 2026-11-20 ^l2");
		step();
		expect(line).toBe("- [ ] Lesson 2 content ^l2");
	});

	it("E1: an id with hyphens and digits reopens the same way, and an old stamp is replaced not stacked", () => {
		const reopen = planLineEdit(["- [-] Text ❌ 2026-11-08 ^a-1-b2"], 0, "click", ON);
		expect("edit" in reopen && reopen.edit.after).toBe("- [ ] Text ^a-1-b2");
		const replace = planLineEdit(["- [x] Text ✅ 2026-11-08 ^a-1-b2"], 0, "click", ON);
		expect("edit" in replace && replace.edit.after).toBe("- [-] Text ❌ 2026-11-20 ^a-1-b2");
	});

	it("a line with no block id gets the stamp at its end", () => {
		const r = planLineEdit(["- [/] Plain"], 0, "click", ON);
		expect("edit" in r && r.edit.after).toBe("- [x] Plain ✅ 2026-11-20");
	});

	it("closeStamps off: only the status char changes, stamps stay as they are", () => {
		const close = planLineEdit(["- [/] Task ^id"], 0, "click", OFF);
		expect("edit" in close && close.edit.after).toBe("- [x] Task ^id");
		const reopen = planLineEdit(["- [-] Task ❌ 2026-11-08 ^id"], 0, "click", OFF);
		expect("edit" in reopen && reopen.edit.after).toBe("- [ ] Task ❌ 2026-11-08 ^id");
	});

	it("takes a Date and uses its local date", () => {
		const r = planLineEdit(["- [/] Task"], 0, "click", {
			stampsOn: true,
			today: new Date(2026, 10, 20, 23, 59),
		});
		expect("edit" in r && r.edit.after).toBe("- [x] Task ✅ 2026-11-20");
	});

	it("reports the status char column, also behind a blockquote and a tab", () => {
		const r = planLineEdit(["\t> - [ ] Task"], 0, "click", ON);
		expect("edit" in r && r.edit.ch).toBe("\t> - [".length);
	});

	it("an astral status char is replaced whole", () => {
		const r = planLineEdit(["- [🙂] Task"], 0, "click", ON);
		expect("edit" in r && r.edit.from).toBe("🙂");
		expect("edit" in r && r.edit.after).toBe("- [ ] Task");
	});
});

describe("planLineEdit: lines that are not a task", () => {
	it.each([
		["a plain line", ["plain"], 0, "not-a-task"],
		["a list item without a checkbox", ["- item"], 0, "not-a-task"],
		["a blank line", [""], 0, "not-a-task"],
		["a line past the last line", ["- [ ] a"], 1, "out-of-range"],
		["a negative line", ["- [ ] a"], -1, "out-of-range"],
		["a fractional line", ["- [ ] a"], 0.5, "out-of-range"],
		["a task inside a backtick fence", ["```", "- [ ] a", "```"], 1, "excluded"],
		["a task inside a tilde fence", ["~~~", "- [ ] a", "~~~"], 1, "excluded"],
		["a task inside an unclosed fence", ["text", "```", "- [ ] a"], 2, "excluded"],
		["a task inside frontmatter", ["---", "- [ ] a", "---", "- [ ] b"], 1, "excluded"],
	] as Array<[string, string[], number, string]>)("%s is skipped", (_name, lines, line, reason) => {
		expect(planLineEdit(lines, line, "click", ON)).toEqual({ skipped: reason });
	});

	it("a task after a closed fence and after frontmatter is still edited", () => {
		const lines = ["---", "a: 1", "---", "```", "x", "```", "- [ ] real"];
		const r = planLineEdit(lines, 6, "click", ON);
		expect("edit" in r && r.edit.after).toBe("- [/] real");
	});

	it("a long press on [-] writes nothing", () => {
		expect(planLineEdit(["- [-] a ❌ 2026-11-08"], 0, "longPress", ON)).toEqual({
			skipped: "no-change",
		});
	});

	it("never changes the input lines", () => {
		const lines = ["- [ ] a", "- [x] b ✅ 2026-11-08"];
		const copy = [...lines];
		planLineEdit(lines, 0, "click", ON);
		planLineEdit(lines, 1, "click", ON);
		expect(lines).toEqual(copy);
	});
});

describe("editTextLine: endings and untouched lines", () => {
	it("keeps every ending of a CRLF note, including after the stamp and the block id", () => {
		const text = "# T\r\n- [/] Ship it ^id1\r\n- [ ] Other\r\n";
		const { text: out, result } = editTextLine(text, 1, "click", ON);
		expect("edit" in result).toBe(true);
		expect(out).toBe("# T\r\n- [x] Ship it ✅ 2026-11-20 ^id1\r\n- [ ] Other\r\n");
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("keeps each line's own ending in a mixed-ending note and the missing final newline", () => {
		const text = "- [ ] a\r\n- [ ] b\n- [ ] c\r\n- [ ] d";
		expect(editTextLine(text, 3, "click", ON).text).toBe("- [ ] a\r\n- [ ] b\n- [ ] c\r\n- [/] d");
		expect(editTextLine(text, 0, "click", ON).text).toBe("- [/] a\r\n- [ ] b\n- [ ] c\r\n- [ ] d");
		expect(editTextLine(text, 1, "click", ON).text).toBe("- [ ] a\r\n- [/] b\n- [ ] c\r\n- [ ] d");
	});

	it("the CRLF fixture: closing a line keeps every ending and the line count", () => {
		const crlf = fixtureFile("crlf-note.md");
		const lines = splitLines(crlf);
		const target = lines.findIndex((l) => l.text === "- [ ] Ship release ^rel1");
		expect(target).toBeGreaterThan(-1);
		const { text } = editTextLine(crlf, target, "click", ON);
		const after = splitLines(text);
		expect(after).toHaveLength(lines.length);
		expect(after.map((l) => l.eol)).toEqual(lines.map((l) => l.eol));
		expect(after[target].text).toBe("- [/] Ship release ^rel1");
	});

	it("returns the very same string when nothing applies", () => {
		const text = "plain\r\n- [-] c\r\n";
		expect(editTextLine(text, 0, "click", ON)).toEqual({ text, result: { skipped: "not-a-task" } });
		expect(editTextLine(text, 1, "longPress", ON).text).toBe(text);
	});
});

describe("F3: only the status char, the stamp and the one space before it change", () => {
	const kinds: PressKind[] = ["click", "longPress"];
	const options: Array<[string, LineEditOptions]> = [
		["stamps on", ON],
		["stamps off", OFF],
	];

	const demo = fixtureFile("lifecycle-demo.md").split("\n");
	const crlf = fixtureFile("crlf-note.md")
		.split("\r\n")
		.filter((l) => /\[.\]/.test(l));
	const fixtureLines = [...DEMO_TASK_LINES.map((i) => demo[i]), ...crlf, ...SHAPE_LINES];

	it("covers the fixture files and the shape cases", () => {
		expect(fixtureLines.length).toBeGreaterThanOrEqual(DEMO_TASK_LINES.length + SHAPE_LINES.length);
		for (const l of fixtureLines) expect(checkboxTokenRange(l)).not.toBeNull();
	});

	it.each(fixtureLines.flatMap((l) => kinds.flatMap((k) => options.map(([n, o]) => [l, k, n, o] as const))))(
		"%j, %s, %s: the remainders are identical",
		(line, kind, _name, opts) => {
			const r = planLineEdit([line], 0, kind, opts);
			if (!("edit" in r)) {
				expect(r).toEqual({ skipped: "no-change" });
				return;
			}
			expect(remainder(r.edit.after)).toBe(remainder(line));
		}
	);

	it.each(fixtureLines)("%j: every transition in the cycle, in order, keeps the remainder", (line) => {
		let current = line;
		const base = remainder(line);
		for (let i = 0; i < 6; i++) {
			const r = planLineEdit([current], 0, "click", ON);
			if (!("edit" in r)) throw new Error("click always changes a task");
			current = r.edit.after;
			expect(remainder(current)).toBe(base);
		}
	});

	it("every other line of a note is byte-identical", () => {
		const text = fixtureFile("lifecycle-demo.md");
		const before = splitLines(text);
		for (const i of DEMO_TASK_LINES) {
			for (const kind of kinds) {
				const after = splitLines(editTextLine(text, i, kind, ON).text);
				expect(after).toHaveLength(before.length);
				after.forEach((l, n) => {
					if (n !== i) expect(l).toEqual(before[n]);
				});
			}
		}
	});
});
