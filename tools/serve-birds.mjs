// Serves the birdsbirdbirds challenge page on the requested port with Host header forwarding.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const setupHook = path.join(repoRoot, 'challenges', 'birdsbirdbirds', 'setup')
const cleanupHook = path.join(repoRoot, 'challenges', 'birdsbirdbirds', 'cleanup')

const port = Number(process.env.PORT || 3000)
const internalPort = 4322
const runDir = path.join('/tmp', `birds-serve-${Date.now()}`)

fs.mkdirSync(runDir, { recursive: true })

const setup = spawn(setupHook, [], { cwd: runDir, stdio: 'inherit' })
setup.on('exit', (code) => {
  if (code !== 0) {
    console.error(`setup failed with code ${code}`)
    process.exit(code ?? 1)
  }

  const proxy = http.createServer((req, res) => {
    const options = {
      hostname: '127.0.0.1',
      port: internalPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${internalPort}` },
    }
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res, { end: true })
    })
    req.pipe(proxyReq, { end: true })
  })

  proxy.listen(port, '0.0.0.0', () => {
    console.log(`BirdsBirdBirds server listening on port ${port}`)
  })

  function cleanup() {
    try {
      spawn(cleanupHook, [], { cwd: runDir, stdio: 'ignore' })
    } catch {}
    process.exit(0)
  }

  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
})
