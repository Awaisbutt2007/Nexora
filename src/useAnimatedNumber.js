/**
 * useAnimatedNumber — smooth reverse-countdown for the topbar wallet pill.
 *
 * WHY: a raw `{creditsRemaining}` swap makes the number JUMP on every reply,
 * which reads as a glitch, not a drain. Users have specifically asked for an
 * "ulta countdown" feel — the digit should visually roll down from the old
 * value to the new one, like a slot machine running backwards, and a small
 * "-N" chip should pop off the pill so the spend is unmistakable.
 *
 * HOW: we remember the previous number in a ref, then interpolate previous →
 * next with `requestAnimationFrame` on an ease-out curve. The tween lives in
 * a single `{ display, delta }` state that we only touch inside RAF/timeout
 * callbacks — synchronous `setState` in an effect body is exactly the
 * cascading-render footgun oxlint flags, and there's no reason to do it here
 * because the first RAF tick is <16ms anyway.
 *
 * Behaviour notes:
 *  - Not-finite inputs (premium `null` while quota loads) short-circuit: no
 *    tween, we just render the raw value so callers keep their conditional.
 *  - First-time materialisation (null → 100) doesn't roll: rolling FROM a
 *    non-number would show the pill jitter on every mount.
 *  - Upward changes (upgrade, monthly refill) SNAP and only keep the chip
 *    alive 500ms — the "reverse countdown" is a drain cue, not a gift cue.
 */
import { useEffect, useRef, useState } from 'react'

const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4)

export function useAnimatedNumber(value, { durationMs = 900 } = {}) {
  const [tween, setTween] = useState(null)
  const fromRef = useRef(value)
  const rafRef = useRef(0)

  useEffect(() => {
    const from = fromRef.current
    fromRef.current = value
    /* No valid old→new pair, or nothing actually moved: skip the tween so we
       never call setState and the pill just renders the raw `value`. */
    if (!Number.isFinite(value) || !Number.isFinite(from) || from === value) return undefined
    cancelAnimationFrame(rafRef.current)
    const delta = value - from
    const isUp = delta > 0
    const start = performance.now()
    const dur = Math.max(200, Math.min(1600, durationMs))
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur)
      const v = isUp || p >= 1 ? value : Math.round(from + (value - from) * easeOutQuart(p))
      setTween({ display: v, delta })
      if (p < 1) rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    /* Chip unmounts after its CSS animation window (1.7s) so the pill can
       settle back to its resting state; upward jumps clear quicker because
       the roll itself is instant. */
    const clear = setTimeout(() => setTween(null), isUp ? 500 : 1800)
    return () => { cancelAnimationFrame(rafRef.current); clearTimeout(clear) }
  }, [value, durationMs])

  return tween ? { display: tween.display, delta: tween.delta } : { display: value, delta: 0 }
}
