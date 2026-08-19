import { CATEGORY_ALIASES, RESEARCH_TARGET_CATEGORIES, TOPIC_KEYWORDS } from '../config/topic-filter.config.ts'

export type FeedCategoryVerdict = 'target' | 'off-target' | 'unknown'

/**
 * What the feed itself says about an item, when it says anything recognisable.
 *
 * Only an explicit, recognised statement counts. Measured across 3043 live feed
 * items, just 45% carry a <category> at all and only 12% of the values map to a
 * known category — the rest are "news", "top", "storytype:standard". So this is
 * a cheap way to skip the obvious, never a way to decide the doubtful: anything
 * unrecognised returns 'unknown' and goes through the normal path.
 */
export function feedCategoryVerdict(rssCategories?: string[]): FeedCategoryVerdict {
  if (!rssCategories?.length) return 'unknown'

  let sawOffTarget = false
  for (const raw of rssCategories) {
    const normalized = CATEGORY_ALIASES[raw.toLowerCase().trim()]
    if (!normalized) continue
    // One matching target category is enough — a story filed under both
    // "politics" and "technology" is still politics.
    if (RESEARCH_TARGET_CATEGORIES.has(normalized)) return 'target'
    sawOffTarget = true
  }
  return sawOffTarget ? 'off-target' : 'unknown'
}

export function classifyTopic(text: string, rssCategories?: string[]): string | null {
  if (rssCategories?.length) {
    for (const raw of rssCategories) {
      const normalized = CATEGORY_ALIASES[raw.toLowerCase().trim()]
      if (normalized) return normalized
    }
  }

  const lower = text.toLowerCase()
  for (const [category, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return category
  }

  return null
}

export function isAllowedTopic(text: string, rssCategories?: string[]): boolean {
  return classifyTopic(text, rssCategories) !== null
}
