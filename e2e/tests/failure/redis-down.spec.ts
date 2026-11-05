import { ui } from '../copy'
import { everySignInCode, signInCode, subjectsTo } from '../mailpit'
import {
    ACCESS_TTL_MS,
    alert,
    emailField,
    expect,
    expectAccount,
    expectBalance,
    expectNoCrash,
    expectPagesHold,
    expectSessionOver,
    logsOf,
    pastRefreshThreshold,
    requestCode,
    sessionCookie,
    signIn,
    signOut,
    signOutRefused,
    start,
    stop,
    submitCode,
    test,
} from './harness'

test.describe('Redis stops @failure', () => {
    test('sign-in refuses without sending, existing pages keep working, and it recovers by itself', async ({
        newPerson,
        request,
    }) => {
        // Before the outage: one person signed in, one on the code step.
        const signedIn = await newPerson()
        await signIn(signedIn, request)
        const onCodeStep = await newPerson()
        await requestCode(onCodeStep.page, onCodeStep.email)
        await expect(onCodeStep.page.getByLabel(ui.login.code)).toBeVisible()
        const code = await signInCode(request, onCodeStep.email)
        const newcomer = await newPerson()
        const codes = (await everySignInCode(request)).length

        await stop('redis')

        // A code request: no limit can be applied, so an error and no email.
        await requestCode(newcomer.page, newcomer.email)
        await expect(alert(newcomer.page, ui.login.errors.unavailable)).toBeVisible()
        await expectNoCrash(newcomer.page)

        // A code that is right: the same, and it stays usable.
        await submitCode(onCodeStep.page, code)
        await expect(alert(onCodeStep.page, ui.login.errors.unavailable)).toBeVisible()
        await expectNoCrash(onCodeStep.page)

        // No code went out, also not a little later. Welcome emails of the people above
        // may: they are not sign-in and have no limit to apply.
        await newcomer.page.waitForTimeout(3_000)
        expect(await everySignInCode(request), 'code emails sent while Redis was down').toHaveLength(codes)
        expect(await subjectsTo(request, newcomer.email), 'emails to the person refused').toEqual([])

        // The signed-in person: the access token still opens the pages.
        await signedIn.page.goto('/account')
        await expectAccount(signedIn.page, signedIn.email)
        await expectBalance(signedIn.page, 0, 10_000)
        await expectPagesHold(signedIn.page)

        // Past its end nothing can renew it: the page says so or asks to sign in again,
        // and the session is kept for when Redis returns.
        await signedIn.page.waitForTimeout(ACCESS_TTL_MS)
        await signedIn.page.goto('/account')
        await expect(alert(signedIn.page, ui.account.unavailable).or(emailField(signedIn.page))).toBeVisible()
        await expectNoCrash(signedIn.page)
        await sessionCookie(signedIn)

        await start('redis')

        // Without a restart of anything: the session, the waiting code, a new sign-in.
        await expect(async () => {
            await signedIn.page.goto('/account')
            await expectAccount(signedIn.page, signedIn.email)
        }).toPass({
            timeout: 30_000,
        })
        await expect(async () => {
            await submitCode(onCodeStep.page, code)
            await expect(onCodeStep.page).toHaveURL(/\/account$/)
        }).toPass({
            timeout: 30_000,
        })
        await signIn(newcomer, request)
    })

    // Not a 500: a store that is down is no internal error, and is not logged as one.
    test('a refresh during the outage is a 503, the answer for a dependency that is down', async ({
        newPerson,
        request,
    }) => {
        const person = await newPerson()
        await signIn(person, request)
        const refreshes = async () =>
            (await logsOf('id-api'))
                .split('\n')
                .filter(line => line.includes('/sessions/refresh') && line.includes('statusCode'))
        const before = (await refreshes()).length

        await stop('redis')
        await pastRefreshThreshold(person.page)
        await person.page.goto('/account')
        await expectAccount(person.page, person.email)
        await expect.poll(async () => (await refreshes()).length).toBeGreaterThan(before)
        await start('redis')

        const during = (await refreshes()).slice(before).map(line => /"statusCode":(\d+)/.exec(line)?.[1])
        expect([
            ...new Set(during),
        ]).toEqual([
            '503',
        ])
    })

    test('sign-out during the outage says so, keeps the session, and works once Redis is back', async ({
        newPerson,
        request,
    }) => {
        const person = await newPerson()
        // After a scenario that stopped Redis: id-api's client reconnects a moment after it is healthy.
        await expect(() => signIn(person, request)).toPass({
            timeout: 60_000,
        })
        const { page, email } = person

        await stop('redis')
        await signOutRefused(person)
        await start('redis')

        // Until id-api's client has reconnected, a sign-out is refused the same way.
        const cookie = await sessionCookie(person)
        await expect(async () => {
            await page.goto('/account')
            await expectAccount(page, email)
            await signOut(page)
        }).toPass({
            timeout: 60_000,
        })
        await expectSessionOver(person, cookie)
    })
})
