/* global app */
// Finding 4: how app.vault.process behaves on a note that is open in an
// editor. A: no unsaved typing. B: unsaved typing at the end of the file,
// then process before the autosave. C: unsaved typing on the SAME line the
// process edits. Records what the callback saw, the editor after, the
// plugin's status events, and the disk after the autosave. Needs the plugin
// enabled.
(async () => {
	const GOLDEN = "- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n";
	const wait = (t) => new Promise((r) => setTimeout(r, t));
	const out = {};
	const file = app.vault.getAbstractFileByPath("Course.md");
	const plugin = app.plugins.plugins["task-lifecycle"];
	const events = [];
	const off = plugin.events.on("task-lifecycle:status-changed", (p) =>
		events.push(p.line + ":" + JSON.stringify(p.from) + ">" + p.to)
	);
	const tick = (d) => d.replace("- [ ] Lesson 2", "- [x] Lesson 2");
	await app.vault.process(file, () => GOLDEN);
	await wait(500);
	const leaf = app.workspace.getLeaf("split");
	await leaf.openFile(file, { state: { mode: "source", source: false } });
	await wait(1500);
	const editor = leaf.view.editor;
	events.length = 0;

	// A: no unsaved typing.
	const returned = await app.vault.process(file, tick);
	await wait(400);
	out.A_returned = JSON.stringify(returned);
	out.A_editor_refreshed = editor.getValue();
	out.A_events = events.slice();
	await wait(2500);
	out.A_disk = await app.vault.read(file);
	events.length = 0;

	// B: unsaved typing at the end of the file.
	await app.vault.process(file, () => GOLDEN);
	await wait(800);
	events.length = 0;
	editor.replaceRange("TYPED\n", { line: 3, ch: 0 });
	let seen = null;
	await app.vault.process(file, (d) => {
		seen = d;
		return tick(d);
	});
	await wait(400);
	out.B_process_saw_typed = seen.includes("TYPED");
	out.B_editor_after = editor.getValue();
	out.B_events = events.slice();
	await wait(3000);
	out.B_editor_after_save = editor.getValue();
	out.B_disk = await app.vault.read(file);
	events.length = 0;

	// C: typing on the same line the process edits.
	await app.vault.process(file, () => GOLDEN);
	await wait(800);
	events.length = 0;
	editor.replaceRange(" EXTRA", { line: 0, ch: 24 });
	await app.vault.process(file, tick);
	await wait(400);
	out.C_editor_after = editor.getValue();
	out.C_events = events.slice();
	await wait(3000);
	out.C_disk = await app.vault.read(file);

	off();
	leaf.detach();
	await app.vault.process(file, () => GOLDEN);
	return JSON.stringify(out, null, 1);
})();
