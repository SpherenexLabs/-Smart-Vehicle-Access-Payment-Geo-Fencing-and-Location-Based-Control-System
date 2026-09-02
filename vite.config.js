import fs from 'node:fs'
import path from 'node:path'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// Persists the dashboard's database to a JSON file inside this project
// folder (data/db.json) instead of the browser's localStorage, so the
// data survives browser restarts / "clear on exit" settings.
function localFileDbPlugin() {
  const dataDir = path.resolve(process.cwd(), 'data')
  const dbFile = path.join(dataDir, 'db.json')

  const handler = (req, res) => {
    if (req.method === 'GET') {
      if (!fs.existsSync(dbFile)) {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader('Content-Type', 'application/json')
      fs.createReadStream(dbFile).pipe(res)
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          JSON.parse(body)
          if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
          fs.writeFileSync(dbFile, body)
          res.statusCode = 204
          res.end()
        } catch (err) {
          res.statusCode = 400
          res.end(String(err))
        }
      })
      return
    }
    res.statusCode = 405
    res.end()
  }

  return {
    name: 'local-file-db',
    configureServer(server) {
      server.middlewares.use('/api/db', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/db', handler)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    localFileDbPlugin(),
  ],
  server: {
    host: true,
  },
})
