import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentsMain, Band, BlockView, Mode, PickerGroup, RunRow } from '../types'

// Live typing. `/live-typing` opens a small picker; `/live-typing on | off | demo` and
// `/live-typing agents full | brief | off` switch directly.
// - on (default): a band above the prompt shows what Claude is doing, fed by the real stream:
//   thinking, reply text, commands and code as they are written (typed out letter by letter),
//   then each tool while it runs (blinking marker + timer) and the last lines of a command's output.
//   When a reply lands in the transcript, the band hands it over and the transcript types the rest.
//   Fullscreen: a reply never types in the band. It types in a row of its own at the transcript's end, exactly
//   where the finished message lands (a short chat's top, a long chat's bottom), and the message takes the
//   row's place and types on from there, so the text never moves. Scrolled away from it, the band shows it.
// - demo: the same at a calm pace; before a tool runs it waits until the text written before it has
//   been typed and had time to be read. Lasts one reply, then back to on or off. Never remembered.
// - off. On and off are remembered across sessions.
// The band copies the transcript's look (● bullets, 2-cell gutter, results under ⎿). It opens a couple
// of rows at a time and closes with an ease-out, so nothing below it jumps.
// Helper agents (any subagent, also ones started later) get the same band, always at the normal pace:
// while an agent's transcript is open (tasks list), the band shows that agent. The main view shows
// Claude's own work; how much of the agents it shows is the `agents` setting (remembered, off by default):
// full = while Claude is idle (or only waiting on a helper it started), the helper's band under its name;
// brief = just a name row when an agent starts or finishes; off = nothing. ▾ hide / ▸ show next to an
// agent's name switches between full and brief.

const tick = atom({ plugin: 'live-typing', key: 'tick' } as const, 0)
const band = atom({ plugin: 'live-typing', key: 'band' } as const, null)
const agentBands = atom({ plugin: 'live-typing', key: 'agents' } as const, {})
const agentsMain = atom({ plugin: 'live-typing', key: 'agentsMain' } as const, 'off')
const mode = atom({ plugin: 'live-typing', key: 'mode' } as const, 'on')
const pickerFocus = atom({ plugin: 'live-typing', key: 'pickerFocus' } as const, '')
const pickerStart = atom({ plugin: 'live-typing', key: 'pickerStart' } as const, 'typing')
const AGENTS_STORE_KEY = 'agentsMain'
const TYPING_STORE_KEY = 'typing'
const PICKER = 'live-typing' // the picker pane's id
const PICKER_ROWS = 13
const LABEL_CELLS = 9 // the picker's label column: "Brief ✔" and a gap
const AGENT_TOOLS = new Set(['Agent', 'Task']) // the tool that starts a helper agent (Task: its older name)

// The words the command takes; `live` and `name` are older names, still accepted.
const TYPING_WORDS: Record<string, Mode> = { on: 'on', live: 'on', demo: 'demo', off: 'off' }
const AGENTS_WORDS: Record<string, AgentsMain> = { full: 'full', brief: 'brief', name: 'brief', off: 'off' }
const TYPING_OPTIONS: { value: Mode; label: string; what: string }[] = [
  { value: 'on', label: 'On', what: "Claude's work types out as it streams" },
  { value: 'demo', label: 'Demo', what: 'next reply only, slow enough to follow' },
  { value: 'off', label: 'Off', what: 'nothing above the prompt' },
]
const AGENTS_OPTIONS: { value: AgentsMain; label: string; what: string }[] = [
  { value: 'full', label: 'Full', what: "a helper's live typing, under its name" },
  { value: 'brief', label: 'Brief', what: 'just its name and what it is doing' },
  { value: 'off', label: 'Off', what: "only Claude's own work" },
]
// A word's meaning in one of the tables above (own keys only: `constructor` is no setting).
const wordOf = <T,>(table: Record<string, T>, w: unknown): T | undefined =>
  typeof w === 'string' && Object.prototype.hasOwnProperty.call(table, w) ? table[w] : undefined
const whatOf = <T extends string>(list: { value: T; what: string }[], v: T) => list.find((o) => o.value === v)?.what ?? ''
const USAGE = 'Use /live-typing on | off | demo, or /live-typing agents full | brief | off; /live-typing alone opens the picker.'

async function setAgentsMain($: EngineInterface, v: AgentsMain) {
  await update($, agentsMain, () => v)
  try {
    await $.store.set(AGENTS_STORE_KEY, v)
  } catch {
    // kept for this session only
  }
}

// On and off are remembered (and are what a demo goes back to); demo lasts one reply and is never remembered.
async function setTyping($: EngineInterface, chosen: Mode) {
  await update($, mode, () => chosen)
  pace = chosen === 'demo' ? PACES.demo : PACES.live
  demoUsed = false
  revertDemo = false
  if (chosen !== 'demo') {
    restMode = chosen
    try {
      await $.store.set(TYPING_STORE_KEY, chosen)
    } catch {
      // kept for this session only
    }
  }
  // Only off clears: the command is immediate, and clearing mid-reply drops the block still streaming
  // (the step keeps writing into it, but it is no longer in the queue, so the rest never shows).
  if (chosen === 'off') await clearAll($)
}

async function statusLine($: EngineInterface) {
  return `Live typing: ${await read($, mode)} · agents in the main view: ${await read($, agentsMain)}. ${USAGE}`
}

// The picker: a small dialog above the prompt (arrows + Enter, Esc closes). Where no pane can be shown
// (a headless run), the settings as one line instead.
async function openPicker($: EngineInterface, at: PickerGroup): Promise<{ text?: string }> {
  try {
    await update($, pickerStart, () => at)
    await update($, pickerFocus, () => '')
    const opened = await $.ui.open({ id: PICKER, title: 'Live typing', focus: true, closeOnEscape: true, rows: PICKER_ROWS })
    if (opened.isPlaced) return {}
    void $.ui.close({ id: PICKER }).catch(() => {})
  } catch {
    // no pane here
  }
  return { text: await statusLine($) }
}

// Claude is only waiting on helper agents it started (its band shows just ● Agent(...) 12s): the tasks
// those Agent calls named; null when it is doing anything else.
function waitedOn(b: Band): string[] | null {
  if (b.block) return null
  const running = b.rows.filter((r) => r.running)
  return running.length > 0 && running.every((r) => AGENT_TOOLS.has(r.tool)) ? running.map((r) => r.label) : null
}

// One line for an agent whose band is folded to its name: what it is doing now.
function doingOf(b: Band): string {
  const v = b.block
  if (v?.kind === 'think') return 'thinking'
  if (v?.kind === 'text') return 'writing'
  if (v && v.tool) return [v.tool, v.label || oneLine(v.source.replace(CARET, ''), 60)].filter(Boolean).join(' ')
  const r = b.rows[b.rows.length - 1]
  if (r) return `${r.tool}${r.label ? ` ${r.label}` : ''}${r.running ? '' : r.isError ? ' ✗' : ' ✓'}`
  return b.idle ? 'between steps' : ''
}

type Kind = BlockView['kind']
type Pace = {
  cps: number // the slowest it types, characters per second
  catchup: number // a backlog is typed out over about this long (s), so it never falls far behind
  queued: number // the same while more blocks wait behind this one
  maxCps: number // never faster than this (Infinity: no cap)
  gap: number // ms a finished block stays when another waits behind it
  hold: Record<Kind, number> // ms a finished block stays when nothing follows it
  result: number // ms a finished tool (and its output) stays
  read: boolean // demo: hold reply text long enough to read, make tools wait for it, never hurry
}
const PACES: Record<'live' | 'demo', Pace> = {
  live: { cps: 320, catchup: 1.2, queued: 0.4, maxCps: Infinity, gap: 0, hold: { think: 250, text: 350, code: 1200, line: 600 }, result: 2500, read: false },
  demo: { cps: 110, catchup: 3, queued: 3, maxCps: 165, gap: 700, hold: { think: 800, text: 1200, code: 2000, line: 1500 }, result: 5000, read: true },
}
const READ_WPS = 3.3 // words per second a person reads
const READ_MIN_MS = 1500
const READ_MAX_MS = 6000
const TOOL_WAIT_SPARE_MS = 1500 // a waiting tool goes ahead while this much of its hook budget is left

