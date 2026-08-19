/**
 * Terminal colours for the worker's logs.
 *
 * The log lines are dense — a single job prints a dozen of them — so colour
 * carries the structure: which component spoke, which job it was about, and
 * whether anything went wrong. The bracketed shape is preserved inside the
 * escape codes so `grep '\[Job abc\]'` still works on a live terminal, and
 * colours switch off entirely when output is redirected.
 *
 * Kept deliberately in step with the research service's formatter
 * (truth-accord-research/src/research/logging_setup.py) so both services read
 * the same way in a terminal.
 */

const RESET = '\x1b[0m'

export const COLORS = {
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  bold: '1',
} as const

export type ColorCode = string

/**
 * Colour is on for an interactive terminal, off when piped to a file or a log
 * collector. NO_COLOR wins over everything (see https://no-color.org).
 */
export function colorsEnabled(): boolean {
  if (process.env['NO_COLOR']) return false
  if (process.env['FORCE_COLOR']) return true
  return process.stdout.isTTY === true
}

export function colorize(text: string, code: ColorCode): string {
  if (!colorsEnabled()) return text
  return `\x1b[${code}m${text}${RESET}`
}

export const dim = (text: string): string => colorize(text, COLORS.dim)
export const bold = (text: string): string => colorize(text, COLORS.bold)

/** A component name: `[ScrapeWorker]`, `[RssFeedWorker]`. */
export function tag(name: string): string {
  return colorize(`[${name}]`, COLORS.cyan)
}

/** A job identifier, coloured so one job's lines can be followed by eye. */
export function jobId(id: string): string {
  return colorize(`[Job ${id}]`, COLORS.magenta)
}

/** A step counter such as `[2/4]`, dimmed so it does not compete with content. */
export function step(current: number, total: number): string {
  return dim(`[${current}/${total}]`)
}

const LEVEL_COLORS: Record<string, ColorCode> = {
  info: COLORS.blue,
  success: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
}

/** Colour a message by severity. */
export function level(kind: keyof typeof LEVEL_COLORS | string, text: string): string {
  return colorize(text, LEVEL_COLORS[kind] ?? COLORS.blue)
}

export const ok = (text: string): string => colorize(text, COLORS.green)
export const warn = (text: string): string => colorize(text, COLORS.yellow)
export const bad = (text: string): string => colorize(text, COLORS.red)

/** A value worth picking out of a line — a URL, a title, a count. */
export const value = (text: string | number): string => bold(String(text))
