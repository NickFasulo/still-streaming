// galaxymovies.app data access — read-only JSON payloads that carry the day's
// quiz, the weekly prediction slate, and the slate's resolution. The API needs
// no key; payloads are identical for every installed subreddit.

export const GM = 'https://www.galaxymovies.app'

export interface TriviaQuestion {
  id: string
  prompt: string
  options: string[]
  answerIndex: number
  link: string
}

export interface DailyPayload {
  date: string
  questions: TriviaQuestion[]
}

export interface SlateEntry {
  tmdbId: number
  tmdbType: string
  title: string
}

export interface WeeklyPayload {
  week: string
  provider: string
  providerLabel: string
  slate: SlateEntry[]
}

export interface ResolvePayload {
  week: string
  provider: string
  providerLabel: string
  actualLeavers: string[]
}

export async function gmFetch<T>(path: string): Promise<T | null> {
  let response: Response | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(`${GM}${path}`, { signal: AbortSignal.timeout(8000) })
      if (response.ok || response.status < 500) break
    } catch {
      response = null
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400))
  }
  if (!response?.ok) return null
  return (await response.json().catch(() => null)) as T | null
}
