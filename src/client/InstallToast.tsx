/**
 * Post-reload confirmation via the official Toast primitive: shown once after
 * the refresh that follows a hot install, so the user lands
 * back in their flow with visible proof.
 */
import { useState } from 'react'
import { IconSparkle16, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { readSession } from './pluginhub-data.ts'
import type { Translate } from './pluginhub-data.ts'

export function InstallToast(props: { t: Translate }) {
  const t = props.t
  const [names, setNames] = useState<string[]>(() => {
    const value = readSession('dsph-toast')
    sessionStorage.removeItem('dsph-toast')
    return Array.isArray(value) ? value : []
  })
  if (names.length === 0) return null
  return (
    <Toast
      text={names.join(', ') + ' ' + t('toastReady')}
      icon={<IconSparkle16 size={14} />}
      onDone={() => setNames([])}
    />
  )
}
