import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareDataDir } from '../../datadir/ladder.js'
import { desktopEnabled } from '../../config/env.js'
import { detectLayout, type Layout } from '../../runtime/layout.js'
import { readLastUpdate, writeLastUpdate } from '../../runtime/last-update.js'
import { CODEX_VERSION, installedCodexVersion } from '../../runtime/codex-cli.js'
import { asRoot, canSudo, hasCommand, isRoot, run } from './exec.js'
import {
    type Artifact,
    downloadArtifact,
    extractArtifact,
    installLayout,
    parseArtifactArgs,
    pruneReleases,
    releaseBin,
    releaseDir,
    releasesDir,
    requireFreeSpace,
    rollbackRelease,
    sweepLegacyCheckout,
    sweepRootCaches,
    switchCurrent,
    trimRootFilesystem,
    verifyRelease,
} from './release.js'

// Resolved through symlinks by Node, so this is the bin.js of the release that is running, even
// when the process was started through `current/`.
const CLI_ENTRY = fileURLToPath(new URL('../bin.js', import.meta.url))

const continuing = (what: string, err: unknown): void => {
    process.stdout.write(`${what} failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`)
}

async function browserInstalled(): Promise<boolean> {
    try {
        const { chromium } = await import('patchright')
        const executable = chromium.executablePath()
        return !!executable && existsSync(executable)
    } catch {
        return false
    }
}

// A checkout drives patchright through pnpm; a prebuilt package has it in its own node_modules.
function patchrightCommand(layout: Layout, args: string[]): { command: string; args: string[]; cwd: string } {
    if (layout.kind === 'monorepo') return { command: 'pnpm', args: ['--filter', 'rerun-engine', 'exec', 'patchright', ...args], cwd: layout.root }
    return { command: process.execPath, args: [resolve(layout.packageDir, 'node_modules', 'patchright', 'cli.js'), ...args], cwd: layout.packageDir }
}

export async function installBrowser(layout: Layout): Promise<void> {
    if (await browserInstalled()) {
        process.stdout.write('chromium already installed\n')
        return
    }
    const deps = patchrightCommand(layout, ['install-deps', 'chromium'])
    if (isRoot()) {
        run(deps.command, deps.args, { cwd: deps.cwd })
    } else if (canSudo()) {
        run('sudo', ['-n', deps.command, ...deps.args], { cwd: deps.cwd })
    } else {
        process.stdout.write('no passwordless sudo available: skipping chromium system dependencies (the browser may fail to launch)\n')
    }
    const install = patchrightCommand(layout, ['install', '--no-shell', 'chromium'])
    run(install.command, install.args, { cwd: install.cwd })
}

const DESKTOP_PACKAGES = ['openbox', 'x11vnc', 'xdotool', 'thunar', 'xfce4-terminal', 'adwaita-icon-theme', 'tint2', 'hsetroot', 'curl', 'maim', 'ffmpeg']

// The dock, the wallpaper, the screen capture and the recorder are checked too, so a box that got its desktop before they existed installs them.
const desktopInstalled = (): boolean => ['openbox', 'x11vnc', 'xdotool', 'tint2', 'hsetroot', 'maim', 'ffmpeg'].every(hasCommand)

const desktopInstallable = (): boolean => process.platform === 'linux' && hasCommand('apt-get')

// Kept in step with the list in the installer of the boxes (cloud/infra/engine/install.sh), which only
// ever runs when a box is born.
export function installDesktop(): void {
    if (!desktopInstallable()) return
    if (desktopInstalled()) {
        process.stdout.write('desktop already installed\n')
        return
    }
    if (!isRoot() && !canSudo()) {
        process.stdout.write('no passwordless sudo available: skipping the desktop packages\n')
        return
    }
    try {
        // A box that has not installed anything since it was born holds package lists that point at versions the mirror dropped.
        asRoot(['apt-get', 'update', '-qq'])
        asRoot(['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-qq', '--no-install-recommends', ...DESKTOP_PACKAGES])
    } catch (err) {
        continuing('desktop install', err)
    }
}

