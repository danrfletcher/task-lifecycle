/* global app */
// Finding 2 (callout, blockquote, numbered, empty, table, fenced, rich text)
// and the rendered text for the content check (E17): per checkbox in
// Shapes Queue.md, the li and input data-line, the container kinds and the
// li's own text (subtasks, inputs and bullets removed). Ends with the
// metadataCache sections, blocks and list items of Shapes.md.
(async () => {
	const wait = (t) => new Promise((r) => setTimeout(r, t));
	const leaf = app.workspace.getLeaf();
	const res = {};
	for (const mode of ["lp", "rv"]) {
		await leaf.setViewState({
			type: "markdown",
			state: { file: "Shapes Queue.md", mode: mode === "lp" ? "source" : "preview", source: false },
		});
		await wait(3000);
		res[mode] = [...leaf.view.contentEl.querySelectorAll(".internal-embed")].map(
			(e) =>
				e.getAttribute("src") +
				" (" +
				e.className.replace("internal-embed ", "") +
				") " +
				[...e.querySelectorAll("input[type=checkbox]")]
					.map((cb) => {
						const li = cb.closest("li");
						const clone = li.cloneNode(true);
						clone.querySelectorAll("ul,ol,input,.list-bullet").forEach((n) => n.remove());
						return `[li.line=${li?.dataset.line} cb=${cb.dataset.line} tag=${cb.parentElement.tagName} bq=${!!cb.closest("blockquote")} callout=${!!cb.closest(".callout")} table=${!!cb.closest("table")} text=${JSON.stringify(clone.textContent)}]`;
					})
					.join(" ")
		);
	}
	const f = app.vault.getAbstractFileByPath("Shapes.md");
	const c = app.metadataCache.getFileCache(f);
	res.cache = JSON.stringify({
		sections: c.sections.map((s) => s.type + ":" + s.position.start.line + "-" + s.position.end.line),
		blocks: Object.entries(c.blocks).map(([k, b]) => k + ":" + b.position.start.line + "-" + b.position.end.line),
		li: c.listItems.map((x) => x.position.start.line + "-" + x.position.end.line + "[" + x.task + "]p" + x.parent),
	});
	return JSON.stringify(res, null, 1);
})();
