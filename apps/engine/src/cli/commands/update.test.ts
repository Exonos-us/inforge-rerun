import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-cli-update-'))
process.env.RERUN_API_KEY = ''
process.env.RERUN_CODEX_PATH = '/usr/bin/codex'

const FAKE_HOME = mkdtempSync(resolve(tmpdir(), 'rerun-cli-update-home-'))
const RELEASE_ROOT = mkdtempSync(resolve(tmpdir(), 'rerun-cli-update-root-'))

const DROP_CACHES = '/proc/sys/vm/drop_caches'
const CHROMIUM = '/fake/ms-playwright/chromium/chrome'

type FakeLayout = { kind: 'release' | 'monorepo' | 'image'; root: string; packageDir: string }

const { ROOT, ENGINE_DIR } = await vi.hoisted(async () => {
    const { resolve: resolvePath } = await import('node:path')
    const ROOT = resolvePath(import.meta.dirname, '../../../../..')
    return { ROOT, ENGINE_DIR: resolvePath(ROOT, 'apps', 'engine') }
})

const state = vi.hoisted(() => ({
    calls: [] as string[],
    spawned: [] as Array<{ line: string; options: unknown }>,
    cwds: [] as (string | undefined)[],
    failing: [] as string[],
    outputs: {} as Record<string, string>,
    procPresent: false,
    chromium: 'installed' as 'installed' | 'missing' | 'no-path' | 'throws',
    layout: null as FakeLayout | null,
    desktop: true,
    downloadFails: false,
    verifyFails: false,
    freeSpaceFails: false,
    previousTarget: null as string | null,
    pruned: [] as string[],
    swept: [] as string[],
    layoutWritten: [] as string[],
}))

vi.mock('../../config/env.js', async importOriginal => ({ ...(await importOriginal<typeof import('../../config/env.js')>()), desktopEnabled: () => state.desktop }))

vi.mock('../../runtime/layout.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../runtime/layout.js')>()),
    detectLayout: () => state.layout ?? { kind: 'monorepo', root: ROOT, packageDir: ENGINE_DIR },
}))

vi.mock('node:child_process', () => ({
    execFileSync: (command: string, args: string[], options?: { cwd?: string; encoding?: string }) => {
        const line = `${command} ${args.join(' ')}`
        state.calls.push(line)
        state.cwds.push(options?.cwd)
        if (state.failing.some(prefix => line.startsWith(prefix))) throw new Error(`${command} exited with 1`)
        const output = state.outputs[line] ?? ''
        return options?.encoding ? output : Buffer.from(output)
    },
    spawn: (command: string, args: string[], options: unknown) => {
        state.spawned.push({ line: `${command} ${args.join(' ')}`, options })
        return { unref: () => {} }
    },
}))

vi.mock('node:fs', async importOriginal => {
    const real = await importOriginal<typeof import('node:fs')>()
    const existsSync = (path: string) => {
        if (path === '/proc/sys/vm/drop_caches') return state.procPresent
        if (path === '/fake/ms-playwright/chromium/chrome') return state.chromium === 'installed'
        return real.existsSync(path)
    }
    return { ...real, existsSync, default: { ...real, existsSync } }
})

// updateCliTools removes the Claude install under the home it runs in: never the developer's own.
vi.mock('node:os', async importOriginal => {
    const real = await importOriginal<typeof import('node:os')>()
    return { ...real, homedir: () => FAKE_HOME, default: { ...real, homedir: () => FAKE_HOME } }
})

vi.mock('patchright', () => ({
    chromium: {
        executablePath: () => {
            if (state.chromium === 'throws') throw new Error('no browsers')
            return state.chromium === 'no-path' ? '' : '/fake/ms-playwright/chromium/chrome'
        },
    },
}))

vi.mock('../../datadir/ladder.js', () => ({
    prepareDataDir: async () => {
        state.calls.push('<prepareDataDir>')
    },
}))