const CARET = '▌'
const FRAME_MS = 33
const BLINK_MS = 500
const BAND_MIN_CAP = 6 // the band's tallest, at least (rows)...
const BAND_MAX_CAP = 18 // ...and at most; in between, about 40% of the window
const GROW_ROWS = 2 // the band opens this many rows per frame when it needs more...
// ...and closes with an ease-out: quick while far from its new size, slower for the last rows.
// A terminal moves in whole rows; this is as smooth as it gets.
const SHRINK_MS = 48 // ms per row for the last rows
function shrinkEvery(rowsLeft: number) {
  return rowsLeft > 6 ? 16 : rowsLeft > 3 ? 28 : SHRINK_MS
}
const KEEP_LINES = 60 // code lines the band keeps; it draws as many as fit
const KEEP_CHARS = 6000 // reply / thinking text the band keeps
const TAIL_LINES = 14
const GIVE_UP_MS = 120000 // a transcript reply still "typing" after this is shown whole
const HANDOVER_MS = 4000 // the transcript continues typing only a reply that landed this recently

// Tools whose main field is typed out as code, and the field.
const CODE_FIELDS: Record<string, string> = {
  Write: 'content',
  Edit: 'new_string',
  NotebookEdit: 'new_source',
  Bash: 'command',
  PowerShell: 'command',
}
const CODE_LANGS: Record<string, string> = { Bash: 'bash', PowerShell: 'powershell' }
// For any other tool, the first of these that arrives is its one-line label.
const LINE_FIELDS = ['file_path', 'notebook_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'skill', 'command']
const RUN_LABEL_FIELDS = ['description', 'command', 'file_path', 'notebook_path', 'pattern', 'path', 'url', 'query', 'prompt', 'skill']

type Block = {
  kind: Kind
  id: string // the tool call's id ('' for text and thinking)
  tool: string
  field: string
  json: string
  target: string
  path: string
  scan: Scan // the code field (code) or the label's field (line), read as the JSON arrives
  pathScan: Scan
  descScan: Scan // a command's description, for its header
  desc: string
  shown: number
  last: number
  born: number
  complete: boolean
  landed: boolean // its step ended: the transcript shows it now
  doneAt: number
  // Fullscreen, a main reply: the transcript row it types in ('' = the band types it). The finished message
  // lands right under that row and takes over (`handed`) at the tick after `handTick`: from that tick on the
  // row draws nothing (`cleared` once it has) and the message draws the text, so the two never both show it.
  row: string
  handed: boolean
  handTick: number
  cleared: boolean
  gone: boolean // no message took over (an error, an interrupt, typing switched off): the row draws nothing
  offScreen: boolean // the row is scrolled out of view: the band shows the reply meanwhile
}
type Run = { tool: string; label: string; started: number; ended: number; isError: boolean; tail: string[]; tailMore: number }
// A reply text block as it streamed. `typed`/`landedAt`: how far the band had typed it when its step
// ended and the transcript took it over, so the transcript can go on typing from there (live mode).
// `block`: the band's block for it (main conversation, typing on or demo).
type Live = { raw: string; complete: boolean; typed: number; landedAt: number; block?: Block }
// `block`: a reply that typed in its own transcript row; the message goes on from where the row got to.
type Anim = { shown: number; last: number; born: number; live: Live; finished: boolean; block?: Block }
type Timer = ReturnType<EngineInterface['clock']['every']>

// What one loop is doing: the main conversation's, or one helper agent's.
type Feed = {
  agentId: string // '' for the main conversation
  queue: Block[] // blocks in the order they stream; its band types the first
  runs: Map<string, Run> // tool calls running or just finished, by tool_use_id
  turnDone: boolean // the turn has ended: whatever is left types out quickly
  lastBand: Band | null // what its band drew last (kept dim between steps)
  lastBandKey: string
  active: number // when it last streamed or ran something
  noticeUntil: number // with agents brief, its name row shows until then (it started, finished, or was just folded)
  note: string // why: 'started', 'finished ✓', or '' (the row says what it is doing)
}
const newFeed = (agentId: string): Feed => ({ agentId, queue: [], runs: new Map(), turnDone: false, lastBand: null, lastBandKey: '', active: 0, noticeUntil: 0, note: '' })
const AGENT_DIM_MS = 90000 // an agent's last view stays (dim) between its steps at most this long
const NOTICE_MS = 4000 // with agents brief, an agent's name row shows this long, then slides away

// Module state: starts over on a reload, which only costs what is showing at that moment.
const main = newFeed('')
const agentFeeds = new Map<string, Feed>()
const agentNames = new Map<string, string>() // agent id -> "type · task", from $.agent.list()
const agentTasks = new Map<string, string>() // agent id -> the task its Agent call named
const TASK_CHARS = 60
const lives: Live[] = [] // reply text blocks of recent steps (the transcript handover matches against them)
const anims = new Map<string, Anim>() // replies the transcript is typing out, per transcript message
let pace: Pace = PACES.live // the main conversation's pace; agents always type at the live pace
let restMode: 'on' | 'off' = 'on' // the remembered choice: what a demo goes back to
let demoUsed = false // a model turn ran in demo mode
let revertDemo = false // that turn ended: back to the remembered choice once the band is idle
let bandHeight = 0 // rows the band takes now
let lastShrinkAt = 0
let easing = false // the band is still opening or closing: keep frames coming
let drawnAt = 0 // when the band last drew itself
let shownAgent = '' // the agent the main view shows now
let snapHeight = false // the band's reply text just moved into the transcript: give its rows back at once
let timer: Timer | null = null
let framing = false
// Fullscreen (learned from this mod's own terminal drawings: the layout is fixed for a session). There the
// transcript is a scroller above a bottom slot (spinner, band, prompt), so a reply typed in the band would
// jump up into the transcript when it lands; it types in a transcript row of its own instead.
let fullscreen = false
const rowBlocks = new Map<string, Block>() // transcript row id -> the reply typing in it
const openRows = new Set<Block>() // rows still showing their reply (no message took over yet)
let rowCount = 0
let rowsChanged = false // a row stopped drawing: redraw once more
let mainDoneAt = 0 // when the main turn last ended
const ORPHAN_MS = 2500 // a row no message took over this long after its turn ended draws nothing again
const isRow = (b: Block) => b.kind === 'text' && b.row !== '' && !b.gone // a reply typing in its own row
// ...which the band leaves alone: on screen, or its message has taken over (demo keeps it queued till read)
const inRow = (b: Block) => isRow(b) && (b.handed || !b.offScreen)
const isBlank = (s: string) => !/\S/.test(s) // a text block of blank lines alone: the engine shows no message for it
const flat = (s: string) => s.replace(/\r/g, '').trimStart()

// A new turn: rows of the turn that ended that no message took over (an error, an interrupt) go now.
function dropOrphans($: EngineInterface) {
  if (!main.turnDone || openRows.size === 0) return
  for (const b of openRows) b.gone = true
  openRows.clear()
  rowsChanged = true
  startTimer($)
}

// Moves the band's height a step toward `want`: open fast, close with an ease-out (at most 2 rows a draw).
function easeToward(now: number, want: number) {
  if (want > bandHeight) {
    bandHeight = Math.min(want, bandHeight + GROW_ROWS)
    lastShrinkAt = now
    return
  }
  if (want < bandHeight) {
    const steps = Math.min(2, Math.floor((now - lastShrinkAt) / shrinkEvery(bandHeight - want)))
    if (steps > 0) {
      bandHeight = Math.max(want, bandHeight - steps)
      lastShrinkAt = now
    }
  }
}

function advance(shown: number, want: number, dtMs: number, cps: number, catchup: number, maxCps: number): number {
  if (shown >= want) return want
  const rate = Math.min(maxCps, Math.max(cps, (want - shown) / catchup))
  return Math.min(want, shown + Math.max(1, Math.round((rate * Math.min(dtMs, 100)) / 1000)))
}

function readMs(text: string) {
  const words = text.trim().split(/\s+/).length
  return Math.min(READ_MAX_MS, Math.max(READ_MIN_MS, 1000 + (words / READ_WPS) * 1000))
}

// Reads one string field out of a tool's arguments while their JSON is still arriving. The scan keeps
// where it got to, so each new piece costs only its own length (re-reading from the start each piece
// was quadratic: seconds of hook time on a 100 KB Write, out of the step's 10 s budget).
type Scan = { from: number; at: number; out: string; done: boolean }
const newScan = (): Scan => ({ from: 0, at: -1, out: '', done: false })
// \b, \f, \r and control characters given as \uXXXX are dropped: the band may draw none (see `clean`).
const ESC: Record<string, string> = { n: '\n', t: '\t', r: '', b: '', f: '', '"': '"', '\\': '\\', '/': '/' }

function scanField(json: string, key: string, s: Scan, max = Infinity): string | null {
  if (s.at < 0) {
    const re = new RegExp('"' + key + '"\\s*:\\s*"', 'g')
    re.lastIndex = s.from
    const m = re.exec(json)
    if (!m) {
      s.from = Math.max(0, json.length - key.length - 16) // a key cut off at the end is found next time
      return null
    }
    s.at = m.index + m[0].length
  }
  let i = s.at
  while (!s.done && i < json.length) {
    if (s.out.length >= max) s.done = true
    const c = json[i]!
    if (s.done || c === '"') {
      s.done = true
      break
    }
    if (c === '\\') {
      if (i + 1 >= json.length) break
      const n = json[i + 1]!
      if (n === 'u') {
        if (i + 6 > json.length) break
        const code = parseInt(json.slice(i + 2, i + 6), 16)
        if (drawable(code)) s.out += String.fromCharCode(code)
        i += 6
        continue
      }
      s.out += ESC[n] ?? n
      i += 2
      continue
    }
    if (drawable(c.charCodeAt(0))) s.out += c
    i++
  }
  s.at = i
  return s.out
}

// The engine refuses (skips) a band whose Text or Code holds a control character other than tab and
// newline. Command output carries escape sequences (colours, links, window titles, cursor moves), and
// tool input or a reply can carry other control characters, so all outside text goes through here.
const ESCAPES = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -\/]*[@-~]?|\x1b[ -\/]*[0-~]?|\x9b[0-?]*[ -\/]*[@-~]?/g
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const clean = (s: string) => s.replace(ESCAPES, '').replace(CONTROLS, '')
function drawable(code: number) {
  return (code >= 0x20 && code < 0x7f) || code > 0x9f || code === 0x09 || code === 0x0a
}
const oneLine = (s: string, n: number) => clean(s.replace(/\s+/g, ' ')).trim().slice(0, n)
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? ''

