import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Meta, Window } from '../types'

const windows = atom({ plugin: 'usage-bar', key: 'windows' } as const, [] as Window[])
const meta = atom({ plugin: 'usage-bar', key: 'meta' } as const, {} as Meta)

const STORE_KEY = 'lastWindows'
const LABELS: Record<string, string> = { five_hour: '5H', seven_day: '7D', spend_limit: '$' }
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Bar cells: filled and empty segments, and the "now" cell.
const ON = '▰'
const OFF = '▱'

// Palette: mid-tone colors that read on light and dark backgrounds alike.
const C = {
  green: '#3fb950',
  lime: '#8cc83c',
  amber: '#d29922',
  orange: '#e8743b',
  red: '#f0524f',
  blue: '#4c9cf5',
  violet: '#a371f7',
  track: '#8b949e',
}
const STOPS: [number, string][] = [
  [0, C.green],
  [0.45, C.lime],
  [0.65, C.amber],
  [0.82, C.orange],
  [1, C.red],
]

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const toHex = (rgb: number[]) => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`

// Heat color for a fraction 0–1: green, through amber, to red.
function heat(f: number): string {
  const x = Math.max(0, Math.min(1, f))
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i]!
    const [p0, c0] = STOPS[i - 1]!
    if (x <= p1) {
      const t = (x - p0) / (p1 - p0 || 1)
      const a = hex(c0)
      const b = hex(c1)
      return toHex(a.map((v, k) => v + ((b[k] ?? v) - v) * t))
    }
  }
  return C.red
}

const label = (w: Window) => LABELS[w.kind] ?? w.kind
const formatPct = (n: number) => `${n < 10 && n % 1 !== 0 ? n.toFixed(1) : Math.round(n)}%`

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
  if (w.percentUsed >= 100) return { text: '● limit reached', color: C.red }
  const elapsed = elapsedPct(w, now)
  const len = WINDOW_MS[w.kind]
  if (elapsed === null || !len || !w.resetsAt) return null
  const diff = w.percentUsed - elapsed
  if (diff > 10 && w.percentUsed > 0 && elapsed > 0) {
    const start = Date.parse(w.resetsAt) - len
    const rate = w.percentUsed / (now - start)
    const hitAt = now + (100 - w.percentUsed) / rate
    if (hitAt < Date.parse(w.resetsAt)) {
      return { text: `▲ out ~${clockAt(hitAt, now)}`, color: diff > 25 ? C.red : C.orange }
    }
    return { text: '▲ ahead of pace', color: C.amber }
  }
  if (diff < -15) return { text: '● plenty left', color: C.green }
  return { text: '● on pace', color: C.blue }
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
      head: `${label(w)} `,
      pct: ` ${formatPct(w.percentUsed)}`,
      reset: resetText(w, now),
      pace: pace(w, now),
      elapsed: elapsedPct(w, now),
    }))

    const extras: { text: string; color: string }[] = []
    if (typeof m.contextPct === 'number') {
      extras.push({ text: `◔ ctx ${Math.round(m.contextPct)}%`, color: heat(m.contextPct / 100) })
    }
    if (typeof m.usd === 'number' && m.usd > 0) extras.push({ text: `$${m.usd.toFixed(2)}`, color: C.violet })
    const extrasLen = extras.reduce((n, x) => n + x.text.length + 2, 0)

    const SEP = '   '
    // Whatever the text leaves goes to the bars, shared evenly.
    const textLen = rows.reduce(
      (n, r) => n + r.head.length + r.pct.length + (r.reset ? r.reset.length + 2 : 0) + (r.pace ? r.pace.text.length + 2 : 0),
      0,
    )
    const fixed = textLen + SEP.length * (rows.length - 1) + extrasLen + 4
    const cells = Math.max(8, Math.min(30, Math.floor((cols - fixed) / rows.length)))

    return (
      <Box flexDirection="row" width={cols} paddingX={1} justifyContent="space-between" overflow="hidden">
        <Box flexDirection="row">
          {rows.map((r, i) => {
            const used = Math.max(0, Math.min(100, r.w.percentUsed))
            const filled = Math.round((used / 100) * cells)
            const nowCell = r.elapsed === null ? -1 : Math.min(cells - 1, Math.floor((r.elapsed / 100) * cells))
            const tone = heat(used / 100)
            return (
              <Box key={r.w.kind} flexDirection="row">
                {i > 0 ? <Text size="caption">{SEP}</Text> : null}
                <Text size="caption" weight="bold" color={C.blue}>
                  {r.head}
                </Text>
                {Array.from({ length: cells }, (_, c) => {
                  const isOn = c < filled
                  const isNow = c === nowCell
                  // Filled cells take the heat color of their own position; the "now" cell is blue.
                  const color = isNow ? C.blue : isOn ? heat((c + 0.5) / cells) : C.track
                  return (
                    <Text key={`c${c}`} size="caption" tabular color={color} dimColor={!isOn && !isNow}>
                      {isOn || isNow ? ON : OFF}
                    </Text>
                  )
                })}
                <Text color={tone} bold size="caption" tabular>
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
