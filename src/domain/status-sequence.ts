/**
 * Status sequence (pure).
 *
 * The cycle is fixed: " " -> "/" -> "x" -> "-" -> " ".
 * No function here takes a custom sequence.
 */
export type StatusChar = " " | "/" | "x" | "-";

export type StatusKind = "open" | "inProgress" | "done" | "cancelled";

export const STATUS_SEQUENCE: readonly StatusChar[] = Object.freeze([
	" ",
	"/",
	"x",
	"-",
] as StatusChar[]);

/**
 * The status a click moves a checkbox to.
 * "X" counts as "x". Any char outside the sequence (including "?", ">" and
 * the empty string) goes to " ".
 */
export function nextStatus(current: string): StatusChar {
	const norm = current === "X" ? "x" : current;
	const idx = STATUS_SEQUENCE.findIndex((c) => c === norm);
	if (idx < 0) return " ";
	return STATUS_SEQUENCE[(idx + 1) % STATUS_SEQUENCE.length];
}

/**
 * A press on a checkbox: a short click (cycle), a short click with "Status
 * cycle" off (`toggle`, the plain open/done flip a native checkbox makes) or
 * a long press (cancel).
 */
export type PressKind = "click" | "toggle" | "longPress";

/**
 * The plain toggle: an open task becomes done, any other status (in progress,
 * done, cancelled, unknown) becomes open. "X" counts as done.
 */
export function toggledStatus(current: string): StatusChar {
	return current === " " ? "x" : " ";
}

/**
 * The status a press moves `from` to. A long press always goes to "-"; a
 * toggle is the plain open/done flip; a click follows the cycle.
 */
export function targetStatus(from: string, kind: PressKind): string {
	if (kind === "longPress") return "-";
	return kind === "toggle" ? toggledStatus(from) : nextStatus(from);
}

/** Kind of a status char. Unknown chars count as open. */
export function statusKind(c: string): StatusKind {
	switch (c) {
		case "/":
			return "inProgress";
		case "x":
		case "X":
			return "done";
		case "-":
			return "cancelled";
		default:
			return "open";
	}
}

/** True only for "x", "X" and "-". */
export function isClosed(c: string): boolean {
	const kind = statusKind(c);
	return kind === "done" || kind === "cancelled";
}
