import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv, promisify } from 'node:util'
import {
    type APIRequestContext,
    type BrowserContext,
    test as base,
    type Cookie,
    expect,
    type Page,
} from '@playwright/test'
import { ui } from '../copy'
import { everySignInCode, signInCode } from '../mailpit'
import { E2E } from '../stack'

const run = promisify(execFile)

/** `docker compose` in e2e/: .env names the project and the files of this run. */
export async function compose(...args: string[]): Promise<string> {
    const { stdout } = await run(
        'docker',
        [
            'compose',
            ...args,
        ],
        {
            cwd: E2E,
            maxBuffer: 256 * 1024 * 1024,
        },
    )
    return stdout
}

export const stop = (service: string) => compose('stop', service)
export const kill = (service: string) => compose('kill', service)
export const logsOf = (service: string) => compose('logs', '--no-color', service)

/** The services' state, from what `docker compose ps` says about each. */
export async function healthOf(services: string[]) {
    const lines = await compose('ps', '--all', '--format', '{{.Service}}={{.Health}}', ...services)
    return lines.trim().split('\n').sort()
}

/**
 * Back and healthy. Polled, not `start --wait`, which gives up at the first
 * unhealthy report: a health check of an emulated image can miss its 3 s once.
 */
export async function start(...services: string[]) {
    await compose('start', ...services)
    await expect
        .poll(() => healthOf(services), {
            message: `healthy again: ${services.join(', ')}`,
            timeout: 180_000,
            intervals: [
                1_000,
            ],
        })
        .toEqual(services.map(service => `${service}=healthy`).sort())
}

/** Everything a scenario may stop; never the migrations, which ran once. */
const LONG_RUNNING = [
    'postgres',
    'redis',
    'rabbitmq',
    'mailpit',
    'id-api',
    'id-api-2',
    'wallet-api',
    'pay-api',
]

/** After a failed scenario: the next one starts from the whole stack. */
async function restore() {
    await compose('unpause').catch(() => {})
    await start(...LONG_RUNNING)
}

/** ACCESS_TOKEN_TTL_SECONDS of compose.failure.yaml. */
export const ACCESS_TTL_MS = 70_000
/** REFRESH_BEFORE_MS of id-web: fewer than this left of the access token, and a request refreshes it. */
const REFRESH_THRESHOLD_MS = 60_000
/** REFRESH_GRACE_MS of id-api: how long the previous refresh token still gets the new one. */
export const REFRESH_GRACE_MS = 20_000

/** Until the access token of a sign-in or refresh that just happened is past id-web's threshold. */
export const pastRefreshThreshold = (on: Page) => on.waitForTimeout(ACCESS_TTL_MS - REFRESH_THRESHOLD_MS + 1_000)

const LOG_WATERMARK = path.join(import.meta.dirname, '../test-results/.log-watermark')

/** What a line of a log may not hold, and the name a finding gets. */
type Rule = [
    string,
    RegExp,
]

const FORBIDDEN: Rule[] = [
    [
        'a test user email',
        /e2e-[0-9a-f-]{36}(?:@|%40)example\.com/g,
    ],
    [
        'a JWT',
        /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
    ],
    [
        'a bearer token',
        /bearer\s+[\w.~+/=-]{16,}/gi,
    ],
    [
        'a refresh token',
        /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[\w-]{43}/g,
    ],
    [
        'a connection string with a password',
        /(?:postgres|postgresql|amqp|amqps|redis|rediss):\/\/[^\s:@/"]*:[^\s@/"]+@/g,
    ],
    [
        'a private key',
        /BEGIN PRIVATE KEY/g,
    ],
]

/** The passwords and tokens this run generated (../.env), whatever surrounds them in a line. */
function secretsOfRun(): string[] {
    const env = parseEnv(readFileSync(path.join(E2E, '.env'), 'utf8')) as Record<string, string>
    return Object.entries(env)
        .filter(([key]) => /_(?:PASSWORD|TOKEN|SECRET|PEPPER)$/.test(key))
        .map(([, value]) => value)
}

/**
 * The rule that a line breaks, with what matched cut out: a finding names the
 * line, and never repeats the value in a report.
 */
