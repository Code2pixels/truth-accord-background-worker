import { pool } from '../db/client.ts'

const sources = [
  // ── US Mainstream ─────────────────────────────────────────────────────────
  { name: 'AP News',            url: 'https://apnews.com',              rss_url: 'https://apnews.com/feed' },
  { name: 'Reuters',            url: 'https://reuters.com',             rss_url: 'https://feeds.reuters.com/reuters/topNews' },
  { name: 'NPR',                url: 'https://npr.org',                 rss_url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'PBS NewsHour',       url: 'https://pbs.org/newshour',        rss_url: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
  { name: 'CNN',                url: 'https://cnn.com',                 rss_url: 'http://rss.cnn.com/rss/edition.rss' },
  { name: 'NBC News',           url: 'https://nbcnews.com',             rss_url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
  { name: 'ABC News',           url: 'https://abcnews.go.com',          rss_url: 'https://feeds.abcnews.com/abcnews/topstories' },
  { name: 'CBS News',           url: 'https://cbsnews.com',             rss_url: 'https://www.cbsnews.com/latest/rss/main' },
  { name: 'Fox News',           url: 'https://foxnews.com',             rss_url: 'https://moxie.foxnews.com/google-publisher/latest.xml' },
  { name: 'USA Today',          url: 'https://usatoday.com',            rss_url: 'https://rssfeeds.usatoday.com/usatoday-NewsTopStories' },
  { name: 'The New York Times', url: 'https://nytimes.com',             rss_url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
  { name: 'Washington Post',    url: 'https://washingtonpost.com',      rss_url: 'https://feeds.washingtonpost.com/rss/national' },
  { name: 'Wall Street Journal',url: 'https://wsj.com',                 rss_url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' },
  { name: 'Los Angeles Times',  url: 'https://latimes.com',             rss_url: 'https://www.latimes.com/rss2.0.xml' },
  { name: 'Chicago Tribune',    url: 'https://chicagotribune.com',      rss_url: 'https://www.chicagotribune.com/arc/outboundfeeds/rss/' },
  { name: 'The Hill',           url: 'https://thehill.com',             rss_url: 'https://thehill.com/rss/syndicator/19110' },
  { name: 'Politico',           url: 'https://politico.com',            rss_url: 'https://www.politico.com/rss/politicopicks.xml' },
  { name: 'Axios',              url: 'https://axios.com',               rss_url: 'https://api.axios.com/feed/' },
  { name: 'Time',               url: 'https://time.com',                rss_url: 'https://time.com/feed/' },
  { name: 'Newsweek',           url: 'https://newsweek.com',            rss_url: 'https://www.newsweek.com/rss' },

  // ── US Opinion / Investigative ────────────────────────────────────────────
  { name: 'The Atlantic',       url: 'https://theatlantic.com',         rss_url: 'https://www.theatlantic.com/feed/all/' },
  { name: 'Vox',                url: 'https://vox.com',                 rss_url: 'https://www.vox.com/rss/index.xml' },
  { name: 'Slate',              url: 'https://slate.com',               rss_url: 'https://feeds.slate.com/slate/podcasts-and-blogs' },
  { name: 'Mother Jones',       url: 'https://motherjones.com',         rss_url: 'https://www.motherjones.com/feed/' },
  { name: 'ProPublica',         url: 'https://propublica.org',          rss_url: 'https://feeds.propublica.org/propublica/main' },
  { name: 'The Intercept',      url: 'https://theintercept.com',        rss_url: 'https://theintercept.com/feed/' },
  { name: 'The New Yorker',     url: 'https://newyorker.com',           rss_url: 'https://www.newyorker.com/feed/everything' },
  { name: 'Foreign Policy',     url: 'https://foreignpolicy.com',       rss_url: 'https://foreignpolicy.com/feed/' },
  { name: 'Foreign Affairs',    url: 'https://foreignaffairs.com',      rss_url: 'https://www.foreignaffairs.com/rss.xml' },
  { name: 'National Review',    url: 'https://nationalreview.com',      rss_url: 'https://www.nationalreview.com/feed/' },
  { name: 'The Federalist',     url: 'https://thefederalist.com',       rss_url: 'https://thefederalist.com/feed/' },
  { name: 'Breitbart',          url: 'https://breitbart.com',           rss_url: 'https://feeds.feedburner.com/breitbart' },
  { name: 'Daily Wire',         url: 'https://dailywire.com',           rss_url: 'https://www.dailywire.com/feeds/rss.xml' },
  { name: 'Common Dreams',      url: 'https://commondreams.org',        rss_url: 'https://www.commondreams.org/rss.xml' },
  { name: 'Truthout',           url: 'https://truthout.org',            rss_url: 'https://truthout.org/feed/' },
  { name: 'The Nation',         url: 'https://thenation.com',           rss_url: 'https://www.thenation.com/feed/?post_type=article' },
  { name: 'Salon',              url: 'https://salon.com',               rss_url: 'https://www.salon.com/feed' },

  // ── US Business / Finance ─────────────────────────────────────────────────
  { name: 'Bloomberg',          url: 'https://bloomberg.com',           rss_url: 'https://feeds.bloomberg.com/markets/news.rss' },
  { name: 'CNBC',               url: 'https://cnbc.com',                rss_url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'Forbes',             url: 'https://forbes.com',              rss_url: 'https://www.forbes.com/real-time/feed2/' },
  { name: 'Business Insider',   url: 'https://businessinsider.com',     rss_url: 'https://feeds.businessinsider.com/custom/all' },
  { name: 'MarketWatch',        url: 'https://marketwatch.com',         rss_url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
  { name: 'Fortune',            url: 'https://fortune.com',             rss_url: 'https://fortune.com/feed/' },
  { name: 'The Economist',      url: 'https://economist.com',           rss_url: 'https://www.economist.com/rss/the_world_this_week_rss.xml' },

  // ── UK / Europe ───────────────────────────────────────────────────────────
  { name: 'BBC News',           url: 'https://bbc.co.uk',               rss_url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'The Guardian',       url: 'https://theguardian.com',         rss_url: 'https://www.theguardian.com/world/rss' },
  { name: 'The Independent',    url: 'https://independent.co.uk',       rss_url: 'https://www.independent.co.uk/news/rss' },
  { name: 'The Telegraph',      url: 'https://telegraph.co.uk',         rss_url: 'https://www.telegraph.co.uk/rss.xml' },
  { name: 'Financial Times',    url: 'https://ft.com',                  rss_url: 'https://www.ft.com/rss/home/uk' },
  { name: 'Sky News',           url: 'https://news.sky.com',            rss_url: 'https://feeds.skynews.com/feeds/rss/home.xml' },
  { name: 'The Mirror',         url: 'https://mirror.co.uk',            rss_url: 'https://www.mirror.co.uk/news/?service=rss' },
  { name: 'Daily Mail',         url: 'https://dailymail.co.uk',         rss_url: 'https://www.dailymail.co.uk/articles.rss' },
  { name: 'Deutsche Welle',     url: 'https://dw.com',                  rss_url: 'https://rss.dw.com/rdf/rss-en-all' },
  { name: 'France 24',          url: 'https://france24.com',            rss_url: 'https://www.france24.com/en/rss' },
  { name: 'Euronews',           url: 'https://euronews.com',            rss_url: 'https://www.euronews.com/rss?level=theme&name=news' },
  { name: 'Irish Times',        url: 'https://irishtimes.com',          rss_url: 'https://www.irishtimes.com/rss/' },
  { name: 'Le Monde (EN)',      url: 'https://lemonde.fr',              rss_url: 'https://www.lemonde.fr/en/rss/une.xml' },
  { name: 'Der Spiegel (EN)',   url: 'https://spiegel.de',              rss_url: 'https://www.spiegel.de/international/index.rss' },

  // ── International ─────────────────────────────────────────────────────────
  { name: 'Al Jazeera',         url: 'https://aljazeera.com',           rss_url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'South China Morning Post', url: 'https://scmp.com',          rss_url: 'https://www.scmp.com/rss/91/feed' },
  { name: 'Japan Times',        url: 'https://japantimes.co.jp',        rss_url: 'https://www.japantimes.co.jp/feed/' },
  { name: 'The Hindu',          url: 'https://thehindu.com',            rss_url: 'https://www.thehindu.com/feeder/default.rss' },
  { name: 'Times of India',     url: 'https://timesofindia.com',        rss_url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' },
  { name: 'Haaretz (EN)',       url: 'https://haaretz.com',             rss_url: 'https://www.haaretz.com/cmlink/1.628765' },
  { name: 'Middle East Eye',    url: 'https://middleeasteye.net',       rss_url: 'https://www.middleeasteye.net/rss' },
  { name: 'The Globe and Mail', url: 'https://theglobeandmail.com',     rss_url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/' },
  { name: 'CBC News',           url: 'https://cbc.ca/news',             rss_url: 'https://www.cbc.ca/cmlink/rss-topstories' },
  { name: 'Sydney Morning Herald', url: 'https://smh.com.au',           rss_url: 'https://www.smh.com.au/rss/feed.xml' },
  { name: 'ABC Australia',      url: 'https://abc.net.au/news',         rss_url: 'https://www.abc.net.au/news/feed/51120/rss.xml' },
  { name: 'RT',                 url: 'https://rt.com',                  rss_url: 'https://www.rt.com/rss/' },

  // ── Technology ────────────────────────────────────────────────────────────
  { name: 'Wired',              url: 'https://wired.com',               rss_url: 'https://www.wired.com/feed/rss' },
  { name: 'Ars Technica',       url: 'https://arstechnica.com',         rss_url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'TechCrunch',         url: 'https://techcrunch.com',          rss_url: 'https://techcrunch.com/feed/' },
  { name: 'The Verge',          url: 'https://theverge.com',            rss_url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'Engadget',           url: 'https://engadget.com',            rss_url: 'https://www.engadget.com/rss.xml' },
  { name: 'Gizmodo',            url: 'https://gizmodo.com',             rss_url: 'https://gizmodo.com/rss' },
  { name: 'MIT Technology Review', url: 'https://technologyreview.com', rss_url: 'https://www.technologyreview.com/feed/' },
  { name: 'VentureBeat',        url: 'https://venturebeat.com',         rss_url: 'https://venturebeat.com/feed/' },
  { name: 'ZDNet',              url: 'https://zdnet.com',               rss_url: 'https://www.zdnet.com/news/rss.xml' },

  // ── Science ───────────────────────────────────────────────────────────────
  { name: 'Scientific American', url: 'https://scientificamerican.com', rss_url: 'https://rss.sciam.com/ScientificAmerican-Global' },
  { name: 'New Scientist',       url: 'https://newscientist.com',       rss_url: 'https://www.newscientist.com/feed/home/' },
  { name: 'Nature',              url: 'https://nature.com',             rss_url: 'https://www.nature.com/nature.rss' },
  { name: 'Popular Science',     url: 'https://popsci.com',             rss_url: 'https://www.popsci.com/feed/' },
  { name: 'Space.com',           url: 'https://space.com',              rss_url: 'https://www.space.com/feeds/all' },
  { name: 'Live Science',        url: 'https://livescience.com',        rss_url: 'https://www.livescience.com/feeds/all' },
]

async function run(): Promise<void> {
  console.log(`Seeding ${sources.length} sources...`)
  let inserted = 0
  let skipped = 0

  for (const s of sources) {
    try {
      const res = await pool.query(
        `INSERT INTO sources.records (name, url, rss_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (url) DO NOTHING
         RETURNING id`,
        [s.name, s.url, s.rss_url],
      )
      if (res.rowCount && res.rowCount > 0) {
        console.log(`  ✓ ${s.name}`)
        inserted++
      } else {
        console.log(`  – ${s.name} (already exists)`)
        skipped++
      }
    } catch (err) {
      console.error(`  ✗ ${s.name}: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`\nDone: ${inserted} inserted, ${skipped} skipped`)
  await pool.end()
}

run().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
