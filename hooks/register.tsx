import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Window } from '../types'

const windows = atom({ plugin: 'usage-bar', key: 'windows' } as const, [] as Window[])

const STORE_KEY = 'lastWindows'
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'Spend' }
const BAR_CELLS = 28

const label = (w: Window) => LABELS[w.kind] ?? w.kind
const TITLES: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }
const title = (w: Window) => TITLES[w.kind] ?? w.kind
const formatPct = (n: number) => `${n < 10 && n % 1 !== 0 ? n.toFixed(1) : Math.round(n)}%`

// How far through the window we are, 0–100, when its length is known.
function elapsedPct(w: Window, now: number): number | null {
  const len = WINDOW_MS[w.kind]
  if (!len || !w.resetsAt) return null
  const left = Date.parse(w.resetsAt) - now
  if (!Number.isFinite(left)) return null
  return Math.max(0, Math.min(100, 100 - (left / len) * 100))
}

// Compares usage with time elapsed: ahead of pace means the limit will be hit before reset.
function paceNote(used: number, elapsed: number | null): { text: string; color: string } | null {
  if (elapsed === null) return null
  const diff = used - elapsed
  if (used >= 100) return { text: 'limit reached', color: 'error' }
  if (diff > 15) return { text: 'ahead of pace', color: 'warning' }
  if (diff < -15) return { text: 'plenty left', color: 'success' }
  return { text: 'on pace', color: 'subtle' }
}
const colorFor = (pct: number) => (pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'claude')

function resetIn(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return 'resetting'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `resets in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `resets in ${hours}h ${mins % 60}m`
  return `resets in ${Math.round(hours / 24)}d`
}

// Account limits are shared by every chat, so keep the last reading across sessions too.
async function save($: EngineInterface, ws: Window[]) {
  if (ws.length === 0) return
  const clean = ws.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
  await update($, windows, () => clean)
  await $.store.set(STORE_KEY, clean)
  $.ui.status(clean.map(w => `${label(w)} ${Math.round(w.percentUsed)}%`).join(' · '))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const stored = (await $.store.get(STORE_KEY)) as Window[] | undefined
    if (Array.isArray(stored) && stored.length > 0) await save($, stored)
    const usage = await $.session.usage()
    await save($, usage.rateLimits)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await save($, e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ws = await read($, windows)
    if (e.props.hasSurvey || ws.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    return (
      <Box
        flexDirection="row"
        flexWrap="wrap"
        columnGap={4}
        rowGap={1}
        paddingX={2}
        paddingY={1}
        borderStyle="round"
        borderColor="promptBorder"
      >
        {ws.map(w => {
          const pct = Math.max(0, Math.min(100, w.percentUsed))
          const filled = Math.round((pct / 100) * BAR_CELLS)
          const color = colorFor(w.percentUsed)
          const elapsed = elapsedPct(w, now)
          const marker = elapsed === null ? null : Math.min(BAR_CELLS - 1, Math.floor((elapsed / 100) * BAR_CELLS))
          const pace = paceNote(w.percentUsed, elapsed)
          return (
            <Box key={w.kind} flexDirection="column" gap={0} flexGrow={1} minWidth={BAR_CELLS + 2}>
              <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" gap={2}>
                <Text weight="semibold" size="footnote">
                  {title(w)}
                </Text>
                <Text color={color} bold weight="bold" tabular>
                  {formatPct(w.percentUsed)}
                </Text>
              </Box>
              <Box position="relative" flexDirection="row" width={BAR_CELLS} height={1} overflow="hidden">
                <Box width={filled} height={1} backgroundColor={color} />
                <Box flexGrow={1} height={1} backgroundColor="subtle" />
                {marker === null ? null : (
                  <Box position="absolute" left={marker} top={0} width={1} height={1} backgroundColor="text" />
                )}
              </Box>
              <Box flexDirection="row" justifyContent="space-between" gap={2}>
                <Text dimColor size="caption">
                  {resetIn(w.resetsAt, now)}
                </Text>
                {pace ? (
                  <Text color={pace.color} size="caption">
                    {pace.text}
                  </Text>
                ) : null}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
