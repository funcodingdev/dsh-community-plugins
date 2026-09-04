/**
 * dsh-pluginhub client: registers the PluginHub settings section and the
 * post-install toast in the shell overlay layer.
 * Built by tsdown into the __ModuleLoader__ factory bundle at
 * client/client.js; React and UI primitives resolve through the host module table.
 */
import { createElement as h, Fragment } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { en, zh } from './locales.ts'
import { InstallToast } from './InstallToast.tsx'
import { PluginHubSection, resetPluginHubCache } from './PluginHubSection.tsx'
import { PluginHubNavIcon } from './PluginHubNavIcon.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { PLUGINHUB_PACKAGE_NAME } from '../package-name.ts'

const NS = 'dsh-pluginhub'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-pluginhub': string
  }
  // ui-layout owns this slot at runtime; only its public slot declaration is needed here.
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

/**
 * Primitives this bundle relies on that did not exist before rc.6. The
 * primitives module is host-injected (external at build time), so on an
 * older host the module resolves but these named exports are undefined —
 * rendering would throw and blank the whole settings dialog. Returning the
 * gaps lets apply() skip registration for a clean downgrade instead.
 */
export const REQUIRED_PRIMITIVES = ['Menu', 'DisclosureRow', 'Tooltip', 'Toast'] as const

export function missingPrimitives(mod: Record<string, unknown>, required: readonly string[] = REQUIRED_PRIMITIVES): string[] {
  return required.filter(name => mod[name] === undefined)
}

export const name = PLUGINHUB_PACKAGE_NAME
export const inject = ['slots', 'locale']
export function apply(ctx: ClientContext): void {
  // Older hosts resolve the primitives module but lack the rc.6 exports the
  // pluginhub renders with. Skip registration (pluginhub simply absent from the
  // settings list) rather than throwing mid-render and blanking the dialog.
  const gaps = missingPrimitives(primitives as unknown as Record<string, unknown>)
  if (gaps.length > 0) {
    console.warn('[dsh-pluginhub] host ui-primitives missing ' + gaps.join(', ') + ' — pluginhub section disabled (dsh web >= 0.1.0-rc.6 required)')
    return
  }

  ctx.effect(() => {
    resetPluginHubCache()
    return resetPluginHubCache
  }, 'dsh-pluginhub: client cache')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pluginhub: dictionaries')
  const t = ctx.locale.bind(NS)

  // Self-removal retires the navigation entry before the host reloads.
  let retireSection: (() => void) | null = null

  ctx.slots.inject('settings.section', () => {
    const off = ctx.slots.register({
      name: 'settings.section',
      id: 'pluginhub',
      order: 40,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ t }),
    }, (ownerProps: { preferredSubsectionId?: string } = {}) => h(PluginHubSection, {
      t,
      locale: ctx.locale,
      preferredSubsectionId: ownerProps.preferredSubsectionId,
    }))
    retireSection = off
    return off
  })

  // The optional card must not prevent the pluginhub page mounting on older hosts.
  ctx.inject(['settingsScope'], (scoped) => {
    // rc.7 dispatches cards by namespace key; newer hosts use list ids.
    const cardOptions = {
      name: 'settings.plugin.item',
      key: NS,
      id: NS,
      locale: NS,
      inject: () => ({ t }),
    } as const
    scoped.slots.inject('settings.plugin.item', () => scoped.slots.register(cardOptions,
      () => h(SettingsCard, { t, onRemoved: () => { const off = retireSection; retireSection = null; off?.() } })))
  })

  const Overlay = () => h(Fragment, null,
    h(InstallToast, { t }),
    h(PluginHubNavIcon),
  )
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-pluginhub-overlay',
    label: () => 'dsh-pluginhub',
  }, Overlay))
}
