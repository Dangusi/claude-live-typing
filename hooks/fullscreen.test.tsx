import { expect, mock, test } from 'claude-code/testing'

// Fullscreen: a reply types in a row of its own at the transcript's end, where its message lands, and the
// message takes the row's place, so the text never jumps from the bottom band to the top.

const PRES = { isFullscreen: true, columns: 100 } as any
const ORIGIN = { kind: 'composer' } as any
const FULL = { columns: 100, rows: 40, isFullscreen: true }
const SLOW = { timeoutMs: 60_000 }

type Opts = { placed?: boolean; fullscreen?: boolean }

function engine(on: any, steps: Array<Array<any>>, opts: Opts = {}) {
  const places: string[] = []
  const clock: any = mock.clock(on, { now: 1_000_000 })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'live-typing' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => e)
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { stdout: 'ok\n', stderr: '' } }))
  on('ui.place', (_: any, e: any) => {
    places.push(e.id)
    return { value: opts.placed === false ? { isPlaced: false, reason: 'too many rows' } : { isPlaced: true, requestId: 'row-' + e.id } }
  })
  // The engine's own drawing: a message draws its text (as rewritten), anything else a marker.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'AssistantMessage' ? `MSG:${e.props.text}` : 'ENGINE'}</Text>
  })
  let n = 0
  on('turn.step', async function* (_: any, e: any) {
    for (const c of steps[n++] ?? []) {
      if (c === 'HANG') await clock.sleep(100_000_000) // the stream stops here for the rest of the test
      yield c
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { clock, places }
}

// The band above the prompt, drawn in the fullscreen layout (which is how the mod learns the layout).
async function band($: any, fullscreen = true) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band',
    ...(fullscreen ? { viewport: FULL } : {}),
    props: { hasSurvey: false, isWorking: true, maxRows: 18, bodyColumns: 95, scroll: { offset: 0, bodyRows: 17 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  await ui.unmount()
  const out = texts.join(' | ')
  return out === 'ENGINE' ? null : out
}

// What the reply's own transcript row shows ('' when it draws nothing).
async function row($: any, id: string, onScreen: any = { first: 0, last: 3, of: 4 }, surface = 'terminal') {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface, component: 'Placed', requestId: 'row-' + id, viewport: FULL,
    props: { id, plugin: 'live-typing', onScreen },
  })
  const md = await ui.find({ type: 'Markdown' })
  await ui.unmount()
  return md ? String((md as any).props?.text ?? (md as any).text ?? '') : ''
}

// What the landed message shows ('' for nothing, else its text as drawn).
async function message($: any, text: string, requestId = 'm1') {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AssistantMessage', requestId, viewport: FULL,
    props: { text, isFirstOfReply: true },
  })
  const t = await ui.find({ type: 'Text' })
  await ui.unmount()
  return t ? String(t.text).replace(/^MSG:/, '') : ''
}

const start = async ($: any, fullscreen = true) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await band($, fullscreen) // the first drawing tells the mod which layout this is
}

const REPLY = 'A rainbow begins with sunlight and raindrops. When the sun is behind you and rain falls in front of you, light enters each droplet and bends. '.repeat(4).trim()

test('fullscreen: the reply types in its own transcript row, and the band stays closed', async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: REPLY.slice(0, 200) }, 'HANG']])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(300)
  expect(places).toHaveLength(1)
  const shown = await row($, places[0]!)
  expect(shown.startsWith('A rainbow begins')).toBe(true)
  expect(shown.endsWith('▌')).toBe(true)
  expect(await band($)).toBe(null)
})

test('fullscreen: the landed message takes the row\'s place: never both, never neither', SLOW, async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: REPLY }, { kind: 'stop', stopReason: 'end_turn', usage: null }]])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next() // the whole reply has streamed; the row is still typing it
  await clock.advance(200)
  const before = (await row($, places[0]!)).replace('▌', '')
  expect(before.length).toBeGreaterThan(10)
  expect(before.length).toBeLessThan(REPLY.length)
  // The message lands: its first frame draws nothing, the row still shows the text.
  expect(await message($, REPLY)).toBe('')
  expect(await message($, REPLY)).toBe('') // drawn again before the next frame (its onScreen report): still nothing
  expect((await row($, places[0]!)).replace('▌', '')).toBe(before)
  while (!(await it.next()).done) {
  } // the step ends right after its message landed
  // From the next frame on: the message shows the text from where the row got to, the row nothing.
  let last = before.length
  for (let f = 0; f < 80; f++) {
    await clock.advance(33)
    const r = await row($, places[0]!)
    const m = await message($, REPLY)
    expect(r === '' || m === '').toBe(true) // never both
    expect(r !== '' || m !== '').toBe(true) // never neither
    expect(r).toBe('')
    const typed = m.replace('▌', '').length
    expect(typed).toBeGreaterThanOrEqual(last) // it goes on, never back
    last = typed
  }
  expect(await message($, REPLY)).toBe(REPLY) // typed out, drawn as the engine draws it
})

