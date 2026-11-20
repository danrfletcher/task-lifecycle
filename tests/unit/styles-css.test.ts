import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const css = readFileSync(join(root, "styles.css"), "utf8");

const SCOPE = "body.task-lifecycle-checkboxes";

interface Rule {
	selectors: string[];
	body: string;
}

/** Split on commas that are not inside (...) or [...]. */
function splitSelectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < list.length; i++) {
		const c = list[i];
		if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth--;
		else if (c === "," && depth === 0) {
			out.push(list.slice(start, i));
			start = i + 1;
		}
	}
	out.push(list.slice(start));
	return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** styles.css has no at-rules or nesting, so a flat `selectors { body }` parse is enough. */
function parseRules(source: string): Rule[] {
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
	expect(stripped).not.toMatch(/@/);
	const rules: Rule[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(stripped))) {
		rules.push({ selectors: splitSelectors(m[1]), body: m[2] });
	}
	// Nothing left over outside the rules.
	expect(stripped.replace(re, "").trim()).toBe("");
	return rules;
}

const rules = parseRules(css);
const allSelectors = rules.flatMap((r) => r.selectors);

const rulesFor = (token: string) =>
	rules.filter((r) => r.selectors.some((s) => s.includes(`[data-task="${token}"]`)));

describe("styles.css", () => {
	it("parses into rules", () => {
		expect(rules.length).toBeGreaterThan(5);
	});

	it("scopes every selector under body.task-lifecycle-checkboxes", () => {
		const unscoped = allSelectors.filter(
			(s) => s !== SCOPE && !s.startsWith(`${SCOPE} `) && !s.startsWith(`${SCOPE}.`)
		);
		expect(unscoped).toEqual([]);
	});

	it("has an icon rule for - (❌), / (⛛) and X (✔️)", () => {
		const icon = (token: string) =>
			rules.find(
				(r) =>
					r.selectors.includes(`${SCOPE} [data-task="${token}"]`) &&
					/--task-icon:/.test(r.body)
			)?.body;
		expect(icon("-")).toContain('--task-icon: "❌"');
		expect(icon("/")).toContain('--task-icon: "⛛"');
		expect(icon("X")).toContain('--task-icon: "✔️"');
	});

	it("draws the glyph for [-] and [/] through ::before", () => {
		const draw = rules.find((r) => /content:\s*var\(--task-icon\)/.test(r.body));
		expect(draw).toBeDefined();
		for (const s of draw?.selectors ?? []) {
			expect(s).toMatch(/::before$/);
			expect(s).toContain('[data-task="-"]');
			expect(s).toContain('[data-task="/"]');
		}
	});

	it("has the [x] bold rule", () => {
		const bold = rules.find(
			(r) =>
				r.selectors.some((s) => s.includes('[data-task="x"]')) &&
				/font-weight:\s*600/.test(r.body)
		);
		expect(bold).toBeDefined();
	});

	it("has the [-] strike-and-dim rule", () => {
		const dim = rules.find(
			(r) =>
				r.selectors.some((s) => s.endsWith('[data-task="-"]')) &&
				/line-through/.test(r.body) &&
				/opacity:\s*0\.8/.test(r.body)
		);
		expect(dim).toBeDefined();
	});

	it("has the no-strike rule so [/] is not struck through", () => {
		const noStrike = rules.find(
			(r) =>
				/text-decoration:\s*none\s*!important/.test(r.body) &&
				r.selectors.every((s) => s.includes(":not([data-task=\"x\"])"))
		);
		expect(noStrike).toBeDefined();
		expect(rulesFor("/").length).toBeGreaterThan(0);
	});

	it("only mentions data-task values in { ' ', '', x, X, -, / }", () => {
		const allowed = new Set([" ", "", "x", "X", "-", "/"]);
		const values = [...css.matchAll(/data-task\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
		expect(values.length).toBeGreaterThan(0);
		expect(values.filter((v) => !allowed.has(v))).toEqual([]);
		expect(css).not.toMatch(/data-task\s*=\s*[^"\s\]]/); // no unquoted values
		expect(css).not.toMatch(/data-task\s*[~|^$*]=/); // no pattern matchers
	});

	it("defines --col-d for both theme-dark and theme-light", () => {
		for (const theme of ["theme-dark", "theme-light"]) {
			const rule = rules.find(
				(r) =>
					r.selectors.includes(`${SCOPE}.${theme}`) && /--col-d:\s*#[0-9a-f]{6}/i.test(r.body)
			);
			expect(rule, theme).toBeDefined();
		}
	});

	it("carries no other palette colours or token rules from the source", () => {
		expect(css).not.toMatch(/--col-(?!d\b)/);
	});

	it("has no agile substring (F5)", () => {
		expect(css).not.toMatch(/agile/i);
	});

	it("has no @import, url() or external font (F9 / static only)", () => {
		expect(css).not.toMatch(/@import|url\(|@font-face/);
	});

	it("does not use the old data attribute gate", () => {
		expect(css).not.toMatch(/\[data-[a-z-]*styles/);
	});

	it("turns off the touch callout and text selection on a rendered checkbox (G2), scoped like the other rules", () => {
		const rule = rules.find((r) => /-webkit-touch-callout:\s*none/.test(r.body));
		expect(rule).toBeDefined();
		expect(rule?.body).toMatch(/(?:^|[\s;])user-select:\s*none/);
		expect(rule?.body).toMatch(/-webkit-user-select:\s*none/);
		// The checkbox of an embed and of a preview (Reading) view, nothing wider.
		expect(rule?.selectors).toEqual([
			`${SCOPE} .internal-embed input.task-list-item-checkbox`,
			`${SCOPE} .markdown-embed input.task-list-item-checkbox`,
			`${SCOPE} .markdown-preview-view input.task-list-item-checkbox`,
		]);
	});
});
