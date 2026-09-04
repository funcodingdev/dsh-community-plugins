import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as pluginhub from '../src/index.ts'

const mounts = vi.hoisted(() => new Set<unknown>())
vi.mock('../src/routes.ts', () => ({
  mountPluginHubRoutes: (host: unknown) => {
    mounts.add(host)
    return () => { mounts.delete(host) }
  },
}))

const roots: Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
  mounts.clear()
})

describe('host injection lifecycle', () => {
  it('removes settings with the web service and registers once after it returns', async () => {
    const root = new Context()
    roots.push(root)
    const registrations = new Set<string>()
    class Settings extends Service {
      constructor(ctx: Context) { super(ctx, 'settings') }
      register(namespace: string, _schema: unknown, options: { base: { allowRestart: boolean } }) {
        this.ctx.effect(() => {
          if (registrations.has(namespace)) throw new Error('duplicate settings namespace')
          registrations.add(namespace)
          return () => { registrations.delete(namespace) }
        })
        return { get: () => options.base, watch: () => {} }
      }
    }
    await root.plugin(Settings).await()
    const services = { apply: (ctx: Context) => {
      ctx.provide('webServer', {})
      ctx.provide('loader', {})
    } }
    let provider = root.plugin(services)
    await provider.await()
    const plugin = root.plugin(pluginhub, { profile: 'web' })
    await plugin.await()
    expect(mounts.size).toBe(1)
    expect(registrations.size).toBe(1)

    await provider.dispose()
    await vi.waitFor(() => {
      expect(mounts.size).toBe(0)
      expect(registrations.size).toBe(0)
    })

    provider = root.plugin(services)
    await provider.await()
    await vi.waitFor(() => {
      expect(mounts.size).toBe(1)
      expect(registrations.size).toBe(1)
    })
    await plugin.dispose()
    expect(mounts.size).toBe(0)
    expect(registrations.size).toBe(0)
  })
})
