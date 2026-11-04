import { subjects, ui } from '../copy'
import { subjectsTo } from '../mailpit'
import {
    confirmPayment,
    expect,
    expectAccount,
    expectBalance,
    expectCreditedOnce,
    expectNoCrash,
    kill,
    psql,
    signIn,
    start,
    startCheckout,
    stop,
    test,
} from './harness'

test.describe('the broker and the consumer @failure', () => {
    test('the broker stops during a payment and returns: the credit arrives afterwards, exactly once', async ({
        newPerson,
        request,
    }) => {
        const person = await newPerson()
        const { page, email } = person
        await signIn(person, request)
        await startCheckout(page, '550 coins (+10%)')

        await stop('rabbitmq')

        // The payment commits with its event in the outbox; nothing can carry it yet.
        await confirmPayment(page)
        await expect(page).toHaveURL(/\/wallet\?paid=1$/)
        await page.waitForTimeout(3_000)
        await expectBalance(page, 0, 10_000)

        // Sign-in needs no broker: its event waits in the outbox too.
        const newcomer = await newPerson()
        await signIn(newcomer, request)
        await expectAccount(newcomer.page, newcomer.email)

        await start('rabbitmq')

        await expectCreditedOnce(page, 550)
        const receipts = async () => (await subjectsTo(request, email)).filter(s => subjects.anyReceipt.test(s))
        await expect
            .poll(receipts, {
                message: 'one receipt email',
                timeout: 30_000,
            })
            .toEqual([
                subjects.receipt(550),
            ])

        // An event already in the queue when the broker stops: the queue keeps it.
        await startCheckout(page, '100 coins')
        await stop('wallet-api')
        await confirmPayment(page)
        await expect(page).toHaveURL(/\/wallet\?paid=1$/)
        await expect
            .poll(() => psql('pay', "select count(*) from outbox where status = 'pending'"), {
                message: 'pay-api published the event',
                timeout: 30_000,
            })
            .toBe('0')
        await stop('rabbitmq')
        await start('rabbitmq')
        await start('wallet-api')
        await expectBalance(page, 650)
        await page.waitForTimeout(5_000)
        await expectBalance(page, 650, 10_000)
    })

    test('wallet-api is killed and restarted in the middle of the flow: exactly once', async ({
        newPerson,
        request,
    }) => {
        const person = await newPerson()
        const { page } = person
        await signIn(person, request)
        await startCheckout(page, '550 coins (+10%)')

        // At the moment the event may be on its way or in the middle of its transaction.
        await Promise.all([
            confirmPayment(page),
            kill('wallet-api'),
        ])
        await expect(page).toHaveURL(/\/wallet\?paid=1$/)
        // While it is down the page says so. Read afresh: the first render may be from before the kill.
        await page.goto('/wallet?currency=USD')
        await expect(page.getByText(ui.wallet.unavailable).first()).toBeVisible()
        await expectNoCrash(page)
        await start('wallet-api')
        await expectCreditedOnce(page, 550)

        // And with the event waiting in the queue the whole time.
        await startCheckout(page, '100 coins')
        await kill('wallet-api')
        await confirmPayment(page)
        await expect(page).toHaveURL(/\/wallet\?paid=1$/)
        await start('wallet-api')
        await expectBalance(page, 650)
        await page.waitForTimeout(5_000)
        await expectBalance(page, 650, 10_000)
    })
})
