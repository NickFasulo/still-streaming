# Still Streaming?

A daily streaming-trivia game for Reddit, powered by real availability changes
from galaxymovies.app.

- **Daily quiz** (15:00 UTC, on the sub's configured post days): 3–5 questions
  built from this week's actual arrivals/departures across Netflix, Hulu,
  Disney+ and more. One-shot answers with a speed bonus, per-sub scores,
  streaks, and a leaderboard.
- **Weekly prediction** (Monday): the community votes on which titles leave a
  headline service this week; scored Sunday against the real diffs.

Every install plays the same quiz on the same day — payloads are shared
read-only JSON from the app.

## Fetch Domains

The following domains are requested for this app:

- `www.galaxymovies.app` — fetches read-only JSON payloads
  (`/api/trivia/daily`, `/api/trivia/weekly`, `/api/trivia/resolve`) containing
  the day's questions, the weekly prediction slate, and the slate's resolution.
  The app performs no other outbound requests.

## Data & privacy

Stores only pseudonymous Reddit IDs (`t2_*`) with answer picks, prediction
votes, per-subreddit scores, and streaks in Devvit Redis — used solely to
render scores and the leaderboard. No personal data leaves Reddit.

## Commands

- `npm run build` — client + server bundles into `dist/`
- `npm run typecheck` / `npm test` — tsc + vitest (game-logic tests)
- `npm run dev` — `devvit playtest` against `still_streaming_dev`
- `npm run upload` — upload a version to the Developer Portal
- `npm run assets` — regenerate the directory-listing PNGs (`--video` also
  writes `devvit-featuring-1500x1000.mp4`, `--gif` the animated fallback)
