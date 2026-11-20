import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false },
} as const

test('the band shows the 5-hour and 7-day windows on every surface', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {} as never,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42.5, resetsAt: '2099-01-01T00:00:00Z' },
        { kind: 'seven_day', percentUsed: 91 },
      ],
    },
  }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2098-12-31T22:00:00Z') }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect((await ui.find({ type: 'Text', text: '5-hour limit' }))?.text).toBe('5-hour limit')
    expect((await ui.find({ type: 'Text', text: /^43%$/ }))?.text).toBe('43%')
    expect((await ui.find({ type: 'Text', text: /^91%$/ }))?.text).toBe('91%')
    expect((await ui.find({ type: 'Text', text: /resets in/ }))?.text).toBe('resets in 2h 0m')
    await ui.unmount()
  }
})