export function findings(lines: string[], codes: string[], secrets: string[]): string[] {
    const literal = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rules: Rule[] = [
        ...FORBIDDEN,
        ...secrets.map(
            (secret): Rule => [
                'a password or token of this run',
                new RegExp(literal(secret), 'g'),
            ],
        ),
        // Not part of a longer number or a fraction of a second.
        ...codes.map(
            (code): Rule => [
                'a sign-in code',
                new RegExp(`(?<![\\d.])${code}(?!\\d)`, 'g'),
            ],
        ),
    ]
    return lines.flatMap(line => {
        const broken = rules.filter(([, pattern]) => line.search(pattern) >= 0)
        if (broken.length === 0) return []
        const masked = broken.reduce((text, [name, pattern]) => text.replace(pattern, `<${name}>`), line)
        return [
            `${[
                ...new Set(broken.map(([name]) => name)),
            ].join(', ')}: ${masked.slice(0, 400)}`,
        ]
    })
}

/**
 * Every line of every service since the last check, against the rules. The
 * mark is the engine's own timestamp of the last line read, on disk: a failed
 * test restarts the worker.
 */
async function checkLogs(codes: string[]) {
    let since: string | undefined
    try {
        since = readFileSync(LOG_WATERMARK, 'utf8')
    } catch {
        since = undefined
    }
    const logs = await compose(
        'logs',
        '--no-color',
        '--timestamps',
        ...(since
            ? [
                  '--since',
                  since,
              ]
            : []),
    )
    const lines = logs.split('\n').filter(Boolean)
    const stamps = lines
        .map(line => /\| (\d{4}-\d{2}-\d{2}T[\d:.]+Z) /.exec(line)?.[1])
        .filter(stamp => stamp !== undefined)
        .sort()
    const last = stamps.at(-1)
    if (last) {
        mkdirSync(path.dirname(LOG_WATERMARK), {
            recursive: true,
        })
        writeFileSync(LOG_WATERMARK, last)
    }
    expect(
        findings(lines, codes, secretsOfRun()),
        'service logs: an email, a sign-in code, a token or a password (masked here)',
    ).toEqual([])
}

export type Person = {
    context: BrowserContext
    page: Page
    email: string
}

type Fixtures = {
    /** A new person with their own browser; closed with the test. */
    newPerson: () => Promise<Person>
    /** After every scenario: the whole stack back if it failed, and the logs clean. */
    aftermath: undefined
}

export const test = base.extend<Fixtures>({
    newPerson: async ({ browser }, use) => {
        const contexts: BrowserContext[] = []
        await use(async () => {
            const context = await browser.newContext({
                // Cloudflare's header in prod: id-api's limit per address (20 code requests
                // an hour) then counts one person, not the whole suite.
                extraHTTPHeaders: {
                    'cf-connecting-ip': `203.0.113.${randomInt(1, 255)}`,
                },
            })
            contexts.push(context)
            return {
                context,
                page: await context.newPage(),
                email: `e2e-${randomUUID()}@example.com`,
            }
        })
        await Promise.all(contexts.map(context => context.close()))
    },
    aftermath: [
        async ({ request }, use, testInfo) => {
            await use(undefined)
            if (testInfo.status !== testInfo.expectedStatus) await restore()
            await checkLogs(await everySignInCode(request))
        },
        {
            auto: true,
            timeout: 240_000,
        },
    ],
})

export { expect }

/** Exact: "Language of emails" on the account page and "Code from the email" contain the word too. */
export const emailField = (on: Page) =>
    on.getByLabel(ui.login.email, {
        exact: true,
    })

/** Step 1 of sign-in, on one replica of id-web (the first by default). */
export async function requestCode(on: Page, email: string, site = '') {
    await on.goto(`${site}/login?lang=en`)
    await emailField(on).fill(email)
    await on
        .getByRole('button', {
            name: ui.login.send,
        })
        .click()
}

/** Step 2 of sign-in, on the page as it is. */
export async function submitCode(on: Page, code: string) {
    await on.getByLabel(ui.login.code).fill(code)
    await on
        .getByRole('button', {
            name: ui.login.verify,
        })
        .click()
}

/** A person signed in with the code from the email; ends on the account page. */
export async function signIn({ page, email }: Person, request: APIRequestContext, site = '') {
    await requestCode(page, email, site)
    await expect(page.getByLabel(ui.login.code)).toBeVisible()
    await submitCode(page, await signInCode(request, email))
    await expect(page).toHaveURL(/\/account$/)
}

