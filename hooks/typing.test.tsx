import { expect, mock, test } from 'claude-code/testing'

// The main band: demo pacing, a step that ends early, a Write streamed in small pieces.

const PRES = { isFullscreen: false, columns: 100 } as any
const ORIGIN = { kind: 'composer' } as any
const SLOW = { timeoutMs: 60_000 }

function engine(on: any, steps: Array<Array<any>>) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'live-typing' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => e)
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { stdout: 'ok\n', stderr: '' } }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  let n = 0
  on('turn.step', async function* (_: any, e: any) {
    const chunks = steps[n++] ?? []
    for (const c of chunks) {
      if (c === 'HANG') await clock.sleep(100_000_000) // the stream stops here and does not resume during the test
      yield c
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return clock
}

const run = ($: any, args: string) => $.command.run({ command: 'live-typing', args, origin: ORIGIN, presentation: PRES })

// The typing setting the picker ticks now.
async function modeOf($: any) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'Pane', requestId: 'live-typing',
    props: { title: 'Live typing', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 13 }, view: {} },
  })
  const ticked = (await ui.findAll({ type: 'Button' })).find((b: any) => String(b.key).startsWith('typing:') && String(b.text).endsWith('✔'))
  await ui.unmount()
  return String(ticked?.key ?? '').replace('typing:', '')
}

// What the band above the prompt shows (null when the plugin passes to the engine).
async function band($: any) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 29 }, view: {} },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  const out = texts.map((t: any) => t.text).join(' | ')
  return out === 'ENGINE' ? null : out
}

async function waitOut(clock: any, ms: number) {
  for (let t = 0; t < ms; t += 500) await clock.advance(500)
}

const STEP = [
  { kind: 'text', index: 0, text: 'Let me ask a helper agent to look.' },
  { kind: 'tool', index: 1, id: 'tu1', name: 'Agent' },
  { kind: 'input', index: 1, json: '{"description":"look around","prompt":"x"}' },
  { kind: 'stop', stopReason: 'tool_use', usage: null },
]

test('a helper agent finishing does not end demo in the middle of the main turn', async ($, on) => {
  const clock = engine(on, [STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'demo')
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  // The Agent tool runs a subagent; its own turn ends while the main turn is still running.
  await $.turn.start({ text: 'look', turnId: 'sub', agentId: 'sub1' })
  await $.turn.complete({ turnId: 'sub', agentId: 'sub1', reason: 'answer', answer: 'found it', durationMs: 5, isAborted: false } as any)
  await clock.settle()
  expect(await modeOf($)).toBe('demo')
})

test('demo makes a tool wait until the text before it could be read', async ($, on) => {
  const clock = engine(on, [STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'demo')
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  let done = false
  const p = $.tool.call({ tool: 'Bash', command: 'ls' } as any).then(() => (done = true))
  await clock.settle()
  expect(done).toBe(false)
  await clock.advance(20_000)
  await p
  expect(done).toBe(true)
})

test('demo still makes the next tool wait after a helper agent ended', async ($, on) => {
  const clock = engine(on, [STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'demo')
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  await $.turn.complete({ turnId: 'sub', agentId: 'sub1', reason: 'answer', answer: 'x', durationMs: 5, isAborted: false } as any)
  let done = false
  const p = $.tool.call({ tool: 'Bash', command: 'ls' } as any).then(() => (done = true))
  await clock.settle()
  expect(done).toBe(false)
  await clock.advance(20_000)
  await p
})

test('a step left before its end does not keep the band typing after the turn and a new prompt', SLOW, async ($, on) => {
  const clock = engine(on, [[{ kind: 'text', index: 0, text: 'Hello, I will' }, 'HANG']])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  const s = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })
  await s.next() // one chunk reaches the engine, then the engine goes on without this generator
  await clock.advance(1000)
  await $.turn.complete({ turnId: 'main', reason: 'aborted', answer: '', durationMs: 5, isAborted: true } as any)
  await waitOut(clock, 6000) // longer than any hold
  await $.prompt.submit({ text: 'next', origin: ORIGIN } as any).catch(() => {})
  await waitOut(clock, 2000)
  expect(await band($)).toBe(null)
})

test('a step stream closed early (an interrupt) clears the band', SLOW, async ($, on) => {
  const clock = engine(on, [[{ kind: 'text', index: 0, text: 'A'.repeat(40) + ' ' + 'B'.repeat(40) }, 'HANG']])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  const s = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })
  await s.next()
  await clock.advance(66)
  expect(await band($)).toContain('AAAA')
  void s.return(undefined as any).catch(() => {})
  await waitOut(clock, 4000)
  expect(await band($)).toBe(null)
})

test('a Write streamed in small pieces types its file name and code into the card', SLOW, async ($, on) => {
  const json = JSON.stringify({ file_path: 'C:\\proj\\src\\hello.ts', content: 'const a = "x\\y"\r\nconsole.log(a) // ą😀\n' })
  const pieces: any[] = []
  for (let i = 0; i < json.length; i += 3) pieces.push({ kind: 'input', index: 0, json: json.slice(i, i + 3) })
  const clock = engine(on, [[{ kind: 'tool', index: 0, id: 'w1', name: 'Write' }, ...pieces, 'HANG']])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  const s = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })
  for (let i = 0; i < pieces.length + 1; i++) await s.next()
  await waitOut(clock, 1000)
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 29 }, view: {} },
  })
  const code = await ui.find({ type: 'Code' })
  const header = await ui.find({ type: 'Text', text: /hello\.ts/ })
  await ui.unmount()
  expect(header?.text).toContain('Write')
  expect(code?.text).toContain('const a = "x\\y"\nconsole.log(a) // ą😀')
})
