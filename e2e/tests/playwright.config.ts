import { defineConfig, devices } from '@playwright/test'
import { WEB_URL } from './stack'

// One scenario against the real stack of ../compose.yaml, which the global
// setup (stack.ts) starts and removes. Serial and without retries: the tests
// share one signed-in browser, and a failure is a finding, not noise.
export default defineConfig({
    testDir: '.',
    globalSetup: './stack.ts',
    fullyParallel: false,
    workers: 1,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    timeout: 60_000,
    expect: {
        timeout: 10_000,
    },
    reporter: process.env.CI
        ? [
              [
                  'list',
              ],
              [
                  'html',
                  {
                      open: 'never',
                  },
              ],
          ]
        : [
              [
                  'list',
              ],
          ],
    use: {
        baseURL: WEB_URL,
        locale: 'en-US',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
            },
        },
    ],
})
