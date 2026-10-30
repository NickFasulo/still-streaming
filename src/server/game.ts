import { context, reddit, redis, settings } from '@devvit/web/server'
import { GM, gmFetch } from './gm'
import type { DailyPayload, ResolvePayload, SlateEntry, WeeklyPayload } from './gm'

const FALLBACK_SUB = 'galaxymovies'
const DEV_SUB = 'still_streaming_dev'

// Content key: `d:{date}` for daily quizzes, `s:{week}` for prediction slates.
// Picks, votes, scores and streaks all key off it. Forced reposts get a :vN
// suffix so each post owns its payload and picks; reusing the day's key would
// let a repost see and mutate the earlier post's state.
const contentKey = (d: PostData) => `${d.week ? `s:${d.week}` : `d:${d.date}`}${d.v ? `:${d.v}` : ''}`
const quizKey = (date: string, v?: string) => `ss:quiz:${date}${v ? `:${v}` : ''}`
const slateKey = (week: string, v?: string) => `ss:slate:${week}${v ? `:${v}` : ''}`
const postVarKey = 'ss:postv'
// Devvit Redis has no keyspace scan, so post records live in one hash and
// answered uids in another — resetAll enumerates them instead of KEYS.
const postsHashKey = 'ss:posts'
const postField = (ck: string, sid: string) => `${ck}|${sid}`
const uidIndexKey = 'ss:idx:uids'
const picksKey = (ck: string, uid: string) => `ss:picks:${ck}:${uid}`
const votesKey = (ck: string, sid: string) => `ss:votes:${ck}:${sid}`
const scoreKey = (subId: string) => `ss:score:${subId}`
const streakKey = (uid: string) => `ss:streak:${uid}`
const nameKey = (uid: string) => `ss:name:${uid}`
const answerLockKey = (ck: string, uid: string, qid: string) => `ss:anslock:${ck}:${uid}:${qid}`
const shownKey = (ck: string, uid: string, qid: string) => `ss:shown:${ck}:${uid}:${qid}`

// Transitional reads for data written before the content-key schema shipped:
// posts were deduped in per-date/week hashes, picks/votes keyed by bare
// date/week. Only unversioned keys can have legacy state. Safe to delete
// once the legacy hashes have cycled out.
const legacyPicksKey = (date: string, uid: string) => `ss:picks:${date}:${uid}`
const legacyVotesKey = (week: string, sid: string) => `ss:votes:${week}:${sid}`
const legacyQuizPostsKey = (date: string) => `ss:quizposts:${date}`
const legacyPredPostsKey = (week: string) => `ss:predposts:${week}`

// Speed bonus: the first client view stamps a server-side clock, and the
// award decays from FULL_PTS (<=8s) to FLOOR_PTS (>=20s). A lookup takes
// long enough that it only ever earns the floor.
const FULL_PTS = 100
const FLOOR_PTS = 25
const FULL_MS = 8_000
const FLOOR_MS = 20_000
export const awardFor = (elapsed: number) =>
  elapsed <= FULL_MS
    ? FULL_PTS
    : elapsed >= FLOOR_MS
      ? FLOOR_PTS
      : FULL_PTS - Math.round(((elapsed - FULL_MS) / (FLOOR_MS - FULL_MS)) * (FULL_PTS - FLOOR_PTS))

export const todayUtc = () => new Date().toISOString().split('T')[0]
export const weekKeyUtc = (d = new Date()) => {
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7)
  return `${d.getUTCFullYear()}-W${week}`
}

const subId = () => String(context.subredditId ?? 'unknown')
const subName = () => context.subredditName ?? FALLBACK_SUB
const userId = () => String(context.userId ?? 'anon')

// The post record is stored at creation time so client /api calls only need
// context.postId — context.postData isn't reliably populated on those.
type PostData = { mode: 'quiz' | 'predict'; date?: string; week?: string; v?: string }
const postKey = (postId: string) => `ss:post:${postId}`
async function getPostData(): Promise<PostData> {
  const raw = context.postId ? await redis.get(postKey(context.postId)).catch(() => null) : null
  if (raw) return JSON.parse(raw) as PostData
  return (context.postData as PostData | undefined) ?? { mode: 'quiz', date: todayUtc() }
}

async function payloadFor(data: PostData): Promise<DailyPayload | WeeklyPayload | null> {
  const key = data.mode === 'predict' ? slateKey(data.week || weekKeyUtc(), data.v) : quizKey(data.date || todayUtc(), data.v)
  const raw = await redis.get(key).catch(() => null)
  return raw ? JSON.parse(raw) : null
}

