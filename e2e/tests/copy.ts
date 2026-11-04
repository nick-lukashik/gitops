/**
 * The texts the scenario finds things by, in English: id-web's UI
 * (src/i18n/messages/en.json) and notifications-api's email subjects
 * (src/mail/templates.ts). A copy change in a deploy fails the step that
 * uses it; update the text here in the same PR.
 */
export const ui = {
    login: {
        email: 'Email',
        send: 'Send the code',
        code: 'Code from the email',
        verify: 'Sign in',
        resend: 'Send a new code',
        errors: {
            unavailable: 'Sign-in is unavailable right now. Try again a little later.',
            deliveryFailed: 'The code could not be sent. Try again in a minute.',
            rateLimited: /^Too many attempts\./,
        },
    },
    nav: {
        signOut: 'Sign out',
    },
    account: {
        /** "Email: {email}" in the profile card. */
        email: (address: string) => `Email: ${address}`,
        sessions: 'Signed-in devices',
        /** The end of the current session's line in the devices list. */
        thisDevice: /· this device$/,
        unavailable: 'The account is unavailable right now. Try again a little later.',
    },
    wallet: {
        buy: 'Buy',
        coins: (count: number) => `${count} coins`,
        unavailable: 'Unavailable right now.',
        historyUnavailable: 'The history is unavailable right now.',
    },
    payments: {
        /** A payment's line on /payments ends with its status. */
        waiting: 'Waiting for payment',
    },
    /** The error page of a render that failed (src/app/error.tsx): no state the design has for an outage. */
    crash: 'Something went wrong',
    fakePay: {
        pay: 'Confirm the payment',
        done: 'This payment is already finished.',
    },
}

export const subjects = {
    /** "123456 is your sign-in code". */
    signInCode: /^(\d{6}) is your sign-in code$/,
    receipt: (coins: number) => `Payment received: ${coins} coins`,
    anyReceipt: /^Payment received: /,
}
