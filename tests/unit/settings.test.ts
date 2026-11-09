import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SETTINGS,
	SETTING_KEYS,
	SettingsStore,
	normalizeSettings,
	type TaskLifecycleSettings,
} from "../../src/settings/settings";

/** In-memory loadData/saveData pair. `writes` records every saved payload. */
function memory(initial?: unknown) {
	const state = { file: initial, writes: [] as unknown[] };
	return {
		state,
		persistence: {
			loadData: async () => (state.file === undefined ? null : state.file),
			saveData: async (data: unknown) => {
				state.writes.push(JSON.parse(JSON.stringify(data)));
				state.file = JSON.parse(JSON.stringify(data));
			},
		},
	};
}

const ALL_TRUE: TaskLifecycleSettings = {
	statusCycle: true,
	closeStamps: true,
	closeCascade: true,
	checkboxIcons: true,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("defaults", () => {
	it("are exactly four keys, all true", () => {
		expect([...SETTING_KEYS]).toEqual([
			"statusCycle",
			"closeStamps",
			"closeCascade",
			"checkboxIcons",
		]);
		expect(DEFAULT_SETTINGS).toEqual(ALL_TRUE);
	});

	it("missing data.json (loadData gives null) loads all true", async () => {
		const { persistence } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		expect(store.get()).toEqual(ALL_TRUE);
	});
});

describe("normalizeSettings", () => {
	it("keeps a stored value and defaults the missing keys", () => {
		expect(normalizeSettings({ closeStamps: false })).toEqual({
			...ALL_TRUE,
			closeStamps: false,
		});
	});

	it.each([["yes"], [null], [0], [1], [undefined], [{}], [[]]])(
		"falls back to the default for non-boolean value %j",
		(bad) => {
			expect(
				normalizeSettings({
					statusCycle: bad,
					closeStamps: bad,
					closeCascade: bad,
					checkboxIcons: bad,
				})
			).toEqual(ALL_TRUE);
		}
	);

	it("drops unknown keys", () => {
		const out = normalizeSettings({
			useBundledCheckboxes: false,
			closeCascade: false,
		});
		expect(Object.keys(out).sort()).toEqual([...SETTING_KEYS].sort());
		expect(out.closeCascade).toBe(false);
	});

	it.each([[null], [[]], [["closeStamps"]], ["a string"], [42], [true], [undefined]])(
		"corrupt or non-object input %j gives the defaults and does not throw",
		(raw) => {
			expect(normalizeSettings(raw)).toEqual(ALL_TRUE);
		}
	);

	it("ignores inherited keys", () => {
		const raw = Object.create({ closeStamps: false }) as unknown;
		expect(normalizeSettings(raw)).toEqual(ALL_TRUE);
	});
});

describe("SettingsStore.load", () => {
	it("loads partial data from loadData", async () => {
		const { persistence } = memory({ closeStamps: false });
		const store = new SettingsStore(persistence);
		await store.load();
		expect(store.get()).toEqual({ ...ALL_TRUE, closeStamps: false });
	});

	it.each([[null], [[1, 2]], ["corrupt"]])(
		"does not throw when loadData returns %j",
		async (raw) => {
			const store = new SettingsStore({
				loadData: async () => raw,
				saveData: async () => {},
			});
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.get()).toEqual(ALL_TRUE);
		}
	);

	it("does not throw when loadData rejects", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const store = new SettingsStore({
			loadData: async () => {
				throw new Error("disk gone");
			},
			saveData: async () => {},
		});
		await expect(store.load()).resolves.toBeUndefined();
		expect(store.get()).toEqual(ALL_TRUE);
	});

	it("get() returns a copy", async () => {
		const { persistence } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		store.get().closeStamps = false;
		expect(store.get().closeStamps).toBe(true);
	});
});

describe("SettingsStore.update / save", () => {
	it("writes exactly the four keys and drops unknown ones", async () => {
		const { persistence, state } = memory({
			useBundledCheckboxes: true,
			closeStamps: false,
			junk: [1],
		});
		const store = new SettingsStore(persistence);
		await store.load();
		await store.update({ statusCycle: false });
		expect(state.file).toEqual({
			statusCycle: false,
			closeStamps: false,
			closeCascade: true,
			checkboxIcons: true,
		});
		expect(Object.keys(state.file as object).sort()).toEqual([...SETTING_KEYS].sort());
	});

	it("ignores non-boolean values in a patch", async () => {
		const { persistence, state } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		await store.update({ closeStamps: "no" as unknown as boolean });
		expect(state.file).toEqual(ALL_TRUE);
	});

	it("ten quick flips leave data.json and the last subscriber call on the final value", async () => {
		const { persistence, state } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		const calls: boolean[] = [];
		store.subscribe((next) => calls.push(next.checkboxIcons));

		const pending: Promise<void>[] = [];
		let value = true;
		for (let i = 0; i < 10; i++) {
			value = !value;
			pending.push(store.update({ checkboxIcons: value }));
		}
		await Promise.all(pending);

		expect(value).toBe(true); // ten flips from true
		expect(store.get().checkboxIcons).toBe(true);
		expect((state.file as TaskLifecycleSettings).checkboxIcons).toBe(true);
		expect(calls).toHaveLength(10);
		expect(calls[calls.length - 1]).toBe(true);
	});

	it("an odd number of quick flips ends on the flipped value everywhere", async () => {
		const { persistence, state } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		let last: boolean | undefined;
		store.subscribe((next) => (last = next.closeCascade));
		const pending: Promise<void>[] = [];
		let value = true;
		for (let i = 0; i < 9; i++) {
			value = !value;
			pending.push(store.update({ closeCascade: value }));
		}
		await Promise.all(pending);
		expect(value).toBe(false);
		expect(last).toBe(false);
		expect((state.file as TaskLifecycleSettings).closeCascade).toBe(false);
	});

	it("saves run in order even when an earlier write is slow", async () => {
		const written: boolean[] = [];
		const store = new SettingsStore({
			loadData: async () => null,
			saveData: async (data) => {
				const d = data as TaskLifecycleSettings;
				if (written.length === 0) await new Promise((r) => setTimeout(r, 20));
				written.push(d.closeStamps);
			},
		});
		await store.load();
		const a = store.update({ closeStamps: false });
		const b = store.update({ closeStamps: true });
		await Promise.all([a, b]);
		expect(written).toHaveLength(2);
		// The final write holds the final state.
		expect(written[written.length - 1]).toBe(true);
	});

	it("rejects when the write fails, and a later save still goes through", async () => {
		let fail = true;
		const saved: unknown[] = [];
		const store = new SettingsStore({
			loadData: async () => null,
			saveData: async (data) => {
				if (fail) throw new Error("read-only");
				saved.push(data);
			},
		});
		await store.load();
		await expect(store.update({ closeStamps: false })).rejects.toThrow("read-only");
		fail = false;
		await store.update({ closeCascade: false });
		expect(saved).toHaveLength(1);
		expect(saved[0]).toEqual({ ...ALL_TRUE, closeStamps: false, closeCascade: false });
	});
});

