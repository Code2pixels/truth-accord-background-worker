export interface ReferenceSite {
  domain: string
  /** Trust score 0–1; higher = more trusted. */
  trustScore: number
  /** RSS/Atom feed URL for crawling similar articles. Omit if no public feed. */
  feedUrl?: string
}

export const REFERENCE_SITES: readonly ReferenceSite[] = [
  // Wire services & agencies
  { domain: 'reuters.com', trustScore: 0.92, feedUrl: 'https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best' },
  { domain: 'apnews.com', trustScore: 0.92, feedUrl: 'https://apnews.com/apf-topnews' },
  { domain: 'associatedpress.com', trustScore: 0.9 },
  { domain: 'afp.com', trustScore: 0.88 },
  { domain: 'upi.com', trustScore: 0.78, feedUrl: 'https://www.upi.com/News_Archive/rss' },
  // US public broadcast & major networks
  { domain: 'npr.org', trustScore: 0.86, feedUrl: 'https://feeds.npr.org/1001/rss.xml' },
  { domain: 'pbs.org', trustScore: 0.86, feedUrl: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
  { domain: 'cbsnews.com', trustScore: 0.84, feedUrl: 'https://www.cbsnews.com/feeds/rss/home.rss' },
  // UK & international broadcasters
  { domain: 'bbc.com', trustScore: 0.88, feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { domain: 'bbc.co.uk', trustScore: 0.88, feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { domain: 'dw.com', trustScore: 0.84, feedUrl: 'https://rss.dw.com/xml/rss-en-all' },
  { domain: 'france24.com', trustScore: 0.82, feedUrl: 'https://www.france24.com/en/rss' },
  { domain: 'aljazeera.com', trustScore: 0.8, feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { domain: 'cbc.ca', trustScore: 0.86, feedUrl: 'https://www.cbc.ca/cmlink/rss-topstories' },
  // US & UK newspapers
  { domain: 'nytimes.com', trustScore: 0.86, feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
  { domain: 'washingtonpost.com', trustScore: 0.84, feedUrl: 'https://feeds.washingtonpost.com/rss/world' },
  { domain: 'theguardian.com', trustScore: 0.84, feedUrl: 'https://www.theguardian.com/world/rss' },
  { domain: 'wsj.com', trustScore: 0.84, feedUrl: 'https://feeds.content.dowjones.io/public/rss/topstories' },
  { domain: 'economist.com', trustScore: 0.86, feedUrl: 'https://www.economist.com/full/rss.xml' },
  { domain: 'csmonitor.com', trustScore: 0.84, feedUrl: 'https://rss.csmonitor.com/feeds/world' },
  // Politics & policy
  { domain: 'politico.com', trustScore: 0.82, feedUrl: 'https://www.politico.com/rss/politics08.xml' },
  { domain: 'thehill.com', trustScore: 0.8, feedUrl: 'https://thehill.com/homenews/feed/' },
  // Business & tech
  { domain: 'bloomberg.com', trustScore: 0.86, feedUrl: 'https://www.bloomberg.com/politics/feeds/site.xml' },
  // Cable & digital
  { domain: 'cnn.com', trustScore: 0.8, feedUrl: 'https://rss.cnn.com/rss/cnn_topstories.rss' },
  // Investigative & science
  { domain: 'propublica.org', trustScore: 0.88, feedUrl: 'https://www.propublica.org/feeds/propublica/main' },
  { domain: 'nature.com', trustScore: 0.9, feedUrl: 'https://www.nature.com/nature.rss' },
  { domain: 'science.org', trustScore: 0.9, feedUrl: 'https://www.science.org/rss/news_current.xml' },
  // Additional perspective
  { domain: 'foxnews.com', trustScore: 0.55, feedUrl: 'https://moxie.foxnews.com/google-publisher/latest.xml' },
] as const

const STOP_WORDS_LIST = [
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'his',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'how', 'its', 'may', 'new',
  'now', 'old', 'see', 'way', 'who', 'did', 'has', 'her', 'him', 'his', 'say', 'she',
  'too', 'use', 'that', 'with', 'this', 'from', 'have', 'will', 'your', 'they', 'been',
  'more', 'when', 'would', 'there', 'their', 'what', 'about', 'which', 'could', 'should',
  'if', 'on', 'in', 'an', 'at', 'as', 'it', 'so', 'by', 'do', 'to', 'of', 'a', 'is', 'or',
  'be', 'no', 'up', 'down', 'over', 'under', 'into', 'out', 'before', 'after', 'off',
  'just', 'like', 'than', 'then', 'such', 'these', 'those', 'them', 'very', 'much',
  'any', 'each', 'other', 'some', 'also', 'were', 'because',
]

export const STOP_WORDS = new Set(STOP_WORDS_LIST.map((w) => w.toLowerCase()))
