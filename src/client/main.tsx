import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

interface Question {
  id: string
  prompt: string
  options: string[]
  link: string
}
interface SlateEntry {
  tmdbId: number
  title: string
}
interface State {
  mode: 'quiz' | 'predict'
  date?: string
  questions?: Question[]
  picks?: Record<string, string>
  score?: number
  streak?: number
  week?: string
  providerLabel?: string
  slate?: SlateEntry[]
  myVotes?: number[]
}

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const resp = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`)
  return data as T
}

function Quiz({ state }: { state: State }) {
  const questions = state.questions || []
  const [picks, setPicks] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const [k, v] of Object.entries(state.picks || {})) init[k] = Number(v)
    return init
  })
  const [answers, setAnswers] = useState<Record<string, { answerIndex: number; link: string }>>({})
  const [score, setScore] = useState(state.score || 0)
  const [streak, setStreak] = useState(state.streak || 0)
  const [board, setBoard] = useState<{ userId: string; score: number }[] | null>(null)

  const current = questions.find((q) => picks[q.id] === undefined)
  const done = !current && questions.length > 0
  const correctCount = questions.filter((q) => answers[q.id]?.answerIndex === picks[q.id]).length

  const answer = async (q: Question, choice: number) => {
    setPicks((p) => ({ ...p, [q.id]: choice }))
    try {
      const res = await api<{ correct: boolean; answerIndex: number; link: string; score: number; streak: number }>(
        '/api/answer',
        { questionId: q.id, choice }
      )
      setAnswers((a) => ({ ...a, [q.id]: { answerIndex: res.answerIndex, link: res.link } }))
      setScore(res.score)
      if (res.streak) setStreak(res.streak)
    } catch {
      // already answered or offline — leave pick marked
    }
  }

  if (!questions.length) {
    return <div className='card'>No quiz data for today — check back tomorrow.</div>
  }

  return (
    <>
      <div className='meta'>
        <span>
          Question {Math.min(questions.length, Object.keys(picks).length + 1)} / {questions.length}
        </span>
        <span>
          Score {score}
          {streak > 1 ? ` · streak ${streak}` : ''}
        </span>
      </div>
      {questions.map((q) => {
        const picked = picks[q.id]
        const revealed = answers[q.id]
        return (
          <div className='card' key={q.id}>
            <div className='prompt'>{q.prompt}</div>
            {q.options.map((opt, i) => {
              let cls = 'opt'
              if (picked !== undefined && revealed) {
                if (i === revealed.answerIndex) cls += ' correct'
                else if (i === picked) cls += ' wrong'
                else cls += ' dim'
              }
              return (
                <button
                  key={i}
                  className={cls}
                  disabled={picked !== undefined}
                  onClick={() => answer(q, i)}
                >
                  {opt}
                </button>
              )
            })}
            {revealed && (
              <a className='link' href={revealed.link} target='_blank' rel='noreferrer'>
                See the live list →
              </a>
            )}
          </div>
        )
      })}
      {done && (
        <div className='card center'>
          <div className='brand'>Done for today</div>
          <div className='score-big'>
            {correctCount}/{questions.length}
          </div>
          <div className='sub'>{streak > 1 ? `${streak}-day perfect streak` : 'New quiz drops daily at 15:00 UTC'}</div>
          <button className='primary' onClick={() => api<{ rows: { userId: string; score: number }[] }>('/api/leaderboard').then((r) => setBoard(r.rows))}>
            Show leaderboard
          </button>
          {board && (
            <div style={{ marginTop: 14, textAlign: 'left' }}>
              {board.map((r, i) => (
                <div className='row' key={r.userId}>
                  <span>
                    #{i + 1} u/{r.userId.replace(/^t2_/, '')}
                  </span>
                  <span>{r.score} pts</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

function Predict({ state }: { state: State }) {
  const [votes, setVotes] = useState<number[]>(state.myVotes || [])
  const [saved, setSaved] = useState<number[]>(state.myVotes || [])
  const [msg, setMsg] = useState('')

  const toggle = (id: number) => {
    setVotes((v) => {
      if (v.includes(id)) return v.filter((x) => x !== id)
      return v.length < 3 ? [...v, id] : v
    })
  }

  const submit = async () => {
    try {
      const res = await api<{ myVotes: number[] }>('/api/vote', { tmdbIds: votes })
      setSaved(res.myVotes)
      setMsg('Votes locked in — results Sunday night (UTC).')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'vote failed')
    }
  }

  if (!state.slate?.length) {
    return <div className='card'>No prediction slate this week.</div>
  }

  const voted = saved.length > 0

  return (
    <div className='card'>
      <div className='prompt'>
        Which of these leave {state.providerLabel} this week? <span className='sub'>(pick up to 3)</span>
      </div>
      {state.slate.map((s) => (
        <label className='opt vote-opt' key={s.tmdbId}>
          <input
            type='checkbox'
            checked={votes.includes(s.tmdbId)}
            disabled={voted}
            onChange={() => toggle(s.tmdbId)}
          />
          {s.title}
        </label>
      ))}
      {!voted ? (
        <button className='primary' disabled={!votes.length} onClick={submit} style={{ marginTop: 8 }}>
          Lock in {votes.length} vote{votes.length === 1 ? '' : 's'}
        </button>
      ) : (
        <div className='toast'>You picked {saved.length} title{saved.length === 1 ? '' : 's'} — results drop Sunday.</div>
      )}
      {msg && !voted && <div className='err'>{msg}</div>}
    </div>
  )
}

function App() {
  const [state, setState] = useState<State | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api<State>('/api/state').then(setState).catch((e) => setErr(String(e)))
  }, [])

  if (err) return <div className='card'>Something went wrong loading the game.</div>
  if (!state) return <div className='card'>Loading…</div>

  return (
    <>
      <div className='brand'>Still Streaming? · galaxymovies.app</div>
      <h1>{state.mode === 'predict' ? 'Weekly prediction' : 'Daily streaming trivia'}</h1>
      <div className='sub'>
        {state.mode === 'predict'
          ? 'Real catalog data, real stakes — scored against actual departures.'
          : 'Every question is a real change from this week.'}
      </div>
      {state.mode === 'predict' ? <Predict state={state} /> : <Quiz state={state} />}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
