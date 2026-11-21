/* global app */
// Findings 2 and 3 (docs/probe-rendered-tasks.md): for every checkbox in an
// embed, the embed's src, its depth, the rendered section it sits in, and
// data-line on the li and on the input. Runs on Learning Queue.md and
// Outer.md in Live Preview (lp) and Reading view (rv).
(async () => {
	const wait = (t) => new Promise((r) => setTimeout(r, t));
	const leaf = app.workspace.getLeaf();
	const res = {};
	const dump = (c) =>
		[...c.querySelectorAll("input.task-list-item-checkbox")].map((cb) => {
			const emb = cb.closest(".internal-embed");
			const sizer = cb.closest(".markdown-preview-sizer");
			const secs = sizer ? [...sizer.children].filter((d) => /(^| )el-/.test(d.className)) : [];
			const sec = cb.closest("div[class*=el-]");
			const depth = (() => {
				let n = 0;
				let e = cb;
				while ((e = e.parentElement?.closest(".internal-embed"))) n++;
				return n;
			})();
			return `${emb ? emb.getAttribute("src") : "-"} d${depth} sec#${secs.indexOf(sec)}/${secs.length}(${sec && sec.className}) li.line=${cb.closest("li").dataset.line} cb.line=${cb.dataset.line} :: ${cb.closest("li").childNodes[1]?.textContent.trim() || cb.parentElement.textContent.trim().slice(0, 30)}`;
		});
	for (const [name, mode] of [
		["Learning Queue.md", "lp"],
		["Learning Queue.md", "rv"],
		["Outer.md", "lp"],
		["Outer.md", "rv"],
	]) {
		await leaf.setViewState({
			type: "markdown",
			state: { file: name, mode: mode === "lp" ? "source" : "preview", source: false },
		});
		await wait(2500);
		res[name + " " + mode] = dump(leaf.view.contentEl);
	}
	return JSON.stringify(res, null, 1);
})();