// Same reason as the browser below: the update that brought this build in ran the previous
// release's updater, which had never heard of these packages.
export function installDesktopInBackground(): boolean {
    if (!desktopEnabled() || !desktopInstallable() || desktopInstalled()) return false
    spawn(process.execPath, [CLI_ENTRY, 'install-desktop'], { stdio: 'ignore', detached: true }).unref()
    return true
}

// An engine can come up without the browser its build expects: the updater that installed it ran
// the previous release's code, which knew another package. A child process keeps the server
// answering during the ~170 MB download.
export async function installBrowserInBackground(): Promise<boolean> {
    if (await browserInstalled()) return false
    spawn(process.execPath, [CLI_ENTRY, 'install-browser'], { stdio: 'ignore', detached: true }).unref()
    return true
}

export async function installBrowserCommand(): Promise<void> {
    await installBrowser(detectLayout())
}

// The updater that brings a release in is the previous release's code, so the CLIs are installed by
// the new release's `update-cli-tools`, and an engine that boots on a Codex other than its pin
// installs it itself. Codex is best-effort: a box that cannot reach npm still gets its engine
// update, it keeps the CLI it had and the models it cannot serve stay locked.
export function updateCliTools(): void {
    const installed = installedCodexVersion()
    if (installed === CODEX_VERSION) {
        process.stdout.write(`codex CLI already at ${CODEX_VERSION}\n`)
    } else {
        const codexPackage = `@openai/codex@${CODEX_VERSION}`
        try {
            if (!isRoot() && canSudo()) run('sudo', ['-n', 'npm', 'install', '-g', codexPackage])
            else run('npm', ['install', '-g', codexPackage])
        } catch (err) {
            continuing('codex CLI update', err)
        }
    }
    if (detectLayout().kind !== 'release') return
    try {
        for (const path of removeLegacyClaudeCli()) process.stdout.write(`removed ${path}\n`)
    } catch (err) {
        continuing('claude CLI cleanup', err)
    }
}

// `no-root`: the global npm prefix is root's and the service user cannot sudo into it (install.sh's
// sudoers only opens systemctl), so the spawn would fail silently at every boot.
export function updateCliToolsInBackground(): 'spawned' | 'no-root' | false {
    if (detectLayout().kind !== 'release' || installedCodexVersion() === CODEX_VERSION) return false
    if (!isRoot() && !canSudo()) return 'no-root'
    spawn(process.execPath, [CLI_ENTRY, 'update-cli-tools'], { stdio: 'ignore', detached: true }).unref()
    return 'spawned'
}

const LEGACY_CLAUDE_LINK = '/usr/local/bin/claude'

// Claude runs on the binary the Agent SDK ships inside each release. The one install.sh used to
// fetch with claude.ai/install.sh was never on that path, and kept ~250 MB per version it saw.
// Release layout and Linux only: on a checkout, or on a developer's Mac, the same folder is their
// own Claude Code.
export function removeLegacyClaudeCli(home = homedir(), platform = process.platform): string[] {
    const install = resolve(home, '.local', 'share', 'claude')
    const launcher = resolve(home, '.local', 'bin', 'claude')
    if (platform !== 'linux' || !existsSync(install)) return []
    const removed: string[] = []
    if (symlinkTarget(LEGACY_CLAUDE_LINK) === launcher && (isRoot() || canSudo())) {
        asRoot(['rm', '-f', LEGACY_CLAUDE_LINK])
        removed.push(LEGACY_CLAUDE_LINK)
    }
    if (symlinkTarget(launcher)?.startsWith(`${install}/`)) {
        rmSync(launcher, { force: true })
        removed.push(launcher)
    }
    rmSync(install, { recursive: true, force: true })
    removed.push(install)
    return removed
}

function symlinkTarget(path: string): string | null {
    try {
        return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null
    } catch {
        return null
    }
}

const DROP_CACHES = '/proc/sys/vm/drop_caches'
const RETURN_MEMORY_SCRIPT = `sync; echo 3 > ${DROP_CACHES}; echo 1 > /proc/sys/vm/compact_memory`

