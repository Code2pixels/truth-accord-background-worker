import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isVideoArticle } from './media-filter.ts'

describe('isVideoArticle', () => {
  const videos = [
    'Video: Marine One suffers communication failure',
    'Video Marine One suffers communication failure',
    'VIDEO: Senate passes budget bill',
    'video: protests continue in the capital',
    'Video | Inside the ceasefire talks',
    'Video - What the ruling means',
    'Video – Election night in five minutes',
    'WATCH: President addresses the nation',
    'Watch: the moment the verdict was read',
    'Trump speech in full – video',
    'The ruling explained - video',
    'Election results roundup | video',
    // Real titles from the corpus: euronews separates with a period, RT uses no
    // separator at all, and both had been reaching the research service.
    'Video. Nepal flood death toll passes 900 as search for survivors continues',
    'Video. Draghi’s new Rhine Group wants to fix Europe',
    'WATCH huge blasts rock ‘missile warehouse’ near Kiev',
    'Watch: Grand Canyon flash flood sends bunkhouse downstream',
  ]
  for (const title of videos) {
    it(`drops ${JSON.stringify(title)}`, () => {
      assert.equal(isVideoArticle(title), true)
    })
  }

  // Stories *about* video are ordinary articles and must survive.
  const articles = [
    'Video game industry faces new regulation',
    'Video games are the new battleground for regulators',
    'Video call evidence admitted in landmark trial',
    'Video conferencing firm sued over privacy',
    'Video assistant referee decision sparks review',
    'Videos of the strike were verified by investigators',
    'Senate passes budget bill',
    'Court blocks road through wildlife refuge',
    'How a viral video changed the campaign',
    'Provider releases video evidence in court case',
    // "Watch" as an ordinary word must survive.
    'Watch out for these scams, regulator warns',
    'Watchdog criticises minister over spending',
    'Watchmaker fined over misleading adverts',
  ]
  for (const title of articles) {
    it(`keeps ${JSON.stringify(title)}`, () => {
      assert.equal(isVideoArticle(title), false)
    })
  }

  it('handles empty and missing titles', () => {
    assert.equal(isVideoArticle(''), false)
    assert.equal(isVideoArticle(null), false)
    assert.equal(isVideoArticle(undefined), false)
  })

  it('ignores surrounding whitespace', () => {
    assert.equal(isVideoArticle('   Video: something happened  '), true)
  })
})
