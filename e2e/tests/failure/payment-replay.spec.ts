import { type Request } from '@playwright/test'
import { subjects, ui } from '../copy'
import { subjectsTo } from '../mailpit'
import {
    compose,
    confirmPayment,
    expect,
    expectCreditedOnce,
    kill,
    logsOf,
    packForm,
    psql,
    signIn,
    start,
    startCheckout,
    test,
} from './harness'

/** tsconfig has no DOM types. */
type HiddenInput = {
    value: string
}

test.describe('payment replays @failure', () => {
    test("the fake provider's completion repeated: still one credit", async ({ newPerson, request }) => {
        const person = await newPerson()
        const { context, page } = person
        await signIn(person, request)
        await startCheckout(page, '550 coins (+10%)')
        const checkout = page.url()
        const paymentId = checkout.split('/').at(-1) as string
        const completions = async () =>
            (await logsOf('pay-api')).split('\n').filter(line => line.includes(`${paymentId}/fake-complete`)).length

        // Two tabs press pay at once.
        const again = await context.newPage()
        await again.goto(checkout)
        const posts: Request[] = []
        page.on('request', sent => {
            if (sent.method() === 'POST') posts.push(sent)
        })
        await Promise.all([
            confirmPayment(page),
            confirmPayment(again),
        ])
        await expect(page).toHaveURL(/\/wallet\?paid=1$/)
        await expectCreditedOnce(page, 550)

        // The very request of the first press, sent again: over id-web, to pay-api.
        const press = posts.find(post => post.url() === checkout)
        expect(press, 'the POST of the pay button').toBeDefined()
        const before = await completions()
        for (const _ of [
            1,
            2,
        ]) {
            // From the page: only the browser knows the site's name (playwright.config.ts). The
            // browser adds the cookies and leaves out the headers a page may not set.
            const status = await page.evaluate(
                async ({ url, headers, body }) =>
                    (
                        await fetch(url, {
                            method: 'POST',
                            headers,
                            body,
                            redirect: 'manual',
                        })
                    ).status,
                {
                    url: (press as Request).url(),
                    headers: await (press as Request).allHeaders(),
                    body: (press as Request).postData(),
                },
            )
            expect(status, 'the replay reached the action').toBeLessThan(500)
        }
        await expect.poll(completions, 'the replays reached pay-api').toBe(before + 2)
        await expectCreditedOnce(page, 550)

        // The event itself published again, as after a crash between publish and mark:
        // the same eventId reaches wallet-api and notifications-api a second time.
        const eventId = await psql(
            'pay',
            `select event_id from outbox where envelope->'payload'->>'paymentId' = '${paymentId}'`,
        )
        expect(eventId, 'the one event of the payment').toMatch(/^[0-9a-f-]{36}$/)
        const handled = async (service: string) =>
            (await logsOf(service)).split('\n').filter(line => line.includes(eventId) && line.includes('Event handled'))
                .length
        await expect.poll(() => handled('notifications-api'), 'the event reached notifications-api').toBe(1)
        expect(await handled('wallet-api'), 'the event reached wallet-api').toBe(1)
        await psql(
            'pay',
            `update outbox set status = 'pending', published_at = null, available_at = now() where event_id = '${eventId}'`,
        )
        for (const service of [
            'wallet-api',
            'notifications-api',
        ])
            await expect
                .poll(() => handled(service), {
                    message: `${service} got the event again`,
                    timeout: 30_000,
                })
                .toBe(2)
        await expectCreditedOnce(page, 550)
        // The receipt's job has its time; a second one would show now.
        await page.waitForTimeout(5_000)
        const receipts = await subjectsTo(request, person.email)
        expect(receipts.filter(subject => subjects.anyReceipt.test(subject))).toEqual([
            subjects.receipt(550),
        ])
    })

    test('pay-api restarts in the middle of a checkout: the retry with the same key ends in one payment', async ({
        newPerson,
        request,
    }) => {
        const person = await newPerson()
        const { page } = person
        await signIn(person, request)
        // pay-api has fetched id-api's keys, which it needs before the payment row.
        await page.goto('/payments')
        await page.goto('/wallet?currency=USD')
        const pack = packForm(page, '550 coins (+10%)')
        const key = await pack.locator('input[name="idempotencyKey"]').inputValue()
        const statusOfKey = () => psql('pay', `select status from payments where idempotency_key = '${key}'`)

        // The checkout stops at its call for the buyer's address, its row committed.
        await compose('pause', 'id-api')
        const press = pack
            .getByRole('button', {
                name: ui.wallet.buy,
            })
            .click()
        await expect.poll(statusOfKey, 'the payment row of the first attempt').toBe('created')
        await kill('pay-api')
        await compose('unpause', 'id-api')
        await press
        await expect(page).toHaveURL(/\/wallet\?error=checkout/, {
            timeout: 30_000,
        })
        await start('pay-api')

        // The retry: the same form, the same key.
        await page.goto('/wallet?currency=USD')
        await pack.locator('input[name="idempotencyKey"]').evaluate((input, value) => {
            ;(input as unknown as HiddenInput).value = value
        }, key)
        await pack
            .getByRole('button', {
                name: ui.wallet.buy,
            })
            .click()
        await expect(page).toHaveURL(/\/payments\/fake\/[0-9a-f-]{36}$/)
        const paymentUrl = page.url()

        // One payment of this person, on the page and in the table.
        await page.goto('/payments')
        await expect(page.getByText(ui.payments.waiting)).toHaveCount(1)
        expect(
            await psql(
                'pay',
                `select count(*) from payments where user_id = (select user_id from payments where idempotency_key = '${key}')`,
            ),
        ).toBe('1')

        await page.goto(paymentUrl)
        await confirmPayment(page)
        await expect(page).toHaveURL(/\/wallet\?paid=1$/)
        await expectCreditedOnce(page, 550)
    })
})
