import { XMLParser } from 'fast-xml-parser'
import { STOP_WORDS } from '../../config/reference.config.ts'
import { isAllowedTopic } from '../topic-classifier.ts'
import type { ReferenceSitesRepository, ReferenceSiteRecord } from '../../repositories/reference-sites.repository.ts'

const MIN_WORD_LENGTH = Number(process.env['REFERENCE_MIN_WORD_LENGTH'] ?? 4)
const MIN_KEYWORD_MATCH = Number(process.env['REFERENCE_MIN_KEYWORD_MATCH'] ?? 2)
const FEED_TIMEOUT_MS = Number(process.env['SEARCH_FEED_TIMEOUT_MS'] ?? 8_000)

export interface SimilarArticleItem {
  url: string
  title: string | null
  sourceDomain: string
  matchedKeywords: string[]
  similarityScore: number
}

export class ReferenceSitesCrawlService {
  private readonly parser: XMLParser
  private cachedSites: ReferenceSiteRecord[] | null = null

  constructor(private readonly referenceSitesRepo: ReferenceSitesRepository) {
    this.parser = new XMLParser({ ignoreDeclaration: true, ignoreAttributes: false, trimValues: true })
  }

  private async getSites(): Promise<ReferenceSiteRecord[]> {
    if (!this.cachedSites) {
      this.cachedSites = await this.referenceSitesRepo.findAll()
    }
    return this.cachedSites
  }

  async getTrustScore(domain: string | null | undefined): Promise<number | null> {
    if (!domain) return null
    const norm = domain.toLowerCase().trim().replace(/^www\./, '')
    const sites = await this.getSites()
    return sites.find((s) => s.domain === norm)?.trustScore ?? null
  }

  async getMatchingArticles(originalTitle: string, originalMeta: string, content = ''): Promise<{ count: number; items: SimilarArticleItem[] }> {
    const keywords = this.extractKeywords(originalTitle, originalMeta)
    if (keywords.size < MIN_KEYWORD_MATCH) return { count: 0, items: [] }

    const titleBigrams = this.extractBigrams(originalTitle)
    const namedEntities = this.extractNamedEntities(content)

    const sites = await this.getSites()
    const allItems: SimilarArticleItem[] = []

    await Promise.all(
      sites.map(async (site) => {
        const items = await this.getMatchesInFeed(site.feedUrl, site.domain, keywords, titleBigrams, namedEntities)
        allItems.push(...items)
      }),
    )

    return { count: allItems.length, items: allItems }
  }

  async getMatchingArticleCount(originalTitle: string, originalMeta: string, content = ''): Promise<number> {
    const { count } = await this.getMatchingArticles(originalTitle, originalMeta, content)
    return count
  }

  async searchFeedsByTerm(term: string, limit = 20): Promise<{ urls: string[]; totalFound: number }> {
    const keywords = this.getSearchTermKeywords(term)
    if (keywords.size < 1) return { urls: [], totalFound: 0 }

    const sites = await this.getSites()
    const seen = new Set<string>()
    const urls: string[] = []

    await Promise.all(
      sites.map(async (site) => {
        try {
          const res = await globalThis.fetch(site.feedUrl, {
            signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TruthAccordBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
          })
          const xml = await res.text()
          const items = this.getFeedItems(xml)
          for (const it of items) {
            const matched = this.getMatchedKeywords(it.title, it.description, keywords)
            if (matched.length < 1) continue
            const url = it.url?.trim()
            if (!url || !url.startsWith('http') || seen.has(url)) continue
            seen.add(url)
            urls.push(url)
          }
        } catch (err) {
          console.warn(`[ReferenceCrawl] Feed search failed: ${site.feedUrl}`, err instanceof Error ? err.message : err)
        }
      }),
    )

    return { urls: urls.slice(0, limit), totalFound: urls.length }
  }

