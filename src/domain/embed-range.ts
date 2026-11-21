/**
 * Embed targets and the source range they show (pure, no `obsidian` import).
 *
 * The inputs are plain slices of Obsidian's `CachedMetadata` (`headings`,
 * `blocks`, `listItems`) and the `src` attribute of an embed
 * (`Note`, `Note#Heading`, `Note#H1#H2`, `Note#^blockid`, any of them with a
 * `|300` size or alias).
 */

export interface CachePosition {
	start: { line: number };
	end: { line: number };
}

export interface CacheHeading {
	heading: string;
	level: number;
	position: CachePosition;
}

export interface CacheBlock {
	position: CachePosition;
}

export interface CacheListItem {
	position: CachePosition;
	/** Line of the parent item; negative for a top-level item. */
	parent: number;
}

/** The parts of a file's metadata cache this module reads. */
export interface CacheSlice {
	headings?: readonly CacheHeading[];
	blocks?: Readonly<Record<string, CacheBlock>>;
	listItems?: readonly CacheListItem[];
}

export type EmbedTarget =
	| { kind: "note"; linkpath: string }
	| { kind: "heading"; linkpath: string; path: string[] }
	| { kind: "block"; linkpath: string; id: string };

/** Source lines an embed shows, and the start of its one rendered section if exactly one. */
export interface EmbedRange {
	/** First line, 0-based, inclusive. */
	from: number;
	/** Last line, inclusive. `Infinity` means the end of the note. */
	to: number;
	/**
	 * Source line the rendered section starts on, set only when the embed is
	 * one rendered section (a block embed). Null for heading and whole-note
	 * embeds, where the section a checkbox sits in is not known from the DOM.
	 */
	sectionStart: number | null;
}

/**
 * Parse an embed `src`. A `|size` or `|alias` tail is dropped. A block id
 * (`#^id`) wins over any headings before it. `#Heading` alone has an empty
 * `linkpath` (an embed of a heading in the host note).
 */
export function parseEmbedSrc(src: string): EmbedTarget {
	const bar = src.indexOf("|");
	const bare = bar >= 0 ? src.slice(0, bar) : src;
	const hash = bare.indexOf("#");
	if (hash < 0) return { kind: "note", linkpath: bare.trim() };

	const linkpath = bare.slice(0, hash).trim();
	const parts = bare
		.slice(hash + 1)
		.split("#")
		.map((p) => p.trim())
		.filter((p) => p !== "");
	const block = parts.find((p) => p.startsWith("^"));
	if (block !== undefined && block.length > 1) {
		return { kind: "block", linkpath, id: block.slice(1) };
	}
	if (parts.length === 0) return { kind: "note", linkpath };
	return { kind: "heading", linkpath, path: parts };
}

/** Heading text as Obsidian compares it in a link: no link punctuation, one space, lower case. */
function headingKey(text: string): string {
	return text
		.replace(/[[\]#|^:]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * The lines a heading embed shows: from the heading to the line before the
 * next heading of the same or a higher level. A path (`H1#H2`) finds each
 * name inside the section of the one before it. Null if a name is missing.
 */
function headingRange(
	headings: readonly CacheHeading[],
	path: readonly string[]
): { from: number; to: number } | null {
	let lo = 0;
	let hi = headings.length;
	let current: CacheHeading | null = null;
	for (let n = 0; n < path.length; n++) {
		const want = headingKey(path[n]);
		let found = -1;
		for (let i = lo; i < hi; i++) {
			const h = headings[i];
			if (headingKey(h.heading) !== want) continue;
			if (current !== null && h.level <= current.level) continue;
			found = i;
			break;
		}
		if (found < 0) return null;
		current = headings[found];
		let end = headings.length;
		for (let j = found + 1; j < headings.length; j++) {
			if (headings[j].level <= current.level) {
				end = j;
				break;
			}
		}
		lo = found + 1;
		hi = end;
		if (n === path.length - 1) {
			const to = end < headings.length ? headings[end].position.start.line - 1 : Number.POSITIVE_INFINITY;
			return { from: current.position.start.line, to };
		}
	}
	return null;
}

/**
 * The lines a block embed shows: the block itself, and for a list item the
 * item's whole subtree (the cache position covers only the item's own line,
 * the render includes its children).
 */
function blockRange(
	cache: CacheSlice,
	id: string
): { from: number; to: number } | null {
	const block = cache.blocks?.[id.toLowerCase()] ?? cache.blocks?.[id];
	if (!block) return null;
	const from = block.position.start.line;
	let to = block.position.end.line;

	const items = cache.listItems ?? [];
	const at = items.findIndex((li) => li.position.start.line === from);
	if (at >= 0) {
		const inTree = new Set<number>([from]);
		for (let i = at + 1; i < items.length; i++) {
			const li = items[i];
			if (!inTree.has(li.parent)) break;
			inTree.add(li.position.start.line);
			to = Math.max(to, li.position.end.line);
		}
		to = Math.max(to, items[at].position.end.line);
	}
	return { from, to };
}

/**
 * The source range an embed target shows, or null when the cache has no such
 * heading or block (the target does not exist, or the cache is stale).
 */
export function resolveEmbedRange(cache: CacheSlice, target: EmbedTarget): EmbedRange | null {
	switch (target.kind) {
		case "note":
			return { from: 0, to: Number.POSITIVE_INFINITY, sectionStart: null };
		case "heading": {
			const range = headingRange(cache.headings ?? [], target.path);
			return range ? { ...range, sectionStart: null } : null;
		}
		case "block": {
			const range = blockRange(cache, target.id);
			return range ? { ...range, sectionStart: range.from } : null;
		}
	}
}
