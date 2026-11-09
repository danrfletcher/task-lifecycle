import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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

let main = "";

beforeAll(() => {
	// Build the shipped bundle the same way `npm run build` does.
	execFileSync(process.execPath, [join(root, "esbuild.config.mjs"), "production"], {
		cwd: root,
		stdio: "pipe",
	});
	main = readFileSync(join(root, "main.js"), "utf8");
}, 60_000);

describe("F9: no runtime style injection in the built main.js", () => {
	it("main.js was built and is not empty", () => {
		expect(existsSync(join(root, "main.js"))).toBe(true);
		expect(main.length).toBeGreaterThan(100);
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

	it("src/ never writes to document.head or calls addCommand", () => {
		for (const p of files(join(root, "src"))) {
			const text = readFileSync(p, "utf8");
			expect(text, relative(root, p)).not.toMatch(
				/document\.head|adoptedStyleSheets|createElement\(\s*["']style|addCommand/
			);
		}
	});
});
