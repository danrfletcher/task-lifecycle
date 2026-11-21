// @vitest-environment happy-dom
/**
 * `renderedTextOf` against the source matcher: a task whose line holds a
 * footnote reference or inline math must still be placed, because neither
 * side keeps the part Obsidian draws from the whole note or as typeset glyphs.
 */
import { describe, expect, it } from "vitest";
import { matchRenderedTask } from "../../src/domain/rendered-match";
import { renderedTextOf } from "../../src/rendered/resolve-rendered-task";

/** An `li` as Obsidian draws it: the checkbox, then `html` for the text. */
function box(html: string): HTMLInputElement {
	const li = document.createElement("li");
	li.className = "task-list-item";
	const parsed = new DOMParser().parseFromString(
		`<input class="task-list-item-checkbox" type="checkbox">${html}`,
		"text/html"
	);
	li.append(...Array.from(parsed.body.childNodes));
	document.body.append(li);
	return li.querySelector("input") as HTMLInputElement;
}

const WHOLE = { from: 0, to: Number.POSITIVE_INFINITY };

describe("renderedTextOf with footnotes and math", () => {
	it("places a task with a footnote reference (drawn as a superscript number)", () => {
		const checkbox = box(
			' Call Sam<sup data-footnote-id="fnref-1-abc" class="footnote-ref"><a href="#fn-1-abc" class="footnote-link">1</a></sup> today'
		);
		const lines = ["- [ ] Call Sam[^1] today ^t1", "- [ ] Call Sam 1 today"];
		expect(matchRenderedTask(lines, renderedTextOf(checkbox), WHOLE)).toEqual({ line: 0 });
	});

	it("places a task with inline math (drawn as MathJax glyphs and hidden MathML)", () => {
		const checkbox = box(
			' Solve <span class="math math-inline is-loaded"><mjx-container class="MathJax" jax="CHTML"><mjx-math>x2+1</mjx-math><mjx-assistive-mml>x squared plus 1</mjx-assistive-mml></mjx-container></span> today'
		);
		const lines = ["- [ ] Solve $x^2 + 1$ today", "- [ ] Solve today now"];
		expect(matchRenderedTask(lines, renderedTextOf(checkbox), WHOLE)).toEqual({ line: 0 });
	});

	it("still places a task with neither, and leaves a plain superscript in other text alone", () => {
		const checkbox = box(" Plain <sup>2</sup> task");
		expect(renderedTextOf(checkbox).replace(/\s+/g, " ").trim()).toBe("Plain 2 task");
		expect(matchRenderedTask(["- [ ] Plain <sup>2</sup> task"], renderedTextOf(checkbox), WHOLE)).toEqual({
			line: 0,
		});
	});
});
