// cache-ttl-timer: a prompt-cache countdown beside the mode labels in the prompt footer.
//
// The main conversation's cache entry lives for its TTL after the last request
// that used it. The countdown starts when each main-loop request is sent
// (turn.step), and the TTL (5m or 1h) is read from the transcript, where the
// API's usage records how many tokens were written at each TTL. Both are kept in
// the plugin's store per session, for a transcript too large to read.
import { atom, read, update } from 'claude-code'

// When the main conversation last used its cache, in $.clock.now() milliseconds; null before any request
const lastHit = atom({ plugin: 'cache-ttl-timer', key: 'lastHit' }, null)
// The TTL the latest cache write used, as the transcript reports it; null until one is seen
const detectedTtl = atom({ plugin: 'cache-ttl-timer', key: 'detectedTtl' }, null)
// The wait for a new session's first TTL: null before it, the $.clock.now() deadline while it runs, 'done' after
const ttlWait = atom({ plugin: 'cache-ttl-timer', key: 'ttlWait' }, null)
// The transcript's path, as classic.SessionStart gives it; null until then
const transcriptFile = atom({ plugin: 'cache-ttl-timer', key: 'transcriptFile' }, null)

const TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 }
// What Claude Code asks for on the main thread of a subscription that isn't in overage
const DEFAULT_TTL = '1h'
// How long a new session's first request waits for its row in the transcript, which says the TTL.
// The row usually lands about a second after the request ends; the ticker reads once a second meanwhile.
const TTL_WAIT_MS = 10 * 1000
// The share of the TTL left when the countdown turns amber
const WARN_FRACTION = 0.2
// Claude Code names a project's folder after its path, cut to this length
const PROJECT_SLUG_MAX = 200
// How many steps the ring drains in: every 30 seconds of a 1h TTL, so it redraws rarely
const RING_STEPS = 120
// The ring's geometry, in the 16x16 viewBox it is drawn in
const RING_R = 6
const RING_C = 2 * Math.PI * RING_R
// The terminal's ring, from full to nearly empty, and the one drawn once the cache is cold
const GLYPHS = ['●', '◕', '◑', '◔', '○']
const COLD_GLYPH = '◌'
// Label colors by level: the footer's own dim gray, the theme's warning, and dim again once cold
const LABEL_STYLE = { warm: { dimColor: true }, warn: { color: 'warning' }, cold: { dimColor: true } }
// The desktop ring's arc by level
const RING_COLOR = { warm: '#9a9a9a', warn: '#d99a2b' }

// The TTL picked with /cache-ttl 5m|1h, shared by every session; null follows the transcript
let override = null
// What the indicator last drew, so the ticker redraws only when the label or the ring changes
let drawnKey = ''
// Whether the desktop has asked for the footer's mode labels; until it does, the band above the prompt stands in
let desktopFooterSeen = false
// Whether the ticker is reading the transcript, so a slow read isn't started again on the next tick
let ttlReading = false