export type Result = { status: string; detail?: string }

// `force` is for manual menu/external triggers: the scheduler dedups once per
// period, but a mod explicitly re-running the action wants another post.
export async function createQuizPost(force = false): Promise<Result> {
  const date = todayUtc()
  if (
    !force &&
    ((await redis.hGet(postsHashKey, postField(`d:${date}`, subId())).catch(() => null)) ||
      (await redis.hGet(legacyQuizPostsKey(date), subId()).catch(() => null)))
  ) {
    return { status: 'skipped', detail: 'already posted today' }
  }
  const payload = await gmFetch<DailyPayload>('/api/trivia/daily')
  if (!payload?.questions?.length) return { status: 'failed', detail: 'no trivia payload' }
  const n = force ? Number(await redis.hIncrBy(postVarKey, `${subId()}:d:${date}`, 1).catch(() => 0)) + 1 : 0
  const v = n > 1 ? `v${n}` : undefined
  await redis.set(quizKey(date, v), JSON.stringify(payload))

  const post = await reddit.submitCustomPost({
    subredditName: subName(),
    title: `Still Streaming? — today's streaming trivia`,
    entry: 'default',
    postData: { mode: 'quiz', date, ...(v ? { v } : {}) },
    styles: { heightPixels: 512, backgroundColor: '#14181c' },
    textFallback: {
      text: `**Still Streaming? — daily streaming trivia**\n\n${payload.questions.length} questions from this week's real streaming changes. Open on the Reddit app or new Reddit to play. Data: https://www.galaxymovies.app`
    }
  })
  await redis.hSet(postsHashKey, { [postField(`d:${date}${v ? `:${v}` : ''}`, subId())]: post.id })
  await redis.set(postKey(post.id), JSON.stringify({ mode: 'quiz', date, ...(v ? { v } : {}) }))
  return { status: 'posted' }
}

export async function createSlatePost(force = false): Promise<Result> {
  const week = weekKeyUtc()
  if (
    !force &&
    ((await redis.hGet(postsHashKey, postField(`s:${week}`, subId())).catch(() => null)) ||
      (await redis.hGet(legacyPredPostsKey(week), subId()).catch(() => null)))
  ) {
    return { status: 'skipped', detail: 'already posted this week' }
  }
  const payload = await gmFetch<WeeklyPayload>('/api/trivia/weekly')
  if (!payload?.slate?.length) return { status: 'failed', detail: 'no slate payload' }
  const n = force ? Number(await redis.hIncrBy(postVarKey, `${subId()}:s:${week}`, 1).catch(() => 0)) + 1 : 0
  const v = n > 1 ? `v${n}` : undefined
  await redis.set(slateKey(week, v), JSON.stringify(payload))

  const post = await reddit.submitCustomPost({
    subredditName: subName(),
    title: `Prediction round: what leaves ${payload.providerLabel} this week?`,
    entry: 'default',
    postData: { mode: 'predict', week, ...(v ? { v } : {}) },
    styles: { heightPixels: 512, backgroundColor: '#14181c' },
    textFallback: {
      text: `**Prediction round** — which titles leave ${payload.providerLabel} this week? Vote on new Reddit or the app. Data: https://www.galaxymovies.app`
    }
  })
  await redis.hSet(postsHashKey, { [postField(`s:${week}${v ? `:${v}` : ''}`, subId())]: post.id })
  await redis.set(postKey(post.id), JSON.stringify({ mode: 'predict', week, ...(v ? { v } : {}) }))
  return { status: 'posted' }
}

const norm = (t: string) => t.toLowerCase().trim()

// Maps the slate's tmdbIds onto the titles that actually left, so votes score
// on ids rather than display strings.
export function matchLeaverIds(slate: SlateEntry[], actualLeavers: string[]): Set<number> {
  const leaverTitles = new Set(actualLeavers.map(norm))
  return new Set(slate.filter((s) => leaverTitles.has(norm(s.title))).map((s) => s.tmdbId))
}

