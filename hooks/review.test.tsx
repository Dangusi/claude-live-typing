import { expect, mock, test } from 'claude-code/testing'

// Reviewer's tests for 1.3.0: each one fails on the code as handed over.

const PRES = { isFullscreen: false, columns: 100 } as any
const ORIGIN = { kind: 'composer' } as any
const store: Record<string, unknown> = {}
const A1 = [{ id: 'a1', description: 'run the tests', type: 'tester', status: 'running' }]
let agentList: any[] = A1

function engine(on: any, steps: Array<Array<any>>, saved: Record<string, unknown> = {}, toolCall?: (e: any, clock: any) => any) {
  for (const k of Object.keys(store)) delete store[k]
  Object.assign(store, saved)
  agentList = A1
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  const clock: any = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'live-typing' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => e)
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('tool.call', async (_: any, e: any) => (toolCall ? toolCall(e, clock) : { result: { stdout: '', stderr: '' } }))
  on('agent.list', () => ({ value: agentList }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  let n = 0
  on('turn.step', async function* (_: any, e: any) {
    for (const c of steps[n++] ?? []) {
      if (c === 'HANG') await clock.sleep(100_000_000)
      yield c
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return clock
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const run = ($: any, args: string) => $.command.run({ command: 'live-typing', args, origin: ORIGIN, presentation: PRES })
const PANE = {
  plugin: 'live-typing', surface: 'terminal', component: 'Pane', requestId: 'live-typing',
  props: { title: 'Live typing', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 13 }, view: {} },
} as any

async function band($: any, cols = 100) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 40, bodyColumns: cols, scroll: { offset: 0, bodyRows: 39 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  await ui.unmount()
  const out = texts.join(' | ')
  return out === 'ENGINE' ? null : out
}

async function typingNow($: any) {
  const ui = await $.ui.mount(PANE)
  const ticked = (await ui.findAll({ type: 'Button' })).find((b: any) => String(b.key).startsWith('typing:') && String(b.text).endsWith('✔'))
  await ui.unmount()
  return String(ticked?.key ?? '').replace('typing:', '')
}

const REPLY = [
  { kind: 'text', index: 0, text: 'Here is the answer.' },
  { kind: 'stop', stopReason: 'end_turn', usage: null },
]

// 1. Demo is "one reply". The revert waits for EVERY helper agent's feed to be empty, so a helper running a
//    long command (or streaming) keeps demo on into the next replies.
test('demo goes back to on after its reply even while a helper agent is still running a long command', async ($, on) => {
  const clock = engine(on, [REPLY, REPLY], { typing: 'on' }, async (e: any, c: any) => {
    if (e.agentId) await c.sleep(120_000) // the helper's test run takes two minutes
    return { result: { stdout: 'ok\n', stderr: '' } }
  })
  await start($)
  await run($, 'demo')
  await $.turn.start({ text: 'x', turnId: 'sub', agentId: 'a1' }) // a background helper is working
  void $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as any).catch(() => {})
  await clock.advance(100)
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: 'x', durationMs: 5, isAborted: false } as any)
  for (let t = 0; t < 15_000; t += 500) await clock.advance(500) // the demo reply has long been shown and read
  expect(await typingNow($)).toBe('on')
})

// 2. `/live-typing` is immediate now, and the picker autofocuses the ticked option. Re-picking it (Enter), or
//    on <-> demo, mid-reply calls clearAll(), which drops the block being streamed from the queue while the
//    step keeps appending to it: the rest of that reply never shows in the band.
const LONG = [
  { kind: 'text', index: 0, text: 'First part of a long answer, ' },
  { kind: 'text', index: 0, text: 'and the second part arrives after the switch. ' },
  'HANG',
]
for (const how of ['command on', 'picker Enter on the ticked On', 'command demo'] as const) {
  test(`mid-reply, ${how}: the reply being written keeps typing in the band`, { timeoutMs: 60_000 }, async ($, on) => {
    const clock = engine(on, [LONG])
    await start($)
    await $.turn.start({ text: 'go', turnId: 'main' })
    const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
    await it.next() // the first chunk streams in
    await clock.advance(400)
    expect(await band($)).toContain('First part')
    if (how === 'command on') await run($, 'on')
    if (how === 'command demo') await run($, 'demo')
    if (how === 'picker Enter on the ticked On') {
      await run($, '')
      const ui = await $.ui.mount(PANE)
      await ui.press({ key: 'typing:on' })
      await ui.unmount()
    }
    await it.next() // the same text block goes on streaming
    for (let t = 0; t < 4000; t += 100) await clock.advance(100)
    expect((await band($)) ?? '').toContain('second part')
  })
}

// 3. Wide emoji outside the two ranges cellsOf knows (✅ U+2705, ❌ U+274C, ✨ U+2728, ⚡ U+26A1, ⭐ U+2B50,
//    🚀 U+1F680, 🟢 U+1F7E2, 🪄 U+1FA84 ...) count as 1 cell, so a row is laid out wider than the band and the
//    terminal cuts its end off.
const EAW_WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3],
  [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]
