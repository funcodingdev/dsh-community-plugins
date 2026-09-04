/**
 * dsh-pluginhub host entry: mounts the pluginhub's HTTP routes once the profile
 * composes the webServer and loader services.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createDesktopPluginRuntime, type DesktopPnpmLike } from './dsh-cli.ts'
import { mountPluginHubRoutes, type PluginHubConfig, type PluginHubHost } from './routes.ts'
import { installPluginHubSettings } from './settings.ts'
import type { AgentsServiceLike } from './agents.ts'
import { PLUGINHUB_PACKAGE_NAME } from './package-name.ts'

export const name = PLUGINHUB_PACKAGE_NAME

/** Optional cordis.yml configuration; profile defaults to `web`. */
export type Config = Partial<Pick<PluginHubConfig, 'profile' | 'allowRestart'>>

/** Structural subset of DSH Desktop's public `desktopProfiles` contract. */
interface DesktopProfilesLike {
  readonly current: {
    readonly name: string
    readonly dir: string
  }
}

/**
 * The profile this host process actually booted (`--profile <name>` on the
 * dsh CLI invocation). Without it the pluginhub would default to `web` and
 * installs from a test/secondary profile would mutate the real one.
 */
function argvProfile(): string | undefined {
  const argv = process.argv.slice(2)
  for (const [index, arg] of argv.entries()) {
    if (arg === '--') break
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length) || undefined
    if (arg === '--profile') {
      const value = argv[index + 1]
      return value !== undefined && !value.startsWith('-') ? value : undefined
    }
  }
  return undefined
}

/**
 * Resolve the host's `agents` inventory lazily — at request time, not at
 * pluginhub startup, so the guard sees whichever agents exist by the time an
 * update is asked for. Hosts without the service return undefined and the
 * update route stays open (see src/agents.ts).
 */
function agentsLookupOf(ctx: Context): () => AgentsServiceLike | undefined {
  return () => ctx.get('agents') as AgentsServiceLike | undefined
}

/** Register routes and settings under the scope that owns their required services. */
export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
    const host = hostCtx as unknown as PluginHubHost
    const desktopProfiles = hostCtx.get('desktopProfiles') as DesktopProfilesLike | undefined
    if (desktopProfiles === undefined) {
      const resolved: PluginHubConfig = {
        profile: config?.profile ?? argvProfile() ?? 'web',
        // Undefined lets restartAllowed() decide from supervisor detection.
        allowRestart: config?.allowRestart,
      }
      // Settings and routes must unload together when either required service reloads.
      installPluginHubSettings(hostCtx, resolved)
      hostCtx.effect(() => mountPluginHubRoutes(host, resolved, undefined, agentsLookupOf(hostCtx)), 'dsh-pluginhub: http routes')
      return
    }

    // Desktop's supported cross-environment contract guarantees that
    // desktopProfiles exists before Loader entries mount, and prescribes this
    // presence check plus a nested desktopPnpm injection:
    // https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md#L190-L243
    // Ordinary DSH keeps the existing CLI path above.
    hostCtx.inject(['desktopPnpm'], (desktopCtx: Context) => {
      const current = desktopProfiles.current
      const service = (desktopCtx as unknown as { desktopPnpm: DesktopPnpmLike }).desktopPnpm
      const runtime = createDesktopPluginRuntime(service, current.dir)
      const resolved: PluginHubConfig = {
        profile: current.name,
        profileDirectory: current.dir,
        // Relaunching a raw Electron process would bypass Desktop's launcher
        // lifecycle. The shell remains responsible for restart in this mode.
        allowRestart: false,
      }
      const desktopHost = desktopCtx as unknown as PluginHubHost
      desktopCtx.effect(() => {
        const disposeRoutes = mountPluginHubRoutes(desktopHost, resolved, runtime, agentsLookupOf(desktopCtx))
        return async () => {
          disposeRoutes()
          await runtime.dispose()
        }
      }, 'dsh-pluginhub: Desktop http routes and package operations')
    })
  })
}
