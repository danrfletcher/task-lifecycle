import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/probe/scratch.sh: the guard setup.sh runs before it deletes anything.
 * Each case runs the real `prepare_scratch` in bash and reports SCR, so the
 * deleting path is exercised on a throwaway directory, never on anything real.
 * (setup.sh itself builds and starts Obsidian, so it is not run here.)
 */
const scratchSh = join(__dirname, "..", "..", "scripts", "probe", "scratch.sh");
const MARKER = ".task-lifecycle-probe";

let base = "";

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "task-lifecycle-guard-")));
});
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

function prepare(arg: string, cwd: string = base, home?: string) {
	const r = spawnSync(
		"bash",
		["-c", `set -euo pipefail; . "${scratchSh}"; prepare_scratch "$1"; echo "SCR=$SCR"`, "bash", arg],
		{ cwd, encoding: "utf8", env: { ...process.env, HOME: home ?? process.env.HOME ?? base } }
	);
	const m = /^SCR=(.*)$/m.exec(r.stdout);
	return { ok: r.status === 0, scr: m?.[1], stderr: r.stderr };
}

/** A directory under `base` holding some real-looking files. */
function populated(name: string): string {
	const dir = join(base, name);
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, "keep.txt"), "mine");
	writeFileSync(join(dir, ".git", "HEAD"), "ref");
	return dir;
}

describe("probe scratch dir guard", () => {
	it("creates a path that does not exist yet and marks it", () => {
		const dir = join(base, "fresh");
		const r = prepare(dir);
		expect(r.ok).toBe(true);
		expect(r.scr).toBe(dir);
		expect(existsSync(join(dir, MARKER))).toBe(true);
	});

	it("uses an empty directory as it is and marks it", () => {
		const dir = join(base, "empty");
		mkdirSync(dir);
		expect(prepare(dir).ok).toBe(true);
		expect(readdirSync(dir)).toEqual([MARKER]);
	});

	it("clears a directory a previous run marked, dotfiles included, and keeps it", () => {
		const dir = join(base, "again");
		expect(prepare(dir).ok).toBe(true);
		mkdirSync(join(dir, "vault", ".dotdir"), { recursive: true });
		writeFileSync(join(dir, "vault", ".dotdir", "app.json"), "{}");
		writeFileSync(join(dir, ".hidden"), "x");
		expect(prepare(dir).ok).toBe(true);
		expect(readdirSync(dir)).toEqual([MARKER]);
	});

	it("refuses a non-empty directory with no marker and deletes nothing", () => {
		const dir = populated("real");
		const r = prepare(dir);
		expect(r.ok).toBe(false);
		expect(r.stderr).toContain("refusing scratch dir");
		expect(existsSync(join(dir, "keep.txt"))).toBe(true);
		expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
		expect(existsSync(join(dir, MARKER))).toBe(false);
	});

	it("refuses '.', '..', a trailing slash and a symlinked path that name a real directory", () => {
		const dir = populated("repo");
		const sub = join(dir, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "f"), "x");
		expect(prepare(".", dir).ok).toBe(false);
		expect(prepare("..", sub).ok).toBe(false);
		expect(prepare(`${dir}/`).ok).toBe(false);
		expect(prepare(`${dir}/sub/../`).ok).toBe(false);
		const link = join(base, "link-to-repo");
		symlinkSync(dir, link);
		expect(prepare(link).ok).toBe(false);
		expect(prepare(`${link}/`).ok).toBe(false);
		expect(existsSync(join(dir, "keep.txt"))).toBe(true);
		expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
		expect(existsSync(join(sub, "f"))).toBe(true);
	});

	it("refuses a HOME with and without a trailing slash, and the filesystem root", () => {
		const home = populated("home");
		expect(prepare(home, base, home).ok).toBe(false);
		expect(prepare(`${home}/`, base, home).ok).toBe(false);
		expect(prepare("/").ok).toBe(false);
		expect(existsSync(join(home, "keep.txt"))).toBe(true);
	});

	it("refuses a plain file, an empty argument and a path whose parent is missing", () => {
		const file = join(base, "a-file");
		writeFileSync(file, "x");
		expect(prepare(file).ok).toBe(false);
		expect(prepare("").ok).toBe(false);
		expect(prepare(join(base, "no", "such", "dir")).ok).toBe(false);
		expect(existsSync(file)).toBe(true);
	});
});
