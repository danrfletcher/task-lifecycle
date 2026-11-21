/* global app */
// Finding 2: the metadataCache facts for Forms.md that the embed resolver
// reads: headings, sections, blocks and list items, each as startLine-endLine.
(() => {
	const f = app.vault.getAbstractFileByPath("Forms.md");
	const c = app.metadataCache.getFileCache(f);
	const p = (x) => x.position.start.line + "-" + x.position.end.line;
	return JSON.stringify(
		{
			headings: c.headings.map((h) => h.heading + "@" + h.level + ":" + p(h)),
			sections: c.sections.map((s) => s.type + ":" + p(s) + (s.id ? "#" + s.id : "")),
			blocks: Object.entries(c.blocks).map(([k, b]) => k + ":" + p(b)),
			listItems: c.listItems.map(
				(l) => l.position.start.line + (l.task ? "[" + l.task + "]" : "") + " parent=" + l.parent + (l.id ? "#" + l.id : "")
			),
			link: app.metadataCache.getFirstLinkpathDest("Forms", "Learning Queue.md")?.path,
		},
		null,
		1
	);
})();
