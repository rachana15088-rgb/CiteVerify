import type { Metadata } from 'next'
import { ResultsView } from '@/components/results/results-view'

export const metadata: Metadata = {
  title: 'Results — CiteVerify',
}

export default function ResultsPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 md:py-14">
      <ResultsView />
    </main>
  )
}
