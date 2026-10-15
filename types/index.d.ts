declare module 'claude-code' {
  interface PluginState {
    'cache-ttl-timer': {
      lastHit: number | null
      detectedTtl: '5m' | '1h' | null
      turnActive: boolean
      promptAt: number | null
      idleCompactionOff: boolean
    }
  }
}
