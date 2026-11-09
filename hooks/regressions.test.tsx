import { expect, mock, test } from 'claude-code/testing'

// Behaviour a stranger expects, each test once a bug: off really off, wide (CJK) text, emoji, agents
// in the main view, the frame timer.

const PRES = { isFullscreen: false, columns: 100 } as any
const ORIGIN = { kind: 'composer' } as any

const store: Record<string, unknown> = {}

function engine(on: any, steps: Array<Array<any>>, saved: Record<string, unknown> = {}, agents: any[] = [], toolCall?: (e: any) => any) {
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
  on('tool.call', (_: any, e: any) => (toolCall ? toolCall(e) : { result: { stdout: 'build ok\n', stderr: '' } }))
  on('agent.list', () => ({
    value: agents.length ? agents : [{ id: 'a1', description: 'Check the login flow', type: 'code-reviewer', status: 'running' }],
  }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  let n = 0
  on('turn.step', async function* (_: any, e: any) {
    for (const c of steps[n++] ?? []) {
      if (c === 'HANG') await clock.sleep(100_000_000) // the stream stops here for the rest of the test
      yield c
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return clock
}

async function band($: any, view: { agentId?: string } = {}, cols = 100, surface = 'terminal') {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface, component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: cols, scroll: { offset: 0, bodyRows: 29 }, view },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  const out = texts.map((t: any) => t.text).join(' | ')
  return out === 'ENGINE' ? null : out
}

async function agentTurn($: any, id = 'a1') {
  await $.turn.start({ text: 'go', turnId: 'sub-' + id, agentId: id })
  for await (const _ of $.turn.step({ turnId: 'sub-' + id, index: 0, model: 'm', messageCount: 1, agentId: id })) {
  }
}

const AGENT_STEP = [
  { kind: 'text', index: 0, text: 'Looking through the source now.' },
  { kind: 'stop', stopReason: 'end_turn', usage: null },
]
const FULL = { agentsMain: 'full' }

test('off: a helper agent that starts and finishes shows nothing at all', async ($, on) => {
  const clock = engine(on, [], FULL)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'live-typing', args: 'off', origin: ORIGIN, presentation: PRES })
  await $.turn.start({ text: 'build', turnId: 'sub', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any)
  await $.turn.complete({ turnId: 'sub', agentId: 'a1', reason: 'answer', answer: 'done', durationMs: 5, isAborted: false } as any)
  await clock.advance(100)
  expect(await band($)).toBe(null)
})

// Wide characters (Chinese, Japanese, Korean, most emoji) take 2 terminal cells.
const wide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
const cellsOf = (s: string) => [...s].reduce((n, ch) => n + (wide(ch.codePointAt(0)!) ? 2 : 1), 0)

const JP = 'これはライブタイピングのテストです。日本語の返信はスペースがないので、行の幅は文字数ではなくセル数で数える必要があります。'

async function mainRows($: any, cols: number) {
  const ui = await $.ui.mount({
    plugin: 'live-typing', surface: 'terminal', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 40, bodyColumns: cols, scroll: { offset: 0, bodyRows: 39 }, view: {} },
  })
  const all = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  await ui.unmount()
  return all.filter((t: string) => t.length > 2 && (t.startsWith('● ') || t.startsWith('  '))) // the reply's rows
}

test('a Japanese reply (no spaces) types while it streams', async ($, on) => {
  const clock = engine(on, [[{ kind: 'text', index: 0, text: JP }, 'HANG']])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  const s = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await s.next() // the model is still writing
  await clock.advance(3000)
  expect((await mainRows($, 100)).join('')).toContain('これはライブ')
})

test('a Japanese reply fits the band: no row wider than its cells', async ($, on) => {
  const clock = engine(on, [[
    { kind: 'text', index: 0, text: JP.repeat(3) },
    { kind: 'tool', index: 1, id: 'r1', name: 'Read' },
    'HANG',
  ]])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  const s = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await s.next()
  await s.next() // the Read starts: the text block is complete
  await clock.advance(250) // mid-typing
  const cols = 60
  const rows = await mainRows($, cols)
  expect(rows.length).toBeGreaterThan(1)
  expect(Math.max(...rows.map(cellsOf))).toBeLessThanOrEqual(cols)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band draws on ${surface} (text, code card, agent header)`, async ($, on) => {
    const clock = engine(on, [[
      { kind: 'text', index: 0, text: 'Running the checks.' },
      { kind: 'tool', index: 1, id: 'tb1', name: 'Bash' },
      { kind: 'input', index: 1, json: '{"command":"npm test","description":"Run the tests"}' },
      { kind: 'stop', stopReason: 'tool_use', usage: null },
    ]], FULL)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await agentTurn($)
    await clock.advance(60)
    const t1 = await band($, {}, 100, surface)
    await clock.advance(1500)
    const t2 = await band($, {}, 100, surface)
    expect(t1).toContain('Running')
    expect(t1).toContain('code-reviewer · Check the login flow')
    expect(t2).toContain('Run the tests')
  })
}

test('agents brief: a new agent is announced even before its first chunk streams', async ($, on) => {
  const clock = engine(on, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'live-typing', args: 'agents brief', origin: ORIGIN, presentation: PRES })
  await $.turn.start({ text: 'build', turnId: 'sub', agentId: 'a1' })
  await clock.advance(1000) // the agent's model is still working on its first token
  expect((await band($)) ?? '').toContain('started')
})

// A FOREGROUND helper: Claude's Agent call runs the helper inside it, so Claude's own band shows only
// "● Agent(look around) 12s" until the helper is done.
const LOOKER = [{ id: 'a1', description: 'look around', type: 'Explore', status: 'running' }]
function foreground(on: any, saved: Record<string, unknown>, agents: any[] = LOOKER, steps: Array<Array<any>> = [AGENT_STEP]) {
  const clock: any = engine(on, steps, saved, agents, async (e: any) => {
    if (e.tool === 'Agent') await clock.sleep(30_000) // the helper runs inside the Agent call
    return { result: { stdout: '', stderr: '' } }
  })
  return clock
}

test("agents full: while Claude only waits on a foreground helper, the helper's typing shows in the main view", async ($, on) => {
  const clock = foreground(on, FULL)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  void $.tool.call({ tool: 'Agent', description: 'look around', prompt: 'x' } as any)
  await clock.advance(500)
  expect(await band($)).toContain('Agent(look around)') // nothing from the helper yet: Claude's own row
  await agentTurn($)
  await clock.advance(200)
  const shown = await band($)
  expect(shown).toContain('Explore · look around')
  expect(shown).toContain('Looking through')
})

for (const shows of ['off', 'brief'] as const) {
  test(`agents ${shows}: a foreground helper stays Claude's one ● Agent(...) row`, async ($, on) => {
    const clock = foreground(on, { agentsMain: shows })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 'main' })
    void $.tool.call({ tool: 'Agent', description: 'look around', prompt: 'x' } as any)
    await clock.advance(500)
    await agentTurn($)
    await clock.advance(200)
    const shown = (await band($)) ?? ''
    expect(shown).toContain('Agent(look around)')
    expect(shown).not.toContain('Looking through')
  })
}

