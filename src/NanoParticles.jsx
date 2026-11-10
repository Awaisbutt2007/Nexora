import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import femalePhoto from './assets/portrait-female.png'
import malePhoto from './assets/portrait-male.png'
import { isSpeechActive, mouthLevel } from './speechViz.js'

/* Holographic palette (dark indigo → electric blue → cyan → violet → pink
   highlight). A portrait's own photo brightness picks the stop, so shadows read
   deep blue and lit skin glows cyan/violet — a sci-fi hologram, not grey dust. */
const HOLO_STOPS = [
  [0, [0.04, 0.08, 0.32]],
  [0.3, [0.15, 0.39, 0.92]],
  [0.55, [0.13, 0.83, 0.93]],
  [0.8, [0.65, 0.55, 0.98]],
  [1, [0.96, 0.67, 0.99]],
]
function holoAt(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  for (let i = 1; i < HOLO_STOPS.length; i += 1) {
    const [p1, c1] = HOLO_STOPS[i]
    if (x <= p1) {
      const [p0, c0] = HOLO_STOPS[i - 1]
      const k = (x - p0) / (p1 - p0)
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
    }
  }
  return HOLO_STOPS[HOLO_STOPS.length - 1][1]
}
/* Recolour a photo-tinted particle set into the hologram palette, keeping a
   little of the real colour so lips and eyes still read. */
function holoize(src, targets, count) {
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    const b = i * 3
    const l = 0.299 * src[b] + 0.587 * src[b + 1] + 0.114 * src[b + 2]
    const y = targets[b + 1]
    /* the power curve keeps mid-tones in the blue/cyan band so only real
       highlights reach violet/pink — otherwise lit skin washes out to white */
    const g = holoAt(Math.pow(l, 1.5) * 0.86 + ((y + 2.6) / 5.2) * 0.14)
    const lit = 0.38 + 0.78 * l
    out[b] = Math.min(1, (g[0] * 0.9 + src[b] * 0.1) * lit)
    out[b + 1] = Math.min(1, (g[1] * 0.9 + src[b + 1] * 0.1) * lit)
    out[b + 2] = Math.min(1, (g[2] * 0.9 + src[b + 2] * 0.1) * lit)
  }
  return out
}

/**
 * 30k silver nano particles that live in one of three shapes:
 * - 'orb'     : a dense cloud + ring spinning around a dark gunmetal core
 * - 'female'  : the cloud assembles into a feminine portrait
 * - 'male'    : a masculine portrait
 *
 * Realism trick (same idea as studio "particle portrait" installs):
 * a grayscale SHADED portrait is painted on an offscreen canvas (side
 * lighting, cheek/nose highlights, eye-socket and jaw shadows, hair mass).
 * Each particle then samples that image with probability proportional to
 * pixel brightness — bright skin gets dense sparkles, shadows get sparse
 * wisps, black background gets nothing — and brightness also drives Z
 * depth, so the point cloud reads as a 3D lit face, not a flat outline.
 * The finished portrait is rotated slightly sideways (3/4 view).
 */

const CANVAS_W = 512
const CANVAS_H = 640

