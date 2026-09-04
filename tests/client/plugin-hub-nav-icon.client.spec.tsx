// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { findPluginHubNavButton, PluginHubNavIcon } from '../../src/client/PluginHubNavIcon.tsx'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function mountSettingsNav(label = '社区插件') {
  const panel = document.createElement('div')
  panel.setAttribute('role', 'dialog')
  panel.innerHTML = `<nav><button><svg data-host-gear></svg><span>${label}</span></button></nav>`
  document.body.appendChild(panel)
  return panel.querySelector('button') as HTMLButtonElement
}

describe('PluginHubNavIcon', () => {
  it('finds the localized Community Plugins row inside the settings dialog', () => {
    const button = mountSettingsNav('Community Plugins')
    expect(findPluginHubNavButton()).toBe(button)
  })

  it('mounts the vector icon beside the label and marks only that nav row', async () => {
    const button = mountSettingsNav()
    render(<PluginHubNavIcon />)

    await waitFor(() => {
      expect(button.hasAttribute('data-dsh-pluginhub-nav')).toBe(true)
      expect(button.querySelector('[data-dsh-pluginhub-nav-icon] svg')).not.toBeNull()
    })
    const icon = button.querySelector('[data-dsh-pluginhub-nav-icon] svg')
    expect(icon?.getAttribute('width')).toBe('16')
    expect(icon?.getAttribute('height')).toBe('16')
    expect(icon?.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(icon?.getAttribute('fill')).toBe('none')
    expect(icon?.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
    expect(button.querySelector('[data-host-gear]')).not.toBeNull()
  })

  it('follows a settings dialog opened after the plugin overlay mounts', async () => {
    render(<PluginHubNavIcon />)
    const button = mountSettingsNav()

    await waitFor(() => expect(button.hasAttribute('data-dsh-pluginhub-nav')).toBe(true))
  })

  it('removes its host marker when unmounted', async () => {
    const button = mountSettingsNav()
    const view = render(<PluginHubNavIcon />)
    await waitFor(() => expect(button.hasAttribute('data-dsh-pluginhub-nav')).toBe(true))

    view.unmount()
    expect(button.hasAttribute('data-dsh-pluginhub-nav')).toBe(false)
  })
})