// The release mechanics have their own tests; here only their place in the sequence matters.
vi.mock('./release.js', async importOriginal => ({
    ...(await importOriginal<typeof import('./release.js')>()),
    requireFreeSpace: (dir: string, bytes?: number) => {
        state.calls.push(`<requireFreeSpace ${dir} ${bytes ?? 'default'}>`)
        if (state.freeSpaceFails) throw new Error('not enough free space')
    },
    downloadArtifact: async (url: string, dest: string, sha256: string) => {
        state.calls.push(`<download ${url} ${dest} ${sha256}>`)
        if (state.downloadFails) throw new Error('artifact checksum mismatch')
        return 42
    },
    extractArtifact: (tarball: string, dir: string) => {
        state.calls.push(`<extract ${tarball} ${dir}>`)
    },
    verifyRelease: (dir: string) => {
        state.calls.push(`<verify ${dir}>`)
        if (state.verifyFails) throw new Error('artifact built for win32')
    },
    switchCurrent: (root: string, dir: string) => {
        state.calls.push(`<switchCurrent ${root} ${dir}>`)
        return state.previousTarget
    },
    installLayout: (root: string) => {
        state.calls.push(`<installLayout ${root}>`)
        return state.layoutWritten
    },
    pruneReleases: (root: string) => {
        state.calls.push(`<prune ${root}>`)
        return state.pruned
    },
    sweepLegacyCheckout: (root: string) => {
        state.calls.push(`<sweep ${root}>`)
        return state.swept
    },
    rollbackRelease: (root: string) => {
        state.calls.push(`<rollback ${root}>`)
        return resolve(root, 'releases', 'previous-commit')
    },
}))

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')
const { installBrowser, installBrowserCommand, installBrowserInBackground, installDesktop, installDesktopInBackground, installLayoutCommand, removeLegacyClaudeCli, rollbackCommand, updateCliTools, updateCliToolsInBackground, updateCommand } = await import('./update.js')
const { CODEX_VERSION } = await import('../../runtime/codex-cli.js')
const { readLastUpdate, writeLastUpdate } = await import('../../runtime/last-update.js')
const { lastUpdatePath } = await import('../../config/paths.js')

const INSTALL_BROWSER = `${process.execPath} ${resolve(import.meta.dirname, '../bin.js')} install-browser`
const INSTALL_DESKTOP = `${process.execPath} ${resolve(import.meta.dirname, '../bin.js')} install-desktop`
const DESKTOP_APT = 'env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openbox x11vnc xdotool thunar xfce4-terminal adwaita-icon-theme tint2 hsetroot curl maim ffmpeg'
const UPDATE_CLI_TOOLS = `${process.execPath} ${resolve(import.meta.dirname, '../bin.js')} update-cli-tools`
const CODEX = `@openai/codex@${CODEX_VERSION}`
const CODEX_VERSION_CHECK = '/usr/bin/codex --version'
const RETURN_MEMORY = `sync; echo 3 > ${DROP_CACHES}; echo 1 > /proc/sys/vm/compact_memory`

const SHA = 'f'.repeat(64)
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56'
const URL = 'https://releases.example/engine.tar.gz'
const ARTIFACT_ARGS = ['--artifact', URL, '--sha256', SHA, '--commit', COMMIT]
const RELEASES = resolve(RELEASE_ROOT, 'releases')
const TARGET = resolve(RELEASES, COMMIT)
const TMP = resolve(RELEASES, `.tmp-${COMMIT}`)
const NEW_BIN = resolve(TARGET, 'dist', 'cli', 'bin.js')
const RELEASE_LAYOUT: FakeLayout = { kind: 'release', root: RELEASE_ROOT, packageDir: resolve(RELEASES, 'old0000') }

let out = ''

function asUser(uid: number) {
    vi.spyOn(process, 'getuid').mockReturnValue(uid)
}

beforeEach(() => {
    state.calls = []
    state.spawned = []
    state.cwds = []
    state.failing = []
    state.outputs = {}
    state.procPresent = false
    state.chromium = 'installed'
    state.layout = null
    state.desktop = true
    state.downloadFails = false
    state.verifyFails = false
    state.freeSpaceFails = false
    state.previousTarget = null
    state.pruned = []
    state.swept = []
    state.layoutWritten = []
    out = ''
    rmSync(RELEASES, { recursive: true, force: true })
    rmSync(lastUpdatePath(), { force: true })
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
        out += String(chunk)
        return true
    })
    vi.stubEnv('RERUN_SERVICE', undefined)
    asUser(1000)
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
})