/* Paint the shaded grayscale portrait; brightness = particle density */
function drawPortrait(ctx, gender) {
  const W = CANVAS_W
  const H = CANVAS_H
  const female = gender === 'female'
  const cx = W / 2 - 8
  const eyeY = 262
  const faceRx = female ? 92 : 103
  const faceRy = female ? 118 : 128

  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)

  /* ---- face base: lit from upper-left, falls into shadow on the right ---- */
  const skin = ctx.createRadialGradient(cx - 38, eyeY - 46, 18, cx + 10, eyeY + 10, faceRx + 78)
  skin.addColorStop(0, 'rgba(255,255,255,0.98)')
  skin.addColorStop(0.45, 'rgba(205,211,224,0.8)')
  skin.addColorStop(0.75, 'rgba(120,127,145,0.5)')
  skin.addColorStop(1, 'rgba(28,32,44,0.12)')
  ctx.fillStyle = skin
  ctx.beginPath()
  if (female) {
    /* softly tapered oval with a small chin */
    ctx.moveTo(cx - faceRx, eyeY - 24)
    ctx.bezierCurveTo(cx - faceRx - 4, eyeY + 52, cx - 44, eyeY + faceRy, cx, eyeY + faceRy + 4)
    ctx.bezierCurveTo(cx + 44, eyeY + faceRy, cx + faceRx + 4, eyeY + 52, cx + faceRx, eyeY - 24)
    ctx.bezierCurveTo(cx + faceRx - 6, eyeY - faceRy + 12, cx - faceRx + 6, eyeY - faceRy + 12, cx - faceRx, eyeY - 24)
  } else {
    /* angular jaw with a wider chin corner */
    ctx.moveTo(cx - faceRx, eyeY - 28)
    ctx.lineTo(cx - faceRx + 6, eyeY + 46)
    ctx.bezierCurveTo(cx - faceRx + 16, eyeY + 82, cx - 40, eyeY + faceRy + 4, cx, eyeY + faceRy + 8)
    ctx.bezierCurveTo(cx + 40, eyeY + faceRy + 4, cx + faceRx - 16, eyeY + 82, cx + faceRx - 6, eyeY + 46)
    ctx.lineTo(cx + faceRx, eyeY - 28)
    ctx.bezierCurveTo(cx + faceRx - 8, eyeY - faceRy + 8, cx - faceRx + 8, eyeY - faceRy + 8, cx - faceRx, eyeY - 28)
  }
  ctx.closePath()
  ctx.fill()

  /* ---- neck + shoulders ---- */
  const neckHalf = female ? 24 : 38
  const neckTop = eyeY + faceRy - 44
  const neckG = ctx.createLinearGradient(cx - neckHalf, 0, cx + neckHalf, 0)
  neckG.addColorStop(0, 'rgba(190,196,212,0.75)')
  neckG.addColorStop(1, 'rgba(60,66,82,0.4)')
  ctx.fillStyle = neckG
  ctx.fillRect(cx - neckHalf, neckTop, neckHalf * 2, 96)

  const shY = female ? 474 : 456
  const shHalf = female ? 152 : 232
  const shG = ctx.createLinearGradient(cx - shHalf, 0, cx + shHalf, 0)
  shG.addColorStop(0, 'rgba(160,168,186,0.55)')
  shG.addColorStop(0.5, 'rgba(108,115,134,0.42)')
  shG.addColorStop(1, 'rgba(30,34,46,0.18)')
  ctx.fillStyle = shG
  ctx.beginPath()
  ctx.moveTo(cx - shHalf, H)
  ctx.quadraticCurveTo(cx - shHalf + 26, shY + 26, cx - neckHalf - 24, shY)
  ctx.lineTo(cx + neckHalf + 24, shY)
  ctx.quadraticCurveTo(cx + shHalf - 26, shY + 26, cx + shHalf, H)
  ctx.closePath()
  ctx.fill()

  if (female) {
    /* slim hourglass waist line only — no bust shading */
    ctx.filter = 'blur(11px)'
    ctx.fillStyle = 'rgba(6,8,14,0.5)'
    ctx.beginPath()
    ctx.ellipse(cx, shY + 122, 56, 38, 0, 0, Math.PI * 2)
    ctx.fill()
  } else {
    /* adult male: trapezius slope + broad chest for a heavier frame */
    ctx.filter = 'blur(9px)'
    ctx.fillStyle = 'rgba(150,158,178,0.4)'
    ctx.beginPath()
    ctx.moveTo(cx - neckHalf - 4, neckTop + 30)
    ctx.quadraticCurveTo(cx - shHalf + 30, shY - 26, cx - shHalf + 6, H)
    ctx.lineTo(cx - neckHalf + 16, H)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cx + neckHalf + 4, neckTop + 30)
    ctx.quadraticCurveTo(cx + shHalf - 30, shY - 26, cx + shHalf - 6, H)
    ctx.lineTo(cx + neckHalf - 16, H)
    ctx.closePath()
    ctx.fill()
    /* chest shadow line */
    ctx.fillStyle = 'rgba(8,10,16,0.35)'
    ctx.beginPath()
    ctx.ellipse(cx, shY + 96, 10, 52, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  /* under-chin shadow */
  ctx.filter = 'blur(9px)'
  ctx.fillStyle = 'rgba(6,8,14,0.75)'
  ctx.beginPath()
  ctx.ellipse(cx, neckTop + 14, female ? 46 : 54, 16, 0, 0, Math.PI * 2)
  ctx.fill()

  /* ---- hair: dark mass with a few bright strands ---- */
  ctx.filter = 'blur(3px)'
  ctx.fillStyle = 'rgba(10,12,20,0.96)'
  if (female) {
    /* long thick middle-parted hair falling well past the shoulders */
    ctx.beginPath()
    ctx.moveTo(cx - 2, eyeY - faceRy - 26)
    ctx.quadraticCurveTo(cx - faceRx - 42, eyeY - faceRy + 22, cx - faceRx - 38, eyeY + 50)
    ctx.quadraticCurveTo(cx - faceRx - 46, eyeY + 180, cx - faceRx - 16, eyeY + 268)
    ctx.lineTo(cx - faceRx + 34, eyeY + 252)
    ctx.quadraticCurveTo(cx - faceRx + 24, eyeY + 60, cx - faceRx + 28, eyeY - 12)
    ctx.quadraticCurveTo(cx - faceRx + 30, eyeY - faceRy + 34, cx - 8, eyeY - faceRy + 8)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cx + 2, eyeY - faceRy - 26)
    ctx.quadraticCurveTo(cx + faceRx + 42, eyeY - faceRy + 22, cx + faceRx + 38, eyeY + 50)
    ctx.quadraticCurveTo(cx + faceRx + 46, eyeY + 180, cx + faceRx + 16, eyeY + 268)
    ctx.lineTo(cx + faceRx - 34, eyeY + 252)
    ctx.quadraticCurveTo(cx + faceRx - 24, eyeY + 60, cx + faceRx - 28, eyeY - 12)
    ctx.quadraticCurveTo(cx + faceRx - 30, eyeY - faceRy + 34, cx + 8, eyeY - faceRy + 8)
    ctx.closePath()
    ctx.fill()
    /* crown volume above the parting */
    ctx.beginPath()
    ctx.ellipse(cx, eyeY - faceRy + 16, faceRx + 6, 44, 0, Math.PI, Math.PI * 2)
    ctx.fill()
  } else {
    /* short thick textured crop, taller on top (clean Gen-Z fringe) */
    ctx.beginPath()
    ctx.moveTo(cx - faceRx + 2, eyeY - 24)
    ctx.quadraticCurveTo(cx - faceRx - 10, eyeY - faceRy - 12, cx - 10, eyeY - faceRy - 36)
    ctx.quadraticCurveTo(cx + faceRx + 6, eyeY - faceRy - 16, cx + faceRx - 2, eyeY - 20)
    ctx.quadraticCurveTo(cx + faceRx - 26, eyeY - faceRy + 56, cx + 42, eyeY - faceRy + 42)
    ctx.quadraticCurveTo(cx + 10, eyeY - faceRy + 60, cx - 26, eyeY - faceRy + 42)
    ctx.quadraticCurveTo(cx - faceRx + 18, eyeY - faceRy + 56, cx - faceRx + 2, eyeY - 24)
    ctx.closePath()
    ctx.fill()
    /* temple hair / side burn in front of the ears */
    ctx.beginPath()
    ctx.ellipse(cx - faceRx + 8, eyeY - 24, 10, 26, 0.1, 0, Math.PI * 2)
    ctx.ellipse(cx + faceRx - 8, eyeY - 24, 10, 26, -0.1, 0, Math.PI * 2)
    ctx.fill()
  }
  /* hair sheen — bright strands catch the key light */
  ctx.filter = 'blur(4px)'
  ctx.strokeStyle = 'rgba(235,240,250,0.4)'
  ctx.lineWidth = 2.5
  for (let s = 0; s < 7; s += 1) {
    const ox = cx - 60 + s * 16
    ctx.beginPath()
    ctx.moveTo(ox, eyeY - faceRy - 8 + Math.abs(s - 3) * 3)
    ctx.quadraticCurveTo(ox + (female ? -14 : -6), eyeY - faceRy + 26, ox + (female ? -22 : -8), eyeY - faceRy + 52)
    ctx.stroke()
  }
  if (female) {
    /* long glossy strands running down the side falls */
    ctx.strokeStyle = 'rgba(228,234,246,0.3)'
    ctx.lineWidth = 2
    for (const side of [-1, 1]) {
      for (let s = 0; s < 3; s += 1) {
        const ox = cx + side * (faceRx - 12 + s * 12)
        ctx.beginPath()
        ctx.moveTo(ox, eyeY - faceRy + 40)
        ctx.quadraticCurveTo(ox + side * 18, eyeY + 60, ox + side * 10, eyeY + 235)
        ctx.stroke()
      }
    }
  }

  /* ---- eye sockets, brows, eyes ---- */
  ctx.filter = 'blur(4px)'
  ctx.fillStyle = 'rgba(12,15,24,0.8)'
  const eyeDX = female ? 33 : 36
  ctx.beginPath()
  ctx.ellipse(cx - eyeDX, eyeY, 22, 11, 0, 0, Math.PI * 2)
  ctx.ellipse(cx + eyeDX, eyeY, 22, 11, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.filter = 'blur(1.6px)'
  /* brows */
  ctx.strokeStyle = female ? 'rgba(14,16,26,0.92)' : 'rgba(16,19,28,0.9)'
  ctx.lineWidth = female ? 4.5 : 5.5
  ctx.beginPath()
  if (female) {
    /* winged brows flicked up at the outer corners */
    ctx.moveTo(cx - 14, eyeY - 20)
    ctx.quadraticCurveTo(cx - eyeDX - 2, eyeY - 32, cx - eyeDX - 23, eyeY - 25)
    ctx.moveTo(cx + 14, eyeY - 20)
    ctx.quadraticCurveTo(cx + eyeDX + 2, eyeY - 32, cx + eyeDX + 23, eyeY - 25)
  } else {
    /* straight, soft Gen-Z brows */
    ctx.moveTo(cx - eyeDX - 19, eyeY - 19)
    ctx.quadraticCurveTo(cx - eyeDX, eyeY - 24, cx - eyeDX + 19, eyeY - 20)
    ctx.moveTo(cx + eyeDX - 19, eyeY - 20)
    ctx.quadraticCurveTo(cx + eyeDX, eyeY - 24, cx + eyeDX + 19, eyeY - 19)
  }
  ctx.stroke()
  /* eyeballs: dark almond + catch-light */
  ctx.fillStyle = 'rgba(8,10,16,0.9)'
  ctx.beginPath()
  ctx.ellipse(cx - eyeDX, eyeY, 12, female ? 5.5 : 4.6, 0.06, 0, Math.PI * 2)
  ctx.ellipse(cx + eyeDX, eyeY, 12, female ? 5.5 : 4.6, -0.06, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(250,252,255,0.95)'
  ctx.beginPath()
  ctx.arc(cx - eyeDX + 4, eyeY - 2, 2.1, 0, Math.PI * 2)
  ctx.arc(cx + eyeDX + 4, eyeY - 2, 2.1, 0, Math.PI * 2)
  ctx.fill()

  /* ---- nose: bright ridge + shadow side + nostrils ---- */
  ctx.filter = 'blur(5px)'
  const noseG = ctx.createLinearGradient(cx - 16, eyeY, cx + 14, eyeY)
  noseG.addColorStop(0, 'rgba(255,255,255,0.0)')
  noseG.addColorStop(0.35, 'rgba(255,255,255,0.75)')
  noseG.addColorStop(1, 'rgba(20,24,34,0.6)')
  ctx.fillStyle = noseG
  ctx.beginPath()
  ctx.moveTo(cx - 7, eyeY + 6)
  ctx.lineTo(cx - 11, eyeY + 52)
  ctx.quadraticCurveTo(cx, eyeY + 62, cx + 10, eyeY + 52)
  ctx.lineTo(cx + 6, eyeY + 6)
  ctx.closePath()
  ctx.fill()
  ctx.filter = 'blur(2.5px)'
  ctx.fillStyle = 'rgba(8,10,16,0.85)'
  ctx.beginPath()
  ctx.ellipse(cx - 8, eyeY + 56, 4.5, 2.6, 0.3, 0, Math.PI * 2)
  ctx.ellipse(cx + 8, eyeY + 56, 4.5, 2.6, -0.3, 0, Math.PI * 2)
  ctx.fill()

  /* ---- lips ---- */
  ctx.filter = 'blur(2px)'
  const mouthW = female ? 27 : 23
  const mouthY = eyeY + (female ? 84 : 88)
  ctx.strokeStyle = 'rgba(10,12,20,0.95)'
  ctx.lineWidth = female ? 5.5 : 3.2
  ctx.beginPath()
  ctx.moveTo(cx - mouthW, mouthY)
  if (female) {
    /* full cupid's bow upper lip */
    ctx.quadraticCurveTo(cx - mouthW / 2, mouthY - 9, cx, mouthY - 5)
    ctx.quadraticCurveTo(cx + mouthW / 2, mouthY - 9, cx + mouthW, mouthY)
  } else {
    ctx.quadraticCurveTo(cx, mouthY - 4, cx + mouthW, mouthY)
  }
  /* lower lip curve */
  ctx.quadraticCurveTo(cx, mouthY + (female ? 15 : 9), cx - mouthW, mouthY)
  ctx.stroke()
  /* lower-lip gloss highlight */
  ctx.fillStyle = female ? 'rgba(240,244,252,0.68)' : 'rgba(226,232,244,0.45)'
  ctx.beginPath()
  ctx.ellipse(cx, mouthY + (female ? 9 : 6), mouthW * 0.55, female ? 4 : 3, 0, 0, Math.PI * 2)
  ctx.fill()

  /* ---- cheek + jaw shading ---- */
  ctx.filter = 'blur(12px)'
  /* shadow side of the face (right) */
  ctx.fillStyle = 'rgba(6,8,14,0.6)'
  ctx.beginPath()
  ctx.ellipse(cx + faceRx - 14, eyeY + 26, 26, faceRy * 0.62, 0.1, 0, Math.PI * 2)
  ctx.fill()
  /* cheekbone highlight (left, key light) */
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.beginPath()
  ctx.ellipse(cx - eyeDX - 6, eyeY + 34, 20, 13, -0.4, 0, Math.PI * 2)
  ctx.fill()
  /* forehead highlight */
  ctx.fillStyle = 'rgba(255,255,255,0.32)'
  ctx.beginPath()
  ctx.ellipse(cx - 16, eyeY - faceRy + 46, 34, 16, -0.15, 0, Math.PI * 2)
  ctx.fill()
  ctx.filter = 'none'
}

/* Sample the portrait: bright pixel → higher chance of a particle there */
function faceTargets(gender, count) {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  drawPortrait(ctx, gender)
  const { data } = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H)
  const arr = new Float32Array(count * 3)
  /* crop tightly around the figure so the portrait reads much larger */
  const crop = gender === 'female' ? { x: 48, y: 92, w: 384, h: 548 } : { x: 0, y: 84, w: 512, h: 556 }
  const worldW = gender === 'female' ? 4 : 4.3
  const worldH = worldW * (crop.h / crop.w)
  const cropCx = crop.x + crop.w / 2
  const cropCy = crop.y + crop.h / 2
  for (let i = 0; i < count; i += 1) {
    let px = cropCx
    let py = cropCy
    let luma = 0.7
    for (let tries = 0; tries < 600; tries += 1) {
      px = (crop.x + Math.random() * crop.w) | 0
      py = (crop.y + Math.random() * crop.h) | 0
      const idx = (py * CANVAS_W + px) * 4
      luma = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255
      const p = luma < 0.05 ? 0 : 0.05 + Math.pow(luma, 1.6) * 0.95
      if (Math.random() < p) break
    }
    arr[i * 3] = ((px - cropCx) / crop.w) * worldW
    arr[i * 3 + 1] = -((py - cropCy) / crop.h) * worldH + 0.18
    /* brightness fakes depth: lit areas push forward, shadows recede */
    arr[i * 3 + 2] = (luma - 0.55) * 1.05 + (Math.random() - 0.5) * 0.14
  }
  return arr
}

