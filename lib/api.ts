import mockResults from '@/mock/results.json'
import type { AnalysisResponse } from '@/lib/types'

const STORAGE_KEY = 'citeverify:analysis'
const MOCK_LATENCY_MS = 700

/** Remember the latest real analysis. Pass null to clear it (sample document). */
export function saveResults(data: AnalysisResponse | null) {
  try {
    if (data) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable: results page falls back to the sample data
  }
}

/** Send the uploaded PDF to our /api/analyze route. */
export async function analyzeFile(file: File): Promise<AnalysisResponse> {
  const body = new FormData()
  body.append('file', file)
  const res = await fetch('/api/analyze', { method: 'POST', body })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    // response was not JSON
  }
  if (!res.ok) throw new Error(json?.error || `Analysis failed (${res.status})`)
  return json as AnalysisResponse
}

/**
 * Single entry point for results.
 * Real analysis if one was saved, otherwise the sample data.
 * To use the Python backend later, replace the body with a fetch to it.
 */
export async function getResults(): Promise<AnalysisResponse> {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved) as AnalysisResponse
  } catch {
    // ignore and fall back to the sample
  }
  await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS))
  return structuredClone(mockResults) as AnalysisResponse
}