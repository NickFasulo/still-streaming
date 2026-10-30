import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-in for Devvit Redis + Reddit APIs so game.ts runs under
// vitest. `fetch` is stubbed per test where a galaxymovies.app payload matters.
const h = vi.hoisted(() => {
  const store = new Map<string, string>()
  const hashes = new Map<string, Map<string, string>>()
  const context: {
    postId?: string
    subredditId?: string
    subredditName?: string
    userId?: string
    postData?: unknown
  } = {}
  const posts: { id: string; title?: string; postData?: unknown }[] = []
  const comments: { id: string; text: string }[] = []
  let postN = 0
  const state = {
    store,
    hashes,
    context,
    posts,
    comments,
    postDays: undefined as string[] | undefined,
    reset() {
      store.clear()
      hashes.clear()
      for (const k of Object.keys(context) as (keyof typeof context)[]) delete context[k]
      posts.length = 0
      comments.length = 0
      state.postDays = undefined
      context.subredditId = 't5_sub'
      context.subredditName = 'somesub'
      context.userId = 't2_u1'
    }
  }
  return {
    state,
    nextPostId: () => `t3_p${++postN}` as `t3_${string}`
  }
})

vi.mock('@devvit/web/server', () => ({
  context: h.state.context,
  settings: { getAll: async () => ({ post_days: h.state.postDays }) },
  reddit: {
    submitCustomPost: async (opts: { title?: string; postData?: unknown }) => {
      const id = h.nextPostId()
      h.state.posts.push({ id, title: opts.title, postData: opts.postData })
      return { id }
    },
    submitComment: async (opts: { id: string; text: string }) => {
      h.state.comments.push(opts)
      return { id: 't1_c1' }
    },
    getCurrentUsername: async () => 'testuser'
  },
  redis: {
    get: async (k: string) => h.state.store.get(k) ?? null,
    set: async (k: string, v: string, opts?: { nx?: boolean }) => {
      if (opts?.nx && h.state.store.has(k)) return null
      h.state.store.set(k, v)
      return 'OK'
    },
    del: async (k: string) => {
      h.state.store.delete(k)
      h.state.hashes.delete(k)
    },
    hGet: async (k: string, f: string) => h.state.hashes.get(k)?.get(f) ?? null,
    hGetAll: async (k: string) => {
      const m = h.state.hashes.get(k)
      return m ? Object.fromEntries(m) : null
    },
    hSet: async (k: string, o: Record<string, string>) => {
      const m = h.state.hashes.get(k) ?? new Map<string, string>()
      for (const [f, v] of Object.entries(o)) m.set(f, v)
      h.state.hashes.set(k, m)
    },
    hIncrBy: async (k: string, f: string, n: number) => {
      const m = h.state.hashes.get(k) ?? new Map<string, string>()
      const v = Number(m.get(f) ?? 0) + n
      m.set(f, String(v))
      h.state.hashes.set(k, m)
      return v
    }
  }
}))

import {
  awardFor,
  createQuizPost,
  getLeaderboard,
  getState,
  isPostDay,
  markShown,
  matchLeaverIds,
  resetAll,
  resolveWeek,
  submitAnswer,
  submitVote,
  todayUtc,
  weekKeyUtc
} from './game'

const QUIZ = {
  questions: [
    { id: 'q1', prompt: 'Q1?', options: ['a', 'b', 'c', 'd'], answerIndex: 0, link: 'https://x/1' },
    { id: 'q2', prompt: 'Q2?', options: ['a', 'b', 'c', 'd'], answerIndex: 1, link: 'https://x/2' }
  ]
}

const SLATE = {
  week: '2026-W44',
  provider: 'netflix',
  providerLabel: 'Netflix',
  slate: [
    { tmdbId: 1, tmdbType: 'movie', title: 'Gone Girl' },
    { tmdbId: 2, tmdbType: 'movie', title: 'Staying Put' }
  ]
}

const seedQuizPost = (v?: string) => {
  const date = todayUtc()
  h.state.store.set(`ss:quiz:${date}${v ? `:${v}` : ''}`, JSON.stringify({ date, ...QUIZ }))
  h.state.context.postId = 't3_quiz'
  h.state.store.set(`ss:post:t3_quiz`, JSON.stringify({ mode: 'quiz', date, ...(v ? { v } : {}) }))
}

