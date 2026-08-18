import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StaticScraperService } from './static-scraper.service.ts'

const svc = new StaticScraperService()

const HTML = `
<html><body><article>
  <p>Body text goes here with enough words to count as content.</p>
  <a href="https://www.gov.uk/report">the official report</a>
  <a href="/local/story">related story</a>
  <a href="https://twitter.com/someone/status/1">a tweet</a>
  <a href="#anchor">skip me</a>
  <a href="mailto:x@y.com">skip me too</a>
</article></body></html>`

describe('extractArticleData links', () => {
  it('returns absolute URLs resolved against the page URL', () => {
    const { links } = svc.extractArticleData(HTML, 'https://news.example.com/a/b')
    const urls = links.map((l) => l.url)
    assert.ok(urls.includes('https://www.gov.uk/report'))
    assert.ok(urls.includes('https://news.example.com/local/story'))
  })

  it('captures anchor text', () => {
    const { links } = svc.extractArticleData(HTML, 'https://news.example.com/a/b')
    const gov = links.find((l) => l.url === 'https://www.gov.uk/report')
    assert.equal(gov?.anchor, 'the official report')
  })

  it('skips fragment and non-http links', () => {
    const { links } = svc.extractArticleData(HTML, 'https://news.example.com/a/b')
    const urls = links.map((l) => l.url)
    assert.ok(!urls.some((u) => u.startsWith('mailto:')))
    assert.ok(!urls.some((u) => u.includes('#anchor')))
  })

  it('deduplicates repeated links', () => {
    const dup = '<article><a href="https://a.com/x">one</a><a href="https://a.com/x">two</a></article>'
    const { links } = svc.extractArticleData(dup, 'https://news.example.com/')
    assert.equal(links.filter((l) => l.url === 'https://a.com/x').length, 1)
  })

  it('returns an empty array when there are no links', () => {
    const { links } = svc.extractArticleData('<article><p>no links</p></article>', 'https://x.com/')
    assert.deepEqual(links, [])
  })
})
