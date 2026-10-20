// Sync SKILL.md files from GitHub repos into synced-skills/<name>/SKILL.md.
// Run: bun scripts/sync-skills.ts
// Edit skills in their source repo, never in synced-skills/. The folder is replaced on every run.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import childProcess from 'node:child_process'
import * as errore from 'errore'

const execFile = util.promisify(childProcess.execFile)

// `path` narrows the search to a folder inside the repo
const SKILL_SOURCES: { repo: string; path?: string }[] = [
  { repo: 'remorses/kimaki', path: 'skills' },
  { repo: 'remorses/playwriter' },
  { repo: 'remorses/tuistory' },
  { repo: 'remorses/zele' },
  { repo: 'remorses/critique' },
  { repo: 'remorses/errore' },
  { repo: 'remorses/egaki', path: 'cli/skills/egaki' },
  { repo: 'remorses/termcast' },
  { repo: 'remorses/goke' },
  { repo: 'remorses/spiceflow' },
  { repo: 'remorses/holocron' },
  { repo: 'remorses/lintcn' },
  { repo: 'remorses/usecomputer' },
  { repo: 'remorses/profano' },
  { repo: 'remorses/sigillo' },
  { repo: 'remorses/strada' },
]

const ROOT_DIR = path.resolve(import.meta.dir, '..')
const OUTPUT_DIR = path.join(ROOT_DIR, 'synced-skills')
const CLONE_TIMEOUT_MS = 120_000

class CloneError extends errore.createTaggedError({
  name: 'CloneError',
  message: 'Failed to clone $repo. Check the repo exists and run: gh auth status',
}) {}

class MissingNameError extends errore.createTaggedError({
  name: 'MissingNameError',
  message: 'No `name:` in frontmatter of $repo/$file',
}) {}

class DuplicateSkillError extends errore.createTaggedError({
  name: 'DuplicateSkillError',
  message: 'Skill $skill exists in both $first and $second. Remove one from SKILL_SOURCES',
}) {}

class SiblingFailedError extends errore.createTaggedError({
  name: 'SiblingFailedError',
  message: 'Aborted because another repo failed to sync',
  extends: errore.AbortError,
}) {}

class InterruptedError extends errore.createTaggedError({
  name: 'InterruptedError',
  message: 'Interrupted by SIGINT',
  extends: errore.AbortError,
}) {}

type Skill = { name: string; repo: string; content: string }

async function git({ args, cwd, signal }: { args: string[]; cwd: string; signal: AbortSignal }) {
  return execFile('git', args, { cwd, signal })
}

async function fetchRepoSkills({
  source,
  tmpDir,
  signal,
}: {
  source: { repo: string; path?: string }
  tmpDir: string
  signal: AbortSignal
}) {
  const cloneDir = path.join(tmpDir, source.repo.replace('/', '__'))
  const cloneSignal = AbortSignal.any([signal, AbortSignal.timeout(CLONE_TIMEOUT_MS)])
  // only SKILL.md blobs are downloaded, so big repos stay cheap
  const pattern = source.path ? `/${source.path}/**/SKILL.md` : 'SKILL.md'

  const cloned = await (async () => {
    const url = `https://github.com/${source.repo}.git`
    await git({ args: ['clone', '--depth=1', '--filter=blob:none', '--no-checkout', url, cloneDir], cwd: tmpDir, signal: cloneSignal })
    await git({ args: ['sparse-checkout', 'set', '--no-cone', pattern], cwd: cloneDir, signal: cloneSignal })
    await git({ args: ['checkout'], cwd: cloneDir, signal: cloneSignal })
  })().catch((e) => new CloneError({ repo: source.repo, cause: e }))
  if (cloned instanceof Error) return cloned

  const files = fs
    .readdirSync(cloneDir, { recursive: true, encoding: 'utf-8' })
    .filter((file) => path.basename(file) === 'SKILL.md' && !file.startsWith('.git'))

  const skills: Skill[] = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(cloneDir, file), 'utf-8')
    const name = content.match(/^---\n[\s\S]*?^name:\s*['"]?([\w.-]+)['"]?\s*$/m)?.[1]
    if (!name) return new MissingNameError({ repo: source.repo, file })
    skills.push({ name, repo: source.repo, content })
  }
  return skills
}

async function syncSkills({ signal }: { signal: AbortSignal }) {
  await using cleanup = new errore.AsyncDisposableStack()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-skills-'))
  cleanup.defer(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const controller = new AbortController()
  const taskSignal = AbortSignal.any([signal, controller.signal])

  const results = await Promise.all(
    SKILL_SOURCES.map(async (source) => {
      const skills = await fetchRepoSkills({ source, tmpDir, signal: taskSignal })
      if (skills instanceof Error) {
        controller.abort(new SiblingFailedError({ cause: skills }))
        return skills
      }
      console.log(`${source.repo}: ${skills.map((s) => s.name).join(', ') || 'no skills'}`)
      return skills
    }),
  )

  const [repoSkills, errors] = errore.partition(results)
  const rootError = errors.find((e) => !errore.findCause(e, SiblingFailedError)) ?? errors[0]
  if (rootError) return rootError

  const byName = new Map<string, Skill>()
  for (const skill of repoSkills.flat()) {
    const existing = byName.get(skill.name)
    if (existing) return new DuplicateSkillError({ skill: skill.name, first: existing.repo, second: skill.repo })
    byName.set(skill.name, skill)
  }

  if (signal.aborted) return new InterruptedError({ cause: signal.reason })

  // write everything to a staging dir first, so a crash never leaves a half-written folder
  const stagingDir = path.join(tmpDir, 'output')
  for (const skill of byName.values()) {
    fs.mkdirSync(path.join(stagingDir, skill.name), { recursive: true })
    fs.writeFileSync(path.join(stagingDir, skill.name, 'SKILL.md'), skill.content)
  }
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  fs.cpSync(stagingDir, OUTPUT_DIR, { recursive: true })
  console.log(`\nSynced ${byName.size} skills to ${OUTPUT_DIR}`)
}

const controller = new AbortController()
process.once('SIGINT', () => controller.abort(new InterruptedError()))

const result = await syncSkills({ signal: controller.signal })
if (result instanceof Error) {
  console.error(result.message)
  if (result.cause) console.error(result.cause)
  process.exit(1)
}