function findLive(text: string): Live | undefined {
  const probe = text.trimStart().slice(0, 32)
  if (!probe) return undefined
  for (let i = lives.length - 1; i >= 0; i--) {
    const live = lives[i]!
    if (live.raw.trimStart().startsWith(probe)) return live
  }
  return undefined
}

// Cells a character takes in a terminal: 2 for East Asian wide and fullwidth characters and most emoji, else 1.
function cellsOf(cp: number) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) || (cp >= 0x1f900 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x231a && cp <= 0x2b55 && WIDE_SYMBOLS.has(cp))
    ? 2
    : 1
}
// Emoji among the older symbol blocks that terminals draw 2 cells wide: ✅ ❌ ✨ ⚡ ⭐ ⌛ ⏳ ❓ ❗ ➕ ...
const WIDE_SYMBOLS = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653,
  0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
])
const hasWide = (s: string) => [...s].some((ch) => cellsOf(ch.codePointAt(0)!) === 2)
// The code point that ends just before `i`.
const cpBefore = (s: string, i: number) => {
  const c = s.charCodeAt(i - 1)
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? s.codePointAt(i - 2)! : c
}
// `n` moved back off the middle of an emoji (a surrogate pair), so a cut never shows half of one.
const whole = (s: string, n: number) => {
  const c = s.charCodeAt(n - 1)
  return n > 0 && n < s.length && c >= 0xd800 && c <= 0xdbff ? n - 1 : n
}

// How far a block may be typed now: text stops at a word's end until the block is complete,
// so a half-typed word never sits at a row's end and then hops to the next row. A run with no space
// in it (Chinese, Japanese, Thai, a long URL) is laid out per character, so it types as it arrives.
const WORD_MAX = 24
function wantOf(b: Block) {
  const t = b.target
  if (b.complete || (b.kind !== 'text' && b.kind !== 'think')) return t.length
  let i = t.length
  while (i > 0 && t.length - i <= WORD_MAX && !/\s/.test(t[i - 1]!)) i--
  return t.length - i > WORD_MAX || hasWide(t.slice(i)) ? t.length : i
}

function typingOf(b: Block) {
  return b.shown < b.target.length || !b.complete
}

// Markdown marks the band does not draw (the transcript renders them; the band shows plain text).
const stripMarks = (s: string) =>
  s
    .replace(/^```.*$\n?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\*\*|`/g, '')

function runRow(r: Run, now: number): RunRow {
  return {
    tool: r.tool,
    label: r.label,
    secs: Math.floor(((r.ended || now) - r.started) / 1000),
    running: !r.ended,
    isError: r.isError,
  }
}

function feedOf(agentId: string | undefined): Feed {
  if (!agentId) return main
  let f = agentFeeds.get(agentId)
  if (!f) {
    f = newFeed(agentId)
    agentFeeds.set(agentId, f)
  }
  return f
}

const paceOf = (f: Feed) => (f === main ? pace : PACES.live)

// An agent's name for the band's header: its type and task ("code-reviewer · Check the login flow").
async function learnName($: EngineInterface, agentId: string) {
  if (agentNames.get(agentId)) return
  try {
    for (const a of await $.agent.list()) {
      const type = a.type && a.type !== 'general-purpose' && a.type !== 'teammate' ? oneLine(a.type, TASK_CHARS) : ''
      const task = oneLine(a.description ?? '', TASK_CHARS)
      const label = [type, task].filter(Boolean).join(' · ')
      if (label) agentNames.set(a.id, label)
      if (task) agentTasks.set(a.id, task)
    }
  } catch {
    // no list: the header says "agent"
  }
}

function blockView(f: Feed, b: Block, now: number): BlockView {
  const typing = typingOf(b)
  const caret = typing ? CARET : ''
  if (b.kind === 'text' || b.kind === 'think') {
    const full = stripMarks(b.target)
    const shown = Math.min(full.length, stripMarks(b.target.slice(0, b.shown)).length)
    const start = Math.max(0, full.length - KEEP_CHARS)
    return { kind: b.kind, tool: '', path: '', label: '', totalLines: 0, source: full.slice(start), shown: Math.max(0, shown - start), startLine: 0, typing, run: null }
  }
  const run = b.id ? f.runs.get(b.id) : undefined
  const typed = b.target.slice(0, whole(b.target, b.shown))
  const path = b.pathScan.done ? b.path : '' // a half-arrived path would show as a wrong name
  if (b.kind === 'code') {
    const lines = typed.split('\n')
    const tail = lines.slice(-KEEP_LINES)
    const numbered = b.tool === 'Write'
    return {
      kind: 'code',
      tool: b.tool,
      path,
      label: b.tool in CODE_LANGS ? oneLine(b.desc, 120) : baseName(path),
      totalLines: lines.length,
      source: tail.join('\n') + caret,
      shown: 0,
      startLine: numbered ? lines.length - tail.length + 1 : 0,
      typing,
      run: run ? runRow(run, now) : null,
    }
  }
  return { kind: 'line', tool: b.tool, path, label: '', totalLines: 0, source: typed + caret, shown: 0, startLine: 0, typing, run: null }
}

// Greedy word wrap of `text` into rows of at most `width` cells, as [start, end) offsets into it.
// Wide characters (Chinese, Japanese, Korean, emoji) take 2 cells, and a row may break between them.
function layoutRows(text: string, width: number): { start: number; end: number }[] {
  const rows: { start: number; end: number }[] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    let at = 0
    for (;;) {
      let end = at // the furthest end whose characters fit in `width` cells
      let cells = 0
      while (end < line.length) {
        const cp = line.codePointAt(end)!
        if (cells + cellsOf(cp) > width) break
        cells += cellsOf(cp)
        end += cp > 0xffff ? 2 : 1
      }
      if (end >= line.length) break
      if (end === at) end += line.codePointAt(at)! > 0xffff ? 2 : 1 // narrower than one character
      const br = line.lastIndexOf(' ', end)
      const wideEdge = cellsOf(line.codePointAt(end)!) === 2 || cellsOf(cpBefore(line, end)) === 2
      if (br > at && !wideEdge) {
        rows.push({ start: lineStart + at, end: lineStart + br })
        at = br + 1
      } else {
        rows.push({ start: lineStart + at, end: lineStart + end })
        at = end
      }
    }
    rows.push({ start: lineStart + at, end: lineStart + line.length })
    lineStart += line.length + 1
  }
  return rows
}