/* Deliberately strict skin test. Pale/cream walls sit outside this box, and a
   tan headboard fails on Cb — so it marks real face skin and nothing else. */
function isSkinPixel(data, i) {
  const r = data[i]
  const g = data[i + 1]
  const b = data[i + 2]
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b
  return data[i + 3] > 200 && r > 50 && mx - mn > 15 && r > g && r > b && cb >= 68 && cb <= 130 && cr >= 133 && cr <= 185
}

const lumaOf = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]

/* Turn a photo pixel into the colour a particle should paint.
   The portrait cloud paints with NormalBlending (a real, pigmented image), so we
   keep the photo's actual colour and only nudge it: a touch more saturation and a
   gentle shadow lift so dark hair reads as brown instead of vanishing into the black
   backdrop. There is deliberately no /luma equalisation — that trick only existed to
   keep hair visible under the old AdditiveBlending, and it is what blew skin to white. */
function toneParticleColor(data, idx, out, oi) {
  const r = data[idx] / 255
  const g = data[idx + 1] / 255
  const b = data[idx + 2] / 255
  const l = 0.299 * r + 0.587 * g + 0.114 * b
  /* mild vibrance so skin warms and lips redden without going neon */
  const sat = 1.28
  const lift = (v) => (v <= 0 ? 0.04 : v >= 1 ? 1 : 0.1 + 0.92 * Math.pow(v, 0.85))
  out[oi] = lift(l + (r - l) * sat)
  out[oi + 1] = lift(l + (g - l) * sat)
  out[oi + 2] = lift(l + (b - l) * sat)
}

