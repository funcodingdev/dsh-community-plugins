/**
 * Optional allowRestart settings, owned by the same scope as the HTTP routes.
 * Use the injected service directly: settings helper exports differ between
 * supported Harness versions. Profile selection and release channels are
 * owned by the loader and pluginhub state, respectively.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { restartAllowed } from './restart.ts'

const PLUGINHUB_SETTINGS_NS = 'dsh-pluginhub'

/**
 * The slice of the host's `settings` service this module uses.
 *
 * Declared structurally rather than imported: the package no longer exports
 * a type for it on every supported host, and naming only what is called
 * keeps this from breaking again when a neighbouring field moves.
 */
interface SettingsScope {
  get: () => PluginHubSettings
  watch: (listener: () => void) => void
}
interface SettingsService {
  register: (
    ns: string,
    schema: z<PluginHubSettings>,
    options: { base: PluginHubSettings },
  ) => SettingsScope
}

/** The pluginhub settings a user may edit at runtime. */
export interface PluginHubSettings {
  allowRestart: boolean
}

export const PluginHubSettings: z<PluginHubSettings> = z.object({
  allowRestart: z.boolean().default(true),
})

/** Keep route configuration in sync with the optional settings service. */
export function installPluginHubSettings(ctx: Context, resolved: { allowRestart?: boolean }): void {
  const entry = { allowRestart: restartAllowed(resolved) }
  ctx.inject(['settings'], (scopedCtx: Context) => {
    const scoped = scopedCtx as unknown as Context & { settings: SettingsService }
    const scope = scoped.settings.register(PLUGINHUB_SETTINGS_NS, PluginHubSettings, { base: entry })
    const apply = (): void => { resolved.allowRestart = scope.get().allowRestart }
    scoped.effect(() => () => { resolved.allowRestart = entry.allowRestart })
    apply()
    scope.watch(apply)
  })
}
