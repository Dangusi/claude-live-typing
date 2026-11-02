import { expect, mock, test } from 'claude-code/testing'

// Helper agents (subagents) get their own band: shown in their own view, and in the main view under
// their name as the `agents` setting says. They never touch the main band or demo mode.

const PRES = { isFullscreen: false, columns: 100 } as any
const ORIGIN = { kind: 'composer' } as any

const store: Record<string, unknown> = {} // what $.store keeps across sessions (reset per test below)

function engine(on: any, steps: Array<Array<any>>, saved: Record<string, unknown> = { agentsMain: 'full' }) {
  for (const k of Object.keys(store)) delete store[k]
  Object.assign(store, saved)
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'live-typing' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => e)
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { stdout: 'build ok\n', stderr: '' } }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Check the login flow', type: 'code-reviewer', status: 'running' }] }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  let n = 0
  on('turn.step', async function* (_: any, e: any) {
    for (const c of steps[n++] ?? []) yield c
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return clock
}

// What the band above the prompt shows (null when the plugin passes to the engine).
async function band($: any, view: { agentId?: string } = {}, press?: string) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 29 }, view },
  })
  if (press) await ui.press({ key: press })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  const out = texts.map((t: any) => t.text).join(' | ')
  return out === 'ENGINE' ? null : out
}

const run = ($: any, args: string) => $.command.run({ command: 'live-typing', args, origin: ORIGIN, presentation: PRES })

const AGENT_STEP = [
  { kind: 'text', index: 0, text: 'Reading the login handler now.' },
  { kind: 'tool', index: 1, id: 'tb1', name: 'Bash' },
  { kind: 'input', index: 1, json: '{"command":"npm test","description":"Run the tests"}' },
  { kind: 'stop', stopReason: 'tool_use', usage: null },
]
const MAIN_STEP = [
  { kind: 'text', index: 0, text: 'Here is my own answer.' },
  { kind: 'stop', stopReason: 'end_turn', usage: null },
]
const NAME = 'code-reviewer · Check the login flow'

async function agentStep($: any) {
  await $.turn.start({ text: 'check', turnId: 'sub', agentId: 'a1' })
  for await (const _ of $.turn.step({ turnId: 'sub', index: 0, model: 'm', messageCount: 1, agentId: 'a1' })) {
  }
}

test('agents full, Claude idle: the agent types under its name in the main view', async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await agentStep($)
  await clock.advance(60) // the whole step arrived at once here: its text types first, then the command card
  const shown = await band($)
  expect(shown).toContain(NAME)
  expect(shown).toContain('Reading')
})

test("the agent's own view: its band, no name header", async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await agentStep($)
  await clock.advance(60)
  const shown = await band($, { agentId: 'a1' })
  expect(shown).toContain('Reading')
  expect(shown).not.toContain('◆')
  expect((await band($, { agentId: 'other' })) ?? '').not.toContain('Reading') // another agent's view: nothing of a1
})

test("the agent's command runs with a timer, then its output shows", async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await agentStep($)
  await clock.advance(2000)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests', agentId: 'a1' } as any)
  await clock.advance(200)
  const shown = await band($, { agentId: 'a1' })
  expect(shown).toContain('build ok')
})

test("Claude's own band wins over an agent's in the main view", async ($, on) => {
  const clock = engine(on, [AGENT_STEP, MAIN_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await agentStep($)
  await $.prompt.submit({ text: 'hi' } as any)
  await $.turn.start({ text: 'hi', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next() // the main reply has started streaming
  await clock.advance(150)
  const shown = await band($)
  expect(shown).toContain('Here is')
  expect(shown).not.toContain('code-reviewer')
  while (!(await it.next()).done) {
  }
})

test('demo never makes an agent wait, and an agent ending keeps demo on', async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'demo')
  await agentStep($)
  let done = false
  const p = $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any).then(() => (done = true))
  await clock.settle()
  expect(done).toBe(true)
  await p
  await $.turn.complete({ turnId: 'sub', agentId: 'a1', reason: 'answer', answer: 'done', durationMs: 5, isAborted: false } as any)
  await clock.advance(10_000)
  expect(await pickerButtons($)).toContain('Demo ✔') // the picker's ✔ is still on Demo
})

// The picker's options as drawn, "On ✔ | Demo | Off | Full | ...".
async function pickerButtons($: any) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'Pane', requestId: 'live-typing',
    props: { title: 'Live typing', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 13 }, view: {} },
  })
  const buttons = await ui.findAll({ type: 'Button' })
  await ui.unmount()
  return buttons.map((b: any) => b.text).join(' | ')
}

