/**
 * Hit testing for the checkbox press handler (pure: no `obsidian` import,
 * no DOM globals; elements are described by the few fields read here).
 *
 * Two questions are answered here:
 *  - Is a character position on the "[c]" token of a task line? That uses
 *    the line classifier, so blockquote and callout prefixes (`> - [ ]`,
 *    `> > 1) [ ]`) and every list marker count.
 *  - Is the pointer or click target something the press handler must leave
 *    alone (fold chevrons, bullets, list padding), and is it the Live
 *    Preview checkbox widget or its label?
 */
import { checkboxTokenRange } from "../domain/line-classifier";

/** The slice of an `Element` this module reads. */
export interface PathElement {
	tagName?: string;
	classList?: { contains(name: string): boolean };
	type?: string;
}

/** Classes whose presence anywhere in the event path means "not ours". */
export const NON_CHECKBOX_CLASSES: readonly string[] = Object.freeze([
	"cm-fold-indicator",
	"collapse-indicator",
	"collapse-icon",
	"cm-foldPlaceholder",
	"HyperMD-list-bullet",
	"list-bullet",
]);

/**
 * True if `ch` is on the checkbox token of `lineText`, brackets included.
 * The upper bound is exclusive: the position right after "]" is not on it,
 * so a click on the text after the checkbox only places the cursor.
 */
export function isPosOnCheckboxToken(lineText: string, ch: number): boolean {
	const range = checkboxTokenRange(lineText);
	if (!range) return false;
	return ch >= range.fromCh && ch < range.toCh;
}

function hasClass(el: PathElement, name: string): boolean {
	return el.classList?.contains(name) === true;
}

/**
 * True if the event path holds a fold chevron, a list bullet or a fold
 * placeholder, or if the event target is an `LI` itself (its padding area).
 * `path[0]` is the event target; an `LI` further up is just the container
 * of the checkbox and does not count.
 */
export function isNonCheckboxTarget(path: readonly PathElement[]): boolean {
	if (path.length > 0 && path[0].tagName === "LI") return true;
	return path.some((el) => NON_CHECKBOX_CLASSES.some((name) => hasClass(el, name)));
}

/** True if the path is inside a Live Preview editor (not Source mode, not Reading view). */
export function isInLivePreview(path: readonly PathElement[]): boolean {
	return path.some((el) => hasClass(el, "is-live-preview"));
}

/** True if the path is inside an embed (`![[...]]` drawn by Obsidian). */
export function isInsideEmbed(path: readonly PathElement[]): boolean {
	return path.some((el) => hasClass(el, "internal-embed") || hasClass(el, "markdown-embed"));
}

export interface WidgetHit {
	/** The path holds the Live Preview `input.task-list-item-checkbox` widget. */
	hitsCheckbox: boolean;
	/** The path holds a `label` or `.task-list-label`. */
	hitsLabel: boolean;
}

/** Does the path hit the checkbox widget or its label? */
export function pathHitsWidget(path: readonly PathElement[]): WidgetHit {
	let hitsCheckbox = false;
	let hitsLabel = false;
	for (const el of path) {
		if (el.tagName === "LABEL" || hasClass(el, "task-list-label")) hitsLabel = true;
		if (el.tagName === "INPUT" && hasClass(el, "task-list-item-checkbox")) {
			hitsCheckbox = true;
		}
	}
	return { hitsCheckbox, hitsLabel };
}

/**
 * Decide whether a pointer or click event is a press on a checkbox.
 *
 *  - Source mode, Reading view and anything outside the editor: no.
 *  - A chevron, bullet, fold placeholder or `LI` padding in the path: no.
 *  - The checkbox widget itself: yes, whatever position the editor reports
 *    for the click (the widget stands in for the "[ ]" text).
 *  - Its label: only if the reported position is on the "[c]" token.
 *  - Anything else (the text after "]", other lines): no.
 *
 * `lineText` and `ch` are the line and the column the editor maps the
 * pointer to.
 */
export function isCheckboxPress(
	path: readonly PathElement[],
	lineText: string,
	ch: number
): boolean {
	if (!isInLivePreview(path)) return false;
	if (isNonCheckboxTarget(path)) return false;
	const { hitsCheckbox, hitsLabel } = pathHitsWidget(path);
	if (!hitsCheckbox && !hitsLabel) return false;
	if (checkboxTokenRange(lineText) === null) return false;
	return hitsCheckbox || isPosOnCheckboxToken(lineText, ch);
}