export function register(on) {
  // Runs before the first prompt, and again after a reload
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-ttl',
      description: 'Show the prompt cache countdown, or set its TTL: /cache-ttl [5m|1h|auto]',
      immediate: true,
    })
    const saved = await $.store.get('override')
    override = saved === '5m' || saved === '1h' ? saved : null
    // After a reload or a resume, pick the countdown up from the transcript
    try {
      const path = await transcriptPath($)
      if (path) await learnFromTranscript($, path)
    } catch {
      // No transcript to read yet; the first request starts the countdown
    }
    $.clock.every(1000, () => tick($))
    return next(e)
  })

  // Runs on startup, /resume, /clear and compaction, with the transcript's path
  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path) await update($, transcriptFile, () => e.transcript_path)
    await learnFromTranscript($, e.transcript_path)
    return next(e)
  })

  // Runs when Claude finishes answering: the transcript now holds the turn's cache writes
  on('classic.Stop', async ($, e, next) => {
    await learnFromTranscript($, e.transcript_path)
    return next(e)
  })

  // Runs for each request to the model
  on('turn.step', async function* ($, e, next) {
    // A subagent caches its own prefix; the footer follows the main conversation
    if (e.agentId) return yield* next(e)
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    // A request that got an answer read or wrote the cache, which restarts its TTL
    if (result.usage) {
      await update($, lastHit, (prev) => Math.max(prev ?? 0, sentAt))
      await remember($)
      // A new session doesn't know its TTL until this request's row reaches the transcript, which
      // classic.Stop would read only at the end of the turn. Have the ticker look for it now, once.
      if ((await read($, detectedTtl)) === null && (await read($, ttlWait)) === null) {
        const until = (await $.clock.now()) + TTL_WAIT_MS
        await update($, ttlWait, () => until)
      }
    }
    return result
  })

  // Runs when you type /cache-ttl
  on('command.run', { command: 'cache-ttl' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === '5m' || arg === '1h') {
      override = arg
      await $.store.set('override', arg)
    } else if (arg === 'auto') {
      override = null
      await $.store.delete('override')
    } else if (arg) {
      return { text: 'Use /cache-ttl, /cache-ttl 5m, /cache-ttl 1h, or /cache-ttl auto' }
    }
    $.ui.invalidate('ui.render')
    return { text: await statusText($) }
  })

  // Runs each time Claude Code draws the mode labels in the prompt footer
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface === 'desktop' && !desktopFooterSeen) {
      desktopFooterSeen = true
      // Take the stand-in above the prompt down
      $.ui.invalidate('ui.render')
    }
    const now = await readout($)
    if (!now) return next(e)
    const indicator = await drawIndicator($, e, now)
    if (e.props.modes.length === 0) return indicator
    // Keep Claude Code's labels, with the indicator after them
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return Box({
      flexDirection: 'row',
      alignItems: 'center',
      children: [theirs, Text({ dimColor: true, children: [' · '] }), indicator],
    })
  })

  // Runs each time Claude Code draws the band above the prompt. A desktop that never asks for
  // the footer's mode labels gets the indicator here instead, at the right, above the context ring.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || desktopFooterSeen || e.props.hasSurvey) return next(e)
    const now = await readout($)
    if (!now) return next(e)
    const { Box } = $.ui.resolve(e)
    return Box({
      flexDirection: 'row',
      justifyContent: 'flex-end',
      width: e.props.bodyColumns,
      children: [await drawIndicator($, e, now)],
    })
  })
}

// The indicator itself: a ring and its label. The footer draws text alone on every surface (the
// desktop drops images there), so its ring is a glyph; the desktop's band above the prompt draws
// images, so there the ring is an SVG the size of the context ring.
async function drawIndicator($, e, now) {
  const { Box, Text, Svg } = $.ui.resolve(e)
  if (e.surface === 'desktop' && e.component === 'AbovePrompt') {
    const ring = Svg({ source: ringSvg(now), alt: 'Prompt cache: ' + now.label, width: 14, height: 14 })
    const label = Text({ ...LABEL_STYLE[now.level], children: [now.label] })
    return Box({ flexDirection: 'row', alignItems: 'center', columnGap: 1, children: [ring, label] })
  }
  return Text({ ...LABEL_STYLE[now.level], children: [ringGlyph(now) + ' ' + now.label] })
}

// Where the countdown stands now, or null before the first request
async function readout($) {
  const hit = await read($, lastHit)
  if (hit === null) return null
  // Draw nothing rather than the default while the first TTL is on its way
  if (await waitingForTtl($)) return null
  const ttl = await ttlFor($)
  const total = TTL_MS[ttl]
  const left = hit + total - (await $.clock.now())
  const level = left <= 0 ? 'cold' : left <= total * WARN_FRACTION ? 'warn' : 'warm'
  // The ring moves in steps, so its drawing changes a few times a minute at most
  const step = left <= 0 ? 0 : Math.ceil((left / total) * RING_STEPS)
  return { hit, ttl, total, left, level, step, label: labelText(left) }
}

