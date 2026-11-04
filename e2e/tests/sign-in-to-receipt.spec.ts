import { randomUUID } from 'node:crypto'
import { type BrowserContext, type Cookie, expect, type Page, test } from '@playwright/test'
import { subjects, ui } from './copy'
import { signInCode, subjectsTo } from './mailpit'

// One person's way through the deployed set, in one browser: every test starts
// where the previous one ended, and a failed one skips the rest.
test.describe.configure({
    mode: 'serial',
})

const email = `e2e-${randomUUID()}@example.com`
let context: BrowserContext
let page: Page

test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    page = await context.newPage()
})

test.afterAll(async () => {
    await context.close()
})

/** The wallet page until it shows the balance: credits arrive through the broker, a moment after the payment. */
async function expectBalance(coins: number) {
    await expect(async () => {
        await page.goto('/wallet?currency=USD')
        await expect(
            page.getByText(ui.wallet.coins(coins), {
                exact: true,
            }),
        ).toBeVisible({
            timeout: 1_000,
        })
    }).toPass({
        timeout: 20_000,
    })
}

/** Buys the pack with this title on the wallet page; ends on the test provider's checkout page. */
async function startCheckout(title: string, price: string) {
    await page.goto('/wallet?currency=USD')
    await page
        .getByRole('listitem')
        .filter({
            has: page.getByText(title, {
                exact: true,
            }),
        })
        .getByRole('button', {
            name: ui.wallet.buy,
        })
        .click()
    await expect(page).toHaveURL(/\/payments\/fake\/[0-9a-f-]{36}$/)
    await expect(page.getByText(price)).toBeVisible()
}

/** Exact: "Language of emails" on the account page and "Code from the email" contain the word too. */
const emailField = (on: Page) =>
    on.getByLabel(ui.login.email, {
        exact: true,
    })

async function confirmPayment(on: Page) {
    await on
        .getByRole('button', {
            name: ui.fakePay.pay,
        })
        .click()
}

/** The exact total and one history entry per pack, read afresh. */
async function expectCredits() {
    await expectBalance(650)
    for (const amount of [
        '+550',
        '+100',
    ])
        await expect(
            page.getByRole('main').getByText(amount, {
                exact: true,
            }),
        ).toHaveCount(1)
}

test('sign-in with the code from the email', async ({ request }) => {
    await page.goto('/login?lang=en')
    await emailField(page).fill(email)
    await page
        .getByRole('button', {
            name: ui.login.send,
        })
        .click()
    await expect(page.getByLabel(ui.login.code)).toBeVisible()
    await page.getByLabel(ui.login.code).fill(await signInCode(request, email))
    await page
        .getByRole('button', {
            name: ui.login.verify,
        })
        .click()
    await expect(page).toHaveURL(/\/account$/)
})

test('the account page shows the user and this session', async () => {
    await expect(page.getByText(ui.account.email(email))).toBeVisible()
    await expect(page.getByText(ui.account.thisDevice)).toBeVisible()
})

test('a new wallet has 0 coins', async () => {
    await page.goto('/wallet?currency=USD')
    await expect(
        page.getByText(ui.wallet.coins(0), {
            exact: true,
        }),
    ).toBeVisible()
})

test('a pack paid with the test provider is credited exactly once', async () => {
    await startCheckout('550 coins (+10%)', '$5.00')
    const checkout = page.url()
    // The same checkout in a second tab: its button is pressed after the payment went through.
    const again = await context.newPage()
    await again.goto(checkout)

    await confirmPayment(page)
    await expect(page).toHaveURL(/\/wallet\?paid=1$/)
    await expectBalance(550)

    // The completion a second time: pay-api ignores it. What id-web shows for it
    // may change; the balance may not.
    await confirmPayment(again)
    await expect(again).toHaveURL(/\/(wallet\?paid=1|payments\?error=payment)$/)
    await again.goto(checkout)
    await expect(again.getByRole('status')).toHaveText(ui.fakePay.done)
    await again.close()

    // Another pack, seconds after the repeat: a second credit of the first
    // would have landed before this one, and 650 is no sum that includes it.
    await startCheckout('100 coins', '$1.00')
    await confirmPayment(page)
    await expect(page).toHaveURL(/\/wallet\?paid=1$/)
    await expectCredits()

    // A duplicate published late (a slower outbox retry) lands after the read above.
    await page.waitForTimeout(3_000)
    await expectCredits()
})

test('one receipt email per payment', async ({ request }) => {
    const receipts = async () => (await subjectsTo(request, email)).filter(subject => subjects.anyReceipt.test(subject))
    await expect
        .poll(receipts, {
            message: `receipt emails to ${email} in Mailpit (pay-api → broker → notifications-api → SMTP)`,
            timeout: 20_000,
        })
        .toEqual(
            expect.arrayContaining([
                subjects.receipt(550),
                subjects.receipt(100),
            ]),
        )
    expect((await receipts()).sort()).toEqual([
        subjects.receipt(100),
        subjects.receipt(550),
    ])
})

test('sign-out ends the session', async () => {
    await page.goto('/account')
    const session = (await context.cookies()).find(cookie => cookie.name === 'id_session') as Cookie
    expect(session, 'the session cookie (http: no __Host- prefix)').toBeDefined()
    await page
        .getByRole('banner')
        .getByRole('button', {
            name: ui.nav.signOut,
        })
        .click()
    await expect(page).toHaveURL(/\/login$/)
    expect((await context.cookies()).map(cookie => cookie.name)).not.toContain('id_session')
    await page.goto('/account')
    await expect(page).toHaveURL(/\/login$/)

    // The old cookie again. id-api has ended the session, so it is no longer
    // this device's; its access token (a JWT) may open the page until it expires.
    await context.addCookies([
        session,
    ])
    await page.goto('/account')
    await expect(
        page
            .getByRole('heading', {
                name: ui.account.sessions,
            })
            .or(emailField(page)),
    ).toBeVisible()
    await expect(page.getByText(ui.account.thisDevice)).toHaveCount(0)
})
