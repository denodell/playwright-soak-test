import { defineConfig, devices } from '@playwright/test'
import { soakLaunchOptions } from './src/index.js'

export default defineConfig({
  testDir: './tests',
  // Soak runs are long and share one demo server, so they go one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60 * 1000,
  reporter: [['list'], ['./src/reporter.ts']],
  use: {
    baseURL: 'http://localhost:5173',
    // Both retain large in-process buffers, which is noise a soak run doesn't need.
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'unit',
      testMatch: /unit\/.*\.spec\.ts/,
    },
    {
      name: 'package',
      testMatch: /package\/.*\.spec\.ts/,
    },
    {
      name: 'soak',
      testMatch: /soak\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: soakLaunchOptions,
      },
    },
  ],
  webServer: {
    command: 'node examples/server.mjs',
    url: 'http://localhost:5173/__counter',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
  },
});
