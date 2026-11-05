import { subjects, ui } from '../copy'
import { signInCode, subjectsTo } from '../mailpit'
import { alert, emailField, expect, expectNoCrash, requestCode, start, stop, submitCode, test } from './harness'

test.describe('SMTP down @failure', () => {
    test('the code step says the code could not be sent; with Mailpit back a new code arrives', async ({
        newPerson,
        request,
    }) => {
        const { page, email } = await newPerson()

        await stop('mailpit')

        // No code is coming: an error on step 1, not the wait on step 2.
        await requestCode(page, email)
        await expect(alert(page, ui.login.errors.deliveryFailed)).toBeVisible()
        await expect(emailField(page)).toBeVisible()
        await expectNoCrash(page)

        await start('mailpit')

        // The cooldown of the failed attempt runs, then a new request goes out.
        await expect(async () => {
            await requestCode(page, email)
            await expect(page.getByLabel(ui.login.code)).toBeVisible({
                timeout: 2_000,
            })
        }).toPass({
            intervals: [
                5_000,
            ],
            timeout: 90_000,
        })
        await submitCode(page, await signInCode(request, email))
        await expect(page).toHaveURL(/\/account$/)
        // A new person also gets the welcome email, whenever its job runs: only codes count.
        const codes = (await subjectsTo(request, email)).filter(subject => subjects.signInCode.test(subject))
        expect(codes, 'one code: the attempt that failed is not sent later').toHaveLength(1)
    })

    test('a new code that cannot be sent: the code step says so, and the last code still works', async ({
        newPerson,
        request,
    }) => {
        const { page, email } = await newPerson()
        await requestCode(page, email)
        await expect(page.getByLabel(ui.login.code)).toBeVisible()
        const code = await signInCode(request, email)
        // The button counts id-api's cooldown down, then it can be pressed.
        const resend = page.getByRole('button', {
            name: ui.login.resend,
            exact: true,
        })
        await expect(resend).toBeEnabled({
            timeout: 70_000,
        })

        await stop('mailpit')

        await resend.click()
        await expect(alert(page, ui.login.errors.deliveryFailed)).toBeVisible()
        await expect(page.getByLabel(ui.login.code)).toBeVisible()
        await expectNoCrash(page)

        await start('mailpit')

        await submitCode(page, code)
        await expect(page).toHaveURL(/\/account$/)
    })
})
