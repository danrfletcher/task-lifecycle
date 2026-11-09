import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// The real `obsidian` package ships types only.
			obsidian: fileURLToPath(
				new URL("./tests/__mocks__/obsidian.ts", import.meta.url)
			),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			enabled: true,
			provider: "v8",
			include: ["src/domain/**"],
			reporter: ["text", "html"],
			thresholds: {
				lines: 90,
				branches: 90,
			},
		},
	},
});
