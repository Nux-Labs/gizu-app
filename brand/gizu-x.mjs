// X profile kit on the Kurage brand: ink, cyan to violet, ASCII chameleon.
// The chameleon comes from the app's own field, frozen at one frame.
// Usage: node brand/gizu-x.mjs  (writes .html sources, then renders .png with Chrome)

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createStyler, frame, hash } from '../landing/src/chameleon/field.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TIME = Number(process.env.GIZU_TIME ?? 4.6)

const INK = '#04060a'
const CYAN = '#7ce8f2'
const VIOLET = '#b9a6ff'
const TEXT = '#f1f4f8'
const MUTED = 'rgba(241,244,248,0.5)'
const FAINT = 'rgba(241,244,248,0.28)'

const logoPath = readFileSync(join(HERE, '../frontend/public/gizulogo.svg'), 'utf8').match(/ d="([^"]+)"/)[1]
const logo = (h) =>
  `<svg viewBox="0 0 638 866" height="${h}" style="display:block;overflow:visible">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${CYAN}"/><stop offset="1" stop-color="${VIOLET}"/>
    </linearGradient></defs>
    <path d="${logoPath}" fill="url(#lg)"/></svg>`

const DUST = ['.', '.', '.', '-', '-', "'", ',', '·']

// Faint cell grid, drifting dust and the chameleon mosaic, as one SVG layer.
function field(width, height, { anchorX, anchorY, scale, cw = 10, ch = 15, dust = true }) {
  const fs = Math.round(ch * 0.74)
  const out = []
  for (let x = cw; x < width; x += cw) out.push(`<rect x="${x}" width="1" height="${height}"/>`)
  for (let y = ch; y < height; y += ch) out.push(`<rect y="${y}" width="${width}" height="1"/>`)
  const grid = `<g fill="rgba(255,255,255,0.03)">${out.join('')}</g>`
  const glyphs = []
  const text = (g, x, y, fill) =>
    `<text x="${x + cw / 2}" y="${y + ch / 2 + 0.5}" fill="${fill}">${g.replace('&', '&amp;').replace('<', '&lt;')}</text>`
  if (dust) {
    const cols = width / cw
    const rows = height / ch
    for (let i = 0; i < (cols * rows) / 80; i++) {
      const col = (hash(i, 1, 7) * cols) | 0
      const row = (hash(i, 2, 7) * rows) | 0
      const a = (0.14 + hash(i, 3, 7) * 0.3).toFixed(3)
      glyphs.push(text(DUST[(hash(i, 4, 7) * DUST.length) | 0], col * cw, row * ch, `rgba(150,172,205,${a})`))
    }
  }
  const tiles = []
  for (const c of scale ? frame({ width, height, cw, ch, anchorX, anchorY, scale }, TIME, createStyler()) : []) {
    if (c.tile) tiles.push(`<rect x="${c.x + 1}" y="${c.y + 1}" width="${cw - 2}" height="${ch - 2}" fill="${c.tile}"/>`)
    glyphs.push(text(c.glyph, c.x, c.y, c.color))
  }
  return `<svg class="field" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${grid}<g>${tiles.join('')}</g>
    <g font-family="Geist Mono, ui-monospace, Menlo, monospace" font-weight="500" font-size="${fs}"
       text-anchor="middle" dominant-baseline="middle">${glyphs.join('')}</g></svg>`
}

const page = (w, h, body) => `<!doctype html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=block" rel="stylesheet">
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: ${INK}; }
  body { position: relative; font-family: Geist, 'Helvetica Neue', Arial, sans-serif; color: ${TEXT}; }
  .abs { position: absolute; inset: 0; }
  .field { position: absolute; inset: 0; }
  .grad { background: linear-gradient(100deg, ${CYAN}, ${VIOLET}); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .mono { font-family: 'Geist Mono', ui-monospace, Menlo, monospace; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: ${CYAN}; box-shadow: 0 0 10px ${CYAN}; }
</style></head><body>${body}</body></html>`

const glows = (spots) =>
  spots.map(([x, y, r, c, a]) =>
    `<div class="abs" style="background: radial-gradient(${r}px ${r}px at ${x}px ${y}px, ${c}${a}, transparent 70%)"></div>`).join('')

// 400x400 profile picture, shown as a circle.
const avatar = page(400, 400, `
  ${glows([[90, 70, 340, CYAN, '2e'], [330, 350, 360, VIOLET, '30']])}
  ${field(400, 400, { anchorX: 0.5, anchorY: 0.5, scale: 0, dust: true })}
  <div class="abs" style="background: radial-gradient(150px 150px at 200px 200px, ${INK}e6, transparent 100%)"></div>
  <div class="abs" style="display:flex;align-items:center;justify-content:center;filter: drop-shadow(0 0 22px rgba(124,232,242,0.35))">
    ${logo(210)}
  </div>`)

// 1500x500 header. X puts the profile picture over the lower left, so the copy sits above it.
const cover = page(1500, 500, `
  ${glows([[1080, 250, 620, CYAN, '22'], [1320, 420, 520, VIOLET, '26'], [260, 120, 520, CYAN, '10']])}
  ${field(1500, 500, { anchorX: 0.7, anchorY: 0.52, scale: 175 })}
  <div class="abs" style="background: linear-gradient(90deg, ${INK} 0%, ${INK}d9 30%, transparent 55%)"></div>
  <div style="position:absolute;left:96px;top:78px;width:640px">
    <div style="display:flex;align-items:center;gap:14px">
      <div style="filter: drop-shadow(0 0 12px rgba(124,232,242,0.4))">${logo(40)}</div>
      <span style="font-size:26px;font-weight:500;letter-spacing:-0.03em">Gizu</span>
    </div>
    <h1 style="margin-top:34px;font-size:78px;font-weight:600;line-height:0.98;letter-spacing:-0.045em">
      <span class="grad">DeFi</span> <span style="color:${MUTED}">in</span><br>
      <span class="grad">Stealth</span> <span style="color:${MUTED}">Mode</span>
    </h1>
    <p style="margin-top:22px;font-size:19px;line-height:1.5;color:${MUTED};max-width:440px">
      Curated confidential vaults, settlement in minutes. Your keys stay on your device.
    </p>
  </div>
  <div class="mono" style="position:absolute;right:56px;bottom:34px;display:flex;align-items:center;gap:12px;font-size:13px;letter-spacing:0.3em;text-transform:uppercase;color:${FAINT}">
    <span class="dot"></span>invite only
  </div>`)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome']
  .find(existsSync)

for (const [name, html, w, h] of [['gizu-x-avatar', avatar, 400, 400], ['gizu-x-cover', cover, 1500, 500]]) {
  const src = join(HERE, `${name}.html`)
  writeFileSync(src, html)
  if (!CHROME) continue
  // virtual time lets the Google Fonts stylesheet and faces load before the shot
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=6000',
    `--window-size=${w},${h}`, `--screenshot=${join(HERE, `${name}.png`)}`, pathToFileURL(src).href], { stdio: 'ignore' })
  console.log(`${name}.png written`)
}
