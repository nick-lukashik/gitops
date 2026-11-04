import { type APIRequestContext, expect } from '@playwright/test'
import { subjects } from './copy'
import { MAILPIT_URL } from './stack'

type Summary = {
    ID: string
    Subject: string
}

/** Subjects of every email Mailpit holds for the address, newest first (Mailpit API v1 search). */
export async function subjectsTo(request: APIRequestContext, address: string): Promise<string[]> {
    const response = await request.get(`${MAILPIT_URL}/api/v1/search`, {
        params: {
            query: `to:"${address}"`,
        },
    })
    expect(response.ok(), 'Mailpit search').toBe(true)
    const body = (await response.json()) as {
        messages: Summary[]
    }
    return body.messages.map(message => message.Subject)
}

/**
 * The code of the newest sign-in email to the address. The email is the only
 * proof that id-api's call to notifications-api and the SMTP send worked:
 * id-web shows the code step either way.
 */
export async function signInCode(request: APIRequestContext, address: string): Promise<string> {
    const code = async () =>
        (await subjectsTo(request, address)).map(subject => subjects.signInCode.exec(subject)?.[1]).find(Boolean)
    await expect
        .poll(code, {
            message: `a sign-in code email to ${address} in Mailpit (id-api → notifications-api → SMTP)`,
            timeout: 15_000,
        })
        .toMatch(/^\d{6}$/)
    return (await code()) as string
}