const cells = (s: string) => [...s].reduce((n, ch) => {
  const cp = ch.codePointAt(0)!
  return n + (EAW_WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1)
}, 0)

test('a reply with ✅ and 🚀 fits the band: no row wider than the window', async ($, on) => {
  const clock = engine(on, [[{ kind: 'text', index: 0, text: 'Step ✅ done 🚀 next '.repeat(12) }, 'HANG']])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  for (let t = 0; t < 3000; t += 100) await clock.advance(100)
  const cols = 60
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 40, bodyColumns: cols, scroll: { offset: 0, bodyRows: 39 }, view: {} },
  })
  const rows = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text)).filter((t: string) => t.length > 2 && (t.startsWith('● ') || t.startsWith('  ')))
  await ui.unmount()
  expect(rows.length).toBeGreaterThan(1)
  expect(Math.max(...rows.map(cells))).toBeLessThanOrEqual(cols)
})

// 4. Agents full, Claude waits on a foreground helper that has not streamed yet (its model is still on its first
//    token, past the 4 s "started" notice): the main view falls back to ANY busy helper, so it shows a background
//    helper's typing under that helper's name, as if Claude were waiting on it.
test('agents full: while Claude waits on a quiet foreground helper, a busy background one is not shown instead', async ($, on) => {
  const clock = engine(on, [[{ kind: 'text', index: 0, text: 'Tidying the docs, one file at a time, ' }, 'HANG']], { agentsMain: 'full' }, async (e: any, c: any) => {
    if (e.tool === 'Agent') await c.sleep(60_000) // the foreground helper runs inside the Agent call
    return { result: { stdout: '', stderr: '' } }
  })
  agentList = [
    { id: 'bg', description: 'tidy the docs', type: 'writer', status: 'running' },
    { id: 'fg', description: 'look around', type: 'Explore', status: 'running' },
  ]
  await start($)
  await $.turn.start({ text: 'x', turnId: 'tbg', agentId: 'bg' })
  const it = $.turn.step({ turnId: 'tbg', index: 0, model: 'm', messageCount: 1, agentId: 'bg' })[Symbol.asyncIterator]()
  await it.next() // a background helper is busy writing
  await $.turn.start({ text: 'go', turnId: 'main' })
  void $.tool.call({ tool: 'Agent', description: 'look around', prompt: 'x' } as any).catch(() => {})
  await clock.advance(200)
  await $.turn.start({ text: 'look around', turnId: 'tfg', agentId: 'fg' }) // its model has not written a token yet
  for (let t = 0; t < 6000; t += 500) await clock.advance(500)
  const shown = (await band($)) ?? ''
  expect(shown).not.toContain('Tidying')
  expect(shown).toContain('look around')
})
