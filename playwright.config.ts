import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  projects: [{name:process.env.QA_BROWSER||'chromium',use:{browserName:(process.env.QA_BROWSER||'chromium') as 'chromium'|'firefox'|'webkit'}}],
  reporter: [
    ["list"],
    [
      "junit",
      {
        outputFile:
          (process.env.QA_DIR || "artifacts/qa/default") + "/junit.xml",
      },
    ],
    [
      "json",
      {
        outputFile: process.env.QA_DIR
          ? process.env.QA_DIR + "/playwright.json"
          : "artifacts/qa/first-slice/playwright.json",
      },
    ],
  ],
  use: {
    actionTimeout: 15000,
    baseURL: process.env.APP_PUBLIC_ORIGIN || "http://127.0.0.1:3000",
    headless: true,
    contextOptions: {reducedMotion: 'reduce'},
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir:
    ".local/test-results/" +
    (process.env.QA_DIR || "default").replaceAll("/", "_"),
});