export async function resolveWeek(week = weekKeyUtc()): Promise<Result> {
  const result = await gmFetch<ResolvePayload>(`/api/trivia/resolve?week=${week}`)
  if (!result) return { status: 'failed', detail: 'resolve payload unavailable' }

  // Every post for the week across both schemas: the posts hash carries
  // `s:{week}|sid` and versioned `s:{week}:vN|sid` fields, the legacy
  // predposts hash maps sid -> postId for pre-migration installs.
  const posts: { postId: `t3_${string}`; ck: string; sid: string }[] = []
  const all = (await redis.hGetAll(postsHashKey).catch(() => null)) || {}
  for (const [field, postIdRaw] of Object.entries(all)) {
    const [ck, sid] = field.split('|')
    if (ck === `s:${week}` || ck.startsWith(`s:${week}:`)) {
      posts.push({ postId: String(postIdRaw) as `t3_${string}`, ck, sid })
    }
  }
  const legacy = (await redis.hGetAll(legacyPredPostsKey(week)).catch(() => null)) || {}
  for (const [sid, postIdRaw] of Object.entries(legacy)) {
    posts.push({ postId: String(postIdRaw) as `t3_${string}`, ck: `s:${week}`, sid })
  }

  const slateCache = new Map<string, WeeklyPayload | null>()
  for (const { postId, ck, sid } of posts) {
    if (!slateCache.has(ck)) {
      const raw = await redis.get(slateKey(ck.slice(2))).catch(() => null)
      slateCache.set(ck, raw ? (JSON.parse(raw) as WeeklyPayload) : null)
    }
    const leaverIds = matchLeaverIds(slateCache.get(ck)?.slate ?? [], result.actualLeavers)

    // Post-deploy votes land on the content-key hash; pre-deploy votes stay on
    // the bare-week hash. Merged, new wins — a uid can only be in one anyway.
    const votes = ((await redis.hGetAll(legacyVotesKey(week, sid)).catch(() => null)) || {}) as Record<string, string>
    Object.assign(votes, ((await redis.hGetAll(votesKey(ck, sid)).catch(() => null)) || {}) as Record<string, string>)
    for (const [uid, raw] of Object.entries(votes)) {
      const picks = new Set(JSON.parse(raw) as number[])
      const hits = [...picks].filter((id) => leaverIds.has(id)).length
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
          `Data: [galaxymovies.app](${GM}/leaving/${result.provider})`
      })
      .catch(() => {})
  }
  return { status: 'resolved', detail: `${result.actualLeavers.length} leavers` }
}

// Dev-only escape hatch: deletes every key the app writes (payloads, picks,
// votes, scores, streaks, post records). Gated to the dev subreddit so a stray
// mod click on a production install can't wipe real player data.
export async function resetAll(): Promise<Result> {
  if (subName() !== DEV_SUB) return { status: 'failed', detail: 'dev subreddit only' }
  const posts = (await redis.hGetAll(postsHashKey).catch(() => null)) || {}
  const uids = Object.keys((await redis.hGetAll(uidIndexKey).catch(() => null)) || {})
  const dels = new Set<string>([postsHashKey, uidIndexKey, postVarKey])
  for (const [field, postId] of Object.entries(posts)) {
    const [ck, sid] = field.split('|')
    const body = ck.slice(2)
    const key = ck.startsWith('s:') ? slateKey(body) : quizKey(body)
    dels.add(`ss:post:${postId}`)
    dels.add(scoreKey(sid))
    dels.add(votesKey(ck, sid))
    // Read the payload before deleting it so answer locks and shown stamps
    // are cleared for the real question ids, whatever the API calls them.
    const raw = await redis.get(key).catch(() => null)
    const payload = raw ? (JSON.parse(raw) as DailyPayload) : null
    dels.add(key)
    for (const uid of uids) {
      dels.add(picksKey(ck, uid))
      for (const q of payload?.questions ?? []) {
        dels.add(answerLockKey(ck, uid, q.id))
        dels.add(shownKey(ck, uid, q.id))
      }
    }
  }
  for (const uid of uids) {
    dels.add(streakKey(uid))
    dels.add(nameKey(uid))
  }
  await Promise.all([...dels].map((k) => redis.del(k).catch(() => {})))
  return { status: 'ok', detail: `${dels.size} keys cleared` }
}

// Whether today is a configured post day for this install. `post_days` is a
// subreddit setting so subs running several apps can space out their posts.
export async function isPostDay(): Promise<boolean> {
  const all = await settings.getAll<{ post_days?: string[] | string }>().catch(() => ({}) as { post_days?: string[] | string })
  const raw = all.post_days
  // Tue/Thu/Sat so installs alternate with Screen Test's Mon/Wed/Fri and the
  // quiz never shares a day with this app's own Monday prediction slate.
  const days = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : ['2', '4', '6']
  return days.includes(String(new Date().getUTCDay()))
}

