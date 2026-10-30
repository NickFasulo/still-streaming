// Renders the app-directory assets: a buffering-spinner "?" badge over dim
// streaming-catalog rows — slate blues, no marquee chrome.
// Text is rendered via Righteous (OFL, bundled in scripts/fonts) converted
// to vector paths so output is identical on any machine.
// Usage: node scripts/generate-assets.cjs [--video] [--gif]
const sharp = require('sharp')
const path = require('path')
const TextToSVG = require('text-to-svg')

const OUT = path.join(__dirname, '..', 'assets')
const BLUE = '#7aa2e0'
const DEEP = '#2b6cb0'
const ICE = '#dbe7fb'
const INK = '#101419'

const tts = TextToSVG.loadSync(path.join(__dirname, 'fonts', 'Righteous-Regular.ttf'))
const txt = (str, x, y, size, fill, letterSpacing = 0) =>
  `<path d="${tts.getD(str, { x, y, fontSize: size, anchor: 'center baseline', letterSpacing })}" fill="${fill}"/>`
const txtMid = (str, x, y, size, fill) =>
  `<path d="${tts.getD(str, { x, y, fontSize: size, anchor: 'center middle' })}" fill="${fill}"/>`

const DEFS = `<defs>
  <radialGradient id="bgGlow" cx="50%" cy="38%" r="85%">
    <stop offset="0%" stop-color="#26303d"/>
    <stop offset="55%" stop-color="#171e26"/>
    <stop offset="100%" stop-color="#101419"/>
  </radialGradient>
  <radialGradient id="dotA" cx="42%" cy="38%" r="60%">
    <stop offset="0%" stop-color="#f4f8ff"/>
    <stop offset="40%" stop-color="#a9c4f2"/>
    <stop offset="80%" stop-color="#2b6cb0"/>
    <stop offset="100%" stop-color="#2b6cb0" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="disc" cx="50%" cy="40%" r="75%">
    <stop offset="0%" stop-color="#232d3a"/>
    <stop offset="100%" stop-color="#161d26"/>
  </radialGradient>
  <radialGradient id="halo" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#7aa2e0" stop-opacity="0.5"/>
    <stop offset="55%" stop-color="#7aa2e0" stop-opacity="0.2"/>
    <stop offset="100%" stop-color="#7aa2e0" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="vign" cx="50%" cy="50%" r="72%">
    <stop offset="60%" stop-color="#05070a" stop-opacity="0"/>
    <stop offset="100%" stop-color="#05070a" stop-opacity="0.55"/>
  </radialGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#7d9cc6"/>
    <stop offset="45%" stop-color="#3a5a80"/>
    <stop offset="60%" stop-color="#213a55"/>
    <stop offset="100%" stop-color="#5b7ba8"/>
  </linearGradient>
  <linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#1c2733"/>
    <stop offset="100%" stop-color="#131a22"/>
  </linearGradient>
</defs>`

// Staggered rows of rounded "title card" bars, like a streaming app's
// catalog grid scrolled behind everything. Rows alternate x-offset so the
// grid reads as endless rather than a deliberate pattern.
const catalogRows = (w, h, barW, barH, gap, opacity = 0.55) => {
  const colors = ['#1d2733', '#212c3a', '#1a2330', '#243041']
  const out = []
  let row = 0
  for (let y = -barH / 2; y < h + barH; y += barH + gap, row++) {
    const off = (row % 2) * (barW / 2 + gap / 2)
    let col = 0
    for (let x = -barW + off; x < w + barW; x += barW + gap, col++) {
      const c = colors[(row * 3 + col) % colors.length]
      out.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${barH}" rx="${(barH * 0.14).toFixed(1)}" fill="${c}" stroke="#2a3646" stroke-width="1.5" opacity="${opacity}"/>`)
    }
  }
  return out.join('')
}

