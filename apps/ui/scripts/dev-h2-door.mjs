// The HTTP/2 door of the dev server.
//
// `next dev` speaks HTTP/1.1, and Chrome grants an h1 origin six sockets for the whole profile.
// A board tab holds several of them open for good — realtime, the foreman stream, HMR — so a
// second tab plus one hot reload exhausts the pool, and from then on every refresh hangs while
// incognito (a separate pool) works fine. Production never sees this: it serves HTTP/2, where one
// connection multiplexes everything. This proxy gives dev the same property: it terminates TLS,
// negotiates h2 with the browser, and forwards to the h1 dev server on localhost.
//
// Started automatically by instrumentation.ts with every `pnpm dev` (set DEV_H2_DOOR=off to skip),
// or by hand: `node scripts/dev-h2-door.mjs 3050`. The plain http://localhost:<port> stays exactly
// as it is — the engine, the Slack webhook and ngrok keep using it; the https door is for browsers.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createSecureServer } from 'node:http2'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hubPort = Number(process.argv[2] ?? process.env.PORT ?? 3000)
const doorPort = Number(process.env.DEV_H2_PORT ?? hubPort + 400)

// mkcert gives a certificate the machine already trusts (green lock, no warning); without it,
// openssl makes a self-signed one and Chrome asks once per machine: Advanced → Proceed.
function certificate() {
    const dir = join(here, '..', '.dev-certs')
    const key = join(dir, 'localhost-key.pem')
    const cert = join(dir, 'localhost.pem')
    if (!existsSync(key) || !existsSync(cert)) {
        mkdirSync(dir, { recursive: true })
        try {
            execFileSync('mkcert', ['-key-file', key, '-cert-file', cert, 'localhost', '127.0.0.1'], { stdio: 'ignore' })
        } catch {
            execFileSync('openssl', [
                'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                '-keyout', key, '-out', cert, '-nodes', '-days', '825',
                '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
            ], { stdio: 'ignore' })
        }
    }
    return { key: readFileSync(key), cert: readFileSync(cert) }
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'http2-settings', 'te', 'trailer']

const server = createSecureServer({ ...certificate(), allowHTTP1: true })

server.on('request', (req, res) => {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
        if (!name.startsWith(':') && !HOP_BY_HOP.includes(name)) headers[name] = value
    }
    // The host stays the door's own (h2 carries it as :authority): Next checks Origin against
    // Host on every server action, and a rewritten host would fail that check and silently
    // swallow each action. The forwarded pair is the standard way to say "behind TLS".
    headers.host = req.headers[':authority'] ?? req.headers.host ?? `localhost:${doorPort}`
    headers['x-forwarded-proto'] = 'https'
    headers['x-forwarded-host'] = headers.host
    const upstream = httpRequest({ host: '127.0.0.1', port: hubPort, method: req.method, path: req.url, headers }, upstreamRes => {
        const out = {}
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (!HOP_BY_HOP.includes(name)) out[name] = value
        }
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        upstreamRes.pipe(res)
    })
    upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('dev server not answering on :' + hubPort)
    })
    req.pipe(upstream)
})

// The HMR websocket arrives on an http/1.1 TLS connection (browsers do not upgrade inside h2):
// spliced through raw, one extra socket, still five under Chrome's limit.
server.on('upgrade', (req, socket, head) => {
    const upstream = connect(hubPort, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        upstream.write(lines.join('\r\n') + '\r\n\r\n')
        if (head?.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
    })
    const drop = () => {
        socket.destroy()
        upstream.destroy()
    }
    upstream.on('error', drop)
    socket.on('error', drop)
})

// A door is already open (this server restarted, the old child is still up): nothing to do.
server.on('error', err => {
    if (err.code === 'EADDRINUSE') process.exit(0)
    console.error('[h2 door]', err.message)
    process.exit(1)
})

// Dies with the dev server it belongs to, even when the parent could not say goodbye.
setInterval(() => {
    if (process.ppid === 1) process.exit(0)
}, 5000).unref()

server.listen(doorPort, () => {
    console.log(`  \x1b[32m▲ h2\x1b[0m   https://localhost:${doorPort} → http://localhost:${hubPort} — open this one in the browser; HTTP/2 ends the six-socket stalls`)
})
