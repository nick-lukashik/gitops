import { randomUUID } from 'node:crypto'
import { type BrowserContext, type Cookie, expect, type Page, test } from '@playwright/test'
import { ui } from './copy'
import { signInCode } from './mailpit'
import { LANDING_HOST, LANDING_URL, LOCALE_COOKIE, SESSION_COOKIE, WEB_URL } from './stack'

// Two sites of one domain and one person, in one browser: every test starts where
// the previous one ended, and a failed one skips the rest.
test.describe.configure({
    mode: 'serial',
})

const newEmail = () => `e2e-${randomUUID()}@example.com`
const email = newEmail()
let context: BrowserContext
let page: Page

test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    page = await context.newPage()
})

test.afterAll(async () => {
    await context.close()
})

const banner = () => page.getByRole('banner')
/** The landing says who is signed in: a new person has no name yet, so the address. */
const expectSignedIn = (address = email) =>
    expect(
        banner().getByRole('link', {
            name: address,
        }),
    ).toBeVisible()
const expectNobody = () =>
    expect(
        banner().getByRole('link', {
            name: ui.landing.signIn,
        }),
    ).toBeVisible()
const sessionCookie = async () => (await context.cookies()).find(cookie => cookie.name === SESSION_COOKIE)

/** On the sign-in page of id-web. */
async function enterCode(request: Parameters<typeof signInCode>[0], address = email) {
    await page
        .getByLabel(ui.login.email, {
            exact: true,
        })
        .fill(address)
    await page
        .getByRole('button', {
            name: ui.login.send,
        })
        .click()
    await expect(page.getByLabel(ui.login.code)).toBeVisible()
    await page.getByLabel(ui.login.code).fill(await signInCode(request, address))
    await page
        .getByRole('button', {
            name: ui.login.verify,
        })
        .click()
}

test('sign-in from the landing comes back signed in', async ({ request }) => {
    await page.goto(`${LANDING_URL}/`)
    await expectNobody()
    await banner()
        .getByRole('link', {
            name: ui.landing.signIn,
        })
        .click()
    expect(page.url().startsWith(`${WEB_URL}/login`), page.url()).toBe(true)
    await enterCode(request)
    await expect(page).toHaveURL(`${LANDING_URL}/`)
    await expectSignedIn()
})

test('the session is one cookie on the whole domain, and id-web takes it', async () => {
    expect(await sessionCookie()).toMatchObject({
        domain: `.${LANDING_HOST}`,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
    })
    await page.goto(`${WEB_URL}/account`)
    await expect(page).toHaveURL(`${WEB_URL}/account`)
    await expect(page.getByText(ui.account.email(email))).toBeVisible()
    await expect(page.getByText(ui.account.thisDevice)).toBeVisible()
})

test('sign-out on the landing ends the session on both sites', async () => {
    await page.goto(`${LANDING_URL}/`)
    const session = (await sessionCookie()) as Cookie
    await banner()
        .getByRole('button', {
            name: ui.landing.signOut,
        })
        .click()
    await expectNobody()
    expect(await sessionCookie()).toBeUndefined()
    await page.goto(`${WEB_URL}/account`)
    await expect(page).toHaveURL(/\/login(\?|$)/)

    // The old cookie again: id-api has ended the session, not only this browser forgotten it.
    await context.addCookies([
        session,
    ])
    await page.goto(`${LANDING_URL}/`)
    await expectNobody()
    expect(await sessionCookie()).toBeUndefined()
})

test('sign-out on id-web ends the session on the landing too', async ({ request }) => {
    // Another address: this one has just had a code, and a new one comes after a pause.
    const other = newEmail()
    await page.goto(`${WEB_URL}/login`)
    await enterCode(request, other)
    await expect(page).toHaveURL(`${WEB_URL}/account`)
    await page.goto(`${LANDING_URL}/`)
    await expectSignedIn(other)

    await page.goto(`${WEB_URL}/account`)
    await banner()
        .getByRole('button', {
            name: ui.nav.signOut,
        })
        .click()
    await expect(page).toHaveURL(/\/login$/)
    await page.goto(`${LANDING_URL}/`)
    await expectNobody()
})

test('the language chosen on one site holds on the other, in a cookie on the whole domain', async () => {
    await page.goto(`${WEB_URL}/login?lang=ru`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    expect((await context.cookies()).find(cookie => cookie.name === LOCALE_COOKIE)).toMatchObject({
        domain: `.${LANDING_HOST}`,
        value: 'ru',
    })
    await page.goto(`${LANDING_URL}/`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')

    await page.goto(`${LANDING_URL}/?lang=en`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.goto(`${WEB_URL}/login`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})
