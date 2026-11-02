import { expect, mock, test } from 'claude-code/testing'

// Blind review of 1.4.0's fullscreen rows. Same mock engine as fullscreen.test.tsx.

const FULL = { columns: 100, rows: 40, isFullscreen: true }
const SLOW = { timeoutMs: 120_000 }

function engine(on: any, steps: Array<Array<any>>) {
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
    return { value: { isPlaced: true, requestId: 'row-' + e.id } }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'AssistantMessage' ? `MSG:${e.props.text}` : 'ENGINE'}</Text>
  })
  let n = 0
  on('turn.step', async function* (_: any, e: any) {
    for (const c of steps[n++] ?? []) {
      if (c === 'HANG') await clock.sleep(100_000_000)
      yield c
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { clock, places }
}

async function band($: any) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', viewport: FULL,
    props: { hasSurvey: false, isWorking: true, maxRows: 18, bodyColumns: 95, scroll: { offset: 0, bodyRows: 17 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  await ui.unmount()
  const out = texts.join(' | ')
  return out === 'ENGINE' ? null : out
}

// What the row draws: '' when it draws nothing, else its Markdown text, or '(bullet)' for a bullet alone.
async function row($: any, id: string, onScreen: any = { first: 0, last: 3, of: 4 }) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'Placed', requestId: 'row-' + id, viewport: FULL,
    props: { id, plugin: 'live-typing', onScreen },
  })
  const md = await ui.find({ type: 'Markdown' })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  await ui.unmount()
  if (md) return String((md as any).props?.text ?? (md as any).text ?? '')
  return texts.includes('●') ? '(bullet)' : ''
}

async function message($: any, text: string, requestId = 'm1', onScreen: any = { first: 0, last: 3, of: 4 }) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AssistantMessage', requestId, viewport: FULL,
    props: { text, isFirstOfReply: true, onScreen },
  })
  const t = await ui.find({ type: 'Text' })
  await ui.unmount()
  return t ? String(t.text).replace(/^MSG:/, '') : ''
}

const start = async ($: any) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await band($)
}

// ---------------------------------------------------------------------------------------------------------
// 1. A text block of only blank lines (the model streams "\n\n" before a tool call; the engine drops it and
//    no message ever lands for it). Its row shows a lone ● and a caret for the rest of the turn.
test('BI-1: a blank text block leaves no ● ▌ row in the transcript while the turn goes on', SLOW, async ($, on) => {
  const { clock, places } = engine(on, [[
    { kind: 'text', index: 0, text: '\n\n' },
    { kind: 'tool', index: 1, id: 'tb1', name: 'Bash' },
    { kind: 'input', index: 1, json: '{"command":"npm test","description":"Run the tests"}' },
    { kind: 'stop', stopReason: 'tool_use', usage: null },
  ]])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  expect(places).toHaveLength(1)
  // even if the engine drew a message for it, nothing could take the row over
  await message($, '\n\n', 'blank')
  // the command runs for a minute; the turn is not over
  for (let t = 0; t < 60_000; t += 1000) await clock.advance(1000)
  expect(await row($, places[0]!)).toBe('') // fails: the row still draws "\n\n▌" under a ● bullet
})

// ---------------------------------------------------------------------------------------------------------
// 2. An older message the mod never animated (a resumed session, before a reload, typing was off then, or
//    over the 200-message cap) is drawn again while a reply types in its row: in fullscreen that happens on
//    every scroll for the message at the viewport's top edge. If its first 32 characters match the reply
//    being written, it takes over the reply's row: the row empties, the band stays shut, the reply vanishes
//    until its own message lands (then appears whole), and the old message blanks and re-types itself.
const OLD = 'Let me check the current state of the repository first.'
const NEW = 'Let me check the current state of the tests before I change anything, so we know what passes today and what was already failing before this work began. '.repeat(3)

test('BI-2: an older message that starts the same way never steals the reply\'s row', SLOW, async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: NEW }, 'HANG']])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(200)
  const typing = (await row($, places[0]!)).replace('▌', '')
  expect(typing.length).toBeGreaterThan(10)
  // the old message at the top edge is drawn again (a scroll moved its onScreen)
  const oldDrawn = await message($, OLD, 'old-reply', { first: 2, last: 3, of: 4 })
  expect(oldDrawn).toBe(OLD) // fails: '' (it blanks, then re-types itself)
  for (let f = 0; f < 5; f++) await clock.advance(33)
  // the reply being written is still on screen: in its row, or at least in the band
  const r = await row($, places[0]!)
  const b = await band($)
  expect(r !== '' || (b ?? '').includes('Let me check')).toBe(true) // fails: row '' and band null
})

// ---------------------------------------------------------------------------------------------------------
// 3. A turn that ended on an error leaves an orphan row; the next main turn starts without a typed prompt
//    (a continuation: a background task finished, a teammate wrote). The orphan stays the whole next turn.
test('BI-3: an orphan row does not outlive the next turn that starts without a prompt', SLOW, async ($, on) => {
  const { clock, places } = engine(on, [[{ kind: 'text', index: 0, text: 'Half a reply that the API then dropped' }, 'HANG']])
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  await s.next()
  await clock.advance(500)
  expect(await row($, places[0]!)).toContain('Half a reply')
  await $.turn.complete({ turnId: 't1', reason: 'error', answer: '', durationMs: 5, isAborted: false } as any)
  await clock.advance(500)
  await $.turn.start({ text: '', turnId: 't2' }) // a continuation: no prompt.submit
  for (let t = 0; t < 30_000; t += 1000) await clock.advance(1000)
  expect(await row($, places[0]!)).toBe('') // fails: still 'Half a reply ...▌' 30 s into the next turn
})

// ---------------------------------------------------------------------------------------------------------
// 4. Sanity (expected to pass): two text blocks in one step (a server tool between them); the first message
//    is drawn only after the second block began. Each message takes its own row; no row is left.
const P1 = 'The first part of the answer explains where rainbows come from and why they curve across the sky.'
const P2 = 'The second part, after the search, says why the outer bow is fainter and its colours are reversed.'
test('BI-4: two text blocks in one step, the first message drawn late: each takes its own row', SLOW, async ($, on) => {
  const { clock, places } = engine(on, [[
    { kind: 'text', index: 0, text: P1 },
    { kind: 'text', index: 2, text: P2 },
    { kind: 'stop', stopReason: 'end_turn', usage: null },
  ]])
  await start($)
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await it.next()
  // the second block has begun
  await clock.advance(100)
  expect(places).toHaveLength(2)
  expect(await message($, P1, 'p1')).toBe('')
  expect(await message($, P2, 'p2')).toBe('')
  while (!(await it.next()).done) {
  }
  for (let f = 0; f < 60; f++) {
    // the engine draws each message again on every frame while it reads the tick
    await clock.advance(33)
    await message($, P1, 'p1')
    await message($, P2, 'p2')
  }
  expect(await row($, places[0]!)).toBe('')
  expect(await row($, places[1]!)).toBe('')
  expect(await message($, P1, 'p1')).toBe(P1)
  expect(await message($, P2, 'p2')).toBe(P2)
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: P2, durationMs: 5, isAborted: false } as any)
})