test('agents full: of several helpers, the main view shows the one Claude waits on', async ($, on) => {
  const agents = [
    { id: 'bg', description: 'tidy the docs', type: 'writer', status: 'running' },
    { id: 'a1', description: 'look around', type: 'Explore', status: 'running' },
  ]
  const clock = foreground(on, FULL, agents, [
    [{ kind: 'text', index: 0, text: 'Tidying the docs, one file at a time, ' }, 'HANG'],
    AGENT_STEP,
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'x', turnId: 'tbg', agentId: 'bg' })
  const it = $.turn.step({ turnId: 'tbg', index: 0, model: 'm', messageCount: 1, agentId: 'bg' })[Symbol.asyncIterator]()
  await it.next() // a background helper is busy writing
  await clock.advance(100)
  expect(await band($)).toContain('Tidying') // Claude idle: the busy background helper
  await $.turn.start({ text: 'go', turnId: 'main' })
  void $.tool.call({ tool: 'Agent', description: 'look around', prompt: 'x' } as any)
  await agentTurn($)
  await clock.advance(200)
  const shown = await band($)
  expect(shown).toContain('Looking through')
  expect(shown).not.toContain('Tidying')
})

test('agents full: with several busy helpers, the main view stays on one instead of hopping', async ($, on) => {
  const agents = ['a1', 'a2', 'a3'].map((id, i) => ({ id, description: `task ${i + 1}`, type: `worker-${i + 1}`, status: 'running' }))
  const longText = (id: string) => [{ kind: 'text', index: 0, text: `${id} is explaining something at length, `.repeat(6) }, 'HANG']
  const clock = engine(on, [longText('a1'), longText('a2'), longText('a3')], FULL, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const seen: string[] = []
  const header = async () => (/worker-\d/.exec((await band($)) ?? '') ?? ['-'])[0]
  for (const id of ['a1', 'a2', 'a3']) {
    await $.turn.start({ text: 'x', turnId: 't' + id, agentId: id })
    const it = $.turn.step({ turnId: 't' + id, index: 0, model: 'm', messageCount: 1, agentId: id })[Symbol.asyncIterator]()
    await it.next()
    await clock.advance(100)
    seen.push(await header())
  }
  for (const id of ['a1', 'a3', 'a2', 'a1']) {
    await $.tool.call({ tool: 'Read', file_path: '/x.ts', agentId: id } as any) // a quick tool in the middle of the others' typing
    await clock.advance(100)
    seen.push(await header())
  }
  expect(seen.every((h) => h === 'worker-1')).toBe(true)
})

test('the frame timer stops once everything is idle, even if the band was not drawn again', async ($, on) => {
  let ticks = 0
  on('state.set', (_: any, e: any, next: any) => {
    if (e.key === 'tick') ticks++
    return next(e)
  })
  const clock = engine(on, [[{ kind: 'text', index: 0, text: 'Here is my answer, in quite a few words. '.repeat(16) }, { kind: 'stop', stopReason: 'end_turn', usage: null }]])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  const it = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(1500)
  await band($) // drawn once while it opens (2 rows per draw, it needs ~7)
  while (!(await it.next()).done) {
  }
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: 'x', durationMs: 5, isAborted: false } as any)
  for (let t = 0; t < 10_000; t += 500) await clock.advance(500) // the band is not drawn again (collapsed)
  const before = ticks
  for (let t = 0; t < 5_000; t += 500) await clock.advance(500)
  expect(ticks - before).toBe(0)
})