test("a finished agent's band goes away", async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await agentStep($)
  await clock.advance(500)
  expect(await band($)).not.toBe(null)
  await $.turn.complete({ turnId: 'sub', agentId: 'a1', reason: 'answer', answer: 'done', durationMs: 5, isAborted: false } as any)
  for (let t = 0; t < 10_000; t += 500) await clock.advance(500)
  expect(await band($)).toBe(null)
  expect(await band($, { agentId: 'a1' })).toBe(null)
})

test('typing off: agents show nothing either', async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'off')
  await agentStep($)
  await clock.advance(500)
  expect(await band($)).toBe(null)
  expect(await band($, { agentId: 'a1' })).toBe(null)
})

test('agents brief: one row with the name and what it is doing; ▸ show unfolds and is remembered', async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await run($, 'agents brief')
  expect(r.text).toContain('Agents in the main view: brief')
  expect(store.agentsMain).toBe('brief')
  await agentStep($)
  await clock.advance(60)
  const folded = await band($)
  expect(folded).toContain(NAME)
  expect(folded).toContain('writing')
  expect(folded).not.toContain('Reading') // the agent's text is not drawn
  await band($, {}, 'agents-fold') // ▸ show
  expect(store.agentsMain).toBe('full')
  await clock.advance(30)
  expect(await band($)).toContain('Reading') // unfolded: the agent's text is back
})

test('agents off: nothing in the main view, the agent view still types', async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'agents off')
  await agentStep($)
  await clock.advance(60)
  expect(await band($)).toBe(null)
  expect(await band($, { agentId: 'a1' })).toContain('Reading')
})

test('▾ hide folds just the agent part to brief', async ($, on) => {
  const clock = engine(on, [AGENT_STEP])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await agentStep($)
  await clock.advance(60)
  await band($, {}, 'agents-fold') // ▾ hide
  expect(store.agentsMain).toBe('brief')
  const shown = await band($)
  expect(shown).toContain('writing') // folded: the name row says what it is doing
  expect(shown).not.toContain('Reading')
  for (let t = 0; t < 6000; t += 500) await clock.advance(500) // a few seconds later the row slides away for good
  expect((await band($)) ?? '').not.toContain('code-reviewer')
})

test('brief: a new agent shows its name briefly, then nothing while it works', async ($, on) => {
  const clock = engine(on, [AGENT_STEP], { agentsMain: 'brief' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await agentStep($)
  await clock.advance(60)
  expect(await band($)).toContain('code-reviewer')
  for (let t = 0; t < 6000; t += 500) await clock.advance(500)
  expect((await band($)) ?? '').not.toContain('code-reviewer')
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any) // still working: stays folded
  await clock.advance(200)
  expect((await band($)) ?? '').not.toContain('code-reviewer')
})

test('brief: a finished agent says so for a moment, then goes', async ($, on) => {
  const clock = engine(on, [AGENT_STEP], { agentsMain: 'brief' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await agentStep($)
  for (let t = 0; t < 6000; t += 500) await clock.advance(500)
  await $.turn.complete({ turnId: 'sub', agentId: 'a1', reason: 'answer', answer: 'done', durationMs: 5, isAborted: false } as any)
  await clock.advance(100)
  expect(await band($)).toContain('finished ✓')
  for (let t = 0; t < 6000; t += 500) await clock.advance(500)
  expect((await band($)) ?? '').not.toContain('code-reviewer')
})
