/**
 * styles.css parsed into rules, for the tests that look at what the shipped
 * stylesheet selects. It has no at-rules or nesting, so a flat parse is enough.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

export const root = join(__dirname, "..", "..");
export const css = readFileSync(join(root, "styles.css"), "utf8");

export const SCOPE = "body.task-lifecycle-checkboxes";

export interface Rule {
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
export function parseRules(source: string): Rule[] {
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

export const rules = parseRules(css);
export const allSelectors = rules.flatMap((r) => r.selectors);

/** The selectors of the rules that draw the glyph or remove the native box, without pseudo-elements. */
export const iconRuleSelectors = rules
	.filter((r) => /content:\s*var\(--task-icon\)|appearance:\s*none/.test(r.body))
	.flatMap((r) => r.selectors)
	.map((s) => s.replace(/::(?:before|after)$/, ""));

/**
 * Whether a checkbox is one the plugin's icon rules reach right now.
 *
 * The scope (`body.task-lifecycle-checkboxes`) is checked on `document.body`
 * itself and only the rest of the selector is matched against the box:
 * happy-dom caches a result for a long selector with `:is()` and does not
 * invalidate it when an ancestor's class changes, which would make a flip of
 * the setting invisible. styles-css.test.ts separately asserts that every
 * selector starts with the scope.
 */
export function matchesIconRule(box: Element): boolean {
	if (!document.body.classList.contains(SCOPE.replace("body.", ""))) return false;
	return iconRuleSelectors.some((s) => {
		expect(s.startsWith(`${SCOPE} `), s).toBe(true);
		return box.matches(s.slice(SCOPE.length + 1));
	});
}
