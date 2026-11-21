// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { SCOPE, allSelectors, css, matchesIconRule, rules } from "../helpers/css-rules";

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

/**
 * G7: the rendered box (embed in Live Preview, embed in Reading view, a note's
 * own Reading view). The shapes are the DOM Obsidian 1.15.1 draws for a task:
 * `li.task-list-item[data-task] > input` in a tight list and
 * `li > p > input` in a loose one, inside the surface's own ancestors.
 */
describe("styles.css: rendered boxes (embed and Reading view)", () => {
	type Shape = { name: string; ancestors: string[]; loose: boolean };
	const shapes: Shape[] = [
		{ name: "embed, tight list: li > input", ancestors: ["internal-embed markdown-embed", "markdown-preview-view"], loose: false },
		{ name: "embed, loose list: li > p > input", ancestors: ["internal-embed markdown-embed", "markdown-preview-view"], loose: true },
		{ name: "Live Preview embed under .markdown-source-view.mod-cm6", ancestors: ["markdown-source-view mod-cm6 is-live-preview", "internal-embed markdown-embed", "markdown-preview-view"], loose: false },
		{ name: "embed in Reading view (.markdown-reading-view ancestor)", ancestors: ["markdown-reading-view", "internal-embed markdown-embed", "markdown-preview-view"], loose: false },
		{ name: "own Reading view, tight", ancestors: ["markdown-reading-view", "markdown-preview-view"], loose: false },
		{ name: "own Reading view, loose", ancestors: ["markdown-reading-view", "markdown-preview-view"], loose: true },
	];

	function build(shape: Shape, status: string): HTMLInputElement {
		document.body.replaceChildren();
		let parent: HTMLElement = document.body;
		for (const cls of shape.ancestors) {
			const el = document.createElement("div");
			el.className = cls;
			parent.append(el);
			parent = el;
		}
		const ul = document.createElement("ul");
		const li = document.createElement("li");
		li.className = "task-list-item";
		li.setAttribute("data-task", status);
		const box = document.createElement("input");
		box.type = "checkbox";
		box.className = "task-list-item-checkbox";
		if (shape.loose) {
			const p = document.createElement("p");
			p.append(box);
			li.append(p);
		} else {
			li.append(box);
		}
		ul.append(li);
		parent.append(ul);
		return box;
	}

	afterEach(() => {
		document.body.className = "";
		document.body.replaceChildren();
	});

	const cases = shapes.flatMap((shape) => ["-", "/"].map((status) => [shape.name, shape, status] as const));
	it.each(cases)("%s: [%s] matches an icon rule once the body class is on", (_name, shape, status) => {
		document.body.className = "theme-dark task-lifecycle-checkboxes";
		const box = build(shape, status);
		expect(matchesIconRule(box)).toBe(true);
	});

	it.each(cases)("%s: [%s] matches no icon rule with the body class off (the theme's own look)", (_name, shape, status) => {
		document.body.className = "theme-dark";
		const box = build(shape, status);
		expect(matchesIconRule(box)).toBe(false);
	});

	const untouched = shapes.flatMap((shape) =>
		[" ", "x", "X", "?"].map((status) => [shape.name, shape, status] as const)
	);
	it.each(untouched)("%s: [%s] is never restyled (glyph or native-box rules)", (_name, shape, status) => {
		document.body.className = "theme-light task-lifecycle-checkboxes";
		const box = build(shape, status);
		expect(matchesIconRule(box)).toBe(false);
	});

	it("every glyph-rule selector still ends in ::before and names both [-] and [/]", () => {
		const draw = rules.filter((r) => /content:\s*var\(--task-icon\)/.test(r.body));
		expect(draw.length).toBeGreaterThan(0);
		for (const r of draw) {
			for (const s of r.selectors) {
				expect(s).toMatch(/::before$/);
				expect(s).toContain('[data-task="-"]');
				expect(s).toContain('[data-task="/"]');
			}
		}
	});

	it("the strike and bold rules reach the rendered item: [x] bold, [-] struck and dimmed, [/] not struck", () => {
		const item = (token: string) => `${SCOPE} .task-list-item.is-checked[data-task="${token}"]`;
		const bold = rules.find((r) => r.selectors.includes(item("x")) && /font-weight:\s*600/.test(r.body));
		const dim = rules.find((r) => r.selectors.includes(item("-")) && /line-through/.test(r.body));
		expect(bold).toBeDefined();
		expect(dim).toBeDefined();
		const noStrike = rules.find(
			(r) =>
				/text-decoration:\s*none\s*!important/.test(r.body) &&
				r.selectors.some((s) => s.includes(".task-list-item.is-checked:not("))
		);
		expect(noStrike).toBeDefined();
		// [/] and [ ] are never struck by the plugin's own rules.
		for (const token of ["/", " "]) {
			const struck = rules.filter((r) => r.selectors.some((s) => s.endsWith(`[data-task="${token}"]`)) && /line-through/.test(r.body));
			expect(struck).toEqual([]);
		}
	});

	it("a cancelled rendered item is dimmed by colour, not opacity, and its nested lists are cut off from strike and colour", () => {
		const item = `${SCOPE} .task-list-item.is-checked[data-task="-"]`;
		const own = rules.find((r) => r.selectors.includes(item));
		expect(own?.body).toMatch(/text-decoration:\s*line-through\s*!important/);
		expect(own?.body).toMatch(/color:\s*var\(--lines,\s*var\(--text-faint\)\)/);
		// Opacity multiplies into every descendant and cannot be undone by a child.
		expect(own?.body).not.toMatch(/opacity/);

		const nested = rules.find((r) => r.selectors.includes(`${item} > ul`));
		expect(nested?.selectors).toEqual([`${item} > ul`, `${item} > ol`]);
		// An inline-block is not struck through by its parent's line-through.
		expect(nested?.body).toMatch(/display:\s*inline-block/);
		expect(nested?.body).toMatch(/width:\s*100%/);
		expect(nested?.body).toMatch(/box-sizing:\s*border-box/);
		expect(nested?.body).toMatch(/color:\s*var\(--text-normal\)/);
		expect(nested?.body).not.toMatch(/opacity|line-through/);
		// It comes after the item's own rule, so its colour wins.
		expect(rules.indexOf(nested!)).toBeGreaterThan(rules.indexOf(own!));
	});

	it("the editor's cancelled line keeps the opacity dim (one line per task, no subtree)", () => {
		const line = rules.find((r) => r.selectors.includes(`${SCOPE} .HyperMD-task-line[data-task="-"]`));
		expect(line?.body).toMatch(/opacity:\s*0\.8/);
		expect(line?.body).toMatch(/line-through/);
	});

	it("subtasks of a done item are not made bold by it, and a done subtask is bold again", () => {
		const parent = `${SCOPE} .task-list-item.is-checked[data-task="x"]`;
		const reset = rules.find((r) => r.selectors.includes(`${parent} .task-list-item`));
		const rebold = rules.find((r) => r.selectors.includes(`${parent} .task-list-item.is-checked[data-task="x"]`));
		expect(reset?.body).toMatch(/font-weight:\s*var\(--font-normal,\s*400\)/);
		expect(rebold?.body).toMatch(/font-weight:\s*600/);
		// The reset comes after the bold rule and the re-bold after the reset.
		expect(rules.indexOf(reset!)).toBeGreaterThan(rules.findIndex((r) => r.selectors.includes(parent)));
		expect(rules.indexOf(rebold!)).toBeGreaterThan(rules.indexOf(reset!));
	});

	it("adds no rule outside the body class: nothing for a plain page", () => {
		document.body.className = "theme-dark";
		for (const shape of shapes) {
			const box = build(shape, "-");
			const li = box.closest("li")!;
			const outside = allSelectors.filter((s) => {
				try {
					return li.matches(s) || box.matches(s.replace(/::(?:before|after)$/, ""));
				} catch {
					return false;
				}
			});
			expect(outside, shape.name).toEqual([]);
		}
	});
});
