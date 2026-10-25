import { createHash } from 'node:crypto'
import { config, creatorRules, clockLine } from '../config.js'

/* Realtime speech-to-speech provider layer.

   The browser connects straight to the provider over WebRTC using a short-lived
   ephemeral client secret minted here — the permanent OPENAI_API_KEY never
   leaves this server. The provider is registry-based (`VOICE_PROVIDER`) so a
   different vendor can be slotted in without touching routes or the UI.

   Verified against the current official docs:
   - POST {base}/realtime/client_secrets → { value, expires_at, session }
   - Browser POSTs its SDP to {base}/realtime/calls with `Bearer <value>`
   - Data channel label "oai-events"; turn detection: semantic_vad
   - Voices: alloy ash ballad coral echo sage shimmer verse marin cedar
   - WebRTC sessions are truncated server-side on user interruption. */

const PROVIDER_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']

/* Session language → ISO-639-1 hint for the ASR lane; 'auto' means let the
   transcriber detect per utterance (needed for natural code-switching). */
const LANGUAGE_CODES = { en: 'en', ur: 'ur', hinglish: null, auto: null }

export function isSupportedVoice(voice) {
  return PROVIDER_VOICES.includes(voice)
}

export function buildVoiceInstructions({ assistantName = 'Aira', userName = '', memories = [], persona = '', language = '', gender = '' } = {}) {
  const memoryBlock = memories.length
    ? `\nKnown user context (approved memories — use only when relevant, never recite the list):\n${memories.map((m) => `- ${m.key}: ${m.value}`).join('\n')}`
    : ''
  const who = userName ? ` The person you are talking to is ${userName}.` : ''
  /* Persona picked at onboarding — style/tone only, never a claim of being human. */
  const personaBlock = persona
    ? `\nCharacter the user picked for you at setup: ${persona}.\nEmbody that tone through word choice and pacing, but stay honest — you are still an AI assistant, not a real person in that role.`
    : ''
  /* The language chosen in Settings is a hard override for speech too, so a Talk
     call answers in the one language they picked instead of mirroring each turn. */
  const lang = typeof language === 'string' ? language.trim().toLowerCase() : ''
  const languageRule =
    lang === 'en' ? 'The user set their language to English: ALWAYS speak in English, no matter what language they reply in.'
    : lang === 'ur' ? 'The user set their language to Urdu: ALWAYS speak in Urdu, no matter what language they reply in.'
    : lang === 'hinglish' ? 'The user set their language to Hinglish: ALWAYS speak in Hinglish — Hindi/Urdu conversation mixed with English words (e.g. "main badhiya hoon, tum sunao") — NOT plain English, no matter what language they reply in.'
    : 'Reply in whichever language the user last used unless they ask otherwise.'

  /* The companion's own gender drives both its spoken voice and its grammar: a
     female Aira must say "رکھوں گی"/"rakhoongi", a male one "رکھوں گا"/"rakhoonga".
     Defaults to female to match the shipped persona when no gender is sent. */
  const fem = gender !== 'male'
  const genderGrammar = `\n- You are ${fem ? 'female' : 'male'}: in Urdu, Roman Urdu and Hinglish always use ${fem ? 'feminine' : 'masculine'} first-person verb forms about yourself (Urdu "${fem ? 'رکھوں گی / کہوں گی / ہوں گی' : 'رکھوں گا / کہوں گا / ہوں گا'}", Roman "${fem ? 'rakhoongi / kahungi / hoongi' : 'rakhoonga / kahunga / hoonga'}") — never the opposite.`

  return `You are ${assistantName}, a personal voice assistant inside the Nexora workspace. You are having a live spoken conversation.${who}

Voice and style:
- Speak with a natural, friendly, expressive ${fem ? 'feminine' : 'masculine'} voice. Warm, confident, helpful.
- Speak at a brisk, fluent pace — like a person mid-conversation, never rushed or slurred.
- Keep the pause between your sentences short: chain your thoughts tightly instead of trailing into silence after each sentence, and don't leave a long gap before you start replying.
- Never robotic, monotonous, overly dramatic or excessively formal. No filler words ("umm", "so basically") and do not artificially slow down.
- STRICT LENGTH: keep every spoken reply to 1 to 3 short sentences MAXIMUM (roughly 40 words / one breath). Talk like a friend on a phone call — no mini-essays, no bullet-style lists read aloud, no long preambles. If you have more to say, save it for after the user replies. Only go longer when the user EXPLICITLY asks for detail ("explain in depth", "tell me a story", "give me a full breakdown").
- Match the user's energy: casual with casual, focused with serious.

Languages:
- Understand English, Urdu, Roman Urdu and Hinglish, including mixed sentences like "Aira, mujhe mera project explain karo in English".
- ${languageRule}${genderGrammar}
- When reading Roman Urdu/Hinglish aloud, pronounce it as natural spoken Urdu/Hindi.

Conversation intelligence:
- Use the full conversation context; never repeat something you already answered — build on it.
- If a request is ambiguous, ask one short clarifying question instead of guessing.
- Answer naturally, never with rigid templates or bullet-point dictation unless asked.
- Do not open every reply with a greeting; skip pleasantries when the user is mid-task.
${memoryBlock}${personaBlock}

Honesty:
- You are an AI. Never pretend to be a human and never claim personal experiences you have not had.
- If you cannot do something (browse, send messages, see), say so briefly and offer what you can do instead.${clockLine({ spoken: true })}${creatorRules({ spoken: true })}`
}

