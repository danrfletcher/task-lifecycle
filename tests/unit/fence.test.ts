import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CANCELLED_EMOJI, DONE_EMOJI } from "../../src/domain/constants";
import * as constants from "../../src/domain/constants";
import {
	addStamp,
	applyStampTransition,
	findStamps,
	removeStamps,
} from "../../src/domain/stamps";
import { STATUS_SEQUENCE, nextStatus } from "../../src/domain/status-sequence";

const root = join(__dirname, "..", "..");

function files(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...files(p));
		else out.push(p);
	}
	return out;
}

function read(p: string): string {
	return readFileSync(p, "utf8");
}

function hits(paths: string[], re: RegExp): string[] {
	const found: string[] = [];
	for (const p of paths) {
		read(p)
			.split("\n")
			.forEach((line, i) => {
				if (re.test(line)) found.push(`${relative(root, p)}:${i + 1}: ${line}`);
			});
	}
	return found;
}

const srcFiles = files(join(root, "src"));

describe("domain purity", () => {
	it("nothing under src/domain or src/utils imports obsidian", () => {
		const pure = [
			...files(join(root, "src", "domain")),
			...files(join(root, "src", "utils")),
		];
		expect(pure.length).toBeGreaterThan(0);
		const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']obsidian["']/;
		expect(hits(pure, importRe)).toEqual([]);
	});
});

