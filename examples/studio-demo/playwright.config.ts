import { defineConfig, devices } from '@playwright/test';

/** Token and port the E2E studio runs with. */
export const E2E_TOKEN = 'e2e-token';
const PORT = 7299;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node server.ts',
    url: `http://localhost:${PORT}/api/session`,
    // The studio answers 401 until the token is used; any answer means it is up.
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(PORT), PARAF_STUDIO_TOKEN: E2E_TOKEN, STUDIO_LABEL: 'PRODUCTION' },
  },
});
