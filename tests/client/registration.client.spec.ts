// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import * as slotModule from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it } from 'vitest'
import * as pluginhub from '../../src/client/index.ts'

// Published Client entries use the official closure-factory format, not ESM.
function runtimeModule(): { SlotRegistry: typeof SlotRegistry } {
  let result: { SlotRegistry: typeof SlotRegistry } | undefined
  runInNewContext(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-client-runtime/client')), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }: {
      factory: (require: (name: string) => unknown) => { SlotRegistry: typeof SlotRegistry }
    }) => {
      result = factory(name => {
        if (name === '@deepseek-ai/cordis') return cordis
        if (name === '@deepseek-ai/dsh-client-ui-slots') return slotModule
        throw new Error(`unexpected Client external: ${name}`)
      })
    } } },
    queueMicrotask,
    setTimeout,
    clearTimeout,
  })
  if (result === undefined) throw new Error('runtime bundle did not register')
  return result
}

const Runtime = runtimeModule()
const roots: cordis.Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
})

describe('official Client slot registration', () => {
  it.each(['keyed', 'list'] as const)('registers and disposes settings cards in a %s slot', async kind => {
    const ctx = new cordis.Context()
    roots.push(ctx)
    await ctx.plugin(Runtime.SlotRegistry).await()
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'en' }),
    })
    ctx.provide('settingsScope', {})
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.plugin.item': { kind, scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)

    for (let attempt = 0; attempt < 2; attempt++) {
      const fiber = ctx.plugin(pluginhub)
      await fiber.await()
      expect(slots.entries('settings.section')).toHaveLength(1)
      expect(slots.entries('settings.section')[0].options).toMatchObject({ id: 'pluginhub' })
      expect(slots.entries('shell.overlay')).toHaveLength(1)
      const cards = slots.entries('settings.plugin.item')
      expect(cards).toHaveLength(1)
      expect(cards[0].options).toMatchObject({ [kind === 'keyed' ? 'key' : 'id']: 'dsh-pluginhub' })
      await fiber.dispose()
      expect(slots.entries('settings.section')).toHaveLength(0)
      expect(slots.entries('settings.plugin.item')).toHaveLength(0)
      expect(slots.entries('shell.overlay')).toHaveLength(0)
    }
  })
})
