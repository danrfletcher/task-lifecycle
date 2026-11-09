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

	it("F2: no vault modify handling, no vault writes, no task index, no headless path in src", () => {
		expect(
			hits(
				srcFiles,
				/vault\.on\(\s*["']modify["']|vault\.modify|vault\.process|vault\.append|metadataCache|modifyHeadless|onStatusChanged/
			)
		).toEqual([]);
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
