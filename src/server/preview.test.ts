import { describe, expect, it } from 'vitest'

// Live smoke test: `GM_PREVIEW=1 npx vitest run preview.test.ts` fetches the
// real galaxymovies.app payloads and prints them for human review. Skipped in
// the normal suite so `npm test` never touches the network.
import { gmFetch } from './gm'
import type { DailyPayload, ResolvePayload, WeeklyPayload } from './gm'

const run = process.env.GM_PREVIEW ? describe : describe.skip

run('live preview', () => {
  it('prints the daily quiz, weekly slate and latest resolve', async () => {
    const daily = await gmFetch<DailyPayload>('/api/trivia/daily')
    expect(daily).not.toBeNull()
    console.log(`\n=== daily ${daily!.date} ===`)
    for (const q of daily!.questions) {
      console.log(`  ${q.prompt}`)
      q.options.forEach((o, i) => console.log(`    ${i === q.answerIndex ? '>' : ' '} ${o}`))
    }

    const weekly = await gmFetch<WeeklyPayload>('/api/trivia/weekly')
    expect(weekly).not.toBeNull()
    console.log(`\n=== slate ${weekly!.week}: ${weekly!.providerLabel} ===`)
    for (const s of weekly!.slate) console.log(`  ${s.tmdbId}  ${s.title}`)

    const resolved = await gmFetch<ResolvePayload>(`/api/trivia/resolve?week=${weekly!.week}`)
    if (resolved) {
      console.log(`\n=== resolve ${resolved.week}: ${resolved.providerLabel} ===`)
      for (const t of resolved.actualLeavers) console.log(`  left: ${t}`)
    }
  }, 60_000)
})
