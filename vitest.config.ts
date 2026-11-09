import { defineConfig } from "vitest/config";

export default defineConfig({
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
