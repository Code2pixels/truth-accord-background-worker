import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ScopeGateService, cosineSimilarity, SCOPE_ANCHORS } from './scope-gate.service.ts'

// Anchor order is politics, world, law, other.
const POLITICAL = [1, 0]
const OFF_TOPIC = [0, 1]

/** Embeds anchors by their known text, and any other input by a lookup table. */
function fakeEmbed(byText: Record<string, number[]>) {
  const calls: string[][] = []
  const fn = async (inputs: string[]) => {
    calls.push(inputs)
    return inputs.map((input) => {
      if (input === SCOPE_ANCHORS['politics']) return POLITICAL
      if (input === SCOPE_ANCHORS['world']) return [0.95, 0.05]
      if (input === SCOPE_ANCHORS['law']) return [0.9, 0.1]
      if (input === SCOPE_ANCHORS['other']) return OFF_TOPIC
      return byText[input] ?? [0.5, 0.5]
    })
  }
  return { fn, calls }
}

const originalEnabled = process.env['SCOPE_GATE_ENABLED']

describe('ScopeGateService', () => {
  beforeEach(() => { delete process.env['SCOPE_GATE_ENABLED'] })
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env['SCOPE_GATE_ENABLED']
    else process.env['SCOPE_GATE_ENABLED'] = originalEnabled
  })

  it('keeps a political headline', async () => {
    const { fn } = fakeEmbed({ 'Senate passes budget bill': POLITICAL })
    const [keep] = await new ScopeGateService(fn).keep(['Senate passes budget bill'])
    assert.equal(keep, true)
  })

  it('drops an off-topic headline', async () => {
    const { fn } = fakeEmbed({ 'Best headphone deals this week': OFF_TOPIC })
    const [keep] = await new ScopeGateService(fn).keep(['Best headphone deals this week'])
    assert.equal(keep, false)
  })

  it('keeps a near-tie for the research service to judge', async () => {
    const { fn } = fakeEmbed({ borderline: [0.45, 0.55] })
    const [keep] = await new ScopeGateService(fn, 0.5).keep(['borderline'])
    assert.equal(keep, true)
  })

  it('embeds the anchors once, not once per batch', async () => {
    const { fn, calls } = fakeEmbed({})
    const gate = new ScopeGateService(fn)
    await gate.keep(['a'])
    await gate.keep(['b'])
    await gate.keep(['c'])
    // One anchor call, then one call per batch.
    assert.equal(calls.length, 4)
  })

  it('sends the whole batch in a single embedding call', async () => {
    const { fn, calls } = fakeEmbed({})
    await new ScopeGateService(fn).keep(['a', 'b', 'c', 'd'])
    const batchCall = calls[calls.length - 1]
    assert.equal(batchCall?.length, 4)
  })

  it('keeps everything when the model is unreachable', async () => {
    const gate = new ScopeGateService(async () => null)
    assert.deepEqual(await gate.keep(['a', 'b']), [true, true])
  })

  it('keeps everything when the model returns the wrong number of vectors', async () => {
    const gate = new ScopeGateService(async (inputs) =>
      inputs.length === 4 ? [POLITICAL, POLITICAL, POLITICAL, OFF_TOPIC] : [POLITICAL],
    )
    assert.deepEqual(await gate.keep(['a', 'b']), [true, true])
  })

  it('keeps an item with no usable text', async () => {
    const { fn } = fakeEmbed({ '   ': OFF_TOPIC })
    const [keep] = await new ScopeGateService(fn).keep(['   '])
    assert.equal(keep, true)
  })

  it('can be switched off entirely', async () => {
    process.env['SCOPE_GATE_ENABLED'] = 'false'
    const gate = new ScopeGateService(async () => {
      throw new Error('must not be called when disabled')
    })
    assert.deepEqual(await gate.keep(['anything']), [true])
  })

  it('returns a verdict per item, in order', async () => {
    const { fn } = fakeEmbed({ good: POLITICAL, bad: OFF_TOPIC })
    assert.deepEqual(await new ScopeGateService(fn).keep(['good', 'bad', 'good']), [
      true, false, true,
    ])
  })

  it('guards against zero vectors rather than returning NaN', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
    assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 1]) - 1) < 1e-9)
  })
})

describe('ScopeGateService batching', () => {
  it('splits a large batch into chunks rather than one long request', async () => {
    const sizes: number[] = []
    const embed = async (inputs: string[]) => {
      sizes.push(inputs.length)
      return inputs.map(() => [1, 0])
    }
    await new ScopeGateService(embed).keep(Array.from({ length: 100 }, (_, i) => `item ${i}`))
    // First call is the four anchors; the rest are capped chunks.
    const chunks = sizes.slice(1)
    assert.ok(chunks.length > 1, 'a 100-item batch must be chunked')
    assert.ok(chunks.every((n) => n <= 32), `chunks too large: ${chunks.join(',')}`)
    assert.equal(chunks.reduce((a, b) => a + b, 0), 100)
  })

  it('keeps every item when one chunk fails, rather than dropping half a feed', async () => {
    let call = 0
    const embed = async (inputs: string[]) => {
      call++
      if (call === 3) return null
      return inputs.map(() => [0, 1])
    }
    const verdicts = await new ScopeGateService(embed).keep(
      Array.from({ length: 100 }, (_, i) => `item ${i}`),
    )
    assert.equal(verdicts.length, 100)
    assert.ok(verdicts.every(Boolean), 'a partial failure must fail open for the whole batch')
  })
})