// 47m while there's time, 0:42 in the last minute, Cold after
function labelText(left) {
  if (left <= 0) return 'Cold'
  if (left < 60 * 1000) return '0:' + String(Math.ceil(left / 1000)).padStart(2, '0')
  return Math.ceil(left / 60000) + 'm'
}

// The terminal's ring: one glyph that empties as the cache cools
function ringGlyph(now) {
  if (now.level === 'cold') return COLD_GLYPH
  const emptied = 1 - now.step / RING_STEPS
  return GLYPHS[Math.min(GLYPHS.length - 1, Math.round(emptied * (GLYPHS.length - 1)))]
}

// The desktop's ring: a track and an arc that drains clockwise from twelve, dashed once cold.
// Drawn as an image, so the colors sit in attributes: mid grays and an amber that read on light and dark.
export function ringSvg(now) {
  const offset = (RING_C * (1 - now.step / RING_STEPS)).toFixed(2)
  const track =
    now.level === 'cold'
      ? '<circle cx="8" cy="8" r="6" fill="none" stroke="#8a8a8a" stroke-opacity=".6" stroke-width="1.75" stroke-dasharray="1.6 2.1"/>'
      : '<circle cx="8" cy="8" r="6" fill="none" stroke="#8a8a8a" stroke-opacity=".35" stroke-width="1.75"/>'
  const arc =
    now.level === 'cold'
      ? ''
      : '<circle cx="8" cy="8" r="6" fill="none" stroke="' + RING_COLOR[now.level] +
        '" stroke-width="1.75" stroke-linecap="round" stroke-dasharray="' + RING_C.toFixed(2) +
        '" stroke-dashoffset="' + offset + '" transform="rotate(-90 8 8)"/>'
  return '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16">' + track + arc + '</svg>'
}

// The TTL in use: /cache-ttl's choice, else what the transcript reported, else the default
async function ttlFor($) {
  return override ?? (await read($, detectedTtl)) ?? DEFAULT_TTL
}

// Whether the TTL is still unknown and a new session's first request is waiting to read it
async function waitingForTtl($) {
  if (override) return false
  return typeof (await read($, ttlWait)) === 'number' && (await read($, detectedTtl)) === null
}

// Once a second: look for the first TTL while a new session waits for it, then redraw when the label or the ring has changed
async function tick($) {
  await awaitTtl($)
  const now = await readout($)
  const key = now ? now.level + now.label + now.step : ''
  if (key === drawnKey) return
  drawnKey = key
  $.ui.invalidate('ui.render')
}

// Reads the transcript for the TTL during a new session's wait, and ends the wait once it's found or the deadline passes
async function awaitTtl($) {
  const until = await read($, ttlWait)
  if (typeof until !== 'number' || ttlReading) return
  ttlReading = true
  try {
    if ((await read($, detectedTtl)) === null) {
      const path = (await read($, transcriptFile)) ?? (await transcriptPath($))
      if (path) await learnFromTranscript($, path)
    }
  } catch {
    // Not there yet; the next tick tries again until the deadline
  } finally {
    ttlReading = false
  }
  if ((await read($, detectedTtl)) !== null || (await $.clock.now()) >= until) await update($, ttlWait, () => 'done')
}

