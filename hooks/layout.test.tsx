import { expect, mock, test } from 'claude-code/testing'

import type { Band, BlockView, RunRow } from '../types'

// How the band lays itself out in the room it has: given a band, what it draws.

const props = (maxRows: number, bodyColumns: number) =>
  ({
    plugin: 'live-typing',
    component: 'AbovePrompt',
    requestId: 'above',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: true, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
  }) as const

// The engine for these tests: the band the plugin reads is `band` (or what the getter gives now).
function stateWith(on: any, band: Band | null | (() => Band | null)) {
  mock.clock(on, { now: 1_000_000 })
  let version = 1
  on('state.get', (_: unknown, e: any) => {
    const k = e?.key
    if (k === 'band') return { value: { value: typeof band === 'function' ? band() : band, version: version++ } }
    if (k === 'mode') return { value: { value: 'on', version: 1 } }
    if (k === 'tick') return { value: { value: 0, version: 1 } }
    return { value: { value: null, version: 1 } }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
}

const block = (b: Pick<BlockView, 'kind' | 'source'> & Partial<BlockView>): BlockView => ({
  tool: '', path: '', label: '', totalLines: 0, shown: 0, startLine: 0, typing: true, run: null, ...b,
})
const bandOf = (b: Partial<Band>): Band => ({ block: null, rows: [], tail: [], tailMore: 0, blink: true, idle: false, ...b })
const run = (label: string, running = false): RunRow => ({ tool: 'Bash', label, secs: 3, running, isError: false })

// The band's tallest for a window of `maxRows` (about 40% of it, 6 to 18 rows, never past maxRows - 4).
const capOf = (maxRows: number) => Math.max(3, Math.min(maxRows - 4, Math.max(6, Math.min(18, Math.floor(maxRows * 0.4)))))

// The rows a tree takes: a Text is a row, a Code its lines, a row Box its tallest child, a border 2 more.
function rowsOf(node: any): number {
  if (!node || typeof node !== 'object') return 0
  if (node.type === 'Text') return 1
  if (node.type === 'Code') return String(node.props?.source ?? '').split('\n').length
  const kids: any[] = node.children ?? node.props?.children ?? []
  const list = Array.isArray(kids) ? kids : [kids]
  if (node.type === 'Box' && node.props?.flexDirection === 'row') return Math.max(1, ...list.map(rowsOf))
  let n = list.reduce((s, c) => s + rowsOf(c), 0)
  if (node.props?.borderStyle) n += 2
  return n
}
const inner = (tree: any) => (tree.children ?? tree.props?.children)[0]

const code = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')

for (const maxRows of [6, 8, 9, 10, 17, 30, 60]) {
  test(`a code card in a window of ${maxRows} rows stays inside the band`, async ($, on) => {
    stateWith(on, bandOf({
      block: block({ kind: 'code', tool: 'Write', path: '/src/a.ts', label: 'a.ts', source: code + '▌', totalLines: 30, startLine: 1 }),
      rows: [run('npm test', true)],
      tail: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'],
    }))
    let tree: any = null
    for (let i = 0; i < 12; i++) {
      // the band opens a couple of rows per draw
      const ui = await $.ui.mount(props(maxRows, 75) as any)
      tree = await ui.drawn()
      await ui.unmount()
    }
    expect(tree.props.height).toBeLessThanOrEqual(capOf(maxRows))
    if (maxRows >= 9) expect(rowsOf(inner(tree))).toBeLessThanOrEqual(capOf(maxRows)) // and the card's own rows fit it
  })
}

test('a reply never shows its bullet alone on a blank row', async ($, on) => {
  const long = 'word '.repeat(30).trim()
  const short = 'word '.repeat(15).trim()
  let now: Band | null = null
  stateWith(on, () => now)
  for (const source of [`${long}\n\n${long}\n\n${long}`, `${long}\n\n${short}`]) {
    now = bandOf({ block: block({ kind: 'text', source, shown: source.length, typing: false }) })
    for (const maxRows of [9, 10, 11, 12, 13, 14]) {
      const ui = await $.ui.mount(props(maxRows, 40) as any)
      const rows: any[] = inner(await ui.drawn()).children // one Text per row: [bullet or gutter, the row's words, caret]
      await ui.unmount()
      const bullets = rows.filter((r) => typeof r.children?.[0] === 'object') // the bullet is a Text of its own
      expect(bullets).toHaveLength(1)
      expect(String(bullets[0].children[1] ?? '').trim()).not.toBe('')
    }
  }
})

test('rows of a reply are never wider than the band', async ($, on) => {
  const source = 'A fairly long reply that has to wrap over several rows of a narrow terminal window. '.repeat(3)
  stateWith(on, bandOf({ block: block({ kind: 'text', source, shown: source.length, typing: false }) }))
  for (const cols of [20, 40, 80]) {
    const ui = await $.ui.mount(props(40, cols) as any)
    const rows = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text))
    await ui.unmount()
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(cols)
  }
})

test('with nothing to show, the band leaves the engine its place', async ($, on) => {
  stateWith(on, null)
  const ui = await $.ui.mount(props(40, 75) as any)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('ENGINE')
  await ui.unmount()
})

// The band draws on the terminal and on the desktop app, and one session can be open in both. Each has its
// own room for the band, so each keeps its own height. (With one height for both, the one with less room
// held the other's card down to its own few rows.)
test("a smaller second surface drawing the same band does not hold the terminal's band down", async ($, on) => {
  stateWith(on, bandOf({
    block: block({ kind: 'code', tool: 'Write', path: '/src/a.ts', label: 'a.ts', source: code + '▌', totalLines: 30, startLine: 1 }),
  }))
  const draw = async (surface: string, maxRows: number) => {
    const ui = await $.ui.mount({ ...props(maxRows, 75), surface, requestId: 'above-' + surface } as any)
    const tree: any = await ui.drawn()
    await ui.unmount()
    return tree.props.height as number
  }
  let terminal = 0
  let desktop = 0
  for (let i = 0; i < 12; i++) {
    // both redraw on every frame
    terminal = await draw('terminal', 40)
    desktop = await draw('desktop', 8)
  }
  expect(terminal).toBe(capOf(40)) // 16 rows: the whole card
  expect(desktop).toBe(capOf(8)) // 4 rows: all the room the other one has
})
