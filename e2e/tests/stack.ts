import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** id-web and Mailpit's API on the host: the ports of ../compose.yaml. */
export const WEB_URL = 'http://localhost:3900'
export const MAILPIT_URL = 'http://127.0.0.1:3901'

/** Set for the test workers when pay-api is part of the stack. */
export const PAY_API_ENV = 'E2E_PAY_API'
export const NO_PAY_API =
    'pay-api is not in the stack: no apps/pay-api/prod in the deployed set and no PAY_API_IMAGE '
    + '(e.g. PAY_API_IMAGE=ghcr.io/nick-lukashik/pay-api:sha-<commit>)'

const E2E = path.resolve(import.meta.dirname, '..')
const REPO = path.resolve(E2E, '..')
const OUTPUT = path.join(import.meta.dirname, 'test-results')

const compose = (...args: string[]) =>
    execFileSync(
        'docker',
        [
            'compose',
            ...args,
        ],
        {
            cwd: E2E,
            stdio: 'inherit',
        },
    )

/** Every service's log of this run, for the report of a failed run. Never throws: the run's own error matters more. */
function saveLogs() {
    try {
        mkdirSync(OUTPUT, {
            recursive: true,
        })
        const logs = execFileSync(
            'docker',
            [
                'compose',
                'logs',
                '--no-color',
                '--timestamps',
            ],
            {
                cwd: E2E,
                maxBuffer: 256 * 1024 * 1024,
            },
        )
        writeFileSync(path.join(OUTPUT, 'compose.log'), logs)
    } catch (error) {
        console.warn(`No compose.log: ${(error as Error).message}`)
    }
}

/**
 * The deployed set: `<SERVICE>_IMAGE=<image>@<digest>` of every
 * apps/<service>/prod. The same variable in the environment replaces one
 * (a candidate image); an empty one counts as unset.
 */
function images(): Record<string, string> {
    const deployed = execFileSync(path.join(REPO, 'scripts/versions.sh'), [
        '--env',
    ])
        .toString()
        .trim()
        .split('\n')
        .map(line => [
            line.slice(0, line.indexOf('=')),
            line.slice(line.indexOf('=') + 1),
        ])
    const result: Record<string, string> = Object.fromEntries(deployed)
    for (const key of [
        ...Object.keys(result),
        'PAY_API_IMAGE',
    ]) {
        const override = process.env[key]
        if (override) result[key] = override
    }
    return result
}

/** Random values for one run: nothing here is a real secret or leaves the machine. */
function secrets(): Record<string, string> {
    const random = () => randomBytes(32).toString('hex')
    const { privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem',
        },
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem',
        },
    })
    return {
        POSTGRES_PASSWORD: random(),
        PG_ID_PASSWORD: random(),
        PG_NOTIFICATIONS_PASSWORD: random(),
        PG_WALLET_PASSWORD: random(),
        PG_PAY_PASSWORD: random(),
        REDIS_PASSWORD: random(),
        RABBITMQ_PASSWORD: random(),
        // id-api: the ES256 key of access tokens, the code pepper, its token for callers.
        ID_SIGNING_KEY_PEM: privateKey,
        ID_LOGIN_CODE_PEPPER: random(),
        ID_INTERNAL_TOKEN: random(),
        NOTIFICATIONS_INTERNAL_TOKEN: random(),
        WALLET_INTERNAL_TOKEN: random(),
        ID_WEB_SESSION_SECRET: random(),
    }
}

/**
 * Global setup: ../.env with the images and fresh secrets, then the stack up
 * and healthy (migrations first, as in the cluster). The returned teardown
 * saves the logs to test-results/compose.log and removes the stack, unless
 * E2E_KEEP=1 keeps it for a look (`docker compose -f e2e/compose.yaml down -v`).
 */
export default function setup() {
    const env = {
        ...images(),
        ...secrets(),
    }
    const pay = Boolean(env.PAY_API_IMAGE)
    process.env[PAY_API_ENV] = pay ? '1' : ''
    // Double quotes: compose reads \n in them as a newline (the PEM).
    const lines = Object.entries({
        ...env,
        ...(pay
            ? {
                  COMPOSE_PROFILES: 'pay',
              }
            : {}),
    }).map(([key, value]) => `${key}="${value.replaceAll('\n', '\\n')}"`)
    writeFileSync(
        path.join(E2E, '.env'),
        `# Written by tests/stack.ts for one run: never commit.\n${lines.join('\n')}\n`,
        {
            mode: 0o600,
        },
    )
    console.log('Images (the deployed set and overrides from the environment):')
    for (const [key, value] of Object.entries(env)) if (key.endsWith('_IMAGE')) console.log(`  ${key}=${value}`)
    // In GitHub Actions a warning annotation, so a green run says what it left out.
    if (!pay) console.log(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}Payment tests skip: ${NO_PAY_API}`)

    const keep = process.env.E2E_KEEP === '1'
    const down = () => {
        if (!keep) compose('down', '--volumes', '--remove-orphans', '--timeout', '5')
    }
    const started = Date.now()
    try {
        compose('up', '--detach', '--wait', '--wait-timeout', '300')
    } catch (error) {
        saveLogs()
        compose('ps', '--all')
        down()
        throw new Error('The stack did not become healthy; logs in test-results/compose.log', {
            cause: error,
        })
    }
    console.log(`Stack healthy in ${Math.round((Date.now() - started) / 1000)} s`)

    return () => {
        saveLogs()
        down()
    }
}
