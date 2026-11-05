import { ui } from '../copy'
import { signInCode } from '../mailpit'
import { LANDING_URL, WEB_2_URL, WEB_URL } from '../stack'
import {
    expect,
    expectAccount,
    expectSessionOver,
    logsOf,
    pastRefreshThreshold,
    REFRESH_GRACE_MS,
    requestCode,
    sessionCookie,
    signIn,
    signOut,
    submitCode,
    test,
} from './harness'

test.describe('concurrency @failure', () => {
    test('two tabs of one session past the refresh threshold load at once: both stay signed in', async ({
        newPerson,
        request,
    }) => {
        const person = await newPerson()
        const { context, page, email } = person
        await signIn(person, request)
        const tabs = [
            page,
            await context.newPage(),
        ]

        for (const round of [
            1,
            2,
        ]) {
            await pastRefreshThreshold(page)
            const before = (await sessionCookie(person)).value
            await Promise.all(tabs.map(tab => tab.goto('/account')))
            for (const tab of tabs) await expectAccount(tab, email)
            expect((await sessionCookie(person)).value, `round ${round}: id-web refreshed the session`).not.toBe(before)
        }

        // What the tabs ended with is the current token, not one only the grace window accepts.
        await page.waitForTimeout(REFRESH_GRACE_MS + 2_000)
        await Promise.all(tabs.map(tab => tab.goto('/account')))
        for (const tab of tabs) {
            await expectAccount(tab, email)
            await expect(tab.getByText(ui.account.thisDevice)).toBeVisible()
        }
    })

    test('two sites of one session past the refresh threshold load at once: both stay signed in', async ({
        newPerson,
        request,
    }) => {
        // The landing calls the first id-api, the second id-web the second one: the race is on Redis.
        const person = await newPerson()
        const { context, page, email } = person
        await signIn(person, request)
        const landing = await context.newPage()
        const signedIn = () =>
            expect(
                landing.getByRole('banner').getByRole('link', {
                    name: email,
                }),
            ).toBeVisible()

        for (const round of [
            1,
            2,
        ]) {
            await pastRefreshThreshold(page)
            const before = (await sessionCookie(person)).value
            await Promise.all([
                page.goto(`${WEB_2_URL}/account`),
                landing.goto(`${LANDING_URL}/`),
            ])
            await expectAccount(page, email)
            await signedIn()
            expect((await sessionCookie(person)).value, `round ${round}: the session was refreshed`).not.toBe(before)
        }

        // What they ended with is the current token, not one only the grace window accepts.
        await page.waitForTimeout(REFRESH_GRACE_MS + 2_000)
        await Promise.all([
            page.goto(`${WEB_URL}/account`),
            landing.goto(`${LANDING_URL}/`),
        ])
        await expectAccount(page, email)
        await signedIn()
    })

    test('the answer to a refresh gets lost: past the grace window the old cookie still signs in', async ({
        newPerson,
        request,
    }) => {
        const person = await newPerson()
        const { context, page, email } = person
        await signIn(person, request)

        // id-api turns the token, and the browser never gets the new one: a closed tab, no network.
        await pastRefreshThreshold(page)
        const lost = await sessionCookie(person)
        await page.goto('/account')
        await expectAccount(page, email)
        expect((await sessionCookie(person)).value, 'id-web refreshed the session').not.toBe(lost.value)
        await page.waitForTimeout(REFRESH_GRACE_MS + 2_000)
        await context.addCookies([
            lost,
        ])

        await page.goto('/account')
        await expectAccount(page, email)
        await expect(page.getByText(ui.account.thisDevice)).toBeVisible()
        expect((await sessionCookie(person)).value, 'a new token').not.toBe(lost.value)

        // The session goes on with it.
        await pastRefreshThreshold(page)
        await page.goto('/account')
        await expectAccount(page, email)
        await expect(page.getByText(ui.account.thisDevice)).toBeVisible()
    })

    test('sign-in, refresh and sign-out work across two replicas of id-web and id-api', async ({
        newPerson,
        request,
    }) => {
        // The first id-web calls the first id-api, the second the second (compose.failure.yaml).
        const person = await newPerson()
        const { context, page, email } = person
        const refreshes = async (service: string) =>
            (await logsOf(service)).split('\n').filter(line => line.includes('/sessions/refresh')).length

        // The code is asked for on one replica and entered on the other.
        await requestCode(page, email, WEB_URL)
        await expect(page.getByLabel(ui.login.code)).toBeVisible()
        const code = await signInCode(request, email)
        await page.goto(`${WEB_2_URL}/login?lang=en`)
        await submitCode(page, code)
        await expect(page).toHaveURL(`${WEB_2_URL}/account`)
        await expectAccount(page, email)

        // A refresh on each, each from the token the other one issued.
        for (const [site, service] of [
            [
                WEB_URL,
                'id-api',
            ],
            [
                WEB_2_URL,
                'id-api-2',
            ],
            [
                WEB_URL,
                'id-api',
            ],
        ] as const) {
            const before = await refreshes(service)
            await pastRefreshThreshold(page)
            await page.goto(`${site}/account`)
            await expectAccount(page, email)
            await expect(page.getByText(ui.account.thisDevice)).toBeVisible()
            await expect.poll(() => refreshes(service), `${service} took the refresh`).toBeGreaterThan(before)
        }

        // Both at once, one tab on each replica.
        const second = await context.newPage()
        await pastRefreshThreshold(page)
        await Promise.all([
            page.goto(`${WEB_URL}/account`),
            second.goto(`${WEB_2_URL}/account`),
        ])
        await expectAccount(page, email)
        await expectAccount(second, email)
        await second.close()

        // Signed out through one replica, the session is over on the other.
        await page.goto(`${WEB_URL}/account`)
        const cookie = await sessionCookie(person)
        await signOut(page)
        await expect(page).toHaveURL(`${WEB_URL}/login`)
        await expectSessionOver(person, cookie, WEB_2_URL)
    })
})
