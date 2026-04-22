// Flatten drizzle-kit migrations for wrangler D1 compatibility.
//
// Drizzle-kit generates migrations as `<timestamp>_<name>/migration.sql`
// subdirectories, but wrangler D1 only recognizes flat `.sql` files.
// This script scans a migrations directory, finds any subdirectory that
// contains a `migration.sql` but has no corresponding flat `.sql` file,
// and copies it out with sequential numbering (0001_, 0002_, ...).
//
// Tracking issues:
//   https://github.com/drizzle-team/drizzle-orm/issues/5266 (--flat flag request)
//   https://github.com/cloudflare/workers-sdk/issues/13257 (wrangler subdirectory support)
// TODO: Remove this script when drizzle-kit adds a --flat flag or wrangler supports subdirectories.
//
// Usage: tsx scripts/flatten-migrations.ts <migrations-dir>
// Supports pnpm passthrough: pnpm run flatten -- <override-dir>

import fs from 'node:fs'
import path from 'node:path'

function flattenMigrations(migrationsDir: string) {
  const absDir = path.resolve(migrationsDir)
  if (!fs.existsSync(absDir)) {
    console.error(`Directory not found: ${absDir}`)
    process.exit(1)
  }

  const entries = fs.readdirSync(absDir, { withFileTypes: true })

  // Find highest existing sequence number
  const flatFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort()

  let nextSeq = 1
  for (const name of flatFiles) {
    const match = name.match(/^(\d+)_/)
    if (match) {
      const num = parseInt(match[1]!, 10)
      if (num >= nextSeq) nextSeq = num + 1
    }
  }

  // Build content set of existing flat files for dedup
  const flatContents = new Set<string>()
  for (const name of flatFiles) {
    flatContents.add(fs.readFileSync(path.join(absDir, name), 'utf-8'))
  }

  // Find and flatten new subdirectory migrations
  const subdirs = entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(absDir, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort()

  let created = 0
  for (const subdir of subdirs) {
    const content = fs.readFileSync(path.join(absDir, subdir, 'migration.sql'), 'utf-8')
    if (flatContents.has(content)) continue

    const slug = subdir.replace(/^\d+_/, '')
    const flatName = `${String(nextSeq).padStart(4, '0')}_${slug}.sql`
    fs.copyFileSync(path.join(absDir, subdir, 'migration.sql'), path.join(absDir, flatName))
    console.log(`Created ${flatName}`)
    flatContents.add(content)
    nextSeq++
    created++
  }

  if (created === 0) console.log('All migrations already flattened.')
  else console.log(`Flattened ${created} migration(s).`)
}

// Support pnpm passthrough: `pnpm run flatten -- ../other-dir`
const args = process.argv.slice(2).filter((a) => a !== '--')
const dir = args.at(-1)
if (!dir) {
  console.error('Usage: tsx scripts/flatten-migrations.ts <migrations-dir>')
  process.exit(1)
}

console.log(`Scanning ${path.resolve(dir)}`)
flattenMigrations(dir)
