import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button, IconChevronDownOutline14, IconChevronUpOutline14, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './pluginhub-data.ts'
import css from './PluginHub.module.css'

interface CategoryItem {
  id: string
  label: string
}

const COLLAPSED_ROWS = 2

/** Measure the complete list so collapsing never changes its wrapping calculation. */
export function CategoryList({ items, value, onChange, t }: {
  items: CategoryItem[]
  value: string
  onChange: (id: string) => void
  t: Translate
}) {
  const id = useId()
  const measurementRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [collapsedCount, setCollapsedCount] = useState(items.length)
  // Labels include counts and locale; only reconnect the observer when those change.
  const labelsKey = JSON.stringify(items.map(item => item.label))

  useLayoutEffect(() => {
    const element = measurementRef.current
    if (element === null) return
    const measure = () => {
      const chips = [...element.children].slice(0, -1)
      const style = getComputedStyle(element)
      const width = element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      if (width <= 0) { setCollapsedCount(chips.length); return }
      const gap = parseFloat(style.columnGap) || 0
      const toggleWidth = element.lastElementChild!.getBoundingClientRect().width
      let row = 1
      let used = 0
      let visible = 0
      for (const [index, chip] of chips.entries()) {
        const chipWidth = chip.getBoundingClientRect().width
        if (used > 0 && used + gap + chipWidth > width) {
          row++
          used = chipWidth
        } else {
          used += (used > 0 ? gap : 0) + chipWidth
        }
        // Leave room for the arrow at the end of the final collapsed row.
        const rowWithToggle = row + (used + gap + toggleWidth > width ? 1 : 0)
        if (rowWithToggle <= COLLAPSED_ROWS) visible = index + 1
      }
      setCollapsedCount(row <= COLLAPSED_ROWS ? chips.length : visible)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    let disposed = false
    void element.ownerDocument.fonts?.ready.then(() => { if (!disposed) measure() })
    return () => { disposed = true; observer?.disconnect() }
  }, [labelsKey])

  const canCollapse = collapsedCount < items.length
  const shown = expanded ? items : items.slice(0, collapsedCount)
  const toggleLabel = expanded ? t('categoriesCollapse') : t('categoriesExpand')
  return (
    <div className={css.categoryList}>
      <div className={css.catsMeasure} ref={measurementRef} aria-hidden="true">
        {items.map(item => <Pill key={item.id}>{item.label}</Pill>)}
        <span className={css.catsToggleMeasure} />
      </div>
      <div id={id} className={css.catsWrap}>
        {shown.map(item => (
          <Pill key={item.id} data-chip="1" active={value === item.id} aria-pressed={value === item.id} onClick={() => onChange(item.id)}>
            {item.label}
          </Pill>
        ))}
        {canCollapse && (
          <Button variant="ghost" size="sm" className={css.catsToggle}
            aria-expanded={expanded} aria-controls={id} aria-label={toggleLabel} title={toggleLabel}
            onClick={() => setExpanded(current => !current)}>
            {expanded ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
          </Button>
        )}
      </div>
    </div>
  )
}
