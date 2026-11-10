# The agent's computer: how it works, and where it can go

This note describes the agent computer as it ships (Nov 2026), then weighs the options for what
comes next. The routes are in `API.md` (Desktop), the tools in `GUIDE.md` (`computer`,
`computerRecording`), the packages, limits and security model in the README ("The agent's
computer", "Configuration"). Nothing below the "Options" heading is built.

## Architecture as it stands

One engine process per box (the Docker image `apps/engine/Dockerfile`, or a Debian/Ubuntu server),
serving every agent of one workspace. Each agent that needs a screen gets one:

```
              app (Next.js)                              engine box (Linux)
 ┌──────────────────────────────┐        ┌─────────────────────────────────────────────────┐
 │ DesktopViewer (noVNC canvas) │──wss──▶│ /desktop/ws?ticket=…  bridge.ts (view | drive)    │
 │ FloatingScreen, notch, hold  │        │        │ localhost:5900+N                         │
 │ ScreenActivityCard           │──http─▶│ x11vnc ── Xvfb :N ── openbox, tint2, apps,       │
 └──────────────────────────────┘        │                     patchright Chromium           │
                                         │ computer tools ─ xdotool (input), maim (capture) │
                                         │ recording.ts ─ ffmpeg x11grab → workspace/screen/ │
                                         └─────────────────────────────────────────────────┘
```

- **Display** (`src/tools/virtual-display.ts`): one Xvfb per agent, 1920x1080x24, refcounted, gone a
  minute after its last holder.
- **Desktop** (`src/desktop/session.ts`): openbox, x11vnc bound to localhost on 5900+N, the tint2
  dock and bar. Started lazily, stopped `RERUN_DESKTOP_IDLE_STOP_MINUTES` after the last viewer,
  hold or run lets go, capped at `RERUN_DESKTOP_MAX_SCREENS` per box (503 past it). `GET /desktop`
  reports each screen's uptime.
- **Process hygiene** (`src/lib/child-reaper.ts`): every screen process (Xvfb, x11vnc, openbox, tint2,
  ffmpeg, the apps) is SIGKILLed when the engine exits, including one still in the grace of its own
  stop. An engine killed with SIGKILL cannot run that hook; in Docker the container going down takes
  them with it, on a bare server a restart can find an x11vnc on its port, and the desktop then
  refuses to start on that display rather than talk to a stranger (`PORT_FREE_TIMEOUT_MS`).
- **Model-facing tools** (`src/tools/builtin/computer.ts`): one run owns an agent's screen at a time.
  The generic `computer` tool (screenshot, zoom, clicks, drag, scroll, type, key, type_secret, wait)
  answers each action with a screenshot capped at 1280x720. A zoom frames later coordinates until
  the next plain screenshot. Claude 5 models on the `anthropic` provider get
  `computer_toolset_20260801` instead, mapped onto the same executor, with a peek-only zoom.
  Screenshots never enter stored conversation: the run keeps the latest
  `RERUN_COMPUTER_SCREENSHOTS_IN_CONTEXT` in memory (`src/runtime/screenshots.ts`).
- **People on the screen**: watch/drive over the ticketed WebSocket, the explicit hold
  ("Take over" / "I'm done", `src/desktop/hold.ts`), the takeover browser for sign-ins
  (`src/desktop/takeover.ts`). The agent is told when a person drove between two of its actions.
- **Secrets** (`src/desktop/screen-secrets.ts`): `type_secret` types a value from the agent's `.env`
  into the engine's browser window only on the secret's own site, behind a per-run approval, and
  answers without a screenshot.
- **Evidence** (`src/desktop/recording.ts`): one `workspace/screen/<session id>/` folder per screen
  session with every action screenshot and a fragmented MP4 (pausable into segments), the last
  `RERUN_COMPUTER_SESSIONS_KEPT` kept.

**Isolation today.** Screens, VNC ports and browser profiles are per agent. The filesystem, the Unix
user and the network are per box: the terminal and file manager of one agent can read another's
folder. This is the same trust boundary as a VM per account: everything on one box belongs to
one workspace. Boxes are the unit of isolation between workspaces, which Rerun Cloud already gives
each workspace (`claimPoolEngine` in `@rerun/cloud/engines`).

## Options

### 1. A container per computer (the webtop / KasmVNC-workspace pattern)

Run each agent's screen in its own container (linuxserver/webtop-style image: Xvfb or KasmVNC,
a window manager, a browser), with only that agent's workspace mounted, a user of its own and
optionally a network policy. The engine would talk to it over the container network instead of
spawning processes.

- **Gains**: real per-agent file and user isolation; per-screen CPU/memory limits (cgroups)
  replace the coarse `RERUN_DESKTOP_MAX_SCREENS`; a crashed screen cannot leave orphans on the box;
  images can carry per-template software.
- **Costs**: the engine needs a container runtime it controls (Docker socket or a rootless Podman
  inside the box, which is itself a container: Docker-in-Docker or sysbox, a real security and ops
  burden); 300–600 MB of image per screen flavour; start time goes from ~1 s to several seconds;
  `xdotool`/`maim`/`ffmpeg` must run inside the container (an exec API or a small agent in the
  image); the takeover's patchright profile and its lock move across a container boundary.
