import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { context, createServer, getServerPort, reddit, redis } from '@devvit/web/server'
import type { TaskRequest, TaskResponse } from '@devvit/web/server'

const GM = 'https://www.galaxymovies.app'
const FALLBACK_SUB = 'galaxymovies'

interface TriviaQuestion {
  id: string
  prompt: string
  options: string[]
  answerIndex: number
  link: string
}
interface DailyPayload {
  date: string
  questions: TriviaQuestion[]
}
interface SlateEntry {
  tmdbId: number
  tmdbType: string
  title: string
}
interface WeeklyPayload {
  week: string
  provider: string
  providerLabel: string
  slate: SlateEntry[]
}
interface ResolvePayload {
  week: string
  provider: string
  providerLabel: string
  actualLeavers: string[]
}

const quizKey = (date: string) => `ss:quiz:${date}`
const picksKey = (date: string, userId: string) => `ss:picks:${date}:${userId}`
const scoreKey = (subId: string) => `ss:score:${subId}`
const streakKey = (userId: string) => `ss:streak:${userId}`
const slateKey = (week: string) => `ss:slate:${week}`
const votesKey = (week: string, subId: string) => `ss:votes:${week}:${subId}`
const predPostsKey = (week: string) => `ss:predposts:${week}`

const todayUtc = () => new Date().toISOString().split('T')[0]
const weekKeyUtc = (d = new Date()) => {
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7)
  return `${d.getUTCFullYear()}-W${week}`
}

const subId = () => String(context.subredditId ?? 'unknown')
const subName = () => context.subredditName ?? FALLBACK_SUB
const userId = () => String(context.userId ?? 'anon')

// The post record is stored at creation time so client /api calls only need
// context.postId — context.postData isn't reliably populated on those.
type PostData = { mode: 'quiz' | 'predict'; date?: string; week?: string }
const postKey = (postId: string) => `ss:post:${postId}`
async function getPostData(): Promise<PostData> {
  const raw = context.postId
    ? await redis.get(postKey(context.postId)).catch(() => null)
    : null
  if (raw) return JSON.parse(raw) as PostData
  return (context.postData as PostData | undefined) ?? { mode: 'quiz', date: todayUtc() }
}

async function gmFetch<T>(path: string): Promise<T | null> {
  const resp = await fetch(`${GM}${path}`).catch(() => null)
  if (!resp?.ok) return null
  return (await resp.json().catch(() => null)) as T | null
}

// ---------- post creators ----------

async function createQuizPost(): Promise<{ status: string; detail?: string }> {
  const payload = await gmFetch<DailyPayload>('/api/trivia/daily')
  if (!payload?.questions?.length) return { status: 'failed', detail: 'no trivia payload' }

  if (await redis.get(quizKey(payload.date))) return { status: 'skipped', detail: 'already posted today' }
  await redis.set(quizKey(payload.date), JSON.stringify(payload))

  const subredditName = subName()
  const post = await reddit.submitCustomPost({
    subredditName,
    title: `Still Streaming? — today's streaming trivia`,
    entry: 'default',
    postData: { mode: 'quiz', date: payload.date },
    styles: { heightPixels: 512, backgroundColor: '#14181c' },
    textFallback: {
      text: `**Still Streaming? — daily streaming trivia**\n\n${payload.questions.length} questions from this week's real streaming changes. Open on the Reddit app or new Reddit to play. Data: https://www.galaxymovies.app`
    }
  })
  await redis.set(postKey(post.id), JSON.stringify({ mode: 'quiz', date: payload.date }))
  return { status: 'posted' }
}

async function createSlatePost(): Promise<{ status: string; detail?: string }> {
  const payload = await gmFetch<WeeklyPayload>('/api/trivia/weekly')
  if (!payload?.slate?.length) return { status: 'failed', detail: 'no slate payload' }

  if (await redis.hGet(predPostsKey(payload.week), subId())) {
    return { status: 'skipped', detail: 'already posted this week' }
  }
  await redis.set(slateKey(payload.week), JSON.stringify(payload))

  const post = await reddit.submitCustomPost({
    subredditName: subName(),
    title: `Prediction round: what leaves ${payload.providerLabel} this week?`,
    entry: 'default',
    postData: { mode: 'predict', week: payload.week },
    styles: { heightPixels: 512, backgroundColor: '#14181c' },
    textFallback: {
      text: `**Prediction round** — which titles leave ${payload.providerLabel} this week? Vote on new Reddit or the app. Data: https://www.galaxymovies.app`
    }
  })
  await redis.hSet(predPostsKey(payload.week), { [subId()]: post.id })
  await redis.set(postKey(post.id), JSON.stringify({ mode: 'predict', week: payload.week }))
  return { status: 'posted' }
}

