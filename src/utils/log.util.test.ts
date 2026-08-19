import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { colorize, colorsEnabled, tag, jobId, level, step, dim } from './log.util.ts'

const originalNoColor = process.env['NO_COLOR']
const originalForceColor = process.env['FORCE_COLOR']

function reset(): void {
  delete process.env['NO_COLOR']
  delete process.env['FORCE_COLOR']
}

describe('log colors', () => {
  beforeEach(reset)

  afterEach(() => {
    reset()
    if (originalNoColor !== undefined) process.env['NO_COLOR'] = originalNoColor
    if (originalForceColor !== undefined) process.env['FORCE_COLOR'] = originalForceColor
  })

  it('wraps text in an escape sequence when colors are on', () => {
    process.env['FORCE_COLOR'] = '1'
    const out = colorize('hello', '36')
    assert.equal(out, '[36mhello[0m')
  })

  it('returns text untouched when NO_COLOR is set', () => {
    process.env['NO_COLOR'] = '1'
    assert.equal(colorize('hello', '36'), 'hello')
    assert.equal(colorsEnabled(), false)
  })

  it('honours NO_COLOR even when FORCE_COLOR is also set', () => {
    process.env['FORCE_COLOR'] = '1'
    process.env['NO_COLOR'] = '1'
    assert.equal(colorsEnabled(), false)
  })

  it('emits no escape codes when output is redirected to a file', () => {
    // Not a TTY and not forced: piping logs to a file must not embed escapes.
    assert.equal(colorsEnabled(), process.stdout.isTTY === true)
  })

  it('never nests escape sequences when colors are off', () => {
    process.env['NO_COLOR'] = '1'
    const nested = tag('ScrapeWorker') + jobId('abc') + step(1, 4) + dim('x')
    assert.ok(!nested.includes(''))
  })

  it('gives each severity its own color', () => {
    process.env['FORCE_COLOR'] = '1'
    const warn = level('warn', 'careful')
    const error = level('error', 'broken')
    const info = level('info', 'fine')
    assert.notEqual(warn, error)
    assert.notEqual(info, warn)
    assert.ok(warn.includes('careful'))
    assert.ok(error.includes('broken'))
  })

  it('keeps the bracketed shape so log lines stay greppable', () => {
    process.env['NO_COLOR'] = '1'
    assert.equal(tag('ScrapeWorker'), '[ScrapeWorker]')
    assert.equal(jobId('job-1'), '[Job job-1]')
    assert.equal(step(2, 4), '[2/4]')
  })

  it('still contains the plain text when colors are on, for grep -a', () => {
    process.env['FORCE_COLOR'] = '1'
    assert.ok(tag('ScrapeWorker').includes('[ScrapeWorker]'))
    assert.ok(jobId('job-1').includes('[Job job-1]'))
  })
})
