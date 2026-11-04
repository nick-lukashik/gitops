import { expect, findings, test } from './harness'

// The check of every scenario's logs (harness.ts) against lines made up here:
// a rule that stopped matching would pass every scenario in silence.
test.describe('the log check @failure', () => {
    const email = 'e2e-0190b5a0-7c3e-7d5a-9f2b-1c2d3e4f5a6b@example.com'
    const jwt = [
        'eyJhbGciOiJFUzI1NiJ9',
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        'c2lnbmF0dXJlLW9mLXRoZS10b2tlbg',
    ].join('.')
    const refresh = `0190b5a0-7c3e-7d5a-9f2b-1c2d3e4f5a6b.${'A'.repeat(43)}`
    const secret = 'f'.repeat(64)

    for (const [what, line] of [
        [
            'an email',
            `{"msg":"code sent","to":"${email}"}`,
        ],
        [
            'an email in a URL',
            `{"url":"/users?email=${email.replace('@', '%40')}"}`,
        ],
        [
            'a sign-in code',
            '{"msg":"sending","code":"123456"}',
        ],
        [
            'a sign-in code as a number',
            '{"msg":"sending","code":123456}',
        ],
        [
            'a sign-in code in a subject',
            '123456 is your sign-in code',
        ],
        [
            'a JWT',
            `{"token":"${jwt}"}`,
        ],
        [
            'a bearer token',
            `authorization: Bearer ${'x'.repeat(40)}`,
        ],
        [
            'a refresh token',
            `{"refreshToken":"${refresh}"}`,
        ],
        [
            'a connection string',
            'connect postgres://id:hunter2hunter2@postgres:5432/id failed',
        ],
        [
            'a password of the run',
            `FATAL: bad value ${secret} for option`,
        ],
        [
            'a private key',
            '-----BEGIN PRIVATE KEY-----',
        ],
    ] as const) {
        test(`catches ${what}, and does not repeat it`, () => {
            const found = findings(
                [
                    line,
                ],
                [
                    '123456',
                ],
                [
                    secret,
                ],
            )
            expect(found).toHaveLength(1)
            for (const value of [
                email,
                '123456',
                jwt,
                refresh,
                secret,
                'hunter2hunter2',
            ])
                expect(found[0]).not.toContain(value)
        })
    }

    test('leaves ordinary lines alone', () => {
        expect(
            findings(
                [
                    '2026-11-05 01:02:03.123456+00:00 [info] <0.123.0> started',
                    '{"req":{"method":"POST","url":"/api/v1/login/email"},"res":{"statusCode":202},"responseTime":12}',
                    '{"context":"Redis","err":"connect ECONNREFUSED 192.168.97.3:6379"}',
                    '{"requestId":"0190b5a0-7c3e-7d5a-9f2b-1c2d3e4f5a6b"}',
                    '{"key":"1234567"}',
                ],
                [
                    '123456',
                ],
                [
                    'f'.repeat(64),
                ],
            ),
        ).toEqual([])
    })
})