test('a resumed agent does not say "finished ✓" while it works again', async ($, on) => {
  const long = [{ kind: 'text', index: 0, text: 'Done with the first part, here is a long summary of it. '.repeat(4) }, { kind: 'stop', stopReason: 'end_turn', usage: null }]
  const clock = engine(on, [long], FULL)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 's1', agentId: 'a1' })
  for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: 'm', messageCount: 1, agentId: 'a1' })) {
  }
  await $.turn.complete({ turnId: 's1', agentId: 'a1', reason: 'answer', answer: 'x', durationMs: 5, isAborted: false } as any)
  await clock.advance(100) // still typing its last text, now as "finished ✓"
  await $.turn.start({ text: 'one more thing', turnId: 's2', agentId: 'a1' }) // woken again
  for (let t = 0; t < 6000; t += 500) await clock.advance(500) // its model is thinking about the new message
  const shown = (await band($)) ?? ''
  expect(shown).toContain('code-reviewer')
  expect(shown).not.toContain('finished ✓')
})

test('the typed part never ends in half an emoji', async ($, on) => {
  const clock = engine(on, [[{ kind: 'text', index: 0, text: 'Ready 🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉 ok' }, 'HANG']])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  const s = $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
  await s.next()
  let lone = 0
  for (let t = 0; t < 40; t++) {
    await clock.advance(33)
    const shown = (await band($)) ?? ''
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|�/.test(shown)) lone++ // a lone half may arrive here as U+FFFD
  }
  expect(lone).toBe(0)
})

