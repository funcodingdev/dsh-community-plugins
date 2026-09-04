import { logEvent } from './log.ts'

/** The slice of a cordis loader entry needed for live enable/disable. */
export interface LoaderEntry {
  options: { id?: string; name?: string; disabled?: boolean | null }
  fiber?: unknown
  update(options: { disabled: boolean | null }, create?: boolean, force?: boolean): Promise<void>
}

export interface LiveToggleHost {
  loader: { entries(): Iterable<LoaderEntry> }
}

/**
 * Live-toggle a bundle-layer plugin through its loader entry. Bundle trees
 * are in memory, so the caller persists the user's choice separately.
 *
 * @returns true when a matching live entry was found and updated.
 */
export async function setEntryDisabled(
  host: LiveToggleHost,
  name: string,
  disabledFlag: boolean,
): Promise<boolean> {
  let found = false
  for (const entry of host.loader.entries()) {
    if (entry.options.name !== name) continue
    // A disable can land while entry initialization is still in flight. Force
    // the update and retry until the fiber agrees with the requested state.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await entry.update({ disabled: disabledFlag ? true : null }, false, true)
        found = true
      } catch (error) {
        logEvent('warn', 'toggle', `${name}: entry update failed — ${error instanceof Error ? error.message : String(error)}`)
        break
      }
      const live = entry.fiber !== undefined
      if (live !== disabledFlag) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
    }
    logEvent('info', 'toggle',
      `${name} -> ${disabledFlag ? 'off' : 'on'}: fiber=${String(entry.fiber !== undefined)}`)
  }
  if (!found) logEvent('info', 'toggle', `${name}: no loader entry matched`)
  return found
}