// The rows of `text` typed so far: laid out on the whole text, so a word being typed keeps its row.
// Blank rows at the top are dropped, so a bullet never stands alone.
function typedRows(text: string, shown: number, width: number): string[] {
  shown = whole(text, shown)
  const rows = layoutRows(text, width)
    .filter((r, i) => i === 0 || r.start < shown)
    .map((r) => text.slice(r.start, Math.min(r.end, shown)))
  while (rows.length > 1 && rows[0]!.trim() === '') rows.shift()
  return rows
}

// The first row with words in it (0 when none has).
const firstWords = (rows: string[]) => Math.max(0, rows.findIndex((r) => r.trim() !== ''))

function startTimer($: EngineInterface) {
  if (timer) return
  timer = $.clock.every(FRAME_MS, () => {
    if (!framing) void frame($)
  })
}

// Types a feed's first block on and says what its band shows now (null: nothing).
function stepFeed(f: Feed, now: number): Band | null {
  const p = paceOf(f)
  const isMain = f === main
  const queue = f.queue
  while (queue.length > 0) {
    const head = queue[0]!
    // main, live: a block whose step has ended is in the transcript already; don't type it twice.
    // (An agent's text is not in the main transcript, so its band types it out whole.) A reply typing in its
    // own row goes as soon as its message took over: the message types the rest.
    const handedOver = head.handed && isRow(head)
    if (isMain && (head.landed || handedOver) && !p.read && (head.kind === 'text' || head.kind === 'think')) {
      if (head.kind === 'text' && !inRow(head)) {
        // The transcript now holds this text (and types the rest in place): the band hands its rows
        // over in the same instant, so nothing jumps, and keeps no dim copy of it.
        snapHeight = true
        if (f.lastBand?.block?.kind === 'text') {
          f.lastBand = null
          f.lastBandKey = ''
        }
      }
      queue.shift()
      continue
    }
    // a tool call's one-line block gives way to its run row once the tool runs
    if (head.kind === 'line' && head.id && f.runs.has(head.id) && !typingOf(head)) {
      queue.shift()
      continue
    }
    const hurry = !p.read && (queue.length > 1 || f.turnDone)
    head.shown = advance(head.shown, wantOf(head), now - head.last, p.cps, hurry ? p.queued : p.catchup, p.maxCps)
    head.last = now
    if (typingOf(head)) break
    if (!head.doneAt) head.doneAt = now
    const own = head.id ? f.runs.get(head.id) : undefined
    if (own && !own.ended) break // a card stays while its own tool runs
    if (own && own.ended && now - own.ended < p.result && queue.length === 1) break // ...and then shows its output
    if (now - head.doneAt < holdOf(f, head, queue.length > 1)) break
    queue.shift()
    if (queue[0]) queue[0].last = now
  }
  // forget finished tools after a while
  for (const [id, r] of f.runs) if (r.ended && now - r.ended > p.result) f.runs.delete(id)

  const head = queue[0]
  // fullscreen: the reply types in its own transcript row, so the band shows nothing for it (and closes)
  if (isMain && head && inRow(head)) return { block: null, rows: [], tail: [], tailMore: 0, blink: false, idle: false, inflow: true }
  const block = head ? blockView(f, head, now) : null
  const ownId = head?.kind === 'code' ? head.id : ''
  const list = [...f.runs.entries()].filter(([id]) => id !== ownId).map(([, r]) => r)
  const rows = list.slice(-3).map((r) => runRow(r, now))
  const lastDone = [...list].reverse().find((r) => r.ended && r.tail.length > 0)
  const ownRun = ownId ? f.runs.get(ownId) : undefined
  const outOf = ownRun ? (ownRun.ended ? ownRun : null) : lastDone ?? null
  const tail = outOf ? outOf.tail : []
  const tailMore = outOf ? outOf.tailMore : 0
  const blink = Math.floor(now / BLINK_MS) % 2 === 0
  const named = !isMain && now < f.noticeUntil
  const task = isMain ? undefined : agentTasks.get(f.agentId)
  const whose = isMain
    ? {}
    : { who: agentNames.get(f.agentId) || 'agent', ...(task ? { task } : {}), at: f.active, named, ...(named && f.note ? { note: f.note } : {}) }

  if (block || rows.length > 0) return { block, rows, tail, tailMore, blink, idle: false, ...whose }
  // between steps: keep the last view, dimmed, so nothing jumps (an agent's only for a while)
  if (!f.turnDone && f.lastBand && (isMain || now - f.active < AGENT_DIM_MS)) {
    const { note: _then, ...last } = f.lastBand // the note it had then ("finished ✓") is not today's
    return { ...last, idle: true, ...whose }
  }
  // agents brief, one that just started or finished: its name row, for a few seconds
  if (named) return { block: null, rows: [], tail: [], tailMore: 0, blink, idle: true, ...whose }
  return null
}

// Folding agents to brief: the ones showing now keep their name row for a few seconds, then slide away.
async function nameAgentsBriefly($: EngineInterface) {
  const until = (await $.clock.now()) + NOTICE_MS
  for (const f of agentFeeds.values()) {
    f.noticeUntil = until
    f.note = ''
  }
  await update($, agentBands, (all) => Object.fromEntries(Object.entries(all ?? {}).map(([id, x]) => [id, { ...x, named: true }])))
  startTimer($)
}

// Remembers what a feed's band showed; true when that changed.
function keep(f: Feed, next: Band | null) {
  const key = JSON.stringify(next)
  if (key === f.lastBandKey) return false
  f.lastBandKey = key
  if (next && !next.idle) f.lastBand = next
  if (!next) f.lastBand = null
  return true
}

const isEmpty = (f: Feed) => f.queue.length === 0 && f.runs.size === 0

async function frame($: EngineInterface) {
  framing = true
  try {
    const now = await $.clock.now()
    const mainNext = stepFeed(main, now)
    if (keep(main, mainNext)) await update($, band, () => mainNext)

    let agentsChanged = false
    const agentsNow: Record<string, Band> = {}
    for (const [id, f] of agentFeeds) {
      const next = stepFeed(f, now)
      if (keep(f, next)) agentsChanged = true
      if (next) agentsNow[id] = next
      else if (isEmpty(f) && now >= f.noticeUntil && (f.turnDone || now - f.active > AGENT_DIM_MS)) agentFeeds.delete(id) // done: forget it
    }
    if (agentsChanged) await update($, agentBands, () => agentsNow)

    // the transcript reply still typing, and the band while it opens or closes, redraw on every frame
    for (const a of anims.values()) if (!a.finished && now - a.born > GIVE_UP_MS) a.finished = true
    const handing = [...anims.values()].some((a) => !a.finished)
    // a band that is no longer drawn (collapsed with [-], a screen without the prompt) eases no more;
    // drawn again, it starts the timer itself
    const eases = easing && now - drawnAt < 1000
    // a reply typing in its own transcript row redraws on every frame; a row no message took over (an error,
    // an interrupt) lets its text go a little after its turn ended, as the engine dropped it
    for (const b of openRows) {
      if (b.handed || b.gone) {
        openRows.delete(b)
      } else if (b.complete && isBlank(b.target)) {
        b.gone = true // blank lines alone: no message will come for it, and its row draws nothing
        openRows.delete(b)
      } else if (main.turnDone && now - mainDoneAt > ORPHAN_MS) {
        b.gone = true
        openRows.delete(b)
        rowsChanged = true
      }
    }
    const rowsTyping = openRows.size > 0
    if (handing || eases || rowsTyping || rowsChanged) {
      rowsChanged = false
      await update($, tick, (n) => n + 1)
    }

    const idle = isEmpty(main) && [...agentFeeds.values()].every((f) => isEmpty(f) && now >= f.noticeUntil) // a name row still has to slide away
    if (isEmpty(main) && revertDemo) { // demo is the main conversation's alone: helpers still at work don't hold it
      revertDemo = false
      demoUsed = false
      pace = PACES.live
      await update($, mode, () => restMode)
    }
    if (idle && !handing && !eases && !rowsTyping) {
      timer?.cancel()
      timer = null
    }
  } catch {
    // a missed frame is fine
  } finally {
    framing = false
  }
}

