/* Validates the wake-word matcher AND the two-chunk arming state machine used
   by src/useWakeWord.js — the exact regex plus the exact fireWake/fireCommand
   closure sequence must behave the same here as in the hook. Run:
   `node scripts/wake-word-check.mjs`

   If you change the hook's regex, cooldowns, arming window or the closure
   order, mirror it here. This is what catches regressions like:
     • "Aira <breath> bana do ek image" arriving as two finals and the second
       half being silently dropped (the reason the chat never opened).
     • Same command re-firing when Chrome emits the identical transcript twice. */

const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function match(name, text) {
  const re = new RegExp(`(^|[^\\p{L}])${escapeRe(name)}([^\\p{L}]|$)`, 'iu')
  const m = re.exec(text)
  if (!m) return { hit: false }
  const start = m.index + m[1].length + name.length
  const tail = text.slice(start).replace(/^[\s,.:;!?'"-]+/, '').trim()
  return { hit: true, cmd: tail }
}

/* ---------------------------------------------------------------------------
 * Regex test cases
 * ------------------------------------------------------------------------- */

const cases = [
  /* [name, transcript, expectHit, expectTail] */
  ['Aira', 'Aira, make me an image of a mountain', true, 'make me an image of a mountain'],
  ['Aira', 'aira please open chrome', true, 'please open chrome'],
  ['Aira', 'Hey, Aira: mujhe ek image bana do', true, 'mujhe ek image bana do'],
  ['Aira', 'Aira', true, ''],
  ['Aira', 'Aira!', true, ''],
  ['Aira', 'airna is not the wake word', false, null],
  ['Aira', 'unrelated conversation about air conditioning', false, null],
  ['Aira', 'Nexora, kaise ho', false, null],
  ['Zara QA', 'Zara QA, generate a picture of a cat', true, 'generate a picture of a cat'],
  ['Zara QA', 'My friend Zara QASmith is here', false, null],
  ['Aira', 'Aira tum kahan ho? Mujhe kuch bana do', true, 'tum kahan ho? Mujhe kuch bana do'],
  ['A.i', 'A.i do a task', true, 'do a task'],
]

/* ---------------------------------------------------------------------------
 * State-machine simulator — mirrors useWakeWord's closure exactly.
 * ------------------------------------------------------------------------- */

function makeMachine({ name, cooldownMs = 3200, wakeRetriggerMs = 1500, armWindowMs = 6000 }) {
  let armedUntilMs = 0
  let lastSig = { text: '', ts: -1e9 }
  let lastWakeTs = -1e9
  const wake = []
  const command = []

  const fireWake = (text, now) => {
    if (now - lastWakeTs < wakeRetriggerMs) return
    lastWakeTs = now
    armedUntilMs = now + armWindowMs
    wake.push(text)
  }
  const fireCommand = (cmd, text, now) => {
    const trimmed = String(cmd || '').trim()
    if (!trimmed) return
    const sig = trimmed.toLowerCase().replace(/\W+/g, ' ').trim()
    if (sig && sig === lastSig.text && now - lastSig.ts < cooldownMs) return
    lastSig = { text: sig, ts: now }
    armedUntilMs = 0
    command.push({ cmd: trimmed, full: text })
  }
  const handleFinal = (text, now) => {
    if (!name || !text) return
    const re = new RegExp(`(^|[^\\p{L}])${escapeRe(name)}([^\\p{L}]|$)`, 'iu')
    const m = re.exec(text)
    if (m) {
      const startIdx = m.index + m[1].length + name.length
      const tail = text.slice(startIdx).replace(/^[\s,.:;!?'"-]+/, '').trim()
      if (tail) fireCommand(tail, text, now)
      else fireWake(text, now)
      return
    }
    if (armedUntilMs && now < armedUntilMs) fireCommand(text, text, now)
  }
  return { handleFinal, wake, command }
}

/* Each seq case is a list of [transcript, simulatedMsTimestamp] events plus the
   expected wake/command callouts. Commands are compared by their extracted
   `cmd` string, not the raw transcript, so we test the actual routing. */
const seqs = [
  {
    label: 'Two-chunk: "Aira" then command inside arm window (the original bug)',
    events: [['Aira', 0], ['mujhe ek image bana do', 800]],
    expectWake: ['Aira'],
    expectCommands: ['mujhe ek image bana do'],
  },
  {
    label: 'Single chunk: wake + command in one final',
    events: [['Aira, make me an image', 0]],
    expectWake: [],
    expectCommands: ['make me an image'],
  },
  {
    label: 'Bare wake then background noise (armed → still fires as command)',
    events: [['Aira', 0], ['kuch chal raha hai', 1200]],
    expectWake: ['Aira'],
    expectCommands: ['kuch chal raha hai'],
  },
  {
    label: 'Stuttered wake ("Aira" twice inside retrigger floor) → only one wake',
    events: [['Aira', 0], ['Aira', 400]],
    expectWake: ['Aira'],
    expectCommands: [],
  },
  {
    label: 'Arm window expired → second utterance is NOT a command',
    events: [['Aira', 0], ['hello there', 12000]],
    expectWake: ['Aira'],
    expectCommands: [],
  },
  {
    label: 'Same command twice inside cooldown → only one fires',
    events: [['Aira bana do', 0], ['Aira bana do', 900]],
    expectWake: [],
    expectCommands: ['bana do'],
  },
  {
    label: 'Different commands back-to-back after a wake → both route',
    events: [['Aira pehla', 0], ['Aira doosra', 500]],
    expectWake: [],
    expectCommands: ['pehla', 'doosra'],
  },
  {
    label: 'Pure background speech with no wake and no arming → nothing fires',
    events: [['hawa ka mausam acha hai', 0], ['chalo khana khate hain', 2000]],
    expectWake: [],
    expectCommands: [],
  },
]

/* ---------------------------------------------------------------------------
 * Runner
 * ------------------------------------------------------------------------- */

let pass = 0
let fail = 0
const record = (ok, msg) => {
  if (ok) { pass += 1; console.log(`  ✓ ${msg}`) }
  else { fail += 1; console.log(`  ✗ ${msg}`) }
}

console.log('Regex cases:')
for (const [name, text, expectHit, expectTail] of cases) {
  const r = match(name, text)
  const ok = r.hit === expectHit && (!expectHit || r.cmd === expectTail)
  record(ok, `${JSON.stringify(text)} → ${r.hit ? `cmd=${JSON.stringify(r.cmd)}` : 'no match'}`)
}

console.log('\nTwo-chunk arming cases:')
for (const s of seqs) {
  const machine = makeMachine({ name: 'Aira' })
  for (const [text, ts] of s.events) machine.handleFinal(text, ts)
  const gotWakes = machine.wake.slice()
  const gotCmds = machine.command.map((c) => c.cmd)
  const okWake = JSON.stringify(gotWakes) === JSON.stringify(s.expectWake)
  const okCmd = JSON.stringify(gotCmds) === JSON.stringify(s.expectCommands)
  const ok = okWake && okCmd
  const detail = ok
    ? s.label
    : `${s.label} — expected wake=${JSON.stringify(s.expectWake)} cmd=${JSON.stringify(s.expectCommands)}, got wake=${JSON.stringify(gotWakes)} cmd=${JSON.stringify(gotCmds)}`
  record(ok, detail)
}

console.log(`\n${pass} pass / ${fail} fail`)
if (fail) process.exit(1)