- **Recommendation**: not now. The workspace is the trust boundary customers pay for, and one box per
  workspace already enforces it. Revisit when a single workspace needs agents that must not see
  each other's files (a regulated team, a shared marketplace agent). Prepare for it cheaply: keep
  every screen operation behind `controlScreen()` / `ensureDesktop()` so a container backend is a
  second implementation of the same functions, not a rewrite.

### 2. KasmVNC or Selkies instead of x11vnc + noVNC

- **KasmVNC** replaces Xvfb + x11vnc with one X server that streams to its own web client over
  WebSocket, with WebP/JPEG/QOI encoding, dynamic resize, clipboard both ways (text and images)
  and audio. Same RFB-derived protocol family, so noVNC-compatible mode exists, but its best
  features need its own client.
- **Selkies-GStreamer** streams the X display as WebRTC video (H.264/VP8, hardware encode when a GPU
  exists): far smoother for video and animation, much lower bandwidth on busy screens, but a
  TURN server is needed behind NAT and input is a separate data channel.
- **What it would fix**: the clipboard-out limitation phase 2 found (the browser refuses
  `navigator.clipboard` writes without focus), choppy view on fast-moving pages, bandwidth on
  phones. **What it would cost**: the bridge (`bridge.ts`), the ticket, the drive-mode input
  detector (`driverActed`) and `DesktopViewer` are all built on RFB through noVNC; the mobile app
  embeds the same client.
- **Recommendation**: KasmVNC first, if anything, because it keeps an RFB-shaped stream and Xvfb's
  role, so `xdotool`, `maim` and `ffmpeg x11grab` keep working against its display. Try it as an
  opt-in image variant (`RERUN_DESKTOP_SERVER=kasmvnc`), measure bandwidth and latency on a real
  agent run, and keep x11vnc as the default until it wins. Selkies only if live video quality
  becomes a product requirement; it needs a GPU-less benchmark first.

### 3. Windows apps (dockur/windows)

dockur/windows boots a real Windows VM under QEMU inside a container, exposed over RDP/VNC.

- **Hard requirement**: `/dev/kvm` on the host. Most cloud VMs (including the boxes Rerun runs
  today) do not expose nested virtualization; bare metal or nested-virt instance types do. Without
  KVM it falls back to emulation that is unusably slow.
- **Also**: 4+ GB RAM and 64 GB disk per VM, minutes to first boot, Windows licensing is on the
  operator, and the agent's tools (`xdotool`, `maim`) do not exist there: control would go through
  the VNC/RDP protocol itself (send pointer/key events, read framebuffer) rather than X tools.
- **Recommendation**: do not build into the engine. If a customer needs a Windows app, the shape
  is a separate "Windows computer" box type with its own executor speaking VNC, selected per agent,
  behind the same model-facing `computer` tool. The `ScreenControl` abstraction (view, scale,
  capture, input primitives in `control.ts`) is the seam: a VNC-protocol implementation of
  capture/click/type makes the tool work unchanged.

### 4. A managed pool in Rerun Cloud behind `@rerun/cloud/computer`

Rerun Cloud could run screens on a pool of machines sized for them (GPU encode, more RAM) instead
of on each workspace's engine box, keeping engine boxes small.

- **Seam**: a new `@rerun/cloud/computer` domain, following the repo's rule that whatever Rerun Cloud
  runs differently is reached only through `@rerun/cloud/<domain>`:
  - `cloud/packages/cloud/src/computer.ts` (private): leases a screen from the managed pool for an
    agent, returns where its VNC stream and control endpoint live, releases it.
  - `apps/ui/cloud-oss/computer.ts` (public twin, today's behaviour): the screen is the agent's
    engine box; it returns the engine's own desktop routes, exactly what the app calls now. A
    self-hosted install never leases anything.
  - Where it plugs in: the app already resolves the desktop's relay through
    `desktopRelayBase` in `@rerun/cloud/engines`; screen leasing would sit beside it. On the engine
    side, the control functions (`ensureDesktop`, `controlScreen`) would gain a remote
    implementation selected by configuration the hub hands the box, not by importing cloud code
    (the engine has no `@rerun/cloud` alias and stays fully AGPL).
  - Tests of public code that check the Cloud behaviour pin `@rerun/cloud/computer` with `vi.mock`.
- **Hard parts**: the workspace files the agent works on live on the engine box (the file manager,
  the terminal, uploads into the screen, the evidence folder), so a remote screen needs either a
  synced or network-mounted workspace or a much narrower screen (browser only); latency between
  the engine's executor and a remote display adds to every action.
- **Recommendation**: only after option 1's backend split exists, and only for a browser-only
  screen first (no workspace mount needed, the bulk of real agent screen use). Until then, scale by
  box size: the configurable limits shipped here let Cloud tune `RERUN_DESKTOP_MAX_SCREENS` and
  idle time per box class without code.

## Summary

| Option | Verdict | Trigger to revisit |
| --- | --- | --- |
| Container per computer | Not now; keep the `ensureDesktop`/`controlScreen` seam clean | Agents of one workspace must not share files |
| KasmVNC | Prototype as an opt-in image variant | Clipboard and smoothness complaints, mobile bandwidth |
| Selkies | No | Video-grade live view becomes a requirement |
| Windows via dockur | Separate box type, never inside the engine | A paying customer needs a Windows-only app, on KVM hosts |
| Managed Cloud pool | After the backend split, browser-only first | Engine boxes cannot be sized for their screens |
