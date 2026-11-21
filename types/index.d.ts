export type Window = { kind: string; percentUsed: number; resetsAt?: string }
export type Meta = { contextPct?: number; usd?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { windows: Window[]; meta: Meta }
  }
}