// How long a finished block stays before the next one (or nothing) takes its place.
function holdOf(f: Feed, b: Block, hasNext: boolean) {
  const p = paceOf(f)
  if (b.kind === 'text' && p.read) return readMs(b.target)
  if (hasNext) return p.gap
  return f.turnDone && !p.read ? Math.min(p.hold[b.kind], 400) : p.hold[b.kind]
}

// demo: a tool may run once everything written before it has been typed and the text had time to be read.
function mustWait() {
  if (!pace.read) return false
  const head = main.queue[0]
  if (!head) return false
  if (head.kind === 'text' || head.kind === 'think') return true
  return main.queue.some(typingOf)
}

// The last lines of a command's output, as a terminal would show them.
function outputTail(result: unknown): { tail: string[]; tailMore: number } {
  if (!result || typeof result !== 'object') return { tail: [], tailMore: 0 }
  const r = result as Record<string, unknown>
  const text = [r.stdout, r.stderr].filter((s): s is string => typeof s === 'string' && s.trim() !== '').join('\n')
  const lines = text
    .replace(ESCAPES, '') // colours, links, window titles, cursor moves
    .split('\n')
    .map((l) => clean((l.split('\r').filter((p) => p !== '').pop() ?? '').replace(/\t/g, '  '))) // a progress line keeps its last state
    .filter((l) => l.trim() !== '')
  const tail = lines.slice(-TAIL_LINES).map((l) => l.slice(0, 300))
  return { tail, tailMore: lines.length - tail.length }
}

