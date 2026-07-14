#!/usr/bin/env bun
/**
 * Rewrites git commit timestamps for weekday commits made before a target hour,
 * shifting them to a random (but deterministic per-commit) time in the evening.
 *
 * Usage:
 *   bun ~/.config/opencode/skills/shift-commits/shift-commits.ts --after 2026-07-06 --dry-run
 *   bun ~/.config/opencode/skills/shift-commits/shift-commits.ts --after 2026-07-06 --run
 *
 * GIT_AUTHOR_DATE format inside filter-branch: @<epoch> <offset>  e.g. @1783354530 -0700
 */

import { execSync } from 'node:child_process'
import { goke } from 'goke'
import { z } from 'zod'

// Minimal terminal colors (no dependency needed)
const isColorSupported =
  process.env.FORCE_COLOR !== '0' &&
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR || process.stdout.isTTY)
const fmt =
  (open: string, close: string) => (s: string) =>
    isColorSupported ? `\x1b[${open}m${s}\x1b[${close}m` : s
const colors = {
  bold: fmt('1', '22'),
  dim: fmt('2', '22'),
  red: fmt('31', '39'),
  green: fmt('32', '39'),
  yellow: fmt('33', '39'),
}

const cli = goke('shift-commits')

cli
  .command('', 'Shift weekday before-5PM git commits to after 5 PM')
  .option(
    '--after <date>',
    z
      .string()
      .describe(
        'Start date (YYYY-MM-DD). Only commits on or after this date are shifted',
      ),
  )
  .option('--min-hour [hour]', 'Minimum target hour (default: 17)')
  .option('--max-hour [hour]', 'Maximum target hour (default: 22)')
  .option('--run', 'Actually rewrite commits (default is dry-run)')
  .option('--dry-run', 'Preview changes without rewriting (default behavior)')
  .action((options) => {
    const afterDate = options.after as string
    const minHour = options.minHour ? Number(options.minHour) : 17
    const maxHour = options.maxHour ? Number(options.maxHour) : 22
    const isDryRun = !options.run
    const hourRange = maxHour - minHour + 1

    if (maxHour < minHour) {
      console.error(
        colors.red('--max-hour must be >= --min-hour'),
      )
      process.exit(1)
    }

    // Parse the after date into YYYYMMDD integer
    const dateMatch = afterDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!dateMatch) {
      console.error(
        colors.red('--after must be YYYY-MM-DD format'),
      )
      process.exit(1)
    }
    const rangeStartDate = parseInt(
      dateMatch[1] + dateMatch[2] + dateMatch[3],
      10,
    )

    function run(cmd: string): string {
      return execSync(cmd, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }).trim()
    }

    /**
     * Deterministic hour from commit hash, matching the env-filter logic.
     * Uses first 8 hex chars -> decimal -> mod hourRange + minHour.
     */
    function hashToHour(commitHash: string): number {
      const hex8 = commitHash.slice(0, 8)
      const dec = parseInt(hex8, 16)
      return minHour + (dec % hourRange)
    }

    /**
     * Convert a timezone offset string like "-0700" or "+0530" to seconds.
     */
    function offsetToSeconds(offset: string): number {
      const sign = offset.startsWith('-') ? -1 : 1
      const digits = offset.replace(/[+-]/, '')
      const hours = parseInt(digits.slice(0, 2), 10)
      const minutes = parseInt(digits.slice(2, 4), 10)
      return sign * (hours * 3600 + minutes * 60)
    }

    // Verify we are in a git repo
    try {
      run('git rev-parse --is-inside-work-tree')
    } catch {
      console.error(colors.red('Not inside a git repository'))
      process.exit(1)
    }

    // Grab a generous range of commits and filter by author date ourselves
    const dayBefore = new Date(afterDate)
    dayBefore.setDate(dayBefore.getDate() - 2)
    const queryDate = dayBefore.toISOString().split('T')[0]

    const allRecent = run(
      `git log --after="${queryDate}" --format="%H %ai"`,
    )
      .split('\n')
      .filter(Boolean)

    if (allRecent.length === 0) {
      console.log('No commits found in range')
      process.exit(0)
    }

    // Parse and filter commits
    interface CommitInfo {
      hash: string
      date: string
      time: string
      offset: string
      dateNum: number
      hour: number
      dayOfWeek: number // 1=Mon, 7=Sun
      needsShift: boolean
      newHour?: number
    }

    const commits: CommitInfo[] = []

    for (const line of allRecent) {
      const [hash, date, time, offset] = line.split(' ')
      const dateNum = parseInt(date.replace(/-/g, ''), 10)

      if (dateNum < rangeStartDate) continue

      const hour = parseInt(time.split(':')[0], 10)

      const isoStr = `${date}T${time}${offset.slice(0, 3)}:${offset.slice(3)}`
      const d = new Date(isoStr)
      const dayOfWeek = d.getDay() // 0=Sun, 6=Sat
      const isoDow = dayOfWeek === 0 ? 7 : dayOfWeek // 1=Mon, 7=Sun

      const isWeekday = isoDow >= 1 && isoDow <= 5
      const isBeforeTarget = hour < minHour
      const needsShift = isWeekday && isBeforeTarget

      const info: CommitInfo = {
        hash,
        date,
        time,
        offset,
        dateNum,
        hour,
        dayOfWeek: isoDow,
        needsShift,
      }

      if (needsShift) {
        info.newHour = hashToHour(hash)
      }

      commits.push(info)
    }

    if (commits.length === 0) {
      console.log(`No commits found on or after ${afterDate}`)
      process.exit(0)
    }

    // Find parent commit for filter-branch range
    const oldestCommit = commits[commits.length - 1].hash
    let parentCommit: string
    try {
      parentCommit = run(`git rev-parse ${oldestCommit}^`)
    } catch {
      console.error(
        colors.red(
          `Cannot find parent of oldest commit ${oldestCommit.slice(0, 8)}. Is this the initial commit?`,
        ),
      )
      process.exit(1)
    }

    console.log(`Found ${colors.bold(String(commits.length))} commits in range`)
    console.log(
      `Parent (rewrite base): ${colors.dim(parentCommit.slice(0, 8))}`,
    )
    console.log()

    let shiftCount = 0
    let skipCount = 0
    const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    for (const c of commits) {
      if (c.needsShift) {
        const [, mins, secs] = c.time.split(':')
        const newTime = `${String(c.newHour).padStart(2, '0')}:${mins}:${secs}`
        console.log(
          `${colors.green('SHIFT')} ${c.hash.slice(0, 8)} ${dayNames[c.dayOfWeek]} ${c.date} ${c.time} ${colors.dim('->')} ${colors.green(newTime)} ${c.offset}`,
        )
        shiftCount++
      } else {
        const reason =
          c.dayOfWeek > 5
            ? `weekend (${dayNames[c.dayOfWeek]})`
            : `already >=${minHour}:00`
        console.log(
          `${colors.dim('SKIP')}  ${c.hash.slice(0, 8)} ${dayNames[c.dayOfWeek]} ${c.date} ${c.time} ${colors.dim(`(${reason})`)}`,
        )
        skipCount++
      }
    }

    console.log(
      `\nSummary: ${colors.green(String(shiftCount))} to shift, ${colors.dim(String(skipCount))} to skip`,
    )

    if (isDryRun) {
      console.log(
        `\n${colors.yellow('Dry-run mode.')} Pass ${colors.bold('--run')} to rewrite commits.`,
      )
      process.exit(0)
    }

    console.log('\nRewriting commits with git filter-branch...')

    // Build the env-filter. Runs in /bin/sh inside filter-branch.
    // GIT_AUTHOR_DATE/GIT_COMMITTER_DATE format: @<epoch> <offset>
    const envFilter = `
AUTHOR_EPOCH=\${GIT_AUTHOR_DATE%% *}
AUTHOR_EPOCH=\${AUTHOR_EPOCH#@}
AUTHOR_OFFSET=\${GIT_AUTHOR_DATE##* }

OFFSET_SIGN=\${AUTHOR_OFFSET%"\${AUTHOR_OFFSET#?}"}
OFFSET_DIGITS=\${AUTHOR_OFFSET#?}
OFFSET_H=\${OFFSET_DIGITS%??}
OFFSET_M=\${OFFSET_DIGITS#??}
OFFSET_SECS=$(( (1\${OFFSET_H} - 100) * 3600 + (1\${OFFSET_M} - 100) * 60 ))
if [ "$OFFSET_SIGN" = "-" ]; then
  OFFSET_SECS=$(( -OFFSET_SECS ))
fi

LOCAL_EPOCH=$(( AUTHOR_EPOCH + OFFSET_SECS ))

LOCAL_DATE=$(TZ=UTC date -r "$LOCAL_EPOCH" "+%Y%m%d")
HOUR=$(TZ=UTC date -r "$LOCAL_EPOCH" "+%H")
DOW=$(TZ=UTC date -r "$LOCAL_EPOCH" "+%u")

HOUR_INT=$((10#$HOUR))
DOW_INT=$((10#$DOW))
LOCAL_DATE_INT=$((10#$LOCAL_DATE))

if [ "$LOCAL_DATE_INT" -ge ${rangeStartDate} ] && \\
   [ "$DOW_INT" -le 5 ] && \\
   [ "$HOUR_INT" -lt ${minHour} ]; then

  HASH_NUM=\${GIT_COMMIT%\${GIT_COMMIT#????????}}
  HASH_DEC=$((16#$HASH_NUM))
  NEW_HOUR=$(( ${minHour} + HASH_DEC % ${hourRange} ))

  DIFF_SECS=$(( (NEW_HOUR - HOUR_INT) * 3600 ))

  NEW_AUTHOR_EPOCH=$(( AUTHOR_EPOCH + DIFF_SECS ))

  COMMITTER_EPOCH=\${GIT_COMMITTER_DATE%% *}
  COMMITTER_EPOCH=\${COMMITTER_EPOCH#@}
  COMMITTER_OFFSET=\${GIT_COMMITTER_DATE##* }
  NEW_COMMITTER_EPOCH=$(( COMMITTER_EPOCH + DIFF_SECS ))

  export GIT_AUTHOR_DATE="@$NEW_AUTHOR_EPOCH $AUTHOR_OFFSET"
  export GIT_COMMITTER_DATE="@$NEW_COMMITTER_EPOCH $COMMITTER_OFFSET"
fi
`

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
    const backupRef = `refs/original/shift-commits-${timestamp}`

    try {
      const cmd = [
        'git filter-branch',
        `--original "${backupRef}"`,
        `--env-filter '${envFilter.replace(/'/g, "'\\''")}'`,
        '--',
        `${parentCommit}..HEAD`,
      ].join(' ')

      console.log(`Backup ref: ${colors.dim(backupRef)}`)
      console.log('Running filter-branch...')

      const output = execSync(cmd, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
      })
      if (output.trim()) console.log(output)

      console.log(colors.green('\nDone! Commits rewritten successfully.'))
      console.log(`Backup stored at: ${colors.dim(backupRef)}`)
      console.log(
        `\nVerify: ${colors.bold('git log --format="%h %ai %s" | head -20')}`,
      )
      console.log(
        `Force push: ${colors.bold('git push --force')}`,
      )
    } catch (err: any) {
      console.error(colors.red('filter-branch failed:'))
      console.error(err.stderr || err.message)
      process.exit(1)
    }
  })

cli.help()
cli.parse()
