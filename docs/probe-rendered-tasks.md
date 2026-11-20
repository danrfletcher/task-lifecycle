# Probe: how Obsidian renders and ticks tasks outside the live editor

Run on 2026-11-20 with the real `obsidian` CLI (`eval`, `plugin:enable`, `plugin:disable`) against Obsidian 1.15.1 (installer 1.14.4) on macOS. The CLI drove a throwaway Obsidian instance with its own home folder and user-data directory, so Dan's own vault and window were never touched. The vault held `Course.md` (the golden path below) plus a few extra notes for the other embed forms. Plugin code under test is this branch's 0.1.0 build.

```
- [ ] Lesson 2 content ^l2
	- [ ] Watch video
	- [ ] Take notes
```

`Learning Queue.md` held `![[Course#^l2]]`, `![[Course#^l2|300]]`, `![[Forms#Sub]]`, `![[Forms#Top#Sub]]`, `![[Course]]`, `![[Forms#^li]]` and `![[Forms#^child]]`. `Outer.md` embeds `Inner.md`, which embeds `![[Course#^l2]]`. `Shapes.md` held a callout task, a blockquote task, `1.` and `2)` tasks, an empty task, a task inside a table cell, a task inside a fenced block and a task with bold, a wikilink alias, inline code and an inline field.

A click was simulated with `input.click()` on the rendered checkbox. It landed (the seed ticket recorded that a synthetic click did not, but that was with the plugin enabled, see finding 5).

## Verdict

All four questions match the plan. No later PR is blocked. Two extra observations (5 and 6) do not contradict the plan but change what PR-3 has to replace.

## 1. Native embed tick: matches the plan

Task Lifecycle disabled, `Course.md` closed, `Learning Queue.md` open.

| View | Click | Bytes of `Course.md` line 1 afterwards |
|---|---|---|
| Live Preview | 1st | `- [x] Lesson 2 content ^l2` |
| Live Preview | 2nd | `- [ ] Lesson 2 content ^l2` |
| Live Preview, line was `[/]` | 1st | `- [ ] Lesson 2 content ^l2` |
| Reading view | 1st | `- [x] Lesson 2 content ^l2` |
| Reading view | 2nd | `- [ ] Lesson 2 content ^l2` |

Obsidian writes a bare `[x]` (open to done, any other char back to open). It adds no stamp. Nothing else in the file changes, and the other lines and the trailing newline are byte-identical. This is what the plan assumed.

## 2. `data-line`: matches the plan, with the rule spelled out

Findings, the same in Live Preview and Reading view and in the note's own Reading view:

- `data-line` is set on the `li` and on its `input.task-list-item-checkbox` and has the same value on both.
- The base is 0.
- It is relative to the rendered section, never to the file. A section is one `div.el-*` child of `.markdown-preview-sizer` (`el-ul`, `el-h2`, `el-p`, ...). Each list section restarts at 0.
- It counts source lines inside the section, so a nested task has the offset of its own line (`^l2` embed: parent 0, children 1 and 2).

Per embed form (the rendered sections are the `div.el-*` children, `cache` is `metadataCache` for the source):

| Form | Rendered sections | `data-line` of the checkboxes | Section start |
|---|---|---|---|
| `![[Course#^l2]]` (list item block) | 1 `el-ul` | 0, 1, 2 | the block's `position.start.line` (0). The block position covers the item line only, the render covers the item's whole subtree |
| `![[Course#^l2\|300]]` | same | same | same. The size is a `width` attribute, `src` stays `Course#^l2` |
| `![[Forms#^li]]` | 1 `el-ul` | 0, 1, 2 | block start (line 4) |
| `![[Forms#^child]]` (nested child) | 1 `el-ul` | 0 | block start (line 5) |
| callout block `![[Shapes#^cal]]` | 1 section | 1, 2 | block start is the `> [!note]` line (2), so the first task (line 3) is offset 1 |
| blockquote block | 1 section | 0 | block start |
| `![[Forms#Sub]]` (heading) | `el-h2`, `el-ul`, `el-h3`, `el-ul` | 0, 1, 2 then 0 | one section per cache section inside the heading range; the heading renders down to the next heading of the same or higher level, so the deeper `### Deep` is included |
| `![[Forms#Top#Sub]]` (nested heading) | same as above | same | same |
| `![[Course]]` (whole note) | 1 `el-ul` | 0, 1, 2 | the section's cache start |
| Own Reading view | one `el-*` per section | restarts at 0 in each list section | the section's cache start |

The block lookup in `metadataCache.getFileCache(file).blocks` is keyed by the lower-case id. In the heading embed the rendered `div.el-*` sections matched the cache `sections` inside the range one to one (4 and 4). Reading view may render sections lazily, so a section index is not relied on.

Decision recorded for the resolver: the section start is taken only for block embeds, where the block is exactly one rendered section. For heading, whole-note and own Reading view the resolver places a task by content only, and two identical lines give `unmappable` (golden path GP8 asks for exactly that). Using data-line there would resolve GP8's duplicate lines, against the product decision.

Rendered text, for the content check (E17): Obsidian removes the `^id` and the checkbox, renders links as their alias text, strips bold and inline-code markers, and leaves inline fields as raw text. Example: source `- [ ] **bold** and [[Course|alias]] and \`code\` [due:: 2026-11-30] ^rich` renders `bold and alias and code [due:: 2026-11-30]`. An empty task renders whitespace only. A task inside a table cell renders no checkbox at all. A task in a fenced block renders as `<code>`, never a checkbox.