// ---------- client API helpers ----------

export type StateResponse =
  | {
      mode: 'quiz'
      date: string
      questions: Pick<DailyPayload['questions'][number], 'id' | 'prompt' | 'options' | 'link'>[]
      picks: Record<string, string>
      score: number
      streak: number
      solved?: number
    }
  | { mode: 'predict'; week: string; providerLabel: string; slate: SlateEntry[]; myVotes: number[] }

async function picksFor(ck: string, uid: string): Promise<Record<string, string>> {
  const picks = ((await redis.hGetAll(picksKey(ck, uid)).catch(() => null)) || {}) as Record<string, string>
  // Unversioned quiz keys can have pre-migration picks under the bare date.
  if (ck.startsWith('d:') && !ck.includes(':', 2)) {
    const legacy = ((await redis.hGetAll(legacyPicksKey(ck.slice(2), uid)).catch(() => null)) || {}) as Record<string, string>
    return { ...legacy, ...picks }
  }
  return picks
}

export async function getState(): Promise<StateResponse> {
  const data = await getPostData()
  const payload = await payloadFor(data)
  const ck = contentKey(data)

  if (data.mode === 'predict') {
    const week = data.week || weekKeyUtc()
    const slate = payload as WeeklyPayload | null
    const sid = subId()
    let raw = await redis.hGet(votesKey(ck, sid), userId()).catch(() => null)
    if (raw == null && ck === `s:${week}`) raw = await redis.hGet(legacyVotesKey(week, sid), userId()).catch(() => null)
    return {
      mode: 'predict',
      week,
      providerLabel: slate?.providerLabel ?? '',
      slate: slate?.slate ?? [],
      myVotes: raw ? (JSON.parse(raw) as number[]) : []
    }
  }

  const quiz = payload as DailyPayload | null
  const uid = userId()
  const picks = await picksFor(ck, uid)
  const streak = (await redis.hGetAll(streakKey(uid)).catch(() => null)) as { count?: string } | null
  const score = await redis.hGet(scoreKey(subId()), uid).catch(() => null)
  const questions = quiz?.questions || []
  const allAnswered = questions.length > 0 && questions.every((q) => picks[q.id] !== undefined)
  return {
    mode: 'quiz',
    date: data.date || todayUtc(),
    questions: questions.map(({ id, prompt, options, link }) => ({ id, prompt, options, link })),
    picks,
    score: Number(score) || 0,
    streak: Number(streak?.count) || 0,
    // Correct count is safe to expose only once the set is fully answered —
    // earlier it would leak per-question answer indexes indirectly.
    solved: allAnswered ? questions.filter((q) => picks[q.id] === String(q.answerIndex)).length : undefined
  }
}

// Records when the client first rendered a question. nx: first stamp wins,
// so it can't be reset just before answering.
export async function markShown(questionId: string) {
  const data = await getPostData()
  const payload = (await payloadFor(data)) as DailyPayload | null
  if (data.mode === 'predict' || !payload?.questions.some((q) => q.id === questionId)) return
  await redis
    .set(shownKey(contentKey(data), userId(), questionId), String(Date.now()), {
      nx: true,
      expiration: new Date(Date.now() + 8 * 86_400_000)
    })
    .catch(() => null)
}

