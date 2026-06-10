export interface ScrapedArticle {
  url: string
  title: string | null
  content: string | null
  author: string | null
  publishedAt: string | null
  metaDescription: string | null
  wordCount: number | null
  isArchived: boolean
  snapshotTimestamp: string | null
  paywallDetected: boolean
}

export interface ScraperOptions {
  forceStatic?: boolean
  forceDynamic?: boolean
}

export interface RawPageData {
  html: string
  url: string
  usedBrowser: boolean
}

export interface ExtractedArticleData {
  title: string | null
  content: string | null
  author: string | null
  publishedAt: string | null
  metaDescription: string | null
  wordCount: number | null
}

export interface PaywallSignals {
  hasPaywallKeyword: boolean
  hasSubscribeModal: boolean
  isContentEmpty: boolean
  wordCountBelowThreshold: boolean
}
