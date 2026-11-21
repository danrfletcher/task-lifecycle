/* global app */
// Finding 1: what Obsidian itself writes when an embedded checkbox is
// clicked. Run with the task-lifecycle plugin DISABLED (run.sh disable),
// or the plugin's own write is measured instead. Course.md is reset to its
// golden-path text first and last.
(async () => {
	const GOLDEN = "- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n";
	const wait = (t) => new Promise((r) => setTimeout(r, t));
	const file = app.vault.getAbstractFileByPath("Course.md");
	const leaf = app.workspace.getLeaf();
	const contentEl = () => leaf.view.contentEl;
	const box = () => contentEl().querySelector(".internal-embed input.task-list-item-checkbox");
	const out = {};
	const click = async (key) => {
		box().click();
		await wait(1200);
		out[key] = await app.vault.read(file);
	};
	await app.vault.process(file, () => GOLDEN);
	await leaf.openFile(app.vault.getAbstractFileByPath("Learning Queue.md"), {
		state: { mode: "source", source: false },
	});
	await wait(2000);
	await click("lp_first");
	await click("lp_second");
	await app.vault.process(file, () => "- [/] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n");
	await wait(800);
	await click("lp_from_slash");
	await app.vault.process(file, () => GOLDEN);
	await leaf.setViewState({ type: "markdown", state: { file: "Learning Queue.md", mode: "preview" } });
	await wait(2500);
	out.mode = leaf.view.getMode();
	await click("rv_first");
	await click("rv_second");
	await app.vault.process(file, () => GOLDEN);
	return JSON.stringify(out, null, 1);
})();
