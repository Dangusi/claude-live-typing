import { expect, mock, test } from 'claude-code/testing'

// `/live-typing`: the picker, the short forms, what is remembered across sessions.

const PRES = { isFullscreen: false, columns: 100 } as any
const ORIGIN = { kind: 'composer' } as any

const store: Record<string, unknown> = {} // $.store, kept across sessions (each test starts from `saved`)
let opened: any[] = []
let registered: any = null

function engine(on: any, saved: Record<string, unknown> = {}, placed = true, steps: Array<Array<any>> = []) {
  for (const k of Object.keys(store)) delete store[k]
  Object.assign(store, saved)
  opened = []
  registered = null
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', (_: any, e: any) => {
    registered = e
    return { value: { command: e.name } }
  })
  on('ui.open', (_: any, e: any) => {
    opened.push(e)
    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => e)
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Check the login flow', type: 'code-reviewer', status: 'running' }] }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  let n = 0
  on('turn.step', async function* (_: any, e: any) {
    for (const c of steps[n++] ?? []) {
      if (c === 'HANG') await clock.sleep(100_000_000) // the model is still writing for the rest of the test
      yield c
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return clock
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const run = ($: any, args: string) => $.command.run({ command: 'live-typing', args, origin: ORIGIN, presentation: PRES })

const PANE = (surface: string, bodyColumns = 80) => ({
  plugin: 'live-typing', surface, component: 'Pane', requestId: 'live-typing',
  props: { title: 'Live typing', isFocused: true, bodyColumns, placement: 'inline', scroll: { offset: 0, bodyRows: 13 }, view: {} },
})

// The picker's options as drawn: "typing:on=On ✔", "typing:demo=Demo", ...
async function options($: any) {
  const ui = await $.ui.mount(PANE('terminal') as any)
  const buttons = (await ui.findAll({ type: 'Button' })).map((b: any) => `${b.key}=${b.text}`)
  await ui.unmount()
  return buttons
}

// The current settings, as the picker ticks them.
async function current($: any) {
  const list: string[] = await options($)
  const ticked = (group: string) => list.find((o) => o.startsWith(group + ':') && o.endsWith('✔'))?.split('=')[0]?.split(':')[1]
  return { typing: ticked('typing'), agents: ticked('agents') }
}

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

const REPLY = [
  { kind: 'text', index: 0, text: 'Here is the answer.' },
  { kind: 'stop', stopReason: 'end_turn', usage: null },
]
const AGENT_STEP = [
  { kind: 'text', index: 0, text: 'Reading the login handler now.' },
  { kind: 'stop', stopReason: 'end_turn', usage: null },
]

test('/live-typing alone opens the picker as a small keyboard dialog', async ($, on) => {
  engine(on)
  await start($)
  const r = await run($, '')
  expect(r.text).toBe(undefined) // the picker is the answer; no transcript line
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'live-typing', focus: true, closeOnEscape: true })
  expect(await options($)).toEqual(['typing:on=On ✔', 'typing:demo=Demo', 'typing:off=Off', 'agents:full=Full', 'agents:brief=Brief', 'agents:off=Off ✔'])
})

test('the picker: Enter on an option switches it, the ✔ moves, and on/off and agents are remembered', async ($, on) => {
  engine(on)
  await start($)
  await run($, '')
  const ui = await $.ui.mount(PANE('terminal') as any)
  await ui.press({ key: 'typing:off' })
  await ui.press({ key: 'agents:brief' })
  const now = (await ui.findAll({ type: 'Button' })).map((b: any) => b.text)
  await ui.unmount()
  expect(now).toEqual(['On', 'Demo', 'Off ✔', 'Full', 'Brief ✔', 'Off'])
  expect(store.typing).toBe('off')
  expect(store.agentsMain).toBe('brief')
})

test('the picker says what each choice does, and the highlighted one gets the ❯', async ($, on) => {
  engine(on)
  await start($)
  await run($, '')
  await $.ui.focus({ component: 'Pane', requestId: 'live-typing', plugin: 'live-typing', element: 'agents:brief', origin: { kind: 'person' } } as any)
  const ui = await $.ui.mount(PANE('terminal') as any)
  const row = await ui.find({ key: 'row:agents:brief' })
  const other = await ui.find({ key: 'row:typing:on' })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  await ui.unmount()
  expect(row?.text ?? JSON.stringify(row?.children)).toContain('❯')
  expect(other?.text ?? JSON.stringify(other?.children)).not.toContain('❯')
  for (const words of ["Claude's work types out as it streams", 'next reply only, slow enough to follow', 'nothing above the prompt', "a helper's live typing, under its name", 'just its name and what it is doing', "only Claude's own work"]) {
    expect(texts).toContain(words)
  }
  expect(texts).toContain('↑↓ move · Enter choose · Esc close')
})

test('/live-typing agents opens the picker on the agents setting', async ($, on) => {
  engine(on)
  await start($)
  await run($, 'agents')
  expect(opened).toHaveLength(1)
  const ui = await $.ui.mount(PANE('terminal') as any)
  const focused = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.autoFocus).map((b: any) => b.key)
  await ui.unmount()
  expect(focused).toEqual(['agents:off'])
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`the picker draws on ${surface}, also narrow`, async ($, on) => {
    engine(on)
    await start($)
    for (const cols of [24, 40, 120]) {
      const ui = await $.ui.mount(PANE(surface, cols) as any)
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)
      await ui.unmount()
    }
  })
}

