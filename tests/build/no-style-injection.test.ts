import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

function files(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...files(p));
		else out.push(p);
	}
	return out;
}

const rootMain = join(root, "main.js");
const rootMainBefore = existsSync(rootMain) ? readFileSync(rootMain, "utf8") : null;

let main = "";
let outDir = "";
let outfile = "";

beforeAll(() => {
	// Build the shipped bundle the way `npm run build` does, but into a
	// temporary file so the test never overwrites a dev/watch main.js.
	outDir = mkdtempSync(join(tmpdir(), "task-lifecycle-build-"));
	outfile = join(outDir, "main.js");
	execFileSync(process.execPath, [join(root, "esbuild.config.mjs"), "production", outfile], {
		cwd: root,
		stdio: "pipe",
	});
	main = readFileSync(outfile, "utf8");
}, 60_000);

afterAll(() => {
	if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("F9: no runtime style injection in the built main.js", () => {
	it("main.js was built and is not empty", () => {
		expect(existsSync(outfile)).toBe(true);
		expect(main.length).toBeGreaterThan(100);
	});

	it("building for the test leaves the worktree's own main.js alone", () => {
		const after = existsSync(rootMain) ? readFileSync(rootMain, "utf8") : null;
		expect(after).toBe(rootMainBefore);
	});

	const banned: Array<[string, RegExp]> = [
		["<style", /<style/i],
		["createElement(\"style\")", /createElement\(\s*["'`]style["'`]/],
		["createEl(\"style\")", /createEl\(\s*["'`]style["'`]/],
		["head.appendChild", /head\s*\.\s*appendChild/],
		["head.append", /head\s*\.\s*append\(/],
		["head.prepend", /head\s*\.\s*prepend\(/],
		["adoptedStyleSheets", /adoptedStyleSheets/],
		["insertRule", /insertRule/],
		["new CSSStyleSheet", /new\s+CSSStyleSheet/],
	];
	it.each(banned)("main.js has no %s", (_name, re) => {
		expect(main).not.toMatch(re);
	});

	it("main.js has no agile substring (F5)", () => {
		expect(main).not.toMatch(/agile/i);
	});

	it("main.js never calls addCommand (F3)", () => {
		expect(main).not.toMatch(/addCommand/);
	});

	it("main.js registers no ribbon icon and no hotkey (F2)", () => {
		expect(main).not.toMatch(/addRibbonIcon|hotkeys/);
	});

	it("main.js draws no icon by inline style (F7): no setCssProps, setCssStyles, cssText or style attribute", () => {
		expect(main).not.toMatch(/setCssProps|setCssStyles|cssText|setAttribute\(\s*["']style["']/);
	});
});

describe("F9: sources", () => {
	it("src/ imports no .css file", () => {
		const hits = files(join(root, "src"))
			.filter((p) => /\.(ts|mjs|js)$/.test(p))
			.filter((p) =>
				/(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["'][^"']*\.css["']/.test(
					readFileSync(p, "utf8")
				)
			)
			.map((p) => relative(root, p));
		expect(hits).toEqual([]);
	});

	it("src/ has no stray .css or css.d.ts file", () => {
		expect(files(join(root, "src")).filter((p) => /\.css$|css\.d\.ts$/.test(p))).toEqual([]);
	});

	it("esbuild.config.mjs has no .css loader", () => {
		const cfg = readFileSync(join(root, "esbuild.config.mjs"), "utf8");
		expect(cfg).not.toMatch(/loader/);
		expect(cfg).not.toMatch(/["']\.css["']/);
	});

	it("F2: src/ registers no command, ribbon icon or hotkey", () => {
		for (const p of files(join(root, "src"))) {
			expect(readFileSync(p, "utf8"), relative(root, p)).not.toMatch(/addCommand|addRibbonIcon|hotkeys/);
		}
	});

	it("F7: src/rendered and src/status-cycle only toggle classes: no inline style, setCssProps or cssText", () => {
		const dirs = ["rendered", "status-cycle"].flatMap((d) => files(join(root, "src", d)));
		expect(dirs.length).toBeGreaterThan(0);
		for (const p of dirs) {
			expect(readFileSync(p, "utf8"), relative(root, p)).not.toMatch(
				/\.style\b|setCssProps|setCssStyles|cssText|setAttribute\(\s*["']style["']/
			);
		}
	});

	it("src/ never writes to document.head or calls addCommand", () => {
		for (const p of files(join(root, "src"))) {
			const text = readFileSync(p, "utf8");
			expect(text, relative(root, p)).not.toMatch(
				/document\.head|adoptedStyleSheets|createElement\(\s*["']style|addCommand/
			);
		}
	});
});