/* Locate the head with no model and no dependency.

   Skin chroma alone is useless on its own — a beige wall, a wooden headboard or
   a pink shirt all read as "skin" and merge with the face. Two things rescue
   the signal:
   1. a face is a CONTIGUOUS run of skin that never spans the whole row, while
      wall/furniture does — so a run wider than 70% of the frame, or one that
      touches either frame border, is thrown away;
   2. the vertical profile is dependable: skin climbs at the forehead, peaks at
      the cheeks, then falls away.
   Colour only gives the FOREHEAD and the WIDTH though. The chin is taken from
   anatomy (hairline → chin ≈ 1.05 face widths) because on a bearded face the
   skin run dies at the moustache, which is a third of the face too early. */
function locateHead(data, W, H) {
  const maxRun = Math.round(W * 0.7)
  const skinAt = (i) => isSkinPixel(data, i)
  const lumaAt = (i) => lumaOf(data, i)
  const rowW = new Int32Array(H)
  const rowLo = new Int32Array(H).fill(-1)
  const rowHi = new Int32Array(H).fill(-1)
  for (let y = 0; y < H; y += 1) {
    let best = 0
    let bLo = -1
    let bHi = -1
    let run = 0
    let runLo = -1
    for (let x = 0; x < W; x += 1) {
      if (skinAt((y * W + x) * 4)) {
        if (run === 0) runLo = x
        run += 1
      } else {
        if (run > best) { best = run; bLo = runLo; bHi = x - 1 }
        run = 0
      }
    }
    if (run > best) { best = run; bLo = runLo; bHi = W - 1 }
    /* A face floats in the middle of the frame; a run that touches either edge
       (or spans 70%+ of the row) is wall/furniture/shirt, never the cheeks. */
    if (best > maxRun || bLo === 0 || bHi === W - 1) { best = 0; bLo = -1; bHi = -1 }
    rowW[y] = best
    rowLo[y] = bLo
    rowHi[y] = bHi
  }

  const minRow = Math.max(5, Math.round(W * 0.05))
  /* forehead = first row with skin four rows running (kills speckle) */
  let yTop = -1
  for (let y = 0; y + 3 < H; y += 1) {
    if (rowW[y] >= minRow && rowW[y + 1] >= minRow && rowW[y + 2] >= minRow && rowW[y + 3] >= minRow) {
      yTop = y
      break
    }
  }
  if (yTop < 0) return null
  /* cheeks = widest qualifying row, searched only just below the forehead so a
     band of furniture further down can never become the "face" */
  const winEnd = Math.min(H - 1, yTop + Math.max(10, Math.round(H * 0.34)))
  let peak = 0
  let peakY = yTop
  for (let y = yTop; y <= winEnd; y += 1) {
    if (rowW[y] > peak) { peak = rowW[y]; peakY = y }
  }
  if (peak < minRow) return null
  /* where the skin run breaks up — only a FLOOR for the chin, never the answer
     on its own, because a moustache breaks it far above the real jaw */
  let collapseY = -1
  for (let y = peakY + 2; y < H; y += 1) {
    if (rowW[y] < peak * 0.5) { collapseY = y; break }
  }
  const faceW = peak
  const cx = Math.round((rowLo[peakY] + rowHi[peakY]) / 2)
  const halfW = Math.round(faceW * 0.85)
  const x0 = Math.max(0, cx - halfW)
  const x1 = Math.min(W - 1, cx + halfW)
  /* chin from anatomy: hairline → chin is ~1.05 face widths for a typical head.
     A late collapse (clean-shaven long face) is still honoured. */
  let chin = Math.min(H - 1, Math.max(collapseY, yTop + Math.round(faceW * 1.05)))
  /* crown: walk UP through the hair until the backdrop shows through, so a high
     quiff or long hair is measured instead of guessed */
  const hx0 = Math.max(0, cx - Math.round(faceW * 0.55))
  const hx1 = Math.min(W - 1, cx + Math.round(faceW * 0.55))
  const hSpan = Math.max(1, hx1 - hx0 + 1)
  let crown = yTop
  for (let y = yTop - 1; y >= Math.max(0, yTop - Math.round(faceW * 1.3)); y -= 1) {
    let hair = 0
    for (let x = hx0; x <= hx1; x += 1) {
      const i = (y * W + x) * 4
      if (lumaAt(i) < 125 || skinAt(i)) hair += 1
    }
    if (hair / hSpan < 0.5) break
    crown = y
  }
  /* a beard hangs below the geometric chin: keep walking while the row is dark
     AND warm. A bright shirt has no dark pixels, a grey/blue jacket is dark but
     cool (r <= b), and shoulders spread wider than the head, so all three stop
     the walk instead of dragging the crop into the body. */
  const bx0 = Math.max(0, cx - Math.round(faceW * 0.62))
  const bx1 = Math.min(W - 1, cx + Math.round(faceW * 0.62))
  const bSpan = Math.max(1, bx1 - bx0 + 1)
  const stopAt = Math.min(H - 1, chin + Math.round(faceW * 0.55))
  let bottom = chin
  let dry = 0
  for (let y = chin + 1; y <= stopAt; y += 1) {
    let dn = 0
    let warm = 0
    for (let x = bx0; x <= bx1; x += 1) {
      const i = (y * W + x) * 4
      if (lumaAt(i) < 92) {
        dn += 1
        if (data[i] > data[i + 2] + 6) warm += 1
      }
    }
    if (dn / bSpan > 0.35 && warm / bSpan > 0.25) {
      bottom = y
      dry = 0
    } else {
      dry += 1
      if (dry > 4) break
    }
  }
  return {
    x0,
    x1,
    y0: crown,
    y1: Math.min(H - 1, bottom + Math.round(faceW * 0.08)),
    /* anatomy read for the lip-sync anchor: hairline → chin span + centre + width */
    forehead: yTop,
    chin,
    cx,
    faceW,
  }
}

/* Sample particle targets straight from a real photo.
   Background is peeled off with a border flood-fill, then foreground pixels
   become particle targets with brightness-weighted density + fake depth.
   faceCrop = true isolates the HEAD only: locateHead() picks a head box from
   the skin profile, the flood-fill runs inside that box, and everything outside
   the head ellipse is dropped — so no wall and no body ever becomes particles.
   colorOut: pass a Float32Array(count * 3) to receive each particle's source
   colour, so the point cloud reads as the real person instead of flat silver. */
