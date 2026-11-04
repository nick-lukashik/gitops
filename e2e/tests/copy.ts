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
    },
    wallet: {
        buy: 'Buy',
        coins: (count: number) => `${count} coins`,
    },
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