// "3s", "1m 05s"; nothing under a second.
function fmtSecs(s: number) {
  if (s < 1) return ''
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

async function clearAll($: EngineInterface) {
  for (const f of [main, ...agentFeeds.values()]) {
    f.queue.length = 0
    f.runs.clear()
    f.lastBand = null
    f.lastBandKey = ''
  }
  agentFeeds.clear()
  for (const b of openRows) b.gone = true // a reply typing in its own row: its message shows it whole
  openRows.clear()
  for (const a of anims.values()) a.finished = true
  await update($, band, () => null)
  await update($, agentBands, () => ({}))
  await update($, tick, (n) => n + 1)
}

const isBandMode = (m: Mode) => m !== 'off'

// A transcript row at the conversation's end for a reply to type in (fullscreen). Where none can be placed
// (no surface draws rows, too many rows), the band types the reply as before.
async function placeRow($: EngineInterface, b: Block) {
  try {
    const id = `reply-${Math.floor(b.born)}-${++rowCount}` // unique across reloads: an old id answers its old row
    const r = await $.ui.place({ id })
    if (!r.isPlaced) return
    b.row = id
    rowBlocks.set(id, b)
    openRows.add(b)
    if (rowBlocks.size > 200) rowBlocks.delete(rowBlocks.keys().next().value!) // long handed over
  } catch {
    // the band types it
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    // Also runs on a reload, which starts this module's state over: drop a band the old code left mid-typing.
    await update($, band, () => null)
    await update($, agentBands, () => ({}))
    // How agents show in the main view: the choice from an earlier session (an older version's `name` is
    // `brief` now), else off.
    let savedAgents: unknown
    try {
      savedAgents = await $.store.get(AGENTS_STORE_KEY)
    } catch {
      // nothing saved
    }
    const shows = wordOf(AGENTS_WORDS, savedAgents)
    await update($, agentsMain, () => shows ?? 'off')
    if (savedAgents === 'name') await setAgentsMain($, 'brief')
    // Typing: on or off as last chosen (on for anyone who never chose); a demo still running across a
    // reload stays. An older version kept `live` in this session's state: that is `on`.
    let savedTyping: unknown
    try {
      savedTyping = await $.store.get(TYPING_STORE_KEY)
    } catch {
      // nothing saved
    }
    const m = await read($, mode)
    restMode = savedTyping === 'on' || savedTyping === 'off' ? savedTyping : m === 'off' ? 'off' : 'on'
    const now: Mode = m === 'demo' ? 'demo' : restMode
    if (now !== m) await update($, mode, () => now)
    pace = now === 'demo' ? PACES.demo : PACES.live
    demoUsed = now === 'demo' // a reload mid-demo (module variables start over): the demo still ends after this reply
    await $.command.register({
      name: 'live-typing',
      description: 'Live typing above the prompt: no argument opens the settings picker',
      argumentHint: '[on|off|demo] or [agents full|brief|off]',
      immediate: true, // switching off (or on) works in the middle of a long reply too
    })
    return next(e)
  })

  // A new prompt: a new turn begins; with nothing typing or running, clear whatever the band still shows.
  on('prompt.submit', async ($, e, next) => {
    try {
      dropOrphans($)
    } catch {
      // never block the prompt
    }
    main.turnDone = false
    try {
      if (isEmpty(main)) {
        main.lastBand = null
        main.lastBandKey = ''
        await update($, band, () => null)
      }
    } catch {
      // never block the prompt
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      // a helper agent's turn: its own band (never the main turn's band or demo)
      try {
        if (!isBandMode(await read($, mode))) return next(e) // off: no agent bands, no name rows
        const isNew = !agentFeeds.has(e.agentId)
        const f = feedOf(e.agentId)
        f.turnDone = false
        f.active = await $.clock.now()
        if (isNew) {
          f.note = 'started' // with agents brief, its name still shows for a moment
          f.noticeUntil = f.active + NOTICE_MS
          startTimer($) // now, not only once its first chunk streams in (that can be past the 4 s)
        } else if (f.note === 'finished ✓') {
          f.note = '' // woken again (SendMessage, a teammate's next message): no longer finished
          f.noticeUntil = 0
        }
        await learnName($, e.agentId)
      } catch {
        // its band just says "agent"
      }
      return next(e)
    }
    try {
      dropOrphans($) // a turn started without a prompt (a continuation) ends the last turn's orphans too
    } catch {
      // they go 2.5 s after this turn instead
    }
    main.turnDone = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      // a helper agent ending must not end the main turn's band or demo: only its own band finishes
      const f = agentFeeds.get(e.agentId)
      if (f) {
        f.turnDone = true
        for (const b of f.queue) {
          b.complete = true
          b.landed = true
        }
        try {
          f.note = 'finished ✓' // with agents brief, its name shows for a moment once more
          f.noticeUntil = (await $.clock.now()) + NOTICE_MS
          startTimer($)
        } catch {
          // nothing to finish
        }
      }
      return next(e)
    }
    main.turnDone = true // the reply is in the transcript now: finish the band
    for (const b of main.queue) {
      b.complete = true // a step hook left mid-stream never reached its finally
      b.landed = true
    }
    if (demoUsed) revertDemo = true // back to live once the band has finished showing the demo
    try {
      mainDoneAt = await $.clock.now()
      startTimer($) // the frame clears the band (and reverts the demo) once it is idle
    } catch {
      // nothing to finish
    }
    return next(e)
  })

  // `/live-typing` opens the picker; `/live-typing on | off | demo` and `/live-typing agents full | brief | off`
  // switch directly. Anything else answers with one line of usage.
  on('command.run', { command: 'live-typing' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const first = words[0] ?? '' // "demo please" counts as "demo"
    const unknown = (w: string) => ({ text: `Unknown option "${oneLine(w, 24)}". ${USAGE}` })
    if (first === 'agents' || first === 'agent') {
      const want = words[1] ?? ''
      if (!want) return openPicker($, 'agents')
      const v = wordOf(AGENTS_WORDS, want)
      if (!v) return unknown(want)
      await setAgentsMain($, v)
      return { text: `Agents in the main view: ${v} (${whatOf(AGENTS_OPTIONS, v)}).` }
    }
    if (!first) return openPicker($, 'typing')
    const chosen = wordOf(TYPING_WORDS, first)
    if (!chosen) return unknown(first)
    await setTyping($, chosen)
    const then = chosen === 'demo' ? `, then back to ${restMode}` : ''
    return { text: `Live typing: ${chosen} (${whatOf(TYPING_OPTIONS, chosen)})${then}.` }
  })

  // The picker. Two settings, each a short list; the arrows walk the options, Enter picks one (the picker
  // stays open, its ✔ moves), Esc closes it. The option the keyboard is on gets the ❯ and its words in full color.
  on('ui.focus', { component: 'Pane', requestId: PICKER }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!r?.deny) await update($, pickerFocus, () => e.element ?? '')
    } catch {
      // the pointer stays where it was; the ring itself moved
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PICKER }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const typing = await read($, mode)
    const shows = await read($, agentsMain)
    const focus = e.props.isFocused ? await read($, pickerFocus) : ''
    const start = await read($, pickerStart)
    const option = (group: PickerGroup, value: string, label: string, what: string, current: boolean, pick: () => Promise<void>) => {
      const key = `${group}:${value}`
      const pointed = focus === key
      const focusFirst = group === start && current ? { autoFocus: true as const } : {}
      return (
        <Box key={`row:${key}`} flexDirection="row">
          <Text color="suggestion">{pointed ? '❯ ' : '  '}</Text>
          <Box width={LABEL_CELLS} flexShrink={0}>
            {current ? (
              <Button key={key} plain {...focusFirst} onPress={pick}>
                {label}
                <Text color="success"> ✔</Text>
              </Button>
            ) : (
              <Button key={key} plain {...focusFirst} onPress={pick}>
                {label}
              </Button>
            )}
          </Box>
          <Box flexShrink={1}>
            <Text dimColor={!pointed} wrap="truncate-end">
              {what}
            </Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text weight="bold">Live typing</Text>
        <Box height={1} />
        <Text>Typing</Text>
        {TYPING_OPTIONS.map((o) => option('typing', o.value, o.label, o.what, typing === o.value, () => setTyping($, o.value)))}
        <Box height={1} />
        <Text>Agents in the main view</Text>
        {AGENTS_OPTIONS.map((o) => option('agents', o.value, o.label, o.what, shows === o.value, () => setAgentsMain($, o.value)))}
        <Box height={1} />
        <Text dimColor wrap="truncate-end">
          ↑↓ move · Enter choose · Esc close
        </Text>
      </Box>
    )
  })

  // Watch the model's response as it streams; every chunk is passed on untouched.
  // A helper agent's step goes to that agent's own band, at the live pace (also in demo).
  on('turn.step', async function* ($, e, next) {
    let m: Mode = 'on'
    try {
      m = await read($, mode)
      if (e.agentId && isBandMode(m)) await learnName($, e.agentId)
    } catch {
      // watch as live
    }
    if (e.agentId && !isBandMode(m)) {
      yield* next(e)
      return
    }
    const f = feedOf(e.agentId)
    const isMain = f === main
    const isLive = isBandMode(m)
    if (isMain && m === 'demo') demoUsed = true
    const texts = new Map<number, Live>()
    const blocks = new Map<number, Block>()
    let lastIndex = -1
    const closeOthers = (index: number) => {
      for (const [i, t] of texts) if (i !== index) t.complete = true
      for (const [i, b] of blocks) if (i !== index) b.complete = true
    }
    const open = async (index: number, kind: Kind, tool: string, field: string, id: string) => {
      const now = await $.clock.now()
      const b: Block = {
        kind,
        id,
        tool,
        field,
        json: '',
        target: '',
        path: '',
        scan: newScan(),
        pathScan: newScan(),
        descScan: newScan(),
        desc: '',
        shown: 0,
        last: now,
        born: now,
        complete: false,
        landed: false,
        doneAt: 0,
        row: '',
        handed: false,
        handTick: 0,
        cleared: false,
        gone: false,
        offScreen: false,
      }
      blocks.set(index, b)
      // fullscreen: a main reply types in a row of its own at the transcript's end, where its message will
      // land. Placed before its first chunk goes on, so the row stands above the message.
      if (isMain && kind === 'text' && fullscreen) await placeRow($, b)
      f.queue.push(b)
      f.active = now
      startTimer($)
      return b
    }
    try {
      for await (const c of next(e)) {
        try {
          if (c.kind === 'text' || c.kind === 'thinking' || c.kind === 'tool' || c.kind === 'input') {
            if (c.index !== lastIndex) {
              closeOthers(c.index)
              lastIndex = c.index
            }
          }
          if (c.kind === 'text') {
            let t = texts.get(c.index)
            if (!t) {
              t = { raw: '', complete: false, typed: 0, landedAt: 0 }
              texts.set(c.index, t)
              if (isMain) {
                lives.push(t) // only the main reply is handed over to the transcript
                if (lives.length > 40) lives.shift()
              }
            }
            t.raw += c.text
            if (isLive) {
              const b = blocks.get(c.index) ?? (await open(c.index, 'text', '', '', ''))
              b.target += clean(c.text)
              if (isMain) t.block = b
            }
          } else if (c.kind === 'thinking') {
            if (isLive && c.text) {
              const b = blocks.get(c.index) ?? (await open(c.index, 'think', '', '', ''))
              b.target += clean(c.text)
            }
          } else if (c.kind === 'tool' && isLive) {
            const field = CODE_FIELDS[c.name]
            await open(c.index, field ? 'code' : 'line', c.name, field ?? '', c.id)
          } else if (c.kind === 'input') {
            const b = blocks.get(c.index)
            if (b && !b.complete) {
              b.json += c.json
              if (b.kind === 'code') {
                b.target = scanField(b.json, b.field, b.scan) ?? ''
              } else if (!b.scan.done) {
                for (const key of LINE_FIELDS) {
                  const s = newScan()
                  const v = scanField(b.json, key, s, 200)
                  if (v !== null) {
                    b.target = oneLine(v, 160)
                    b.scan = s // once its field closes, the label is final
                    break
                  }
                }
              }
              if (!(b.tool in CODE_LANGS) && !b.pathScan.done) {
                b.path = scanField(b.json, b.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path', b.pathScan, 1000) ?? b.path
              }
              if (b.tool in CODE_LANGS && !b.descScan.done) {
                b.desc = scanField(b.json, 'description', b.descScan, 200) ?? b.desc
              }
            }
          } else if (c.kind === 'stop') {
            closeOthers(-1)
          }
        } catch {
          // watching must never break the reply
        }
        yield c
      }
    } finally {
      let landedAt = 1
      try {
        landedAt = await $.clock.now()
      } catch {
        // no clock: the transcript still continues the text, just without the recency check's precision
      }
      for (const [i, t] of texts) {
        t.complete = true
        t.typed = blocks.get(i)?.shown ?? 0
        t.landedAt = landedAt
      }
      for (const b of blocks.values()) {
        b.complete = true
        b.landed = true
      }
    }
  })

  // Each tool: (demo) wait until what came before it could be read, then a blinking marker + timer
  // while it runs, then the last lines of its output.
  on('tool.call', async ($, e, next) => {
    let run: Run | null = null
    let f = main
    try {
      const m = await read($, mode)
      if (isBandMode(m)) {
        f = feedOf(e.agentId) // (off: no feed, so nothing of an agent's is kept or shown)
        // demo makes only the main conversation's tools wait; an agent never waits for the band
        while (f === main && mustWait() && next.budget.remainingMs > TOOL_WAIT_SPARE_MS) {
          await $.clock.sleep(100, { signal: next.signal })
        }
        const input = e as unknown as Record<string, unknown>
        let label = ''
        for (const key of RUN_LABEL_FIELDS) {
          const v = input[key]
          if (typeof v === 'string' && v.trim()) {
            label = key === 'file_path' || key === 'notebook_path' ? oneLine(baseName(v), 120) : oneLine(v, 120)
            break
          }
        }
        run = { tool: e.tool, label, started: await $.clock.now(), ended: 0, isError: false, tail: [], tailMore: 0 }
        f.runs.set(e.tool_use_id, run)
        f.active = run.started
        startTimer($)
      }
    } catch {
      // an interrupted wait or anything else here: just run the tool
    }
    let res: Awaited<ReturnType<typeof next>>
    try {
      res = await next(e)
    } catch (err) {
      if (run) {
        run.isError = true
        run.ended = run.started + 1 // shown as failed, then forgotten
      }
      throw err
    }
    if (run) {
      try {
        run.isError = 'deny' in res && typeof res.deny === 'string' ? true : !!res.isError
        const out = 'result' in res ? outputTail(res.result) : { tail: [], tailMore: 0 }
        run.tail = out.tail
        run.tailMore = out.tailMore
        run.ended = await $.clock.now()
        f.active = run.ended
        startTimer($)
      } catch {
        f.runs.delete(e.tool_use_id)
      }
    }
    return res
  })

  // The handover (on, not demo): the reply that just left the band keeps typing in the transcript from where
  // the band had got to, so the transcript grows smoothly instead of the whole message appearing at once.
  // Fullscreen: the reply typed in its own row just above where this message lands. On the message's first
  // frame it draws nothing (the row still shows the text); from the next frame on, the row draws nothing and
  // the message types on from where the row got to, both redrawn by the same tick, so the text stays put.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    try {
      if (e.surface === 'terminal' && e.viewport) fullscreen = e.viewport.isFullscreen === true
      const p = e.props
      if (p.isSummary || !p.text) return next(e)
      let a = anims.get(e.requestId)
      if (a?.finished) return next(e)
      const m = await read($, mode)
      if (m === 'off') return next(e)
      if (m === 'demo' && a && !a.block) return next(e) // demo: the band types it; the transcript shows it whole
      const now = await $.clock.now()
      if (!a) {
        const live = findLive(p.text)
        if (!live) return next(e) // not a reply from this session's live stream: draw it as is
        const b = live.block
        if (b && isRow(b)) {
          // its own row typed it: this message takes the row's place (on the terminal, once)
          if (e.surface !== 'terminal' || b.handed) return next(e)
          // only the reply's own message, which holds all it streamed: an older message that merely starts
          // the same way (drawn again on a scroll) leaves the row alone
          if (!flat(p.text).startsWith(flat(live.raw).trimEnd())) return next(e)
          b.handed = true
          b.handTick = (await read($, tick)) ?? 0
          openRows.delete(b)
          a = { shown: Math.min(p.text.length, b.shown), last: now, born: now, live, finished: false, block: b }
          anims.set(e.requestId, a)
          if (anims.size > 200) anims.delete(anims.keys().next().value!)
          startTimer($)
          const { Box } = $.ui.resolve(e)
          return <Box flexDirection="column" />
        }
        if (m === 'demo') return next(e)
        if (!live.landedAt || now - live.landedAt > HANDOVER_MS) return next(e) // an older reply
        const start = Math.min(p.text.length, live.typed)
        if (start >= p.text.length) return next(e)
        a = { shown: start, last: now, born: now, live, finished: false }
        anims.set(e.requestId, a)
        if (anims.size > 200) anims.delete(anims.keys().next().value!)
        startTimer($)
      }
      const t = (await read($, tick)) ?? 0 // redraw this message on every frame while it types
      if (a.block && t <= a.block.handTick) {
        // the row above shows the text until the tick moves on; then both change together
        const { Box } = $.ui.resolve(e)
        return <Box flexDirection="column" />
      }
      if (a.block && pace.read) {
        // demo: the reply's block still types at the calm pace (tools wait for it); the message follows it
        a.shown = Math.max(a.shown, Math.min(p.text.length, a.block.shown))
        if (!main.queue.includes(a.block)) a.shown = p.text.length
      } else {
        a.shown = advance(a.shown, p.text.length, now - a.last, PACES.live.cps, PACES.live.catchup, Infinity)
      }
      a.last = now
      if (a.shown >= p.text.length && a.live.complete) {
        a.finished = true
        return next(e)
      }
      return next({ ...e, props: { ...p, text: p.text.slice(0, whole(p.text, a.shown)) + CARET } })
    } catch {
      return next(e)
    }
  })

  // Fullscreen: a reply's own row at the transcript's end. It types the reply as the transcript will draw it
  // (a blank row, the ● bullet, the markdown), so the message that lands under it can take its place unseen.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    try {
      if (e.props.plugin !== 'live-typing' || e.surface !== 'terminal') return next(e)
      const b = rowBlocks.get(e.props.id)
      if (!b || b.cleared || b.gone) return next(e) // done, or from before a reload: nothing
      const t = (await read($, tick)) ?? 0 // redraw on every frame while it types
      if (b.handed && t > b.handTick) {
        b.cleared = true // its message shows the reply now
        return next(e)
      }
      // scrolled out of view, the band shows the reply meanwhile
      const off = e.props.onScreen === null
      if (off !== b.offScreen) {
        b.offScreen = off
        startTimer($)
      }
      if ((await read($, mode)) === 'off') return next(e)
      if (isBlank(b.target)) return next(e) // blank lines alone (so far): no lone ● and caret
      const { Box, Text, Markdown } = $.ui.resolve(e)
      const typed = b.target.slice(0, whole(b.target, b.shown))
      return (
        <Box flexDirection="column">
          <Box height={1} />
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color="text">●</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Markdown text={typed + CARET} />
            </Box>
          </Box>
        </Box>
      )
    } catch {
      return next(e)
    }
  })

  // on / demo: the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.viewport) fullscreen = e.viewport.isFullscreen === true
    // Whose band: the agent whose transcript is open; else Claude's own; while Claude is idle (agents
    // full or brief), or only waiting on helpers it started (full), an agent's, under its name.
    const viewing = e.props.view?.agentId
    let chosen: Band | null = null
    let header = ''
    let folded = false // main view, agents set to `brief`: only the name row
    if ((await read($, mode)) === 'off') {
      // off: nothing (also what a step that was already streaming when it was turned off still sends)
    } else if (viewing) {
      chosen = ((await read($, agentBands)) ?? {})[viewing] ?? null
    } else {
      const own = await read($, band)
      const shows = (await read($, agentsMain)) ?? 'off'
      chosen = own
      const waits = own && shows === 'full' ? waitedOn(own) : null
      if ((!own && shows !== 'off') || waits) {
        const latest = ([, x]: [string, Band], [, y]: [string, Band]) => (y.at ?? 0) - (x.at ?? 0)
        // brief: only an agent whose name row is due (it started, finished, or was just folded)
        const all = Object.entries((await read($, agentBands)) ?? {}).filter(([, x]) => shows === 'full' || x.named)
        // waiting: the helpers Claude waits on (by the task its Agent call named), else any busy helper;
        // with no helper busy yet, Claude's own ● Agent(...) row stays
        const waitedFor = waits ? all.filter(([, x]) => !!x.task && waits.some((t) => t.slice(0, TASK_CHARS) === x.task)) : []
        // (any busy helper only when no helper of this session has that task: a waited-on helper that is
        // just quiet for now keeps Claude's own row, never a background helper's typing)
        const known = !!waits && waits.some((t) => [...agentTasks.values()].includes(t.slice(0, TASK_CHARS)))
        const pool = !waits ? all : waitedFor.length > 0 || known ? waitedFor : all.filter(([, x]) => !x.idle)
        const busy = pool.filter(([, x]) => !x.idle)
        // the agent on screen stays while it is busy, so several agents at once do not swap mid-sentence;
        // then the one that did something last
        const [pickId, pick] = busy.find(([id]) => id === shownAgent) ?? busy.sort(latest)[0] ?? pool.sort(latest)[0] ?? ['', null]
        shownAgent = pickId
        if (pick) {
          chosen = pick
          header = pick.who || 'agent'
          folded = shows === 'brief'
        }
      }
    }
    const b = chosen
    const { Box, Text, Code, Button } = $.ui.resolve(e)
    if (!b || b.inflow || e.props.hasSurvey) {
      // The band is done (or the reply types in the transcript itself): close it a row at a time instead of
      // letting everything below jump at once.
      if (snapHeight) {
        snapHeight = false
        bandHeight = 0 // the text moved into the transcript: its rows go at once, the transcript takes them
      }
      if (e.props.hasSurvey || bandHeight <= 0) {
        bandHeight = 0
        easing = false
        return next(e)
      }
      let now = lastShrinkAt + SHRINK_MS
      try {
        now = await $.clock.now()
      } catch {
        // no clock: just shrink on this draw
      }
      drawnAt = now
      easeToward(now, 0)
      easing = bandHeight > 0
      if (!easing) return next(e)
      await read($, tick)
      startTimer($)
      return <Box flexDirection="column" height={bandHeight} />
    }
    // The band may take about 40% of the window. It grows at once to fit what it shows, and gives back
    // empty rows one at a time, so nothing jumps and no gap is left under it.
    // Fullscreen: `maxRows` is already just the room the bottom slot has left above the prompt (the slot is
    // capped at half the window), so the band may use all of it. Otherwise `maxRows` is the whole window.
    const fullCap = e.viewport?.isFullscreen === true
      ? Math.max(3, e.props.maxRows)
      : Math.max(3, Math.min(e.props.maxRows - 4, Math.max(BAND_MIN_CAP, Math.min(BAND_MAX_CAP, Math.floor(e.props.maxRows * 0.4)))))
    const cap = header ? Math.max(2, fullCap - 1) : fullCap // an agent's name takes the top row
    const width = Math.max(10, e.props.bodyColumns - 3) // the bullet and the caret take the other 3
    const dim = b.idle

    // A tool call's row, in the transcript's words: ● Tool(label)  3s — the marker blinks while it runs.
    const runLine = (r: RunRow, key: string) => (
      <Box key={key} flexDirection="row">
        <Text color={r.running ? (b.blink && !dim ? 'claude' : 'subtle') : r.isError ? 'error' : 'success'}>● </Text>
        <Box flexShrink={1}>
          <Text wrap="truncate-end" dimColor={dim}>
            <Text weight="bold">{r.tool}</Text>
            <Text dimColor>{r.label ? `(${r.label})` : ''}</Text>
          </Text>
        </Box>
        <Text dimColor>{fmtSecs(r.secs) ? `  ${fmtSecs(r.secs)}` : ''}</Text>
      </Box>
    )
    // Lines that do not fit are counted, as the transcript does: "… +12 lines".
    const moreLine = (n: number, indent: string) => (
      <Text dimColor wrap="truncate-end">
        {`${indent}… +${n} line${n === 1 ? '' : 's'}`}
      </Text>
    )
    // The last lines of `lines` (of `total` in all) that fit in `room` rows, and how many are left out.
    const fit = (lines: string[], total: number, room: number) => {
      if (total <= room) return { shown: lines.slice(-room), more: 0 }
      const shown = lines.slice(-Math.max(1, room - 1))
      return { shown, more: total - shown.length }
    }

    let body = null
    let used = 0
    const v = b.block
    if (v && v.kind === 'text') {
      // Reply being written: looks like the reply itself; its bullet is Claude's orange while typing, white once done.
      const typing = v.typing && !dim
      const rows = typedRows(v.source, v.shown, width).slice(-cap)
      const lead = firstWords(rows) // a window that starts on a blank line between paragraphs: the bullet goes on the words
      used = rows.length
      body = rows.map((row, i) => (
        <Text wrap="truncate-end" dimColor={dim}>
          {i === lead ? <Text color={typing ? 'claude' : 'text'}>● </Text> : '  '}
          {row}
          {typing && i === rows.length - 1 ? CARET : ''}
        </Text>
      ))
    } else if (v && v.kind === 'think') {
      // Thinking: a dim, italic aside, its ✻ in the gutter, a few rows at most.
      const rows = typedRows(v.source, v.shown, width).slice(-Math.min(4, cap))
      const lead = firstWords(rows)
      used = rows.length
      body = rows.map((row, i) => (
        <Text dimColor italic wrap="truncate-end">
          {i === lead ? '✻ ' : '  '}
          {row || ' '}
        </Text>
      ))
    } else if (v && v.kind === 'line') {
      // Any other tool call being written: one row, in the transcript's words.
      used = 1
      body = (
        <Text wrap="truncate-end" dimColor>
          {'● '}
          <Text weight="bold">{v.tool}</Text>
          {v.source ? `(${v.source})` : ''}
        </Text>
      )
    } else if (v && v.kind === 'code') {
      // A file or command in a rounded card: its name on top (right side: blinking ● + timer while it runs,
      // then ✓ / ✗), the code typing out inside, then the command's output in its place.
      const isCommand = v.tool in CODE_LANGS
      const room = Math.max(1, cap - 3) // the border takes 2 rows, the name 1
      const r = v.run
      const showTail = !!r && !r.running && b.tail.length > 0
      const out = showTail ? fit(b.tail, b.tail.length + b.tailMore, room) : null
      const lines = v.source.split('\n')
      const code = out ? null : fit(lines, v.totalLines, room)
      const shownCount = out ? out.shown.length + (out.more ? 1 : 0) : code!.shown.length + (code!.more ? 1 : 0)
      used = 3 + shownCount
      body = (
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" borderDimColor={dim} paddingX={1}>
          <Box flexDirection="row">
            <Box flexShrink={1} flexGrow={1}>
              <Text wrap="truncate-end" dimColor={dim}>
                <Text weight="bold">{v.tool}</Text>
                <Text dimColor>{v.label ? `  ${v.label}` : ''}</Text>
              </Text>
            </Box>
            {r && (
              <Text>
                <Text dimColor>{fmtSecs(r.secs) ? `${fmtSecs(r.secs)} ` : ''}</Text>
                <Text color={r.running ? (b.blink && !dim ? 'claude' : 'subtle') : r.isError ? 'error' : 'success'}>
                  {r.running ? '●' : r.isError ? '✗' : '✓'}
                </Text>
              </Text>
            )}
          </Box>
          {out ? (
            <Box flexDirection="column">
              {out.more > 0 && moreLine(out.more, '')}
              {out.shown.map((line) => (
                <Text dimColor wrap="truncate-end">
                  {line}
                </Text>
              ))}
            </Box>
          ) : (
            <Box flexDirection="column">
              {code!.more > 0 && moreLine(code!.more, '')}
              <Code
                source={code!.shown.join('\n')}
                language={CODE_LANGS[v.tool]}
                path={isCommand ? undefined : v.path || undefined}
                startLine={v.startLine > 0 ? v.startLine + lines.length - code!.shown.length : undefined}
                wrap="truncate-end"
              />
            </Box>
          )}
        </Box>
      )
    } else {
      // No block: the tools that ran last, and the latest command's output under ⎿.
      const rows = b.rows.slice(-Math.min(3, cap))
      const out = fit(b.tail, b.tail.length + b.tailMore, Math.max(0, cap - rows.length))
      const tail = cap - rows.length > 0 ? out.shown : []
      used = rows.length + tail.length + (tail.length && out.more ? 1 : 0)
      body = (
        <Box flexDirection="column">
          {rows.map((row, i) => runLine(row, `run${i}`))}
          {tail.length > 0 && out.more > 0 && moreLine(out.more, '  ⎿  ')}
          {tail.map((line, i) => (
            <Text dimColor wrap="truncate-end">
              {i === 0 && !out.more ? '  ⎿  ' : '     '}
              {line}
            </Text>
          ))}
        </Box>
      )
    }

    let now = lastShrinkAt + SHRINK_MS
    try {
      now = await $.clock.now()
    } catch {
      // no clock: just shrink on this draw
    }
    drawnAt = now
    if (folded) {
      body = null // the name row alone, with what the agent is doing
      used = 0
    }
    // the name row's status: "finished ✓" always; brief, what the agent is doing ("started" before anything)
    const shownAny = !!b.block || b.rows.length > 0
    const status = !header ? '' : b.note === 'finished ✓' ? b.note : folded ? (shownAny ? doingOf(b) : b.note || doingOf(b)) : ''
    const want = Math.max(1, Math.min(fullCap, used + (header ? 1 : 0)))
    if (snapHeight) {
      snapHeight = false
      bandHeight = Math.min(bandHeight, want) // the text moved into the transcript: hand its rows over at once
    }
    easeToward(now, want)
    bandHeight = Math.min(bandHeight, fullCap)
    easing = bandHeight !== want
    if (easing) {
      await read($, tick) // redraw on the next frames until the band has given back its empty rows
      startTimer($)
    }

    // The inner box keeps its natural size (no shrinking), so while the band slides it is cut off cleanly
    // instead of its rows being squeezed together.
    return (
      <Box flexDirection="column" height={bandHeight} overflow="hidden">
        <Box flexDirection="column" flexShrink={0}>
          {header && (
            // The agent's name; folded, what it is doing. ▾ hide / ▸ show folds just the agent's part
            // (the engine's own [-] closes the whole band).
            <Box flexDirection="row">
              <Box flexShrink={1} flexGrow={1}>
                <Text dimColor wrap="truncate-end">
                  <Text color={folded && !b.idle && b.blink ? 'claude' : 'subtle'}>◆ </Text>
                  {header}
                  {status ? `  ·  ${status}` : ''}
                </Text>
              </Box>
              <Button
                key="agents-fold"
                plain
                dimColor
                onPress={async () => {
                  if (!folded) await nameAgentsBriefly($) // folding: the name stays a moment, then slides away
                  await setAgentsMain($, folded ? 'full' : 'brief')
                }}
              >
                {folded ? '▸ show' : '▾ hide'}
              </Button>
            </Box>
          )}
          {body}
        </Box>
      </Box>
    )
  })
}
