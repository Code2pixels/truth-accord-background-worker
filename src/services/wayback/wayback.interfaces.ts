export interface WaybackSnapshot {
  url: string
  timestamp: string
  originalUrl: string
  statusCode: number | null
}

export interface WaybackAvailabilityResponse {
  url: string
  archived_snapshots: {
    closest?: {
      status: string
      available: boolean
      url: string
      timestamp: string
    }
  }
}

export interface CdxRecord {
  urlkey: string
  timestamp: string
  original: string
  mimetype: string
  statuscode: string
  digest: string
  length: string
}