// A build leaves ~5 GiB of page cache in the VM, and the host only gets it back once the guest
// frees it. The image's return-memory timer does that every 10 min and skips busy boxes, so a
// fleet-wide update outran it and swapped a host until it stopped answering. Freeing it here,
// before the restart, hands it back before the update queue moves on to the next box.
function returnMemoryToHost(): void {
    if (!existsSync(DROP_CACHES)) return
    try {
        if (isRoot()) run('sh', ['-c', RETURN_MEMORY_SCRIPT])
        else if (canSudo()) run('sudo', ['-n', 'sh', '-c', RETURN_MEMORY_SCRIPT])
        else process.stdout.write('no passwordless sudo available: skipping memory return\n')
    } catch (err) {
        continuing('memory return', err)
    }
}

const serviceName = (): string => process.env.RERUN_SERVICE ?? 'rerun'

function restartService(): void {
    if (!hasCommand('systemctl')) {
        process.stdout.write('systemctl not found; restart the engine manually to load the new build\n')
        return
    }
    const service = serviceName()
    const useSudo = !isRoot() && hasCommand('sudo')
    run(useSudo ? 'sudo' : 'systemctl', useSudo ? ['systemctl', 'restart', service] : ['restart', service])
    process.stdout.write(`restarted ${service}\n`)
}

function finishUpdate(noRestart: boolean): void {
    returnMemoryToHost()
    if (noRestart) {
        process.stdout.write('skipping restart (--no-restart)\n')
        return
    }
    restartService()
}

export async function updateCommand(args: string[]): Promise<void> {
    const noRestart = args.includes('--no-restart')
    const artifact = parseArtifactArgs(args)
    const layout = detectLayout()
    if (artifact) return updateFromArtifact(layout, artifact, noRestart)
    if (layout.kind === 'image') throw new Error('this engine was installed from an image: pull the new image to update it')
    if (layout.kind === 'release') throw new Error('this engine was installed from a release artifact: pass --artifact <url> --sha256 <hex> --commit <sha>')
    await updateFromGit(layout, noRestart)
}

async function updateFromGit(layout: Layout, noRestart: boolean): Promise<void> {
    const root = layout.root
    run('git', ['pull', '--ff-only'], { cwd: root })
    run('pnpm', ['--filter', 'rerun-engine...', 'install', '--prod=false', '--frozen-lockfile'], { cwd: root })
    run('pnpm', ['--filter', 'rerun-engine...', 'build'], { cwd: root })

    // Through the freshly built CLI: this process still runs the code it started with, and the new
    // build may expect another browser than the one it knows how to install.
    try {
        run(process.execPath, [CLI_ENTRY, 'install-browser'], { cwd: root })
    } catch (err) {
        continuing('chromium install', err)
    }
    try {
        run(process.execPath, [CLI_ENTRY, 'update-cli-tools'], { cwd: root })
    } catch (err) {
        continuing('CLI tools update', err)
    }
    if (desktopEnabled()) {
        try {
            run(process.execPath, [CLI_ENTRY, 'install-desktop'], { cwd: root })
        } catch (err) {
            continuing('desktop install', err)
        }
    }

    await prepareDataDir()
    process.stdout.write('migrated data dir\n')
    finishUpdate(noRestart)
}

