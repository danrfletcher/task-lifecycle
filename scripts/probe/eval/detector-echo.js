/* global app */
// Finding 3: does a write to an OPEN source note reach the plugin's change
// detector exactly once, and give one stamp? Needs the plugin enabled. Three
// writes on Course.md open in a split Live Preview editor: Editor.transaction,
// Editor.replaceRange and a raw CodeMirror dispatch. Counts the plugin's
// "task-lifecycle:status-changed" events for each.
(async () => {
	const GOLDEN = "- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n";
	const wait = (t) => new Promise((r) => setTimeout(r, t));
	const out = {};
	const file = app.vault.getAbstractFileByPath("Course.md");
	const plugin = app.plugins.plugins["task-lifecycle"];
	const events = [];
	const off = plugin.events.on("task-lifecycle:status-changed", (p) =>
		events.push(p.line + ":" + p.from + ">" + p.to)
	);
	const reset = async () => {
		await app.vault.process(file, () => GOLDEN);
		await wait(500);
		events.length = 0;
	};
	await reset();
	const leaf = app.workspace.getLeaf("split");
	await leaf.openFile(file, { state: { mode: "source", source: false } });
	await wait(1500);
	const editor = leaf.view.editor;
	out.open_doc = editor.getValue() === GOLDEN;
	const stamps = () => (editor.getValue().match(/\u2705/g) || []).length;

	// 1. Editor.transaction: what a closed-embed write to an open source uses.
	editor.transaction({ changes: [{ from: { line: 0, ch: 3 }, to: { line: 0, ch: 4 }, text: "x" }] });
	await wait(300);
	out.tx_editor_text = editor.getValue();
	out.tx_events = events.slice();
	out.tx_stamp_count = stamps();
	await wait(2500);
	out.tx_disk = await app.vault.read(file);
	await reset();
	editor.setValue(GOLDEN);
	await wait(300);
	events.length = 0;

	// 2. Editor.replaceRange.
	editor.replaceRange("x", { line: 0, ch: 3 }, { line: 0, ch: 4 });
	await wait(300);
	out.rr_text = editor.getValue();
	out.rr_events = events.slice();
	out.rr_stamp_count = stamps();
	await wait(2500);
	out.rr_disk = await app.vault.read(file);
	events.length = 0;

	// 3. Raw CodeMirror dispatch.
	await app.vault.process(file, () => GOLDEN);
	await wait(1000);
	editor.setValue(GOLDEN);
	await wait(300);
	events.length = 0;
	editor.cm.dispatch({ changes: { from: 3, to: 4, insert: "x" } });
	await wait(300);
	out.cm_text = editor.getValue();
	out.cm_events = events.slice();

	off();
	leaf.detach();
	await reset();
	return JSON.stringify(out, null, 1);
})();