describe("SettingsStore.subscribe", () => {
	it("calls listeners synchronously, in order, with (next, prev)", async () => {
		const { persistence } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		const order: string[] = [];
		const seen: Array<[TaskLifecycleSettings, TaskLifecycleSettings]> = [];
		store.subscribe((next, prev) => {
			order.push("first");
			seen.push([{ ...next }, { ...prev }]);
		});
		store.subscribe(() => order.push("second"));

		const done = store.update({ closeCascade: false });
		// Before awaiting: listeners have already run.
		expect(order).toEqual(["first", "second"]);
		await done;

		expect(seen).toHaveLength(1);
		expect(seen[0][0]).toEqual({ ...ALL_TRUE, closeCascade: false });
		expect(seen[0][1]).toEqual(ALL_TRUE);
	});

	it("passes frozen snapshots so a listener cannot change the store", async () => {
		const { persistence } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		store.subscribe((next) => {
			expect(Object.isFrozen(next)).toBe(true);
		});
		await store.update({ statusCycle: false });
		expect(store.get().statusCycle).toBe(false);
	});

	it("a throwing subscriber doesn't stop the save or the other subscribers", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { persistence, state } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		const before = vi.fn();
		const after = vi.fn();
		store.subscribe(before);
		store.subscribe(() => {
			throw new Error("boom");
		});
		store.subscribe(after);

		await store.update({ closeStamps: false });

		expect(before).toHaveBeenCalledTimes(1);
		expect(after).toHaveBeenCalledTimes(1);
		expect(state.writes).toHaveLength(1);
		expect((state.file as TaskLifecycleSettings).closeStamps).toBe(false);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("unsubscribe stops further calls and leaves the others", async () => {
		const { persistence } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		const a = vi.fn();
		const b = vi.fn();
		const offA = store.subscribe(a);
		store.subscribe(b);
		await store.update({ statusCycle: false });
		offA();
		await store.update({ statusCycle: true });
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(2);
	});

	it("a listener that unsubscribes itself mid-notification doesn't skip the next one", async () => {
		const { persistence } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		const second = vi.fn();
		const off = store.subscribe(() => off());
		store.subscribe(second);
		await store.update({ statusCycle: false });
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("doesn't notify when nothing changed, but still saves", async () => {
		const { persistence, state } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		const listener = vi.fn();
		store.subscribe(listener);
		await store.update({ closeStamps: true });
		expect(listener).not.toHaveBeenCalled();
		expect(state.writes).toHaveLength(1);
	});

	it("clear() removes every subscriber", async () => {
		const { persistence } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		const listener = vi.fn();
		store.subscribe(listener);
		store.clear();
		await store.update({ statusCycle: false });
		expect(listener).not.toHaveBeenCalled();
	});

	it("a later feature can react to its toggle going off (fake subscribers)", async () => {
		const { persistence } = memory();
		const store = new SettingsStore(persistence);
		await store.load();
		const cancelLongPress = vi.fn(); // PR-4's reaction
		const closeDialogAsLeaveOpen = vi.fn(); // PR-5's reaction
		store.subscribe((next, prev) => {
			if (prev.statusCycle && !next.statusCycle) cancelLongPress();
		});
		store.subscribe((next, prev) => {
			if (prev.closeCascade && !next.closeCascade) closeDialogAsLeaveOpen();
		});

		await store.update({ closeStamps: false });
		expect(cancelLongPress).not.toHaveBeenCalled();
		expect(closeDialogAsLeaveOpen).not.toHaveBeenCalled();

		await store.update({ statusCycle: false });
		expect(cancelLongPress).toHaveBeenCalledTimes(1);
		expect(closeDialogAsLeaveOpen).not.toHaveBeenCalled();

		await store.update({ closeCascade: false });
		expect(closeDialogAsLeaveOpen).toHaveBeenCalledTimes(1);
	});
});
