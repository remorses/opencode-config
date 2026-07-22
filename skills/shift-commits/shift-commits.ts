#!/usr/bin/env bun
/**
 * Rewrites git commit timestamps so weekday commits appear after working hours.
 *
 * Strategy: group commits by day. Find the earliest commit each weekday. If it's
 * before the target hour, compute a single delta for that day (target - earliest).
 * Apply the same delta to ALL commits on that day. This preserves relative ordering.
 *
 * Usage:
 *   bun ~/.config/opencode/skills/shift-commits/shift-commits.ts --after 2026-07-06
 *   bun ~/.config/opencode/skills/shift-commits/shift-commits.ts --after 2026-07-06 --run
 *
 * GIT_AUTHOR_DATE format inside filter-branch: @<epoch> <offset>  e.g. @1783354530 -0700
 */

import { execSync } from 'node:child_process'
import { goke } from 'goke'
import { z } from 'zod'

// Minimal terminal colors
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
  .command('', 'Shift weekday commits to after working hours')
  .option(
    '--after <date>',
    z
      .string()
      .describe(
        'Start date (YYYY-MM-DD). Only commits on or after this date are shifted',
      ),
  )
  .option('--target-hour [hour]', 'Hour to shift the earliest commit to (default: 17)')
  .option('--day-boundary [hour]', 'Commits before this hour count as previous day (default: 6)')
  .option('--run', 'Actually rewrite commits (default is dry-run)')
  .action((options) => {
    const afterDate = options.after as string
    const targetHour = options.targetHour ? Number(options.targetHour) : 17
    const dayBoundary = options.dayBoundary ? Number(options.dayBoundary) : 6
    const isDryRun = !options.run

    const dateMatch = afterDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!dateMatch) {
      console.error(colors.red('--after must be YYYY-MM-DD format'))
      process.exit(1)
    }
    const rangeStartDate = parseInt(dateMatch[1] + dateMatch[2] + dateMatch[3], 10)

    function run(cmd: string): string {
      return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim()
    }

    // Verify git repo
    try {
      run('git rev-parse --is-inside-work-tree')
    } catch {
      console.error(colors.red('Not inside a git repository'))
      process.exit(1)
    }

    // Query commits (grab 2 days before to be safe with git's date filtering)
    const dayBefore = new Date(afterDate)
    dayBefore.setDate(dayBefore.getDate() - 2)
    const queryDate = dayBefore.toISOString().split('T')[0]

    const rawLines = run(`git log --after="${queryDate}" --format="%H %ai"`)
      .split('\n')
      .filter(Boolean)

    if (rawLines.length === 0) {
      console.log('No commits found in range')
      process.exit(0)
    }

    // Parse commits
    // effectiveDate: commits before dayBoundary (e.g. 6 AM) are grouped with
    // the previous calendar day. A 00:56 commit is a late-night session, not an
    // early morning one, so its delta should come from yesterday's group.
    interface Commit {
      hash: string
      date: string // YYYY-MM-DD (calendar date from git)
      effectiveDate: string // YYYY-MM-DD (shifted back 1 day if hour < dayBoundary)
      time: string // HH:MM:SS
      offset: string // e.g. -0700
      hour: number
      dayOfWeek: number // 1=Mon, 7=Sun (from effectiveDate)
    }

    function prevDay(dateStr: string): string {
      const d = new Date(dateStr + 'T12:00:00Z')
      d.setUTCDate(d.getUTCDate() - 1)
      return d.toISOString().split('T')[0]
    }

    const commits: Commit[] = []
    for (const line of rawLines) {
      const [hash, date, time, offset] = line.split(' ')
      const dateNum = parseInt(date.replace(/-/g, ''), 10)
      if (dateNum < rangeStartDate) continue

      const hour = parseInt(time.split(':')[0], 10)
      const effectiveDate = hour < dayBoundary ? prevDay(date) : date
      const effIso = `${effectiveDate}T12:00:00Z`
      const dow = new Date(effIso).getUTCDay()

      commits.push({
        hash,
        date,
        effectiveDate,
        time,
        offset,
        hour,
        dayOfWeek: dow === 0 ? 7 : dow, // 1=Mon, 7=Sun
      })
    }

    if (commits.length === 0) {
      console.log(`No commits found on or after ${afterDate}`)
      process.exit(0)
    }

    // Group by effectiveDate, find earliest hour per weekday, compute per-day delta.
    // Commits before dayBoundary are grouped with the previous day, so a 00:56
    // commit doesn't inflate the delta for that calendar day's daytime commits.
    // The delta map is keyed by effectiveDate (for grouping/display) but the
    // filter-branch case statement maps each commit's CALENDAR date+hour to the
    // right delta via per-commit lookup (see caseEntries below).
    const dayDeltas = new Map<string, number>() // effectiveDate -> delta in hours

    // Group commits by effectiveDate
    const byDate = new Map<string, Commit[]>()
    for (const c of commits) {
      const group = byDate.get(c.effectiveDate) ?? []
      group.push(c)
      byDate.set(c.effectiveDate, group)
    }

    for (const [effDate, dayCommits] of byDate) {
      const first = dayCommits[0]
      const isWeekday = first.dayOfWeek >= 1 && first.dayOfWeek <= 5

      if (!isWeekday) {
        dayDeltas.set(effDate, 0)
        continue
      }

      // Find earliest hour on this day (excluding pre-boundary commits which
      // logically belong here but have very low hours like 0-5)
      const earliestHour = Math.min(...dayCommits.map((c) => c.hour))

      if (earliestHour >= targetHour) {
        dayDeltas.set(effDate, 0)
      } else {
        dayDeltas.set(effDate, targetHour - earliestHour)
      }
    }

    // Find parent commit
    const oldestCommit = commits[commits.length - 1].hash
    let parentCommit: string
    try {
      parentCommit = run(`git rev-parse ${oldestCommit}^`)
    } catch {
      console.error(colors.red(`Cannot find parent of ${oldestCommit.slice(0, 8)}. Initial commit?`))
      process.exit(1)
    }

    console.log(`Found ${colors.bold(String(commits.length))} commits in range`)
    console.log(`Parent (rewrite base): ${colors.dim(parentCommit.slice(0, 8))}`)
    console.log()

    // Print per-day summary
    const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    let shiftCount = 0
    let skipCount = 0

    for (const c of commits) {
      const delta = dayDeltas.get(c.effectiveDate)!
      const effLabel = c.effectiveDate !== c.date ? ` ${colors.dim(`(grouped with ${c.effectiveDate})`)}` : ''
      if (delta > 0) {
        const [hh, mins, secs] = c.time.split(':')
        const newHour = parseInt(hh, 10) + delta
        const newTime = `${String(newHour).padStart(2, '0')}:${mins}:${secs}`
        console.log(
          `${colors.green('SHIFT')} ${c.hash.slice(0, 8)} ${dayNames[c.dayOfWeek]} ${c.date} ${c.time} ${colors.dim('->')} ${colors.green(newTime)} ${c.offset}  ${colors.dim(`(+${delta}h)`)}${effLabel}`,
        )
        shiftCount++
      } else {
        const reason = c.dayOfWeek > 5 ? `weekend` : `already >=${targetHour}:00`
        console.log(
          `${colors.dim('SKIP')}  ${c.hash.slice(0, 8)} ${dayNames[c.dayOfWeek]} ${c.date} ${c.time} ${colors.dim(`(${reason})`)}${effLabel}`,
        )
        skipCount++
      }
    }

    console.log(`\nSummary: ${colors.green(String(shiftCount))} to shift, ${colors.dim(String(skipCount))} to skip`)

    // Print per-day deltas
    console.log()
    for (const [date, delta] of [...dayDeltas].sort()) {
      if (delta > 0) {
        console.log(`  ${date}: ${colors.green(`+${delta}h`)} (all commits shifted)`)
      }
    }

    if (isDryRun) {
      console.log(`\n${colors.yellow('Dry-run mode.')} Pass ${colors.bold('--run')} to rewrite commits.`)
      process.exit(0)
    }

    console.log('\nRewriting commits with git filter-branch...')

    // Build a lookup table of effectiveDate -> delta for the env-filter.
    // The shell script computes effectiveDate the same way we do in JS:
    // if local hour < dayBoundary, subtract 1 day. Then look up the delta.
    let caseEntries = ''
    for (const [effDate, delta] of dayDeltas) {
      if (delta > 0) {
        const dateNum = effDate.replace(/-/g, '')
        caseEntries += `  ${dateNum}) DELTA_HOURS=${delta} ;;\n`
      }
    }

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
LOCAL_HOUR=$(TZ=UTC date -r "$LOCAL_EPOCH" "+%H")
LOCAL_HOUR_NUM=$((10#$LOCAL_HOUR))

# Commits before dayBoundary belong to the previous day's group
EFF_EPOCH=$LOCAL_EPOCH
if [ "$LOCAL_HOUR_NUM" -lt ${dayBoundary} ]; then
  EFF_EPOCH=$(( LOCAL_EPOCH - 86400 ))
fi
EFF_DATE=$(TZ=UTC date -r "$EFF_EPOCH" "+%Y%m%d")

DELTA_HOURS=0
case "$EFF_DATE" in
${caseEntries}  *) DELTA_HOURS=0 ;;
esac

if [ "$DELTA_HOURS" -gt 0 ]; then
  DIFF_SECS=$(( DELTA_HOURS * 3600 ))

  NEW_AUTHOR_EPOCH=$(( AUTHOR_EPOCH + DIFF_SECS ))

  COMMITTER_EPOCH=\${GIT_COMMITTER_DATE%% *}
  COMMITTER_EPOCH=\${COMMITTER_EPOCH#@}
  COMMITTER_OFFSET=\${GIT_COMMITTER_DATE##* }
  NEW_COMMITTER_EPOCH=$(( COMMITTER_EPOCH + DIFF_SECS ))

  export GIT_AUTHOR_DATE="@$NEW_AUTHOR_EPOCH $AUTHOR_OFFSET"
  export GIT_COMMITTER_DATE="@$NEW_COMMITTER_EPOCH $COMMITTER_OFFSET"
fi
`

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
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
      console.log(`\nVerify: ${colors.bold('git log --format="%h %ai %s" | head -20')}`)
      console.log(`Force push: ${colors.bold('git push --force')}`)
    } catch (err: any) {
      console.error(colors.red('filter-branch failed:'))
      console.error(err.stderr || err.message)
      process.exit(1)
    }
  })

cli.help()
cli.parse()