export async function submitAnswer(questionId: string, choice: number) {
  const data = await getPostData()
  const payload = (await payloadFor(data)) as DailyPayload | null
  const question = data.mode !== 'predict' ? payload?.questions.find((q) => q.id === questionId) : undefined
  if (!payload || !question || typeof choice !== 'number') {
    return { error: 'bad request', status: 400 as const }
  }
  const ck = contentKey(data)
  const uid = userId()
  // Atomic claim: concurrent submissions could both pass an hGet check and
  // double-score; the nx lock makes the first writer win.
  const claimed = await redis
    .set(answerLockKey(ck, uid, questionId), '1', { nx: true, expiration: new Date(Date.now() + 60_000) })
    .catch(() => null)
  if (!claimed) return { error: 'already answered', status: 409 as const }

  const existing = await picksFor(ck, uid)
  if (existing[questionId] !== undefined) {
    return { error: 'already answered', status: 409 as const }
  }

  // Store the username once so leaderboards can show u/name, not t2_ ids.
  // The uid index lets the dev reset find per-user keys without a key scan.
  if (!(await redis.get(nameKey(uid)).catch(() => null))) {
    const name = await reddit.getCurrentUsername().catch(() => undefined)
    if (name) await redis.set(nameKey(uid), name).catch(() => {})
  }
  await redis.hSet(uidIndexKey, { [uid]: '1' }).catch(() => {})

  const correct = choice === question.answerIndex
  await redis.hSet(picksKey(ck, uid), { [questionId]: String(choice) })
  let points = 0
  if (correct) {
    const shown = Number(await redis.get(shownKey(ck, uid, questionId)).catch(() => null)) || 0
    // Missing stamp (unstamped view) can't verify speed: scores at the floor.
    points = awardFor(shown ? Date.now() - shown : Number.POSITIVE_INFINITY)
    await redis.hIncrBy(scoreKey(subId()), uid, points).catch(() => {})
  }

  // Streak: increments when the day's set is fully answered with all correct.
  const picks = await picksFor(ck, uid)
  const answeredAll = payload.questions.every((q) => picks[q.id] !== undefined)
  let streak = 0
  if (answeredAll) {
    const allRight = payload.questions.every((q) => picks[q.id] === String(q.answerIndex))
    const prev = (await redis.hGetAll(streakKey(uid)).catch(() => null)) as { count?: string; lastDate?: string } | null
    if (allRight) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
      streak = prev?.lastDate === yesterday ? Number(prev.count) + 1 : 1
      await redis.hSet(streakKey(uid), { count: String(streak), lastDate: todayUtc() })
    } else {
      await redis.hSet(streakKey(uid), { count: '0', lastDate: todayUtc() })
    }
  }

  const score = await redis.hGet(scoreKey(subId()), uid).catch(() => null)
  return { correct, answerIndex: question.answerIndex, link: question.link, points, score: Number(score) || 0, streak }
}

export async function submitVote(tmdbIds: number[]) {
  const data = await getPostData()
  if (data.mode !== 'predict') return { error: 'not a prediction post', status: 400 as const }
  if (!Array.isArray(tmdbIds) || tmdbIds.length > 3 || tmdbIds.some((id) => typeof id !== 'number')) {
    return { error: 'up to 3 tmdbIds', status: 400 as const }
  }
  const payload = (await payloadFor(data)) as WeeklyPayload | null
  if (!payload?.slate) return { error: 'no slate', status: 404 as const }
  const valid = new Set(payload.slate.map((s) => s.tmdbId))
  if (!tmdbIds.every((id) => valid.has(id))) return { error: 'unknown title', status: 400 as const }

  const ck = contentKey(data)
  const week = data.week || weekKeyUtc()
  const sid = subId()
  const uid = userId()
  // Votes lock in — a resubmission returns the recorded ballot rather than
  // overwriting it ahead of Sunday's resolve.
  let prev = await redis.hGet(votesKey(ck, sid), uid).catch(() => null)
  if (prev == null && ck === `s:${week}`) prev = await redis.hGet(legacyVotesKey(week, sid), uid).catch(() => null)
  if (prev != null) return { ok: true as const, myVotes: JSON.parse(prev) as number[] }

  if (!(await redis.get(nameKey(uid)).catch(() => null))) {
    const name = await reddit.getCurrentUsername().catch(() => undefined)
    if (name) await redis.set(nameKey(uid), name).catch(() => {})
  }
  await redis.hSet(uidIndexKey, { [uid]: '1' }).catch(() => {})
  const uniq = [...new Set(tmdbIds)]
  await redis.hSet(votesKey(ck, sid), { [uid]: JSON.stringify(uniq) })
  return { ok: true as const, myVotes: uniq }
}

export async function getLeaderboard() {
  const all = ((await redis.hGetAll(scoreKey(subId())).catch(() => null)) || {}) as Record<string, string>
  const sorted = Object.entries(all)
    .map(([uid, s]) => ({ userId: uid, score: Number(s) }))
    .sort((a, b) => b.score - a.score)
  const top = sorted.slice(0, 10)
  const names = await Promise.all(top.map((r) => redis.get(nameKey(r.userId)).catch(() => null)))
  const rows = top.map((r, i) => ({ ...r, username: names[i] || r.userId.replace(/^t2_/, '') }))
  const myIndex = sorted.findIndex((r) => r.userId === userId())
  const me = myIndex === -1 ? null : { rank: myIndex + 1, score: sorted[myIndex].score }
  return { rows, me }
}
