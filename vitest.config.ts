import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-canvas-agent-plugin",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
