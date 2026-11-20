/**
 * Shared task-line fixtures for the source-line edit and source-writer tests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkboxTokenRange } from "../../src/domain/line-classifier";

export const TODAY = "2026-11-20";

export function fixtureFile(name: string): string {
	return readFileSync(join(__dirname, name), "utf8");
}

/** Task lines with every shape the classifier accepts. The status char of each is written literally. */
export const SHAPE_LINES: readonly string[] = [
	"- [ ] Lesson 2 content ^l2",
	"- [/] Lesson 2 content ^l2",
	"- [ ] id with hyphens and digits ^abc-123-x9",
	"\t- [ ] Tab indented ^t-1",
	"\t\t- [/] Two tabs ^t-2",
	"  - [ ] Two spaces",
	"    - [ ] Four spaces ^sp4",
	"> - [ ] Blockquote ^q1",
	"> > - [/] Nested blockquote ^q2",
	"* [ ] Star ^s",
	"+ [/] Plus ^p",
	"1. [ ] Numbered dot ^n1",
	"12) [/] Numbered paren ^n2",
	"- [x] Done with old stamp ✅ 2026-11-08 ^done-1",
	"- [-] Cancelled with old stamp ❌ 2026-11-08 ^c9",
	"- [X] Capital X ✅ 2026-11-08",
	"- [?] Unknown char ^u",
	"- [ ] No block id",
	"- [ ]",
];

/** Which lines of `tests/fixtures/lifecycle-demo.md` are tasks (0-based). */
export const DEMO_TASK_LINES = [0, 1, 3, 4, 5];

/**
 * The F3 rule: take out the status char, then every stamp together with the
 * one space before it. A press must leave a line's remainder as it was.
 */
export function remainder(line: string): string {
	const range = checkboxTokenRange(line);
	if (!range) throw new Error(`not a task line: ${line}`);
	const noChar = line.slice(0, range.fromCh + 1) + line.slice(range.toCh - 1);
	return noChar.replace(/ ?(?:✅|❌)\uFE0F? \d{4}-\d{2}-\d{2}/g, "");
}
