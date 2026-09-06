import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["tests/live/**", "node_modules/**", "dist/**"],
    coverage: { reporter: ["text", "json", "html"] }
  }
});
