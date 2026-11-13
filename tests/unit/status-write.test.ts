import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Editor } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { targetStatus, writeStatus } from "../../src/status-cycle/status-write";

/** An in-memory editor: `getLine`, `lineCount`, `replaceRange`. */
function fakeEditor(lines: string[]) {
	const replaceRange = vi.fn(
		(text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
			expect(from.line).toBe(to.line);
			const l = lines[from.line];
			lines[from.line] = l.slice(0, from.ch) + text + l.slice(to.ch);
		}
	);
	const editor = {
		getLine: (n: number) => lines[n],
		lineCount: () => lines.length,
		replaceRange,
	} as unknown as Editor;
	return { editor, lines, replaceRange };
}

// [from char, click target, long-press target]
const table: Array<[string, string, string]> = [
	[" ", "/", "-"],
	["/", "x", "-"],
	["x", "-", "-"],
	["X", "-", "-"], // X counts as x
	["-", " ", "-"],
	["?", " ", "-"], // unknown goes to " " (E3)
];

describe("targetStatus", () => {
	it.each(table)("from %j: click -> %j, long press -> %j", (from, click, long) => {
		expect(targetStatus(from, "click")).toBe(click);
		expect(targetStatus(from, "longPress")).toBe(long);
	});
});

describe("writeStatus: click", () => {
	it.each(table)("[%s] -> written line and pair", (from, to) => {
		const { editor, lines, replaceRange } = fakeEditor([`- [${from}] Ship release ^rel1`]);
		const res = writeStatus(editor, 0, "click");
		expect(res).toEqual({ from, to, didChange: true });
		expect(lines[0]).toBe(`- [${to}] Ship release ^rel1`);
		expect(replaceRange).toHaveBeenCalledTimes(1);
	});

	it("the write is one replaceRange of exactly the status char", () => {
		const { editor, lines, replaceRange } = fakeEditor(["\t- [ ] Ship release ^rel1"]);
		const before = lines[0].length;
		writeStatus(editor, 0, "click");
		expect(replaceRange).toHaveBeenCalledTimes(1);
		expect(replaceRange).toHaveBeenCalledWith("/", { line: 0, ch: 4 }, { line: 0, ch: 5 });
		expect(lines[0].length).toBe(before);
	});

	it("runs a full cycle back to where it started", () => {
		const { editor, lines } = fakeEditor(["- [ ] a"]);
		const seen = [];
		for (let i = 0; i < 5; i++) {
			writeStatus(editor, 0, "click");
			seen.push(lines[0]);
		}
		expect(seen).toEqual(["- [/] a", "- [x] a", "- [-] a", "- [ ] a", "- [/] a"]);
	});

	it("[X] goes to [-]", () => {
		const { editor, lines } = fakeEditor(["- [X] a"]);
		expect(writeStatus(editor, 0, "click")).toEqual({ from: "X", to: "-", didChange: true });
		expect(lines[0]).toBe("- [-] a");
	});

	it("E3: [?] goes to [ ] with the pair {from: '?', to: ' '}", () => {
		const { editor, lines } = fakeEditor(["- [?] Ask"]);
		expect(writeStatus(editor, 0, "click")).toEqual({ from: "?", to: " ", didChange: true });
		expect(lines[0]).toBe("- [ ] Ask");
	});

	it.each([
		["1. [ ] a", 4],
		["1) [ ] a", 4],
		["* [ ] a", 3],
		["+ [ ] a", 3],
		["> - [ ] a", 5],
		["> > 1) [ ] a", 8],
		["  \t- [ ] a", 6],
	])("targets the right column on %j", (line, ch) => {
		const { editor, replaceRange } = fakeEditor([line]);
		writeStatus(editor, 0, "click");
		expect(replaceRange).toHaveBeenCalledWith("/", { line: 0, ch }, { line: 0, ch: ch + 1 });
	});

	it("only touches the pressed line", () => {
		const { editor, lines } = fakeEditor(["- [ ] a", "- [ ] b", "- [ ] c"]);
		writeStatus(editor, 1, "click");
		expect(lines).toEqual(["- [ ] a", "- [/] b", "- [ ] c"]);
	});
});

