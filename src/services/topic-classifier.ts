import { TOPIC_KEYWORDS } from '../config/topic-filter.config.ts'

export function isAllowedTopic(text: string): boolean {
  const lower = text.toLowerCase()
  return Object.values(TOPIC_KEYWORDS).some((keywords) =>
    keywords.some((kw) => lower.includes(kw)),
  )
}