test('where no pane can show (a headless run), /live-typing answers with the settings in one line', async ($, on) => {
  engine(on, {}, false)
  await start($)
  const r = await run($, '')
  expect(r.text).toContain('Live typing: on')
  expect(r.text).toContain('agents in the main view: off')
  expect(r.text).not.toContain('\n')
})

test('short forms: on | off | demo, and the old word live', async ($, on) => {
  engine(on)
  await start($)
  expect((await run($, 'off')).text).toBe('Live typing: off (nothing above the prompt).')
  expect((await current($)).typing).toBe('off')
  expect(store.typing).toBe('off')
  expect((await run($, 'live')).text).toContain('Live typing: on')
  expect((await current($)).typing).toBe('on')
  expect((await run($, 'OFF')).text).toContain('Live typing: off')
  expect((await run($, 'on')).text).toContain('Live typing: on')
  expect((await run($, 'demo')).text).toBe('Live typing: demo (next reply only, slow enough to follow), then back to on.')
  expect((await current($)).typing).toBe('demo')
  expect(store.typing).toBe('on') // demo is never remembered
})

test('short forms: agents full | brief | off, and the old word name', async ($, on) => {
  engine(on)
  await start($)
  expect((await run($, 'agents full')).text).toContain('Agents in the main view: full')
  expect(store.agentsMain).toBe('full')
  expect((await run($, 'agents name')).text).toContain('Agents in the main view: brief')
  expect(store.agentsMain).toBe('brief')
  expect((await current($)).agents).toBe('brief')
  expect((await run($, 'agents off')).text).toContain('Agents in the main view: off')
  expect(store.agentsMain).toBe('off')
})

test('unknown words answer with one line of usage and change nothing', async ($, on) => {
  engine(on)
  await start($)
  for (const args of ['banana', 'agents maybe', 'help me please', 'constructor', 'agents toString', '__proto__']) {
    const r = await run($, args)
    expect(r.text).toContain('Unknown option')
    expect(r.text).toContain('/live-typing on | off | demo')
    expect(r.text).not.toContain('\n')
  }
  expect(opened).toHaveLength(0)
  expect(await current($)).toEqual({ typing: 'on', agents: 'off' })
  expect(store).toEqual({})
})

test('the command shows its options as a dim hint after its name', async ($, on) => {
  engine(on)
  await start($)
  expect(registered.name).toBe('live-typing')
  expect(registered.argumentHint).toContain('on|off|demo')
  expect(registered.argumentHint).toContain('agents full|brief|off')
})

test('off is remembered: the next session starts off', async ($, on) => {
  engine(on, { typing: 'off' }, true, [REPLY])
  await start($)
  expect((await current($)).typing).toBe('off')
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  expect(await band($)).toBe(null)
})

test('a demo goes back to the remembered choice when its reply is done', async ($, on) => {
  const clock = engine(on, { typing: 'off' }, true, [REPLY])
  await start($)
  expect((await run($, 'demo')).text).toContain('then back to off')
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  await clock.advance(300)
  expect(await band($)).toContain('Here is')
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: 'x', durationMs: 5, isAborted: false } as any)
  for (let t = 0; t < 15_000; t += 500) await clock.advance(500)
  expect((await current($)).typing).toBe('off')
  expect(store.typing).toBe('off')
})

test('a fresh store: typing on, agents off in the main view (their own view still types)', async ($, on) => {
  const clock = engine(on, {}, true, [AGENT_STEP, [{ kind: 'text', index: 0, text: 'Here is the answer, still coming.' }, 'HANG']])
  await start($)
  expect(await current($)).toEqual({ typing: 'on', agents: 'off' })
  await $.turn.start({ text: 'check', turnId: 'sub', agentId: 'a1' })
  for await (const _ of $.turn.step({ turnId: 'sub', index: 0, model: 'm', messageCount: 1, agentId: 'a1' })) {
  }
  await clock.advance(60)
  expect(await band($)).toBe(null)
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 29 }, view: { agentId: 'a1' } },
  })
  expect((await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')).toContain('Reading')
  await ui.unmount()
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next() // Claude's reply is streaming
  await clock.advance(150)
  expect(await band($)).toContain('Here is')
  expect(store).toEqual({}) // nothing written until a choice is made
})

test('values the store should not hold fall back to the defaults', async ($, on) => {
  engine(on, { agentsMain: 'constructor', typing: 42 })
  await start($)
  expect(await current($)).toEqual({ typing: 'on', agents: 'off' })
})

test('a saved agents choice wins over the default', async ($, on) => {
  engine(on, { agentsMain: 'full' })
  await start($)
  expect((await current($)).agents).toBe('full')
})

test("an older version's stored `name` (and no typing key yet) becomes brief", async ($, on) => {
  engine(on, { agentsMain: 'name' })
  await start($)
  expect(await current($)).toEqual({ typing: 'on', agents: 'brief' })
  expect(store.agentsMain).toBe('brief')
  expect(store.typing).toBe(undefined)
})

test("an older version's `live` in this session's state becomes on after a reload", async ($, on) => {
  engine(on)
  // what an older version left in this session's state: `live`, until the new code writes
  let old = true
  on('state.get', (_: any, e: any, next: any) => (old && e.key === 'mode' ? { value: { value: 'live', version: 1 } } : next(e)))
  on('state.set', (_: any, e: any, next: any) => {
    if (e.key === 'mode') old = false
    return next(e)
  })
  await start($)
  expect(old).toBe(false)
  expect((await current($)).typing).toBe('on')
})

test('a reload in the middle of a demo keeps the demo', async ($, on) => {
  engine(on, { typing: 'off' })
  await start($)
  await run($, 'demo')
  await start($) // a reload runs session.start again
  expect((await current($)).typing).toBe('demo')
})
