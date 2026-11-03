// Sync the HyperFrames skills from heygen-com/hyperframes into hyperframes-skills/.
// Run: bun scripts/sync-hyperframes-skills.ts
// The folder is replaced on every run; never edit it by hand.
//
// Every skill is renamed to start with `hyperframes` (media-use -> hyperframes-media-use), and
// references to the renamed skills inside the markdown are rewritten to match. Descriptions get
// a gate so models only load them when the user mentions HyperFrames.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import childProcess from 'node:child_process'
import * as errore from 'errore'

const execFile = util.promisify(childProcess.execFile)

const REPO = 'heygen-com/hyperframes'
const SKILLS_PATH = 'skills'
const PREFIX = 'hyperframes'
const GATE = 'Only load when the user explicitly mentions HyperFrames.'
const ROOT_DIR = path.resolve(import.meta.dir, '..')
const OUTPUT_DIR = path.join(ROOT_DIR, 'hyperframes-skills')
const CLONE_TIMEOUT_MS = 120_000

class CloneError extends errore.createTaggedError({
  name: 'CloneError',
  message: 'Failed to clone $repo. Check your network and run: gh auth status',
}) {}

class FrontmatterError extends errore.createTaggedError({
  name: 'FrontmatterError',
  message: 'Unexpected frontmatter in $file: expected single-line `name:` and `description:`',
}) {}

function prefixed(name: string) {
  return name.startsWith(PREFIX) ? name : `${PREFIX}-${name}`
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// `/media-use`, `../media-use/x`, `skills/media-use/x` and `` `media-use` `` point at the skill;
// `dist/media-use/` or `/media-use-cache` do not.
function rewriteReferences({ text, renames }: { text: string; renames: Map<string, string> }) {
  let out = text
  for (const [from, to] of renames) {
    const name = escapeRegExp(from)
    out = out
      .replace(new RegExp(`(^|[\\s\`(\\[,"'])/${name}(?![\\w-])`, 'gm'), `$1/${to}`)
      .replace(new RegExp(`(\\.\\./|skills/)${name}/`, 'g'), `$1${to}/`)
      .replace(new RegExp(`\`${name}\``, 'g'), `\`${to}\``)
  }
  return out
}

function rewriteFrontmatter({ text, name, file }: { text: string; name: string; file: string }) {
  const nameLine = /^name:\s*\S+\s*$/m
  const descLine = /^description:\s*(?![>|])(.+)$/m
  if (!nameLine.test(text) || !descLine.test(text)) return new FrontmatterError({ file })
  return text
    .replace(nameLine, `name: ${name}`)
    .replace(descLine, (_, desc: string) => `description: ${desc.startsWith(GATE) ? desc : `${GATE} ${desc}`}`)
}

async function sync({ signal }: { signal: AbortSignal }) {
  await using cleanup = new errore.AsyncDisposableStack()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-hyperframes-skills-'))
  cleanup.defer(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const cloneDir = path.join(tmpDir, 'repo')
  const cloneSignal = AbortSignal.any([signal, AbortSignal.timeout(CLONE_TIMEOUT_MS)])
  console.log(`cloning ${REPO} (${SKILLS_PATH}/ only)`)
  const cloned = await (async () => {
    const git = (args: string[], cwd: string) => execFile('git', args, { cwd, signal: cloneSignal })
    await git(['clone', '--depth=1', '--filter=blob:none', '--sparse', `https://github.com/${REPO}.git`, cloneDir], tmpDir)
    await git(['sparse-checkout', 'set', SKILLS_PATH], cloneDir)
    return (await git(['rev-parse', '--short', 'HEAD'], cloneDir)).stdout.trim()
  })().catch((e) => new CloneError({ repo: REPO, cause: e }))
  if (cloned instanceof Error) return cloned
  console.log(`cloned at ${cloned}`)

  const srcDir = path.join(cloneDir, SKILLS_PATH)
  const skills = fs.readdirSync(srcDir).filter((d) => fs.existsSync(path.join(srcDir, d, 'SKILL.md')))
  const renames = new Map(skills.filter((s) => prefixed(s) !== s).map((s) => [s, prefixed(s)]))

  // write to a staging dir first, so a crash never leaves a half-written folder
  const stagingDir = path.join(tmpDir, 'output')
  for (const skill of skills) {
    const name = prefixed(skill)
    const dest = path.join(stagingDir, name)
    // upstream unit tests need the full monorepo; they are useless here
    fs.cpSync(path.join(srcDir, skill), dest, { recursive: true, filter: (src) => !src.endsWith('.test.mjs') })

    const mdFiles = fs
      .readdirSync(dest, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.md'))
    for (const file of mdFiles) {
      const full = path.join(dest, file)
      fs.writeFileSync(full, rewriteReferences({ text: fs.readFileSync(full, 'utf-8'), renames }))
    }

    const skillFile = path.join(dest, 'SKILL.md')
    const text = rewriteFrontmatter({ text: fs.readFileSync(skillFile, 'utf-8'), name, file: `${skill}/SKILL.md` })
    if (text instanceof Error) return text
    fs.writeFileSync(skillFile, text)
    console.log(`${skill} -> ${name} (${mdFiles.length} markdown files)`)
  }

  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  fs.cpSync(stagingDir, OUTPUT_DIR, { recursive: true })
  console.log(`\nSynced ${skills.length} skills from ${REPO}@${cloned} to ${OUTPUT_DIR}`)
}

const controller = new AbortController()
process.once('SIGINT', () => controller.abort(new Error('Interrupted by SIGINT')))

const result = await sync({ signal: controller.signal })
if (result instanceof Error) {
  console.error(result.message)
  if (result.cause) console.error(result.cause)
  process.exit(1)
}
