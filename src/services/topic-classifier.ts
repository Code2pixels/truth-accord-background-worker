import { CATEGORY_ALIASES, TOPIC_KEYWORDS } from '../config/topic-filter.config.ts'

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
