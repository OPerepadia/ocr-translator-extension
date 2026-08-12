import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 90_000,
  reporter: process.env.CI ? "github" : "list",
});
