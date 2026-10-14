// One-time migration: data/db.json  ->  Firebase Realtime Database
// ----------------------------------------------------------------
// Copies the old local JSON database into child nodes under the
// smart_vehicle_system root node. Run once with:
//
//   node scripts/migrate-db-to-firebase.mjs
//
// It refuses to run if the root node already holds data; pass --force to
// overwrite it anyway.

import fs from 'node:fs'
import path from 'node:path'

const DATABASE_URL = 'https://diet-planner-3bdf3-default-rtdb.firebaseio.com'
const DB_ROOT = 'smart_vehicle_system'
const DB_NODES = [
  'meta',
  'settings',
  'users',
  'dropLocations',
  'rides',
  'payments',
  'locationSamples',
  'events',
  'vehicle',
]

const rootUrl = `${DATABASE_URL}/${DB_ROOT}.json`
const sourceFile = path.resolve(process.cwd(), 'data', 'db.json')
const force = process.argv.includes('--force')

if (!fs.existsSync(sourceFile)) {
  console.error(`No source file at ${sourceFile} - nothing to migrate.`)
  process.exit(1)
}

const local = JSON.parse(fs.readFileSync(sourceFile, 'utf8'))

const existing = await fetch(`${rootUrl}?shallow=true`).then((r) => r.json())
if (existing && !force) {
  console.error(`${DB_ROOT} already contains data:`, Object.keys(existing).join(', '))
  console.error('Re-run with --force to overwrite it.')
  process.exit(1)
}

const payload = {}
for (const node of DB_NODES) {
  const value = local[node]
  payload[node] = Array.isArray(value) && value.length === 0 ? null : value ?? null
}

const res = await fetch(rootUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

if (!res.ok) {
  console.error(`Upload failed: HTTP ${res.status} ${await res.text()}`)
  process.exit(1)
}

console.log(`Migrated data/db.json into ${DATABASE_URL}/${DB_ROOT}`)
for (const node of DB_NODES) {
  const value = payload[node]
  const count = Array.isArray(value) ? `${value.length} records` : value ? 'object' : 'empty'
  console.log(`  ${DB_ROOT}/${node}: ${count}`)
}