describe("rendered-task resolver (src/rendered, rendered-match, embed-range)", () => {
	// `source-writer.ts` is the one writer in src/rendered; it has its own block below.
	const writerPath = join(root, "src", "rendered", "source-writer.ts");
	const renderedFiles = files(join(root, "src", "rendered")).filter((p) => p !== writerPath);
	const readOnlyFiles = [
		...renderedFiles,
		join(root, "src", "domain", "rendered-match.ts"),
		join(root, "src", "domain", "embed-range.ts"),
	];

	it("the files exist, so the greps below are not vacuous", () => {
		expect(renderedFiles.length).toBeGreaterThanOrEqual(1);
		expect(readOnlyFiles.length).toBeGreaterThanOrEqual(3);
		for (const p of readOnlyFiles) expect(read(p).length).toBeGreaterThan(0);
	});

	it("F3: no vault, editor or file write call in the resolver, the probe code or the matcher", () => {
		expect(
			hits(
				readOnlyFiles,
				/vault\.(?:process|modify|create|append|delete|rename|trash)|fileManager\.|editor\.(?:replaceRange|replaceSelection|transaction|setValue|setLine)|\.replaceRange\(|\.transaction\(|\.dispatch\(/
			)
		).toEqual([]);
	});

	it("F9: no listener and no event interference in src/rendered, so the native toggle is untouched", () => {
		expect(
			hits(
				renderedFiles,
				/addEventListener|removeEventListener|registerDomEvent|registerEvent|\.on\(|\bonclick\b|\bonpointerdown\b|\bonkeydown\b|preventDefault|stopPropagation|stopImmediatePropagation|dispatchEvent/
			)
		).toEqual([]);
	});

	it("only type imports from obsidian, so the resolver pulls in no runtime code", () => {
		const valueImport = /import\s+(?!type\b)[^;]*from\s+["']obsidian["']/;
		expect(hits(renderedFiles, valueImport)).toEqual([]);
	});

	it("registers no command and no hotkey (F2)", () => {
		expect(hits(renderedFiles, /addCommand|hotkeys|addRibbonIcon|addSettingTab/)).toEqual([]);
	});
});

describe("source writer (src/rendered/source-writer.ts)", () => {
	const writerPath = join(root, "src", "rendered", "source-writer.ts");
	const renderedAll = files(join(root, "src", "rendered"));

	it("exists, so the scans are not vacuous", () => {
		expect(read(writerPath).length).toBeGreaterThan(0);
	});

	it("F3: vault.process has exactly one call site in src, and it is the writer", () => {
		const found = hits(srcFiles, /vault\.process\(/);
		expect(found).toHaveLength(1);
		expect(found[0]).toContain("src/rendered/source-writer.ts");
	});

	it("F3: the writer changes the note only through editor.transaction or vault.process", () => {
		expect(
			hits(
				[writerPath],
				/vault\.(?:modify|create|append|delete|rename|trash)|fileManager\.|editor\.(?:replaceRange|replaceSelection|setValue|setLine)|\.replaceRange\(|\.dispatch\(/
			)
		).toEqual([]);
	});

	it("F3: the writer imports no CodeMirror, no change-detector internals and no annotation", () => {
		const src = read(writerPath);
		expect(src).not.toMatch(/@codemirror/);
		expect(src).not.toMatch(/change-detector|taskLifecycleSelfWrite|Annotation/);
		expect(src).not.toMatch(/events\/event-bus|cascade\//);
	});

	it("F1/F9: the writer listens to nothing and touches no click", () => {
		expect(
			hits(
				renderedAll,
				/addEventListener|removeEventListener|registerDomEvent|registerEvent|\.on\(|\bonclick\b|preventDefault|stopPropagation|stopImmediatePropagation|dispatchEvent/
			)
		).toEqual([]);
	});

	it("F2/F5: the writer registers no command, hotkey, setting or public API", () => {
		expect(hits(renderedAll, /addCommand|hotkeys|addRibbonIcon|addSettingTab|window\.|globalThis/)).toEqual([]);
	});

	it("only type imports from obsidian in src/rendered, so nothing is pulled in at runtime", () => {
		const valueImport = /import\s+(?!type\b)[^;]*from\s+["']obsidian["']/;
		expect(hits(renderedAll, valueImport)).toEqual([]);
	});
});

describe("embed press (src/status-cycle/wire-embed-press.ts, src/rendered/embed-press.ts)", () => {
	const wirePath = join(root, "src", "status-cycle", "wire-embed-press.ts");
	const pressPath = join(root, "src", "rendered", "embed-press.ts");

	it("the files exist, so the greps below are not vacuous", () => {
		expect(read(wirePath).length).toBeGreaterThan(0);
		expect(read(pressPath).length).toBeGreaterThan(0);
	});

	it("F1: a file changed from outside is never stamped: no modify/changed handler, no vault or cache watcher, no polling", () => {
		expect(
			hits(
				srcFiles,
				/\.on\(\s*["'](?:modify|changed|create|delete|rename)["']|registerEvent\(\s*(?:this\.)?app\.(?:vault|metadataCache)|setInterval|registerInterval|MutationObserver/
			)
		).toEqual([]);
	});

	it("F6: no read of app.plugins and no detection of other plugins in src", () => {
		expect(hits(srcFiles, /\bplugins\.(?:plugins|getPlugin|enabledPlugins)|app\.plugins|\.plugins\[/)).toEqual([]);
		expect(hits(srcFiles, /enabledPlugins|getPlugin\(|isPluginEnabled/)).toEqual([]);
	});

	it("F9: the click is taken in the capture phase through registerDomEvent and always swallowed once handled", () => {
		const src = read(wirePath);
		expect(src).toMatch(/registerDomEvent\(doc, "click", onClick, opts\)/);
		expect(src).toMatch(/const opts = \{ capture: true \}/);
		// The native toggle is stopped before the press kind is decided, so no kind can let it through.
		const handler = src.slice(src.indexOf("const onClick"), src.indexOf("const stopSettings"));
		const begin = handler.indexOf("presser.begin(box)");
		expect(begin).toBeGreaterThan(-1);
		expect(handler.indexOf("swallow(evt)", begin)).toBeGreaterThan(begin);
		expect(handler.indexOf("swallow(evt)", begin)).toBeLessThan(handler.indexOf("clickKind(box, evt)"));
		expect(src).toMatch(/evt\.preventDefault\(\)/);
		expect(src).toMatch(/evt\.stopImmediatePropagation\(\)/);
	});

	it("F9: no raw listener, no interval and one hold timer in the embed handler, cleared on unload", () => {
		expect(hits([wirePath], /addEventListener|setInterval|requestAnimationFrame/)).toEqual([]);
		// The only timer is the hold timer; every path that ends a press, and the stop function, clear it.
		expect(hits([wirePath], /setTimeout\(/)).toHaveLength(1);
		const src = read(wirePath);
		const stop = src.slice(src.indexOf("return () => {"));
		expect(stop).toMatch(/clearTimer\(\)/);
	});

	it("F2: the embed handler adds no command, hotkey, ribbon icon, setting or public API", () => {
		expect(hits([wirePath, pressPath], /addCommand|hotkeys|addRibbonIcon|addSettingTab|window\.|globalThis/)).toEqual([]);
	});

	it("F3: the embed press writes only through the source writer", () => {
		expect(
			hits(
				[wirePath, pressPath],
				/vault\.(?:process|modify|create|append|delete|rename|trash)|fileManager\.|\.transaction\(|\.replaceRange\(|\.dispatch\(|setCheckboxStatusChar/
			)
		).toEqual([]);
	});

	it("the metadata cache is read only under src/rendered (the handler asks the resolver)", () => {
		expect(hits([wirePath], /metadataCache/)).toEqual([]);
	});

	it("the pure domain files stay untouched by this feature: no embed-press import in src/domain", () => {
		const domain = files(join(root, "src", "domain"));
		expect(hits(domain, /from ".*(?:embed-press|wire-embed|source-writer)/)).toEqual([]);
	});
});

describe("fence regression checks", () => {
	it("F1: no dashboard, task index or date-marker parsing in src", () => {
		expect(hits(srcFiles, /📅|🛫|⏳|🎯|TaskItem|task-index/)).toEqual([]);
	});

	it("F5: no mention of the other plugin in src, styles.css, package.json, manifest.json", () => {
		const paths = [
			...srcFiles,
			join(root, "styles.css"),
			join(root, "package.json"),
			join(root, "manifest.json"),
		];
		expect(hits(paths, /agile/i)).toEqual([]);
	});

	it("F5: package.json depends on no shared package", () => {
		const pkg = JSON.parse(read(join(root, "package.json"))) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const names = [
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {}),
		];
		expect(names.filter((n) => /agile/i.test(n))).toEqual([]);
	});

	it("F6: no release workflow and no fundingUrl", () => {
		const wf = readdirSync(join(root, ".github", "workflows"));
		expect(wf).toEqual(["ci.yml"]);
		expect(read(join(root, "manifest.json"))).not.toMatch(/fundingUrl/);
	});

	it("F7: no detection of or adaptation to other plugins in src", () => {
		expect(
			hits(srcFiles, /obsidian-tasks-plugin|agile-project-management/)
		).toEqual([]);
	});

	it("F8: the sequence and constants are frozen / const", () => {
		expect(Object.isFrozen(STATUS_SEQUENCE)).toBe(true);
		expect(DONE_EMOJI).toBe("✅");
		expect(CANCELLED_EMOJI).toBe("❌");
		expect(constants.LONG_PRESS_MS).toBe(500);
		expect(constants.MOVE_TOLERANCE_PX).toBe(5);
		expect(constants.CLICK_SWALLOW_MS).toBe(600);
		expect(constants.SELF_WRITE_SUPPRESSION_MS).toBe(1200);
		expect(constants.CASCADE_DEDUPE_MS).toBe(1500);
	});

	it("F1: no vault-wide watcher anywhere in src (vault, metadata cache or file-event listeners)", () => {
		expect(
			hits(
				srcFiles,
				/vault\.on\(|metadataCache\.on\(|\.on\(\s*["'](?:modify|create|delete|rename|changed|resolve|resolved)["']|FileSystemWatcher|onExternalSettingsChange/
			)
		).toEqual([]);
	});

	it("F2: no vault.modify, vault.append, modify listener, task index or headless path in src; vault.process only in the source writer", () => {
		expect(
			hits(srcFiles, /vault\.modify|vault\.append|vault\.on\(\s*["']modify["']|modifyHeadless|onStatusChanged/)
		).toEqual([]);
		const outside = srcFiles.filter((p) => !/src\/rendered\/source-writer\.ts$/.test(p));
		expect(hits(outside, /vault\.process/)).toEqual([]);
	});

	it("F2: the metadata cache is read only under src/rendered", () => {
		const outside = srcFiles.filter((p) => !/src\/rendered\//.test(p));
		expect(hits(outside, /metadataCache/)).toEqual([]);
	});

	it("F5/F9: no agile: events, no document.dispatchEvent, no workspace.trigger, no <style in the new files", () => {
		const added = srcFiles.filter((p) => /src\/(editor|events|cascade)\//.test(p) || /task-line-diff|domain\/cascade/.test(p));
		expect(added.length).toBeGreaterThanOrEqual(3);
		expect(hits(added, /agile:|document\.dispatchEvent|dispatchEvent\(|workspace\.trigger|<style/i)).toEqual([]);
	});

	it("F4: the change detector never writes a status char", () => {
		const editorFiles = srcFiles.filter((p) => /src\/(editor|events)\//.test(p));
		expect(editorFiles.length).toBeGreaterThanOrEqual(2);
		expect(hits(editorFiles, /setCheckboxStatusChar/)).toEqual([]);
	});

	it("F8: domain functions take no sequence, emoji or timing from outside", () => {
		// Declared parameter counts: a function that took a custom sequence or
		// emoji would show up as an extra parameter.
		expect(nextStatus.length).toBe(1);
		expect(findStamps.length).toBe(1);
		expect(removeStamps.length).toBe(1);
		expect(addStamp.length).toBe(3);
		expect(applyStampTransition.length).toBe(4);
	});
});