test('fullscreen, the reply scrolled out of view: the band shows it meanwhile', async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: REPLY.slice(0, 120) }, 'HANG']])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(300)
  expect(await band($)).toBe(null)
  await row($, places[0]!, null) // the person scrolled up: the row is off screen
  await clock.advance(100)
  expect((await band($)) ?? '').toContain('A rainbow begins')
  await row($, places[0]!) // back at the bottom
  await clock.advance(100)
  expect(await band($)).toBe(null)
})

test('not fullscreen: no transcript row; the band types the reply as before', async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: REPLY.slice(0, 120) }, 'HANG']])
  await start($, false)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(300)
  expect(places).toHaveLength(0)
  expect((await band($, false)) ?? '').toContain('A rainbow begins')
})

test('fullscreen, no row can be placed: the band types the reply', async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: REPLY.slice(0, 120) }, 'HANG']], { placed: false })
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(300)
  expect(places).toHaveLength(1)
  expect((await band($)) ?? '').toContain('A rainbow begins')
})

test('fullscreen: a row no message took over (an error) lets its text go after the turn', SLOW, async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: 'Half a reply that the engine then dropped' }, 'HANG']])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const s = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })
  await s.next()
  await clock.advance(500)
  expect(await row($, places[0]!)).toContain('Half a reply')
  await $.turn.complete({ turnId: 'main', reason: 'error', answer: '', durationMs: 5, isAborted: true } as any)
  for (let t = 0; t < 4000; t += 500) await clock.advance(500)
  expect(await row($, places[0]!)).toBe('')
})

test('fullscreen: typing switched off mid-reply empties the row; the message shows whole', async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: REPLY.slice(0, 160) }, 'HANG']])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(200)
  expect(await row($, places[0]!)).not.toBe('')
  await $.command.run({ command: 'live-typing', args: 'off', origin: ORIGIN, presentation: PRES })
  await clock.advance(100)
  expect(await row($, places[0]!)).toBe('')
  expect(await message($, REPLY.slice(0, 160))).toBe(REPLY.slice(0, 160))
})

test('fullscreen: the row draws on the terminal only', async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: REPLY.slice(0, 160) }, 'HANG']])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(200)
  expect(await row($, places[0]!, { first: 0, last: 3, of: 4 }, 'desktop')).toBe('')
  expect(await row($, places[0]!)).not.toBe('')
})

const SAY_THEN_RUN = [
  { kind: 'text', index: 0, text: 'Let me run the tests now, they take a moment.' },
  { kind: 'tool', index: 1, id: 'tb1', name: 'Bash' },
  { kind: 'input', index: 1, json: '{"command":"npm test","description":"Run the tests"}' },
  { kind: 'stop', stopReason: 'tool_use', usage: null },
]

test('fullscreen demo: the reply types in its row at the calm pace and the tool still waits for it', SLOW, async ($, on) => {
  const { clock, places } = engine(on, [SAY_THEN_RUN])
  await start($)
  await $.command.run({ command: 'live-typing', args: 'demo', origin: ORIGIN, presentation: PRES })
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  await clock.advance(150)
  const early = (await row($, places[0]!)).replace('▌', '')
  expect(early.length).toBeGreaterThan(0)
  expect(early.length).toBeLessThan(30) // about 110 characters a second
  // its message lands and takes the row's place, still at the calm pace
  const text = SAY_THEN_RUN[0]!.text as string
  expect(await message($, text)).toBe('')
  await clock.advance(33)
  expect(await row($, places[0]!)).toBe('')
  const landed = (await message($, text)).replace('▌', '')
  expect(landed.length).toBeGreaterThanOrEqual(early.length)
  expect(landed.length).toBeLessThan(text.length)
  let done = false
  const p = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' } as any).then(() => (done = true))
  await clock.settle()
  expect(done).toBe(false) // the text before it is still being typed and read
  for (let t = 0; t < 20_000; t += 500) await clock.advance(500)
  await p
  expect(done).toBe(true)
})

test('fullscreen: a command after the reply still types in the band', SLOW, async ($, on) => {
  const { clock, places } = engine(on, [SAY_THEN_RUN])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  await message($, SAY_THEN_RUN[0]!.text as string) // the reply landed in the transcript
  for (let t = 0; t < 1500; t += 100) await clock.advance(100)
  const shown = (await band($)) ?? ''
  expect(shown).toContain('Run the tests')
  expect(shown).not.toContain('Let me run') // the reply itself never typed in the band
  expect(places).toHaveLength(1)
})