  private extractBigrams(title: string): Set<string> {
    const words = title.toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean)
    const set = new Set<string>()
    for (let i = 0; i < words.length - 1; i++) {
      const wordA = words[i]
      const wordB = words[i + 1]
      if (!wordA || !wordB) continue
      const a = wordA.replace(/^['-]+|['-]+$/g, '')
      const b = wordB.replace(/^['-]+|['-]+$/g, '')
      if (a.length >= MIN_WORD_LENGTH && b.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(a) && !STOP_WORDS.has(b)) {
        set.add(`${a} ${b}`)
      }
    }
    return set
  }

  private extractNamedEntities(content: string): Set<string> {
    const set = new Set<string>()
    if (!content.trim()) return set

    // Only extract runs of 2–3 consecutive capitalised tokens — single capitalised words
    // are too ambiguous (sentence openers, common nouns) to be reliable signals.
    const sentences = content.split(/(?<=[.!?])\s+/)
    for (const sentence of sentences) {
      const tokens = sentence.trim().split(/\s+/)
      let i = 0
      while (i < tokens.length) {
        const rawToken = tokens[i]
        if (!rawToken) { i++; continue }
        const token = rawToken.replace(/[^A-Za-z'-]/g, '')
        if (token.length >= 3 && /^[A-Z]/.test(token) && !STOP_WORDS.has(token.toLowerCase())) {
          const run: string[] = [token]
          let j = i + 1
          while (j < tokens.length && run.length < 3) {
            const rawNext = tokens[j]
            if (!rawNext) break
            const next = rawNext.replace(/[^A-Za-z'-]/g, '')
            if (next.length >= 2 && /^[A-Z]/.test(next)) {
              run.push(next)
              j++
            } else break
          }
          if (run.length >= 2) set.add(run.join(' '))
          i = j
        } else {
          i++
        }
      }
    }
    return set
  }

  private extractKeywords(title: string, meta: string): Set<string> {
    const text = [title, meta].filter(Boolean).join(' ').toLowerCase()
    const words = text.replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean)
    const set = new Set<string>()
    for (const w of words) {
      const clean = w.replace(/^['-]+|['-]+$/g, '')
      if (clean.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(clean)) set.add(clean)
    }
    return set
  }

  private getSearchTermKeywords(term: string): Set<string> {
    const text = term.trim().toLowerCase()
    if (!text) return new Set()
    const words = text.replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean)
    const set = new Set<string>()
    for (const w of words) {
      const clean = w.replace(/^['-]+|['-]+$/g, '')
      if (clean.length >= 2 && !STOP_WORDS.has(clean)) set.add(clean)
    }
    return set
  }

  private getMatchedKeywords(itemTitle: string, itemDesc: string, keywords: Set<string>): string[] {
    const text = [itemTitle, itemDesc].filter(Boolean).join(' ').toLowerCase()
    return [...keywords].filter((kw) => text.includes(kw))
  }

  private getFeedItems(xml: string): { title: string; description: string; url: string }[] {
    try {
      const parsed = this.parser.parse(xml) as Record<string, unknown>
      const items: { title: string; description: string; url: string }[] = []

      const one = (obj: unknown, tag: string): string => {
        if (typeof obj !== 'object' || obj === null || !(tag in (obj as Record<string, unknown>))) return ''
        const v = (obj as Record<string, unknown>)[tag]
        if (typeof v === 'string') return v
        if (typeof v === 'object' && v !== null && '#text' in (v as Record<string, unknown>))
          return String((v as Record<string, unknown>)['#text'] ?? '')
        return String(v ?? '')
      }

      const linkFromAtom = (obj: unknown): string => {
        const link = (obj as Record<string, unknown>).link
        const hrefFrom = (l: unknown): string => {
          if (!l || typeof l !== 'object') return ''
          const attrs = (l as Record<string, unknown>)['@_']
          if (attrs && typeof attrs === 'object' && 'href' in (attrs as object))
            return String((attrs as Record<string, string>).href ?? '')
          return ''
        }
        if (Array.isArray(link)) {
          const alt = link.find((l: unknown) => {
            const attrs = (l as Record<string, unknown>)['@_']
            return attrs && typeof attrs === 'object' && (attrs as Record<string, string>).rel !== 'self'
          })
          return hrefFrom(alt ?? link[0]) || ''
        }
        return hrefFrom(link) || ''
      }

      if (parsed.rss && typeof parsed.rss === 'object') {
        const channel = (parsed.rss as Record<string, unknown>).channel
        if (channel && typeof channel === 'object') {
          const rawItems = (channel as Record<string, unknown>).item
          const arr = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : []
          for (const it of arr) {
            const t = one(it, 'title')
            const d = one(it, 'description') || one(it, 'content:encoded') || one(it, 'content')
            const url = one(it, 'link')
            if (url && url.startsWith('http')) items.push({ title: t, description: typeof d === 'string' ? d : '', url })
          }
        }
      } else if (parsed.feed && typeof parsed.feed === 'object') {
        const rawEntries = (parsed.feed as Record<string, unknown>).entry
        const arr = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : []
        for (const it of arr) {
          const t = one(it, 'title')
          const sum = (it as Record<string, unknown>).summary
          const cont = (it as Record<string, unknown>).content
          const d = typeof sum === 'string' ? sum : typeof cont === 'string' ? cont : ''
          const url = linkFromAtom(it) || one(it, 'id')
          if (url && url.startsWith('http')) items.push({ title: t, description: d, url })
        }
      }
      return items
    } catch {
      return []
    }
  }

  private async getMatchesInFeed(
    feedUrl: string,
    sourceDomain: string,
    keywords: Set<string>,
    titleBigrams: Set<string>,
    namedEntities: Set<string>,
  ): Promise<SimilarArticleItem[]> {
    try {
      const res = await globalThis.fetch(feedUrl, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TruthAccordBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
      })
      const xml = await res.text()
      const items = this.getFeedItems(xml)
      const out: SimilarArticleItem[] = []

      for (const it of items) {
        const candidateText = `${it.title} ${it.description}`.toLowerCase()

        // Hard filter: unigram minimum — only gate; bigrams/entities are scoring signals only
        const matchedKeywords = this.getMatchedKeywords(it.title, it.description, keywords)
        if (matchedKeywords.length < MIN_KEYWORD_MATCH) continue

        if (!isAllowedTopic(`${it.title} ${it.description}`)) continue

        // Weighted score
        const totalKeywords = keywords.size
        const unigramRatio = totalKeywords > 0 ? matchedKeywords.length / totalKeywords : 0

        const matchedBigrams = titleBigrams.size > 0
          ? [...titleBigrams].filter((bg) => candidateText.includes(bg)).length
          : 0
        const bigramRatio = titleBigrams.size > 0 ? matchedBigrams / titleBigrams.size : 0

        const matchedEntities = namedEntities.size > 0
          ? [...namedEntities].filter((e) => candidateText.includes(e.toLowerCase())).length
          : 0
        const entityRatio = namedEntities.size > 0 ? matchedEntities / namedEntities.size : 0

        // If a signal type is absent, redistribute its weight to unigrams
        const unigramWeight = 0.4 + (titleBigrams.size === 0 ? 0.35 : 0) + (namedEntities.size === 0 ? 0.25 : 0)
        const bigramWeight = titleBigrams.size > 0 ? 0.35 : 0
        const entityWeight = namedEntities.size > 0 ? 0.25 : 0

        const similarityScore = Math.min(1, Math.round(
          (unigramRatio * unigramWeight + bigramRatio * bigramWeight + entityRatio * entityWeight) * 10000
        ) / 10000)

        out.push({ url: it.url, title: it.title || null, sourceDomain, matchedKeywords, similarityScore })
      }
      return out
    } catch (err) {
      console.warn(`[ReferenceCrawl] Feed fetch failed: ${feedUrl}`, err instanceof Error ? err.message : err)
      return []
    }
  }
}