const seedSlatePost = (week = weekKeyUtc(), v?: string) => {
  h.state.store.set(`ss:slate:${week}${v ? `:${v}` : ''}`, JSON.stringify({ ...SLATE, week }))
  h.state.context.postId = 't3_slate'
  h.state.store.set(`ss:post:t3_slate`, JSON.stringify({ mode: 'predict', week, ...(v ? { v } : {}) }))
}

const stubFetch = (body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))

beforeEach(() => {
  h.state.reset()
  vi.unstubAllGlobals()
})

describe('awardFor', () => {
  it('decays from full to floor across the window', () => {
    expect(awardFor(0)).toBe(100)
    expect(awardFor(8_000)).toBe(100)
    expect(awardFor(14_000)).toBe(62)
    expect(awardFor(20_000)).toBe(25)
    expect(awardFor(Number.POSITIVE_INFINITY)).toBe(25)
  })
})

describe('weekKeyUtc', () => {
  it('numbers weeks from Jan 1', () => {
    expect(weekKeyUtc(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-W1')
    expect(weekKeyUtc(new Date(Date.UTC(2026, 9, 30)))).toBe('2026-W44')
  })
})

describe('matchLeaverIds', () => {
  it('maps departing titles to slate ids, case-insensitively', () => {
    const ids = matchLeaverIds(SLATE.slate, [' gone girl ', 'Not On Slate'])
    expect([...ids]).toEqual([1])
  })
})

describe('submitAnswer', () => {
  it('scores a correct answer at full points when freshly shown', async () => {
    seedQuizPost()
    await markShown('q1')
    const res = await submitAnswer('q1', 0)
    expect(res).toMatchObject({ correct: true, points: 100, score: 100 })
  })

  it('floors the award without a shown stamp', async () => {
    seedQuizPost()
    const res = await submitAnswer('q1', 0)
    expect(res).toMatchObject({ correct: true, points: 25 })
  })

  it('rejects a second submission', async () => {
    seedQuizPost()
    await submitAnswer('q1', 0)
    expect(await submitAnswer('q1', 0)).toEqual({ error: 'already answered', status: 409 })
  })

  it('awards no points on a wrong answer', async () => {
    seedQuizPost()
    const res = await submitAnswer('q1', 2)
    expect(res).toMatchObject({ correct: false, points: 0, score: 0 })
  })

  it('extends a yesterday-chain streak on a perfect set', async () => {
    seedQuizPost()
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
    h.state.hashes.set('ss:streak:t2_u1', new Map([['count', '4'], ['lastDate', yesterday]]))
    await submitAnswer('q1', 0)
    const res = await submitAnswer('q2', 1)
    expect(res).toMatchObject({ streak: 5 })
  })

  it('resets the streak when the set is not perfect', async () => {
    seedQuizPost()
    await submitAnswer('q1', 2)
    const res = await submitAnswer('q2', 1)
    expect(res).toMatchObject({ streak: 0 })
    expect(h.state.hashes.get('ss:streak:t2_u1')?.get('count')).toBe('0')
  })

  it('honors legacy picks so a mid-day deploy cannot re-answer', async () => {
    const date = todayUtc()
    seedQuizPost()
    h.state.hashes.set(`ss:picks:${date}:t2_u1`, new Map([['q1', '0']]))
    expect(await submitAnswer('q1', 0)).toEqual({ error: 'already answered', status: 409 })
    const state = await getState()
    expect(state.mode === 'quiz' && state.picks?.q1).toBe('0')
  })
})

describe('getState', () => {
  it('hides answer indexes until the set is done', async () => {
    seedQuizPost()
    const state = await getState()
    if (state.mode !== 'quiz') throw new Error('expected quiz mode')
    for (const q of state.questions) expect('answerIndex' in q).toBe(false)
    expect(state.solved).toBeUndefined()
    await submitAnswer('q1', 0)
    await submitAnswer('q2', 1)
    const done = await getState()
    expect(done.mode === 'quiz' && done.solved).toBe(2)
  })

  it('returns the slate and recorded votes in predict mode', async () => {
    const week = weekKeyUtc()
    seedSlatePost(week)
    const state = await getState()
    expect(state).toMatchObject({ mode: 'predict', week, providerLabel: 'Netflix', myVotes: [] })
  })
})

describe('submitVote', () => {
  it('locks the ballot in and dedupes ids', async () => {
    seedSlatePost()
    const res = await submitVote([1, 1, 2])
    expect(res).toEqual({ ok: true, myVotes: [1, 2] })
    // Second ballot returns the recorded one instead of overwriting.
    expect(await submitVote([2])).toEqual({ ok: true, myVotes: [1, 2] })
  })

  it('validates against the slate', async () => {
    seedSlatePost()
    expect(await submitVote([99])).toEqual({ error: 'unknown title', status: 400 })
    expect(await submitVote([1, 2, 3, 4])).toEqual({ error: 'up to 3 tmdbIds', status: 400 })
  })

  it('rejects votes on quiz posts', async () => {
    seedQuizPost()
    expect(await submitVote([1])).toEqual({ error: 'not a prediction post', status: 400 })
  })
})

describe('createQuizPost', () => {
  it('dedupes per sub but lets a forced repost own a versioned key', async () => {
    stubFetch({ date: todayUtc(), ...QUIZ })
    expect(await createQuizPost()).toEqual({ status: 'posted' })
    expect(await createQuizPost()).toEqual({ status: 'skipped', detail: 'already posted today' })

    const repost = await createQuizPost(true)
    expect(repost).toEqual({ status: 'posted' })
    const ck = `d:${todayUtc()}:v2`
    expect(h.state.hashes.get('ss:posts')?.has(`${ck}|t5_sub`)).toBe(true)
    expect(h.state.store.has(`ss:quiz:${todayUtc()}:v2`)).toBe(true)
    expect(h.state.posts[1].postData).toMatchObject({ mode: 'quiz', v: 'v2' })
  })
})

describe('resolveWeek', () => {
  it('scores votes across both schemas and comments results', async () => {
    const week = '2026-W44'
    stubFetch({ week, provider: 'netflix', providerLabel: 'Netflix', actualLeavers: ['Gone Girl'] })
    // New-schema post + votes under the content key.
    h.state.hashes.set('ss:posts', new Map([[`s:${week}|t5_sub`, 't3_new']]))
    h.state.store.set(`ss:slate:${week}`, JSON.stringify(SLATE))
    h.state.hashes.set(`ss:votes:s:${week}:t5_sub`, new Map([['t2_u1', '[1,2]'], ['t2_u2', '[2]']]))
    // Legacy post + votes under the bare week.
    h.state.hashes.set(`ss:predposts:${week}`, new Map([['t5_oldsub', 't3_old']]))
    h.state.hashes.set(`ss:votes:${week}:t5_oldsub`, new Map([['t2_u3', '[1]']]))

    const res = await resolveWeek(week)
    expect(res).toEqual({ status: 'resolved', detail: '1 leavers' })
    expect(h.state.hashes.get('ss:score:t5_sub')?.get('t2_u1')).toBe('1')
    expect(h.state.hashes.get('ss:score:t5_sub')?.get('t2_u2')).toBeUndefined()
    expect(h.state.hashes.get('ss:score:t5_oldsub')?.get('t2_u3')).toBe('1')
    expect(h.state.comments.map((x) => x.id).sort()).toEqual(['t3_new', 't3_old'])
    expect(h.state.comments[0].text).toContain('Gone Girl')
  })
})

describe('getLeaderboard', () => {
  it('ranks rows and reports the caller outside the top cut', async () => {
    h.state.hashes.set(
      'ss:score:t5_sub',
      new Map(Array.from({ length: 12 }, (_, i) => [`t2_u${i}`, String(110 - i * 10)]))
    )
    h.state.store.set('ss:name:t2_u0', 'alice')
    h.state.context.userId = 't2_u11'
    const board = await getLeaderboard()
    expect(board.rows).toHaveLength(10)
    expect(board.rows[0]).toMatchObject({ username: 'alice', score: 110 })
    expect(board.me).toEqual({ rank: 12, score: 0 })
  })
})

describe('isPostDay', () => {
  it('gates on the configured post days', async () => {
    h.state.postDays = [String(new Date().getUTCDay())]
    expect(await isPostDay()).toBe(true)
    h.state.postDays = ['9']
    expect(await isPostDay()).toBe(false)
  })
})

describe('resetAll', () => {
  it('is gated to the dev subreddit', async () => {
    h.state.context.subredditName = 'somesub'
    expect(await resetAll()).toEqual({ status: 'failed', detail: 'dev subreddit only' })
  })

  it('clears every key the app wrote', async () => {
    h.state.context.subredditName = 'still_streaming_dev'
    seedQuizPost()
    await markShown('q1')
    await submitAnswer('q1', 0)
    h.state.hashes.set('ss:posts', new Map([[`d:${todayUtc()}|t5_sub`, 't3_quiz']]))
    const res = await resetAll()
    expect(res.status).toBe('ok')
    expect(h.state.store.size).toBe(0)
    expect(h.state.hashes.size).toBe(0)
  })
})