// Every step that runs code runs the NEW release's bin.js: this process is the old release, and its
// own CLI_ENTRY resolves into the old folder. The updater dies with the restart it triggers, so the
// `restarting` mark is its last word; the engine that comes up on the new build settles it.
async function updateFromArtifact(layout: Layout, artifact: Artifact, noRestart: boolean): Promise<void> {
    if (layout.kind === 'image') throw new Error('an image does not take release artifacts: pull the new image instead')
    const root = layout.root
    const previousUpdate = readLastUpdate()
    writeLastUpdate({ status: 'running', commit: artifact.commit })
    const tmp = resolve(releasesDir(root), `.tmp-${artifact.commit}`)
    try {
        if (!isRoot() && !canSudo()) throw new Error('passwordless sudo is required to install a release')
        mkdirSync(releasesDir(root), { recursive: true })
        // Before the free-space check, which the checkout alone can fail. A `release` updater runs from
        // a release that already serves; only a swap not yet confirmed (`restarting`) or an updater cut
        // short (`running`) leaves the checkout as the last build known to boot.
        if (layout.kind === 'release' && previousUpdate?.status !== 'restarting' && previousUpdate?.status !== 'running') {
            for (const path of sweepLegacyCheckout(root)) process.stdout.write(`removed legacy ${path}\n`)
        }
        requireFreeSpace(releasesDir(root), artifact.bytes)

        const target = releaseDir(root, artifact.commit)
        if (existsSync(target)) {
            process.stdout.write(`release ${artifact.commit} already on disk\n`)
        } else {
            rmSync(tmp, { recursive: true, force: true })
            mkdirSync(tmp)
            const tarball = resolve(tmp, 'engine.tar.gz')
            process.stdout.write(`downloading ${artifact.url}\n`)
            const bytes = await downloadArtifact(artifact.url, tarball, artifact.sha256)
            process.stdout.write(`downloaded ${bytes} bytes, checksum ok\n`)
            extractArtifact(tarball, tmp)
            rmSync(tarball, { force: true })
            verifyRelease(tmp, artifact)
            renameSync(tmp, target)
        }

        const bin = releaseBin(target)
        run(process.execPath, [bin, 'migrate'])
        process.stdout.write('migrated data dir\n')
        try {
            run(process.execPath, [bin, 'install-browser'])
        } catch (err) {
            continuing('chromium install', err)
        }
        try {
            run(process.execPath, [bin, 'update-cli-tools'])
        } catch (err) {
            continuing('CLI tools update', err)
        }
        if (desktopEnabled()) {
            try {
                run(process.execPath, [bin, 'install-desktop'])
            } catch (err) {
                continuing('desktop install', err)
            }
        }

        const previous = switchCurrent(root, target)
        process.stdout.write(`current -> releases/${artifact.commit}${previous ? ` (previous: ${basename(previous)})` : ''}\n`)
        for (const path of installLayout(root)) process.stdout.write(`wrote ${path}\n`)
        for (const name of pruneReleases(root)) process.stdout.write(`removed release ${name}\n`)
        try {
            for (const path of sweepRootCaches()) process.stdout.write(`removed cache ${path}\n`)
        } catch (err) {
            continuing('root cache sweep', err)
        }
        try {
            trimRootFilesystem()
            process.stdout.write('trimmed /\n')
        } catch (err) {
            continuing('fstrim', err)
        }
        writeLastUpdate({ status: 'restarting', commit: artifact.commit })
    } catch (err) {
        rmSync(tmp, { recursive: true, force: true })
        writeLastUpdate({ status: 'error', commit: artifact.commit, error: err instanceof Error ? err.message : String(err) })
        throw err
    }
    finishUpdate(noRestart)
}

// A dangling link counts: it was placed on purpose and `existsSync` would follow it to nothing.
function linkExists(path: string): boolean {
    try {
        lstatSync(path)
        return true
    } catch {
        return false
    }
}

export function rollbackCommand(): void {
    const layout = detectLayout()
    if (layout.kind !== 'release') throw new Error('rollback needs a release layout (releases/ beside a current link)')
    const previous = rollbackRelease(layout.root)
    process.stdout.write(`current -> ${relative(layout.root, previous)}\n`)
    writeLastUpdate({ status: 'restarting', commit: basename(previous) })
    restartService()
}

// Run by the installer on a fresh machine, from the release it just unpacked: points `current` at it
// when nothing does yet and writes the launcher and the units.
export function installLayoutCommand(): void {
    const layout = detectLayout()
    if (layout.kind !== 'release') throw new Error('install-layout runs from a release under <root>/releases/<commit>/')
    if (!linkExists(resolve(layout.root, 'current'))) switchCurrent(layout.root, layout.packageDir)
    for (const path of installLayout(layout.root)) process.stdout.write(`wrote ${path}\n`)
}