describe('updateCommand from a git checkout', () => {
    it('pulls, installs, builds, installs the browser, refreshes the CLIs, migrates and restarts through sudo, in that order', async () => {
        await updateCommand([])

        expect(state.calls).toEqual([
            'git pull --ff-only',
            'pnpm --filter rerun-engine... install --prod=false --frozen-lockfile',
            'pnpm --filter rerun-engine... build',
            INSTALL_BROWSER,
            UPDATE_CLI_TOOLS,
            INSTALL_DESKTOP,
            '<prepareDataDir>',
            'command -v systemctl',
            'command -v sudo',
            'sudo systemctl restart rerun',
        ])
        expect(state.cwds.slice(0, 5)).toEqual([ROOT, ROOT, ROOT, ROOT, ROOT])
        expect(out).toContain('migrated data dir')
        expect(out).toContain('restarted rerun')
        expect(out).toContain('\n$ git pull --ff-only\n')
        expect(readLastUpdate()).toBeNull()
    })

    it('stops before building or migrating when git pull fails', async () => {
        state.failing = ['git pull']
        await expect(updateCommand([])).rejects.toThrow('git exited with 1')
        expect(state.calls).toEqual(['git pull --ff-only'])
    })

    it('stops when the build fails, before touching the database', async () => {
        state.failing = ['pnpm --filter rerun-engine... build']
        await expect(updateCommand([])).rejects.toThrow()
        expect(state.calls).not.toContain('<prepareDataDir>')
    })

    it('refuses to pull from an image, and tells to pull the image instead', async () => {
        state.layout = { kind: 'image', root: '/app', packageDir: '/app' }
        await expect(updateCommand([])).rejects.toThrow('installed from an image')
        expect(state.calls).toEqual([])
    })

    it('refuses to pull on a release layout, and asks for an artifact', async () => {
        state.layout = RELEASE_LAYOUT
        await expect(updateCommand([])).rejects.toThrow('pass --artifact')
        expect(state.calls).toEqual([])
    })

    it('skips the restart with --no-restart', async () => {
        await updateCommand(['--no-restart'])
        expect(state.calls.at(-1)).toBe('<prepareDataDir>')
        expect(out).toContain('skipping restart (--no-restart)')
    })

    it('tells the user to restart by hand when there is no systemctl', async () => {
        state.failing = ['command -v systemctl']
        await updateCommand([])
        expect(state.calls.at(-1)).toBe('command -v systemctl')
        expect(out).toContain('systemctl not found; restart the engine manually')
        expect(out).not.toContain('restarted')
    })

    it('restarts directly as root', async () => {
        asUser(0)
        await updateCommand([])
        expect(state.calls).not.toContain('sudo -n true')
        expect(state.calls).not.toContain('command -v sudo')
        expect(state.calls.at(-1)).toBe('systemctl restart rerun')
    })

    it('restarts directly when sudo is not installed', async () => {
        state.failing = ['command -v sudo', 'sudo -n true']
        await updateCommand([])
        expect(state.calls.at(-1)).toBe('systemctl restart rerun')
    })

    it('restarts the service named by RERUN_SERVICE', async () => {
        vi.stubEnv('RERUN_SERVICE', 'rerun-staging')
        await updateCommand([])
        expect(state.calls.at(-1)).toBe('sudo systemctl restart rerun-staging')
        expect(out).toContain('restarted rerun-staging')
    })

    it('carries on when the browser install fails', async () => {
        state.failing = [INSTALL_BROWSER]
        await updateCommand(['--no-restart'])
        expect(out).toContain(`chromium install failed (continuing): ${process.execPath} exited with 1`)
        expect(state.calls).toContain('<prepareDataDir>')
    })

    it('returns the page cache to the host before restarting when /proc allows it', async () => {
        state.procPresent = true
        await updateCommand([])
        const i = state.calls.indexOf(`sudo -n sh -c ${RETURN_MEMORY}`)
        expect(i).toBeGreaterThan(state.calls.indexOf('<prepareDataDir>'))
        expect(i).toBeLessThan(state.calls.indexOf('sudo systemctl restart rerun'))
    })
})