DOM facts the resolver relies on:

- The embed element is `div.internal-embed.markdown-embed` with `src="Note#Heading"` or `src="Note#^id"`, with any `|300` already split into a `width` attribute.
- An embed inside an embed is a nested `.internal-embed`. In `Outer.md` the checkbox sits at embed depth 2 and `closest(".internal-embed")` is the inner `Course#^l2` one, so the innermost `src` wins (E9).
- Missing or non-markdown embeds (`![[nonexistent]]`, `![[image.png]]`) carry class `file-embed` and have no checkbox.
- In Live Preview 1.15.1 the embed is a direct child of `.cm-content` and is not inside a `.cm-embed-block`. The `.cm-embed-block` check in the existing 0.1.0 code does not hold for embeds here (finding 5).

## 3. Detector echo: matches the plan

Course.md open in a Live Preview editor (a split pane), plugin enabled, an `events.on("task-lifecycle:status-changed")` listener counting events.

| Write | Status events | Result in editor and on disk |
|---|---|---|
| `editor.transaction({ changes })` setting `[ ]` to `[x]` | 1 | `- [x] Lesson 2 content ✅ 2026-11-20 ^l2` (one stamp, before `^l2`) |
| `editor.replaceRange("x", ...)` | 1 | same |
| raw CodeMirror `cm.dispatch(...)` | 1 | same |

An editor transaction on an open source reaches `change-detector.ts` once. The fallback (self-write annotation plus the 1.5 s dedupe) is not needed for this path, and stays in place for the cascade write.

## 4. `vault.process` with the same file open: matches the plan

Course.md open in an editor, plugin enabled.

- Editor refresh: yes. The open editor shows the new text within 400 ms, with no manual reload.
- Detector: no status event and no stamp. The write arrives as a `set` change, which the detector ignores by design. A `vault.process` write to an open source must therefore carry its own stamp.
- Unsaved typing: it survives. With `TYPED\n` typed at the end and not yet saved, a `vault.process` that changed line 1 left the editor and, after autosave, the file holding both changes. The callback was given the on-disk text (without `TYPED`). A second case typed 6 characters at column 24 of line 1, which is inside `^l2`, while `vault.process` rewrote that same line. The typed text was kept and merged at its offset (the line became `^ EXTRAl2`), so a write on the line being typed on can split a token.

The plan routes an open source through an editor transaction (one change, detector stamps once, undo works) and a closed source through `vault.process`. The probe supports both halves and shows why the open case must not use `vault.process`: no detector event, and a merge that can split a token.

## 5. Observation: 0.1.0 swallows the click on an embedded checkbox in Live Preview

With the plugin enabled, a simulated click (and a full pointerdown, pointerup, click sequence) on an embedded checkbox in Live Preview changed nothing in `Course.md` (still `- [ ]`). With the plugin disabled the same click wrote `- [x]`. The likely cause, from reading the code and not traced: the capture-phase click guard in `src/status-cycle/wire-checkbox-press.ts` (`onClick`) swallows it, because it leaves a Live Preview widget checkbox alone only when it is inside `.cm-embed-block`, and embeds in 1.15.1 are not. So the premise "the native handler runs and writes a bare `[x]`" holds with the plugin off, but with the plugin on a tick in an embed currently writes nothing at all. PR-3 replaces this path (suppress the native toggle and write the stamped result), so it is not a contradiction of the plan, but it must not rely on `.cm-embed-block`. The resolver in this PR does not use that class. Reading view is not affected (the guard needs Live Preview).

## 6. Observation: the source file's disk text and an unsaved editor can differ

The resolver reads the source with `vault.cachedRead` (disk text). A source open in an editor with unsaved typing can differ from what an embed shows until the next autosave (about 2 s). The resolver's content check turns any mismatch into `unmappable`, never a guess, and PR-2 re-checks the line at write time (E2).

## 7. The resolver against the real app

`plugin.resolveRenderedTask(checkbox)` was built into the scratch vault and called on every checkbox in the probe notes (2026-11-20, Obsidian 1.15.1), twice each:

| Embed (Reading view and Live Preview) | Result |
|---|---|
| `![[Course#^l2]]`, 3 checkboxes | `Course.md` lines 0, 1, 2 |
| `![[Course#^l2\|300]]` | the same lines 0, 1, 2 |
| `![[Forms#Sub]]` and `![[Forms#Top#Sub]]` | the two `Read chapter 3` boxes: `unmappable: ambiguous`; `Unique in sub`: line 12; `Deep task`: line 16 |
| `![[Course]]` | lines 0, 1, 2 |
| `![[Forms#^li]]`, `![[Forms#^child]]` | lines 4, 5, 6 and line 5 |
| `Outer.md` -> `Inner.md` -> `Course#^l2` | `Course.md` lines 0, 1, 2 (the innermost `src` wins) |

Both calls of each pair gave equal results, and `Course.md` was byte-identical before and after.

## Plan check

| Question | Result |
|---|---|
| Native embed tick bytes | matches the plan |
| `data-line` meaning | matches the plan (section-relative, base 0) |
| Detector echo | matches the plan (once) |
| `vault.process` with the file open | matches the plan |

Nothing contradicts the plan, so PR-2 and PR-3 may start.
