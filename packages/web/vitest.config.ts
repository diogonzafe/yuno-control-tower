import { defineConfig } from "vitest/config";

// The unit suite renders components with renderToStaticMarkup and needs no DOM,
// so this config exists for one reason: vitest's default glob also matches
// `e2e/*.spec.ts`, which are Playwright specs. Run under vitest they fail at the
// import, and the failure says nothing about the code they cover.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "e2e/**"],
  },
});