describe('updateCommand from an artifact', () => {
    const happyPath = [
        'sudo -n true',
        `<sweep ${RELEASE_ROOT}>`,
        `<requireFreeSpace ${RELEASES} default>`,
        `<download ${URL} ${resolve(TMP, 'engine.tar.gz')} ${SHA}>`,
        `<extract ${resolve(TMP, 'engine.tar.gz')} ${TMP}>`,
        `<verify ${TMP}>`,
        `${process.execPath} ${NEW_BIN} migrate`,
        `${process.execPath} ${NEW_BIN} install-browser`,
        `${process.execPath} ${NEW_BIN} update-cli-tools`,
        `${process.execPath} ${NEW_BIN} install-desktop`,
        `<switchCurrent ${RELEASE_ROOT} ${TARGET}>`,
        `<installLayout ${RELEASE_ROOT}>`,
        `<prune ${RELEASE_ROOT}>`,
        'sudo -n rm -rf /root/.local/share/pnpm /root/.npm /root/.cache/node',
        'sudo -n fstrim --quiet-unsupported /',
    ]

    it('downloads, verifies, migrates and installs with the new release, swaps current, then restarts', async () => {
        state.layout = RELEASE_LAYOUT
        state.previousTarget = resolve(RELEASES, 'old0000')
        state.layoutWritten = ['/usr/local/bin/rerun']
        state.pruned = ['ancient']
        await updateCommand(ARTIFACT_ARGS)

        expect(state.calls).toEqual([...happyPath, 'command -v systemctl', 'command -v sudo', 'sudo systemctl restart rerun'])
        expect(existsSync(TARGET)).toBe(true)
        expect(existsSync(TMP)).toBe(false)
        expect(readLastUpdate()).toMatchObject({ status: 'restarting', commit: COMMIT })
        expect(out).toContain('downloaded 42 bytes, checksum ok')
        expect(out).toContain(`current -> releases/${COMMIT} (previous: old0000)`)
        expect(out).toContain('wrote /usr/local/bin/rerun')
        expect(out).toContain('removed release ancient')
        expect(state.calls).not.toContain('<prepareDataDir>')
        expect(state.calls).not.toContain(INSTALL_BROWSER)
    })

    it('passes the announced size to the free-space check and keeps the data-dir untouched by this process', async () => {
        state.layout = RELEASE_LAYOUT
        await updateCommand([...ARTIFACT_ARGS, '--bytes', '1000', '--no-restart'])
        expect(state.calls).toContain(`<requireFreeSpace ${RELEASES} 1000>`)
        expect(state.calls.slice(-3)).toEqual([`<prune ${RELEASE_ROOT}>`, 'sudo -n rm -rf /root/.local/share/pnpm /root/.npm /root/.cache/node', 'sudo -n fstrim --quiet-unsupported /'])
        expect(out).toContain('skipping restart (--no-restart)')
        expect(readLastUpdate()).toMatchObject({ status: 'restarting' })
    })

    it('reports the freed caches and the trim, after the prune', async () => {
        state.layout = RELEASE_LAYOUT
        await updateCommand(ARTIFACT_ARGS)
        expect(out).toContain('removed cache /root/.local/share/pnpm\nremoved cache /root/.npm\nremoved cache /root/.cache/node\n')
        expect(out).toContain('trimmed /\n')
        expect(out.indexOf('trimmed /')).toBeGreaterThan(out.indexOf('removed cache /root/.cache/node'))
        expect(out.indexOf('trimmed /')).toBeLessThan(out.indexOf('restarted rerun'))
    })

    it('still switches and restarts on the new release when the cache sweep and the trim both fail', async () => {
        state.layout = RELEASE_LAYOUT
        state.failing = ['sudo -n rm -rf /root/', 'sudo -n fstrim']
        await updateCommand(ARTIFACT_ARGS)

        expect(state.calls).toEqual([...happyPath, 'command -v systemctl', 'command -v sudo', 'sudo systemctl restart rerun'])
        expect(existsSync(TARGET)).toBe(true)
        expect(readLastUpdate()).toMatchObject({ status: 'restarting', commit: COMMIT })
        expect(out).toContain('root cache sweep failed (continuing): sudo exited with 1')
        expect(out).toContain('fstrim failed (continuing): sudo exited with 1')
        expect(out).not.toContain('trimmed /')
    })

    it('takes a checkout to the release layout on its first artifact, without sweeping the checkout', async () => {
        state.layout = { kind: 'monorepo', root: RELEASE_ROOT, packageDir: resolve(RELEASE_ROOT, 'apps', 'engine') }
        writeLastUpdate({ status: 'success', commit: 'old0000' })
        await updateCommand(ARTIFACT_ARGS)
        expect(state.calls).toContain(`<switchCurrent ${RELEASE_ROOT} ${TARGET}>`)
        expect(state.calls).not.toContain(`<sweep ${RELEASE_ROOT}>`)
    })

    it('sweeps the legacy checkout before checking the free space once a release has served', async () => {
        state.layout = RELEASE_LAYOUT
        state.swept = [resolve(RELEASE_ROOT, '.git')]
        writeLastUpdate({ status: 'success', commit: 'old0000' })
        await updateCommand(ARTIFACT_ARGS)
        expect(state.calls.indexOf(`<sweep ${RELEASE_ROOT}>`)).toBeLessThan(state.calls.indexOf(`<requireFreeSpace ${RELEASES} default>`))
        expect(out).toContain(`removed legacy ${resolve(RELEASE_ROOT, '.git')}`)
    })

    it('still sweeps after an update that failed on a release that serves, so a full disk does not lock the box', async () => {
        state.layout = RELEASE_LAYOUT
        writeLastUpdate({ status: 'error', commit: 'old0000', error: 'not enough free space' })
        await updateCommand(ARTIFACT_ARGS)
        expect(state.calls.indexOf(`<sweep ${RELEASE_ROOT}>`)).toBeLessThan(state.calls.indexOf(`<requireFreeSpace ${RELEASES} default>`))
    })

    it.each(['restarting', 'running'] as const)('does not sweep while the last update is %s', async status => {
        state.layout = RELEASE_LAYOUT
        writeLastUpdate({ status, commit: 'old0000' })
        await updateCommand(ARTIFACT_ARGS)
        expect(state.calls).not.toContain(`<sweep ${RELEASE_ROOT}>`)
    })

    it('skips the download when the release is already on disk', async () => {
        state.layout = RELEASE_LAYOUT
        mkdirSync(TARGET, { recursive: true })
        await updateCommand([...ARTIFACT_ARGS, '--no-restart'])
        expect(state.calls.some(call => call.startsWith('<download'))).toBe(false)
        expect(state.calls).toContain(`${process.execPath} ${NEW_BIN} migrate`)
        expect(out).toContain(`release ${COMMIT} already on disk`)
    })

    it('stops before downloading without passwordless sudo', async () => {
        state.layout = RELEASE_LAYOUT
        state.failing = ['sudo -n true']
        await expect(updateCommand(ARTIFACT_ARGS)).rejects.toThrow('passwordless sudo is required')
        expect(state.calls).toEqual(['sudo -n true'])
        expect(readLastUpdate()).toMatchObject({ status: 'error', commit: COMMIT, error: expect.stringContaining('sudo') })
    })

    it('stops before downloading when the disk is short', async () => {
        state.layout = RELEASE_LAYOUT
        state.freeSpaceFails = true
        await expect(updateCommand(ARTIFACT_ARGS)).rejects.toThrow('not enough free space')
        expect(state.calls).toContain(`<sweep ${RELEASE_ROOT}>`)
        expect(state.calls.some(call => call.startsWith('<download'))).toBe(false)
        expect(readLastUpdate()).toMatchObject({ status: 'error', error: 'not enough free space' })
    })

    it('swaps nothing and removes its download on a checksum mismatch', async () => {
        state.layout = RELEASE_LAYOUT
        state.downloadFails = true
        await expect(updateCommand(ARTIFACT_ARGS)).rejects.toThrow('checksum mismatch')
        expect(existsSync(TMP)).toBe(false)
        expect(existsSync(TARGET)).toBe(false)
        expect(state.calls.some(call => call.startsWith('<switchCurrent'))).toBe(false)
        expect(state.calls.some(call => call.includes('systemctl restart'))).toBe(false)
        expect(readLastUpdate()).toMatchObject({ status: 'error', error: 'artifact checksum mismatch' })
    })

    it('swaps nothing when the unpacked release does not match', async () => {
        state.layout = RELEASE_LAYOUT
        state.verifyFails = true
        await expect(updateCommand(ARTIFACT_ARGS)).rejects.toThrow('built for win32')
        expect(existsSync(TMP)).toBe(false)
        expect(existsSync(TARGET)).toBe(false)
        expect(readLastUpdate()).toMatchObject({ status: 'error' })
    })

    it('leaves current alone when the new release cannot migrate the data-dir', async () => {
        state.layout = RELEASE_LAYOUT
        state.failing = [`${process.execPath} ${NEW_BIN} migrate`]
        await expect(updateCommand(ARTIFACT_ARGS)).rejects.toThrow('exited with 1')
        expect(state.calls.some(call => call.startsWith('<switchCurrent'))).toBe(false)
        expect(existsSync(TARGET)).toBe(true)
        expect(readLastUpdate()).toMatchObject({ status: 'error' })
    })

    it('carries on past a browser or desktop install that fails', async () => {
        state.layout = RELEASE_LAYOUT
        state.failing = [`${process.execPath} ${NEW_BIN} install-browser`, `${process.execPath} ${NEW_BIN} install-desktop`]
        await updateCommand([...ARTIFACT_ARGS, '--no-restart'])
        expect(out).toContain('chromium install failed (continuing)')
        expect(out).toContain('desktop install failed (continuing)')
        expect(state.calls).toContain(`<switchCurrent ${RELEASE_ROOT} ${TARGET}>`)
    })

    it('leaves the desktop out on a box whose desktop is switched off', async () => {
        state.layout = RELEASE_LAYOUT
        state.desktop = false
        await updateCommand([...ARTIFACT_ARGS, '--no-restart'])
        expect(state.calls).not.toContain(`${process.execPath} ${NEW_BIN} install-desktop`)
    })

    it('refuses an artifact on an image', async () => {
        state.layout = { kind: 'image', root: '/app', packageDir: '/app' }
        await expect(updateCommand(ARTIFACT_ARGS)).rejects.toThrow('does not take release artifacts')
        expect(state.calls).toEqual([])
    })

    it('refuses a partial artifact before doing anything', async () => {
        state.layout = RELEASE_LAYOUT
        await expect(updateCommand(['--artifact', URL])).rejects.toThrow('go together')
        expect(state.calls).toEqual([])
    })
})

