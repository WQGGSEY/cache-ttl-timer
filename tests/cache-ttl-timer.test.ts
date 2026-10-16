import { describe, expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const START = Date.parse('2026-10-02T06:00:00Z')
const SURFACES = ['desktop', 'terminal'] as const
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 100,
  model: 'claude-opus-5-5',
}

// What the world beneath the mod answers: no transcript on disk, no saved /cache-ttl choice
function world(
  on: any,
  transcript = '',
  options: { tooLarge?: boolean; store?: Record<string, unknown>; kept?: Map<string, unknown> } = {},
) {
  const clock = mock.clock(on, { now: START })
  const kept = options.kept
  if (kept) {
    // A store the test reads back afterwards
    on('store.get', (_$: any, e: any) => ({ value: kept.get(e.key) }))
    on('store.set', (_$: any, e: any) => {
      kept.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', (_$: any, e: any) => {
      kept.delete(e.key)
      return { value: undefined }
    })
  } else mock.store(on, options.store)
  mock.env(on, { HOME: '/Users/test' })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'cache-ttl' } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('fs.exists', () => ({ value: false }))
  on('classic.Stop', () => ({}))
  on('session.usage', () => ({
    value: { startedAt: START, context: { tokens: 186_000, window: 1_000_000, percent: 18.6 }, rateLimits: [] },
  }))
  // Claude Code's own drawing of the footer labels
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('fs.read', () => {
    // A transcript over 4 MiB, which $.fs.read refuses
    if (options.tooLarge) throw new Error('EFBIG: file is over 4 MiB')
    return { value: transcript }
  })
  // The model's answer to every request
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  // The engine compacts whatever reaches it into one summary
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  return clock
}

// A compaction raised as the engine raises it: 'auto' for its threshold and its idle compaction
function compact($: any, trigger: 'auto' | 'manual') {
  return $.session.compact({ trigger, messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
}

const ON_LABEL = '●  Idle compact  On'
const OFF_LABEL = '○  Idle compact  Off'

async function start($: any) {
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
}

// One request to the model, read to its end
async function step($: any, agentId?: string) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) {
  }
  return s.result
}

function footer($: any, surface: 'desktop' | 'terminal', modes: string[] = ['focus']) {
  return $.ui.mount({ plugin: 'cache-ttl-timer', surface, component: 'SessionMode', props: { modes } })
}

// The indicator's label: 47m, 0:42, or Cold, after its ring glyph in the footer
const LABEL = /^(?:[●◕◑◔○◌] )?(\d+m|0:\d\d|Cold)$/
const BAND = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} }

async function label(ui: any) {
  return ui.find({ type: 'Text', text: LABEL })
}

// The label without its glyph
async function labelText(ui: any) {
  const t = await label(ui)
  return t ? String(t.text).replace(/^[●◕◑◔○◌] /, '') : undefined
}

function band($: any, surface: 'desktop' | 'terminal', props: Record<string, unknown> = {}) {
  return $.ui.mount({ plugin: 'cache-ttl-timer', surface, component: 'AbovePrompt', props: { ...BAND, ...props } })
}

// Where each surface draws the indicator: the terminal's footer, the desktop's band above the prompt
function indicator($: any, surface: 'desktop' | 'terminal') {
  return surface === 'terminal' ? footer($, surface) : band($, surface)
}