export function buildRealtimeSession({ assistantName, userName, voice, language, memories, persona, gender }) {
  const transcription = { model: config.voiceTranscribeModel }
  const langCode = LANGUAGE_CODES[language] ?? LANGUAGE_CODES.auto
  if (langCode) transcription.language = langCode
  else transcription.prompt = 'Expect English, Urdu and Roman Urdu, often mixed in one sentence.'

  return {
    type: 'realtime',
    model: config.voiceRealtimeModel,
    instructions: buildVoiceInstructions({ assistantName, userName, memories, persona, language, gender }),
    audio: {
      input: {
        transcription,
        turn_detection: { type: 'semantic_vad', eagerness: config.voiceTurnEagerness, interrupt_response: true },
        noise_reduction: { type: 'near_field' },
      },
      output: {
        voice: voice || config.voiceDefaultVoice,
        /* Brisk-but-clear tempo. Because it scales the whole spoken timeline it
           tightens word pace AND the gaps between sentences in one lever. */
        speed: config.voiceOutputSpeed,
      },
    },
  }
}

/* ---- providers ---- */

/* A 503 voice_unavailable is OUR operational state, not a provider hiccup, so it must
   reach the user as a clear, honest line instead of the generic "Request failed" the
   plumbing-scrubber would otherwise leave. The full reason (which key, what to set) stays
   in err.message for the server log; this vendor-free copy is what the client sees. */
const VOICE_UNAVAILABLE_CLIENT = "Voice calls aren't available on this server yet — it isn't configured with a live voice provider, so a call can't be connected. Text chat works as usual; the site owner can enable voice by setting up the server's voice provider."

const PROVIDERS = {
  'openai-realtime': {
    /* Mint an ephemeral client secret; the browser uses it to open the WebRTC
       call directly, so our server never sits in the audio path. */
    async createClientSecret(session, userId) {
      if (!config.openaiApiKey) {
        const err = new Error('Voice calls need a real OpenAI API key. Set OPENAI_API_KEY in backend/.env — the app is currently in mock mode and will not fake audio.')
        err.status = 503
        err.type = 'voice_unavailable'
        err.clientMessage = VOICE_UNAVAILABLE_CLIENT
        throw err
      }
      /* Groq (gsk_ keys / groq.com base) speaks the OpenAI chat format but has NO
         realtime voice endpoint, so a Groq key powers chat yet can never place a
         call. Fail with a clear reason instead of a confusing provider 404. */
      if (/^gsk_/.test(config.openaiApiKey) || /groq\.com/i.test(config.openaiBaseUrl)) {
        const err = new Error('Voice calls need an OpenAI key (sk-…). The configured key is a Groq key — Groq powers text chat but does not support realtime voice. Add a funded OpenAI key to backend/.env to enable calls.')
        err.status = 503
        err.type = 'voice_unavailable'
        err.clientMessage = VOICE_UNAVAILABLE_CLIENT
        throw err
      }
      const res = await fetch(`${config.openaiBaseUrl.replace(/\/$/, '')}/realtime/client_secrets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'Content-Type': 'application/json',
          /* Stable, privacy-preserving per-user identifier (docs: set by the
             trusted backend, bound to the ephemeral token). */
          'OpenAI-Safety-Identifier': createHash('sha256').update(`nexora:${userId}`).digest('hex'),
        },
        body: JSON.stringify({ session }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.value) {
        const err = new Error(data?.error?.message || `Voice provider responded ${res.status}`)
        err.status = 502
        err.type = 'voice_provider_error'
        throw err
      }
      return { clientSecret: data.value, expiresAt: data.expires_at, sessionId: data.session?.id || null }
    },
  },
}

export function activeProvider() {
  return PROVIDERS[config.voiceProvider] || null
}

export async function createVoiceClientSecret(session, userId) {
  const provider = activeProvider()
  if (!provider) {
    const err = new Error(`Unknown voice provider "${config.voiceProvider}"`)
    err.status = 500
    err.type = 'config_error'
    throw err
  }
  return provider.createClientSecret(session, userId)
}

/* ---- per-user sliding-window rate limit (fresh session starts) ---- */

const starts = new Map()

export function consumeVoiceStart(userId) {
  const now = Date.now()
  const windowMs = 10 * 60 * 1000
  const list = (starts.get(userId) || []).filter((t) => now - t < windowMs)
  if (list.length >= config.voiceRateLimit) return false
  list.push(now)
  starts.set(userId, list)
  return true
}