describe("writeStatus: long press", () => {
	it.each(table)("[%s] -> [-]", (from, _click, long) => {
		const { editor, lines } = fakeEditor([`- [${from}] Book venue`]);
		const res = writeStatus(editor, 0, "longPress");
		if (from === "-") {
			expect(res).toEqual({ from: "-", to: "-", didChange: false });
		} else {
			expect(res).toEqual({ from, to: long, didChange: true });
		}
		expect(lines[0]).toBe(`- [-] Book venue`);
	});

	it("[-] long press makes no write", () => {
		const { editor, replaceRange } = fakeEditor(["- [-] Book venue ❌ 2026-11-09"]);
		const res = writeStatus(editor, 0, "longPress");
		expect(res.didChange).toBe(false);
		expect(replaceRange).not.toHaveBeenCalled();
	});

	it("from x the pair is {x, -}: the shape the cascade rule excludes", () => {
		const { editor } = fakeEditor(["- [x] Ship release ✅ 2026-11-09"]);
		const res = writeStatus(editor, 0, "longPress");
		expect({ from: res.from, to: res.to }).toEqual({ from: "x", to: "-" });
	});
});

describe("writeStatus: not a task", () => {
	it.each(["plain text", "- no box", "- [ ]x", "- [ab] a", "-[ ] a", ""])(
		"%j: no write",
		(line) => {
			const { editor, replaceRange } = fakeEditor([line]);
			for (const kind of ["click", "longPress"] as const) {
				expect(writeStatus(editor, 0, kind)).toEqual({
					from: null,
					to: null,
					didChange: false,
				});
			}
			expect(replaceRange).not.toHaveBeenCalled();
		}
	);
});

describe("scroll position", () => {
	it("is put back after the write (scroll-preserver)", () => {
		vi.useFakeTimers();
		try {
			const lines = ["- [ ] a"];
			const scrollDOM = { scrollTop: 420, scrollLeft: 0 };
			const editor = {
				getLine: (n: number) => lines[n],
				lineCount: () => lines.length,
				replaceRange: (text: string, from: { ch: number }, to: { ch: number }) => {
					lines[0] = lines[0].slice(0, from.ch) + text + lines[0].slice(to.ch);
					scrollDOM.scrollTop = 0; // the jump the write would cause
				},
				cm: {
					scrollDOM,
					viewport: { from: 0, to: 7 },
					state: { doc: { lines: 1, lineAt: () => ({ number: 1, from: 0, to: 7 }), line: () => ({ number: 1, from: 0, to: 7 }) } },
					lineBlockAt: () => ({ top: 420 }),
				},
			} as unknown as Editor;
			writeStatus(editor, 0, "click");
			expect(lines[0]).toBe("- [/] a");
			vi.advanceTimersByTime(100);
			expect(scrollDOM.scrollTop).toBe(420);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("fence: the press modules never touch the cascade", () => {
	const dir = join(__dirname, "..", "..", "src", "status-cycle");
	const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

	it("has the press files", () => {
		expect(files).toEqual(
			expect.arrayContaining([
				"checkbox-hit-test.ts",
				"press-controller.ts",
				"status-write.ts",
				"wire-checkbox-press.ts",
			])
		);
	});

	it.each(files)("%s imports nothing from a cascade module", (file) => {
		const text = readFileSync(join(dir, file), "utf8");
		const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
		expect(imports.filter((p) => /cascade/i.test(p))).toEqual([]);
		// Code (not comments) never calls into cascade code either.
		const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		expect(code).not.toMatch(/cascade/i);
	});

	it("contains no command, hotkey, <style> or other-plugin event name", () => {
		for (const file of files) {
			const text = readFileSync(join(dir, file), "utf8");
			expect(text, file).not.toMatch(/addCommand|hotkeys/);
			expect(text, file).not.toMatch(/agile:|createElement\("style"\)/);
		}
	});
});