describe('rollbackCommand and installLayoutCommand', () => {
    it('rolls back to the previous release and restarts', () => {
        state.layout = RELEASE_LAYOUT
        rollbackCommand()
        expect(state.calls).toEqual([`<rollback ${RELEASE_ROOT}>`, 'command -v systemctl', 'command -v sudo', 'sudo systemctl restart rerun'])
        expect(out).toContain('current -> releases/previous-commit')
        expect(readLastUpdate()).toMatchObject({ status: 'restarting', commit: 'previous-commit' })
    })

    it('only rolls back a release layout', () => {
        expect(() => rollbackCommand()).toThrow('rollback needs a release layout')
        state.layout = { kind: 'image', root: '/app', packageDir: '/app' }
        expect(() => rollbackCommand()).toThrow('rollback needs a release layout')
    })

    it('points current at the release it runs from when none does, then writes the layout files', () => {
        state.layout = RELEASE_LAYOUT
        state.layoutWritten = ['/etc/systemd/system/rerun.service']
        installLayoutCommand()
        expect(state.calls).toEqual([`<switchCurrent ${RELEASE_ROOT} ${RELEASE_LAYOUT.packageDir}>`, `<installLayout ${RELEASE_ROOT}>`])
        expect(out).toContain('wrote /etc/systemd/system/rerun.service')
    })

    it('leaves an existing current link alone', () => {
        state.layout = RELEASE_LAYOUT
        mkdirSync(RELEASES, { recursive: true })
        symlinkSync('releases/old0000', resolve(RELEASE_ROOT, 'current'))
        try {
            installLayoutCommand()
            expect(state.calls).toEqual([`<installLayout ${RELEASE_ROOT}>`])
        } finally {
            rmSync(resolve(RELEASE_ROOT, 'current'))
        }
    })

    it('only installs the layout from a release', () => {
        expect(() => installLayoutCommand()).toThrow('install-layout runs from a release')
    })
})

