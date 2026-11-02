/**
 * on (default): the band above the prompt shows what Claude is doing, from the real stream, typed quickly:
 *   thinking, reply text, commands and code as they are written, tools running and their output.
 * demo: the same at a calm pace, and before a tool runs it waits until the text written before it
 *   could be read. Lasts one reply, then back to on or off, whichever was chosen last. Never remembered.
 * off: nothing.
 * On and off are remembered across sessions.
 */
export type Mode = 'on' | 'demo' | 'off'

/**
 * Helper agents in the main conversation's view (their own view, opened from the tasks list, always shows them):
 * full = their band under their name (while Claude is idle, or only waiting on them);
 * brief = a short name row for a few seconds when an agent starts, finishes, or was just folded;
 * off (default) = nothing. Remembered across sessions; ▾ hide next to the name switches to brief, ▸ show back to full.
 */
export type AgentsMain = 'full' | 'brief' | 'off'

/** Which setting the picker's focus starts on. */
export type PickerGroup = 'typing' | 'agents'

/** A tool call's state, as a row or as a code card's header. */
export type RunRow = {
  tool: string
  label: string
  /** Whole seconds since it started (or how long it took). */
  secs: number
  running: boolean
  isError: boolean
}

/** The block being typed. */
export type BlockView = {
  /** think = thinking, text = a reply, code = a file or command being written, line = any other tool call. */
  kind: 'think' | 'text' | 'code' | 'line'
  /** The tool's name ('' for text and thinking). */
  tool: string
  /** The file being written, full path, once it has fully arrived ('' until then, and for commands). */
  path: string
  /** For code: what the header names: the file's name, or a command's description. */
  label: string
  /** For code: how many lines are typed in all (`source` holds the last of them). */
  totalLines: number
  /**
   * code / line: what has been typed so far (its tail), caret included while typing.
   * text / think: everything received so far (its tail, markdown marks removed), no caret;
   * `shown` says how much of it is typed, so rows are laid out on the whole text and a word
   * being typed never jumps to the next row.
   */
  source: string
  /** text / think: how many characters of `source` are typed. */
  shown: number
  /** For code: the 1-based number of the first line in `source`, or 0 for no line numbers. */
  startLine: number
  /** True while it is still being typed. */
  typing: boolean
  /** For code: its tool call once it runs (drawn in the card's header instead of a row of its own). */
  run: RunRow | null
}

/** What the band above the prompt draws. */
export type Band = {
  block: BlockView | null
  /** Tool calls running or just finished (not the one the block shows). */
  rows: RunRow[]
  /** The last lines of a finished command's output (the block's own command, else the latest one). */
  tail: string[]
  /** How many output lines came before `tail`. */
  tailMore: number
  /** Blink phase for running markers. */
  blink: boolean
  /** Nothing new is happening (the model is between steps): drawn dim, no caret. */
  idle: boolean
  /**
   * Fullscreen: the reply being written types in its own row in the transcript, where it will land,
   * so the band draws nothing for it (and closes). Absent otherwise.
   */
  inflow?: boolean
  /** A helper agent's band: its name (type · task), shown as a header in the main view. Absent for the main conversation. */
  who?: string
  /** A helper agent's band: the task its Agent call named, so the main view can tell which helper Claude waits on. */
  task?: string
  /** A helper agent's band: when it last streamed or ran something (ms), so the main view shows the busiest one. */
  at?: number
  /** A helper agent's band: its name row shows even with agents set to brief, for now: it just started, finished, or was just folded. */
  named?: boolean
  /** With `named`: why ("started", "finished ✓"); absent: the row says what the agent is doing. */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'live-typing': {
      /**
       * Bumped every frame while a reply types in the transcript (its own row, or the message it handed over to)
       * or the band opens/closes; readers redraw.
       */
      tick: number
      band: Band | null
      /** Helper agents' bands, by agent id (only those with something to show). */
      agents: Record<string, Band>
      /** How helper agents show in the main view (mirrors the store, so the band redraws on a change). */
      agentsMain: AgentsMain
      mode: Mode
      /** The picker option the keyboard is on (`typing:on`, `agents:brief`, ...), '' for none. */
      pickerFocus: string
      /** Which setting the picker's focus starts on when it opens. */
      pickerStart: PickerGroup
    }
  }
}