async function resolveWeek(week = weekKeyUtc()): Promise<{ status: string; detail?: string }> {
  const result = await gmFetch<ResolvePayload>(`/api/trivia/resolve?week=${week}`)
  if (!result) return { status: 'failed', detail: 'resolve payload unavailable' }
  const slate = await redis.get(slateKey(week)).catch(() => null)
  const slateData = slate ? (JSON.parse(slate) as WeeklyPayload) : null

  const posts = (await redis.hGetAll(predPostsKey(week)).catch(() => null)) || {}
  for (const [sid, postIdRaw] of Object.entries(posts)) {
    const postId = String(postIdRaw) as `t3_${string}`
    // Score each sub's votes against the real leavers.
    const votes = (await redis.hGetAll(votesKey(week, sid)).catch(() => null)) || {} as Record<string, string>
    const leaverTitles = new Set(result.actualLeavers.map(norm))
    const leaverIds = new Set(
      (slateData?.slate || []).filter((s) => leaverTitles.has(norm(s.title))).map((s) => s.tmdbId)
    )
    for (const [uid, raw] of Object.entries(votes)) {
      const picks = JSON.parse(raw) as number[]
      const hits = picks.filter((id) => leaverIds.has(id)).length
      if (hits > 0) await redis.hIncrBy(scoreKey(sid), uid, hits).catch(() => {})
    }

    const list = result.actualLeavers.length
      ? result.actualLeavers.map((t) => `- ${t}`).join('\n')
      : '- Nothing on the slate actually left'
    await reddit
      .submitComment({
        id: postId,
        text:
          `**Results are in** — real ${result.providerLabel} departures this week:\n\n${list}\n\n` +
          `Data: [galaxymovies.app](https://www.galaxymovies.app/leaving/${result.provider})`
      })
      .catch(() => {})
  }
  return { status: 'resolved', detail: `${result.actualLeavers.length} leavers` }
}

const norm = (t: string) => t.toLowerCase().trim()

// ---------- client API ----------

const app = new Hono()

app.get('/api/state', async (c) => {
  const data = await getPostData()
  if (data.mode === 'predict') {
    const week = data.week || weekKeyUtc()
    const raw = await redis.get(slateKey(week)).catch(() => null)
    const slate = raw ? (JSON.parse(raw) as WeeklyPayload) : null
    const votes = ((await redis.hGet(votesKey(week, subId()), userId()).catch(() => null)) as string | null)
    return c.json({
      mode: 'predict',
      week,
      providerLabel: slate?.providerLabel ?? '',
      slate: slate?.slate ?? [],
      myVotes: votes ? (JSON.parse(votes) as number[]) : []
    })
  }

  const date = data.date || todayUtc()
  const raw = await redis.get(quizKey(date)).catch(() => null)
  const quiz = raw ? (JSON.parse(raw) as DailyPayload) : null
  const picks = (await redis.hGetAll(picksKey(date, userId())).catch(() => null)) || {}
  const streak = (await redis.hGetAll(streakKey(userId())).catch(() => null)) as {
    count?: string
  } | null
  const score = await redis.hGet(scoreKey(subId()), userId()).catch(() => null)
  const questions = quiz?.questions || []
  const allAnswered = questions.length > 0 && questions.every((q) => picks[q.id] !== undefined)
  return c.json({
    mode: 'quiz',
    date,
    questions: questions.map(({ id, prompt, options, link }) => ({ id, prompt, options, link })),
    picks,
    score: Number(score) || 0,
    streak: Number(streak?.count) || 0,
    // Correct count is safe to expose only once the set is fully answered —
    // earlier it would leak per-question answer indexes indirectly.
    solved: allAnswered ? questions.filter((q) => picks[q.id] === String(q.answerIndex)).length : undefined
  })
})