/** The account page of this person, as a page that works shows it. */
export async function expectAccount(on: Page, email: string) {
    await expect(on).toHaveURL(/\/account$/)
    await expect(on.getByText(ui.account.email(email))).toBeVisible()
}

/** The session cookie as it is now. */
export async function sessionCookie({ context }: Person) {
    const cookie = (await context.cookies()).find(item => item.name === '__Host-id_session')
    expect(cookie, 'the session cookie').toBeDefined()
    return cookie as Cookie
}

export async function pressSignOut(on: Page) {
    await on
        .getByRole('banner')
        .getByRole('button', {
            name: ui.nav.signOut,
        })
        .click()
}

export async function signOut(on: Page) {
    await pressSignOut(on)
    await expect(on).toHaveURL(/\/login$/)
}

/** id-api cannot end the session: the account says so, and the session stays. */
export async function signOutRefused(person: Person) {
    const before = await sessionCookie(person)
    await pressSignOut(person.page)
    await expect(person.page).toHaveURL(/\/account\?error=unavailable$/)
    expect((await sessionCookie(person)).value).toBe(before.value)
}

/**
 * A session is over at id-api: its cookie put back, past the refresh threshold,
 * where the access token no longer decides, ends on the sign-in page.
 */
export async function expectSessionOver({ context, page }: Person, cookie: Cookie, site = '') {
    await context.addCookies([
        cookie,
    ])
    await pastRefreshThreshold(page)
    await expect(async () => {
        await page.goto(`${site}/account`)
        await expect(page).toHaveURL(/\/login$/, {
            timeout: 2_000,
        })
    }).toPass({
        timeout: 30_000,
    })
}

/** A message of the page; `role="alert"` is also Next.js's own route announcer. */
export const alert = (on: Page, text: string | RegExp) =>
    on.getByRole('alert').filter({
        hasText: text,
    })

/** Not the error page a failed render ends on: an outage has states of its own. */
export const expectNoCrash = (on: Page) =>
    expect(
        on.getByRole('heading', {
            name: ui.crash,
        }),
    ).toHaveCount(0)

/** Every page behind sign-in answers and renders, whatever part of it is down. */
export async function expectPagesHold(on: Page) {
    for (const page of [
        '/account',
        '/wallet',
        '/payments',
        '/notifications',
    ]) {
        const response = await on.goto(page)
        expect(response?.status(), `${page} answers`).toBeLessThan(500)
        await expectNoCrash(on)
    }
}

/** The wallet page until it shows the balance; credits arrive through the broker. */
export async function expectBalance(on: Page, coins: number, timeout = 120_000) {
    await expect(async () => {
        await on.goto('/wallet?currency=USD')
        await expect(
            on.getByText(ui.wallet.coins(coins), {
                exact: true,
            }),
        ).toBeVisible({
            timeout: 2_000,
        })
    }).toPass({
        timeout,
    })
}

/**
 * The one pack bought so far arrived, once: the balance and one history entry,
 * read when it arrives and again a few seconds later, so a late duplicate fails.
 */
export async function expectCreditedOnce(on: Page, coins: number) {
    await expectBalance(on, coins)
    for (const wait of [
        0,
        5_000,
    ]) {
        await on.waitForTimeout(wait)
        await on.goto('/wallet?currency=USD')
        await expect(
            on.getByText(ui.wallet.coins(coins), {
                exact: true,
            }),
        ).toBeVisible()
        await expect(
            on.getByRole('main').getByText(`+${coins}`, {
                exact: true,
            }),
        ).toHaveCount(1)
    }
}

/** The form of the pack with this title on the wallet page. */
export const packForm = (on: Page, title: string) =>
    on.getByRole('listitem').filter({
        has: on.getByText(title, {
            exact: true,
        }),
    })

/** Buys the pack with this title on the wallet page; ends on the test provider's checkout page. */
export async function startCheckout(on: Page, title: string) {
    await on.goto('/wallet?currency=USD')
    await packForm(on, title)
        .getByRole('button', {
            name: ui.wallet.buy,
        })
        .click()
    await expect(on).toHaveURL(/\/payments\/fake\/[0-9a-f-]{36}$/)
}

export async function confirmPayment(on: Page) {
    await on
        .getByRole('button', {
            name: ui.fakePay.pay,
        })
        .click()
}

/** One query as superuser, over the socket of the Postgres container. */
export const psql = async (database: string, query: string) =>
    (await compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database, '-Atc', query)).trim()