// /cache-ttl as typed at the prompt
function cacheTtl($: any, args: string) {
  return $.command.run({ command: 'cache-ttl', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
}

describe('cache-ttl-timer', () => {
  test('draws nothing of its own before the first request', async ($, on) => {
    world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await indicator($, surface)
      expect(await label(ui)).toBeUndefined()
      await ui.unmount()
    }
  })

  // Moving the clock an hour runs the once-a-second ticker 3,600 times
  test('shows the ring and the time: gray, then the warning color in the last fifth, then cold', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = world(on)
    await start($)
    await step($)
    const expectEach = async (glyph: string, text: string, level: 'warm' | 'warn' | 'cold') => {
      for (const surface of SURFACES) {
        const ui = await indicator($, surface)
        const t = await label(ui)
        // The terminal's ring is a glyph before the time; the desktop's is an SVG beside it
        expect(t?.text).toBe(surface === 'terminal' ? glyph + ' ' + text : text)
        // Warm, the terminal's label is the footer's dim gray and the desktop's the text color
        if (level === 'warn') expect(t?.props.color).toBe('warning')
        else expect(t?.props.dimColor).toBe(level === 'cold' || surface === 'terminal' ? true : undefined)
        expect(Boolean(await ui.find({ type: 'Svg' }))).toBe(surface === 'desktop')
        await ui.unmount()
      }
    }
    await clock.advance(1000)
    await expectEach('●', '60m', 'warm')
    await clock.set(START + 50 * MIN)
    await expectEach('◔', '10m', 'warn')
    await clock.set(START + 59 * MIN + 18_000)
    await expectEach('○', '0:42', 'warn')
    await clock.set(START + 60 * MIN + 1000)
    await expectEach('◌', 'Cold', 'cold')
  })

  test("the desktop's band draws the ring as an SVG image, amber in the last fifth, dashed with no arc once cold", async ($, on) => {
    const clock = world(on)
    await start($)
    await step($)
    const sourceAt = async (ms: number) => {
      await clock.set(START + ms)
      const ui = await band($, 'desktop')
      const svg = await ui.find({ type: 'Svg' })
      expect(svg?.props.isInteractive).toBeUndefined()
      const source = String(svg?.props.source)
      await ui.unmount()
      return source
    }
    expect(await sourceAt(1000)).toContain('stroke="#9a9a9a"')
    expect(await sourceAt(50 * MIN)).toContain('stroke="#d99a2b"')
    const cold = await sourceAt(61 * MIN)
    expect(cold).not.toContain('#9a9a9a')
    expect(cold).not.toContain('#d99a2b')
    expect(cold).toContain('stroke-dasharray="1.6 2.1"')
  })

  test("the terminal's footer keeps its labels when there are some, and the indicator stands alone when there are none", async ($, on) => {
    world(on)
    await start($)
    await step($)
    const withModes = await footer($, 'terminal', ['focus'])
    expect(await labelText(withModes)).toBe('60m')
    expect(await withModes.find({ type: 'Text', text: /^ · $/ })).toBeDefined()
    await withModes.unmount()
    const alone = await footer($, 'terminal', [])
    expect(await labelText(alone)).toBe('60m')
    expect(await alone.find({ type: 'Text', text: /^ · $/ })).toBeUndefined()
  })

  test("the desktop draws the island above the prompt and leaves the footer's labels to Claude Code", async ($, on) => {
    world(on)
    await start($)
    await step($)
    const desktopBand = await band($, 'desktop')
    expect(await labelText(desktopBand)).toBe('60m')
    // The switch at the left, the ring and the time at the right
    expect((await desktopBand.find({ type: 'Box' }))?.props.justifyContent).toBe('space-between')
    // The desktop draws the footer's labels on a row of their own under the model and effort
    const desktopFooter = await footer($, 'desktop', [])
    expect(await label(desktopFooter)).toBeUndefined()
    // The terminal's band stays Claude Code's: its indicator is in the footer
    const terminalBand = await band($, 'terminal')
    expect(await label(terminalBand)).toBeUndefined()
    // A survey holds the band
    const surveyBand = await band($, 'desktop', { hasSurvey: true })
    expect(await label(surveyBand)).toBeUndefined()
  })

  test("the band's button turns idle compaction off and back on, dimming while off", async ($, on) => {
    world(on)
    await start($)
    await step($)
    const ui = await band($, 'desktop')
    const button = () => ui.find({ type: 'Button' })
    expect((await button())?.props).toEqual(expect.objectContaining({ key: 'idle-compaction', label: ON_LABEL }))
    expect((await button())?.props.dimColor).toBeUndefined()
    await ui.press({ key: 'idle-compaction' })
    expect((await button())?.props).toEqual(expect.objectContaining({ label: OFF_LABEL, dimColor: true }))
    await ui.press({ key: 'idle-compaction' })
    expect((await button())?.props.label).toBe(ON_LABEL)
  })

  test('while off, an idle compaction is skipped; one inside a turn, right after a prompt, or by hand goes on', async ($, on) => {
    const clock = world(on)
    await start($)
    await step($)
    // On, the engine's idle compaction goes on
    expect((await compact($, 'auto')).skip).toBeUndefined()
    const ui = await band($, 'desktop')
    await ui.press({ key: 'idle-compaction' })
    // Off and idle: skipped
    expect((await compact($, 'auto')).skip).toBe('Idle compaction is off for this session')
    // The threshold's compaction inside a turn goes on
    await $.turn.start({ text: 'go on', turnId: 't2' })
    expect((await compact($, 'auto')).skip).toBeUndefined()
    await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
    expect((await compact($, 'auto')).skip).toBe('Idle compaction is off for this session')
    // A prompt just sent opens a turn whose turn.start may still be queued
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect((await compact($, 'auto')).skip).toBeUndefined()
    await clock.advance(3 * MIN)
    expect((await compact($, 'auto')).skip).toBe('Idle compaction is off for this session')
    // /compact is the person's own
    expect((await compact($, 'manual')).skip).toBeUndefined()
  })

  test('the off choice is kept for the session across a resume', async ($, on) => {
    world(on, '', { store: { 'idle-off:session-1': true } })
    await start($)
    await step($)
    const ui = await band($, 'desktop')
    expect((await ui.find({ type: 'Button' }))?.props.label).toBe(OFF_LABEL)
    expect((await compact($, 'auto')).skip).toBe('Idle compaction is off for this session')
  })

  test("a subagent's request doesn't restart the countdown", async ($, on) => {
    const clock = world(on)
    await start($)
    await step($)
    await clock.advance(30 * MIN)
    await step($, 'agent-1')
    const ui = await band($, 'desktop')
    expect(await labelText(ui)).toBe('30m')
    await step($)
    await clock.settle()
    expect(await labelText(ui)).toBe('60m')
  })

  test('reads the TTL from the transcript when Claude stops', async ($, on) => {
    const sent = new Date(START).toISOString()
    const transcript = [
      'cut-off half line"}',
      JSON.stringify({ type: 'user', timestamp: sent }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(START + 20_000).toISOString(),
        message: {
          id: 'msg_1',
          model: 'claude-opus-5-5',
          usage: { ...USAGE, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } },
        },
      }),
    ].join('\n')
    world(on, transcript)
    await start($)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t.jsonl' })
    const ui = await band($, 'desktop')
    // The countdown starts when the request was sent, the prompt row's time, not the answer's
    expect(await labelText(ui)).toBe('5m')
    const reply = await cacheTtl($, '')
    expect(reply.text).toContain('TTL 5m (from the transcript)')
    expect(reply.text).toContain('drawn on desktop')
  })

  test('/cache-ttl 5m overrides the TTL, and auto hands it back', async ($, on) => {
    world(on)
    await start($)
    await step($)
    const ui = await band($, 'desktop')
    await cacheTtl($, '5m')
    expect(await labelText(ui)).toBe('5m')
    await cacheTtl($, 'auto')
    expect(await labelText(ui)).toBe('60m')
    const bad = await cacheTtl($, '2h')
    expect(bad.text).toContain('Use /cache-ttl')
  })

  test('a transcript too large to read falls back to what the session last kept', async ($, on) => {
    world(on, '', { tooLarge: true, store: { 'last:session-1': { sentAt: START - 50 * MIN, ttl: '1h' } } })
    await start($)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t.jsonl' })
    const ui = await footer($, 'terminal')
    expect((await label(ui))?.text).toBe('◔ 10m')
    const reply = await cacheTtl($, '')
    expect(reply.text).toContain('TTL 1h (from the transcript)')
  })

  test('each request is kept for the next resume', async ($, on) => {
    const kept = new Map<string, unknown>()
    world(on, '', { tooLarge: true, kept })
    await start($)
    await step($)
    expect(kept.get('last:session-1')).toEqual({ sentAt: START, ttl: null })
  })
})