// The engine skips a band whose Text or Code holds a control character other than tab and newline
// ("a text child holds a control character (an escape sequence)"). Command output often has escape
// sequences beyond colours: window titles, links, charset and cursor codes.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
test('escape sequences from a command, its input or a reply never reach the band', async ($, on) => {
  const clock = engine(on, [[
    { kind: 'text', index: 0, text: 'Checking the \x1b[1mbuild\x1b[0m\x07 now.' },
    { kind: 'tool', index: 1, id: 'esc1', name: 'Bash' },
    { kind: 'input', index: 1, json: '{"command":"printf \\"\\u001b[31mred\\b\\f\\"","description":"Colour \\u001b]0;title\\u0007test"}' },
    { kind: 'stop', stopReason: 'tool_use', usage: null },
  ]], {}, [], () => ({
    result: {
      stdout: '\x1b]0;C:\\WINDOWS\\system32\\cmd.exe\x07\x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\ ready\r\n\x1b(B\x1b[mbuild \x1b[>4;2mok\x1b7\x1b8\x00\n',
      stderr: '',
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  const shown: Array<string | null> = []
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
    await clock.advance(40)
    shown.push(await band($))
  }
  await clock.advance(400)
  shown.push(await band($))
  await $.tool.call({ tool: 'Bash', command: 'printf red', description: 'Colour test', tool_use_id: 'esc1' } as any)
  await clock.advance(200)
  const after = await band($)
  shown.push(after)
  for (const s of shown) expect(s ?? '').not.toMatch(CONTROL)
  expect(after).toContain('docs ready')
  expect(after).toContain('build ok')
})

// What the engine answers for a command that failed: the error the model reads (its exit code, then what
// it printed), as `text` and as a string `result`; never the record with stdout and stderr.
const failed = (said: string) => () => ({ result: 'Error: ' + said, text: said, isError: true })

async function runTool($: any, clock: any, tool: string, id: string, input: Record<string, unknown>) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main' })
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'm', messageCount: 1 })) {
  }
  await clock.advance(400)
  await $.tool.call({ tool, ...input, tool_use_id: id } as any)
  await clock.advance(200)
  return band($)
}

for (const tool of ['Bash', 'PowerShell']) {
  test(`a ${tool} command that failed shows its exit code and what it printed, not just ✗`, async ($, on) => {
    const input = { command: 'npm run build', description: 'Build it' }
    const clock = engine(on, [[
      { kind: 'tool', index: 0, id: 'f1', name: tool },
      { kind: 'input', index: 0, json: JSON.stringify(input) },
      { kind: 'stop', stopReason: 'tool_use', usage: null },
    ]], {}, [], failed('Exit code 3\nCompiling 12 files\r\nsrc/a.ts(4,7): error TS2304: Cannot find name \x1b[31mfoo\x1b[0m.'))
    const after = await runTool($, clock, tool, 'f1', input)
    expect(after).toContain('✗')
    expect(after).toContain('Exit code 3')
    expect(after).toContain('Compiling 12 files')
    expect(after).toContain('Cannot find name foo.')
    expect(after ?? '').not.toMatch(CONTROL)
  })
}

test('a failed tool that is no command keeps its one row: its error is not shown as output', async ($, on) => {
  const input = { file_path: '/nope/missing.txt' }
  const clock = engine(on, [[
    { kind: 'tool', index: 0, id: 'r1', name: 'Read' },
    { kind: 'input', index: 0, json: JSON.stringify(input) },
    { kind: 'stop', stopReason: 'tool_use', usage: null },
  ]], {}, [], failed('File does not exist.'))
  const after = await runTool($, clock, 'Read', 'r1', input)
  expect(after).toContain('Read')
  expect(after).toContain('missing.txt')
  expect(after).not.toContain('File does not exist')
})