// One buffering dot. level: 2 lit (blue core), 1 fading tail, 0 asleep.
// glow scales halo strength (used for the video pulse).
const dot = (x, y, r, level, glow = 1) => {
  if (level === 0)
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#3a4a5f"/>`
  const o = level === 1 ? 0.55 : 1
  return (
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r * 2.6).toFixed(1)}" fill="url(#halo)" opacity="${Math.min(1, o * glow)}"/>` +
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="url(#dotA)" opacity="${o}"/>`
  )
}

const N_DOTS = 12

// A comet-tail spinner ring: dots ahead of `phase` burn lit, the next few
// fade, the rest sleep. One full loop is N_DOTS phase steps.
const spinnerRing = (cx, cy, r, dotR, phase = 0, glow = 1) => {
  const out = []
  for (let i = 0; i < N_DOTS; i++) {
    const a = (i / N_DOTS) * Math.PI * 2 - Math.PI / 2
    const d = ((i - phase) % N_DOTS + N_DOTS) % N_DOTS
    const level = d < 2 ? 2 : d < 6 ? 1 : 0
    out.push(dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, dotR, level, glow))
  }
  return out.join('')
}

// The medallion: steel rim, spinner ring, inset disc holding a rounded
// "screen" with the "?".
const badge = (cx, cy, r, phase = 0, glow = 1) => `
  <circle cx="${cx}" cy="${cy}" r="${r * 1.16}" fill="url(#halo)"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${INK}" stroke="url(#rim)" stroke-width="${r * 0.05}"/>
  ${spinnerRing(cx, cy, r * 0.84, r * 0.062, phase, glow)}
  <circle cx="${cx}" cy="${cy}" r="${r * 0.62}" fill="url(#disc)" stroke="#0c1016" stroke-width="${r * 0.02}"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.62}" fill="none" stroke="#3a5a80" stroke-width="${r * 0.012}" opacity="0.8"/>
  <rect x="${(cx - r * 0.4).toFixed(1)}" y="${(cy - r * 0.31).toFixed(1)}" width="${(r * 0.8).toFixed(1)}" height="${(r * 0.62).toFixed(1)}" rx="${(r * 0.1).toFixed(1)}" fill="url(#screen)" stroke="${DEEP}" stroke-width="${r * 0.025}"/>
  ${txtMid('?', cx + r * 0.02, cy + r * 0.035, r * 0.4, '#0b0f14')}
  ${txtMid('?', cx, cy + r * 0.005, r * 0.4, ICE)}`

const vignette = (w, h) => `<rect width="${w}" height="${h}" fill="url(#vign)"/>`

const icon = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
${DEFS}
<clipPath id="iconClip"><rect width="512" height="512" rx="104"/></clipPath>
<rect width="512" height="512" rx="104" fill="url(#bgGlow)"/>
<g clip-path="url(#iconClip)">${catalogRows(512, 512, 130, 74, 18, 0.5)}</g>
${badge(256, 256, 216)}
${vignette(512, 512)}
</svg>`

const tile = `<svg width="560" height="256" xmlns="http://www.w3.org/2000/svg">
${DEFS}
<rect width="560" height="256" fill="url(#bgGlow)"/>
${catalogRows(560, 256, 110, 62, 16, 0.4)}
<rect x="12" y="12" width="536" height="232" rx="20" fill="#101419" fill-opacity="0.72" stroke="url(#rim)" stroke-width="6"/>
${txt('STILL STREAMING?', 280, 118, 40, ICE, 0.04)}
<rect x="180" y="140" width="200" height="4" rx="2" fill="${BLUE}"/>
${txt('DAILY STREAMING TRIVIA', 280, 174, 17, BLUE, 0.16)}
${vignette(560, 256)}
</svg>`

const featuringSvg = (phase = 0, glow = 1) => `<svg width="1500" height="1000" xmlns="http://www.w3.org/2000/svg">
${DEFS}
<rect width="1500" height="1000" fill="url(#bgGlow)"/>
${catalogRows(1500, 1000, 300, 170, 36, 0.4)}
<rect x="30" y="95" width="1440" height="810" rx="44" fill="#101419" fill-opacity="0.68" stroke="url(#rim)" stroke-width="12"/>
${badge(750, 330, 190, phase, glow)}
${txt('STILL STREAMING?', 750, 620, 96, ICE, 0.06)}
<rect x="570" y="680" width="360" height="6" rx="3" fill="${BLUE}"/>
${txt('The daily streaming trivia game', 750, 762, 40, '#b9c8dd')}
${txt('REAL ARRIVALS & DEPARTURES · EVERY WEEK', 750, 824, 26, BLUE, 0.16)}
${vignette(1500, 1000)}
</svg>`

async function main() {
  await sharp(Buffer.from(icon)).png().toFile(path.join(OUT, 'devvit-icon-512.png'))
  await sharp(Buffer.from(tile)).png().toFile(path.join(OUT, 'devvit-tile-560x256.png'))
  await sharp(Buffer.from(featuringSvg())).png().toFile(path.join(OUT, 'devvit-featuring-1500x1000.png'))
  // The form's optional "fallback asset" is the static stand-in for a video
  // featuring asset — the same art works.
  await sharp(Buffer.from(featuringSvg())).png().toFile(path.join(OUT, 'devvit-fallback-1500x1000.png'))
  console.log('wrote assets/')

  // --video: 8s seamless loop for the featuring slot (the only one that
  // accepts video; requires 6-15s). The spinner completes two rotations;
  // halos pulse gently.
  if (process.argv.includes('--video')) {
    const fs = require('fs')
    const HME = require('h264-mp4-encoder')
    const encoder = await HME.createH264MP4Encoder()
    encoder.width = 1500
    encoder.height = 1000
    encoder.frameRate = 24
    encoder.quantizationParameter = 17
    encoder.speed = 2
    encoder.groupOfPictures = 24
    encoder.initialize()
    const FRAMES = 192
    for (let f = 0; f < FRAMES; f++) {
      const phase = Math.floor((f * 2 * N_DOTS) / FRAMES) % N_DOTS
      // cos peaks at f=0 so frame 0 matches the static fallback PNG exactly
      const glow = 0.85 + 0.15 * Math.cos((2 * Math.PI * 3 * f) / FRAMES)
      const { data } = await sharp(Buffer.from(featuringSvg(phase, glow)))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      encoder.addFrameRgba(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      if (f % 30 === 0) console.log(`frame ${f}/${FRAMES}`)
    }
    encoder.finalize()
    fs.writeFileSync(
      path.join(OUT, 'devvit-featuring-1500x1000.mp4'),
      Buffer.from(encoder.FS.readFile(encoder.outputFilename)),
    )
    encoder.delete()
    console.log('wrote devvit-featuring-1500x1000.mp4')
  }

  // --gif: animated fallback for the featuring video (Reddit asks for a GIF
  // fallback when featuring is a video: 3:2, 1000-1500px wide, 3-10s looped,
  // <=3MB). Shared palette from frame 0 plus transparent-index diffs against
  // the previous frame keep the file small.
  if (process.argv.includes('--gif')) {
    const fs = require('fs')
    const { GIFEncoder, quantize, applyPalette } = require('gifenc')
    const W = 1000
    const H = 667
    const FRAMES = 36
    const TIDX = 255
    // Ordered dither before palette mapping: a static Bayer pattern keeps the
    // smooth gradient from banding into steps at 255 colors. It is spatially
    // fixed, so unchanged regions still diff to transparent — no flicker.
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16 - 0.5)
    const dither = (data) => {
      const d = new Uint8ClampedArray(data.length)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4
          const t = BAYER[(y % 4) * 4 + (x % 4)] * 14
          d[i] = data[i] + t
          d[i + 1] = data[i + 1] + t
          d[i + 2] = data[i + 2] + t
          d[i + 3] = data[i + 3]
        }
      }
      return d
    }
    const gif = GIFEncoder()
    let palette = null
    let prev = null
    for (let f = 0; f < FRAMES; f++) {
      const phase = Math.floor((f * N_DOTS) / FRAMES) % N_DOTS
      const glow = 0.85 + 0.15 * Math.cos((2 * Math.PI * 2 * f) / FRAMES)
      const { data } = await sharp(Buffer.from(featuringSvg(phase, glow)))
        .resize(W, H)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (!palette) palette = quantize(data, TIDX)
      const idx = applyPalette(dither(data), palette, 'rgba')
      // dispose:1 (keep) is required for diff accumulation — an unspecified
      // disposal is treated as restore-to-background by some viewers, which
      // would flash the canvas between frames.
      if (!prev) {
        gif.writeFrame(idx, W, H, { palette, delay: 100, repeat: 0, dispose: 1 })
      } else {
        const diff = new Uint8Array(idx.length)
        for (let i = 0; i < idx.length; i++) diff[i] = idx[i] === prev[i] ? TIDX : idx[i]
        gif.writeFrame(diff, W, H, {
          palette: palette.concat([[0, 0, 0]]),
          transparent: true,
          transparentIndex: TIDX,
          dispose: 1,
          delay: 100
        })
      }
      prev = idx
      if (f % 12 === 0) console.log(`gif frame ${f}/${FRAMES}`)
    }
    gif.finish()
    fs.writeFileSync(path.join(OUT, 'devvit-fallback-1000x667.gif'), Buffer.from(gif.bytes()))
    console.log('wrote devvit-fallback-1000x667.gif')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
