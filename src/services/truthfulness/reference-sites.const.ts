export type { ReferenceSite } from '../../config/reference.config.ts'
import { REFERENCE_SITES } from '../../config/reference.config.ts'

export const REFERENCE_SITE_DOMAINS = REFERENCE_SITES.map((s) => s.domain)

const REFERENCE_MAP = new Map<string, number>(
  REFERENCE_SITES.map((s) => [s.domain.toLowerCase().replace(/^www\./, ''), s.trustScore]),
)

export function normalizeDomain(domain: string | null | undefined): string {
  if (!domain || typeof domain !== 'string') return ''
  return domain.toLowerCase().trim().replace(/^www\./, '')
}

export function isReferenceSite(domain: string | null | undefined): boolean {
  return REFERENCE_MAP.has(normalizeDomain(domain))
}

export function getReferenceTrustScore(domain: string | null | undefined): number | null {
  return REFERENCE_MAP.get(normalizeDomain(domain)) ?? null
}