function photoTargets(img, count, { tolerance = 26, worldMax = 5.4, lift = 0.1, faceCrop = false, onBox = null, colorOut = null, mouthOut = null, jawOut = null } = {}) {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) throw new Error('empty image')
  const W = Math.min(480, iw)
  const H = Math.max(1, Math.round((W / iw) * ih))
  const cvs = document.createElement('canvas')
  cvs.width = W
  cvs.height = H
  const c = cvs.getContext('2d', { willReadFrequently: true })
  c.drawImage(img, 0, 0, W, H)
  const { data } = c.getImageData(0, 0, W, H)

  /* head box; when found, everything outside it is treated as background.
     Detected once and reused: for the crop (faceCrop) AND for the mouth anchor
     below (so the built-in portraits, which don't crop, still get lip-sync). */
  const headDetect = locateHead(data, W, H)
  let head = faceCrop ? headDetect : null
  if (faceCrop && !head) {
    /* nothing reliable detected — STILL never particle-ize the whole photo:
       fall back to an upper-centre window sized like a head */
    head = { x0: Math.round(W * 0.2), y0: 0, x1: Math.round(W * 0.8), y1: Math.round(H * 0.52) }
  }
  /* Mouth anchor in PIXEL space, from head anatomy (hairline → chin ≈ 0.73 of
     the way down is the lips). Used to tag the particles that form the mouth. */
  let mouthX = -1
  let mouthY = -1
  let mouthRX = 0
  let mouthRY = 0
  if (mouthOut && headDetect && headDetect.faceW) {
    const fw = headDetect.faceW
    mouthX = headDetect.cx
    mouthY = headDetect.forehead + (headDetect.chin - headDetect.forehead) * 0.73
    mouthRX = fw * 0.2
    mouthRY = fw * 0.115
  }
  let cx0 = 0
  let cy0 = 0
  let cx1 = W - 1
  let cy1 = H - 1
  const bg = new Uint8Array(W * H)
  if (head) {
    cx0 = head.x0
    cy0 = head.y0
    cx1 = head.x1
    cy1 = head.y1
    bg.fill(1)
    for (let y = cy0; y <= cy1; y += 1) bg.fill(0, y * W + cx0, y * W + cx1 + 1)
  }

  /* flood-fill the connected background starting from every border pixel.
     Tolerance is a PER-STEP delta: smooth gradients (the actual backdrop)
     are crossed freely, but real edges — hair silhouette, shoulders — stop
     the fill, so dark hair and clothing survive as foreground. */
  const stack = new Int32Array(W * H)
  let sp = 0
  /* Inside a head box, face skin is NEVER background. Skin is smooth, so once
     the border-seeded flood meets a skin pixel it walks straight through the
     whole face and leaves a hollow ring of hair behind — and the higher the
     photo resolution, the smoother (and the more easily dissolved) the skin is.
     The strict chroma test keeps walls/furniture/shirt unprotected, and the
     head-ellipse veto still erases any backdrop that reads as skin. */
  const keep = (p) => faceCrop && head && isSkinPixel(data, p * 4)
  const push = (p) => { bg[p] = 1; stack[sp++] = p }
  for (let x = cx0; x <= cx1; x += 1) {
    const top = cy0 * W + x
    const bottom = cy1 * W + x
    if (!keep(top)) push(top)
    if (!keep(bottom)) push(bottom)
  }
  for (let y = cy0; y <= cy1; y += 1) {
    const left = y * W + cx0
    const right = y * W + cx1
    if (!keep(left)) push(left)
    if (!keep(right)) push(right)
  }
  const close = (p, q) => {
    const i = p * 4
    const j = q * 4
    return Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) < tolerance
  }
  while (sp > 0) {
    const p = stack[--sp]
    const x = p % W
    const y = (p / W) | 0
    if (x > cx0 && !bg[p - 1] && !keep(p - 1) && close(p, p - 1)) push(p - 1)
    if (x < cx1 && !bg[p + 1] && !keep(p + 1) && close(p, p + 1)) push(p + 1)
    if (y > cy0 && !bg[p - W] && !keep(p - W) && close(p, p - W)) push(p - W)
    if (y < cy1 && !bg[p + W] && !keep(p + W) && close(p, p + W)) push(p + W)
  }

  /* backdrop colour = median tone of everything the flood marked as background */
  const rs = []
  const gs = []
  const bs = []
  for (let p = 0; p < W * H; p += 7) {
    if (bg[p]) {
      rs.push(data[p * 4])
      gs.push(data[p * 4 + 1])
      bs.push(data[p * 4 + 2])
    }
  }
  const median = (a) => {
    a.sort((x, y) => x - y)
    return a[(a.length / 2) | 0] || 0
  }
  const bgR = median(rs)
  const bgG = median(gs)
  const bgB = median(bs)

  /* rescue pixels that differ strongly from the backdrop tone — near-black
     hair and dark clothes survive even where the smooth flood leaked past
     their soft edges. Restricted to pixels no brighter than the backdrop:
     a gradient wall drifts far from its OWN median at the bright end, and
     without this bound those wall strips get pulled back as foreground. */
  const bgLuma = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB
  for (let p = 0; p < W * H; p += 1) {
    if (!bg[p]) continue
    const i = p * 4
    const d = Math.abs(data[i] - bgR) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bgB)
    if (d > 42 && 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < bgLuma) bg[p] = 0
  }

  /* keep only the largest connected foreground blob (the person) — this
     erases rescued islands like bright objects on the wall */
  const seen = new Uint8Array(W * H)
  const compPix = new Int32Array(W * H)
  const subject = new Uint8Array(W * H)
  let bestCount = 0
  for (let start = 0; start < W * H; start += 1) {
    if (bg[start] || seen[start]) continue
    let read = 0
    let count = 1
    seen[start] = 1
    compPix[0] = start
    while (read < count) {
      const p = compPix[read++]
      const x = p % W
      const y = (p / W) | 0
      if (x > 0 && !bg[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; compPix[count++] = p - 1 }
      if (x < W - 1 && !bg[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; compPix[count++] = p + 1 }
      if (y > 0 && !bg[p - W] && !seen[p - W]) { seen[p - W] = 1; compPix[count++] = p - W }
      if (y < H - 1 && !bg[p + W] && !seen[p + W]) { seen[p + W] = 1; compPix[count++] = p + W }
    }
    if (count > bestCount) {
      subject.fill(0)
      for (let i = 0; i < count; i += 1) subject[compPix[i]] = 1
      bestCount = count
    }
  }
  for (let p = 0; p < W * H; p += 1) if (!bg[p] && !subject[p]) bg[p] = 1

  /* bounding box of the surviving subject */
  let bx0 = W
  let bx1 = -1
  let by0 = H
  let by1 = -1
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (!bg[y * W + x]) {
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
    }
  }
  if (bx1 < 0) { bx0 = 0; by0 = 0; bx1 = W - 1; by1 = H - 1 }

  /* With a head box, keep only what falls inside the head ellipse: a patch of
     wall or headboard sitting in the corners of the box can then never become
     particles. */
  if (head) {
    const ecx = (cx0 + cx1) / 2
    const ecy = (cy0 + cy1) / 2
    const erx = ((cx1 - cx0 + 1) / 2) * 1.12
    const ery = ((cy1 - cy0 + 1) / 2) * 1.06
    for (let y = cy0; y <= cy1; y += 1) {
      for (let x = cx0; x <= cx1; x += 1) {
        const dx = (x - ecx) / erx
        const dy = (y - ecy) / ery
        if (dx * dx + dy * dy > 1) bg[y * W + x] = 1
      }
    }
    /* re-tighten the box to whatever actually survived */
    let nx0 = W
    let nx1 = -1
    let ny0 = H
    let ny1 = -1
    for (let y = cy0; y <= cy1; y += 1) {
      for (let x = cx0; x <= cx1; x += 1) {
        if (!bg[y * W + x]) {
          if (x < nx0) nx0 = x
          if (x > nx1) nx1 = x
          if (y < ny0) ny0 = y
          if (y > ny1) ny1 = y
        }
      }
    }
    if (nx1 > nx0 && ny1 > ny0) { bx0 = nx0; bx1 = nx1; by0 = ny0; by1 = ny1 }
  }

  const cropX = bx0
  const cropY = by0
  const cropW = Math.max(1, bx1 - bx0 + 1)
  const cropH = Math.max(1, by1 - by0 + 1)
  /* tell the UI exactly which slice of the photo became particles */
  if (onBox) onBox({ x: cropX / W, y: cropY / H, w: cropW / W, h: cropH / H })
  const scale = worldMax / Math.max(cropW, cropH)
  const worldW = cropW * scale
  const worldH = cropH * scale
  const cxPix = cropX + cropW / 2
  const cyPix = cropY + cropH / 2
  const arr = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    let px = cxPix | 0
    let py = cyPix | 0
    let luma = 0.7
    for (let tries = 0; tries < 900; tries += 1) {
      px = (cropX + Math.random() * cropW) | 0
      py = (cropY + Math.random() * cropH) | 0
      if (px < 0 || px >= W || py < 0 || py >= H) continue
      if (bg[py * W + px]) continue
      const idx = (py * W + px) * 4
      luma = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255
      /* dense foreground everywhere — hair and shoulders read as solid mass,
         highlights sit on top of that base */
      const p = 0.68 + Math.pow(luma, 1.4) * 0.32
      if (Math.random() < p) break
    }
    if (colorOut) toneParticleColor(data, (py * W + px) * 4, colorOut, i * 3)
    arr[i * 3] = ((px - cxPix) / cropW) * worldW
    arr[i * 3 + 1] = -((py - cyPix) / cropH) * worldH + lift
    /* brightness fakes depth: lit areas push forward, shadows recede */
    arr[i * 3 + 2] = (luma - 0.5) * 1.1 + (Math.random() - 0.5) * 0.12
    /* tag lip particles: soft elliptical falloff around the mouth anchor, and a
       jaw flag so the render loop knows which half of the mouth to drop open */
    if (mouthOut && mouthRX > 0) {
      const ddx = (px - mouthX) / mouthRX
      const ddy = (py - mouthY) / mouthRY
      const dd = ddx * ddx + ddy * ddy
      if (dd < 1) {
        mouthOut[i] = Math.pow(1 - dd, 1.15)
        if (jawOut) jawOut[i] = py > mouthY ? 1 : 0
      }
    }
  }
  return arr
}

