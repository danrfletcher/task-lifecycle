/* global app, document, PointerEvent, MouseEvent */
// Finding 5: what a click on an embedded checkbox does in Live Preview. Run
// it twice, with the plugin disabled and enabled (run.sh disable / enable).
// Records the plugin list, the DOM chain around the first embedded checkbox,
// the bytes of Course.md line 1 after a bare click() and after a full
// pointerdown/mousedown/pointerup/mouseup/click sequence, and whether the
// click had been default-prevented by the time it reached `document`.
(async () => {
	const GOLDEN = "- [ ] Lesson 2 content ^l2\n\t- [ ] Watch video\n\t- [ ] Take notes\n";
	const wait = (t) => new Promise((r) => setTimeout(r, t));
	const file = app.vault.getAbstractFileByPath("Course.md");
	const out = { plugins: [...app.plugins.enabledPlugins] };
	const leaf = app.workspace.getLeaf();
	await leaf.setViewState({
		type: "markdown",
		state: { file: "Learning Queue.md", mode: "source", source: false },
	});
	await wait(3000);
	const box = () => leaf.view.contentEl.querySelector(".internal-embed input.task-list-item-checkbox");
	out.cbs = leaf.view.contentEl.querySelectorAll("input.task-list-item-checkbox").length;
	out.inCmEmbedBlock = !!leaf.view.contentEl.querySelector(".cm-embed-block .internal-embed input.task-list-item-checkbox");
	const chain = [];
	for (let e = box(); e && chain.length < 14; e = e.parentElement) {
		chain.push(e.tagName + "." + String(e.className).split(" ").slice(0, 3).join("."));
	}
	out.chain = chain.join(" < ");

	let prevented = null;
	document.addEventListener("click", (e) => (prevented = e.defaultPrevented), { once: true });
	box().click();
	await wait(1200);
	out.single_click = (await app.vault.read(file)).split("\n")[0];
	out.checked = box().checked;
	out.prevented_at_bubble = prevented;
	await app.vault.process(file, () => GOLDEN);
	await wait(800);

	// The full pointer sequence a real press makes.
	const target = box();
	const r = target.getBoundingClientRect();
	const o = {
		bubbles: true,
		cancelable: true,
		clientX: r.x + r.width / 2,
		clientY: r.y + r.height / 2,
		pointerId: 1,
		button: 0,
		isPrimary: true,
	};
	target.dispatchEvent(new PointerEvent("pointerdown", o));
	target.dispatchEvent(new MouseEvent("mousedown", o));
	target.dispatchEvent(new PointerEvent("pointerup", o));
	target.dispatchEvent(new MouseEvent("mouseup", o));
	target.dispatchEvent(new MouseEvent("click", o));
	await wait(1200);
	out.pointer_seq = (await app.vault.read(file)).split("\n")[0];
	await app.vault.process(file, () => GOLDEN);
	return JSON.stringify(out, null, 1);
})();
