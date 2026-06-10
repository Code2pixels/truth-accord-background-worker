export function stripUtmParams(url: string): string {
  try {
    const parsed = new URL(url)
    const toDelete: string[] = []
    parsed.searchParams.forEach((_, key) => {
      if (key.toLowerCase().startsWith('utm_')) toDelete.push(key)
    })
    toDelete.forEach((key) => parsed.searchParams.delete(key))
    return parsed.toString()
  } catch {
    return url
  }
}
