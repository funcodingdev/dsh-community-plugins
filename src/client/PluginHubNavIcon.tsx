import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconSkillOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { en, zh } from './locales.ts'
import css from './PluginHubNavIcon.module.css'

const NAV_MARKER = 'data-dsh-pluginhub-nav'
const NAV_LABELS = new Set([zh.nav, en.nav])

function canContainSettingsNav(node: Node): boolean {
  if (!(node instanceof Element)) return false
  return node.matches('[role="dialog"], [role="dialog"] nav, [role="dialog"] nav *')
    || node.querySelector('[role="dialog"] nav button') !== null
}

/**
 * Stock DSH does not expose an icon field on third-party settings sections.
 * Locate this section by its registered, localized label so the overlay can
 * replace only its generic host icon without patching the DSH installation.
 */
export function findPluginHubNavButton(root: ParentNode = document): HTMLButtonElement | null {
  const buttons = root.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')
  for (const button of buttons) {
    if (NAV_LABELS.has(button.textContent?.trim() ?? '')) return button
  }
  return null
}

/** Official DSH capability glyph with the host navigation's sizing and color. */
export function PluginHubNavIcon() {
  const [target, setTarget] = useState<HTMLButtonElement | null>(null)

  useEffect(() => {
    let current: HTMLButtonElement | null = null

    const sync = () => {
      const next = findPluginHubNavButton()
      if (next === current) return
      current?.removeAttribute(NAV_MARKER)
      current = next
      current?.setAttribute(NAV_MARKER, '')
      setTarget(current)
    }

    sync()
    const observer = new MutationObserver((records) => {
      if (current !== null && !current.isConnected) {
        sync()
        return
      }
      if (records.some(record => [...record.addedNodes].some(canContainSettingsNav))) sync()
    })
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      current?.removeAttribute(NAV_MARKER)
    }
  }, [])

  if (target === null) return null
  return createPortal(
    <span className={css.icon} data-dsh-pluginhub-nav-icon aria-hidden="true">
      <IconSkillOutline16 size={16} />
    </span>,
    target,
  )
}
