import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'

/** The failure scenarios (failure/) with ../compose.failure.yaml on top, not the deploy-PR suite. */
export const FAILURE_SUITE = process.env.E2E_SUITE === 'failure'

/**
 * Project name and host ports: the environment or today's defaults, so runs
 * from two worktrees can be up at once. They reach compose through ../.env.
 */
const place = {
    COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME || 'nl-e2e',
    E2E_WEB_PORT: process.env.E2E_WEB_PORT || '3900',
    E2E_MAILPIT_PORT: process.env.E2E_MAILPIT_PORT || '3901',
    E2E_WEB_2_PORT: process.env.E2E_WEB_2_PORT || '3902',
}

/** id-web and Mailpit's API on the host: the ports of ../compose.yaml. */
export const WEB_URL = `http://localhost:${place.E2E_WEB_PORT}`
export const MAILPIT_URL = `http://127.0.0.1:${place.E2E_MAILPIT_PORT}`
/** The second id-web of ../compose.failure.yaml. Cookies ignore the port: a browser's session is on both. */
export const WEB_2_URL = `http://localhost:${place.E2E_WEB_2_PORT}`

export const E2E = path.resolve(import.meta.dirname, '..')
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
 * apps/<service>/prod, and the pin of ../pay-api.env until pay-api is in it.
 * The same variable in the environment replaces one (a candidate image); an
 * empty one counts as unset.
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
    const result: Record<string, string> = {
        ...(parseEnv(readFileSync(path.join(E2E, 'pay-api.env'), 'utf8')) as Record<string, string>),
        ...Object.fromEntries(deployed),
    }
    for (const key of Object.keys(result)) {
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

/** The compose files of a failure run; a local override is not merged by itself once COMPOSE_FILE is set. */
function failureFiles(): Record<string, string> {
    const files = [
        'compose.yaml',
        'compose.failure.yaml',
        ...(existsSync(path.join(E2E, 'compose.override.yaml'))
            ? [
                  'compose.override.yaml',
              ]
            : []),
    ]
    return {
        COMPOSE_FILE: files.join(':'),
    }
}

/**
 * Global setup: ../.env with the place of this run, the images and fresh
 * secrets, then the stack up and healthy (migrations first, as in the
 * cluster). What a killed run left behind goes first. The returned teardown
 * saves the logs to test-results/compose.log and removes the stack, unless
 * E2E_KEEP=1 keeps it for a look (`docker compose down -v` in e2e/).
 */
export default function setup() {
    const env = {
        ...images(),
        ...secrets(),
    }
    // Double quotes: compose reads \n in them as a newline (the PEM).
    const lines = Object.entries({
        ...place,
        ...(FAILURE_SUITE ? failureFiles() : {}),
        ...env,
    }).map(([key, value]) => `${key}="${value.replaceAll('\n', '\\n')}"`)
    writeFileSync(
        path.join(E2E, '.env'),
        `# Written by tests/stack.ts for one run: never commit.\n${lines.join('\n')}\n`,
        {
            mode: 0o600,
        },
    )
    console.log('Images (the deployed set, the pay-api pin, overrides from the environment):')
    for (const [key, value] of Object.entries(env)) if (key.endsWith('_IMAGE')) console.log(`  ${key}=${value}`)

    const remove = () => compose('down', '--volumes', '--remove-orphans', '--timeout', '5')
    const keep = process.env.E2E_KEEP === '1'
    const down = () => {
        if (!keep) remove()
    }
    remove()
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