export default function NanoParticles({ count = 30000, shape = 'orb', photoUrl = null, onFaceBox = null, state = 'idle', focusY = 0.2, voiceSync = false }) {
  const mountRef = useRef(null)
  const shapeRef = useRef(shape)
  shapeRef.current = shape
  /* Where the camera centres its gaze in portrait mode. Default 0.2 frames the whole
     bust (the chat face). The reveal raises it toward the eyes so the FACE — which sits
     high in the head+shoulders cloud — lands mid-frame instead of near the top. focusY is
     static per instance (reveal=1.05, chat=default), so we seed the ref once — no
     render-phase write, which would add to the react(purity) warning baseline. */
  const focusYRef = useRef(focusY)
  /* Behavioural state that drives the face's live motion:
     'idle' breathing + sway · 'listening' lean-in · 'thinking' look-away · 'talking' lip-sync */
  const stateRef = useRef(state)
  stateRef.current = state
  /* true when replies are spoken aloud: then ONLY the real voice moves the lips */
  const voiceSyncRef = useRef(voiceSync)
  voiceSyncRef.current = voiceSync
  const customTargetsRef = useRef(null)
  const customColorsRef = useRef(null)
  /* per-particle mouth weight + jaw flag for the custom photo (parallel to targets) */
  const customMouthRef = useRef(null)
  const customJawRef = useRef(null)
  /* keep the caller in a ref: an inline prop function would otherwise re-run
     the photo-decode effect on every render */
  const onFaceBoxRef = useRef(onFaceBox)
  onFaceBoxRef.current = onFaceBox

  /* Build a particle portrait from a user-uploaded photo whenever it changes.
     Until the targets are ready, the cloud stays an orb, then morphs in. */
  useEffect(() => {
    let cancelled = false
    if (!photoUrl) {
      customTargetsRef.current = null
      customColorsRef.current = null
      customMouthRef.current = null
      customJawRef.current = null
      onFaceBoxRef.current?.(null)
      return undefined
    }
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const colorsOut = new Float32Array(count * 3)
      const mouthOut = new Float32Array(count)
      const jawOut = new Float32Array(count)
      try {
        customTargetsRef.current = photoTargets(img, count, {
          tolerance: 14,
          worldMax: 5.2,
          lift: 0.12,
          faceCrop: true,
          colorOut: colorsOut,
          mouthOut,
          jawOut,
          onBox: (box) => { if (!cancelled) onFaceBoxRef.current?.(box) },
        })
        customColorsRef.current = holoize(colorsOut, customTargetsRef.current, count)
        customMouthRef.current = mouthOut
        customJawRef.current = jawOut
      } catch {
        customTargetsRef.current = null
        customColorsRef.current = null
        customMouthRef.current = null
        customJawRef.current = null
      }
    }
    img.onerror = () => { customTargetsRef.current = null; customColorsRef.current = null; customMouthRef.current = null; customJawRef.current = null; onFaceBoxRef.current?.(null) }
    img.src = photoUrl
    return () => { cancelled = true }
  }, [photoUrl, count])

  useEffect(() => {
    const container = mountRef.current
    if (!container) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(0, 0.6, 7)

    /* preserveDrawingBuffer so selfCapture.js can photograph the face between frames
       — without it the WebGL buffer is cleared after compositing and toDataURL() is
       blank. ThreeHero already pays this cost for the same reason. */
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    const applySize = () => {
      const size = container.clientWidth || 380
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(size, size)
      camera.aspect = 1
      camera.updateProjectionMatrix()
    }
    applySize()
    const canvas = renderer.domElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    /* Refit when the container resizes (e.g. the reveal stage centers + enlarges it) */
    const resizeObserver = new ResizeObserver(() => applySize())
    resizeObserver.observe(container)

    /* Silver palette for the particles: bright white-silver → cool grey → gunmetal shimmer */
    const palette = [new THREE.Color('#5eead4'), new THREE.Color('#38bdf8'), new THREE.Color('#818cf8'), new THREE.Color('#c084fc'), new THREE.Color('#f472b6'), new THREE.Color('#e0f2fe')]

    /* The core: a dark gunmetal orb — the bright silver particles pop clearly against it */
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1.55, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x0b1235 }),
    )
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.95, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x6d5cff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    scene.add(core, halo)

    /* Orb target positions: 70% spherical shell + 30% tight orbit ring */
    const shellCount = Math.floor(count * 0.7)
    const orbTargets = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const seed = (i, kind) => {
      const col = palette[Math.floor(Math.random() * palette.length)]
      colors[i * 3] = col.r
      colors[i * 3 + 1] = col.g
      colors[i * 3 + 2] = col.b
      if (kind === 'shell') {
        const r = 2.2 + Math.random() * 0.6
        const theta = Math.random() * Math.PI * 2
        const phi = Math.acos(2 * Math.random() - 1)
        orbTargets[i * 3] = r * Math.sin(phi) * Math.cos(theta)
        orbTargets[i * 3 + 1] = r * Math.cos(phi) * 0.85
        orbTargets[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
      } else {
        const angle = Math.random() * Math.PI * 2
        const r = 2.5 + (Math.random() - 0.5) * 0.35
        orbTargets[i * 3] = Math.cos(angle) * r
        orbTargets[i * 3 + 1] = (Math.random() - 0.5) * 0.3
        orbTargets[i * 3 + 2] = Math.sin(angle) * r
      }
    }
    for (let i = 0; i < shellCount; i += 1) seed(i, 'shell')
    for (let i = shellCount; i < count; i += 1) seed(i, 'ring')

    /* Silver stays the fallback: any shape without a photo colour map eases
       back to the palette entry it was seeded with. */
    const orbColors = Float32Array.from(colors)
    const positions = Float32Array.from(orbTargets)
    const cloudGeometry = new THREE.BufferGeometry()
    cloudGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    cloudGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const cloudMaterial = new THREE.PointsMaterial({
      size: 0.028,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const cloud = new THREE.Points(cloudGeometry, cloudMaterial)
    scene.add(cloud)

    /* Thin bright ring that reads as the orbit circle (fades out in portrait mode) */
    const ringGeometry = new THREE.TorusGeometry(2.55, 0.012, 8, 220)
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.35 })
    const orbitRing = new THREE.Mesh(ringGeometry, ringMaterial)
    orbitRing.rotation.x = Math.PI / 2.15
    scene.add(orbitRing)

    /* Dotted circle that frames the portrait — spins live in portrait mode */
    const DOT_COUNT = 190
    const dotGeometry = new THREE.BufferGeometry()
    const dotPositions = new Float32Array(DOT_COUNT * 3)
    const dotColors = new Float32Array(DOT_COUNT * 3)
    const dotBright = new THREE.Color('#67e8f9')
    const dotDim = new THREE.Color('#8b5cf6')
    for (let i = 0; i < DOT_COUNT; i += 1) {
      const angle = (i / DOT_COUNT) * Math.PI * 2
      const r = 3.1 + (i % 7 === 0 ? 0.07 : 0) /* every 7th dot ticks outward like a clock mark */
      dotPositions[i * 3] = Math.cos(angle) * r
      dotPositions[i * 3 + 1] = Math.sin(angle) * r
      dotPositions[i * 3 + 2] = 0
      const col = i % 4 === 0 ? dotBright : dotDim
      dotColors[i * 3] = col.r
      dotColors[i * 3 + 1] = col.g
      dotColors[i * 3 + 2] = col.b
    }
    dotGeometry.setAttribute('position', new THREE.BufferAttribute(dotPositions, 3))
    dotGeometry.setAttribute('color', new THREE.BufferAttribute(dotColors, 3))
    const dotMaterial = new THREE.PointsMaterial({
      size: 0.06,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const dotRing = new THREE.Points(dotGeometry, dotMaterial)
    scene.add(dotRing)

    /* Procedural targets act as the instant fallback, then the real photos take over */
    let femaleTargets = faceTargets('female', count)
    let maleTargets = faceTargets('male', count)
    /* null while the procedural grayscale portrait is in use → silver particles */
    let femaleColors = null
    let maleColors = null
    /* per-particle mouth weight + jaw flag, parallel to each portrait's targets */
    let femaleMouth = null
    let femaleJaw = null
    let maleMouth = null
    let maleJaw = null
    let portraitsCancelled = false
    const loadImage = (src) =>
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => resolve(null)
        img.src = src
      })
    Promise.all([loadImage(femalePhoto), loadImage(malePhoto)]).then(([fImg, mImg]) => {
      if (portraitsCancelled) return
      try {
        if (fImg) {
          const fc = new Float32Array(count * 3)
          const fm = new Float32Array(count)
          const fj = new Float32Array(count)
          femaleTargets = photoTargets(fImg, count, { tolerance: 14, colorOut: fc, mouthOut: fm, jawOut: fj })
          femaleColors = holoize(fc, femaleTargets, count)
          femaleMouth = fm
          femaleJaw = fj
        }
        if (mImg) {
          const mc = new Float32Array(count * 3)
          const mm = new Float32Array(count)
          const mj = new Float32Array(count)
          maleTargets = photoTargets(mImg, count, { tolerance: 14, colorOut: mc, mouthOut: mm, jawOut: mj })
          maleColors = holoize(mc, maleTargets, count)
          maleMouth = mm
          maleJaw = mj
        }
      } catch { /* keep procedural targets */ }
    })

    const pointer = { x: 0, y: 0 }
    const onPointerMove = (event) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', onPointerMove)

    let raf = 0
    let morphFactor = 0 /* 0 = orb, 1 = portrait */
    let spinY = 0
    /* Eased "human" pose so a state change glides instead of snapping */
    const pose = { turn: 0, tilt: 0, lean: 0 }
    let mouthOpen = 0
    /* THREE.Clock is deprecated (logs a console warning on every mount); a plain
       performance.now() delta gives the same seconds-since-mount for the animation. */
    const startTime = performance.now()
    const animate = () => {
      const elapsed = (performance.now() - startTime) / 1000
      const currentShape = shapeRef.current
      const hasCustom = currentShape === 'custom' && customTargetsRef.current
      const portrait = currentShape === 'female' || currentShape === 'male' || !!hasCustom
      /* Portrait mode PAINTS with real pigment colour (NormalBlending) so skin, lips
         and hair read true-to-photo; the silver orb keeps its glowing AdditiveBlending.
         Only write the state when it actually flips so we don't churn the render state. */
      const wantBlending = portrait ? THREE.NormalBlending : THREE.AdditiveBlending
      if (cloudMaterial.blending !== wantBlending) cloudMaterial.blending = wantBlending
      morphFactor += ((portrait ? 1 : 0) - morphFactor) * 0.09

      const targets = currentShape === 'female' ? femaleTargets : currentShape === 'male' ? maleTargets : hasCustom ? customTargetsRef.current : orbTargets

      /* A real photo tints every particle with the pixel it came from (skin,
         hair, lips); the orb and the procedural fallback keep their silver. */
      const tint = hasCustom ? customColorsRef.current : currentShape === 'female' ? femaleColors : currentShape === 'male' ? maleColors : null
      /* Mouth weight + jaw flag for the active portrait — null on the orb and the
         procedural fallback, so the mouth simply stays still until a photo lands. */
      const mouth = hasCustom ? customMouthRef.current : currentShape === 'female' ? femaleMouth : currentShape === 'male' ? maleMouth : null
      const jaw = hasCustom ? customJawRef.current : currentShape === 'female' ? femaleJaw : currentShape === 'male' ? maleJaw : null

      /* ---- behaviour → pose targets (blended in by morphFactor below) ---- */
      const st = stateRef.current
      let tTurn = 0
      let tTilt = 0
      let tLean = 0
      let speech = 0
      if (st === 'listening') { tLean = 0.5; tTilt = 0.06 }
      else if (st === 'thinking') { tTurn = 0.55; tTilt = -0.12; tLean = -0.18 }
      /* Lips follow the words actually being spoken (speechViz.js schedules a bump
         per syllable and re-syncs on every word boundary). Only when replies are
         NOT voiced does the streaming text fall back to a generic talking cadence. */
      const voiceLive = isSpeechActive()
      let talkingNow = false
      if (voiceLive) {
        speech = mouthLevel()
        tLean = 0.12
        talkingNow = true
      } else if (st === 'talking' && !voiceSyncRef.current) {
        /* two detuned sines ≈ a natural syllable cadence (0..1) */
        speech = Math.abs(Math.sin(elapsed * 10.5)) * 0.62 + Math.abs(Math.sin(elapsed * 6.7 + 1.1)) * 0.38
        tLean = 0.12
        talkingNow = true
      }
      pose.turn += (tTurn - pose.turn) * 0.06
      pose.tilt += (tTilt - pose.tilt) * 0.06
      pose.lean += (tLean - pose.lean) * 0.06
      mouthOpen += (speech - mouthOpen) * 0.5

      /* Ease every particle toward its target — the "assembling" effect — while the
         mouth particles ride the speech envelope: the lower lip drops and eases
         forward, the upper lip lifts a touch, so the face reads as actually talking. */
      const pos = cloudGeometry.attributes.position.array
      const col = cloudGeometry.attributes.color.array
      const openAmt = mouthOpen * morphFactor
      const scanY = 2.8 - ((elapsed * 0.32) % 1) * 6
      for (let p = 0; p < count; p += 1) {
        const b = p * 3
        let tx = targets[b]
        let ty = targets[b + 1]
        let tz = targets[b + 2]
        if (mouth && openAmt > 0.001) {
          const w = mouth[p]
          if (w > 0) {
            const amt = openAmt * w
            if (jaw[p] === 1) { ty -= amt * 0.42; tz -= amt * 0.08 } else { ty += amt * 0.09 }
          }
        }
        pos[b] += (tx - pos[b]) * 0.09
        pos[b + 1] += (ty - pos[b + 1]) * 0.09
        pos[b + 2] += (tz - pos[b + 2]) * 0.09
        /* hologram scan line: a bright cyan band sweeps down the portrait */
        let sb = 0
        if (morphFactor > 0.05) {
          const dy = (ty - scanY) / 0.16
          if (dy > -3 && dy < 3) sb = Math.exp(-dy * dy) * 0.45 * morphFactor
        }
        col[b] += ((tint ? tint[b] : orbColors[b]) + sb * 0.3 - col[b]) * 0.09
        col[b + 1] += ((tint ? tint[b + 1] : orbColors[b + 1]) + sb - col[b + 1]) * 0.09
        col[b + 2] += ((tint ? tint[b + 2] : orbColors[b + 2]) + sb - col[b + 2]) * 0.09
      }
      cloudGeometry.attributes.position.needsUpdate = true
      cloudGeometry.attributes.color.needsUpdate = true

      /* Spin only in orb mode; portrait mode turns slightly to the LEFT (3/4 view).
         Idle life: breathing (rise/fall) + sway (yaw) + a gentle nod (pitch), with a
         livelier bob layered on while talking; lean/tilt/turn come from the state pose. */
      spinY += 0.0024
      const sideTurn = -0.3 - Math.sin(elapsed * 0.5) * 0.06
      const breath = Math.sin(elapsed * 1.15) * 0.03
      const sway = Math.sin(elapsed * 0.45) * 0.035
      const nod = Math.sin(elapsed * 0.9) * 0.02
      const talkBob = talkingNow ? Math.sin(elapsed * 8.5) * 0.025 * mouthOpen : 0
      cloud.rotation.y = spinY * (1 - morphFactor) + (sideTurn + pose.turn + sway) * morphFactor
      cloud.rotation.x = Math.sin(elapsed * 0.25) * 0.12 * (1 - morphFactor) + (nod + talkBob) * morphFactor
      cloud.rotation.z = (pose.tilt + Math.sin(elapsed * 0.6) * 0.012) * morphFactor
      cloud.position.y = breath * morphFactor
      cloud.position.z = pose.lean * 0.5 * morphFactor

      /* Core + ring shrink/fade away while the portrait forms */
      const orbPresence = Math.max(0.001, 1 - morphFactor * 1.25)
      const pulse = 1 + Math.sin(elapsed * 2.2) * 0.03
      core.scale.setScalar(pulse * orbPresence)
      halo.scale.setScalar(orbPresence * (1 + Math.sin(elapsed * 1.4) * 0.05))
      /* portrait particles render thicker so the pigmented dots knit into solid skin
         instead of leaving black backdrop showing through the gaps (NormalBlending has
         no additive glow to fill them) */
      cloudMaterial.size = 0.028 + morphFactor * 0.03
      orbitRing.material.opacity = 0.35 * orbPresence
      orbitRing.rotation.z = -elapsed * 0.2
      orbitRing.rotation.x = (Math.PI / 2.15) * (1 - morphFactor)
      orbitRing.scale.setScalar(1 + morphFactor * 0.28)
      orbitRing.position.z = -0.9 * morphFactor
      /* dotted circle fades in around the portrait and keeps drifting + shimmering */
      dotRing.rotation.x = orbitRing.rotation.x
      dotRing.rotation.z = -elapsed * 0.45
      dotRing.scale.setScalar(1 + morphFactor * 0.06)
      dotRing.position.z = -0.9 * morphFactor
      dotMaterial.opacity = morphFactor * (0.7 + Math.sin(elapsed * 2.6) * 0.25)
      dotMaterial.size = 0.05 + 0.012 * Math.sin(elapsed * 3.4)

      camera.position.x += (pointer.x * 0.7 - camera.position.x) * 0.04
      camera.position.y += (-pointer.y * 0.5 + 0.6 - camera.position.y) * 0.04
      camera.lookAt(0, focusYRef.current, 0)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      portraitsCancelled = true
      resizeObserver.disconnect()
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onPointerMove)
      cloudGeometry.dispose()
      cloudMaterial.dispose()
      ringGeometry.dispose()
      ringMaterial.dispose()
      dotGeometry.dispose()
      dotMaterial.dispose()
      core.geometry.dispose()
      core.material.dispose()
      halo.geometry.dispose()
      halo.material.dispose()
      renderer.dispose()
      if (canvas.parentNode === container) container.removeChild(canvas)
    }
  }, [])

  return <div className="nano-particles" ref={mountRef} aria-hidden="true" />
}
