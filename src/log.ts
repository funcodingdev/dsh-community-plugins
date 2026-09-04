/**
 * Bounded operational event log: what the pluginhub did and how it failed.
 *
 * Privacy: entries are sanitized on write — the home directory collapses to
 * `~`, and common credential shapes (API keys, GitHub/npm tokens, bearer
 * headers) are masked. A process that configures a persistent sink appends
 * every event there, capped at {@link PERSISTENT_MAX_BYTES}.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

export type LogLevel = 'info' | 'warn' | 'error'

const DETAIL_MAX = 600
const PERSISTENT_MAX_BYTES = 256 * 1024

let persistentFile: string | null = null
/** Bytes in the sink file, tracked so the cap holds without a stat per event. */
let persistentBytes = 0

function sanitize(text: string): string {
  return text
    .replaceAll(homedir(), '~')
    // Log-injection guard: control characters (newlines above all) would
    // forge extra lines in the persisted log file, so strip them at the
    // single choke point.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
    .replace(/npm_[A-Za-z0-9]{16,}/g, 'npm_***')
    .replace(/bearer\s+\S+/gi, 'Bearer ***')
    .replace(/(authorization|token|apikey|api-key|password)(["':=\s]+)\S+/gi, '$1$2***')
}

/**
 * Append one event, sanitized and truncated.
 * @param level - event severity.
 * @param event - short machine-ish event name (e.g. `install`, `hot-mount`).
 * @param detail - free-form context; credentials and home paths are masked.
 */
export function logEvent(level: LogLevel, event: string, detail: string): void {
  const entry = {
    at: new Date().toISOString(),
    level,
    event,
    detail: sanitize(detail).slice(0, DETAIL_MAX),
  }
  if (persistentFile === null) return
  try {
    const line = `${JSON.stringify(entry)}\n`
    appendFileSync(persistentFile, line)
    persistentBytes += line.length
    // Trimming only on mount left the cap unenforced for the life of a
    // process: 20k events grew the file to 3.2 MB in a measurement, and a
    // retry loop is exactly the situation that both logs hardest and never
    // restarts. Re-trim in place once the ceiling is crossed.
    if (persistentBytes > PERSISTENT_MAX_BYTES) trimPersistentLog(persistentFile)
  } catch {
    // Only append failures reach this: a read-only or full disk. Disable the
    // sink so one bad write cannot break every future event.
    persistentFile = null
  }
}

/**
 * Rewrite the sink keeping only its newest half, and resync the byte count.
 * @param file - the sink file to trim in place.
 */
function trimPersistentLog(file: string): void {
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line !== '')
  const kept: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0 && bytes <= PERSISTENT_MAX_BYTES / 2; index -= 1) {
    kept.unshift(`${lines[index]!}\n`)
    bytes += lines[index]!.length + 1
  }
  writeFileSync(file, kept.join(''))
  persistentBytes = bytes
}

/**
 * Append events to a profile-owned file, or stop doing so.
 *
 * Called once per mount with `<profile>/.dsh-pluginhub/log.ndjson` and with
 * `null` on dispose. An oversized file is trimmed to its newest half on
 * configure, so one long-lived profile cannot grow it without bound.
 * @param file - the sink file, or null to disable persistence.
 */
export function configurePersistentLog(file: string | null): void {
  persistentFile = file
  if (file === null) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    persistentBytes = existsSync(file) ? statSync(file).size : 0
    if (persistentBytes <= PERSISTENT_MAX_BYTES) return
    trimPersistentLog(file)
  } catch {
    // Only configure-time filesystem failures reach this (the directory
    // cannot be created, the file cannot be read or rewritten). The pluginhub
    // must mount regardless; persistent logging is simply disabled.
    persistentFile = null
  }
}
