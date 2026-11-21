import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Meta, Window } from '../types'

const windows = atom({ plugin: 'usage-bar', key: 'windows' } as const, [] as Window[])
const meta = atom({ plugin: 'usage-bar', key: 'meta' } as const, {} as Meta)

const STORE_KEY = 'lastWindows'
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FILL = '━'
const TRACK = '─'
const MARK = '┃'
const SEP = '  │  '

const label = (w: Window) => LABELS[w.kind] ?? w.kind
const formatPct = (n: number) => `${n < 10 && n % 1 !== 0 ? n.toFixed(1) : Math.round(n)}%`
const colorFor = (pct: number) => (pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'claude')

// How far through the window we are, 0–100, when its length is known.
function elapsedPct(w: Window, now: number): number | null {
  const len = WINDOW_MS[w.kind]
  if (!len || !w.resetsAt) return null
  const left = Date.parse(w.resetsAt) - now
  if (!Number.isFinite(left)) return null
  return Math.max(0, Math.min(100, 100 - (left / len) * 100))
}

function duration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// Local clock time, with the weekday when it is not today.
function clockAt(ms: number, now: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes()
  const t = `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
  return new Date(now).toDateString() === d.toDateString() ? t : `${DAYS[d.getDay()]} ${t}`
}

// Usage against time elapsed; when ahead, when the limit would be hit at this rate.
function pace(w: Window, now: number): { text: string; color: string } | null {
  if (w.percentUsed >= 100) return { text: 'limit reached', color: 'error' }
  const elapsed = elapsedPct(w, now)
  const len = WINDOW_MS[w.kind]
  if (elapsed === null || !len || !w.resetsAt) return null
  const diff = w.percentUsed - elapsed
  if (diff > 10 && w.percentUsed > 0 && elapsed > 0) {
    const start = Date.parse(w.resetsAt) - len
    const rate = w.percentUsed / (now - start)
    const hitAt = now + (100 - w.percentUsed) / rate
    if (hitAt < Date.parse(w.resetsAt)) {
      return { text: `out ~${clockAt(hitAt, now)}`, color: diff > 25 ? 'error' : 'warning' }
    }
    return { text: 'ahead of pace', color: 'warning' }
  }
  if (diff < -15) return { text: 'plenty left', color: 'success' }
  return { text: 'on pace', color: 'subtle' }
}

function resetText(w: Window, now: number): string {
  if (!w.resetsAt) return ''
  const at = Date.parse(w.resetsAt)
  if (!Number.isFinite(at) || at <= now) return 'resetting'
  return `↻ ${duration(at - now)} · ${clockAt(at, now)}`
}

// Account limits are shared by every chat, so keep the last reading across sessions too.
async function save($: EngineInterface, ws: Window[]) {
  if (ws.length === 0) return
  const clean = ws.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
  await update($, windows, () => clean)
  await $.store.set(STORE_KEY, clean)
  $.ui.status(clean.map(w => `${label(w)} ${Math.round(w.percentUsed)}%`).join(' · '))
}

async function saveMeta($: EngineInterface, u: Pick<SessionUsage, 'context' | 'cost'>) {
  await update($, meta, () => ({ contextPct: u.context?.percent, usd: u.cost?.usd }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const stored = (await $.store.get(STORE_KEY)) as Window[] | undefined
    if (Array.isArray(stored) && stored.length > 0) await save($, stored)
    const usage = await $.session.usage()
    await save($, usage.rateLimits)
    await saveMeta($, usage)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await save($, e.rateLimits)
    if (e.changed.includes('context') || e.changed.includes('cost')) await saveMeta($, e)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ws = await read($, windows)
    if (e.props.hasSurvey || ws.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const m = await read($, meta)
    const cols = Math.max(40, e.props.bodyColumns || e.viewport?.columns || 100)

    const rows = ws.map(w => ({
      w,
      color: colorFor(w.percentUsed),
      head: `${label(w)} `,
      pct: ` ${formatPct(w.percentUsed)}`,
      reset: resetText(w, now),
      pace: pace(w, now),
      elapsed: elapsedPct(w, now),
    }))

    const extras: { text: string; color: string }[] = []
    if (typeof m.contextPct === 'number') {
      extras.push({ text: `ctx ${Math.round(m.contextPct)}%`, color: m.contextPct >= 80 ? 'warning' : 'subtle' })
    }
    if (typeof m.usd === 'number' && m.usd > 0) extras.push({ text: `$${m.usd.toFixed(2)}`, color: 'subtle' })
    const extrasText = extras.map(x => x.text).join('  ')

    // Whatever the text leaves goes to the bars, shared evenly.
    const textLen = rows.reduce(
      (n, r) => n + r.head.length + r.pct.length + (r.reset ? r.reset.length + 2 : 0) + (r.pace ? r.pace.text.length + 2 : 0),
      0,
    )
    const fixed = textLen + SEP.length * (rows.length - 1) + (extrasText ? SEP.length + extrasText.length : 0) + 2
    const barCells = Math.max(6, Math.min(40, Math.floor((cols - fixed) / rows.length)))

    return (
      <Box flexDirection="row" width={cols} paddingX={1} justifyContent="space-between" overflow="hidden">
        <Box flexDirection="row">
          {rows.map((r, i) => {
            const pct = Math.max(0, Math.min(100, r.w.percentUsed))
            const filled = Math.round((pct / 100) * barCells)
            const mark = r.elapsed === null ? -1 : Math.min(barCells - 1, Math.floor((r.elapsed / 100) * barCells))
            const before = mark >= 0 && mark < filled ? FILL.repeat(mark) : FILL.repeat(filled)
            const fillAfterMark = mark >= 0 && mark < filled ? FILL.repeat(filled - mark - 1) : ''
            const trackBefore = mark >= filled ? TRACK.repeat(mark - filled) : ''
            const trackAfter = mark >= filled ? TRACK.repeat(barCells - mark - 1) : TRACK.repeat(barCells - filled)
            return (
              <Box key={r.w.kind} flexDirection="row">
                {i > 0 ? (
                  <Text color="subtle" size="caption">
                    {SEP}
                  </Text>
                ) : null}
                <Text size="caption" weight="semibold" dimColor>
                  {r.head}
                </Text>
                <Text color={r.color} size="caption">
                  {before}
                </Text>
                {mark >= 0 && mark < filled ? (
                  <Text color="text" size="caption">
                    {MARK}
                  </Text>
                ) : null}
                <Text color={r.color} size="caption">
                  {fillAfterMark}
                </Text>
                <Text color="subtle" size="caption">
                  {trackBefore}
                </Text>
                {mark >= filled ? (
                  <Text color="text" size="caption">
                    {MARK}
                  </Text>
                ) : null}
                <Text color="subtle" size="caption">
                  {trackAfter}
                </Text>
                <Text color={r.color} bold size="caption" tabular>
                  {r.pct}
                </Text>
                {r.reset ? (
                  <Text dimColor size="caption" tabular>
                    {`  ${r.reset}`}
                  </Text>
                ) : null}
                {r.pace ? (
                  <Text color={r.pace.color} size="caption">
                    {`  ${r.pace.text}`}
                  </Text>
                ) : null}
              </Box>
            )
          })}
        </Box>
        {extras.length > 0 ? (
          <Box flexDirection="row" gap={2}>
            {extras.map(x => (
              <Text key={x.text} color={x.color} size="caption" tabular>
                {x.text}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}