describe('returning memory to the host', () => {
    it('is a no-op without /proc', async () => {
        await updateCommand(['--no-restart'])
        expect(state.calls.some(c => c.includes('drop_caches'))).toBe(false)
        expect(out).not.toContain('memory return')
    })

    it('runs the script directly as root', async () => {
        asUser(0)
        state.procPresent = true
        await updateCommand(['--no-restart'])
        expect(state.calls).toContain(`sh -c ${RETURN_MEMORY}`)
    })

    it('skips it without passwordless sudo', async () => {
        state.procPresent = true
        state.failing = ['sudo -n true']
        await updateCommand(['--no-restart'])
        expect(state.calls.some(c => c.includes('drop_caches'))).toBe(false)
        expect(out).toContain('no passwordless sudo available: skipping memory return')
    })

    it('carries on when the script fails', async () => {
        state.procPresent = true
        state.failing = ['sudo -n sh -c']
        await updateCommand([])
        expect(out).toContain('memory return failed (continuing): sudo exited with 1')
        expect(state.calls.at(-1)).toBe('sudo systemctl restart rerun')
    })
})

describe('installBrowser', () => {
    const DEPS = 'pnpm --filter rerun-engine exec patchright install-deps chromium'
    const INSTALL = 'pnpm --filter rerun-engine exec patchright install --no-shell chromium'
    const REPO: FakeLayout = { kind: 'monorepo', root: '/repo', packageDir: '/repo/apps/engine' }

    it('does nothing when chromium is already on disk', async () => {
        await installBrowser(REPO)
        expect(state.calls).toEqual([])
        expect(out).toBe('chromium already installed\n')
    })

    it('installs the system deps directly as root, then the browser, through pnpm in a checkout', async () => {
        asUser(0)
        state.chromium = 'missing'
        await installBrowser(REPO)
        expect(state.calls).toEqual([DEPS, INSTALL])
        expect(state.cwds).toEqual(['/repo', '/repo'])
    })

    it('installs the system deps through sudo when it can', async () => {
        state.chromium = 'no-path'
        await installBrowser(REPO)
        expect(state.calls).toEqual(['sudo -n true', `sudo -n ${DEPS}`, INSTALL])
    })

    it('skips the system deps without passwordless sudo but still installs the browser', async () => {
        state.chromium = 'throws'
        state.failing = ['sudo -n true']
        await installBrowser(REPO)
        expect(state.calls).toEqual(['sudo -n true', INSTALL])
        expect(out).toContain('no passwordless sudo available: skipping chromium system dependencies')
    })

    it("drives patchright from the package's own node_modules in a release or an image", async () => {
        asUser(0)
        state.chromium = 'missing'
        const cli = `${process.execPath} /opt/rerun/releases/abc1234/node_modules/patchright/cli.js`
        await installBrowser({ kind: 'release', root: '/opt/rerun', packageDir: '/opt/rerun/releases/abc1234' })
        expect(state.calls).toEqual([`${cli} install-deps chromium`, `${cli} install --no-shell chromium`])
        expect(state.cwds).toEqual(['/opt/rerun/releases/abc1234', '/opt/rerun/releases/abc1234'])
    })

    it('runs from the detected layout as a command', async () => {
        state.chromium = 'missing'
        asUser(0)
        await installBrowserCommand()
        expect(state.calls).toEqual([DEPS, INSTALL])
        expect(state.cwds).toEqual([ROOT, ROOT])
    })
})

