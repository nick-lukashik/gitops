import { subjects, ui } from '../copy'
import { signInCode, subjectsTo } from '../mailpit'
import {
    alert,
    compose,
    confirmPayment,
    expect,
    expectAccount,
    expectBalance,
    expectCreditedOnce,
    expectNoCrash,
    expectPagesHold,
    expectSessionOver,
    pastRefreshThreshold,
    REFRESH_GRACE_MS,
    requestCode,
    sessionCookie,
    signIn,
    signOut,
    signOutRefused,
    start,
    startCheckout,
    stop,
    submitCode,
    test,
} from './harness'

test.describe('Postgres stops @failure', () => {
    test('requests during the outage show an unavailable state, and the APIs recover by themselves', async ({
        newPerson,
        request,
    }) => {
        const signedIn = await newPerson()
        await signIn(signedIn, request)
        const onCodeStep = await newPerson()
        await requestCode(onCodeStep.page, onCodeStep.email)
        await expect(onCodeStep.page.getByLabel(ui.login.code)).toBeVisible()
        const code = await signInCode(request, onCodeStep.email)
        const newcomer = await newPerson()

        await stop('postgres')

        await signedIn.page.goto('/account')
        await expect(alert(signedIn.page, ui.account.unavailable)).toBeVisible()
        await expectNoCrash(signedIn.page)

        await signedIn.page.goto('/wallet?currency=USD')
        await expect(signedIn.page.getByText(ui.wallet.unavailable).first()).toBeVisible()
        await expect(signedIn.page.getByText(ui.wallet.historyUnavailable)).toBeVisible()
        await expectNoCrash(signedIn.page)

        await expectPagesHold(signedIn.page)

        await requestCode(newcomer.page, newcomer.email)
        await expect(alert(newcomer.page, ui.login.errors.unavailable)).toBeVisible()
        await expectNoCrash(newcomer.page)

        await submitCode(onCodeStep.page, code)
        await expect(alert(onCodeStep.page, ui.login.errors.unavailable)).toBeVisible()
        await expectNoCrash(onCodeStep.page)

        await start('postgres')

        // Without a restart of anything: the waiting code works, a new person signs in and has a wallet.
        await expect(async () => {
            await submitCode(onCodeStep.page, code)
            await expect(onCodeStep.page).toHaveURL(/\/account$/, {
                timeout: 3_000,
            })
        }).toPass({
            timeout: 60_000,
        })
        const after = await newPerson()
        await expect(async () => {
            await signIn(after, request)
        }).toPass({
            timeout: 60_000,
        })
        await expectAccount(after.page, after.email)
        await expectBalance(after.page, 0, 30_000)

        // The background work is back too: outbox, consumers, the email jobs.
        await startCheckout(after.page, '550 coins (+10%)')
        await confirmPayment(after.page)
        await expectCreditedOnce(after.page, 550)
        await expect
            .poll(async () => (await subjectsTo(request, after.email)).filter(s => subjects.anyReceipt.test(s)), {
                message: 'the receipt email after the outage',
                timeout: 60_000,
            })
            .toEqual([
                subjects.receipt(550),
            ])

        // No service died on the way.
        const exited = await compose(
            'ps',
            '--all',
            '--status',
            'exited',
            '--status',
            'dead',
            '--format',
            '{{.Service}}',
        )
        expect(exited.split('\n').filter(service => service && !service.endsWith('-migrate'))).toEqual([])
    })

    // id-api reads the session in Postgres before it rotates the token in Redis: during an
    // outage it answers 503 and the token has not turned, so no later try counts as reuse.
    test('a session used during the outage is still signed in afterwards', async ({ newPerson, request }) => {
        const person = await newPerson()
        await signIn(person, request)
        const { page, email } = person

        await stop('postgres')

        // Two pages that try a refresh, further apart than its grace window.
        await pastRefreshThreshold(page)
        await page.goto('/account')
        await expect(alert(page, ui.account.unavailable)).toBeVisible()
        await page.waitForTimeout(REFRESH_GRACE_MS + 2_000)
        await page.goto('/account')
        await expect(alert(page, ui.account.unavailable)).toBeVisible()

        await start('postgres')

        await expect(async () => {
            await page.goto('/account')
            await expectAccount(page, email)
        }).toPass({
            timeout: 60_000,
        })
    })

    test('sign-out during the outage says so, keeps the session, and works once Postgres is back', async ({
        newPerson,
        request,
    }) => {
        const person = await newPerson()
        await signIn(person, request)
        const { page, email } = person

        await stop('postgres')
        await signOutRefused(person)
        await start('postgres')

        await expect(async () => {
            await page.goto('/account')
            await expectAccount(page, email)
        }).toPass({
            timeout: 60_000,
        })
        const cookie = await sessionCookie(person)
        await signOut(page)
        await expectSessionOver(person, cookie)
    })
})