// The reply to /cache-ttl
async function statusText($) {
  if (await waitingForTtl($)) {
    return 'TTL not known yet: reading it from the transcript, using 1h if it isn\'t there in a few seconds · ' + (await drawnText($))
  }
  const ttl = await ttlFor($)
  const source = override ? 'set with /cache-ttl' : (await read($, detectedTtl)) ? 'from the transcript' : 'default'
  const head = 'TTL ' + ttl + ' (' + source + ')'
  const drawn = await drawnText($)
  const hit = await read($, lastHit)
  if (hit === null) return head + ' · no request yet · ' + drawn
  const now = await $.clock.now()
  const left = hit + TTL_MS[ttl] - now
  const ago = 'last request ' + clockText(now - hit) + ' ago'
  const state = left > 0 ? clockText(left) + ' left' : 'expired, the next message writes the cache again'
  return head + ' · ' + ago + ' · ' + state + ' · ' + drawn
}

// Where the indicator can show: an app draws a mod's UI only once it attaches to the session
async function drawnText($) {
  const surfaces = await $.session.surfaces()
  return surfaces.length > 0 ? 'drawn on ' + surfaces.join(', ') : 'no app draws mod UI in this session'
}

// Reads the transcript and records the TTL of the latest cache write, and the last request if it's newer.
// It starts no program, so it works the same on every platform. A transcript over $.fs.read's 4 MiB
// falls back to what this session last kept in the store.
async function learnFromTranscript($, path) {
  if (!path) return
  let text = null
  try {
    text = await $.fs.read(path)
  } catch {
    // Missing, or too large to read
  }
  const found = text === null ? await $.store.get(lastKey(await $.session.id())) : parseTranscript(text)
  if (!found || typeof found.sentAt !== 'number') return
  if (found.ttl === '5m' || found.ttl === '1h') await update($, detectedTtl, () => found.ttl)
  await update($, lastHit, (prev) => Math.max(prev ?? 0, found.sentAt))
  if (text !== null) await remember($)
}

// Keeps this session's last request and TTL in the store, for a transcript too large to read
async function remember($) {
  const sentAt = await read($, lastHit)
  if (sentAt === null) return
  await $.store.set(lastKey(await $.session.id()), { sentAt, ttl: await read($, detectedTtl) })
}

function lastKey(sessionId) {
  return 'last:' + sessionId
}

// The session's transcript under ~/.claude/projects, where Claude Code names it by the session id
async function transcriptPath($) {
  const projects = ((await $.env.get('CLAUDE_CONFIG_DIR')) || (await $.env.get('HOME')) + '/.claude') + '/projects/'
  const file = '/' + (await $.session.id()) + '.jsonl'
  const slug = (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= PROJECT_SLUG_MAX) {
    return (await $.fs.exists(projects + slug + file)) ? projects + slug + file : null
  }
  // A longer slug is cut and given a hash suffix, so look for the folder that holds the session
  const prefix = slug.slice(0, PROJECT_SLUG_MAX) + '-'
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind === 'dir' && entry.name.startsWith(prefix) && (await $.fs.exists(projects + entry.name + file))) {
      return projects + entry.name + file
    }
  }
  return null
}

// From transcript lines: when the last main-conversation request was sent, and the TTL of the latest cache write
export function parseTranscript(text) {
  let sentAt = null
  let ttl = null
  let lastUserAt = null
  let lastId = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      // A line still being written
      continue
    }
    if (row.isSidechain) continue
    const at = Date.parse(row.timestamp)
    if (Number.isNaN(at)) continue
    // A prompt or a tool result is written just before the request that carries it
    if (row.type === 'user') {
      lastUserAt = at
      continue
    }
    if (row.type !== 'assistant') continue
    const message = row.message ?? {}
    const usage = message.usage
    if (!usage || message.model === '<synthetic>') continue
    // One response is written as several rows that share its id
    if (message.id !== lastId) {
      lastId = message.id
      sentAt = lastUserAt ?? at
    }
    const written = usage.cache_creation ?? {}
    if (written.ephemeral_1h_input_tokens > 0) ttl = '1h'
    else if (written.ephemeral_5m_input_tokens > 0) ttl = '5m'
  }
  return sentAt === null ? null : { sentAt, ttl }
}

// Milliseconds as mm:ss, rounded up so the last second shows 00:01
function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}