describe('installBrowserInBackground', () => {
    it('leaves an installed browser alone', async () => {
        expect(await installBrowserInBackground()).toBe(false)
        expect(state.spawned).toEqual([])
    })

    it('installs a missing browser in a detached child, without blocking on it', async () => {
        state.chromium = 'missing'
        expect(await installBrowserInBackground()).toBe(true)
        expect(state.spawned).toEqual([{ line: INSTALL_BROWSER, options: { stdio: 'ignore', detached: true } }])
        expect(state.calls).toEqual([])
    })
})

describe('installDesktop', () => {
    const onLinux = () => vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')

    it('does nothing off Linux', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
        installDesktop()
        expect(state.calls).toEqual([])
    })

    it('leaves a box that already has the desktop alone', () => {
        onLinux()
        installDesktop()
        expect(state.calls).toEqual(['command -v apt-get', 'command -v openbox', 'command -v x11vnc', 'command -v xdotool', 'command -v tint2', 'command -v hsetroot', 'command -v maim', 'command -v ffmpeg'])
        expect(out).toContain('desktop already installed')
    })

    it('refreshes the package lists and installs through sudo when a package is missing', () => {
        onLinux()
        state.failing = ['command -v x11vnc']
        installDesktop()
        expect(state.calls.slice(-3)).toEqual(['sudo -n true', 'sudo -n apt-get update -qq', `sudo -n ${DESKTOP_APT}`])
    })

    it('installs directly as root', () => {
        onLinux()
        asUser(0)
        state.failing = ['command -v x11vnc']
        installDesktop()
        expect(state.calls.slice(-2)).toEqual(['apt-get update -qq', DESKTOP_APT])
    })

    it('skips without passwordless sudo, and carries on past a failing install', () => {
        onLinux()
        state.failing = ['command -v openbox', 'sudo -n true']
        installDesktop()
        expect(out).toContain('skipping the desktop packages')
        state.calls = []
        state.failing = ['command -v openbox', 'sudo -n apt-get update']
        installDesktop()
        expect(out).toContain('desktop install failed (continuing)')
    })

    it('is started in the background by an engine that boots without it, and only then', () => {
        expect(installDesktopInBackground()).toBe(false)
        onLinux()
        expect(installDesktopInBackground()).toBe(false)
        state.failing = ['command -v openbox']
        expect(installDesktopInBackground()).toBe(true)
        expect(state.spawned).toEqual([{ line: INSTALL_DESKTOP, options: { stdio: 'ignore', detached: true } }])
    })

    it('is left out of a boot and of an update on a box whose desktop is switched off', async () => {
        state.desktop = false
        onLinux()
        state.failing = ['command -v openbox']
        expect(installDesktopInBackground()).toBe(false)
        expect(state.spawned).toEqual([])
        await updateCommand([])
        expect(state.calls).not.toContain(INSTALL_DESKTOP)
    })
})

const CLAUDE_INSTALL_DIR = resolve(FAKE_HOME, '.local', 'share', 'claude')
const CLAUDE_LAUNCHER = resolve(FAKE_HOME, '.local', 'bin', 'claude')

function seedClaudeInstall(): void {
    rmSync(resolve(FAKE_HOME, '.local'), { recursive: true, force: true })
    const versions = resolve(CLAUDE_INSTALL_DIR, 'versions')
    mkdirSync(versions, { recursive: true })
    mkdirSync(dirname(CLAUDE_LAUNCHER), { recursive: true })
    writeFileSync(resolve(versions, '2.1.294'), '')
    symlinkSync(resolve(versions, '2.1.294'), CLAUDE_LAUNCHER)
}

