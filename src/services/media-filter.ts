/**
 * Video packages are not articles.
 *
 * A clip with a one-line caption has no body text to classify, no outbound
 * links to weigh, and nothing for the research service to corroborate — it costs
 * a fetch, a row and a research job to reach the same dead end every time.
 *
 * The trap is over-matching: "Video game industry faces new regulation" is an
 * ordinary story that happens to start with the word. So a bare "Video" prefix
 * only counts when the next word is not part of a compound noun.
 */

/** Compound nouns where a leading "Video" belongs to the subject, not a label. */
const VIDEO_COMPOUNDS = [
  'game',
  'games',
  'gaming',
  'call',
  'calls',
  'conferencing',
  'conference',
  'assistant',
  'evidence',
  'footage',
  'streaming',
  'platform',
  'platforms',
  'app',
  'apps',
  'surveillance',
  'doorbell',
]

/** "Watch out for scams" is advice, not a clip. */
const WATCH_EXCEPTIONS = ['out', 'this', 'closely', 'carefully']

/**
 * An explicit format label: "Video:", "VIDEO |", "Video - ", "Watch:".
 * The period matters — euronews files every clip as "Video. Headline here".
 */
const LABEL_PREFIX = /^\s*(video|watch)\s*[:|.–—-]/i

/**
 * A bare prefix with no separator at all, e.g. "Video Marine One suffers a
 * failure" or RT's "WATCH huge blasts rock warehouse".
 */
const BARE_PREFIX = /^\s*(video|watch)\s+([a-z'’]+)/i

/** Publishers such as the Guardian suffix these: "Trump speech in full – video". */
const LABEL_SUFFIX = /[|–—-]\s*video\s*$/i

export function isVideoArticle(title: string | null | undefined): boolean {
  if (!title || !title.trim()) return false

  if (LABEL_PREFIX.test(title)) return true
  if (LABEL_SUFFIX.test(title)) return true

  const bare = BARE_PREFIX.exec(title)
  if (bare) {
    const label = (bare[1] ?? '').toLowerCase()
    const nextWord = (bare[2] ?? '').toLowerCase()
    const exceptions = label === 'watch' ? WATCH_EXCEPTIONS : VIDEO_COMPOUNDS
    return !exceptions.includes(nextWord)
  }

  return false
}