app.post('/api/answer', async (c) => {
  const { questionId, choice } = (await c.req.json().catch(() => ({}))) as {
    questionId?: string
    choice?: number
  }
  const date = (await getPostData()).date || todayUtc()
  const raw = await redis.get(quizKey(date)).catch(() => null)
  const quiz = raw ? (JSON.parse(raw) as DailyPayload) : null
  const question = quiz?.questions.find((q) => q.id === questionId)
  if (!quiz || !question || typeof choice !== 'number') {
    return c.json({ error: 'bad request' }, 400)
  }

  const uid = userId()
  const existing = await redis.hGet(picksKey(date, uid), questionId!).catch(() => null)
  if (existing !== null && existing !== undefined) {
    return c.json({ error: 'already answered' }, 409)
  }

  const correct = choice === question.answerIndex
  await redis.hSet(picksKey(date, uid), { [questionId!]: String(choice) })
  if (correct) await redis.hIncrBy(scoreKey(subId()), uid, 1).catch(() => {})

  // Streak: increments when today's set is fully answered with all correct.
  const picks = (await redis.hGetAll(picksKey(date, uid)).catch(() => null)) || {}
  const answeredAll = Object.keys(picks).length === quiz.questions.length
  let streak = 0
  if (answeredAll) {
    const allRight = quiz.questions.every((q) => picks[q.id] === String(q.answerIndex))
    const prev = (await redis.hGetAll(streakKey(uid)).catch(() => null)) as {
      count?: string
      lastDate?: string
    } | null
    if (allRight) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
      streak = prev?.lastDate === yesterday ? Number(prev.count) + 1 : 1
      await redis.hSet(streakKey(uid), { count: String(streak), lastDate: date })
    } else {
      await redis.hSet(streakKey(uid), { count: '0', lastDate: date })
    }
  }

  const score = await redis.hGet(scoreKey(subId()), uid).catch(() => null)
  return c.json({
    correct,
    answerIndex: question.answerIndex,
    link: question.link,
    score: Number(score) || 0,
    streak
  })
})

app.post('/api/vote', async (c) => {
  const { tmdbIds } = (await c.req.json().catch(() => ({}))) as { tmdbIds?: number[] }
  if (!Array.isArray(tmdbIds) || tmdbIds.length > 3 || tmdbIds.some((id) => typeof id !== 'number')) {
    return c.json({ error: 'up to 3 tmdbIds' }, 400)
  }
  const week = (await getPostData()).week || weekKeyUtc()
  const raw = await redis.get(slateKey(week)).catch(() => null)
  const slate = raw ? (JSON.parse(raw) as WeeklyPayload) : null
  if (!slate) return c.json({ error: 'no slate' }, 404)
  const valid = new Set(slate.slate.map((s) => s.tmdbId))
  if (!tmdbIds.every((id) => valid.has(id))) return c.json({ error: 'unknown title' }, 400)

  await redis.hSet(votesKey(week, subId()), { [userId()]: JSON.stringify(tmdbIds) })
  return c.json({ ok: true, myVotes: tmdbIds })
})

app.get('/api/leaderboard', async (c) => {
  const all = ((await redis.hGetAll(scoreKey(subId())).catch(() => null)) || {}) as Record<string, string>
  const rows = Object.entries(all)
    .map(([uid, s]) => ({ userId: uid, score: Number(s) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
  return c.json({ rows })
})

// ---------- internal handlers ----------

app.post('/internal/scheduler/daily-quiz', async (c) => {
  await c.req.json<TaskRequest>().catch(() => null)
  const result = await createQuizPost()
  console.log('daily-quiz:', JSON.stringify(result))
  return c.json<TaskResponse>({ status: 'ok' }, 200)
})

app.post('/internal/scheduler/weekly-slate', async (c) => {
  await c.req.json<TaskRequest>().catch(() => null)
  const result = await createSlatePost()
  console.log('weekly-slate:', JSON.stringify(result))
  return c.json<TaskResponse>({ status: 'ok' }, 200)
})

app.post('/internal/scheduler/weekly-resolve', async (c) => {
  await c.req.json<TaskRequest>().catch(() => null)
  const result = await resolveWeek()
  console.log('weekly-resolve:', JSON.stringify(result))
  return c.json<TaskResponse>({ status: 'ok' }, 200)
})

const menuHandler =
  (fn: () => Promise<{ status: string; detail?: string }>) => async (c: any) => {
    await c.req.json().catch(() => null)
    const result = await fn()
    return c.json(
      { showToast: `${result.status}${result.detail ? `: ${result.detail}` : ''}` },
      200
    )
  }

const externalHandler =
  (fn: () => Promise<{ status: string; detail?: string }>) => async (c: any) => {
    const result = await fn()
    return c.json(result, result.status === 'failed' ? 500 : 200)
  }

app.post('/external/quiz-now', externalHandler(createQuizPost))
app.post('/external/slate-now', externalHandler(createSlatePost))
app.post('/external/resolve-now', externalHandler(() => resolveWeek()))

app.post('/internal/menu/quiz-now', menuHandler(createQuizPost))
app.post('/internal/menu/slate-now', menuHandler(createSlatePost))
app.post('/internal/menu/resolve-now', menuHandler(() => resolveWeek()))

serve({ fetch: app.fetch, createServer, port: getServerPort() })