describe('removeLegacyClaudeCli', () => {
    it('removes the install and the launcher that points into it', () => {
        seedClaudeInstall()
        expect(removeLegacyClaudeCli(undefined, 'linux')).toEqual([CLAUDE_LAUNCHER, CLAUDE_INSTALL_DIR])
        expect(existsSync(CLAUDE_INSTALL_DIR)).toBe(false)
        expect(existsSync(resolve(FAKE_HOME, '.local', 'bin'))).toBe(true)
        expect(readdirSync(resolve(FAKE_HOME, '.local', 'bin'))).toEqual([])
    })

    it('leaves a launcher of its own in place', () => {
        seedClaudeInstall()
        rmSync(CLAUDE_LAUNCHER)
        writeFileSync(CLAUDE_LAUNCHER, '')
        expect(removeLegacyClaudeCli(undefined, 'linux')).toEqual([CLAUDE_INSTALL_DIR])
        expect(existsSync(CLAUDE_LAUNCHER)).toBe(true)
    })

    it('does nothing on a box that never had it', () => {
        rmSync(resolve(FAKE_HOME, '.local'), { recursive: true, force: true })
        expect(removeLegacyClaudeCli(undefined, 'linux')).toEqual([])
    })

    it("leaves a developer's own Claude Code alone on macOS", () => {
        seedClaudeInstall()
        expect(removeLegacyClaudeCli(undefined, 'darwin')).toEqual([])
        expect(existsSync(CLAUDE_INSTALL_DIR)).toBe(true)
        expect(existsSync(CLAUDE_LAUNCHER)).toBe(true)
    })
})

describe('updateCliTools', () => {
    it('installs the pinned Codex through sudo when the installed one is another version', () => {
        state.outputs[CODEX_VERSION_CHECK] = 'codex-cli 0.159.3\n'
        updateCliTools()
        expect(state.calls).toEqual([CODEX_VERSION_CHECK, 'sudo -n true', `sudo -n npm install -g ${CODEX}`])
    })

    it('installs without sudo when none is available', () => {
        state.failing = ['sudo -n true']
        updateCliTools()
        expect(state.calls).toEqual([CODEX_VERSION_CHECK, 'sudo -n true', `npm install -g ${CODEX}`])
    })

    it('leaves Codex alone when it is already at the pin', () => {
        state.outputs[CODEX_VERSION_CHECK] = `codex-cli ${CODEX_VERSION}\n`
        updateCliTools()
        expect(state.calls).toEqual([CODEX_VERSION_CHECK])
        expect(out).toContain(`codex CLI already at ${CODEX_VERSION}`)
    })

    it('carries on past a failing Codex install', () => {
        state.failing = ['sudo -n npm']
        updateCliTools()
        expect(out).toContain('codex CLI update failed (continuing): sudo exited with 1')
    })

    it('removes the Claude install the SDK binary replaced on a release', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
        state.layout = RELEASE_LAYOUT
        seedClaudeInstall()
        updateCliTools()
        expect(existsSync(CLAUDE_INSTALL_DIR)).toBe(false)
        expect(out).toContain(`removed ${CLAUDE_INSTALL_DIR}`)
    })

    it("leaves a checkout's own Claude Code alone", () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
        seedClaudeInstall()
        updateCliTools()
        expect(existsSync(CLAUDE_INSTALL_DIR)).toBe(true)
        expect(out).not.toContain('removed')
    })

    it('does not stop the update when the CLI tools step fails', async () => {
        state.failing = [UPDATE_CLI_TOOLS]
        await updateCommand(['--no-restart'])
        expect(out).toContain(`CLI tools update failed (continuing): ${process.execPath} exited with 1`)
        expect(state.calls).toContain('<prepareDataDir>')
    })
})

describe('updateCliToolsInBackground', () => {
    it('installs the pin in the background on a release whose Codex is off it', () => {
        state.layout = RELEASE_LAYOUT
        state.outputs[CODEX_VERSION_CHECK] = 'codex-cli 0.159.3'
        expect(updateCliToolsInBackground()).toBe('spawned')
        expect(state.spawned).toEqual([{ line: UPDATE_CLI_TOOLS, options: { stdio: 'ignore', detached: true } }])
    })

    it('reports a box whose service user cannot sudo instead of spawning a doomed install', () => {
        state.layout = RELEASE_LAYOUT
        state.outputs[CODEX_VERSION_CHECK] = 'codex-cli 0.159.3'
        state.failing = ['sudo -n true']
        expect(updateCliToolsInBackground()).toBe('no-root')
        expect(state.spawned).toEqual([])
    })

    it('stays still when Codex is at the pin', () => {
        state.layout = RELEASE_LAYOUT
        state.outputs[CODEX_VERSION_CHECK] = `codex-cli ${CODEX_VERSION}`
        expect(updateCliToolsInBackground()).toBe(false)
        expect(state.spawned).toEqual([])
    })

    it('never touches the global npm of a checkout or an image', () => {
        expect(updateCliToolsInBackground()).toBe(false)
        state.layout = { kind: 'image', root: '/app', packageDir: '/app' }
        expect(updateCliToolsInBackground()).toBe(false)
        expect(state.spawned).toEqual([])
    })
})
