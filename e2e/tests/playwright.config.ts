import { defineConfig, devices } from '@playwright/test'
import { FAILURE_SUITE, LANDING_HOST, WEB_HOST, WEB_URL } from './stack'

// One scenario against the real stack of ../compose.yaml, which the global
// setup (stack.ts) starts and removes. Serial and without retries: the tests
// share one signed-in browser, and a failure is a finding, not noise.
// E2E_SUITE=failure runs the failure scenarios (tag @failure) instead: they
// stop parts of the stack, so never on a deploy PR and never in parallel.
export default defineConfig({
    testDir: '.',
    globalSetup: './stack.ts',
    grep: FAILURE_SUITE ? /@failure/ : undefined,
    grepInvert: FAILURE_SUITE ? undefined : /@failure/,
    fullyParallel: false,
    workers: 1,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    timeout: FAILURE_SUITE ? 300_000 : 60_000,
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
        // The certificate of id-web-tls, from a CA of its own.
        ignoreHTTPSErrors: true,
        locale: 'en-US',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        // The sites have real names, so that the session cookie is on the whole domain as in
        // prod. Only the browser knows them: a test's `request` reaches Mailpit alone.
        launchOptions: {
            args: [
                `--host-resolver-rules=MAP ${WEB_HOST} 127.0.0.1,MAP ${LANDING_HOST} 127.0.0.1`,
            ],
        },
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
