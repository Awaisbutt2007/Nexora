/* Starts the frontend, the backend AND the desktop agent together with one
   command, so the app can never be open while its API is forgotten — the #1
   cause of a mysterious "Failed to fetch". The desktop agent is optional: it
   only starts when desktop-agent/.env has a valid AGENT_SECRET.
   Usage: npm run dev         (Ctrl+C closes all processes) */
import { spawn } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const backendDir = fileURLToPath(new URL('../backend', import.meta.url))
const rootDir = fileURLToPath(new URL('..', import.meta.url))
const agentDir = fileURLToPath(new URL('../desktop-agent', import.meta.url))
const apiPort = Number(process.env.PORT || 8787)
const agentPort = Number(process.env.AGENT_PORT || 8799)

/* Something already listening on the API port is a leftover backend from an earlier
   terminal. Spawning a second copy would die on EADDRINUSE and leave the user staring at
   code they think is running, so say who owns the port and reuse it instead. */
const portBusy = (port) => new Promise((resolve) => {
  const probe = net.connect({ host: '127.0.0.1', port, timeout: 900 })
  probe.on('connect', () => { probe.destroy(); resolve(true) })
  probe.on('timeout', () => { probe.destroy(); resolve(false) })
  probe.on('error', () => resolve(false))
})

const api = ['api', process.execPath, ['--watch', 'src/index.js'], backendDir]
const web = ['web', process.execPath, ['./node_modules/vite/bin/vite.js'], rootDir]
const agent = ['agent', process.execPath, ['--watch', 'src/index.js'], agentDir]
const targets = (await portBusy(apiPort))
  ? [web]
  : [api, web]
/* Desktop agent: start it only if the agent port is free and the .env has a
   secret configured (otherwise it would refuse to boot and spam an error). */
const agentEnvFile = new URL('../desktop-agent/.env', import.meta.url)
const fs = await import('node:fs')
const agentConfigured = fs.existsSync(fileURLToPath(agentEnvFile))
  && fs.readFileSync(fileURLToPath(agentEnvFile), 'utf8').includes('AGENT_SECRET=')
  && !fs.readFileSync(fileURLToPath(agentEnvFile), 'utf8').match(/AGENT_SECRET=\s*$/m)
if (agentConfigured && !(await portBusy(agentPort))) {
  targets.push(agent)
} else if (!agentConfigured) {
  console.log('[agent] skipped — desktop-agent/.env missing or AGENT_SECRET not set (run: npm run dev:agent manually once configured)')
}
if (targets.length === 1) {
  console.log(`[api] port ${apiPort} is already answering — reusing that backend.`)
  console.log('[api] if you changed backend code, close the terminal running it and re-run this.')
}

const children = targets.map(([name, cmd, args, cwd]) => {
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const pipe = (stream, out) => {
    stream.setEncoding('utf8')
    let rest = ''
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const line of lines) out.write(`[${name}] ${line}\n`)
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  return child
})

const shutdown = () => {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
for (const child of children) {
  child.on('exit', (code) => {
    if (children.some((c) => c.exitCode === null && c.signalCode === null)) return
    process.exit(code ?? 0)
  })
}
