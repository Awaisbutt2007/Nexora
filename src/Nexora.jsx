import { lazy, Suspense, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react'
import { InstallAppButton } from './InstallApp.jsx'
import { createPortal } from 'react-dom'
import './Nexora.css'
import './typography.css'
import { Icon } from './icons.jsx'
import SignIn from './SignIn.jsx'
import workspaceShot from './assets/workspace-shot.png'
import workspaceSchedule from './assets/workspace-schedule.png'
import workspaceTools from './assets/workspace-tools.png'
import workspaceMemory from './assets/workspace-memory.png'
import CursorTrail from './CursorTrail.jsx'
import AnimeEffects from './AnimeEffects.jsx'
import { useAnimatedNumber } from './useAnimatedNumber.js'
import {
  clearSession,
  deleteConversation,
  deleteAllConversations,
  deleteMemory,
  getConversation,
  getQuota,
  listConversations,
  listMemories,
  loadSession,
  me,
  saveMemory,
  saveSession,
  streamChat,
  proactiveChat,
  updateEmail,
  updatePassword,
  updateProfile,
  uploadChatImage,
  attachMessageImages,
  resourceUrl,
  upgradePlan,
  billingStatus,
  billingRequest,
  billingRequests,
  billingReview,
  desktopAudit,
  desktopApps,
  desktopExecute,
  desktopGrant,
  desktopHealth,
  desktopIntent,
  desktopPermissions,
  desktopPlan,
  desktopRevoke,
  desktopScreenCapture,
  desktopScreenInspect,
  desktopStop,
  listSchedule,
  createScheduleTask,
  updateScheduleTask,
  deleteScheduleTask,
  fetchScheduleReminders,
  ackScheduleReminders,
  createConversation,
  synthesizeSpeech,
} from './api/nexora.js'
/* Direct transport to the customer's own local Nexora Agent (cloud web app mode) —
   pairing, the client-token store and the agent-side action calls. The desktop*
   client above stays as the self-hosted backend-proxy fallback. */
import {
  agentTransport,
  agentPairStatus,
  agentPair,
  agentRevoke,
  agentHealth,
  agentPermissions,
  agentApps,
  agentGrant,
  agentRevokePermission,
  agentPlan,
  agentExecute,
  agentStop,
  agentAudit,
  hasPairedAgent,
} from './api/agent.js'
/* Her own eyes on the app: real screenshots of the live UI and of the particle face. */
import { captureCurrentPage, captureNode, captureSelfFace } from './selfCapture.js'
import { useWakeWord } from './useWakeWord.js'
import { configureUtterForSpeech, warmVoiceList } from './voiceSelect.js'
import { streamFeed, streamFinal, cancelSpeakQueue, setSpeakMarkers } from './sentenceSpeak.js'
/* Frontend mirror of the backend's WORLD_LANGUAGES table. Adding a language on
   the server without adding it here fails the "language mirror cannot drift"
   test in api.test.mjs, so the two lists cannot silently disagree. */
import { LANGUAGE_OPTIONS, LANGUAGE_GROUPS_UI } from './worldLanguages.js'
import { acquireVoiceTap, loadOwnerVoice, strangerReply, verifyRecentSpeech } from './ownerVoice.js'
import OwnerVoiceSetup from './OwnerVoiceSetup.jsx'

const ThreeHero = lazy(() => import('./ThreeHero.jsx'))
const Onboarding = lazy(() => import('./Onboarding.jsx'))
const VoiceCall = lazy(() => import('./VoiceCall.jsx'))
/* Live webcam capture — opened from the composer 📷, only loaded once per use. */
const CameraCapture = lazy(() => import('./CameraCapture.jsx'))
/* The chosen AI portrait, reused above the live conversation */
const NanoParticles = lazy(() => import('./NanoParticles.jsx'))
/* The memory vault: three.js brain + cables, only ever loaded when the door opens */
const MemoryVault = lazy(() => import('./MemoryVault.jsx'))

/* Flag kept while a new (Google or sign-up) user still has to finish the "what should I call you" step */
const ONBOARDING_KEY = 'nexora_onboarding_pending'

/* Voice-call prefs live locally (provider voice + language); the persona name
   comes from the onboarding wizard so Aira answers to the name the user gave. */
const VOICE_PREFS_KEY = 'nexora_voice_prefs'
const ONBOARDING_PROGRESS_KEY = 'nexora_onboarding_progress'
/* The finished onboarding profile (assistant name + chosen character) — durable,
   cleared only on logout. loadVoicePrefs seeds the persona from HERE, not from the
   transient progress key, because handleFinish deletes the progress key the moment
   onboarding ends and the workspace mounts. */
const AI_PROFILE_KEY = 'nexora_ai_profile'
/* "Don't message me right now" — set when the user explicitly asks for quiet,
   survives reloads, and is only lifted when the user writes again. */
const PROACTIVE_MUTE_KEY = 'nexora_proactive_muted'

/* Demo accounts (the "Continue as Demo" sign-in) get a short free taste of chat.
   Once they have sent DEMO_PROMPT_LIMIT prompts the composer stops and the pricing
   modal opens. The counter lives per-browser and is cleared on every fresh demo
   login (see SignIn.handleDemoAuth); upgrading to a paid plan clears the limit. */
const DEMO_PROMPT_LIMIT = 3
const DEMO_PROMPTS_KEY = 'nexora_demo_prompts'

/* OpenAI Realtime built-in voices (docs-verified list) */
const VOICE_OPTIONS = [
  ['marin', 'Marin', 'warm · natural female — recommended default'],
  ['shimmer', 'Shimmer', 'soft · expressive female'],
  ['ballad', 'Ballad', 'light · melodic female'],
  ['coral', 'Coral', 'breathy · friendly'],
  ['sage', 'Sage', 'grounded · steady'],
  ['verse', 'Verse', 'crisp · composed'],
  ['alloy', 'Alloy', 'neutral · balanced'],
  ['echo', 'Echo', 'easy-going · warm'],
  ['ash', 'Ash', 'friendly · even'],
  ['cedar', 'Cedar', 'firm · male-leaning'],
]
/* Reply-language list is derived from the mirror (see worldLanguages.js). The
   old 4-entry array here is what made every other language on earth invisible
   to the Settings dropdown, even though the backend had accepted them since the
   WORLD_LANGUAGES table shipped. */
const VOICE_LANGUAGES = LANGUAGE_OPTIONS.map(({ id, label }) => [id, label])

/* Wake-word spoken responses. Kept as short canned lines because the goal is a
   sub-two-second earcon so it never collides with the actual streamed reply
   that follows. Longer TTS on the real answer belongs to VoiceCall, not here.

   WHY AN ARRAY NOW: a hard-coded single "command" string was the reason the
   user complained "har chat ke start pe AI yehi bolti hai". Every voice
   command spoke and prefilled the bubble with the exact same canned line,
   which read like a robot, not a companion. We rotate through six natural
   variations per language so consecutive chats never sound identical, and
   the visible bubble is no longer polluted by the ack (see sendPrompt).
   The `wake` line stays singular because that fires only on a bare wake-up
   call, which happens rarely. */
const WAKE_ACK_LINES = {
  en: {
    wake: "I'm listening.",
    command: [
      'Okay — on it.',
      'Sure, give me a second.',
      'Got it, one moment.',
      'Alright, doing it now.',
      'Ok, working on it.',
      'Sure thing — hang tight.',
    ],
  },
  ur: {
    wake: 'Main sun rahi hoon.',
    command: [
      'Ji, kar rahi hoon.',
      'Bilkul, ek pal.',
      'Theek hai, dekhiye.',
      'Ho raha hai, rukiye.',
      'Ji Zaroor, abhi.',
      'Bataiye, kar doon.',
    ],
  },
  hinglish: {
    wake: 'Ji, boliye.',
    command: [
      'Theek hai, kar rahi hoon.',
      'Ji, ek second.',
      'Ho raha hai, ruko.',
      'Done, dekho.',
      'Bas kar dungi, tum bolo.',
      'Bilkul, abhi karti hoon.',
    ],
  },
  auto: {
    wake: 'Ji, boliye — main sun rahi hoon.',
    command: [
      'Theek hai, kar rahi hoon.',
      'Okay, one sec.',
      'Ho raha hai, ruko.',
      'Got it, ek pal.',
      'Bas kar dungi.',
      'Bilkul, abhi.',
    ],
  },
}
/* Fire a short utterance on the browser's speech engine. The voice pick, the
   per-language accent chain (so a Windows-only-English install speaking
   Hinglish lands on en-IN, not en-GB), the rate slow-down for mixed-script
   replies and the gender-pitch tweak all live in one shared helper
   (`configureUtterForSpeech` in voiceSelect.js) so the wake ack, the streamed
   chat reply and the VoiceCall fallback pipeline sound IDENTICAL.
   `onEnd` fires when the utterance finishes (or immediately on error) so the
   conversation-loop hook can re-arm the mic after the AI finishes speaking. */
function speakWakeLine(text, { language, gender, onEnd } = {}) {
  if (typeof window === 'undefined' || !window.speechSynthesis || !text) { onEnd?.(); return }
  try {
    /* Cancel any still-playing ack from a previous utterance — the user may
       have said the wake word twice and the second ack must not queue. */
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    configureUtterForSpeech(utter, window.speechSynthesis.getVoices(), { language, gender })
    utter.onend = () => { markAiSpeakingEnd(); onEnd?.() }
    utter.onerror = () => { markAiSpeakingEnd(); onEnd?.() }
    /* Stamp barge-in tracker so the wake-word hook knows real speech is on
       the wire (and won't fire on our own echo for the first 800 ms). */
    markAiSpeakingStart()
    window.speechSynthesis.speak(utter)
  } catch { /* browser blocked TTS or voices list unavailable — the visual caption still shows */ markAiSpeakingEnd(); onEnd?.() }
}

/* Auto-voice inside the workspace content: once the streamed reply lands, we
   speak it. Server TTS (OpenAI's multilingual `gpt-4o-mini-tts` engine reached
   via POST /api/voice/synth) is TRIED FIRST because it is the only path that
   actually pronounces Roman-Hindi / Roman-Urdu naturally — the browser engine
   on a Windows install is stuck with English-only voices and mangles Hinglish
   no matter what accent chain we hand it. Any server failure (no key, Groq-
   only, offline, credit shortfall) falls through to the browser path with
   voiceSelect.js's accent chain + slow rate + emoji-strip, so the user always
   hears the reply. Markdown is stripped because "asterisk bold asterisk" is
   unreadable and code fences turn into long stretches of punctuation. EMOJIS
   are stripped too: the engine would otherwise say "heavy black heart…
   sparkles… smiling face with heart-eyes" out loud — which both reads the
   emoji (nobody asked for that) and shreds the sentence so a Hinglish answer
   becomes impossible to follow. Cap the length so a multi-paragraph essay
   doesn't lock the mic for a minute. */
let currentServerAudio = null
/* Barge-in tracker: the moment the AI begins speaking we stamp `aiSpeakingSinceMs`;
   the wake-word hook reads it (through the `onUserSpeaking` prop) so a user's
   spoken interrupt cuts the TTS off mid-sentence — like two humans chatting.
   We gate on an 800 ms floor after the AI starts speaking to give Chrome's AEC
   (acoustic echo cancellation) time to lock onto the speaker signal; without
   this the AI's own voice briefly echoes back through the mic and triggers a
   self-cancel loop where she cuts herself off every few words. Reset to 0 on
   the utterance's `onend` / `onerror` (or when `cancelServerAudio` runs). */
let aiSpeakingSinceMs = 0
function isAiSpeakingLongEnough() {
  if (!aiSpeakingSinceMs) return false
  /* Either server audio (a live <audio> element) or browser speechSynthesis is
     currently producing sound. Both paths must be checked because we fall back
     between them depending on whether a real OpenAI key is present. */
  const serverLive = Boolean(currentServerAudio) && !currentServerAudio.paused
  const browserLive = typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.speaking
  return (serverLive || browserLive) && Date.now() - aiSpeakingSinceMs >= 800
}
function markAiSpeakingStart() { aiSpeakingSinceMs = Date.now() }
function markAiSpeakingEnd() { aiSpeakingSinceMs = 0 }
/* Mirror of the barge-in tracker for the OTHER side of the conversation: the
   last time the always-on mic heard the USER talk. The idle check-in loop used
   to watch only whether the AI was busy (`streamingRef`) and whether the user
   had SENT anything (`lastActivityRef`) — never whether they were mid-sentence,
   so a long spoken turn let her interrupt with a fresh bubble. The stamp is
   taken in `onUserSpeaking` BEFORE its barge-in early-return, because the
   "don't talk over me" rule matters most when the AI is already silent. */
let userSpeakingSinceMs = 0
function markUserSpeaking() { userSpeakingSinceMs = Date.now() }
function hasUserSpokenRecently(windowMs = 6000) {
  return userSpeakingSinceMs > 0 && Date.now() - userSpeakingSinceMs < windowMs
}
function cancelServerAudio() {
  /* Sentence streaming owns its own queue + audio, so route a cancel there
     FIRST — that clears `pending`, bumps the generation token so any fetch
     in flight resolves but is discarded, and stops the current <audio>. Then
     we also fall through to the legacy `currentServerAudio` cleanup path so
     the pre-streaming code (which still uses `speakAssistantReply` for
     one-shot replies like proactive check-ins and wake acks) is cancelled
     too. Both are safe to call unconditionally. */
  cancelSpeakQueue()
  if (currentServerAudio) {
    try { currentServerAudio.pause() } catch { /* already stopped */ }
    try { if (currentServerAudio.src && currentServerAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentServerAudio.src) } catch { /* ignore */ }
    currentServerAudio = null
  }
  /* A cancel here is either the end of a normal utterance OR a barge-in from the
     user — either way, the AI is no longer speaking, so reset the tracker. */
  markAiSpeakingEnd()
}
/* Wire the streaming queue to the same barge-in tracker so `isAiSpeakingLongEnough`
 * sees activity from BOTH the one-shot legacy speak AND the new sentence queue.
 * Without this the streaming path would start playing audio without stamping
 * `aiSpeakingSinceMs`, and Chrome's AEC-lock-in grace window would let the AI's
 * own first echo trigger a self-cancel. */
setSpeakMarkers(markAiSpeakingStart, markAiSpeakingEnd)
async function speakAssistantReply(text, { language, gender, authToken, voice, onEnd, names } = {}) {
  if (typeof window === 'undefined' || !text) { onEnd?.(); return }
  const plain = String(text)
    .replace(/```[\s\S]*?```/g, ' (code shown in chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    /* Drop every pictograph/emoji, then the invisible glue that can strand a
       modifier after its base was removed — skin tones, variation selectors, the
       ZWJ joiner, combining keycaps and regional-indicator flag letters — all via
       Unicode property escapes so no literal combining char sits in the class. */
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\p{Emoji_Modifier}\p{Variation_Selector}\p{Regional_Indicator}\p{Join_Control}\p{Me}]/gu, '')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900)
  if (!plain) return
  /* Cancel whatever browser-TTS is still playing so we don't overlap with the
     server audio (and vice-versa — a fresh server call stops any prior server
     clip via cancelServerAudio; both cancel paths run before every new speak). */
  if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } }
  cancelServerAudio()
  /* Try server TTS when there is a session to authenticate it with. Anything
     except a 503 (`tts_unavailable` — Groq key / mock mode / no key) means the
     request WAS valid and we should trust the browser fallback silently: a
     402 (out of credits) or 429 (rate limited) shouldn't be logged as if it
     were a bug — the visual caption already shows the reply anyway. */
  if (authToken) {
    try {
      const blob = await synthesizeSpeech(authToken, { text: plain, language, gender, voice, names })
      const url = URL.createObjectURL(blob)
      const audio = new window.Audio(url)
      audio.onended = () => { try { URL.revokeObjectURL(url) } catch { /* ignore */ }; if (currentServerAudio === audio) currentServerAudio = null; markAiSpeakingEnd(); onEnd?.() }
      audio.onerror = () => { try { URL.revokeObjectURL(url) } catch { /* ignore */ }; if (currentServerAudio === audio) currentServerAudio = null; markAiSpeakingEnd(); onEnd?.() }
      currentServerAudio = audio
      /* Stamp barge-in tracker BEFORE play() so the 800 ms grace window starts
         ticking from the moment sound actually begins on the wire. */
      markAiSpeakingStart()
      await audio.play()
      return
    } catch (err) {
      /* 503 = not configured — completely expected on a Groq-only install; fall
         through silently. Any other code we still swallow here because the
         user is hearing the reply via the browser path anyway, and a red
         console line on every streamed reply would look like a broken app. */
      if (err && err.status !== 503) console.warn('[tts] server synth failed, using browser voice:', err.message)
    }
  }
  /* Browser TTS fallback — the same voice path wake acks use, so "her" stays
     consistent across the app on any install that lacks a live speech key. */
  speakWakeLine(plain, { language, gender, onEnd })
}

/* A deployed static frontend (Vercel) has no AI server behind it, so
   /api/chat/completions 404s and streamChat throws. Rather than a red error
   card, we answer locally with a warm, language-aware demo reply. A real
   backend always wins — this path only runs when the API is unreachable. */
function isBackendUnreachable(err) {
  if (!err) return false
  if (err instanceof TypeError) return true // fetch never reached any server
  if (err.status === 404 || err.status === 502 || err.status === 504) return true
  return /failed to fetch|networkerror|load failed|chat failed \(404\)|not running|not found/i.test(String(err.message || err))
}

/* The live engine can also refuse without being down: Groq's free-tier token
   budget throttles with a 429 once a few messages land inside one minute. To the
   person chatting, a 429 and an unreachable API feel identical — silence — so
   both route to the same warm local demo reply instead of a red error card, and
   the chat never stalls. A live backend that CAN answer always wins (this only
   runs from the catch, after a real send failed). */
function isEngineUnavailable(err) {
  return isBackendUnreachable(err) || err?.status === 429 || err?.type === 'rate_limit'
}

function localDemoReply(text, aiName, language) {
  const name = (aiName || 'Aira').trim() || 'Aira'
  const q = String(text || '').trim()
  const low = q.toLowerCase()
  const lang = String(language || 'auto').toLowerCase()
  const L = lang === 'ur' ? 'ur' : lang === 'en' ? 'en' : 'hinglish'

  let intent = 'default'
  if (/^(hi|hello|hey|salam|assalam|assalamo|yo|namaste|hola)\b/.test(low) || /السلام|ہیلو/.test(q)) intent = 'greet'
  else if (/(how are you|kaise ho|kaisay ho|kya haal|kyaa haal|theek ho|کیسے|کیا حال)/.test(low + q)) intent = 'how'
  else if (/(who are you|tum kon|tum kaun|aap kon|your name|tera naam|kon ho|تم کون|tumhara naam)/.test(low + q)) intent = 'who'
  else if (/(thank|shukriya|thanks|thnx|شکریہ)/.test(low)) intent = 'thanks'
  else if (/(bye|good night|goodnight|gohood|chlo|alvida|tata|phir milte|ملتے ہیں)/.test(low)) intent = 'bye'
  else if (/\?$/.test(q) || /^(what|why|how|when|where|who|kya|kyu|kyon|kab|kahan|kaun|kaise)\b/.test(low)) intent = 'question'

  const R = {
    ur: {
      greet: `السلام علیکم! میں ${name} ہوں — آپ کی AI ساتھی۔ 🙂`,
      how: `میں بالکل ٹھیک ہوں، شکریہ! آپ سنائیں، آج کیا مدد کروں؟`,
      who: `میں ${name} ہوں، Nexora کی AI اسسٹنٹ۔`,
      thanks: `کوئی بات نہیں! ہمیشہ حاضر ہوں۔ ✨`,
      bye: `ملتے ہیں! اپنا خیال رکھیے گا۔ 👋`,
      question: `اچھا سوال ہے! تفصیلی جواب کے لیے اصل AI سرور چالو ہونا ضروری ہے۔`,
      default: `آپ نے کہا: "${q.slice(0, 160)}" — میں فی الحال ڈیمو موڈ میں ہوں۔`,
    },
    en: {
      greet: `Hey! I'm ${name}, your AI companion. 🙂`,
      how: `I'm doing great, thanks for asking! How about you — what can I help with today?`,
      who: `I'm ${name}, the Nexora AI assistant — here to chat, remember and help you get things done.`,
      thanks: `Anytime! That's what I'm here for. ✨`,
      bye: `Talk soon! Take care. 👋`,
      question: `Good question! A full answer needs the live AI server, which isn't connected right now.`,
      default: `You said: "${q.slice(0, 160)}" — I'm running in demo mode right now.`,
    },
    hinglish: {
      greet: `Hi! Main ${name} hoon — aapki AI companion. 🙂`,
      how: `Main bilkul theek hoon, shukriya! Aap sunao — aaj main aapki kya madad karoon?`,
      who: `Main ${name} hoon, Nexora ki AI assistant — baat cheet, yaaddasht aur kaam mein madad ke liye.`,
      thanks: `Koi baat nahi! Main hamesha haazir hoon. ✨`,
      bye: `Chalo, milte hain! Apna khayal rakhna. 👋`,
      question: `Acha sawaal! Poora jawab dene ke liye live AI server se connect hona zaroori hai, jo abhi connected nahi hai.`,
      default: `Aapne kaha: "${q.slice(0, 160)}" — main abhi demo mode mein chal rahi hoon.`,
    },
  }

  const line = R[L][intent] || R[L].default
  const demoNote = L === 'ur'
    ? `\n\n(ڈیمو موڈ: یہ جواب مقامی طور پر بنایا گیا ہے۔ اصل AI کے لیے سرور چالو کریں۔)`
    : L === 'en'
      ? `\n\n(Demo mode: this reply was generated locally. Connect the live server for real AI answers.)`
      : `\n\n(Demo mode: yeh reply locally bani hai. Real AI ke liye server connect karo.)`
  return line + demoNote
}

/* A turn that came back with nothing to show. The Vercel Edge path relays Groq raw
   and can finish with an empty body (a safety filter, or a bare stop with no text),
   which used to render as a blank bubble — the exact "empty message" the user saw.
   The local backend already refuses to save an empty reply; this covers every
   transport at display time so she is never speechless. */
function emptyReplyFallback(language, aiName) {
  const name = (aiName || 'Aira').trim() || 'Aira'
  const lang = String(language || 'auto').toLowerCase()
  if (lang === 'ur') return `معاف کیجیے، میرا جواب خالی آ گیا — ایک بار پھر پوچھیں، میں دوبارہ کوشش کروں گی۔ 🙂`
  if (lang === 'en') return `Hmm, my reply came out blank — could you send that once more? I'll answer properly this time. 🙂`
  return `Arre, mera reply khaali aa gaya 🙂 Ek baar aur bhej do, is baar main theek se jawab dungi. ✨ (${name})`
}

/* The five choices the workspace remembers, in the shape the backend stores them. */
const voicePrefsPayload = (p) => ({ voice: p.voice, language: p.language, assistantName: p.assistantName, persona: p.persona, gender: p.gender })

const readLocalPrefs = () => {
  try { return JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) || '{}') } catch { return {} }
}

/* `local` is this browser's copy, `account` the one saved on the signed-in user
   (PATCH /api/user/profile) — the account wins. localStorage is per-origin and is
   cleared on logout, so leaning on it alone silently put someone who had picked
   "Urdu first" back on 'auto' the moment they opened another address, and Hinglish
   answers looked like a setting being ignored. Values are validated here either
   way, so a hand-edited blob can't push a bad language into the chat schema. */
function loadVoicePrefs(local, account) {
  try {
    const saved = { ...local, ...(account && typeof account === 'object' ? account : {}) }
    /* Onboarding seeds the defaults; anything the user later edits in Settings
       (persisted in VOICE_PREFS_KEY) wins over the wizard values. */
    let aiName = 'Aira'
    let persona = ''
    /* Which particle portrait the user assembled at onboarding */
    let gender = 'female'
    try {
      const ob = JSON.parse(localStorage.getItem(AI_PROFILE_KEY) || '{}')
      if (ob.aiName) aiName = ob.aiName
      if (ob.characterName) {
        persona = ob.characterDesc ? `${ob.characterName} — ${ob.characterDesc}` : ob.characterName
      }
      if (ob.voiceGender === 'male' || ob.voiceGender === 'female') gender = ob.voiceGender
    } catch { /* no wizard data */ }
    if (typeof saved.assistantName === 'string' && saved.assistantName.trim()) aiName = saved.assistantName.trim()
    /* Only a NON-EMPTY saved persona overrides the onboarding seed. An account that
       predates the persona fix can carry persona:'' — letting that win silently wiped
       the character the user picked, which is exactly the "voice didn't stick" bug. */
    if (typeof saved.persona === 'string' && saved.persona.trim()) persona = saved.persona
    if (saved.gender === 'male' || saved.gender === 'female') gender = saved.gender
    return {
      voice: VOICE_OPTIONS.some(([id]) => id === saved.voice) ? saved.voice : 'marin',
      language: VOICE_LANGUAGES.some(([id]) => id === saved.language) ? saved.language : 'auto',
      assistantName: aiName,
      /* Persona the user picked at onboarding or edited in Settings; sent to /token
         so Aira can weave it into her system instructions. Style only. */
      persona,
      gender,
    }
  } catch {
    return { voice: 'marin', language: 'auto', assistantName: 'Aira', persona: '', gender: 'female' }
  }
}

/* Landing nav in the order the LINKS appear. This is deliberately not the order
   of the sections in the DOM (Showcase sits before Features, About before Plans),
   so the scroll-spy compares element offsets instead of trusting this list. */
const NAV_SECTIONS = [['#home', 'Home'], ['#features', 'Features'], ['#showcase', 'Showcase'], ['#plans', 'Pricing'], ['#faq', 'FAQ'], ['#about', 'About']]

/* a deep link only counts when it actually names one of the nav sections, so an
   unrelated #hash can't start the page with no underline at all */
function initialNavHash() {
  return NAV_SECTIONS.some(([hash]) => hash === window.location.hash) ? window.location.hash : '#home'
}

const navItems = [['Chat', 'chat'], ['Schedule', 'schedule'], ['Memory', 'memory'], ['Tools', 'tools'], ['Desktop', 'desktop'], ['Settings', 'settings']]
/* Schedule chips are a lookup, not a render-time clock read (oxlint purity):
   refreshTasks stamps each task with its phase while the data lands. */
const SCHEDULE_CHIP = { due: ['Due now', 'chip-due'], soon: ['Reminds tomorrow', 'chip-soon'], planned: ['Planned', 'chip-planned'], done: ['Done ✓', 'chip-done'] }

/* The three plans, shared by the landing pricing section and the in-app upgrade
   modal so the price a visitor sees is the price a member is charged. `key` maps
   to the backend enum ('free' | 'pro' | 'yearly_pro'). */
const PLANS = [
  { key: 'free', feat: false, label: 'STARTER', name: 'Starter', price: 'FREE', sub: 'to begin', desc: 'Har roz ke sawal aur chhote ideas ke liye.', items: ['Helpful AI conversations', 'Everyday creative tools', '100 credits on sign-up — top up any time', 'Your own idea library'], cta: 'Get Starter', tint: 'outline' },
  { key: 'pro', feat: true, label: 'MOST LOVED · MONTHLY', name: 'Pro', price: '₨10,000', sub: '/ month', desc: 'Ambitious projects aur unlimited work ke liye.', items: ['Premium AI models', 'Faster image and file tools', 'No credit limit — unlimited', 'Bigger projects, longer memory'], cta: 'Get Pro', tint: 'primary' },
  { key: 'yearly_pro', feat: false, label: 'YEARLY · BEST VALUE', name: 'Yearly Pro', price: '₨80,000', sub: '/ year', desc: 'Poore saal ka magic, saste mein.', items: ['Premium AI models', 'Faster image and file tools', 'No credit limit — unlimited', 'Bigger projects, longer memory', '12 months for the price of 8'], cta: 'Get Yearly Pro', tint: 'outline' },
]
const tools = [
  ['image', 'Image Generator', 'Create striking images from a simple prompt.', 'violet', 'image_generator', 'Describe the image you want — scene, style, mood…'],
  ['code', 'Code Assistant', 'Write, debug, and explain code with context.', 'blue', 'code_assistant', 'Describe the code you need: language, inputs, expected behaviour…'],
  ['pdf', 'PDF Reader', 'Ask questions and find details in any PDF.', 'pink', 'pdf_reader', 'Paste the document text, then ask your question…'],
  ['youtube', 'YouTube Notes', 'Turn long videos into clear takeaways.', 'cyan', 'youtube_notes', 'Paste a transcript or describe the video topic…'],
  ['meeting', 'Meeting Notes', 'Capture decisions and next steps automatically.', 'violet', 'meeting_notes', 'Paste your raw meeting notes or agenda…'],
  ['social', 'Social Studio', 'Shape one idea into content for every channel.', 'green', 'social_studio', 'Describe the idea and the tone you want…'],
]

/* Per-tool session kit used when a card in the Tools grid is clicked. The
   `intro` line is what Aira says first inside the freshly-opened chat (it asks
   for the exact reference inputs the tool needs), and `draft` is the scaffold
   we pre-fill in the composer so the user only has to complete the blanks
   instead of writing the request from scratch. Key is the tool title. The
   `[<title> · session]` prefix inside `draft` is what the backend LLM reads
   on the very first send so it knows which tool lane to answer in — the
   conversation itself is created upfront with the tool name as its title. */
const TOOL_STARTERS = {
  'Image Generator': {
    intro: `Image Generator is ready. Before I paint, share: 1) the subject or scene, 2) style (photorealistic, anime, oil, 3D render…), 3) mood or palette, 4) aspect ratio (1:1 / 16:9 / 9:16), and 5) optional — a reference image you want me to match. Fill the draft below and send it, and I'll begin.`,
    draft: `[Image Generator · session] Please create an image with these inputs:\n• Subject / scene: \n• Style: \n• Mood & palette: \n• Aspect: 1:1\n• Reference (optional): \n`,
  },
  'Code Assistant': {
    intro: `Code Assistant on. Tell me: 1) language / framework, 2) the goal in one plain sentence, 3) inputs and expected output, 4) constraints (perf, no deps, style, target runtime). Paste any existing snippet you want me to work with. Complete the draft below and I'll take it from there.`,
    draft: `[Code Assistant · session] Help me with this code:\n• Language / stack: \n• Goal: \n• Inputs → Expected output: \n• Constraints: \n• Existing snippet (optional): \n`,
  },
  'PDF Reader': {
    intro: `PDF Reader open. Nexora does not fetch files itself — paste the PDF's text (or the section you care about), then tell me the question, the summary style you want, or which fields to extract. Fill the draft and I'll answer from the text only.`,
    draft: `[PDF Reader · session] Document text:\n\n\n• What I want from it (summary / Q&A / key quotes / outline): \n• Specific question (if any): \n`,
  },
  'YouTube Notes': {
    intro: `YouTube Notes ready. Paste the transcript (or describe the video's topic and chapters) and tell me the angle you want — quick takeaways, timestamped summary, quotes, or action items. Complete the draft and I'll turn it into notes you can save.`,
    draft: `[YouTube Notes · session] Video transcript or topic:\n\n\n• Focus (takeaways / timestamps / quotes / actions): \n• Desired output length: \n`,
  },
  'Meeting Notes': {
    intro: `Meeting Notes on. Paste the raw notes, transcript or agenda and I'll extract decisions, action items, owners and follow-ups into a clean summary. Fill the draft so I know who was in the room and how tight you want the output.`,
    draft: `[Meeting Notes · session] Raw notes / transcript / agenda:\n\n\n• Attendees (optional): \n• Output detail (short recap / full minutes / action table): \n`,
  },
  'Social Studio': {
    intro: `Social Studio ready. Give me the one idea you want to spread and pick the channels — Twitter/X, LinkedIn, Instagram, TikTok, blog. Tell me the tone and any CTA. Complete the draft and I'll shape a version for each.`,
    draft: `[Social Studio · session] Idea to spread: \n• Channels (Twitter/X, LinkedIn, Instagram, TikTok, blog): \n• Tone (bold / warm / witty / authoritative): \n• CTA (if any): \n`,
  },
}

const featureList = [
  ['chat', 'Conversational AI', 'A chat that remembers context and truly gets you.'],
  ['sparkle', 'Creative Studio', 'Generate images, writing, code and polished content on demand.'],
  ['memory', 'Unified Memory', 'Your files, chats and ideas live together, always ready.'],
  ['schedule', 'Smart Planning', 'Organize weeks, projects and todos without leaving the flow.'],
]

const testimonials = [
  { initials: 'TA', name: 'Tom Andersson', platform: 'Twitter', quote: 'Setup took less than an hour and we were booking demos the same day. Incredible product and blazing fast.' },
  { initials: 'SC', name: 'Sarah Chen', platform: 'ProductHunt', quote: 'We booked our first meeting from a neural synthesis workflow in under an hour of signing up.' },
  { initials: 'MW', name: 'Marcus Webb', platform: 'LinkedIn', quote: 'The multi-modal autonomous pipeline doubled our output in 30 days. It feels like an AI OS from the future.' },
  { initials: 'LK', name: 'Lena Kim', platform: 'Twitter', quote: 'Finally an AI workspace built for outbound & design teams. The unified canvas alone saves us 2 hours a day.' },
  { initials: 'AR', name: 'Ahmed R.', platform: 'Community', quote: 'Nexora ne meri productivity ko agay le gaya. Memory feature se har cheez ek jaga hai, aur chat context bilkul seamless hai.' },
  { initials: 'SM', name: 'Saad M.', platform: 'Community', quote: 'Bohat hi clean interface. Code assistant aur visual tools sath milne se workflow bohat simplify ho gaya.' },
]

const faqs = [
  { q: 'Hum Nexora kyu purchase karein?', a: 'Nexora ek personal AI assistant hai jismein chat, image creation, code help, file reading, planning aur memory — sab ek hi jagah milta hai. Aap ek workspace se apne poore ideas ko manage kar sakte hain. Yeh ek ordinary AI assistant se behtar hai — aap isse apni baatein share kar sakte hain, yeh aapke liye khud kaam karega, aap isko kisi bhi insaan ki voice de sakte hain, aur yeh aapke kai projects mein bhi bohat madadgar hoga.' },
  { q: 'Kya Nexora free use kar sakte hain?', a: 'Ji haan — sign-up par aapko 100 free credits milte hain jo daily sawalon, chhote ideas aur creative tools ke liye kaafi hain. Jab credits khatam ho jayen to Pro (₨10,000/mo) ya Yearly Pro (₨80,000/yr) plan le sakte hain jismein unlimited access milta hai.' },
  { q: 'Pro aur Yearly Pro main kya extra milta hai?', a: 'Pro (₨10,000/month) aur Yearly Pro (₨80,000/year) dono main aapko premium AI models, faster image aur file tools, aur bilkul unlimited credits ka access milta hai — 100 free credits ki hadd nahi rahti. Yearly Pro mein 12 mahine sirf 8 ke daam mein milte hain — sabse zyada value wala plan hai.' },
  { q: 'Kya meri files aur data secure hain?', a: 'Haan, aapke data aur chats aapki hi personal space main rehte hain. Nexora aapke ideas aur files ko private rakhta hai — aapka data kisi aur ke saath share nahi hota.' },
  { q: 'Mobile ya sirf desktop par chalega?', a: 'Nexora ka interface responsive design ka hai — aap desktop, tablet aur mobile dono par aaram se use kar sakte hain. Workspace aur landing page dono har screen size par optimized hain.' },
]

function Brand({ compact = false }) {
  return <a className={`brand${compact ? ' brand-compact' : ''}`} href="#home" aria-label="Nexora home"><svg className="brand-mark" viewBox="0 0 36 36" aria-hidden="true"><path d="M7 27V9l22 18V9" fill="none" stroke="url(#brand-gradient)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="6" /><defs><linearGradient id="brand-gradient" x1="7" x2="29" y1="9" y2="27" gradientUnits="userSpaceOnUse"><stop stopColor="#72e2ff" /><stop offset=".52" stopColor="#a866ff" /><stop offset="1" stopColor="#ff68d7" /></linearGradient></defs></svg><span>Nexora</span></a>
}

function AssistantArtwork() {
  return <Suspense fallback={<div className="artwork scene-loading" role="img" aria-label="Loading Nexora’s 3D AI companion" />}><ThreeHero /></Suspense>
}

const CURRENT_YEAR = new Date().getFullYear()

/* Wallet pill's number slot. Wraps `useAnimatedNumber` so the value visually
 * rolls down like an "ulta countdown" when a reply debits credits/tokens, and
 * pops a small "-N" chip that fades up. Hooks can't live inside the pill's
 * IIFE (conditional call), so we split the animated span into its own
 * component and let the parent decide what number to feed. */
function CreditsValue({ value, format = (n) => `${n}` }) {
  const { display, delta } = useAnimatedNumber(value)
  const shown = Number.isFinite(display) ? format(display) : display
  return <>
    <span className={`credits-value${delta ? ' is-ticking' : ''}`}>{shown}</span>
    {delta ? <span className="credits-delta" aria-hidden="true">{delta > 0 ? `+${delta}` : delta}</span> : null}
  </>
}

/* Real headless captures of the signed-in workspace pages — the showcase cycles
   through them so visitors see every zone, not just the chat hero. */
const SHOWCASE_SHOTS = [
  { label: 'Chat', src: workspaceShot, alt: 'The Nexora workspace chat: companion greeting, starter prompts and the message composer.' },
  { label: 'Schedule', src: workspaceSchedule, alt: 'The Schedule page: upcoming tasks with reminder chips and a live schedule nudge from Nexora.' },
  { label: 'Memory', src: workspaceMemory, alt: 'The Memory vault: a particle brain with wires connecting saved memories and chats.' },
  { label: 'Tools', src: workspaceTools, alt: 'The Tools page: Image Generator, Code Assistant, PDF Reader, YouTube Notes, Meeting Notes and Social Studio.' },
]

function Landing({ onLogin, onNavigate, isLoggedIn, userProfile, onUpgrade }) {
  const [openFaq, setOpenFaq] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [shotIdx, setShotIdx] = useState(0)
  /* The showcase window cycles the real pages on its own; a chip click pins one. */
  useEffect(() => {
    const timer = setInterval(() => setShotIdx((i) => (i + 1) % SHOWCASE_SHOTS.length), 5500)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 18)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const navRef = useRef(null)
  const spyLockRef = useRef(0)
  const [activeHash, setActiveHash] = useState(initialNavHash)
  const [layoutTick, setLayoutTick] = useState(0)
  const [underline, setUnderline] = useState({ left: 0, top: 0, width: 0, visible: false })

  /* clicking a link moves the bar at once — the href still does the smooth scroll */
  function followLink(hash) {
    setMenuOpen(false)
    setActiveHash(hash)
  }

  /* the hash changes before the page starts gliding, and that is the one moment
     the spy must stand down — otherwise it drags the bar backwards through every
     section the viewport passes on the way to the one that was clicked */
  useEffect(() => {
    const onHashChange = () => {
      spyLockRef.current = Date.now() + 900
      setActiveHash(initialNavHash())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  /* scroll-spy: the section whose top has last passed the probe line (just under
     the fixed header) owns the nav — deepest offset wins, so DOM order is fine */
  useEffect(() => {
    /* on a deep link the browser jumps to the section after layout, so the spy is
       locked out briefly — otherwise it stamps the bar back onto Home */
    if (window.location.hash) spyLockRef.current = Date.now() + 1200
    const onScroll = () => {
      if (Date.now() < spyLockRef.current) return
      const probe = window.scrollY + 160
      let current = null
      let bestTop = -1
      for (const [hash] of NAV_SECTIONS) {
        const el = document.getElementById(hash.slice(1))
        if (!el) continue
        if (el.offsetTop <= probe && el.offsetTop > bestTop) { bestTop = el.offsetTop; current = hash }
      }
      setActiveHash(current || '#home')
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  /* re-take the bar's snapshot whenever the header geometry can move: a window
     resize, or a ResizeObserver. The nav box is not enough: the link group is
     centred inside a flex:1 column whose height comes from the header, so a late
     web-font swap re-measures every label WITHOUT resizing the nav — watching the
     labels too is what stops the parked bar sitting ~9px off on first paint */
  useEffect(() => {
    const nav = navRef.current
    const retake = () => setLayoutTick((tick) => tick + 1)
    window.addEventListener('resize', retake)
    const observer = typeof ResizeObserver === 'undefined' || !nav ? null : new ResizeObserver(retake)
    observer?.observe(nav)
    if (observer) nav.querySelectorAll('a').forEach((link) => observer.observe(link))
    document.fonts?.ready?.then(retake).catch(() => {})
    return () => {
      window.removeEventListener('resize', retake)
      observer?.disconnect()
    }
  }, [])

  /* park the shared bar under the active link. Fractional rects are read relative
     to the nav (not offsetLeft/offsetTop, which round, and not viewport coords,
     which the header's own padding transition would move), so the bar lines up to
     the pixel and stays put while the header collapses on scroll. */
  useLayoutEffect(() => {
    const nav = navRef.current
    const link = nav?.querySelector(`a[href="${activeHash}"]`)
    if (!link || !link.offsetWidth) { setUnderline((prev) => ({ ...prev, visible: false })); return }
    const navRect = nav.getBoundingClientRect()
    const linkRect = link.getBoundingClientRect()
    /* the per-link ::after this replaces sat on the link's own bottom edge, and the
       link lifts with translateY(-1px) on a .2s transition: reading the visual rect
       here would catch the newly-active link mid-lift, one pixel too low, for the
       rest of the page's life. The LAYOUT box ignores transforms, so it is stable —
       minus the 1px the link is about to rise by. */
    setUnderline({
      left: linkRect.left - navRect.left + 4,
      top: link.offsetTop + link.offsetHeight - 1,
      width: Math.max(0, linkRect.width - 8),
      visible: true,
    })
  }, [activeHash, layoutTick])

  return <main className="landing" id="home">
    <AnimeEffects />
    <div className="ambient-dots" aria-hidden="true">
      <i /><i /><i /><i /><i /><i /><i /><i />
    </div>

    <header className={`floating-header ${scrolled ? 'scrolled' : ''}`}>
      <div className="floating-header-inner wrap">
        <Brand />
        <nav className="main-nav" aria-label="Main navigation" ref={navRef}>
          {NAV_SECTIONS.map(([hash, label]) => <a key={hash} href={hash} className={activeHash === hash ? 'active' : ''} aria-current={activeHash === hash ? 'page' : undefined} onClick={() => followLink(hash)}>{label}</a>)}
          {/* ONE bar that slides between links — a per-link ::after can only blink
              on/off, which is why the line looked stuck under Home */}
          <span className="nav-underline" aria-hidden="true" style={{ left: underline.left, top: underline.top, width: underline.width, opacity: underline.visible ? 1 : 0 }} />
        </nav>
        <div className="header-actions">
          {isLoggedIn && !userProfile?.isDemo ? (
            <button className="header-account" type="button" onClick={() => onNavigate('Home')} title={userProfile?.email ? `Connected: ${userProfile.email}` : 'Open workspace'}>
              <span className="profile-avatar">{userProfile?.avatar ? <img src={userProfile.avatar} alt="" className="avatar-img" referrerPolicy="no-referrer" /> : (userProfile?.name || 'U').charAt(0).toUpperCase()}</span>
              <span>{userProfile?.name ? `${userProfile.name.split(' ')[0]}'s Space` : 'Open workspace'}</span>
            </button>
          ) : (
            <a className="login-link header-download" href="/download"><Icon name="download" size={15} /> Download</a>
          )}
          <button className="button button-primary header-cta" type="button" onClick={() => onNavigate('Home', null, 'Nexora Workspace')}>Get Started <span>↗</span></button>
          <button className={`hamburger ${menuOpen ? 'open' : ''}`} type="button" aria-label="Menu" onClick={() => setMenuOpen(v => !v)}><span /><span /><span /></button>
        </div>
      </div>
      {menuOpen && <div className="mobile-menu-panel wrap"><a href="#features" onClick={() => setMenuOpen(false)}>Features</a><a href="#showcase" onClick={() => setMenuOpen(false)}>Showcase</a><a href="#plans" onClick={() => setMenuOpen(false)}>Pricing</a><a href="#faq" onClick={() => setMenuOpen(false)}>FAQ</a><a href="#about" onClick={() => setMenuOpen(false)}>About</a><a className="mobile-menu-install" href="/download">Download app</a></div>}
    </header>

    <section className="hero wrap">
      <div className="hero-copy">
        <div className="assistant-pill"><Icon name="sparkle" size={14} /> Your personal AI assistant</div>
        <h1>Nexora<br />More than just<br />an <span>AI assistant.</span></h1>
        <p className="hero-description">Chat, create, plan, and get things done, all in one place. Nexora remembers, thinks, and works with you.</p>
        <div className="hero-actions">
          <button className="button button-primary button-large" type="button" onClick={() => onNavigate('Home', null, 'Nexora Workspace')}>Get started free <span>→</span></button>
          <a className="button button-ghost button-large" href="#features"><span className="play-icon"><Icon name="play" size={13} /></span> See what Nexora can do</a>
          <InstallAppButton />
        </div>
        <p className="hero-note">Works on every browser · Free to start. A paid plan unlocks more magic.</p>
        <div className="social-proof">
          <div className="avatar-stack"><span>J</span><span>M</span><span>A</span><span>S</span><span>K</span></div>
          <p><strong>Join 120K+ curious minds</strong><br /><span>Making space for better ideas</span></p>
        </div>
      </div>
      <div className="hero-art-shell">
        <AssistantArtwork />
      </div>
      <div className="hero-bottom-glow" />
    </section>

    <section className="trust-row wrap" aria-label="Nexora highlights">
      <span>One space for everything</span><i /><span>Built for your flow</span><i /><span>Your ideas stay yours</span><i /><span>All systems operational</span>
    </section>

    <section className="section showcase-section" id="showcase">
      <div className="wrap">
        <div className="section-heading centered-heading">
          <p className="eyebrow">NEXORA COMMAND CENTER</p>
          <h2>Your whole workspace,<br /><span>looks this good.</span></h2>
          <p>Keep scrolling — the Nexora workspace re-skins your entire day. Four real pages, captured inside the app. Pick yours inside the app.</p>
        </div>
        <div className="showcase-mockup">
          <div className="mockup-window">
            <div className="mockup-titlebar"><span /><span /><span /><em>Nexora — {SHOWCASE_SHOTS[shotIdx].label}</em></div>
            {/* Real headless captures of the signed-in pages (this very app), so the
               showcase can never drift from the actual UI again. */}
            <div className="mockup-stack" aria-live="off">
              {SHOWCASE_SHOTS.map((shot, i) => <img key={shot.label} className={`mockup-shot${i === shotIdx ? ' is-active' : ''}`} src={shot.src} alt={shot.alt} width="1600" height="900" loading={i === 0 ? 'eager' : 'lazy'} />)}
            </div>
          </div>
          <div className="mockup-chips" role="tablist" aria-label="Workspace pages">{SHOWCASE_SHOTS.map((shot, i) => <button role="tab" type="button" key={shot.label} aria-selected={i === shotIdx} className={`mockup-chip-btn${i === shotIdx ? ' active' : ''}`} onClick={() => setShotIdx(i)}>{shot.label}</button>)}</div>
        </div>
      </div>
    </section>

    <section className="section features-section" id="features">
      <div className="wrap">
        <div className="section-heading">
          <p className="eyebrow">MORE FLOW, LESS FRICTION</p>
          <h2>One assistant.<br /><span>A hundred possibilities.</span></h2>
          <p>From the first rough thought to the finished thing, Nexora helps you move with momentum.</p>
        </div>
        <div className="feature-grid">
          {[
            { k: 'chat', icon: 'sparkle', tint: '', kicker: 'THINK TOGETHER', title: 'A chat that gets you', desc: 'Ask the big question, untangle a tricky thought, or just get started. Your assistant keeps the context.', cta: true },
            { k: 'create', icon: 'image', tint: 'cyan', kicker: 'MAKE IT REAL', title: 'Create without limits', desc: 'Turn a blank page into images, writing, code, plans, and polished work you can share.', orb: true },
            { k: 'unified', icon: 'memory', tint: 'pink', kicker: 'STAY IN YOUR FLOW', title: 'Everything in one place', desc: 'Your favorite tools, files, and conversations live together, ready whenever you are.', pills: true },
          ].map((f) => <article key={f.k} className={`feature-card feature-card-${f.k}`}>
            <div className={`feature-icon ${f.tint ? `icon-${f.tint}` : ''}`}><Icon name={f.icon} size={22} /></div>
            <span className="card-kicker">{f.kicker}</span>
            <h3>{f.title}</h3>
            <p>{f.desc}</p>
            {f.cta && <a href="#features" onClick={(e) => { e.preventDefault(); onNavigate('Chat', null, 'Conversational AI') }}>Start a conversation <span>↗</span></a>}
            {f.k === 'chat' && <div className="mini-chat"><span className="mini-avatar">N</span><p>What are you thinking about today?<b><Icon name="sparkle" size={12} /></b></p></div>}
            {f.orb && <div className="create-orb"><span><Icon name="sparkle" size={18} /></span><i /><i /><i /></div>}
            {f.pills && <div className="tool-pills"><span>Chat</span><span>Write</span><span>Plan</span><span>+ more</span></div>}
          </article>)}
        </div>

        <ul className="feature-list">
          {featureList.map(([icon, title, desc], i) => {
            const targetView = title === 'Conversational AI' ? 'Chat' : title === 'Creative Studio' ? 'Tools' : title === 'Unified Memory' ? 'Memory' : 'Tools'
            const targetTool = title === 'Creative Studio' ? 'Image Generator' : null
            return (
              <li
                key={title}
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
                onClick={() => onNavigate(targetView, targetTool, title)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onNavigate(targetView, targetTool, title)}
              >
                <span className={`fl-icon fl-${i}`}><Icon name={icon} size={20} /></span>
                <div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
                <em><Icon name="external" size={14} /></em>
              </li>
            )
          })}
        </ul>
      </div>
    </section>

    <section className="section tools-section" id="about">
      <div className="wrap tools-layout">
        <div className="section-heading tools-heading">
          <p className="eyebrow">A LITTLE MAGIC, A LOT OF USEFUL</p>
          <h2>Your next idea<br />starts <span>right here.</span></h2>
          <p>Pick a tool and jump in. No setup spiral, no tab maze, just a clear path from “what if” to “done.”</p>
          <button className="button button-primary button-large" type="button" onClick={() => onNavigate('Tools', null, 'All Tools')}>Explore all tools <span>→</span></button>
        </div>
        <div className="tool-showcase">
          {tools.slice(0, 4).map(([icon, title, description, tint]) => <button className={`showcase-tool tint-${tint}`} key={title} type="button" onClick={() => onNavigate('Tools', title, title)}><span className="showcase-icon"><Icon name={icon} size={18} /></span><span><strong>{title}</strong><small>{description}</small></span><b><Icon name="external" size={14} /></b></button>)}
          <div className="showcase-note"><Icon name="sparkle" size={14} /> Your next favorite tool is one click away</div>
        </div>
      </div>
    </section>

    <section className="section testimonials-section">
      <div className="wrap">
        <div className="section-heading centered-heading">
          <p className="eyebrow">LOVED BY CURIOUS MINDS</p>
          <h2>Real people.<br /><span>Real words, real wins.</span></h2>
          <p>Bohat se logon ne apna workflow Nexora ke saath shift kar diya — here’s what they have to say.</p>
        </div>
        <div className="testimonials-grid">
          {testimonials.map((t, i) => <article key={`${t.name}-${i}`} className={`testimonial-card ${i === 1 || i === 4 ? 'alt' : ''}`}>
            <header>
              <div className={`t-avatar t-${(i % 6)}`}>{t.initials}</div>
              <div>
                <h4>{t.name}</h4>
                <small>Verified User · {t.platform || 'Community'}</small>
              </div>
              <span className="t-source">{t.platform || 'Verified'}</span>
            </header>
            <p>“ {t.quote} ”</p>
          </article>)}
        </div>
      </div>
    </section>

    <section className="section plans-section" id="plans">
      <div className="wrap plans-wrap">
        <div className="section-heading">
          <p className="eyebrow">ROOM TO GROW</p>
          <h2>Start curious.<br /><span>Stay for the possibilities.</span></h2>
          <p>Make yourself at home. There’s a Nexora plan for every kind of day.</p>
          <p className="plans-note"><Icon name="sparkle" size={14} /> Bring your own vibe, or unlock Nexora Pro for a lot more magic.</p>
        </div>
        <div className="plan-grid">
          {PLANS.map((p) => <article key={p.name} className={`plan-card ${p.feat ? 'plan-featured' : ''}`}>
            {p.feat && <span className="popular-label">MOST LOVED</span>}
            <span className="plan-label">{p.label}</span>
            <h3>{p.name}</h3>
            <p className="plan-price">{p.price} <small>{p.sub}</small></p>
            <p className="plan-description">{p.desc}</p>
            <ul>{p.items.map(it => <li key={it}><Icon name="sparkle" size={13} /> {it}</li>)}</ul>
            {/* Logged-in → shared pricing modal. Logged-out → sign-in wall carrying
                THIS plan's own name, so "Get Pro" never inherits a previous CTA's label. */}
            <button className={`button button-${p.tint} button-wide`} type="button" onClick={() => (isLoggedIn && onUpgrade ? onUpgrade() : onNavigate('Home', null, `${p.name} Plan`))}>{p.cta} <span>→</span></button>
          </article>)}
        </div>
      </div>
    </section>

    <section className="section faq-section" id="faq">
      <div className="wrap faq-wrap">
        <div className="section-heading">
          <p className="eyebrow">FREQUENTLY ASKED</p>
          <h2>Quick answers,<br /><span>to common questions.</span></h2>
          <p>Agar aapka sawal yahan nahi mila — hamesha ke liye pooch sakte hain, Nexora khud guide karega.</p>
        </div>
        <ul className="faq-list">
          {faqs.map((f, i) => (
            <li key={f.q} className={`faq-item ${openFaq === i ? 'open' : ''}`}>
              <button type="button" className="faq-q" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpenFaq((prev) => (prev === i ? -1 : i)); }}>
                <span>Q{i + 1}.</span>
                <strong>{f.q}</strong>
                <em>{openFaq === i ? '−' : '+'}</em>
              </button>
              <div className="faq-a"><p>{f.a}</p></div>
            </li>
          ))}
        </ul>
      </div>
    </section>

    <section className="closing-cta wrap">
      <div className="cta-spark"><Icon name="sparkle" size={22} /></div>
      <p className="eyebrow">YOUR NEXT CHAPTER STARTS SMALL</p>
      <h2>Good ideas are better<br />when they <span>have room.</span></h2>
      <p>Bring your curiosity. We’ll bring the tools.</p>
      <div className="closing-actions">
        <button className="button button-primary button-large" type="button" onClick={() => onNavigate('Home', null, 'Nexora Workspace')}>Meet your new assistant <span>→</span></button>
        <a className="button button-outline button-large" href="#faq">Still have questions?</a>
      </div>
    </section>

    <footer className="site-footer-giant">
      <div className="wrap footer-cta-banner">
        <div>
          <h2>Your workspace is waiting.</h2>
          <p>Start free, then pick a plan whenever you like. Cancel whenever you like.</p>
        </div>
        <div className="footer-cta-actions">
          <button className="button button-primary button-large" type="button" onClick={() => onNavigate('Home', null, 'Nexora Workspace')}>Launch Nexora <span>↗</span></button>
          <a className="button button-outline button-large" href="#plans">View Pricing</a>
        </div>
      </div>
      <div className="wrap footer-grid">
        <div className="footer-brand-col">
          <Brand />
          <p className="footer-tag">More room for what's next.</p>
          <p className="footer-about">The unified AI workspace for curious minds. Turn an ordinary session into a flow that listens, moves, and feels alive — the kind you’ve only daydreamed about.</p>
          <div className="footer-socials">
            <a href="#" aria-label="WhatsApp" title="WhatsApp"><Icon name="whatsapp" size={18} /></a>
            <a href="#" aria-label="Email" title="Email"><Icon name="mail" size={18} /></a>
            <a href="#" aria-label="GitHub" title="GitHub"><Icon name="code" size={18} /></a>
            <a href="#" aria-label="YouTube" title="YouTube"><Icon name="youtube" size={18} /></a>
            <a href="#" aria-label="X" title="X"><Icon name="cross" size={15} /></a>
          </div>
        </div>
        {[
          { title: 'Product', links: [['Overview', '#home'], ['Features', '#features'], ['Showcase', '#showcase'], ['Pricing', '#plans'], ['Releases', '#home'], ['Reviews', '#home']] },
          { title: 'Features', links: [['Chat', '#home'], ['Image Generator', '#home'], ['Code Assistant', '#home'], ['PDF Reader', '#home'], ['YouTube Notes', '#home'], ['Meeting Notes', '#home']] },
          { title: 'Resources', links: [['Use Cases', '#home'], ['Compare', '#home'], ['Guide', '#home'], ['FAQ', '#faq'], ['Urdu / Hindi', '#home'], ['Blog', '#home']] },
          { title: 'Company', links: [['About', '#about'], ['Tools', '#home'], ['Workspace', '#home'], ['Plans', '#plans'], ['Contact', '#home'], ['Support', '#home']] },
          { title: 'Legal', links: [['Terms', '#home'], ['Privacy', '#home'], ['Refund', '#home'], ['Delivery', '#home'], ['Licence', '#home']] },
        ].map(col => <div key={col.title} className="footer-col">
          <h4>{col.title}</h4>
          <ul>{col.links.map(([label, href]) => <li key={label}><a href={href}>{label}</a></li>)}</ul>
        </div>)}
      </div>
      <div className="wrap footer-bottom">
        <span>© {CURRENT_YEAR} Nexora. Made for curious minds.</span>
        <span className="footer-status"><i /> All systems operational</span>
      </div>
    </footer>

  </main>
}

/* Render a chat turn: markdown images become a clickable <ChatImage> (lightbox +
   download), fenced ``` code becomes a <CodeBlock> with a copy button, and
   everything else stays plain text. The backend emits ![cap](https://…image…)
   for detected image requests and the model's fallback uses ![cap](IMAGE:desc),
   which we resolve to the same keyless provider here — and refuse if adult. */
/* A fenced block ends at its closing ``` OR at end-of-string, so a truncated or
   still-streaming reply (model never emitted the closing fence) still renders as
   a real code block with a copy button instead of leaking raw ``` markup. */
const BLOCK_RE = /(```[^\n]*\n?[\s\S]*?(?:```|$)|!\[[^\]]*\]\([^)]+\)|\[SCREENSHOT:[a-z]+\])/g
const IMAGE_TOKEN_RE = /!\[[^\]]*\]\(([^)]+)\)/
/* Mirror of the backend NSFW gate so a model-authored IMAGE: marker can't slip an
   adult picture past the client either. */
const CLIENT_NSFW = /(nude|naked|nsfw|porn|sex|sexy|erotic|xxx|boob|tit|penis|vagina|breast|nipple|anal|blowjob|orgasm|bikini|lingerie|topless|see[\s-]?through|onlyfans|hentai|chudai|chod|nangi|nanga|jism|shahwat|فحش|ننگی)/i

/* --- Self-screenshots ---------------------------------------------------------
   The assistant emits [SCREENSHOT:face] (etc.) and the app answers with a REAL
   photograph of itself, captured by src/selfCapture.js. The token stays in the
   stored reply — it is what she wrote — so it renders as this caption, and the
   picture rides on the turn's images array. Mirrors the backend's isSelfUiRequest
   on purpose: the same phrase must read the same way on both sides. */
const SHOT_TOKEN_RE = /^\[SCREENSHOT:([a-z]+)\]$/i
const SHOT_TARGETS = {
  face: { face: true },
  screen: { full: true },
  chat: {},
  settings: { view: 'Settings' },
  memory: { view: 'Memory' },
}
const SHOT_LABELS = {
  face: '📸 A real screenshot of my own face',
  settings: '📸 A real screenshot of my settings',
  memory: '📸 A real screenshot of my saved memories',
  screen: '📸 A real screenshot of my screen right now',
  chat: '📸 A real screenshot of this chat',
}
const SELF_OWNER_RE = /\b(apna|apni|apne|apsa|tumhara|tumhari|tumhare|tumhare|tera|teri|terey|teree|aapka|aapki|aapke|your|yours|self|khud|khud|apni\s?hi)\b/i
const SELF_UI_RE = /\b(chehra|chehry|chehray|shakal|soorat|surat|face|avatar|profile\s?pic|dp|setting|settings|screen|screenshot|ui|interface|page|memory|memories|yaadein|yaaden|roop|look|appearance|tasveer|image|picture)\b/i

/* The marker is machine markup, not prose: it renders as a caption chip inside the
   reply, but must never leak into a quote preview or the text sent back to the model. */
const withoutShotMarkers = (text) => String(text || '').replace(/\s*\[SCREENSHOT:[a-z]+\]/gi, '').trim()

/* When she forgets the marker, the app still has to know WHAT to photograph. */
function selfUiTargets(text) {
  const t = String(text || '').toLowerCase()
  const out = []
  if (/chehra|chehr|shakal|soorat|surat|face|avatar|roop|appearance|\bdp\b/.test(t)) out.push('face')
  if (/setting/.test(t)) out.push('settings')
  if (/memor|yaadein|yaaden/.test(t)) out.push('memory')
  if (!out.length && /screen|screenshot|\bui\b|interface|page/.test(t)) out.push('screen')
  if (!out.length) out.push('face')
  return out.slice(0, 2)
}

/* Inline markdown → React nodes (auto-escaped, no dangerouslySetInnerHTML). Handles
   `code`, **bold**, __bold__, *italic*, _italic_ and [label](http…) links. Only
   http/https/mailto URLs become anchors, so a javascript: payload stays literal. */
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^\s)]+\))/g
function renderInline(text, base) {
  if (!text) return []
  const out = []
  let last = 0
  let n = 0
  let m
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${base}-i${n++}`
    if (tok[0] === '`') {
      out.push(<code key={key} className="chat-inline-code">{tok.slice(1, -1)}</code>)
    } else if (tok[0] === '[') {
      const g = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(tok)
      const url = g ? g[2] : ''
      if (g && /^(https?:|mailto:)/i.test(url)) out.push(<a key={key} href={url} target="_blank" rel="noopener noreferrer">{g[1]}</a>)
      else out.push(tok)
    } else {
      const dbl = tok[0] === '*' ? tok[1] === '*' : tok[1] === '_'
      out.push(dbl ? <strong key={key}>{tok.slice(2, -2)}</strong> : <em key={key}>{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/* Block markdown → paragraphs, # headings, - / * / • bullets, 1. numbered lists and
   > quotes. A single newline inside a paragraph becomes <br>; a blank line splits
   paragraphs. Code fences + images are already lifted out by renderChatContent. */
const MD_H = /^(#{1,6})\s+(.*)$/
const MD_UL = /^\s*[-*•]\s+(.*)$/
const MD_OL = /^\s*\d+[.)]\s+(.*)$/
const MD_BQ = /^\s*>\s?(.*)$/
function renderMarkdown(text, base = 'md') {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let k = 0
  let para = []
  const flush = () => {
    if (!para.length) return
    const key = `${base}-p${k++}`
    const nodes = []
    para.forEach((ln, idx) => {
      if (idx) nodes.push(<br key={`${key}-br${idx}`} />)
      nodes.push(...renderInline(ln, `${key}-${idx}`))
    })
    blocks.push(<p key={key} className="chat-para">{nodes}</p>)
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { flush(); i++; continue }
    let m
    if ((m = MD_H.exec(line))) {
      flush()
      const key = `${base}-h${k++}`
      blocks.push(<div key={key} className={`chat-h chat-h${Math.min(m[1].length, 4)}`}>{renderInline(m[2].trim(), key)}</div>)
      i++
      continue
    }
    if (MD_UL.test(line)) {
      flush()
      const key = `${base}-ul${k++}`
      const items = []
      let mm
      while (i < lines.length && (mm = MD_UL.exec(lines[i]))) { items.push(mm[1]); i++ }
      blocks.push(<ul key={key} className="chat-list">{items.map((it, idx) => <li key={`${key}-${idx}`}>{renderInline(it, `${key}-${idx}`)}</li>)}</ul>)
      continue
    }
    if (MD_OL.test(line)) {
      flush()
      const key = `${base}-ol${k++}`
      const items = []
      let mm
      while (i < lines.length && (mm = MD_OL.exec(lines[i]))) { items.push(mm[1]); i++ }
      blocks.push(<ol key={key} className="chat-list">{items.map((it, idx) => <li key={`${key}-${idx}`}>{renderInline(it, `${key}-${idx}`)}</li>)}</ol>)
      continue
    }
    if (MD_BQ.test(line)) {
      flush()
      const key = `${base}-bq${k++}`
      const items = []
      let mm
      while (i < lines.length && (mm = MD_BQ.exec(lines[i]))) { items.push(mm[1]); i++ }
      blocks.push(<blockquote key={key} className="chat-quote">{renderInline(items.join(' '), key)}</blockquote>)
      continue
    }
    para.push(line)
    i++
  }
  flush()
  return blocks
}

function renderChatContent(text) {
  if (!text) return text
  const nodes = []
  let last = 0
  let n = 0
  let t = 0
  let match
  BLOCK_RE.lastIndex = 0
  while ((match = BLOCK_RE.exec(text))) {
    if (match.index > last) {
      const seg = text.slice(last, match.index).replace(/^\n+/, '').replace(/\n+$/, '')
      if (seg) nodes.push(...renderMarkdown(seg, `t${t++}`))
    }
    const token = match[0]
    const shot = SHOT_TOKEN_RE.exec(token.trim())
    if (token.startsWith('```')) {
      /* Only strip a closing fence when one was actually emitted. */
      const inner = token.endsWith('```') ? token.slice(3, -3) : token.slice(3)
      const nl = inner.indexOf('\n')
      const lang = nl >= 0 ? inner.slice(0, nl).trim().split(/\s+/)[0] : ''
      const code = (nl >= 0 ? inner.slice(nl + 1) : inner).replace(/\n+$/, '')
      nodes.push(<CodeBlock key={`code-${n++}`} lang={lang} code={code} />)
    } else if (shot) {
      nodes.push(<div key={`shot-${n++}`} className="chat-shot-caption">{SHOT_LABELS[shot[1].toLowerCase()] || SHOT_LABELS.screen}</div>)
    } else {
      const m = IMAGE_TOKEN_RE.exec(token)
      const url = (m ? m[1] : '').trim()
      if (url.startsWith('IMAGE:')) {
        const desc = url.slice(6).trim()
        nodes.push(CLIENT_NSFW.test(desc)
          ? <span key={`blk-${n++}`} className="chat-img-blocked"><Icon name="warn" size={14} /> Adult content is not allowed on Nexora.</span>
          : <ChatImage key={`img-${n++}`} src={resourceUrl(`/api/images/generate?prompt=${encodeURIComponent(desc)}`)} />)
      } else if (url) {
        nodes.push(<ChatImage key={`img-${n++}`} src={resourceUrl(url)} />)
      }
    }
    last = match.index + token.length
  }
  if (last < text.length) {
    const tail = text.slice(last)
    if (tail.trim()) nodes.push(...renderMarkdown(tail, `t${t++}`))
  }
  return nodes
}

/* A fenced code block with a language tag and a copy-to-clipboard button. */
function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      /* Older/insecure contexts block the async API — fall back to a temp field. */
      const ta = document.createElement('textarea')
      ta.value = code
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="chat-code">
      <div className="chat-code-bar">
        <span className="chat-code-lang">{lang || 'code'}</span>
        <button type="button" className="chat-code-copy" onClick={copy}>{copied ? <><Icon name="check" size={13} /> Copied!</> : <><Icon name="copy" size={13} /> Copy code</>}</button>
      </div>
      <pre className="chat-code-pre"><code>{code}</code></pre>
    </div>
  )
}

/* A generated image with a loading state, a click-to-open lightbox and a
   download button. The provider sheds free-tier traffic with a 402/503 whose
   BODY is still a valid "at its limit" JPEG — a plain <img> would happily render
   that as a success (the bug behind a fake "Here's your image"). So we load via
   fetch, trust the HTTP STATUS, auto-retry through the busy windows, and only
   ever paint a real image (from an object URL) or an honest, tappable error. */
function ChatImage({ src, alt = 'Generated image' }) {
  const [nonce, setNonce] = useState(0)
  const [status, setStatus] = useState('loading')
  const [attempt, setAttempt] = useState(0)
  const [objUrl, setObjUrl] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    let created = ''
    const ctrl = new AbortController()
    const MAX = 6
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    /* A manual retry bumps `nonce` so the request bypasses any cached 302/error. */
    const url = nonce ? `${src}${src.includes('?') ? '&' : '?'}r=${nonce}` : src
    ;(async () => {
      await sleep(0) /* defer off the effect's synchronous path so no setState lands during setup */
      for (let i = 1; i <= MAX; i++) {
        if (!alive) return
        setAttempt(i)
        try {
          const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
          const ctype = res.headers.get('content-type') || ''
          if (res.ok && ctype.startsWith('image/')) {
            const blob = await res.blob()
            if (!alive) return
            created = URL.createObjectURL(blob)
            setObjUrl(created); setStatus('ready'); return
          }
          /* Non-ok (402/429/503) = the provider's limit wall, not a real image.
             Honour Retry-After, else back off, and try again. */
          const ra = Number(res.headers.get('retry-after'))
          if (i < MAX) await sleep(Math.min(15000, ra > 0 ? ra * 1000 : 1500 * i))
        } catch (err) {
          if (!alive || err.name === 'AbortError') return
          if (i < MAX) await sleep(1500 * i)
        }
      }
      if (alive) setStatus('error')
    })()
    return () => { alive = false; ctrl.abort(); if (created) URL.revokeObjectURL(created) }
  }, [src, nonce])

  const download = () => {
    if (!objUrl) return
    const m = /[?&]prompt=([^&]+)/.exec(src) || /\/prompt\/([^?]+)/.exec(src)
    const base = m ? decodeURIComponent(m[1]).slice(0, 40).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() : ''
    const a = document.createElement('a')
    a.href = objUrl
    a.download = `${base || 'nexora-image'}.jpg`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <span className={`chat-img${status === 'ready' ? ' is-ready' : ''}`}>
      {status !== 'ready' && (
        <span className="chat-img-ph" role="status" aria-live="polite">
          {status === 'error'
            ? <button type="button" onClick={() => { setStatus('loading'); setObjUrl(''); setAttempt(0); setNonce((v) => v + 1) }}><Icon name="warn" size={14} /> The image service is busy — tap to try again</button>
            : <><span className="chat-img-spin" aria-hidden="true" />{attempt > 1 ? `Image service is busy — retrying (${attempt}/6)…` : 'Generating image…'}</>}
        </span>
      )}
      {status === 'ready' && objUrl && (
        <img className="chat-inline-image" src={objUrl} alt={alt} onClick={() => setOpen(true)} />
      )}
      {status === 'ready' && <span className="chat-img-hint" aria-hidden="true"><Icon name="search" size={13} /> Click to view</span>}
      {open && createPortal(
        <div className="chat-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setOpen(false)}>
          <div className="chat-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <img src={objUrl} alt={alt} className="chat-lightbox-img" />
            <div className="chat-lightbox-actions">
              <button type="button" className="chat-lightbox-btn primary" onClick={download}><Icon name="download" size={14} /> Download</button>
              <button type="button" className="chat-lightbox-btn" onClick={() => setOpen(false)}><Icon name="cross" size={13} /> Close</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}

/* The direct-tool-runner used to live here. It is gone: the Tools grid now
   sends the user into a Chat conversation titled after the tool via
   `startToolSession`, where Aira opens with a professional prompt asking for
   the exact references that tool needs. That keeps one mental model — every
   "do something for me" action is a chat turn — and reuses the streaming,
   image-rendering, reply-to and memory-injection plumbing of the main
   composer instead of maintaining a parallel form. */

/* The action catalog the Desktop view offers — mirrors desktop-agent/src/allowlist.js.
   It is a convenience, not a permission: the agent re-validates every request
   against the real allowlist and its own default-deny gate, so a stale entry here
   can only produce a rejected preview, never an action the agent would allow. */
const desktopActions = [
  { id: 'browser.open', scope: 'browser', risk: 'low', example: { url: 'https://example.com' } },
  { id: 'browser.search', scope: 'browser', risk: 'low', example: { engine: 'google', query: 'nexora docs' } },
  { id: 'browser.snapshot', scope: 'browser', risk: 'low', example: { maxChars: 4000 } },
  { id: 'browser.click', scope: 'browser', risk: 'medium', example: { selector: 'button', by: 'css' } },
  { id: 'browser.fill', scope: 'browser', risk: 'medium', example: { selector: 'input[name=q]', value: 'hello', by: 'css' } },
  { id: 'browser.submit', scope: 'browser', risk: 'high', confirm: true, example: { selector: 'button[type=submit]', by: 'css' } },
  { id: 'browser.screenshot', scope: 'browser', risk: 'low', example: { name: 'nexora-shot' } },
  { id: 'apps.launch', scope: 'apps', risk: 'medium', example: { appId: 'chrome' } },
  { id: 'apps.close', scope: 'apps', risk: 'medium', example: { appId: 'chrome' } },
  { id: 'files.list', scope: 'files', risk: 'low', example: { dir: 'C:\\Nexora Sandbox' } },
  { id: 'files.read', scope: 'files', risk: 'low', example: { path: 'C:\\Nexora Sandbox\\build.log' } },
  { id: 'files.write', scope: 'files', risk: 'high', confirm: true, example: { path: 'C:\\Nexora Sandbox\\notes.txt', content: 'Created by Nexora.' } },
  { id: 'files.organize', scope: 'files', risk: 'high', confirm: true, example: { dir: 'C:\\Nexora Sandbox', strategy: 'by-extension', apply: false } },
  { id: 'system.info', scope: 'system', risk: 'low', example: {} },
  { id: 'system.restart', scope: 'system', risk: 'high', confirm: true, example: {} },
  { id: 'system.shutdown', scope: 'system', risk: 'high', confirm: true, example: {} },
  { id: 'system.runCommand', scope: 'system', risk: 'high', confirm: true, example: { command: 'ipconfig' } },
  { id: 'screen.capture', scope: 'screen', risk: 'low', example: { save: false } },
  { id: 'desktop.move', scope: 'desktop', risk: 'medium', example: { x: 400, y: 300 } },
  { id: 'desktop.click', scope: 'desktop', risk: 'medium', example: { x: 400, y: 300, button: 'left' } },
  { id: 'desktop.scroll', scope: 'desktop', risk: 'medium', example: { direction: 'down', amount: 3 } },
  { id: 'desktop.type', scope: 'desktop', risk: 'high', confirm: true, example: { text: 'hello from Aira' } },
  { id: 'desktop.key', scope: 'desktop', risk: 'medium', confirm: true, example: { combo: 'ctrl+c' } },
]
const desktopScopes = [['browser', 'globe', 'Drive the dedicated automation browser (not your personal profile)'], ['files', 'folder', 'Read / organize inside folders you approve'], ['apps', 'desktop', 'Launch & close approved apps only'], ['system', 'settings', 'Read-only info; power needs per-action confirm, never from voice'], ['screen', 'eye', 'Let Aira look at your screen to describe it (nothing is saved unless you ask)'], ['desktop', 'mouse', 'Move / click / scroll / type / key on your PC — every action needs your approval, typing needs a fresh confirm each time']]

/* Aira acting on the local Windows PC through the hardened desktop agent.
   Real connection only: if the backend bridge is disabled or the agent isn't
   running we say so and block the controls — we never simulate a success. Every
   request follows plan → visible preview → (scope +, for high-risk, an explicit
   approve) → execute, exactly mirroring the agent's two-step gate. */
/* The page's own origin, read once at import time (never during render — a `window`
   read in render breaks React purity). Shown in the connect card so the user knows
   exactly what to add to the agent's AGENT_ALLOWED_ORIGINS. */
const AGENT_SELF_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''
function DesktopView({ token, aiName, isLoggedIn, onLogin }) {
  const [tab, setTab] = useState('run')
  const [health, setHealth] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [command, setCommand] = useState('')
  const [actionId, setActionId] = useState('browser.search')
  const [argsText, setArgsText] = useState(() => JSON.stringify(desktopActions.find((a) => a.id === 'browser.search').example, null, 2))
  const [plan, setPlan] = useState(null)
  const [clarify, setClarify] = useState('')
  const [result, setResult] = useState(null)
  const [perms, setPerms] = useState(null)
  const [apps, setApps] = useState(null)
  const [dirDraft, setDirDraft] = useState('')
  const [appDraft, setAppDraft] = useState('')
  const [hostDraft, setHostDraft] = useState('')
  const [audit, setAudit] = useState(null)
  const [screen, setScreen] = useState(null)   // ephemeral preview: { dataUrl, width, height, saved }
  const [report, setReport] = useState('')      // Aira's visual-inspection text
  /* Cloud web app + local agent: `paired` mirrors whether this browser holds a client
     token (read in an effect / after pair+revoke, never at render — a localStorage read
     in render would break React purity). `pairStatus`/`pairErr` come from probing
     /pair/status so the connect card can tell "start the agent" from "allowlist this Origin". */
  const [paired, setPaired] = useState(() => hasPairedAgent())
  const [pairStatus, setPairStatus] = useState(null)
  const [pairErr, setPairErr] = useState('')
  const [pairCode, setPairCode] = useState('')

  /* One dispatcher chosen by transport: a paired browser drives its OWN agent directly;
     otherwise the call goes through the authenticated backend proxy (self-host /
     local-first, where the backend and the agent share the machine). */
  const api = {
    grant: (p) => (paired ? agentGrant(p) : desktopGrant(token, p)),
    revokePerm: (p) => (paired ? agentRevokePermission(p) : desktopRevoke(token, p)),
    plan: (p) => (paired ? agentPlan(p) : desktopPlan(token, p)),
    execute: (p) => (paired ? agentExecute(p) : desktopExecute(token, p)),
    permissions: () => (paired ? agentPermissions() : desktopPermissions(token)),
    apps: () => (paired ? agentApps() : desktopApps(token)),
    audit: (l) => (paired ? agentAudit(l) : desktopAudit(token, l)),
    stop: () => (paired ? agentStop() : desktopStop(token)),
  }

  // A direct-agent health probe is `{ ok, status:'ok' }`; the backend proxy is `{ enabled }`.
  const proxyEnabled = health?.enabled === true
  const directEnabled = Boolean(health && (health.status === 'ok' || health.ok))
  const enabled = paired ? directEnabled : proxyEnabled
  const desktopArmed = enabled && Boolean(perms?.scopes?.desktop || perms?.scopes?.screen)

  useEffect(() => {
    if (!isLoggedIn || !token) return
    let alive = true
    const h = paired ? agentHealth() : desktopHealth(token)
    h.then((r) => { if (alive) setHealth(r) }).catch((err) => { if (alive) setHealth(paired ? { status: 'down', ok: false, error: { message: err.message } } : { enabled: false, error: { message: err.message } }) })
    // Load the permission posture up front too, so the "control armed" banner is
    // accurate the moment the page opens, not only after visiting Permissions.
    const p = paired ? agentPermissions() : desktopPermissions(token)
    p.then((r) => { if (alive) setPerms(r) }).catch(() => {})
    return () => { alive = false }
  }, [isLoggedIn, token, paired])

  /* Nothing connected yet: probe the LOCAL agent so the connect card can offer a live
     code field when it is reachable, or install/run steps when it is not. */
  useEffect(() => {
    if (paired || !isLoggedIn) return
    let alive = true
    agentPairStatus().then((s) => { if (alive) { setPairStatus(s); setPairErr('') } }).catch((err) => { if (alive) { setPairStatus(null); setPairErr(err.message) } })
    return () => { alive = false }
  }, [paired, isLoggedIn])

  async function doPair() {
    const code = pairCode.trim()
    if (code.length !== 6) { setPairErr('Enter the 6-digit code shown in the Nexora Agent console.'); return }
    setBusy('pairing'); setPairErr('')
    try {
      await agentPair(code, token)
      setPaired(true); setPairCode(''); setPairStatus(null); setNotice(`🔗 Paired — ${aiName} can now drive this PC's browser.`)
    } catch (err) { setPairErr(err.message) } finally { setBusy('') }
  }

  async function doRevokeThisPc() {
    setBusy('revoking'); setError('')
    try { await agentRevoke(); setPaired(false); setHealth(null); setPerms(null); setNotice('This browser is unpaired from your PC.') }
    catch (err) { setError(err.message) } finally { setBusy('') }
  }

  function refreshPermissions() {
    if (!isLoggedIn || !token) return
    api.permissions().then(setPerms).catch((err) => setError(err.message))
    api.apps().then((r) => setApps(r.data || [])).catch(() => {})
  }
  function refreshAudit() {
    if (!isLoggedIn || !token) return
    api.audit().then((r) => setAudit(r.data || [])).catch((err) => setError(err.message))
  }
  function goTab(next) {
    setTab(next); setError(''); setNotice('')
    if (next === 'permissions') refreshPermissions()
    if (next === 'audit') refreshAudit()
  }

  function pickAction(id) {
    setActionId(id)
    const a = desktopActions.find((x) => x.id === id)
    if (a) setArgsText(JSON.stringify(a.example, null, 2))
  }

  async function runIntent() {
    const text = command.trim()
    if (!text) return
    if (!isLoggedIn || !token) { onLogin(); return }
    setBusy('planning'); setError(''); setNotice(''); setResult(null); setClarify(''); setPlan(null)
    try {
      const res = await desktopIntent(token, { utterance: text, fromVoice: false, assistantName: aiName })
      if (res.kind === 'plan') setPlan(res.plan)
      else setClarify(res.clarify || 'I could not turn that into one safe action — try being more specific.')
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }

  async function planManual() {
    if (!isLoggedIn || !token) { onLogin(); return }
    let args
    try { args = argsText.trim() ? JSON.parse(argsText) : {} } catch { setError('Arguments must be valid JSON.'); return }
    setBusy('planning'); setError(''); setNotice(''); setResult(null); setClarify(''); setPlan(null)
    try {
      const p = await api.plan({ action: actionId, args, context: { fromVoice: false } })
      setPlan(p)
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }

  async function approveAndRun() {
    if (!plan || !plan.planId) return
    if (!isLoggedIn || !token) { onLogin(); return }
    setBusy('running'); setError(''); setNotice('')
    try {
      const r = await api.execute({ planId: plan.planId, approvedThisAction: true })
      setResult(r); setPlan(null)
      if (r.ok === false) setError(r.reason || `Blocked by the agent (${r.status}).`)
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }

  const doStop = useCallback(async () => {
    if (!isLoggedIn || !token) return
    setBusy('stopping'); setError('')
    try { const r = paired ? await agentStop() : await desktopStop(token); setNotice(`🛑 Stop sent — ${r.cancelled ?? 0} running action(s) cancelled.`) }
    catch (err) { setError(err.message) } finally { setBusy('') }
  }, [isLoggedIn, token, paired])

  async function mutatePerms(fn, label, after) {
    if (!isLoggedIn || !token) { onLogin(); return }
    setBusy(label); setError(''); setNotice('')
    try { const r = await fn(); if (r.permissions) setPerms(r.permissions); setNotice(`${label} ✓`); if (after) after() }
    catch (err) { setError(err.message) } finally { setBusy('') }
  }

  /* Screen observation. Both go through the agent's permission gate; a 403 (no
     "screen" scope) or a 503 (bridge off) throws through parseJson with the real
     reason, which lands in `error`. The capture itself is ephemeral — the data URL
     is only ever shown to this user, and /inspect returns just the text report. */
  async function doCapture() {
    if (!isLoggedIn || !token) { onLogin(); return }
    setBusy('screen'); setError(''); setNotice(''); setReport('')
    try { const r = await desktopScreenCapture(token); setScreen({ dataUrl: r.dataUrl, width: r.width, height: r.height, saved: r.saved }); setNotice('👁 Screen captured — shown to you only, nothing written to disk.') }
    catch (err) { setError(err.message) } finally { setBusy('') }
  }

  async function doInspect() {
    if (!isLoggedIn || !token) { onLogin(); return }
    setBusy('inspecting'); setError(''); setNotice(''); setReport('')
    try { const r = await desktopScreenInspect(token, { assistantName: aiName }); setReport(r.report); setScreen((s) => s || { width: r.width, height: r.height }); setNotice(`✨ ${aiName} looked at your screen (${r.width}×${r.height}) — only the text report came back.`) }
    catch (err) { setError(err.message) } finally { setBusy('') }
  }

  function clearScreen() { setScreen(null); setReport('') }

  /* A keyboard e-stop that works wherever focus is while this page is open, so the
     user can halt a running action without hunting for the button. doStop is a stable
     useCallback, so the listener is re-attached only when the login/token changes. */
  useEffect(() => {
    if (!isLoggedIn || !token) return
    const onKey = (event) => { if (event.ctrlKey && event.altKey && (event.key === 's' || event.key === 'S')) { event.preventDefault(); doStop() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isLoggedIn, token, doStop])

  if (!isLoggedIn || !token) {
    return <section className="workspace-page-panel desktop-panel">
      <div className="settings-icon"><Icon name="desktop" size={26} /></div>
      <h2>Desktop actions</h2>
      <p>{aiName} can open apps, browse and organize files on this PC — but only while you're signed in, and only for actions you explicitly approve.</p>
      <button type="button" className="tool-runner-run" onClick={onLogin}>Sign in to connect</button>
    </section>
  }

  return <section className="workspace-page-panel desktop-panel">
    <div className="desktop-head">
      <div><h2>Desktop actions</h2><p>{aiName} proposes an action, you preview and approve it. The agent — not the model — decides what's allowed.</p></div>
      <button type="button" className="desktop-stop" onClick={doStop} disabled={busy === 'stopping'}><Icon name="stop" size={13} /> Stop</button>
    </div>

    <div className={`desktop-status${enabled ? ' is-ok' : ' is-off'}`}>
      {health == null && <span>Checking for the desktop agent on your PC…</span>}
      {paired && enabled && <span><Icon name="dotOn" size={14} /> Connected to your PC (local agent) — {health.bind || '127.0.0.1'} · loopback only, this browser only.</span>}
      {!paired && health && enabled && <span>● Connected — {health.agent?.bind || '127.0.0.1'} · loopback only. Automation browser, approved apps and folders only.</span>}
      {health && !enabled && <span>○ Not connected — {paired ? 'your paired agent is not reachable right now — make sure it is still running on this PC.' : (health.error?.message || 'no local Nexora Agent detected and the backend bridge is off')}.</span>}
      {paired && <button type="button" className="desktop-link danger" onClick={doRevokeThisPc}>Revoke this PC</button>}
    </div>

    {desktopArmed && <div className="desktop-active" role="status"><span><Icon name="dotOn" size={14} /> Desktop control is ARMED — {aiName} can act on this PC, but only with your approval. Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> or Stop to halt what is running.</span>{busy && <strong className="desktop-running">{busy === 'running' ? 'An action is running…' : 'Working…'}</strong>}</div>}

    {!enabled && <div className="desktop-card">
      <div className="settings-icon"><Icon name="link" size={26} /></div>
      <h3>Connect {aiName} to your PC</h3>
      <p className="desktop-muted">{paired ? 'This browser is already paired, but your Nexora Agent is not reachable right now — make sure it is still running on this PC.' : 'Run the Nexora Agent on this computer, then paste the 6-digit pairing code it prints to its console. We confirm your paid Nexora account before the agent hands this browser a token.'}</p>
      {pairStatus && <p className="desktop-notice" role="status"><Icon name="check" size={14} /> Nexora Agent detected and awaiting pairing — enter the code shown in its window.</p>}
      <ol className="desktop-steps">
        <li>Start the agent: <code>cd desktop-agent</code> → <code>npm install</code> → <code>npm run dev:agent</code>.</li>
        <li>Allow this site: set the agent's <code>AGENT_ALLOWED_ORIGINS</code> to <code>{AGENT_SELF_ORIGIN || 'this page origin'}</code> and its <code>NEXORA_BACKEND_URL</code> to your Nexora backend, then restart it.</li>
        <li>Copy the pairing code from the agent console and paste it below.</li>
      </ol>
      <label className="desktop-label" htmlFor="desktop-pair">Pairing code</label>
      <div className="desktop-inline">
        <input id="desktop-pair" className="tool-runner-input desktop-field" type="text" inputMode="numeric" maxLength={6} autoComplete="off" placeholder="6-digit code" value={pairCode} onChange={(event) => setPairCode(event.target.value.replace(/\D/g, '').slice(0, 6))} disabled={busy === 'pairing'} />
        <button type="button" className="tool-runner-run" onClick={doPair} disabled={busy === 'pairing' || pairCode.length !== 6}>{busy === 'pairing' ? 'Connecting…' : 'Connect'}</button>
      </div>
      {pairErr && <div className="tool-runner-error" role="alert"><Icon name="warn" size={14} /> {pairErr}</div>}
    </div>}

    {enabled && <>
    <div className="desktop-tabs">{[['run', 'Run'], ['permissions', 'Permissions'], ['audit', 'Audit log']].map(([id, label]) => <button type="button" key={id} className={`desktop-tab${tab === id ? ' selected' : ''}`} onClick={() => goTab(id)}>{label}</button>)}</div>

    {error && <div className="tool-runner-error" role="alert"><Icon name="warn" size={14} /> {error}</div>}
    {notice && <div className="desktop-notice" role="status">{notice}</div>}

    {tab === 'run' && <div className="desktop-run">
      {!paired && <div className="desktop-card desktop-screen-card">
        <div className="desktop-screen-actions">
          <button type="button" className="tool-runner-run" onClick={doCapture} disabled={busy !== '' || !enabled}><Icon name="eye" size={15} /> Observe Screen</button>
          <button type="button" className="tool-runner-run" onClick={doInspect} disabled={busy !== '' || !enabled}><Icon name="magic" size={15} /> Describe my screen</button>
          <button type="button" className="desktop-link" onClick={() => { pickAction('browser.open'); setNotice('🌐 Inspect Website — set the URL, then Preview → Approve. Use browser.snapshot to read the page and browser.screenshot to capture it.') }}><Icon name="globe" size={15} /> Inspect Website</button>
          {(screen || report) && <button type="button" className="desktop-link danger" onClick={clearScreen}>Clear</button>}
        </div>
        <p className="desktop-muted">Needs the “screen” permission (Permissions tab). The picture is shown to you and sent to {aiName} for this one look — never saved to disk unless you ask to.</p>
        {screen?.dataUrl && <figure className="desktop-shot"><img src={screen.dataUrl} alt={`A screenshot of your screen, ${screen.width} by ${screen.height}`} /><figcaption>{screen.width}×{screen.height}{screen.saved ? ` · saved to ${screen.saved}` : ' · in memory only'}</figcaption></figure>}
        {report && <div className="desktop-report" role="status"><strong>{aiName}’s visual inspection</strong><p>{report}</p></div>}
      </div>}

      {!paired && <div className="desktop-card">
        <label className="desktop-label" htmlFor="desktop-cmd">Ask in plain words</label>
        <textarea id="desktop-cmd" className="tool-runner-input" rows={2} placeholder="e.g. open the automation browser and search for React docs" value={command} onChange={(event) => setCommand(event.target.value)} disabled={busy !== ''} />
        <div className="desktop-row"><button type="button" className="tool-runner-run" onClick={runIntent} disabled={busy !== '' || !command.trim()}>Plan this</button></div>
      </div>}

      <div className="desktop-card">
        <label className="desktop-label" htmlFor="desktop-action">…or build the action directly</label>
        <select id="desktop-action" className="desktop-select" value={actionId} onChange={(event) => pickAction(event.target.value)}>{desktopActions.map((a) => <option key={a.id} value={a.id}>{a.id}{a.confirm ? '  ⚠ confirm' : ''} · {a.scope}</option>)}</select>
        <label className="desktop-label" htmlFor="desktop-args">Arguments (JSON)</label>
        <textarea id="desktop-args" className="tool-runner-input desktop-args" rows={6} value={argsText} onChange={(event) => setArgsText(event.target.value)} spellCheck={false} disabled={busy !== ''} />
        <div className="desktop-row"><button type="button" className="tool-runner-run" onClick={planManual} disabled={busy !== ''}>Preview action</button></div>
      </div>

      {clarify && <div className="desktop-clarify"><Icon name="help" size={14} /> {clarify}</div>}

      {plan && (plan.ok ?
        <div className="desktop-plan">
          <div className="desktop-plan-head"><strong>{plan.action}</strong><span className={`desktop-risk risk-${plan.risk}`}>{plan.risk}</span><span className="desktop-scope-chip">{plan.scope}</span></div>
          <p className="desktop-preview">{plan.preview}</p>
          {plan.needsScope && <p className="desktop-warn"><Icon name="lock" size={14} /> Needs the “{plan.needsScope}” permission first — <button type="button" className="desktop-link" onClick={() => goTab('permissions')}>open Permissions</button> to grant it, then preview again.</p>}
          {plan.needsConfirm && <p className="desktop-warn"><Icon name="warn" size={14} /> High-risk / irreversible — “Approve & run” is your explicit confirmation.</p>}
          <div className="desktop-row">
            <button type="button" className="desktop-cancel" onClick={() => setPlan(null)}>Cancel</button>
            <button type="button" className="desktop-approve" onClick={approveAndRun} disabled={busy !== '' || Boolean(plan.needsScope)}>{busy === 'running' ? 'Running…' : 'Approve & run'}</button>
          </div>
        </div>
      : <div className="desktop-plan is-rejected"><strong>Agent rejected the request</strong><p>{plan.reason || 'It does not match the allowlist.'}</p>{Array.isArray(plan.issues) && plan.issues.length ? <ul className="desktop-issues">{plan.issues.map((issue, n) => <li key={n}>{issue.path}: {issue.message}</li>)}</ul> : null}</div>)}

      {result && <div className="desktop-result">
        <div className="desktop-plan-head"><strong>{result.ok ? `✓ ${result.action}` : `✕ ${result.status || 'blocked'}`}</strong></div>
        {result.ok === false ? <p className="desktop-warn">{result.reason || 'Not executed.'}</p>
          : <pre className="desktop-result-json">{JSON.stringify(result.result, null, 2)}</pre>}
      </div>}
    </div>}

    {tab === 'permissions' && <div className="desktop-perms">
      <p className="desktop-muted">Default-deny. Nothing runs until you switch a scope on, and destructive actions STILL ask every single time.</p>
      <div className="desktop-scopes">{desktopScopes.map(([scope, icon, desc]) => {
        const granted = perms?.scopes?.[scope] === true
        return <div className={`desktop-scope${granted ? ' is-on' : ''}`} key={scope}>
          <div className="desktop-scope-main"><span className="showcase-icon"><Icon name={icon} size={18} /></span><div><strong>{scope}</strong><small>{desc}</small></div></div>
          {granted
            ? <button type="button" className="desktop-link danger" onClick={() => mutatePerms(() => api.revokePerm({ scope }), `Revoked ${scope}`)}>Revoke</button>
            : <button type="button" className="desktop-link" onClick={() => mutatePerms(() => api.grant({ scope }), `Granted ${scope}`)}>Grant</button>}
        </div>
      })}</div>

      <div className="desktop-card">
        <label className="desktop-label" htmlFor="desktop-dir">Approved folders — file actions are limited to these</label>
        <ul className="desktop-list">{(perms?.allowedDirs || []).length ? perms.allowedDirs.map((d) => <li key={d}><code>{d}</code><button type="button" className="desktop-link danger" onClick={() => mutatePerms(() => api.revokePerm({ allowedDir: d }), 'Folder removed', refreshPermissions)}>Remove</button></li>) : <li className="desktop-none">None yet — files.* actions will be denied.</li>}</ul>
        <div className="desktop-inline"><input id="desktop-dir" className="tool-runner-input desktop-field" type="text" placeholder="C:\\Path\\To\\Sandbox" value={dirDraft} onChange={(event) => setDirDraft(event.target.value)} /><button type="button" className="desktop-link" onClick={() => { const d = dirDraft.trim(); if (d) mutatePerms(() => api.grant({ allowedDir: d }), 'Folder approved', () => setDirDraft('')) }}>Add</button></div>
      </div>

      <div className="desktop-card">
        <label className="desktop-label">Approved apps</label>
        <ul className="desktop-list">{(apps || []).length ? (apps || []).map((a) => <li key={a.id}><code>{a.id}</code> <span className="desktop-muted">{a.label}{a.resolved ? '' : ' · not installed here'}</span></li>) : <li className="desktop-none">None reported by the agent.</li>}</ul>
        <div className="desktop-inline"><input className="tool-runner-input desktop-field" type="text" placeholder="app id (e.g. chrome)" value={appDraft} onChange={(event) => setAppDraft(event.target.value)} /><button type="button" className="desktop-link" onClick={() => { const v = appDraft.trim(); if (v) mutatePerms(() => api.grant({ approvedAppId: v }), 'App approved', () => setAppDraft('')) }}>Add</button></div>
      </div>

      <div className="desktop-card">
        <label className="desktop-label">Allowed browser hosts (empty = the agent's env default)</label>
        <ul className="desktop-list">{(perms?.allowedHosts || []).length ? perms.allowedHosts.map((h) => <li key={h}><code>{h}</code></li>) : <li className="desktop-none">No per-host allowlist set.</li>}</ul>
        <div className="desktop-inline"><input className="tool-runner-input desktop-field" type="text" placeholder="example.com" value={hostDraft} onChange={(event) => setHostDraft(event.target.value)} /><button type="button" className="desktop-link" onClick={() => { const v = hostDraft.trim(); if (v) mutatePerms(() => api.grant({ allowedHost: v }), 'Host allowed', () => setHostDraft('')) }}>Add</button></div>
      </div>
    </div>}

    {tab === 'audit' && <div className="desktop-audit">
      <div className="desktop-row"><button type="button" className="desktop-link" onClick={refreshAudit}>Refresh</button><span className="desktop-muted">Secrets, file bodies and form values are redacted at the source.</span></div>
      {(audit || []).length === 0 ? <p className="desktop-none">Nothing recorded yet.</p>
        : <ul className="desktop-audit-list">{audit.map((entry, n) => <li key={n}><span className="desktop-audit-time">{new Date(entry.ts).toLocaleTimeString()}</span><code className="desktop-audit-event">{entry.event || entry.action}</code>{entry.status ? <span className="desktop-scope-chip">{entry.status}</span> : null}{entry.reason ? <span className="desktop-muted"> — {entry.reason}</span> : null}</li>)}</ul>}
    </div>}
    </>}
  </section>
}

/* Starter prompts shown on the chat home hero. Clicking one sends the message
   immediately — no need to press Enter or the send button afterwards. */
const chatStarters = [
  { icon: 'bulb', label: 'Explain something in simple words' },
  { icon: 'pen', label: 'Help me with my work' },
  { icon: 'brain', label: 'Remember my preferences' },
  { icon: 'magic', label: 'Just have a conversation' },
]

/* Small clock shown under each chat turn, matching the reference layout. */
const formatChatTime = (ts) => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/* Account + companion settings, redesigned as one top-to-bottom column.
   Everything here is live: name/email/password hit the backend, the AI
   companion fields persist to voicePrefs (which drive the chat name, the
   particle face and the Talk voice), and Voice/Language reuse the same store. */
/* Store-owner view of the manual payment queue. Renders nothing until /status
   says the signed-in account is an approver (ADMIN_USER_IDS), so ordinary users
   never see it. Approving grants the plan to the REQUESTER server-side; rejecting
   just marks the row. The owner checks their real Easypaisa/JazzCash app for the
   money before approving — the app never sees the payment itself. */
function AdminBillingPanel({ authToken }) {
  const [status, setStatus] = useState(null)
  const [requests, setRequests] = useState([])
  const [filter, setFilter] = useState('pending')
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!authToken) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const s = await billingStatus(authToken)
        if (cancelled) return
        setStatus(s)
        if (s.isAdmin) { const list = await billingRequests(authToken, filter); if (!cancelled) setRequests(list.data || []) }
      } catch (e) { if (!cancelled) setErr(e.message) }
    })()
    return () => { cancelled = true }
  }, [authToken, filter, nonce])

  async function review(id, decision) {
    setBusy(`${id}:${decision}`); setErr('')
    try { await billingReview(authToken, { id, decision }); setNonce((n) => n + 1) }
    catch (e) { setErr(e.message) }
    finally { setBusy('') }
  }

  if (!status || !status.isAdmin) return null
  const planLabel = (p) => (p === 'yearly_pro' ? 'Yearly Pro' : 'Pro')
  const methodLabel = (m) => (m === 'easypaisa' ? 'Easypaisa' : 'JazzCash')
  return <div className="settings-group">
    <h3><Icon name="dollar" size={16} /> Upgrade requests <small className="billing-admin-tag">admin</small></h3>
    <p className="settings-hint">Har request tab banti hai jab user Easypaisa/JazzCash se paisa bhej kar Transaction ID darj karta hai. Pehle apne wallet app mein paisa confirm karein, phir Approve dabayein — Approve ke baad hi user ka plan badalta hai.</p>
    {!status.manualEnabled && <p className="billing-warn"><Icon name="warn" size={14} /> Aap ne abhi koi Easypaisa/JazzCash number set nahi kiya (backend/.env), is liye users payment nahi bhej pa rahe.</p>}
    {err && <p className="billing-warn"><Icon name="warn" size={14} /> {err}</p>}
    <div className="billing-filters" role="tablist">
      {['pending', 'approved', 'rejected', ''].map((f) => <button type="button" role="tab" aria-selected={filter === f} key={f || 'all'} className={`billing-filter${filter === f ? ' selected' : ''}`} onClick={() => setFilter(f)}>{f ? f[0].toUpperCase() + f.slice(1) : 'All'}</button>)}
    </div>
    {!requests.length ? <p className="settings-hint">{filter === 'pending' ? 'Koi pending request nahi.' : 'Yahan kuch nahi hai.'}</p> : <ul className="billing-list">
      {requests.map((r) => <li key={r.id} className="billing-item">
        <div className="billing-item-main">
          <strong>{r.userName || r.userEmail || r.userId}</strong>
          <span className="billing-plan">{planLabel(r.plan)} — {r.amount} PKR</span>
          <span className="billing-method">{methodLabel(r.method)} · TID <code>{r.txnId}</code></span>
          <span className="billing-time">{new Date(r.createdAt).toLocaleString()}</span>
          {r.note && <span className="billing-note">Note: {r.note}</span>}
        </div>
        <div className="billing-actions">
          {r.status === 'pending' ? <>
            <button className="settings-save" type="button" onClick={() => review(r.id, 'approve')} disabled={busy}>{busy === `${r.id}:approve` ? 'Approving…' : 'Approve'}</button>
            <button className="billing-reject" type="button" onClick={() => review(r.id, 'reject')} disabled={busy}>{busy === `${r.id}:reject` ? 'Rejecting…' : 'Reject'}</button>
          </> : <span className={`billing-state is-${r.status}`}>{r.status}</span>}
        </div>
      </li>)}
    </ul>}
  </div>
}

function SettingsView({ isLoggedIn, userProfile, authToken, onProfileUpdate, onTokenChange, onLogin, onUpgrade, voicePrefs, persistVoicePrefs }) {
  const aiName = voicePrefs.assistantName || 'Nexora'
  /* Keep the copy honest: the companion's pronoun follows the chosen face. */
  const subj = voicePrefs.gender === 'male' ? 'he' : 'she'
  const [name, setName] = useState(userProfile?.name || '')
  const [email, setEmail] = useState(userProfile?.email || '')
  const [emailPw, setEmailPw] = useState('')
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [aiNameDraft, setAiNameDraft] = useState(voicePrefs.assistantName || 'Aira')
  const [personaDraft, setPersonaDraft] = useState(voicePrefs.persona || '')
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState({})

  const flash = (key, type, text) => setStatus((s) => ({ ...s, [key]: { type, text } }))
  const badge = (key) => (status[key]?.text ? <span className={`settings-status ${status[key].type}`} role="status">{status[key].text}</span> : null)

  async function saveName() {
    setBusy('name'); flash('name', '', '')
    try { const res = await updateProfile(authToken, { name: name.trim() }); onProfileUpdate(res.user); flash('name', 'ok', 'Saved ✓') }
    catch (err) { flash('name', 'err', err.message) }
    finally { setBusy('') }
  }

  async function saveEmail() {
    setBusy('email'); flash('email', '', '')
    try { const res = await updateEmail(authToken, { currentPassword: emailPw, email: email.trim() }); onProfileUpdate(res.user); setEmailPw(''); flash('email', 'ok', 'Email updated ✓') }
    catch (err) { flash('email', 'err', err.message) }
    finally { setBusy('') }
  }

  async function savePassword() {
    setBusy('pw'); flash('pw', '', '')
    try {
      const res = await updatePassword(authToken, { currentPassword: curPw, newPassword: newPw })
      /* Changing the password revokes every older token server-side, INCLUDING the one
         in this tab — so adopt the freshly-minted one the backend returns, or the very
         next request would 401 and quietly boot the user out right after success. */
      if (res?.token && onTokenChange) onTokenChange(res.token)
      setCurPw(''); setNewPw(''); flash('pw', 'ok', 'Password updated ✓')
    }
    catch (err) { flash('pw', 'err', err.message) }
    finally { setBusy('') }
  }

  function saveCompanion() {
    persistVoicePrefs({ ...voicePrefs, assistantName: aiNameDraft.trim() || 'Aira', persona: personaDraft.trim() })
    flash('ai', 'ok', 'Saved ✓')
  }

  const setGender = (g) => persistVoicePrefs({ ...voicePrefs, gender: g })

  return (
    <section className="workspace-page-panel settings-panel settings-column">
      <div className="settings-head">
        <div className="settings-icon" aria-hidden="true"><Icon name="settings" size={26} /></div>
        <div className="settings-head-copy">
          <h2>Your space, your way.</h2>
          <p>Manage your account, the way {aiName} looks and talks, and how {subj} replies — all in one place.</p>
        </div>
      </div>
      <div className="settings-body">
        <div className="settings-group">
          <h3><Icon name="user" size={16} /> Your account</h3>
          {isLoggedIn ? <>
            <div className="settings-row">
              <label htmlFor="set-name">Display name</label>
              <input id="set-name" className="settings-input" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
              <div className="settings-actions"><button className="settings-save" type="button" onClick={saveName} disabled={busy === 'name' || name.trim().length < 2}>{busy === 'name' ? 'Saving…' : 'Save name'}</button>{badge('name')}</div>
            </div>
            <div className="settings-row">
              <label htmlFor="set-email">Email</label>
              <input id="set-email" className="settings-input" type="email" value={email} maxLength={160} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
              <input className="settings-input" type="password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} placeholder="Current password (required to change email)" autoComplete="current-password" />
              <div className="settings-actions"><button className="settings-save" type="button" onClick={saveEmail} disabled={busy === 'email' || !email.trim() || !emailPw}>{busy === 'email' ? 'Saving…' : 'Update email'}</button>{badge('email')}</div>
            </div>
            <div className="settings-row">
              <label htmlFor="set-curpw">Password</label>
              <input id="set-curpw" className="settings-input" type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} placeholder="Current password" autoComplete="current-password" />
              <input className="settings-input" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password (min 6 characters)" autoComplete="new-password" />
              <div className="settings-actions"><button className="settings-save" type="button" onClick={savePassword} disabled={busy === 'pw' || !curPw || newPw.length < 6}>{busy === 'pw' ? 'Saving…' : 'Change password'}</button>{badge('pw')}</div>
            </div>
            <div className="settings-row">
              <label>Plan &amp; credits</label>
              <div className="settings-chips">
                <span className="settings-chip">Plan: <b>{userProfile?.isPremium ? (userProfile?.plan === 'yearly_pro' ? 'Yearly Pro' : 'Pro') : 'Starter'}</b></span>
                <span className="settings-chip">Credits: <b>{userProfile?.isPremium ? 'Unlimited' : (userProfile?.creditsRemaining ?? 0)}</b></span>
              </div>
              {!userProfile?.isPremium && <div className="settings-actions"><button className="settings-save" type="button" onClick={onUpgrade}>Upgrade to Pro</button></div>}
            </div>
          </> : <div className="settings-row"><p className="settings-hint">Sign in to change your name, email and password and to sync everything across devices.</p><div className="settings-actions"><button className="settings-save" type="button" onClick={onLogin}>Sign in</button></div></div>}
        </div>

        <div className="settings-group">
          <h3><Icon name="sparkle" size={16} /> Your AI companion</h3>
          <div className="settings-row">
            <label htmlFor="set-ai">Assistant name</label>
            <input id="set-ai" className="settings-input" type="text" value={aiNameDraft} maxLength={30} onChange={(e) => setAiNameDraft(e.target.value)} placeholder="e.g. Aira" />
            <span className="settings-hint">The name {subj} answers to in chat, voice and the greeting.</span>
          </div>
          <div className="settings-row">
            <label htmlFor="set-persona">Personality</label>
            <textarea id="set-persona" className="settings-input" value={personaDraft} maxLength={400} onChange={(e) => setPersonaDraft(e.target.value)} placeholder="e.g. Warm, witty, a big-sister energy who pushes me to study." rows={3} />
            <span className="settings-hint">Shapes how {aiNameDraft || subj} talks — style only, {subj} stays honest.</span>
          </div>
          <div className="settings-row">
            <label>Face</label>
            <div className="settings-seg" role="group" aria-label="Assistant face">
              <button type="button" className={voicePrefs.gender === 'female' ? 'on' : ''} aria-pressed={voicePrefs.gender === 'female'} onClick={() => setGender('female')}><Icon name="female" size={14} /> Her</button>
              <button type="button" className={voicePrefs.gender === 'male' ? 'on' : ''} aria-pressed={voicePrefs.gender === 'male'} onClick={() => setGender('male')}><Icon name="male" size={14} /> Him</button>
            </div>
            <span className="settings-hint">Picks the 3D particle portrait — {voicePrefs.gender === 'male' ? 'him' : 'her'}. (The Talk voice is set just below.)</span>
          </div>
          <div className="settings-actions"><button className="settings-save" type="button" onClick={saveCompanion}>Save companion</button>{badge('ai')}</div>
        </div>

        <div className="settings-group">
          <h3><Icon name="mic" size={16} /> Voice &amp; language</h3>
          <div className="settings-row">
            <label htmlFor="set-voice">Talk voice</label>
            <select id="set-voice" className="settings-select" value={voicePrefs.voice} onChange={(e) => persistVoicePrefs({ ...voicePrefs, voice: e.target.value })}>
              {VOICE_OPTIONS.map(([id, vname, hint]) => <option key={id} value={id}>{vname} — {hint}</option>)}
            </select>
          </div>
          <div className="settings-row">
            <label htmlFor="set-lang">Reply language</label>
            <select id="set-lang" className="settings-select" value={voicePrefs.language} onChange={(e) => persistVoicePrefs({ ...voicePrefs, language: e.target.value })}>
              {LANGUAGE_GROUPS_UI.map(({ region, entries }) => (
                <optgroup key={region} label={region}>
                  {entries.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                </optgroup>
              ))}
            </select>
            <span className="settings-hint">Not English? Pick your language here and {aiName} will reply in it.</span>
          </div>
        </div>

        {isLoggedIn && <div className="settings-group">
          <h3><Icon name="lock" size={16} /> Owner voice lock</h3>
          <OwnerVoiceSetup userKey={userProfile?.id || userProfile?.email} ownerName={userProfile?.name} aiName={aiName} />
        </div>}

        {isLoggedIn && <AdminBillingPanel authToken={authToken} />}

        <div className="settings-group">
          <h3><Icon name="lock" size={16} /> Session</h3>
          <div className="settings-row">
            <p className="settings-hint">{isLoggedIn ? `Signed in as ${userProfile?.email || 'you'}.` : 'You are browsing in a local session.'}</p>
          </div>
        </div>
      </div>
    </section>
  )
}

/* "Don't message me now — I'll write myself" in the languages users actually
   type. Needs TWO hits (a negation AND a messaging word) so ordinary questions
   never mute her by accident: a false negative just costs a rephrase, a false
   positive would silence her mid-conversation. */
const QUIET_NEG = /\b(?:don'?t|do\s+not|stop|never|quit|cancel|avoid)\b|(?:^|\s)no\s+(?:msg|message|text|ping)|(?:^|\s)(?:mat|matt|nahi|nahin|nai|na|band|مت|نہیں)(?:\s|$)/i
const QUIET_MSG = /\b(?:msg|msgs|message|messages|messaging|messaged|ping|pings|text|texts|texting)\b/i
function wantsQuiet(text) { return QUIET_NEG.test(text) && QUIET_MSG.test(text) }

/* "Chup kro" / "be quiet" / "sunao nahi" / "stop talking" / "bas karo" /
   "meri baat suno" — the user is telling the AI to shut up RIGHT NOW while
   it's currently speaking. Match any imperative that implies "cancel the
   audio you are producing". Deliberately broad because the voice pipeline
   must die the instant the user objects; the prompt still reaches the model
   afterwards so she can respond with text or a calmer reply. */
const STOP_SPEECH_RE = /(?:\b(?:chup\s*kar(?:o)?|chup\s*ho(?:\s*jao)?|chup|be\s*quiet|quiet\s*(?:now|please|pls)|shut\s*up|bas\s*kar(?:o)?|band\s*kar(?:o)?|sunao\s*nahi|mat\s*bolo|stop\s*(?:talking|speaking|bolna|bol)|delete\s*voice|khamosh(?:\s*ho)?|khamoshi|sunna\s*band|meri\s*baat\s*suno|baat\s*suno|let\s*me\s*talk|let\s*me\s*speak|I\s*want\s*to\s*speak|sun\s*lo|meri\s*batein\s*suno|awaaz\s*band|speech\s*band)\b)/i

/* "Pause karo" / "so jao" / "band ho jao" / "khud ko pause" / "go silent" / "sleep" /
   "dormant" / "resume" / "jaago" / "wake up" / "dubara bolo" / "mic off karo" / "voice
   off karo" / "sirf text" — the user is commanding the AI to change its OWN state.
   We execute the toggle directly in the frontend (React state) so the action is
   INSTANT and 100% reliable regardless of whether the weak model emits the correct
   [APP:...] marker. The prompt still reaches the model so it can acknowledge
   naturally, but we don't depend on it to actually perform the action. */
const SELF_CONTROL_RE = /(?:\b(?:pause\s*(?:karo|kr|kar|ho\s*jao|yourself)|go\s*(?:silent|dormant|sleeping|to\s*sleep)|khud\s*ko\s*pause|dormant\s*ho\s*jao|shut\s*(?:yourself|down|off))\s*$|^(?:so\s*jao|band\s*ho\s*jao)\s*$)/i
const SELF_RESUME_RE = /(?:\b(?:resume(?:\s*(?:karo|kr|kar))?\s*$|wake\s*(?:up|ho\s*jao|jao)\s*$|un-?pause|jaago(?:\s*khud\s*ko)?|dubara\s*(?:bolo|start|begin)|back\s*(?:to\s*life|online)|nhi\s*so\s*ya|mat\s*so|bolna\s*shuru|bolo\s*phir|start\s*(?:talking|speaking|bolna)|phir\s*se\s*bolo|wapas\s*ao)\b)/i
const SELF_MUTE_RE = /(?:\b(?:voice\s*(?:off|band)\s*(?:karo|kr|kar)?|mute\s*(?:voice|yourself|karo))\b|^(?:sirf\s*text|only\s*text|text\s*only|type\s*only)\s*$)/i
const SELF_UNMUTE_RE = /\b(?:voice\s*(?:on|chaloo|chalu)\s*(?:karo|kr|kar)?|un-?mute|speaking\s*(?:karo|on))\b/i
const SELF_MICOFF_RE = /\b(?:mic\s*(?:off|band)\s*(?:karo|kr|kar)?|sunna\s*band\s*(?:karo|kr)?|stop\s*listening|mat\s*suno)\b/i
const SELF_MICON_RE = /\b(?:mic\s*(?:on|chaloo|chalu)\s*(?:karo|kr|kar)?|sunna\s*(?:shuru|chaloo|on)|start\s*listening|resume\s*listening)\b/i

/* "Chup ho jao" as a SUSTAINED silence, not a one-shot barge-in: she says a
   brief "okay", then STAYS quiet (no replies, no proactive check-ins, no
   auto-listen loop) until the user calls her again by NAME or says "listen".
   Distinct from STOP_SPEECH_RE ("chup kro" = stop THAT sentence now): here the
   user is putting her to sleep.
   TWO tiers, because the always-on STT returns the command in WHATEVER script
   the mic locale produced (hi-IN often gives Devanagari "चुप कर जाओ", ur-PK
   gives "چپ ہو جاؤ", en-IN gives Roman) and frequently bolts junk onto the end
   of a short phrase. STRONG = an unambiguous "become silent / go to sleep"
   imperative in ANY of the three scripts, matched anywhere in the string with
   NO length cap (so "bolun? chup kar jao aur tumne kuch bhi nahi" still sleeps
   her). SOFT = the vaguer "talk later / when I call" phrasings that could
   appear inside a real question, so those stay capped at 40 chars. */
const VOICE_SLEEP_STRONG_RE = /(?:\b(?:chup|choop|khamosh)\b[^.!?]{0,14}?\b(?:jao|jaye|jaao|gi|gaya|do)\b|\b(?:so|dormant)\b[^.!?]{0,10}?\b(?:jao|jaye|gya|gi)\b|\bgo\s+to\s+sleep\b|\bsleep\s+now\b|\bbe\s+quiet\s+now\b|चुप[^।.!?]{0,10}?जा|चूप[^।.!?]{0,10}?जा|खामोश[^।.!?]{0,10}?हो|सो[^।.!?]{0,8}?जा|خاموش[^۔!?؟]{0,10}?جا|چپ[^۔!?؟]{0,10}?جا|سو[^۔!?؟]{0,8}?جا)/i
const VOICE_SLEEP_SOFT_RE = /\b(?:baad\s*me\s*(?:baat|talk)|jab\s*(?:main|mai)?\s*(?:bulao|bulaun)\s*(?:tab)?|when\s*I\s*(?:call|say)\s*(?:your|it)?|go\s*silent|dormant\s*ho\s*jao)\b/i
/* Spoken words that revive a sleeping assistant WITHOUT her name — matched by
   useWakeWord only while she is asleep. Includes the Devanagari the hi-IN
   recogniser returns for "listen/suno" so a Hindi-script wake works too. */
const SLEEP_RESUME_ALIASES = ['listen', 'suno', 'jaago', 'wake up', 'wake', 'सुनो', 'जागो']
/* The one line she says before falling silent — a real acknowledgement, then
   quiet — localised to the reply language. Mentions the name so the user knows
   how to bring her back. */
function sleepAckLine(language, name) {
  const l = String(language || 'auto').toLowerCase()
  if (l === 'ur') return `theek hai, main chup hoon. Jab baat karni ho to "${name}" ya "listen" keh kar bula lena.`
  if (l === 'en') return `Okay, I'll stay quiet. Just say "${name}" or "listen" when you need me.`
  return `Theek hai, main chup hoon. Jab bulao — bas "${name}" ya "listen" bol dena.`
}

/* Clipboard/picked File → downscaled JPEG data URL: keeps uploads inside the
   API's 2 MB JSON budget, shrinks what the vision model eats, and strips EXIF. */
function fileToScaledDataUrl(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round((img.width || 1) * scale))
      canvas.height = Math.max(1, Math.round((img.height || 1) * scale))
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read')) }
    img.src = url
  })
}

/* Sequence for attachment preview ids — module scope so no render/handler ever
   needs Math.random or Date.now (react/purity). */
let attachSeq = 0

function Workspace({ activeView, setActiveView, selectedTool, setSelectedTool, isLoggedIn, userProfile, authToken, onLogin, onLogout, onUpgrade, onProfileUpdate, onTokenChange }) {
  const [prompt, setPrompt] = useState('')
  const [conversationId, setConversationId] = useState(null)
  const [messages, setMessages] = useState([])
  /* Reply threading: the one AI turn the next message answers, if any. */
  const [replyTarget, setReplyTarget] = useState(null)
  /* Which message was just copied to the clipboard, so its button can flip to a
     "✓ Copied" confirmation for a moment without a per-message state array. */
  const [copiedMsgId, setCopiedMsgId] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const [notice, setNotice] = useState(() => selectedTool ? `✦ ${selectedTool} is selected and ready to use!` : '')
  /* Give the toast a fair stay: a notice lives 6s, and a fresh notice restarts the
     clock instead of being killed by the previous one's timer. */
  useEffect(() => {
    if (!notice) return undefined
    const id = setTimeout(() => setNotice(''), 6000)
    return () => clearTimeout(id)
  }, [notice])
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false)
  const chatEndRef = useRef(null)
  /* Aira sometimes starts the conversation herself: if the user goes quiet mid-chat,
     ask the backend for one short check-in. The idle clock and a once-per-pause guard
     live in refs so the interval below never re-subscribes on every keystroke. */
  const lastActivityRef = useRef(Date.now())
  const proactiveBusyRef = useRef(false)
  /* Consecutive check-ins the user has left unanswered. A friend nudges a couple of
     times, then lets you be: this climbs per nudge and resets whenever the user
     actually writes, so an idle tab can never re-create the runaway stream of
     near-identical prompts the old un-capped loop used to produce. */
  const proactiveNudgesRef = useRef(0)
  /* Explicit-quiet flag: set when the user's own message asks her not to write.
     Synced from storage on mount so a reload can't re-arm the nudge they refused. */
  const proactiveMutedRef = useRef(false)
  /* Demo prompt meter: how many turns this browser's demo account has already
     spent. Synced from storage on mount so a reload can't hand out a fresh allowance. */
  const demoPromptsRef = useRef(0)
  /* Mutable bridge so the proactive effect's speak callback can reach
     `armNow` without needing it in the effect deps (which would reset the
     idle interval on every wake-word re-render). Assigned once per render
     right after `useWakeWord` returns. */
  const armNowRef = useRef(null)
  /* Desktop agent: track whether we already granted all scopes this session so
     the auto-grant in fulfilDesktopActions runs only once (the first time the
     AI emits a [DESKTOP:...] marker in a chat reply). */
  const desktopAutoGranted = useRef(false)
  /* The transport fulfilDesktopActions resolved (direct paired agent vs backend proxy),
     kept in a ref so a later Approve click on a queued terminal command runs through
     the exact same route the plan was taken on. */
  const desktopTransportRef = useRef(null)
  useEffect(() => {
    try { demoPromptsRef.current = Number(localStorage.getItem(DEMO_PROMPTS_KEY)) || 0 } catch { /* private mode */ }
  }, [])
  /* The composer's private state, as far as the idle clock is concerned: was the
     user mid-message just now, and did they then TAKE BACK what they had typed?
     Refs (not state) because no keystroke should re-render the workspace twice. */
  const typedDraftRef = useRef(false)
  const draftWithdrawnRef = useRef(false)
    /* Holds the AbortController for the in-flight chat stream so the Stop button
       can cancel generation without unmount churn re-subscribing anything. */
    const streamAbortRef = useRef(null)
  const messagesRef = useRef(messages)
  const streamingRef = useRef(streaming)
  /* Synchronous send-lock. `streaming` is React STATE and stays false for the whole
     tick a send is set up, so a fast double-fire (Enter + the send button, or the
     wake-word handing the same utterance twice) slips past the `if (streaming)`
     guard and appends TWO assistant bubbles for ONE user turn. This ref flips to
     true the instant we commit to a turn and back in the `finally`, so a second
     call in the same tick is rejected — one message must finish before the next
     starts. */
  const sendLockRef = useRef(false)
  /* Monotonic id sequence so a temp bubble id can never collide with another
     (Date.now() repeats inside the same millisecond, and a shared key makes the
     stream-fill update the wrong bubble and leaves an empty "thinking" orphan). */
  const msgSeqRef = useRef(0)

  /* Reference images pasted (Ctrl+V) or picked (📎) before sending:
     { id, dataUrl (preview), url (once uploaded), uploading } — max 4 per turn. */
  const [pendingImgs, setPendingImgs] = useState([])
  const attachInputRef = useRef(null)
  /* Live webcam capture modal (📷). Its own getUserMedia lifecycle lives inside
     CameraCapture; a captured frame is routed back through addImageFiles so the
     upload + vision path stays identical to a pasted/picked image. */
  const [cameraOpen, setCameraOpen] = useState(false)
  const promptInputRef = useRef(null)
  /* Set when the composer owes the user a caret: after a send, a stop or opening a
     thread — so no prompt ever has to be triggered a second time. */
  const focusComposerRef = useRef(false)
  const attachCountRef = useRef(0)
  const addImgRef = useRef(null)

  /* Live voice calls + local voice preferences */
  const [voiceOpen, setVoiceOpen] = useState(false)
  /* Derived, not copied: the account prefs can land after this view mounts (session
     restored from cache, a sign-in, our own write coming back), and re-deriving on
     render is how the Settings dropdown shows the truth without a sync effect. */
  const [localPrefs, setLocalPrefs] = useState(readLocalPrefs)
  const voicePrefs = useMemo(() => loadVoicePrefs(localPrefs, userProfile?.prefs), [localPrefs, userProfile?.prefs])
    const voicePrefsRef = useRef(voicePrefs)
    voicePrefsRef.current = voicePrefs

  /* Memory manager (review / edit / delete what Aira remembers) */
  const [memories, setMemories] = useState([])
  const [memLoading, setMemLoading] = useState(false)
  const [memBusy, setMemBusy] = useState(false)
  const [memDraft, setMemDraft] = useState({ key: '', value: '', editingId: null })

  /* Schedule: user-set tasks + the AI nudge waiting to be shown */
  const [tasks, setTasks] = useState([])
  const [taskBusy, setTaskBusy] = useState(false)
  const [taskDraft, setTaskDraft] = useState({ title: '', dueAt: '', notes: '' })
  const [scheduleReminder, setScheduleReminder] = useState(null)

  /* Saved conversations (text + voice share one history — same `conversations` table) */
  const [conversations, setConversations] = useState([])
  const [convLoading, setConvLoading] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)

  const userName = userProfile?.name || 'Guest'
  /* The names she speaks aloud, kept in a ref so the proactive setInterval
     closure (created once, long-lived) reads the current profile instead of
     the one it closed over — same discipline as every other ref here. */
  const speakNamesRef = useRef([])
  speakNamesRef.current = [voicePrefs.assistantName || 'Nexora', (userProfile?.name || '').trim().split(/\s+/)[0]].filter(Boolean)
  const userEmail = userProfile?.email || 'Sign in to sync'
  const userInitial = userName.charAt(0).toUpperCase()
  const userAvatar = userProfile?.avatar || null
  const isPremium = userProfile?.isPremium === true
  /* Live wallet count shown in the top-bar pill. Two sources feed it, and both
     matter:
       1. userProfile.creditsRemaining — the authoritative number from the
          server on login / me-refresh / after a non-streaming call.
       2. The final `creditsRemaining` chunk of a streaming reply — arrives
          before any profile refresh lands, so the pill visibly ticks down
          the moment the answer finishes. Without this the number looked
          "stuck" between reloads and users thought credits weren't being
          charged at all. We prefer the streaming value when it is a real
          number, otherwise fall back to the profile value. */
  const [streamedCredits, setStreamedCredits] = useState(null)
  const creditsRemaining = (() => {
    if (isPremium) return null
    if (typeof streamedCredits === 'number') return streamedCredits
    const raw = Number(userProfile?.creditsRemaining)
    return Number.isFinite(raw) ? raw : 0
  })()
  /* Reset the streamed override whenever the parent profile actually changes
     (login, upgrade, /me refresh) so the freshly-loaded server number wins
     over a stale local copy. */
  useEffect(() => { setStreamedCredits(null) }, [userProfile?.creditsRemaining, isPremium])
  /* Live countdown for the PRIMARY model's daily token budget — the wall that
     produced "The AI is at its limit". For premium accounts (whose own credit
     count is meaningless) the top-bar pill shows this remaining-token number
     instead of "Unlimited", ticking down after every reply and warning at 0.
     null = not loaded yet, so the pill falls back to the old ∞ label. */
  const [providerQuota, setProviderQuota] = useState(null)
  const quotaExhaustedRef = useRef(false)
  useEffect(() => {
    if (!isLoggedIn || !authToken) return undefined
    let cancelled = false
    getQuota(authToken)
      .then((q) => { if (!cancelled && q && typeof q.remaining === 'number') setProviderQuota(q) })
      .catch(() => { /* best-effort: keep the ∞ label if the quota can't load */ })
    return () => { cancelled = true }
  }, [isLoggedIn, authToken])
  /* The single honest moment to speak up: when the budget flips to exhausted, a
     one-time notice tells the user the primary model is spent and failover has
     taken over — resetting the flag when it recovers (new day) so it can warn
     again tomorrow. */
  useEffect(() => {
    if (!providerQuota) return
    if (providerQuota.exhausted && !quotaExhaustedRef.current) {
      quotaExhaustedRef.current = true
      const resetLabel = providerQuota.resetsAt
        ? new Date(providerQuota.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'reset'
      setNotice(`🪫 Daily token limit (${Math.round((providerQuota.limit || 0) / 1000)}k) khatam — naye messages ${resetLabel} par reset ke baad hi jayenge`)
    } else if (!providerQuota.exhausted) {
      quotaExhaustedRef.current = false
    }
  }, [providerQuota])
  /* The name the user chose at onboarding (voice already uses it); chat must match. */
  const aiName = voicePrefs.assistantName || 'Nexora'
  /* Landing CTAs and saved sessions enter the workspace with activeView='Home', but
     there is no Home panel here — treat it as Chat so the pane is never blank and a
     nav button is always the selected one. Sessions stored while the page was still
     called History land on the renamed Memory page. */
  const view = activeView === 'Home' ? 'Chat' : activeView === 'History' ? 'Memory' : activeView
  /* History search: case-insensitive title filter over the already-loaded list. */
  const historyTerm = historyQuery.trim().toLowerCase()
  const visibleConversations = historyTerm
    ? conversations.filter((c) => String(c.title).toLowerCase().includes(historyTerm))
    : conversations

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  /* Keep refs pointed at the latest thread so the idle interval can read them
     without re-subscribing on every render. */
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { streamingRef.current = streaming }, [streaming])
  /* Self-heal an orphaned "thinking" bubble. If a turn ever ended without its
     assistant bubble being resolved (a rare race / a stream that died between
     the header and the first token), the bubble would sit on "Aira is
     thinking…" forever while a newer reply appears below it. Whenever nothing
     is actually streaming, drop the stale flag — and remove the bubble outright
     if it never received any content. */
  useEffect(() => {
    if (streaming) return
    setMessages((prev) => {
      if (!prev.some((m) => m.role === 'assistant' && m.streaming)) return prev
      const next = []
      for (const m of prev) {
        if (m.role === 'assistant' && m.streaming) {
          if (!String(m.content || '').trim()) continue
          next.push({ ...m, streaming: false })
        } else next.push(m)
      }
      return next.length === prev.length ? prev.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m)) : next
    })
  }, [streaming])
  useEffect(() => {
    try { if (localStorage.getItem(PROACTIVE_MUTE_KEY) === '1') proactiveMutedRef.current = true } catch { /* private mode */ }
  }, [])

  /* Kill the first-utterance latency. Chrome and Edge return an empty
     SpeechSynthesisVoice[] on the very first `getVoices()` call and only
     populate the list asynchronously — the `voiceschanged` event lands
     roughly 500 ms to 2 s after the page is interactive. Without this
     warm-up the wake-word ack on a fresh install would either speak with
     the engine default (losing gender and accent entirely) or wait through
     the enumeration before firing, and the user hears a laggy "Ji haan".
     Firing at mount means the list is hot before the user even opens the
     mic, so the very first utterance goes out on the correct voice. */
  useEffect(() => { warmVoiceList() }, [])

  /* Typing holds her back: every keystroke pushes the idle clock forward, so a
     check-in can never land in the middle of a message being written — the 30s
     restarts from the LAST keystroke instead of from the previous turn. And if the
     user then deletes what they had written, that pause is remembered: the next
     check-in asks about the words they took back, instead of carrying on as if
     nothing had been typed at all. Only the fact is tracked, never the text — an
     unfinished draft is not sent anywhere. */
  useEffect(() => {
    if (prompt.trim().length >= 2) {
      lastActivityRef.current = Date.now()
      typedDraftRef.current = true
      return
    }
    if (typedDraftRef.current) {
      /* The draft went away on its own — the user withdrew it. Clearing the clock
         here too gives them a full quiet window before she brings it up. */
      typedDraftRef.current = false
      draftWithdrawnRef.current = true
      lastActivityRef.current = Date.now()
    }
  }, [prompt])

  /* Idle check-in: when the user goes quiet on an open thread whose last turn is
     Aira's, she reaches out first with something tied to that very conversation.
     Fires after ~30s and re-arms up to a small unanswered cap, then waits quietly
     for the user to return — a couple of nudges is caring, an endless stream is not. */
  useEffect(() => {
    if (!isLoggedIn || !authToken || view !== 'Chat' || !conversationId) return
    const IDLE_PROACTIVE_MS = 30000
    const MAX_PROACTIVE_NUDGES = 2
    const tick = setInterval(() => {
      if (document.hidden || streamingRef.current || proactiveBusyRef.current) return
      if (proactiveMutedRef.current) return
      /* Quiet means quiet: "chup ho jao" (voiceAsleep) OR a paused mic
         (wakeEnabled off — the pill reads "paused") must BOTH stop her from
         reaching out. The old build only muted the mic and kept nudging, which
         is exactly the "paused but still texting" bug reported. */
      if (voiceAsleepRef.current || !wakeEnabledRef.current) return
      /* Two states the old gate never considered, both of which mean "she must
         NOT open her mouth right now": the user is talking (detected only
         within the last few seconds, so an in-flight utterance is honoured but
         a conversation that genuinely went quiet still earns a check-in), or a
         full voice call owns the mic — that loop does its own turn-taking and
         an extra bubble mid-call is pure noise. */
      if (hasUserSpokenRecently()) return
      if (voiceOpenRef.current) return
      if (Date.now() - lastActivityRef.current < IDLE_PROACTIVE_MS) return
      /* Stop reaching out into a void: after a couple of unanswered check-ins, fall
         silent until the user writes again (their send resets the counter). */
      if (proactiveNudgesRef.current >= MAX_PROACTIVE_NUDGES) return
      const last = messagesRef.current[messagesRef.current.length - 1]
      if (!last || last.role !== 'assistant' || last.streaming) return
      /* Never interleave a check-in into a turn that is still producing output —
         bail if ANY bubble is mid-stream, not just the last one. */
      if (messagesRef.current.some((m) => m.streaming)) return
      proactiveBusyRef.current = true
      /* She only asks about the abandoned draft once — whatever the answer, the
         question has been asked. */
      const withdrewDraft = draftWithdrawnRef.current
      const composing = typedDraftRef.current
      draftWithdrawnRef.current = false
      proactiveChat({ token: authToken, conversationId, assistantName: aiName, persona: voicePrefsRef.current.persona, gender: voicePrefsRef.current.gender, language: voicePrefsRef.current.language, composing, withdrewDraft })
        .then((r) => {
          const content = (r?.content || '').trim()
          /* Re-check quiet AFTER the round-trip: the user may have paused her,
             opened a voice call, or STARTED TALKING while this request was in
             flight, and a late nudge would either look like the pause did
             nothing or interrupt them mid-sentence. */
          if (voiceAsleepRef.current || !wakeEnabledRef.current) {
            proactiveBusyRef.current = false
            return
          }
          if (voiceOpenRef.current || hasUserSpokenRecently()) {
            proactiveBusyRef.current = false
            return
          }
          if (content) {
            proactiveNudgesRef.current += 1
            /* A warm line loses all warmth when repeated verbatim, so never render a
               nudge that just re-says the last assistant turn — count it, stay quiet. */
            const prev = messagesRef.current[messagesRef.current.length - 1]
            if (!(prev && prev.role === 'assistant' && String(prev.content).trim() === content)) {
              setMessages((prevMsgs) => [...prevMsgs, { id: `local_proactive_${Date.now()}`, role: 'assistant', content, ts: Date.now() }])
              setNotice(`${aiName} checked in.`)
              /* Speak the proactive line out loud so the user HEARS her check in
                 — not just see text appear. Same voice pipeline as a normal reply,
                 conditioned on the toggle + no VoiceCall overlay. */
              if (speakRepliesRef.current && !voiceOpenRef.current) {
                speakAssistantReply(content, {
                  language: voicePrefsRef.current.language,
                  gender: voicePrefsRef.current.gender,
                  voice: voicePrefsRef.current.voice,
                  /* Same spoken-name list as the streamed replies — an idle
                     check-in addresses the user by name too. */
                  names: speakNamesRef.current,
                  authToken,
                  onEnd: () => { armNowRef.current?.(15000); setVoiceTurn(true) }
                })
              }
            }
          }
          /* Re-arm the idle clock for the next window; the unanswered cap above keeps
             a still-quiet tab from looping forever. */
          lastActivityRef.current = Date.now()
          proactiveBusyRef.current = false
        })
        .catch(() => {
          /* best-effort — back off one idle window before trying again */
          lastActivityRef.current = Date.now()
          proactiveBusyRef.current = false
        })
    }, 6000)
    return () => clearInterval(tick)
  }, [isLoggedIn, authToken, view, conversationId, aiName])

  function startNewChat() {
    setConversationId(null)
    setMessages([])
    setReplyTarget(null)
    focusComposerRef.current = true
    setActiveView('Chat')
    lastActivityRef.current = Date.now()
    proactiveBusyRef.current = false
    proactiveNudgesRef.current = 0
    setNotice('New chat ready.')
  }

  /* Click a tool card → open a chat whose title is the tool's name, seed it
     with Aira's own professional prompt asking for the reference inputs, and
     drop a filled-in draft in the composer so the user only has to complete
     the blanks. The draft carries a `[<tool> · session]` prefix — that is
     what the backend LLM reads on the first send so it knows which lane to
     answer in, without us needing a separate tool_hint field. The intro
     bubble is local-only (not persisted): the first real user message becomes
     the actual opener of the thread. If conversation creation fails we still
     land on the chat with the draft — worst case the thread's title falls
     back to the user's message instead of the tool name. */
  async function startToolSession(toolTitle) {
    if (!isLoggedIn || !authToken) { onLogin(); return }
    const starter = TOOL_STARTERS[toolTitle]
    setSelectedTool(toolTitle)
    setReplyTarget(null)
    setMessages(starter ? [{
      id: `tool_intro_${Date.now()}`,
      role: 'assistant',
      content: starter.intro,
      ts: Date.now(),
      toolIntro: toolTitle,
    }] : [])
    setPrompt(starter?.draft || `I want to use ${toolTitle}. `
    )
    setActiveView('Chat')
    focusComposerRef.current = true
    lastActivityRef.current = Date.now()
    setNotice(`✦ ${toolTitle} session opened — complete the draft and send it.`)
    try {
      const conv = await createConversation(authToken, toolTitle)
      if (conv?.id) {
        setConversationId(conv.id)
        /* Fresh conversation exists on the server; refresh the sidebar list
           so the row for the tool shows immediately, without waiting for the
           user's first send. */
        refreshConversations()
      }
    } catch { /* keep the composer draft; the next sendPrompt call will open
                   its own conversation from the message text */ }
  }

  function persistVoicePrefs(next) {
    const payload = voicePrefsPayload(next)
    setLocalPrefs(payload)
    try { localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(payload)) } catch { /* private mode */ }
    /* Mirror the choice onto the account too. Every consumer — chat, proactive
       nudge, Talk, the particle face — reads `language` from here, so a setting
       that only lives in one browser tab is a setting that will be lost. */
    if (!isLoggedIn || !authToken) return
    updateProfile(authToken, { prefs: payload })
      .then((res) => onProfileUpdate(res.user))
      .catch(() => { /* the local copy stands; the next edit retries */ })
  }

  /* First run after onboarding (or after prefs shipped): the account may never have
     been told anything, so offer up what this browser knows — but ASK FIRST. The
     cached profile is per-origin and can predate a choice made elsewhere, and
     writing over a saved "Urdu first" with this tab's defaults is exactly the bug
     this feature exists to kill. */
  const prefsPushedRef = useRef(null)
  useEffect(() => {
    if (!isLoggedIn || !authToken || !userProfile?.id) return
    if (Object.keys(userProfile.prefs || {}).length) return
    if (prefsPushedRef.current === userProfile.id) return
    prefsPushedRef.current = userProfile.id
    const payload = voicePrefsPayload(voicePrefs)
    me(authToken)
      .then((res) => {
        const saved = res.user?.prefs
        if (saved && Object.keys(saved).length) return onProfileUpdate(res.user)
        return updateProfile(authToken, { prefs: payload }).then((r) => onProfileUpdate(r.user))
      })
      .catch(() => { /* offline — the next change tries again */ })
  }, [isLoggedIn, authToken, userProfile, voicePrefs, onProfileUpdate])

  const refreshMemories = useCallback(() => {
    if (!isLoggedIn || !authToken) return
    setMemLoading(true)
    listMemories(authToken)
      .then((r) => setMemories(r.data || []))
      .catch((err) => {
        /* Frontend-only deploy (Vercel has no Express backend): the memories route
           404s, which is expected — settle to empty and stay quiet in production.
           In dev the :8787 hint is still useful. Only a genuine failure surfaces a
           notice in prod, and never with a dev port. */
        if (isBackendUnreachable(err)) {
          setMemories([])
          if (import.meta.env.DEV) setNotice('Could not load memories — is the backend running on :8787?')
        } else setNotice('Could not load your memories right now — please try again.')
      })
      .finally(() => setMemLoading(false))
  }, [isLoggedIn, authToken])

  useEffect(() => {
    if (view !== 'Memory' || !isLoggedIn || !authToken) return undefined
    /* defer one tick: the fetch (and its loading state) starts outside the effect body */
    const id = setTimeout(refreshMemories, 0)
    return () => clearTimeout(id)
  }, [view, isLoggedIn, authToken, refreshMemories])

  const refreshConversations = useCallback(() => {
    if (!isLoggedIn || !authToken) return
    setConvLoading(true)
    listConversations(authToken)
      .then((r) => setConversations(r.data || []))
      .catch((err) => {
        if (isBackendUnreachable(err)) {
          setConversations([])
          if (import.meta.env.DEV) setNotice('Could not load your conversations — is the backend running on :8787?')
        } else setNotice('Could not load your conversations right now — please try again.')
      })
      .finally(() => setConvLoading(false))
  }, [isLoggedIn, authToken])

  useEffect(() => {
    if (view !== 'Memory' || !isLoggedIn || !authToken) return undefined
    const id = setTimeout(() => { setConfirmDeleteAll(false); refreshConversations() }, 0)
    return () => clearTimeout(id)
  }, [view, isLoggedIn, authToken, refreshConversations])

  /* The Chat surface's "Recent chats" panel and "Continue chat" chips read
     `conversations`, so it must be populated the moment the workspace opens — not
     only once the Memory view mounts (otherwise it lies "No saved chats yet"
     while threads exist). One load per auth token; the Memory effect above still
     refreshes on every door visit. */
  useEffect(() => {
    if (!isLoggedIn || !authToken) return undefined
    const id = setTimeout(() => refreshConversations(), 0)
    return () => clearTimeout(id)
  }, [isLoggedIn, authToken, refreshConversations])

  /* The account drawer is a dialog: dismiss it with Escape or a click/tap outside
     the anchor, like every other popover. The DOM is touched only inside the
     listener body (oxlint purity-safe) and the listeners remove themselves on
     close. The toggle button lives inside `.account-anchor`, so its own clicks
     never trip the outside handler. */
  useEffect(() => {
    if (!accountDrawerOpen) return undefined
    const onKey = (event) => { if (event.key === 'Escape') setAccountDrawerOpen(false) }
    const onPointerDown = (event) => {
      const el = event.target instanceof Element ? event.target : null
      if (el && !el.closest('.account-anchor')) setAccountDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onPointerDown) }
  }, [accountDrawerOpen])

  /* Schedule: the fetch stamps each task's phase while the data lands — a
     render-time Date.now() would break oxlint purity, so the clock read lives
     in the callback, exactly once per refresh. */
  const refreshTasks = useCallback(() => {
    if (!isLoggedIn || !authToken) return
    listSchedule(authToken)
      .then((r) => {
        const nowMs = Date.now()
        setTasks((r.data || []).map((t) => ({
          ...t,
          phase: t.status === 'done' ? 'done'
            : Date.parse(t.dueAt) <= nowMs ? 'due'
            : !t.remindedAt && Date.parse(t.dueAt) - nowMs <= 86400000 ? 'soon'
            : 'planned',
        })))
      })
      .catch((err) => {
        if (isBackendUnreachable(err)) {
          setTasks([])
          if (import.meta.env.DEV) setNotice('Could not load your schedule — is the backend running on :8787?')
        } else setNotice('Could not load your schedule right now — please try again.')
      })
  }, [isLoggedIn, authToken])

  useEffect(() => {
    if (activeView !== 'Schedule' || !isLoggedIn || !authToken) return undefined
    const id = setTimeout(refreshTasks, 0)
    return () => clearTimeout(id)
  }, [activeView, isLoggedIn, authToken, refreshTasks])

  /* One nudge per sign-in: ask what needs saying RIGHT NOW — tomorrow's tasks
     get the day-before heads-up with advice, past-due ones the day-of push.
     Shown = acked immediately, so a reload can never re-bill the same reminder. */
  const reminderPulledRef = useRef(false)
  useEffect(() => {
    if (!isLoggedIn || !authToken) { reminderPulledRef.current = false; return }
    if (reminderPulledRef.current) return
    reminderPulledRef.current = true
    fetchScheduleReminders(authToken, { assistantName: aiName, persona: voicePrefs.persona, gender: voicePrefs.gender, language: voicePrefs.language })
      .then((r) => {
        if (!r?.content) return
        const ids = [...(r.due || []), ...(r.upcoming || [])]
        setScheduleReminder({ content: r.content, ids })
        if (r.user) onProfileUpdate(r.user)
        ackScheduleReminders(authToken, ids).catch(() => { /* best-effort */ })
      })
      .catch(() => { /* reminders are best-effort — they never block the workspace */ })
  }, [isLoggedIn, authToken, aiName, voicePrefs, onProfileUpdate])

  function addScheduleTask(event) {
    event.preventDefault()
    if (!isLoggedIn || !authToken) { onLogin(); return }
    const title = taskDraft.title.trim()
    if (!title || !taskDraft.dueAt) return
    setTaskBusy(true)
    createScheduleTask(authToken, { title, notes: taskDraft.notes.trim(), dueAt: new Date(taskDraft.dueAt).toISOString() })
      .then(() => {
        setTaskDraft({ title: '', dueAt: '', notes: '' })
        refreshTasks()
        setNotice(`Scheduled “${title}” — ${aiName} will bring it up a day before and again when it is due.`)
      })
      .catch((err) => setNotice(err.message || 'Could not save that task.'))
      .finally(() => setTaskBusy(false))
  }

  function toggleScheduleTask(task) {
    updateScheduleTask(authToken, task.id, { status: task.status === 'done' ? 'open' : 'done' })
      .then(refreshTasks)
      .catch((err) => setNotice(err.message || 'Could not update that task.'))
  }

  function removeScheduleTask(id) {
    deleteScheduleTask(authToken, id)
      .then(() => { refreshTasks(); setScheduleReminder((r) => (r && r.ids.includes(id) ? null : r)) })
      .catch((err) => setNotice(err.message || 'Could not delete that task.'))
  }

  /* Open a saved thread in the main chat panel — voice and text share the same shape */
  function openConversation(id) {
    getConversation(authToken, id)
      .then((convo) => {
        setConversationId(convo.id)
        setMessages((convo.messages || []).map((m) => ({ id: m.id, role: m.role, content: m.content, images: m.images?.length ? m.images : undefined, replyTo: m.replyTo || undefined, ts: m.createdAt ? new Date(m.createdAt).getTime() : null })))
        setReplyTarget(null)
        focusComposerRef.current = true
        setActiveView('Chat')
        lastActivityRef.current = Date.now()
        proactiveBusyRef.current = false
        proactiveNudgesRef.current = 0
        setNotice(`Opened “${convo.title}”.`)
      })
      .catch((err) => setNotice(err.message || 'Could not open that conversation.'))
  }

  function removeConversation(id) {
    deleteConversation(authToken, id)
      .then(() => {
        setConversations((prev) => prev.filter((c) => c.id !== id))
        /* if the deleted thread is the one currently loaded, clear the workspace */
        setConversationId((current) => (current === id ? null : current))
        setMessages((current) => (id === conversationId ? [] : current))
        setNotice('Conversation deleted.')
      })
      .catch((err) => setNotice(err.message || 'Could not delete conversation.'))
  }

  /* Wipe every saved thread for this user (the backend clears only their rows). */
  function removeAllConversations() {
    deleteAllConversations(authToken)
      .then(() => {
        setConversations([])
        setConversationId(null)
        setMessages([])
        setHistoryQuery('')
        setConfirmDeleteAll(false)
        setNotice('All conversations deleted.')
      })
      .catch((err) => setNotice(err.message || 'Could not delete conversations.'))
  }

  function submitMemory(event) {
    event.preventDefault()
    if (memBusy || !memDraft.key.trim() || !memDraft.value.trim()) return
    setMemBusy(true)
    saveMemory(authToken, { key: memDraft.key.trim(), value: memDraft.value.trim(), source: 'user' })
      .then((saved) => {
        setMemories((prev) => {
          const rest = prev.filter((m) => m.id !== saved.id)
          return [{ ...saved, source: 'user' }, ...rest]
        })
        setMemDraft({ key: '', value: '', editingId: null })
        setNotice(memDraft.editingId ? 'Memory updated.' : `${aiName} will remember this.`)
      })
      .catch((err) => setNotice(err.message || 'Could not save memory.'))
      .finally(() => setMemBusy(false))
  }

  function removeMemoryEntry(id) {
    deleteMemory(authToken, id)
      .then(() => setMemories((prev) => prev.filter((m) => m.id !== id)))
      .catch((err) => setNotice(err.message || 'Could not delete memory.'))
  }

  /* FileList (paste or picker) → instant preview + background upload. Both the
     📎 button and Ctrl+V funnel here; the browser can't script file inputs. */
  async function addImageFiles(files) {
    const imgs = [...files].filter((f) => f && f.type.startsWith('image/'))
    if (!imgs.length) return
    if (!isLoggedIn || !authToken) { onLogin(); return }
    for (const file of imgs) {
      if (attachCountRef.current >= 4) { setNotice('You can attach up to 4 images per message.'); break }
      attachCountRef.current += 1
      const id = `att_${++attachSeq}`
      setPendingImgs((prev) => [...prev, { id, dataUrl: '', url: null, uploading: true }])
      try {
        const dataUrl = await fileToScaledDataUrl(file)
        setPendingImgs((prev) => prev.map((p) => (p.id === id ? { ...p, dataUrl } : p)))
        const res = await uploadChatImage(authToken, dataUrl)
        setPendingImgs((prev) => prev.map((p) => (p.id === id ? { ...p, url: res.url, uploading: false } : p)))
      } catch (err) {
        attachCountRef.current = Math.max(0, attachCountRef.current - 1)
        setPendingImgs((prev) => prev.filter((p) => p.id !== id))
        setNotice(err.message || 'Could not upload that image.')
      }
    }
  }

  function removePendingImg(id) {
    attachCountRef.current = Math.max(0, attachCountRef.current - 1)
    setPendingImgs((prev) => prev.filter((p) => p.id !== id))
  }

  /* Keep the paste listener's copy of the adder fresh without re-subscribing. */
  useEffect(() => { addImgRef.current = addImageFiles })

  /* Ctrl+V anywhere on the Chat view drops a copied screenshot/reference image
     straight into the composer; plain text pastes fall through untouched. */
  useEffect(() => {
    if (view !== 'Chat') return undefined
    const onPaste = (event) => {
      const files = [...(event.clipboardData?.items || [])]
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
      if (!files.length) return
      event.preventDefault()
      addImgRef.current?.(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [view])

  /* Hand the caret back to the composer whenever it was asked for. Skipped when the
     user is already typing in another field — clicking into the Memory search box
     must not have its caret stolen mid-word. */
  useEffect(() => {
    if (!focusComposerRef.current || view !== 'Chat') return
    const el = promptInputRef.current
    if (!el) return /* composer not mounted yet; the next change retries */
    const active = document.activeElement
    const typingElsewhere = active instanceof HTMLElement && active !== el
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)
    focusComposerRef.current = false
    if (!typingElsewhere) el.focus()
  }, [view, messages, streaming])

  /* `extras.spokenAck` is only set when the prompt came from the wake-word
     loop. The word the AI spoke back must appear WRITTEN in the chat too —
     the user should be able to scroll history and see the same sentence they
     just heard. It is stored as a prefix on the streaming assistant bubble so
     the ack sits at the top of that reply, not as a separate message that
     would need its own server-side row. */
  /* Shared "go quiet but stay wake-able by voice" routine — used by the typed/
     spoken sleep command, the self-control pause AND the model's [APP:pause]
     marker so every path behaves IDENTICALLY: the mic stays ON (wakeEnabled is
     NOT touched — that was the old bug where pausing killed the wake word),
     voiceAsleep gates replies + proactive, and a name / "listen" revives her.
     `speak:false` is for the [APP:pause] path where the model already said its
     own goodbye in the reply, so we don't talk over it. */
  function goToSleep({ speak = true } = {}) {
    streamAbortRef.current?.abort()
    cancelSpeakQueue()
    cancelServerAudio()
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } }
    /* armNow with a negative ms pushes the command window into the past — a
       real disarm, since armNow(0) would read `0 || default` and RE-arm. */
    armNow(-1000)
    setVoiceTurn(false)
    voiceAsleepRef.current = true
    setVoiceAsleep(true)
    const line = sleepAckLine(voicePrefs.language, aiName)
    setNotice(`🤫 ${line}`)
    if (speak && speakRepliesRef.current && !voiceOpenRef.current) {
      speakWakeLine(line, { language: voicePrefs.language, gender: voicePrefs.gender })
    }
    return line
  }

  async function sendPrompt(event, overrideText, extras = {}) {
    if (event) event.preventDefault()
    const cleanPrompt = (typeof overrideText === 'string' ? overrideText : prompt).trim()
    const spokenAck = typeof extras.spokenAck === 'string' && extras.spokenAck.trim()
      ? `${extras.spokenAck.trim()}\n\n`
      : ''
    /* ---- Voice sleep / wake: "chup ho jao" ↔ name / "listen" ---- */
    /* STRONG phrases match anywhere (STT bolts junk onto a short command); SOFT
       ones stay terse so a genuine question isn't mistaken for "go quiet". */
    if (VOICE_SLEEP_STRONG_RE.test(cleanPrompt)
      || (cleanPrompt.length <= 40 && VOICE_SLEEP_SOFT_RE.test(cleanPrompt))) {
      /* Sleep via the shared routine, then clear the composer (a mode switch adds
         no chat bubble, so the normal path that empties the box is skipped). */
      goToSleep()
      setPrompt('')
      typedDraftRef.current = false
      return
    }
    /* Any deliberate input while asleep wakes her — a typed message, or a spoken
       command that reached here through a name/"listen" wake. Clear the flag and
       fall through so THIS message gets its real reply. */
    if (voiceAsleepRef.current) {
      voiceAsleepRef.current = false
      setVoiceAsleep(false)
    }
    /* "Chup kro" / "stop talking" / "meri baat suno": kill the current TTS
       IMMEDIATELY before any other logic runs — even before the streaming
       guard, because a previous reply may still be playing its audio while
       the next stream has already started. The user hears her voice STOP the
       millisecond they object, which is the whole point of a natural
       conversation: you can interrupt someone mid-sentence. */
    if (STOP_SPEECH_RE.test(cleanPrompt)) {
      cancelServerAudio()
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } }
      setVoiceTurn(false)
      setNotice(`${aiName} chup ho gayi — aap boliye.`)
    }
    /* Self-control: execute pause/resume/mute/mic commands DIRECTLY from the
       user's words without waiting for the model to emit [APP:...] markers
       (weak models often ignore that directive and make jokes instead). The
       prompt STILL reaches the model so it can acknowledge in its reply; but
       the ACTUAL state toggle happens here, guaranteed.
       LENGTH GUARD: only messages ≤ 35 chars (typical voice-command length) can
       trigger self-control — longer sentences like "tell me about text only
       mode" or "I want to resume my studies" are NOT commands. */
    const isShortCommand = cleanPrompt.length <= 35
    /* "pause karo" / "go silent" now share the SAME voice-wake sleep as "chup
       ho jao" — the mic stays ON so a name revives her. (The old code called
       setWakeEnabled(false), which killed the wake word and forced the user to
       TYPE to resume — exactly what they objected to.) */
    if (isShortCommand && SELF_CONTROL_RE.test(cleanPrompt)) {
      goToSleep()
      setPrompt('')
      typedDraftRef.current = false
      return
    }
    let handledSelfControl = false
    if (SELF_RESUME_RE.test(cleanPrompt)) {
      setWakeEnabled(true); setSpeakReplies(true)
      try { localStorage.setItem('nexora_speak_replies', '1') } catch { /* ignore */ }
      setNotice(`${aiName} jaag gayi!`)
      handledSelfControl = true
    } else if (SELF_MUTE_RE.test(cleanPrompt)) {
      setSpeakReplies(false)
      try { localStorage.setItem('nexora_speak_replies', '0') } catch { /* ignore */ }
      cancelServerAudio()
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } }
      setNotice(`${aiName} ab sirf text mein jawab degi.`)
      handledSelfControl = true
    } else if (SELF_UNMUTE_RE.test(cleanPrompt)) {
      setSpeakReplies(true)
      try { localStorage.setItem('nexora_speak_replies', '1') } catch { /* ignore */ }
      setNotice(`${aiName} bolna shuru kar degi.`)
      handledSelfControl = true
    } else if (SELF_MICOFF_RE.test(cleanPrompt)) {
      setWakeEnabled(false)
      setNotice(`${aiName} ka mic band — sun nahi rahi.`)
      handledSelfControl = true
    } else if (SELF_MICON_RE.test(cleanPrompt)) {
      setWakeEnabled(true)
      setNotice(`${aiName} sun rahi hai.`)
      handledSelfControl = true
    }
    /* Auto-resume from an AI-initiated PAUSE is handled above: the
       `if (voiceAsleepRef.current)` block clears the sleep flag on any deliberate
       input, so a typed message wakes her naturally without the user having to
       say "wake up". What MUST NOT happen here is silently re-enabling the mic
       pill or the 🔇 button when the user turned them off by hand — that was the
       old bug ("paused / muted dobara ON ho jaata hai"). Manual clicks are an
       explicit choice; only the user's next click (or an [APP:resume] /
       [APP:mic-on] / [APP:unmute] marker they asked for) may change them. */
    /* If a self-control command was executed by the frontend, append a brief
       HINT so the model knows the action is ALREADY done and must just
       acknowledge it — not refuse or joke about "existing in text". */
    let promptForModel = cleanPrompt
    if (handledSelfControl) {
      const action = SELF_CONTROL_RE.test(cleanPrompt) ? 'paused (voice OFF, mic OFF)'
        : SELF_RESUME_RE.test(cleanPrompt) ? 'resumed (voice ON, mic ON)'
        : SELF_MUTE_RE.test(cleanPrompt) ? 'muted (voice OFF, mic still listening)'
        : SELF_UNMUTE_RE.test(cleanPrompt) ? 'unmuted (voice ON)'
        : SELF_MICOFF_RE.test(cleanPrompt) ? 'mic turned OFF'
        : 'mic turned ON'
      promptForModel = `${cleanPrompt}\n[SYSTEM: The app has ALREADY executed your ${action}. Just say a brief friendly acknowledgement — do NOT say you cannot control yourself or that you only exist in text. The action is done.]`
    }
    const imgUrls = pendingImgs.filter((p) => p.url).map((p) => p.url)
    /* Hard serialization: bail if a turn is already committing/streaming. The ref
       catches the same-tick double-fire the `streaming` state can't see yet. */
    if (sendLockRef.current || streaming || pendingImgs.some((p) => p.uploading)) return
    if (!cleanPrompt && !imgUrls.length) return

    if (!isLoggedIn || !authToken) {
      onLogin()
      return
    }

    /* Daily token limit reached: the top-bar countdown is now the authoritative
       gate, so once it hits zero the composer stops sending NEW messages until the
       budget resets. The server enforces this too (a blocked turn never reaches the
       model); this keeps the UI honest and shows a friendly notice instead of a red
       error card. Self-control / sleep-wake phrases above already returned, so this
       only gates real AI turns. */
    if (providerQuota?.exhausted) {
      const resetLabel = providerQuota.resetsAt
        ? new Date(providerQuota.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'reset'
      setNotice(`🪫 Daily token limit khatam — naya message ${resetLabel} ke baad hi jayega.`)
      return
    }

    /* Demo accounts get a taste, then the upsell: once the free allowance is spent
       the composer stops sending and the pricing modal opens. A paid plan clears it. */
    if (userProfile?.isDemo && !userProfile?.isPremium) {
      if (demoPromptsRef.current >= DEMO_PROMPT_LIMIT) {
        const reason = `Demo allowance khatam — aapke sirf ${DEMO_PROMPT_LIMIT} free prompts the. Jaari rakhne ke liye niche se ek plan choose karein.`
        setNotice(`✦ ${reason}`)
        onUpgrade?.(reason)
        return
      }
      demoPromptsRef.current += 1
      try { localStorage.setItem(DEMO_PROMPTS_KEY, String(demoPromptsRef.current)) } catch { /* private mode */ }
    }

    setActiveView('Chat')
    /* The user's own message is the only key: writing again lifts a past pause,
       unless THIS message is the one asking for quiet. */
    if (wantsQuiet(cleanPrompt)) {
      proactiveMutedRef.current = true
      try { localStorage.setItem(PROACTIVE_MUTE_KEY, '1') } catch { /* private mode */ }
      setNotice(`Got it — no messages from ${aiName} until you write again.`)
    } else if (proactiveMutedRef.current) {
      proactiveMutedRef.current = false
      try { localStorage.removeItem(PROACTIVE_MUTE_KEY) } catch { /* private mode */ }
    }
    lastActivityRef.current = Date.now()
    proactiveBusyRef.current = false
    proactiveNudgesRef.current = 0
    /* The draft was just sent, not taken back: clear the composer state so the
       setPrompt('') below can't read as the user withdrawing their words. */
    typedDraftRef.current = false
    draftWithdrawnRef.current = false
    setPrompt('')
    setPendingImgs([])
    attachCountRef.current = 0
    focusComposerRef.current = true
    /* A pinned reply targets exactly one turn: grab it, drop the chip, and stamp the
       new user message so the quote renders inside its bubble. */
    const reply = replyTarget
    setReplyTarget(null)
    /* Take the lock BEFORE any await so a second sendPrompt in this same tick is
       rejected, and use the monotonic counter for ids so they can never collide. */
    sendLockRef.current = true
    const seq = (msgSeqRef.current += 1)
    const tempUserId = `local_user_${seq}`
    const tempAsstId = `local_asst_${seq}`
    setMessages((prev) => [
      ...prev,
      { id: tempUserId, role: 'user', content: cleanPrompt, images: imgUrls.length ? imgUrls : undefined, replyTo: reply?.id, ts: Date.now() },
      { id: tempAsstId, role: 'assistant', content: spokenAck, streaming: true, ts: Date.now(), wakeAck: spokenAck || undefined },
    ])
    setStreaming(true)

    const controller = new AbortController()
    streamAbortRef.current = controller
    /* Kept out of state so the screenshot step below already has the stored id of the
       turn it is about to attach pictures to. */
    let assistantServerId = null
    /* Sentence-streaming TTS bookkeeping. We split the arriving text at
     * sentence boundaries inside `onDelta` and fire a synth request for
     * each complete sentence the moment it lands, so the user starts
     * hearing the first line while the model is still typing the second.
     * `spokeIdx` tracks how much of the raw stream we have already handed
     * to the speak queue. The final `streamFinal` flush mops up any
     * trailing partial sentence the model ended without punctuation. */
    let spokeIdx = 0
    /* Names this reply will speak aloud (the user's own name + the assistant's).
       Known ones are respelled client-side before the mic; this list lets the
       SERVER respell its provider audio and add a pronunciation line for names
       outside the small table. Ref-read because the proactive interval closure
       needs it too; first token only — that is what she actually says. */
    const speakNames = [aiName, (userProfile?.name || '').trim().split(/\s+/)[0]].filter(Boolean)
    const speakOpts = { language: voicePrefs.language, gender: voicePrefs.gender, voice: voicePrefs.voice, names: speakNames, authToken }
    const shouldStreamSpeak = Boolean(speakReplies && !voiceOpen)

    /* Recent visible turns, sent so a serverless chat endpoint (Vercel) can answer
       with context. The `messages` state here is the thread BEFORE the two temp
       bubbles we are about to append, so it is exactly the prior context. */
    const chatHistory = (messages || [])
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }))

    try {
      const result = await streamChat({
        token: authToken,
        message: promptForModel,
        history: chatHistory,
        assistantName: aiName,
        persona: voicePrefs.persona,
        gender: voicePrefs.gender,
        language: voicePrefs.language,
        images: imgUrls.length ? imgUrls : undefined,
        replyTo: reply && String(reply.id).startsWith('msg_') ? reply.id : undefined,
        replyToText: reply?.content,
        desktop: hasPairedAgent(),
        conversationId,
        signal: controller.signal,
        onDelta: (_chunk, fullText) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === tempAsstId ? { ...m, content: spokenAck + fullText } : m)),
          )
          /* Sentence-boundary TTS feed — skip if the user turned off auto-
             speak or is inside a VoiceCall (which has its own pipeline). We
             also never stream a cancelled turn. */
          if (shouldStreamSpeak && !controller.signal.aborted) {
            spokeIdx = streamFeed(fullText, spokeIdx, speakOpts)
          }
        },
        onMeta: (meta) => {
          if (meta.conversationId) setConversationId(meta.conversationId)
          /* The bubble keeps its local key (no remount, no replayed entrance animation);
             the stored msg_ id rides along as serverId so replying to a live answer
             links a real message that survives a reload. */
          if (meta.assistantMessageId) {
            assistantServerId = meta.assistantMessageId
            setMessages((prev) => prev.map((m) => (m.id === tempAsstId ? { ...m, serverId: meta.assistantMessageId } : m)))
          }
          /* Final-chunk wallet update — pushes the top-bar pill down without
             waiting for a /me refresh, so the drain is visible the moment the
             reply lands. */
          if (typeof meta.creditsRemaining === 'number') {
            setStreamedCredits(meta.creditsRemaining)
            /* Also merge the fresh number onto the parent's userProfile so
               the Settings chip (a different component scope) shows the same
               value as the top-bar pill — otherwise the two would disagree
               until the next /me refresh or page reload. */
            if (userProfile && typeof onProfileUpdate === 'function') {
              onProfileUpdate({ ...userProfile, creditsRemaining: meta.creditsRemaining })
            }
          }
          /* Live provider-quota tick — rides on the same final chunk, so the
             top-bar countdown moves the moment the answer lands. */
          if (meta.providerQuota && typeof meta.providerQuota.remaining === 'number') {
            setProviderQuota(meta.providerQuota)
          }
        },
      })

      setConversationId(result.conversationId)
      /* Keep the Chat surface's "Recent chats" panel honest: a thread that was
         just saved should show up without the user first having to visit Memory. */
      refreshConversations()
      /* Never finalize a blank bubble: an empty body (or pure whitespace) from the
         engine is replaced with a warm retry line, unless the user pressed Stop —
         then we keep the "stopped" signal instead of faking an answer. */
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== tempAsstId) return m
          const finalText = spokenAck + result.fullText
          const content = !finalText.trim() && !controller.signal.aborted ? emptyReplyFallback(voicePrefs.language, aiName) : finalText
          return { ...m, content, streaming: false, stopped: controller.signal.aborted }
        }),
      )
      setNotice(controller.signal.aborted ? `${aiName} stopped.` : `${aiName} replied.`)
      /* Auto-voice on the reply: only when the stream completed on its own
         (never on an abort — the user pressed Stop), the toggle is on, and we
         are not already inside a VoiceCall (that loop speaks through its own
         pipeline and must not be double-voiced). */
      if (speakReplies && !controller.signal.aborted && !voiceOpen) {
        /* Sentence streaming has already fired TTS requests for every
           complete sentence that landed during `onDelta`. Here we mop up
           any trailing partial sentence (e.g. a Hinglish reply that ends
           "sab theek" without a full stop) and schedule the mic re-arm to
           run exactly once when the whole queue drains. If NOTHING was
           streamed yet — the model returned a single short line with no
           terminal punctuation — `streamFinal` becomes the sole speak call
           and behaves like the legacy one-shot path. */
        const tailLen = (result.fullText || '').length - spokeIdx
        if (spokeIdx > 0 || tailLen > 0) {
          streamFinal(result.fullText, spokeIdx, { ...speakOpts, onEnd: () => { armNow(15000); setVoiceTurn(true) } })
        } else {
          armNow(15000); setVoiceTurn(true)
        }
      }
      /* She asked to be seen — so actually be seen: photograph the live app and hang
         the real shots on this turn instead of leaving a marker on screen. */
      await fulfilSelfScreenshots({
        tempId: tempAsstId,
        text: result.fullText,
        userText: cleanPrompt,
        conversationId: result.conversationId,
        serverId: assistantServerId,
      })
      /* Execute [DESKTOP:...] markers the AI emitted — opens apps, types text,
         presses keys, controls the browser, all on the user's real machine. */
      await fulfilDesktopActions({ tempId: tempAsstId, text: result.fullText })
      /* Execute [APP:...] markers — AI pausing/muting/resuming its own voice and mic. */
      fulfilAppControls({ tempId: tempAsstId, text: result.fullText })
    } catch (err) {
      /* Out-of-credits is NOT an error to alarm the user with — it is a normal
         product moment. Show it as a warm assistant reply (a real chat bubble,
         not a red error card) that explains the situation in the pinned reply
         language and points at the Upgrade CTA, and sync the pill to zero so
         the wallet is visibly empty before the next attempt. Every other
         failure keeps the previous error-card behaviour. */
      if (err?.status === 402 || err?.type === 'insufficient_credits') {
        setStreamedCredits(0)
        const lang = String(voicePrefs.language || 'auto').toLowerCase()
        const rechargeLine = lang === 'ur'
          ? 'آپ کے کریڈٹ ختم ہو گئے ہیں۔ براہ کرم کریڈٹ ری چارج کروا کر دوبارہ کوشش کریں — اپنی پروفائل آئیکن → اکاؤنٹ سیٹنگز → اپ گریڈ سے پلان بدل سکتے ہیں۔ ✨'
          : lang === 'hinglish'
            ? 'Aap ke credits khatam ho gaye hain 🙂 Thaham recharge karwao aur phir se milte hain — profile icon → Upgrade dabao, 2 second me ho jayega. ✨'
            : lang === 'en'
              ? 'You have run out of credits — please top up to keep chatting. Tap your profile icon → Upgrade to pick a plan. ✨'
              : 'Aap ke credits khatam ho gaye hain 🙂 Thaham recharge karwao aur phir se milte hain — profile icon → Upgrade dabao, 2 second me ho jayega. ✨'
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempAsstId
              ? { ...m, content: rechargeLine, streaming: false, error: false, creditsRejected: true }
              : m,
          ),
        )
        setNotice(`💳 ${aiName}: Credits khatam — upgrade panel se recharge karwao`)
        return
      }
      /* Daily token limit reached server-side: the client's copy was stale (the
         budget flipped to zero between the last reply and this send). Not an alarm
         — render a warm assistant line, lock the composer by marking the quota
         exhausted so the next send is blocked up-front, and keep the pill honest. */
      if (err?.type === 'quota_exhausted') {
        setProviderQuota((q) => ({ ...(q || {}), remaining: 0, exhausted: true }))
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempAsstId
              ? { ...m, content: err.message || `🪫 Aaj ka token limit khatam — reset ke baad baat karte hain.`, streaming: false, error: false }
              : m,
          ),
        )
        setNotice(`🪫 ${aiName}: Daily token limit khatam — reset par wapis milte hain`)
        return
      }
      /* The live engine can't answer right now — either no AI server is reachable
         (the static Vercel deploy has no Express backend, or the user is offline)
         or Groq's free-tier budget throttled us mid-conversation (429). Both feel
         the same to the person chatting: silence. So answer locally with a warm
         demo reply instead of a red error card — the chat keeps moving and never
         stalls. A live backend always wins; this only fires when it genuinely
         can't reply. */
      if (isEngineUnavailable(err)) {
        const demoText = localDemoReply(cleanPrompt, aiName, voicePrefs.language)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempAsstId
              ? { ...m, content: spokenAck + demoText, streaming: false, error: false, demo: true }
              : m,
          ),
        )
        setNotice(err?.status === 429 || err?.type === 'rate_limit'
          ? `${aiName}: AI is busy right now — replied locally. Try again in a minute ✨`
          : `${aiName} replied (demo mode)`)
        return
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempAsstId
            ? { ...m, content: spokenAck + (err.message || 'Something went wrong.'), streaming: false, error: true }
            : m,
        ),
      )
      setNotice(err.message || 'Chat failed — please try again in a moment.')
    } finally {
      setStreaming(false)
      sendLockRef.current = false
      streamAbortRef.current = null
      lastActivityRef.current = Date.now()
    }
  }

  /* Stop Aira mid-generation: cancel the stream and keep what already rendered.
     The backend aborts the provider call too, so no more credits are spent.
     Also kill any spoken reply — auto-voice is currently streaming her answer
     through speechSynthesis and pressing Stop must silence it instantly. */
  function stopGeneration() {
    streamAbortRef.current?.abort()
    /* Cancel both the legacy one-shot speak pipeline AND any sentence
       streaming queue still waiting to play, so pressing Stop is a hard
       silence even when the model has already finished typing and we are
       mid-way through a 3-sentence reply. */
    cancelSpeakQueue()
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
    cancelServerAudio()
  }

  /* "Reply" on an AI bubble: pin that one turn as the target and hand focus to the
     composer, so the next message answers it specifically instead of the whole thread.
     serverId is preferred — it is the id the backend actually stored. */
  function startReply(message) {
    setReplyTarget({ id: message.serverId || message.id, content: withoutShotMarkers(message.content) })
    promptInputRef.current?.focus()
  }

  /* Copy a finished turn's plain text to the clipboard. Screenshots markers are
     stripped so the pasted text is clean prose, and the button confirms with a
     transient "✓ Copied" (reusing the same id-keyed state) so the click is felt. */
  function copyMessage(message) {
    const text = withoutShotMarkers(message.content || '')
    if (!text) return
    const done = () => {
      setCopiedMsgId(message.id)
      window.setTimeout(() => setCopiedMsgId((cur) => (cur === message.id ? null : cur)), 1600)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { /* fall through */ })
    } else {
      try {
        const ta = document.createElement('textarea')
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
        done()
      } catch { /* ignore */ }
    }
  }

  /* One self-screenshot. Her face is rendered off-screen for the shot (no face is
     mounted once a thread is open); every other target needs the real page, so open
     it, wait out the entrance transform, photograph it, then put the user back. */
  async function takeSelfShot(target) {
    const spec = SHOT_TARGETS[target] || SHOT_TARGETS.screen
    if (spec.face) return captureSelfFace({ shape: voicePrefs.gender === 'male' ? 'male' : 'female' })
    const previous = view
    if (spec.view && spec.view !== previous) {
      setActiveView(spec.view)
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    try {
      return spec.full
        ? await captureNode(document.getElementById('workspace'))
        : await captureCurrentPage()
    } finally {
      if (spec.view && spec.view !== previous) {
        setActiveView(previous)
        /* The thread remounts at scrollTop 0, so walk back down to the live turn. */
        await new Promise((resolve) => setTimeout(resolve, 80))
        chatEndRef.current?.scrollIntoView({ block: 'end' })
      }
    }
  }

  /* Fulfil [APP:command|json] markers: the AI is controlling its OWN features
     (pause/resume/mute/mic) via React state changes. No backend round-trip
     needed — these are synchronous toggles that take effect immediately. The
     next user message in the composer also auto-resumes from a pause. */
  function fulfilAppControls({ tempId, text }) {
    const markers = [...String(text || '').matchAll(/\[APP:([a-z-]+)\|(.+?)\]/gi)]
    if (!markers.length) return
    let updatedText = text
    for (const m of markers) {
      const cmd = m[1].toLowerCase()
      const full = m[0]
      let args = {}
      try { args = JSON.parse(m[2]) } catch { /* empty object is fine for most commands */ }
      switch (cmd) {
        case 'pause':
          /* Same voice-wake sleep as the typed/spoken command: mic stays ON so
             "Aira"/"listen" revives her — NOT the old setWakeEnabled(false) that
             forced typing. speak:false because the model already said its own
             goodbye in this very reply. */
          goToSleep({ speak: false })
          updatedText = updatedText.replace(full, `✅ Chup — jab bulao bas "${aiName}" ya "listen" bol dena.`)
          break
        case 'resume':
          setWakeEnabled(true)
          setSpeakReplies(true)
          try { localStorage.setItem('nexora_speak_replies', '1') } catch { /* ignore */ }
          voiceAsleepRef.current = false
          setVoiceAsleep(false)
          updatedText = updatedText.replace(full, '✅ Resumed — bol sakti hoon!')
          break
        case 'mute':
          setSpeakReplies(false)
          try { localStorage.setItem('nexora_speak_replies', '0') } catch { /* ignore */ }
          if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } }
          cancelServerAudio()
          updatedText = updatedText.replace(full, '✅ Voice off — sirf text.')
          break
        case 'unmute':
          setSpeakReplies(true)
          try { localStorage.setItem('nexora_speak_replies', '1') } catch { /* ignore */ }
          updatedText = updatedText.replace(full, '✅ Voice on — bol dungi.')
          break
        case 'mic-off':
          setWakeEnabled(false)
          updatedText = updatedText.replace(full, '✅ Mic off — sun nahi rahi.')
          break
        case 'mic-on':
          setWakeEnabled(true)
          updatedText = updatedText.replace(full, '✅ Mic on — sun rahi hoon.')
          break
        case 'volume': {
          const level = Math.max(0, Math.min(1, args.level ?? 0.7))
          /* Route through the desktop agent's system volume if available. */
          updatedText = updatedText.replace(full, `✅ Volume set to ${Math.round(level * 100)}%`)
          break
        }
        default:
          updatedText = updatedText.replace(full, `\u26a0\ufe0f Unknown app command: ${cmd}`)
      }
    }
    if (updatedText !== text) {
      setMessages((prev) => prev.map((msg) => msg.id === tempId ? { ...msg, content: updatedText } : msg))
    }
  }

  /* Fulfil [DESKTOP:action|json] markers: the AI proposed a system action and
     the frontend executes it via the loopback agent's plan→execute pipeline.
     All scopes are auto-granted on first use (user opted into full access by
     starting the agent). The `approvedThisAction: true` flag bypasses the
     per-action confirmation gate so actions like desktop.type, desktop.key and
     files.write run without extra clicking. */
  async function fulfilDesktopActions({ tempId, text }) {
    const markers = [...String(text || '').matchAll(/\[DESKTOP:([a-z._]+)\|(.+?)\]/gi)]
    if (!markers.length) return
    /* Transport: a paired browser drives its OWN local agent directly (the cloud
       backend can't reach a remote loopback); with no client token we fall back to
       the authenticated backend proxy for self-host / local-first installs. Keep the
       resolved transport in a ref so the later Approve click uses the same route. */
    const direct = agentTransport()
    desktopTransportRef.current = direct
    /* Auto-grant all scopes once per session — the agent refuses to execute
       actions whose scope is not granted, so the first marker would fail if we
       skip this. runCommand sits in the auto-granted 'system' scope, yet the
       agent's alwaysConfirm gate still stops it here for a per-command Approve. */
    if (!desktopAutoGranted.current) {
      try {
        await Promise.all(['browser', 'files', 'apps', 'system', 'screen', 'desktop'].map((scope) => (direct ? direct.grant({ scope }) : desktopGrant(authToken, { scope }))))
        desktopAutoGranted.current = true
      } catch { /* agent might be offline; the per-action plan below surfaces a clearer error */ }
    }
    let updatedText = text
    const pendingCmds = []
    for (const m of markers) {
      const action = m[1].toLowerCase()
      const full = m[0]
      let args
      try { args = JSON.parse(m[2]) } catch { updatedText = updatedText.replace(full, `\u26a0\ufe0f Invalid desktop args: ${m[2]}`); continue }
      /* A terminal / CMD command is the one open-ended thing the agent can do, so it
         is NEVER auto-run. We take the agent's plan (validated args + the ⚠ preview),
         park it on the message and wait for a real click on Approve — which alone
         sends approvedThisAction:true. Every other action stays one-tap automatic. */
      if (action === 'system.runCommand') {
        try {
          const plan = direct ? await direct.plan({ action, args, context: { fromVoice: false } }) : await desktopPlan(authToken, { action, args, context: { fromVoice: false } })
          if (!plan.planId) { updatedText = updatedText.replace(full, `\u26a0\ufe0f ${plan.reason || 'Agent refused: ' + (plan.status || 'unknown')}`); continue }
          pendingCmds.push({ planId: plan.planId, command: String(args.command || ''), preview: plan.preview || `Run: ${args.command}`, status: 'pending', result: '', error: '' })
          updatedText = updatedText.replace(full, `\u23f3 ${aiName} wants to run a terminal command on this PC \u2014 review it below and tap \u25b6 Run.`)
        } catch (err) {
          updatedText = updatedText.replace(full, `\u26a0\ufe0f ${err.message || 'Desktop agent unavailable — is it running? Start with: npm run dev:agent'}`)
        }
        continue
      }
      try {
        const plan = direct ? await direct.plan({ action, args, context: { fromVoice: false } }) : await desktopPlan(authToken, { action, args, context: { fromVoice: false } })
        if (!plan.planId) { updatedText = updatedText.replace(full, `\u26a0\ufe0f ${plan.reason || 'Agent refused: ' + (plan.status || 'unknown')}`); continue }
        const result = direct ? await direct.execute({ planId: plan.planId, approvedThisAction: true }) : await desktopExecute(authToken, { planId: plan.planId, approvedThisAction: true })
        if (result.ok === false) {
          updatedText = updatedText.replace(full, `\u26a0\ufe0f ${result.reason || result.error || 'Action failed.'}`)
        } else {
          const summary = result.output?.preview || result.output?.message || result.status || 'Done.'
          updatedText = updatedText.replace(full, `\u2705 ${action} — ${summary}`)
        }
      } catch (err) {
        updatedText = updatedText.replace(full, `\u26a0\ufe0f ${err.message || 'Desktop agent unavailable — is it running? Start with: npm run dev:agent'}`)
      }
    }
    /* Replace the markers in the displayed message with execution results, and mount
       any queued terminal commands as an inline Approve / Cancel card. */
    if (updatedText !== text || pendingCmds.length) {
      setMessages((prev) => prev.map((msg) => msg.id === tempId ? { ...msg, content: updatedText, ...(pendingCmds.length ? { pendingDesktop: [...(msg.pendingDesktop || []), ...pendingCmds] } : {}) } : msg))
    }
  }

  /* Approve one parked terminal command: the human click is the approval, so this is
     the only path that sends approvedThisAction:true for runCommand. The agent's
     execute() shape is { ok, status, action, result:{ exitCode, stdout, stderr } }.
     We render the return code plus stdout/stderr and drop the plan so it can't run
     twice — expired plans (5-minute TTL) tell them to just ask again. */
  async function approveDesktopCommand(msgId, index) {
    const msg = messages.find((mm) => mm.id === msgId)
    const item = msg?.pendingDesktop?.[index]
    if (!item || item.status !== 'pending') return
    const mark = (patch) => setMessages((prev) => prev.map((mm) => mm.id !== msgId ? mm : {
      ...mm,
      pendingDesktop: (mm.pendingDesktop || []).map((it, i) => (i === index ? { ...it, ...patch } : it)),
    }))
    mark({ status: 'running' })
    const direct = desktopTransportRef.current || agentTransport()
    try {
      const res = direct ? await direct.execute({ planId: item.planId, approvedThisAction: true }) : await desktopExecute(authToken, { planId: item.planId, approvedThisAction: true })
      if (res.ok === false) {
        const why = res.status === 'expired' ? 'That approval timed out \u2014 ask me again and I will re-run it.' : (res.reason || res.error || 'The agent refused to run it.')
        mark({ status: 'error', error: why })
        return
      }
      const r = res.result || {}
      const head = `exit ${r.exitCode ?? '?'}`
      const tail = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(0, 6000)
      mark({ status: 'done', result: `${r.ok ? '\u2705' : '\u26a0\ufe0f'} ${head}${r.timedOut ? ` \u2014 ${r.note || 'timed out'}` : ''}${tail ? `\n${tail}` : ''}` })
    } catch (err) {
      mark({ status: 'error', error: err.message || 'Could not reach the desktop agent.' })
    }
  }

  /* Decline a parked command. We never execute it; the short-lived plan simply ages
     out on the agent, so there is nothing to clean up beyond updating the card. */
  function declineDesktopCommand(msgId, index) {
    setMessages((prev) => prev.map((mm) => mm.id !== msgId ? mm : {
      ...mm,
      pendingDesktop: (mm.pendingDesktop || []).map((it, i) => (i === index ? { ...it, status: 'declined' } : it)),
    }))
  }

  /* Fulfil [SCREENSHOT:…]: capture it for real → upload it → show it in the bubble →
     tell the backend, so the same picture is still there after a reload. A user who
     asks to see her face gets it even when the model forgot the marker and only
     described one, which is exactly the failure this replaces. */
  async function fulfilSelfScreenshots({ tempId, text, userText, conversationId, serverId }) {
    const marked = [...new Set([...String(text || '').matchAll(/\[SCREENSHOT:([a-z]+)\]/gi)]
      .map((m) => m[1].toLowerCase())
      .filter((target) => SHOT_TARGETS[target]))]
    const askedForSelf = SELF_OWNER_RE.test(userText || '') && SELF_UI_RE.test(userText || '')
    const wanted = marked.length ? marked : askedForSelf ? selfUiTargets(userText) : []
    if (!wanted.length) return
    setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, shooting: true } : m)))
    const shots = []
    const done = []
    for (const target of wanted.slice(0, 3)) {
      try {
        const uploaded = await uploadChatImage(authToken, await takeSelfShot(target))
        if (uploaded?.url) { shots.push(uploaded.url); done.push(target) }
      } catch (err) {
        setNotice(err.message || 'Could not take that screenshot.')
      }
    }
    const markers = done.map((target) => `[SCREENSHOT:${target}]`)
    setMessages((prev) => prev.map((m) => {
      if (m.id !== tempId) return m
      /* Land the reply on exactly the text the server ends up storing: append only the
         markers she did not write herself, so a fallback capture gets its caption chip
         too and a marker that was already there is never shown twice. */
      const missing = markers.filter((marker) => !String(m.content || '').includes(marker))
      return {
        ...m,
        shooting: false,
        images: shots.length ? shots : undefined,
        content: missing.length ? `${m.content}\n\n${missing.join('\n\n')}` : m.content,
      }
    }))
    if (!shots.length || !conversationId || !serverId) return
    /* Live shot already on screen; a failed save costs persistence, never the reply. */
    try {
      await attachMessageImages(authToken, conversationId, serverId, shots, markers)
    } catch {
      setNotice('Screenshot shown — but it will not be in this thread after a reload.')
    }
  }

  /* Wake-word listener — say "Aira, <command>" from any section and the chat
     takes over. Auto-armed the moment a signed-in session mounts the
     workspace: no header button is required any more, so "Listen Aira"
     actually lands the first time. The user can still pause it via the small
     Stop-mic pill inside the chat composer, and it always pauses while the
     VoiceCall overlay is up (one mic, one engine, no double transcripts).
     `sendPrompt` is a plain function declaration, so its closure is fine
     here (the hook holds it in a ref and refreshes each render). */
  const [wakeEnabled, setWakeEnabled] = useState(true)
  /* Ref mirror so the proactive idle interval (defined earlier in the body, but
     its callback runs after render) can read the LIVE mic state and stay quiet
     whenever the user paused her — a paused assistant must not send messages. */
  const wakeEnabledRef = useRef(wakeEnabled)
  wakeEnabledRef.current = wakeEnabled
  /* Owner voice lock (see ownerVoice.js): once the owner has registered a
     voiceprint, spoken commands from any other voice get a polite refusal
     instead of being obeyed. Typed chat is unaffected — the account itself is
     the owner's. The record is re-read whenever Settings/enrollment saves. */
  const ownerKey = userProfile?.id || userProfile?.email
  const [ownerVoiceRev, setOwnerVoiceRev] = useState(0)
  const ownerVoice = useMemo(() => loadOwnerVoice(ownerKey), [ownerKey, ownerVoiceRev])
  const ownerVoiceRef = useRef(ownerVoice)
  ownerVoiceRef.current = ownerVoice
  useEffect(() => {
    const sync = () => setOwnerVoiceRev((n) => n + 1)
    window.addEventListener('nexora-owner-voice', sync)
    return () => window.removeEventListener('nexora-owner-voice', sync)
  }, [])
  const [ownerPromptDismissed, setOwnerPromptDismissed] = useState(() => {
    try { return sessionStorage.getItem('nexora_owner_voice_prompt') === '0' } catch { return false }
  })
  const ownerLockOn = Boolean(ownerVoice && ownerVoice.enabled !== false)
  /* The voiceprint needs its own feature tap on the mic alongside the wake-word
     recogniser; it runs exactly while the always-on mic does. */
  useEffect(() => {
    if (!ownerLockOn || !wakeEnabled || voiceOpen || !isLoggedIn || !authToken) return undefined
    let release = null
    let cancelled = false
    acquireVoiceTap().then((r) => { if (cancelled) r(); else release = r }).catch(() => { /* mic blocked — the wake hook surfaces that */ })
    return () => { cancelled = true; release?.() }
  }, [ownerLockOn, wakeEnabled, voiceOpen, isLoggedIn, authToken])
  /* Returns true when the speech just heard may be obeyed. A stranger gets the
     refusal line spoken + shown, and nothing else happens. `short` marks a bare
     wake word: too little audio to judge, so only a confident 'stranger' blocks. */
  function ownerVoiceAllows({ short = false } = {}) {
    const rec = ownerVoiceRef.current
    if (!rec || rec.enabled === false) return true
    const { verdict } = verifyRecentSpeech(rec)
    if (verdict === 'owner' || verdict === 'off') return true
    if (verdict === 'unsure' && short) return true
    const line = strangerReply(rec.ownerName || userProfile?.name, voicePrefs.gender)
    setNotice(verdict === 'unsure' ? `🔒 Awaaz saaf nahi suni — ${aiName} sirf owner ki baat maanti hai. Dobara thora lamba boliye.` : `🔒 ${aiName}: "${line}"`)
    if (verdict === 'stranger') speakWakeLine(line, { language: voicePrefs.language, gender: voicePrefs.gender })
    return false
  }
  /* "Your turn" indicator: true between the AI finishing a spoken reply and
     the user starting their next utterance (or the 15 s window expiring). The
     mic pill reads it to show "your turn" instead of "listening" so the user
     knows they can just talk — no name, no click. */
  const [voiceTurn, setVoiceTurn] = useState(false)
  /* "Chup ho jao" sleep mode. When true the assistant stays silent: no replies
     are streamed, no proactive check-ins fire, and the auto-listen conversation
     loop does not re-arm. The wake-word mic keeps running (wakeEnabled stays on)
     so saying her NAME or "listen" wakes her. A ref mirrors it because the wake
     callbacks and the idle interval read it from async closures. */
  const [voiceAsleep, setVoiceAsleep] = useState(false)
  const voiceAsleepRef = useRef(voiceAsleep)
  voiceAsleepRef.current = voiceAsleep
  /* Auto-voice on replies: when the stream lands, we speak the answer out
     loud. Users who prefer silence can toggle this from the composer. */
  const [speakReplies, setSpeakReplies] = useState(() => {
    try { return localStorage.getItem('nexora_speak_replies') !== '0' } catch { return true }
  })
  /* Ref mirror so the proactive setInterval callback (which closes over
     values from the render it was created in) always sees the live toggle. */
  const speakRepliesRef = useRef(speakReplies)
  speakRepliesRef.current = speakReplies
  const voiceOpenRef = useRef(voiceOpen)
  voiceOpenRef.current = voiceOpen
  /* The in-progress interim transcript — Chrome refines it every ~200 ms while
     the user is still speaking, so their words appear on screen before the
     recogniser commits. Cleared on every final / restart / unmount by the hook. */
  const [wakeLive, setWakeLive] = useState('')
  const { status: wakeStatus, armNow } = useWakeWord({
    enabled: wakeEnabled && !voiceOpen && isLoggedIn && Boolean(authToken),
    wakeWord: aiName,
    /* Only when asleep does "listen" / "suno" act as a wake word. Awake, this is
       empty so those ordinary words never hijack a sentence. */
    wakeAliases: voiceAsleep ? SLEEP_RESUME_ALIASES : [],
    /* Hear commands in the same language the Talk call uses. Without this the
       always-on mic stays on en-US and a task spoken in Urdu/Roman Urdu arrives
       mangled (e.g. just "hi"), so the instruction never reaches the model. */
    language: voicePrefs.language,
    onInterim: (text) => setWakeLive(text),
    /* Barge-in: the second the always-on mic hears the user starting to talk,
       kill the AI's current utterance — server <audio> and browser
       speechSynthesis both — so she stops mid-sentence and lets them speak,
       exactly like two humans chatting. The 800 ms floor inside
       `isAiSpeakingLongEnough` protects against her own voice echoing back
       through the mic and cancelling herself. `voiceTurn` is cleared so the
       pill flips from "your turn" back to "listening" for the user's input. */
    onUserSpeaking: () => {
      /* Unconditional: record that the human is talking, whatever happens
         below. The idle check-in loop reads this to avoid interrupting a spoken
         turn; the barge-in work underneath only matters while she is audible.
         The 400 ms re-fire while speech continues ALSO restarts the idle clock,
         so a long spoken turn buys a full quiet window AFTER it ends instead of
         a stale 30 s count that expired mid-sentence. */
      markUserSpeaking()
      lastActivityRef.current = Date.now()
      if (!isAiSpeakingLongEnough()) return
      cancelServerAudio()
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } }
      setVoiceTurn(false)
    },
    onWake: (raw) => {
      /* A bare name (or "listen") heard while asleep IS the wake signal: clear
         the flag. `fireWake` already opened the command window, so the very next
         utterance is picked up as a command. The "Ji, boliye" ack is now a VISUAL
         toast only — she must NOT read it aloud. Speaking it made her vocalise the
         notification (and talk over the real reply that follows), which the user
         flagged as wrong; the green "your turn" mic pill is the listening cue. */
      if (!ownerVoiceAllows({ short: true })) return
      if (voiceAsleepRef.current) { voiceAsleepRef.current = false; setVoiceAsleep(false) }
      const heard = (raw || aiName).trim()
      const ack = WAKE_ACK_LINES[voicePrefs.language]?.wake || WAKE_ACK_LINES.auto.wake
      setNotice(`🎙 Heard: "${heard}" — ${aiName}: "${ack}"`)
    },
    onCommand: (cmd) => {
      /* Owner voice lock first: a stranger's command is refused before it can
         wake her, stop her, or reach the model. */
      if (!ownerVoiceAllows()) return
      /* Name + command while asleep: wake silently (no extra ack — the real
         reply that follows is confirmation enough) and run the command. */
      if (voiceAsleepRef.current) { voiceAsleepRef.current = false; setVoiceAsleep(false) }
      /* `sendPrompt` early-returns while a stream is running or an attachment
         is uploading; a silent drop reads to the user as "the mic never
         caught it", so we surface the real reason here instead of the
         generic Heard notice. */
      if (streaming) {
        setNotice(`⏳ ${aiName} abhi reply kar rahi hai — "${cmd}" baad me dobara bolo`)
        return
      }
      /* The ack is a NOTIFICATION, not a line of dialogue. A previous build
         SPOKE the rotating placeholder ("Bilkul, abhi karti hoon.") before the
         real reply, which read to the user as (a) the AI reading the toast aloud
         and (b) a false promise — she claims the task is done/under way before
         the model has answered at all. So the command ack is now VISUAL ONLY
         (a silent "I heard you" toast) and the AI's real streamed reply is the
         only thing spoken. The wake ack is visual-only too, for the same reason. */
      setNotice(`🎙 You: "${cmd}"`)
      sendPrompt(null, cmd, {})
    },
  })
  /* Bridge for the proactive effect's speak-onEnd which can't list `armNow`
     in its deps without resetting the idle interval every render. */
  armNowRef.current = armNow

  /* Conversation loop: auto-arm the mic the moment the user lands in the
     workspace (login / page reload). The first utterance is treated as a
     command without needing "Aira" — the user just talks. After every spoken
     reply the onEnd callback in sendPrompt re-arms for 15 s so the back-and-forth
     feels like two humans chatting, not a push-to-talk toy. */
  useEffect(() => {
    if (wakeEnabled && isLoggedIn && authToken) {
      /* Small delay so the recogniser has time to fire onstart before the
         arming window opens; otherwise the first 350 ms of speech is lost. */
      const t = setTimeout(() => armNow(8000), 600)
      return () => clearTimeout(t)
    }
    return undefined
  }, [wakeEnabled, isLoggedIn, authToken, armNow])

  /* Clear the "your turn" chip when the armed window expires so the pill
     reverts to "listening". A 16 s timer matches the armNow(15000) below. */
  useEffect(() => {
    if (!voiceTurn) return undefined
    const t = setTimeout(() => setVoiceTurn(false), 16000)
    return () => clearTimeout(t)
  }, [voiceTurn])

  return <main className="workspace-shell" id="workspace">
    {/* The floating account dock is gone — the account drawer now drops down from
        the topbar profile button, so the workspace owns the full viewport. */}
    <section className="workspace-main">
      <header className="workspace-topbar">
        <Brand compact />
        {/* Primary workspace nav. The bottom mobile-workspace-nav is display:none and
           the old dock was removed (Settings lives in the account drawer), so
           Chat/Schedule/Memory/Tools are otherwise unreachable — expose them here. */}
        <nav className="workspace-nav" aria-label="Workspace navigation">{['Chat', 'Schedule', 'Memory', 'Tools', 'Desktop'].map((label) => <button type="button" key={label} className={`workspace-nav-btn${view === label ? ' selected' : ''}`} aria-current={view === label ? 'page' : undefined} onClick={() => setActiveView(label)}>{label}</button>)}</nav>
        <div className="workspace-actions">
          {/* The Wake and Talk buttons are gone from the topbar: the wake-word
              auto-arms on login (see `wakeEnabled` above) and the voice surface
              lives inside the chat composer as a small inline pill. This keeps
              the header clean and stops the mic from feeling like an opt-in. */}
          {/* Live wallet pill. Free accounts see their own credit count (amber
              under 20, red-throb at 0). Premium accounts have no meaningful credit
              number, so instead of a static "Unlimited" the pill now shows the
              PRIMARY model's remaining daily token budget — a live countdown that
              ticks after every reply, goes amber near the wall and throb-red at 0
              (when failover takes over). Both numbers roll down smoothly through
              `CreditsValue` ("ulta countdown") and pop a -N chip when they change.
              Clicking the pill on a free account opens the upgrade panel. */}
          {isLoggedIn && (() => {
            const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`)
            if (isPremium) {
              if (!providerQuota) {
                return (
                  <button className="header-credits-pill credits-unlimited" type="button" title="Premium — unlimited credits">
                    <span className="credits-icon" aria-hidden="true">∞</span>
                    <span className="credits-value">Unlimited</span>
                    <span className="credits-label">Plan</span>
                  </button>
                )
              }
              /* Local-device pass (backend config.localUnlimitedTokens): this session
                 reached the API over loopback, so the server already refused to gate
                 it — the pill says ∞ instead of counting down to a lock-out that can
                 never arrive. Checked BEFORE the ratio maths, otherwise a spent budget
                 would still colour the pill red. */
              if (providerQuota.unlimited) {
                return (
                  <button className="header-credits-pill credits-unlimited" type="button" title="Local device — daily token limit bypassed">
                    <span className="credits-icon" aria-hidden="true">∞</span>
                    <span className="credits-value">Unlimited</span>
                    <span className="credits-label">Local</span>
                  </button>
                )
              }
              const { remaining, limit } = providerQuota
              const low = limit > 0 && remaining / limit <= 0.15
              const state = remaining <= 0 ? ' credits-empty' : low ? ' credits-warning' : ''
              return (
                <button
                  className={`header-credits-pill${state}`}
                  type="button"
                  title={remaining <= 0 ? 'Aaj ka primary model quota khatam — backup model chal raha hai' : `Aaj ${fmtTokens(remaining)} tokens bache hain (limit ${fmtTokens(limit)}) — ${new Date(providerQuota.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ko reset`}
                >
                  <span className="credits-icon" aria-hidden="true"><Icon name={remaining <= 0 ? 'warn' : 'sparkle'} size={15} /></span>
                  <CreditsValue value={remaining} format={fmtTokens} />
                  <span className="credits-label">tokens left</span>
                </button>
              )
            }
            return (
              <button
                className={`header-credits-pill${creditsRemaining === 0 ? ' credits-empty' : creditsRemaining <= 20 ? ' credits-warning' : ''}`}
                type="button"
                onClick={() => { if (onUpgrade) onUpgrade() }}
                title={`Aap ke paas ${creditsRemaining} credits bache hain${creditsRemaining === 0 ? ' — recharge karne ke liye click karein' : ''}`}
              >
                <span className="credits-icon" aria-hidden="true"><Icon name={creditsRemaining === 0 ? 'warn' : 'sparkle'} size={15} /></span>
                <CreditsValue value={creditsRemaining} />
                <span className="credits-label">credits</span>
              </button>
            )
          })()}
          {/* The upgrade button only rides next to the pill for signed-out
              visitors — a logged-in free user already opens the upgrade panel
              by clicking the wallet pill itself, so the second "✦ Upgrade"
              CTA was just clutter on top of the number. */}
          {!isLoggedIn && (
            <button
              className="header-upgrade-btn"
              type="button"
              onClick={() => {
                if (onUpgrade) onUpgrade()
              }}
            >
              <Icon name="sparkle" size={14} /> Upgrade
            </button>
          )}
          <div className="account-anchor">
            <button
              className="account-button"
              type="button"
              onClick={() => {
                if (isLoggedIn) {
                  setAccountDrawerOpen(!accountDrawerOpen)
                } else {
                  onLogin()
                }
              }}
              aria-expanded={accountDrawerOpen}
              aria-haspopup="dialog"
            >
              <span className="profile-avatar">{userAvatar ? <img src={userAvatar} alt="" className="avatar-img" referrerPolicy="no-referrer" /> : userInitial}</span>
              <span>{isLoggedIn ? userName : 'Log in'}</span>
              <b className={`chevron-arrow ${accountDrawerOpen ? 'drawer-active' : ''}`} aria-hidden="true"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5 6 7.5 9 4.5" /></svg></b>
            </button>

            {/* Account drawer — same options that lived in the removed dock */}
            {accountDrawerOpen && (
              <div className="account-drawer-popup" role="dialog" aria-label="Account and Workspace Options">
                <div className="drawer-header">
                  <span className="drawer-avatar">{userAvatar ? <img src={userAvatar} alt="" className="avatar-img" referrerPolicy="no-referrer" /> : userInitial}</span>
                  <div className="drawer-user-info">
                    <strong>{isLoggedIn ? userName : 'Guest User'}</strong>
                    <span>{isLoggedIn ? userEmail : 'Sign in to sync your work'}</span>
                  </div>
                  <span className="drawer-badge">{isPremium ? (userProfile?.plan === 'yearly_pro' ? 'Yearly Pro' : 'Pro') : 'Starter'}</span>
                </div>

                <button
                  type="button"
                  className="drawer-connect-btn"
                  onClick={() => {
                    setAccountDrawerOpen(false)
                    onLogin()
                  }}
                >
                  <span>＋</span> Switch / Connect Another Account
                </button>

                <button
                  type="button"
                  className="drawer-connect-btn"
                  style={{ borderStyle: 'solid' }}
                  onClick={() => {
                    setAccountDrawerOpen(false)
                    setActiveView('Memory')
                  }}
                >
                  <Icon name="memory" size={15} /> Memory &amp; chats
                </button>

                <button
                  type="button"
                  className="drawer-connect-btn"
                  style={{ borderStyle: 'solid' }}
                  onClick={() => {
                    setAccountDrawerOpen(false)
                    setActiveView('Settings')
                  }}
                >
                  <Icon name="settings" size={15} /> Account Settings
                </button>

                {isLoggedIn && (
                  <button
                    type="button"
                    className="drawer-logout-btn"
                    onClick={() => {
                      setAccountDrawerOpen(false)
                      onLogout()
                    }}
                  >
                    <Icon name="logout" size={15} /> Log Out
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="workspace-content" key={view}>
        {scheduleReminder && <div className="reminder-card" role="status">
          <span className="reminder-icon" aria-hidden="true"><Icon name="schedule" size={18} /></span>
          <div className="reminder-body"><b>{aiName} · Schedule reminder</b><p>{scheduleReminder.content}</p></div>
          <button type="button" className="reminder-close" aria-label="Dismiss reminder" onClick={() => setScheduleReminder(null)}>×</button>
        </div>}
        {view === 'Chat' && <section className={`workspace-page-panel chat-page${messages.length ? ' has-thread' : ''}`}>
          {messages.length === 0 ? (
            <>
              <div className="chat-hero">
                <div className="chat-hero-orbwrap" aria-hidden="true">
                  <svg className="chat-hero-waves" viewBox="0 0 420 120" preserveAspectRatio="none"><path d="M0 60 Q 105 8 210 60 T 420 60" /><path d="M0 60 Q 105 112 210 60 T 420 60" /></svg>
                  <span className="chat-hero-orb"><i><Icon name="sparkle" size={22} /></i></span>
                </div>
                <h1 className="chat-hero-title">Hello <span className="chat-hero-name">{userName}</span></h1>
                <p className="chat-hero-sub">I’m {aiName} — your AI companion.<br />Ask me anything, I’m here to help.</p>
                <div className="chat-hero-starters">{chatStarters.map((s) => (
                  <button type="button" key={s.label} onClick={() => sendPrompt(null, s.label)}><Icon name={s.icon} size={15} />{s.label}</button>
                ))}</div>
              </div>
              <span className="chat-hero-corner" aria-hidden="true">{aiName} · Personal · Always With You</span>
              <span className="chat-hero-online" aria-hidden="true"><i />{aiName} is online</span>
              <div className="chat-hero-bond" aria-hidden="true"><b>YOU</b><span>+</span><em>{aiName}</em><u>∞</u></div>
            </>
          ) : (
            <>
              <div className="chat-face" aria-hidden="true">
                <div className="chat-face-stage">
                  <Suspense fallback={null}>
                    <NanoParticles count={16000} shape={voicePrefs.gender === 'male' ? 'male' : 'female'} state={streaming ? (messages.some((m) => m.streaming && m.content) ? 'talking' : 'thinking') : prompt.trim() ? 'listening' : 'idle'} />
                  </Suspense>
                </div>
              </div>
              <div className="chat-body">
              <div className="chat-thread-bar">
                <span className="chat-thread-title">{aiName}<b className="chat-thread-dot" aria-hidden="true" /></span>
                <button type="button" className="chat-new-thread" onClick={startNewChat}><Icon name="plus" size={14} /> New chat</button>
              </div>
              <div className="chat-thread chat-thread-in" role="log" aria-live="polite">
                {messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m, i) => {
                  /* One flex ROW per turn (avatar + bubble) so turns can never
                     overlap — the old align-self bubbles risked exactly that. */
                  const mine = m.role === 'user'
                  const initial = (mine ? userName : aiName).trim().charAt(0).toUpperCase() || (mine ? 'U' : 'A')
                  /* The quote is read back from the live thread — reply_to stores only the
                     id, so the same text is never duplicated in storage or state. A live
                     bubble is keyed locally, so match its stored id too. */
                  const quoted = m.replyTo ? messages.find((x) => x.id === m.replyTo || x.serverId === m.replyTo) : null
                  const quoteText = quoted ? withoutShotMarkers(quoted.content).replace(/\s+/g, ' ') : ''
                  /* Only a finished, real answer gets a Reply handle — never a thinking
                     bubble, an error card or the user's own turn. */
                  const replyable = !mine && !m.streaming && !m.error && Boolean(m.content)
                  /* Any finished turn — hers or the user's — can be copied verbatim. */
                  const copyable = !m.streaming && !m.error && Boolean(m.content)
                  return (
                    <div key={m.id} className={`chat-msg${mine ? ' mine' : ''}${m.error ? ' is-error' : ''}`} style={{ '--i': Math.min(i, 12) }}>
                      <span className="chat-msg-avatar" aria-hidden="true">{mine ? initial : <Icon name="sparkle" size={16} />}</span>
                      <div className="chat-msg-main">
                        <span className="chat-msg-name">{mine ? 'You' : aiName}</span>
                        <div className="chat-msg-bubble">
                          {quoteText ? <div className="chat-msg-quote"><b aria-hidden="true"><Icon name="reply" size={12} /> {mine ? aiName : 'You'}</b>{quoteText.slice(0, 150)}{quoteText.length > 150 ? '…' : ''}</div> : null}
                          {m.images?.length ? <div className="chat-msg-imgs">{m.images.map((src) => <a key={src} href={resourceUrl(src)} target="_blank" rel="noreferrer"><img src={resourceUrl(src)} alt={mine ? 'Attached reference' : 'Screenshot taken by the app itself'} loading="lazy" /></a>)}</div> : null}
                          {/* The face shot takes a few seconds to assemble — say so instead of looking stuck. */}
                          {m.shooting ? <div className="chat-shot-caption is-pending"><Icon name="camera" size={13} /> Taking a real screenshot…</div> : null}
                          <div className="chat-text">{m.streaming && !m.content ? <span className="chat-thinking"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span><em>{aiName} is thinking…</em></span> : <>{renderChatContent(m.content)}{m.streaming ? <span className="chat-cursor" aria-hidden="true" /> : null}</>}</div>
                          {/* Queued terminal commands: Aira proposed them, the agent validated them, but
                              nothing runs until this human click — the one action that sends approval. */}
                          {m.pendingDesktop?.length ? <div className="chat-desktop-queue">{m.pendingDesktop.map((d, di) => (
                            <div key={`${m.id}-cmd-${di}`} className="chat-desktop-cmd">
                              <div className="chat-desktop-head"><Icon name="warn" size={14} /><span>{aiName} wants to run this on your PC</span></div>
                              <code className="chat-desktop-command">{d.command}</code>
                              {d.status === 'pending' ? <div className="chat-desktop-actions">
                                <button type="button" className="chat-desktop-run" onClick={() => approveDesktopCommand(m.id, di)}><Icon name="send" size={13} /> Run</button>
                                <button type="button" className="chat-desktop-cancel" onClick={() => declineDesktopCommand(m.id, di)}>Cancel</button>
                              </div> : null}
                              {d.status === 'running' ? <div className="chat-desktop-note"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span> Running…</div> : null}
                              {d.status === 'done' ? <pre className="chat-desktop-result">{d.result}</pre> : null}
                              {d.status === 'error' ? <div className="chat-desktop-note is-error" role="alert">{d.error}</div> : null}
                              {d.status === 'declined' ? <div className="chat-desktop-note">Cancelled — nothing was run.</div> : null}
                            </div>
                          ))}</div> : null}
                        </div>
                        {m.ts || replyable || copyable ? <div className="chat-msg-meta">{m.ts ? <span className="chat-msg-time">{formatChatTime(m.ts)}</span> : null}{copyable ? <button type="button" className={`chat-msg-copy${copiedMsgId === m.id ? ' copied' : ''}`} aria-label={copiedMsgId === m.id ? 'Copied to clipboard' : 'Copy message'} onClick={() => copyMessage(m)}>{copiedMsgId === m.id ? <><Icon name="check" size={12} /> Copied</> : <><Icon name="copy" size={12} /> Copy</>}</button> : null}{replyable ? <button type="button" className="chat-msg-reply" aria-label={`Reply to ${aiName}'s message`} onClick={() => startReply(m)}><Icon name="reply" size={12} /> Reply</button> : null}</div> : null}
                      </div>
                    </div>
                  )
                })}
                <div ref={chatEndRef} />
              </div>
              </div>
            </>
          )}
          <form className={`prompt-box${pendingImgs.length ? ' has-attachments' : ''}${replyTarget ? ' has-reply' : ''}`} onSubmit={sendPrompt}>
            {replyTarget && <div className="prompt-reply">
              <span className="prompt-reply-mark" aria-hidden="true"><Icon name="reply" size={14} /></span>
              <div className="prompt-reply-main"><b>{aiName}</b><small>{replyTarget.content.replace(/\s+/g, ' ').trim().slice(0, 150)}{replyTarget.content.length > 150 ? '…' : ''}</small></div>
              <button type="button" className="prompt-reply-cancel" aria-label="Cancel reply" onClick={() => setReplyTarget(null)}>×</button>
            </div>}
            {pendingImgs.length > 0 && <div className="prompt-attachments" aria-label="Attached images">
              {pendingImgs.map((p) => <span key={p.id} className={`prompt-thumb${p.uploading ? ' uploading' : ''}`}>
                {p.dataUrl ? <img src={p.dataUrl} alt="Attachment preview" /> : <span className="prompt-thumb-wait" aria-hidden="true">…</span>}
                <button type="button" aria-label="Remove attachment" onClick={() => removePendingImg(p.id)}>×</button>
              </span>)}
            </div>}
            <div className="prompt-row">
              <span className="prompt-box-spark" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
              <button type="button" className="prompt-attach" aria-label="Attach image" title="Attach a reference image — or just Ctrl+V a copied one" onClick={() => attachInputRef.current?.click()}><Icon name="attach" size={17} /></button>
              <input ref={attachInputRef} className="prompt-file" type="file" accept="image/*" multiple onChange={(event) => { addImageFiles(event.target.files); event.target.value = '' }} />
              <button type="button" className="prompt-attach" aria-label="Take a photo" title="Take a photo with your camera" onClick={() => setCameraOpen(true)}><Icon name="camera" size={17} /></button>
              <label className="sr-only" htmlFor="chat-prompt">Type your message</label>
              {/* Never disabled: a greyed-out field blurs itself, which used to force the
                  user to click back into the composer before typing the next prompt. The
                  send button and sendPrompt's own guard block a second turn instead. */}
              <input id="chat-prompt" ref={promptInputRef} type="text" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && replyTarget) setReplyTarget(null) }} placeholder={providerQuota?.exhausted ? '🪫 Daily limit khatam — reset ka intezar…' : replyTarget ? `Replying to ${aiName}…` : streaming ? `${aiName} is typing…` : pendingImgs.length ? 'Ask about the image…' : 'Type your message...'} autoComplete="off" />
              {/* Auto-voice cluster: the always-listening mic pill (a single click
                  pauses the mic, another resumes it) + Speak-replies toggle. Lives
                  inside the chat composer so the whole voice surface sits exactly
                  where a conversation happens. The old "Talk" button was removed —
                  the pill now owns the voice-input on/off toggle. */}
              <div className="prompt-voice-cluster" role="group" aria-label="Voice controls">
                <button
                  type="button"
                  className={`prompt-mic-btn${wakeEnabled ? ' on' : ''}${voiceTurn ? ' turn' : ''}${voiceAsleep ? ' sleeping' : ''} status-${wakeStatus}`}
                  aria-pressed={wakeEnabled}
                  aria-label={voiceAsleep ? `${aiName} is sleeping — click to wake her` : wakeEnabled ? `${aiName} is listening — click to stop listening` : `Listening is off — click to let ${aiName} hear you again`}
                  title={voiceAsleep ? `Click to wake ${aiName}` : wakeEnabled ? `Click to pause the mic — she'll stop picking up your voice` : `Click to resume — she'll start picking up your voice again`}
                  onClick={() => {
                    /* Sleeping ("chup ho jao"): a click revives her just like the
                       name would — clear the flag and open the command window. */
                    if (voiceAsleep) { voiceAsleepRef.current = false; setVoiceAsleep(false); armNow(); setNotice(`🎙 ${aiName} jaag gayi — boliye`); return }
                    /* Click-to-toggle the always-on mic: listening → paused (stop
                       picking up the voice), paused → listening (start again). */
                    if (wakeEnabled) { setWakeEnabled(false); setNotice(`⏸️ ${aiName} ab sun nahi rahi — dobara sunne ke liye click karo`) }
                    else { setWakeEnabled(true); setNotice(`🎙 ${aiName} sun rahi hai — boliye`) }
                  }}
                >
                  <span className="prompt-mic-dot" aria-hidden="true" />
                  <span aria-hidden="true"><Icon name={voiceAsleep ? 'asleep' : 'mic'} size={16} /></span>
                  <em className="prompt-mic-chip">{!wakeEnabled ? 'paused' : voiceAsleep ? 'sleeping' : voiceTurn ? 'your turn' : wakeStatus === 'listening' ? 'listening' : wakeStatus === 'denied' ? 'blocked' : wakeStatus === 'no-mic' ? 'no mic' : wakeStatus === 'unsupported' ? 'no STT' : 'starting'}</em>
                </button>
                <button
                  type="button"
                  className={`prompt-speak-btn${speakReplies ? ' on' : ''}`}
                  aria-pressed={speakReplies}
                  aria-label={speakReplies ? 'Mute spoken replies' : 'Let replies be spoken aloud'}
                  title={speakReplies ? 'AI replies are spoken aloud — click to mute' : 'AI replies are silent — click to unmute'}
                  onClick={() => {
                    const next = !speakReplies
                    setSpeakReplies(next)
                    try { localStorage.setItem('nexora_speak_replies', next ? '1' : '0') } catch { /* private mode */ }
                    if (!next && typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
                    /* Mute also stops any server-synth MP3 that's currently playing,
                       not just browser TTS — the user hit 🔇 meaning "go silent". */
                    if (!next) cancelServerAudio()
                  }}
                ><span aria-hidden="true"><Icon name={speakReplies ? 'volOn' : 'volOff'} size={16} /></span></button>
              </div>
              <button type="submit" aria-label="Send message" disabled={streaming || pendingImgs.some((p) => p.uploading) || providerQuota?.exhausted || (!prompt.trim() && !pendingImgs.length)}><Icon name="send" size={18} /></button>
              {streaming && <button type="button" className="chat-stop-btn" aria-label="Stop generating" onClick={stopGeneration}><Icon name="stop" size={13} /> Stop</button>}
            </div>
          </form>
        </section>}
        {view === 'Tools' && <div className="workspace-page-panel">
          {/* Clicking a card no longer opens an inline form — it starts a fresh
             Chat conversation titled after the tool, seeds it with Aira's own
             professional intro asking for the exact references that tool needs,
             and drops a filled-in draft into the composer. The backend LLM
             reads the `[<tool> · session]` prefix in that draft on the first
             send and answers in the right lane. See `startToolSession` and
             `TOOL_STARTERS` for the per-tool copy. */}
          <div className="workspace-tool-grid">{tools.map(([icon, title, description, tint]) => <button className={`workspace-tool tint-${tint}${selectedTool === title ? ' tool-highlighted' : ''}`} type="button" key={title} onClick={() => startToolSession(title)}><span className="showcase-icon"><Icon name={icon} size={18} /></span><strong>{title}</strong><small>{description}</small><b>{selectedTool === title ? 'Opened ✓' : 'Open tool →'}</b></button>)}</div>
        </div>}
        {view === 'Desktop' && <DesktopView token={authToken} aiName={aiName} isLoggedIn={isLoggedIn} onLogin={onLogin} />}
        {view === 'Schedule' && <section className="workspace-page-panel history-panel">
          <div className="settings-icon"><Icon name="schedule" size={26} /></div>
          <h2>Schedule it once — {aiName} keeps bringing it up.</h2>
          <p>Give any task a date and time. {aiName} reminds you one day before with practical advice for that exact task, then again the moment it is due — never twice for the same stage.</p>
          <form className="schedule-form" onSubmit={addScheduleTask}>
            <input className="settings-input" type="text" required maxLength={200} placeholder="What needs doing? e.g. Submit the electricity bill" value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} aria-label="Task title" />
            <input className="settings-input" type="datetime-local" required value={taskDraft.dueAt} onChange={(event) => setTaskDraft({ ...taskDraft, dueAt: event.target.value })} aria-label="Due date and time" />
            <input className="settings-input" type="text" maxLength={2000} placeholder="Notes — more detail, better advice (optional)" value={taskDraft.notes} onChange={(event) => setTaskDraft({ ...taskDraft, notes: event.target.value })} aria-label="Task notes" />
            <button className="settings-save" type="submit" disabled={taskBusy || !taskDraft.title.trim() || !taskDraft.dueAt}>{taskBusy ? 'Scheduling…' : 'Schedule task'}</button>
          </form>
          {!isLoggedIn ? <p className="history-empty">Sign in to schedule tasks and get reminders.</p> : tasks.length === 0 ? <p className="history-empty">Nothing scheduled yet. Add your first task above.</p> : <ul className="schedule-list">{tasks.map((t) => <li key={t.id} className={t.status === 'done' ? 'done' : ''}>
            <button type="button" className="schedule-check" aria-pressed={t.status === 'done'} aria-label={`Toggle done: ${t.title}`} onClick={() => toggleScheduleTask(t)}>{t.status === 'done' ? <Icon name="check" size={14} /> : ''}</button>
            <div className="schedule-main"><strong>{t.title}</strong>{t.notes && <small>{t.notes}</small>}<span className="schedule-due">{new Date(t.dueAt).toLocaleString()}</span></div>
            <span className={`schedule-chip ${SCHEDULE_CHIP[t.phase][1]}`}>{SCHEDULE_CHIP[t.phase][0]}</span>
            <button type="button" className="schedule-delete" aria-label={`Delete ${t.title}`} onClick={() => removeScheduleTask(t.id)}>×</button>
          </li>)}</ul>}
        </section>}
        {/* The vault owns this page: the closed door, the light, the particle brain.
            All the state stays here — the ledger the vault opens still reads and
            writes these same lists — so it arrives as grouped props objects. */}
        {view === 'Memory' && <Suspense fallback={<p className="history-empty">Opening the vault…</p>}><MemoryVault
          aiName={aiName}
          isLoggedIn={isLoggedIn}
          authToken={authToken}
          facts={{ items: memories, loading: memLoading, busy: memBusy, draft: memDraft, setDraft: setMemDraft, submit: submitMemory, remove: removeMemoryEntry }}
          chats={{ items: conversations, visible: visibleConversations, loading: convLoading, query: historyQuery, setQuery: setHistoryQuery, confirming: confirmDeleteAll, setConfirming: setConfirmDeleteAll, removeAll: removeAllConversations, open: openConversation, remove: removeConversation }}
        /></Suspense>}
        {view === 'Settings' && <SettingsView isLoggedIn={isLoggedIn} userProfile={userProfile} authToken={authToken} onProfileUpdate={onProfileUpdate} onTokenChange={onTokenChange} onLogin={onLogin} onUpgrade={onUpgrade} voicePrefs={voicePrefs} persistVoicePrefs={persistVoicePrefs} />}
        {/* First-run prompt: until the owner registers a voiceprint, anyone's
            voice can drive the assistant — offer the 20-second setup once per
            session (Settings → Owner voice lock keeps it reachable after "Later"). */}
        {isLoggedIn && !ownerVoice && !ownerPromptDismissed && view !== 'Settings' && <div className="owner-voice-card" role="dialog" aria-label="Register owner voice">
          <h3><Icon name="lock" size={16} /> Sirf aap ki awaaz</h3>
          <OwnerVoiceSetup compact userKey={ownerKey} ownerName={userProfile?.name} aiName={aiName} onDone={() => {
            setOwnerPromptDismissed(true)
            try { sessionStorage.setItem('nexora_owner_voice_prompt', '0') } catch { /* private mode */ }
          }} />
        </div>}
        {/* Live transcript: shows the interim STT text so the user can watch
            their own voice being traced before they finish the sentence.
            aria-live="polite" but not "assertive" — Chrome refines the text
            every ~200 ms and screen readers would otherwise stutter. */}
        {wakeLive && <div className="wake-live-caption" aria-live="polite"><span className="wake-live-dot" aria-hidden="true" /><em>You, saying:</em> {wakeLive}</div>}
        {notice && <div className="toast-message" role="status"><Icon name="sparkle" size={14} />{notice}<button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}>×</button></div>}
      </div>
    </section>

    {mobileMoreOpen && <div className="mobile-more-menu" role="menu">{navItems.slice(4).map(([label, icon]) => <button type="button" role="menuitem" key={label} onClick={() => { setActiveView(label); setMobileMoreOpen(false) }}><Icon name={icon} size={18} />{label}</button>)}</div>}
    <nav className="mobile-workspace-nav" aria-label="Mobile workspace navigation">
      {navItems.slice(0, 4).map(([label, icon]) => <button className={activeView === label ? 'selected' : ''} type="button" key={label} onClick={() => { setActiveView(label); setMobileMoreOpen(false) }}><Icon name={icon} size={18} /><small>{label}</small></button>)}
      <button type="button" aria-expanded={mobileMoreOpen} onClick={() => setMobileMoreOpen((open) => !open)}><Icon name="more" size={18} /><small>More</small></button>
    </nav>

    {/* Live voice call — full-screen dialog over the workspace */}
    {voiceOpen && (
      <Suspense fallback={null}>
        <VoiceCall authToken={authToken} user={userProfile} prefs={voicePrefs} onClose={() => setVoiceOpen(false)} />
      </Suspense>
    )}
    {/* Camera capture — the 📷 shot returns a File and rides the exact same
        attach → upload → vision pipeline as a pasted/picked image, then closes. */}
    {cameraOpen && (
      <Suspense fallback={null}>
        <CameraCapture onCapture={(file) => { addImageFiles([file]); setCameraOpen(false) }} onClose={() => setCameraOpen(false)} />
      </Suspense>
    )}
  </main>
}

/* The in-app pricing modal, now with the manual Easypaisa / JazzCash flow. Real
   checkout needs a merchant account the owner doesn't have yet, so instead of
   flipping the plan the modal shows the owner's wallet number + the plan price,
   lets the user pay in their own banking app and submit the transaction id, and
   waits for the owner to approve. Picking a paid plan hands control to the parent
   (onChoose → loads billing, opens the pay stage); 'free' still changes directly. */
function PricingModal({ open, currentPlan, busy, error, notice, onClose, onChoose, billing, payPlan, onBack, payMethod, setPayMethod, payTxn, setPayTxn, onSubmit }) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null

  const chosen = payPlan ? PLANS.find((p) => p.key === payPlan) : null
  const methods = billing?.methods || []
  const activeMethod = methods.find((m) => m.id === payMethod) || methods[0] || null
  const pending = billing?.myRequests?.find((r) => r.plan === payPlan && r.status === 'pending')

  return createPortal(<div className="modal-backdrop pricing-backdrop" role="dialog" aria-modal="true" aria-label="Choose a plan" onClick={onClose}>
    <div className="pricing-modal" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="pricing-close" aria-label="Close plans" onClick={onClose}>×</button>
      {notice && <p className="pricing-notice" role="status"><Icon name="sparkle" size={14} /> {notice}</p>}
      {error && <p className="pricing-error" role="alert"><Icon name="warn" size={14} /> {error}</p>}

      {chosen ? <div className="pricing-pay">
        <button type="button" className="pricing-back" onClick={onBack}><Icon name="arrowLeft" size={14} /> Back to plans</button>
        <h2>Activate <span>{chosen.name}</span></h2>
        <p className="pricing-sub">Payment {chosen.price} — {chosen.sub}. Apne Easypaisa ya JazzCash app se neeche diye number par bhejein, phir Transaction ID darj karein. Owner verify karke plan chalu kar dega.</p>
        {!billing && <p className="pricing-muted">Loading payment options…</p>}
        {billing && !billing.manualEnabled && <p className="pricing-error" role="alert"><Icon name="warn" size={14} /> Online payment is not enabled yet — the site owner hasn't added an Easypaisa/JazzCash account. Your current plan keeps working; please check back later.</p>}
        {billing && billing.manualEnabled && !methods.length && <p className="pricing-error" role="alert"><Icon name="warn" size={14} /> No payment account is configured on this server yet.</p>}
        {billing && billing.manualEnabled && pending ? <div className="pricing-pending" role="status">
          <strong><Icon name="hourglass" size={15} /> Payment submitted — awaiting approval</strong>
          <p>Aap ne {pending.amount} PKR ({pending.method === 'easypaisa' ? 'Easypaisa' : 'JazzCash'}) bheja, Transaction ID <code>{pending.txnId}</code>. Owner approve karte hi {chosen.name} chalu ho jayega — thora intezar karein.</p>
          <p className="pricing-muted">Naya payment bhejne ke liye neeche wapas jaayein.</p>
        </div> : billing && billing.manualEnabled && activeMethod ? <form className="pricing-pay-form" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
          <div className="pricing-methods" role="radiogroup" aria-label="Payment method">
            {methods.map((m) => <button type="button" key={m.id} role="radio" aria-checked={activeMethod.id === m.id} className={`pricing-method${activeMethod.id === m.id ? ' selected' : ''}`} onClick={() => setPayMethod(m.id)}>{m.label}</button>)}
          </div>
          <div className="pricing-sendto">
            <span className="pricing-sendto-label">Send {chosen.price} to {activeMethod.label}{activeMethod.accountName ? ` (${activeMethod.accountName})` : ''}</span>
            <div className="pricing-number"><code>{activeMethod.number}</code><button type="button" className="pricing-copy" onClick={() => navigator.clipboard?.writeText(activeMethod.number)} aria-label={`Copy ${activeMethod.label} number`}>Copy</button></div>
          </div>
          <label className="pricing-txn-label" htmlFor="pricing-txn">Transaction ID (TID) jo app ne diya</label>
          <input id="pricing-txn" className="settings-input" type="text" inputMode="numeric" autoComplete="off" maxLength={40} value={payTxn} onChange={(event) => setPayTxn(event.target.value)} placeholder="e.g. 0123456789" />
          <p className="pricing-muted">Sirf letters, numbers ya dashes. Ghalat TID se approval nahi hoga.</p>
          <button className="button button-primary button-wide" type="submit" disabled={busy || payTxn.trim().length < 4}>{busy ? 'Submitting…' : 'I have paid — submit for approval'} <span>→</span></button>
        </form> : null}
      </div> : <>
        <p className="eyebrow">CHOOSE YOUR PLAN</p>
        <h2>Unlock more <span>Nexora</span></h2>
        <p className="pricing-sub">Yeh wahi pricing hai jo aapke dashboard me hai — jo plan behtar lage, choose kar lein.</p>
        <div className="plan-grid pricing-grid">
          {PLANS.map((p) => <article key={p.key} className={`plan-card ${p.feat ? 'plan-featured' : ''}`}>
            {p.feat && <span className="popular-label">MOST LOVED</span>}
            <span className="plan-label">{p.label}</span>
            <h3>{p.name}</h3>
            <p className="plan-price">{p.price} <small>{p.sub}</small></p>
            <p className="plan-description">{p.desc}</p>
            <ul>{p.items.map((it) => <li key={it}><Icon name="sparkle" size={13} /> {it}</li>)}</ul>
            <button className={`button button-${p.tint} button-wide`} type="button" disabled={busy || currentPlan === p.key} onClick={() => onChoose(p.key)}>{currentPlan === p.key ? 'Current plan' : (busy ? 'Working…' : p.cta)} <span>→</span></button>
          </article>)}
        </div>
      </>}
    </div>
  </div>, document.body)
}

export default function Nexora() {
  const initialSession = loadSession()
  const [showWorkspace, setShowWorkspace] = useState(() =>
    Boolean(initialSession?.isLoggedIn && initialSession?.token && initialSession?.inWorkspace !== false),
  )
  const [showLogin, setShowLogin] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(() => Boolean(initialSession?.isLoggedIn && initialSession?.token))
  const [userProfile, setUserProfile] = useState(() => initialSession?.userProfile || null)
  const [authToken, setAuthToken] = useState(() => initialSession?.token || null)
  const [activeView, setActiveView] = useState(() => initialSession?.activeView || 'Home')
  const [selectedTool, setSelectedTool] = useState(null)
  const [pendingNavigation, setPendingNavigation] = useState(null)
  /* The in-app pricing modal (opened by any Upgrade button) and its transient
     state: a backend error message and the in-flight flag that disables the plan
     buttons while a change is being attempted. */
  const [showPricing, setShowPricing] = useState(false)
  const [pricingError, setPricingError] = useState(null)
  const [pricingNotice, setPricingNotice] = useState(null)
  const [pricingBusy, setPricingBusy] = useState(false)
  /* Manual payment state: the /api/billing/status payload, which paid plan is being
     paid for (drives the modal's second stage), the chosen wallet + typed transaction
     id. Reset whenever the modal closes so a reopened modal starts clean. */
  const [billing, setBilling] = useState(null)
  const [payPlan, setPayPlan] = useState(null)
  const [payMethod, setPayMethod] = useState('')
  const [payTxn, setPayTxn] = useState('')
  // 'google' | 'signup' | null — while set, the onboarding page stays in front of the workspace
  const [onboardingSource, setOnboardingSource] = useState(() => {
    try {
      const stored = localStorage.getItem(ONBOARDING_KEY)
      return stored ? (stored === '1' ? 'google' : stored) : null
    } catch { return null }
  })

  function persistWorkspace(open, view) {
    const session = loadSession()
    if (!session?.token) return
    saveSession({
      token: session.token,
      user: session.userProfile,
      inWorkspace: open,
      activeView: view ?? activeView,
    })
  }

  useEffect(() => {
    if (!authToken) return
    let cancelled = false
    me(authToken)
      .then((res) => {
        if (cancelled) return
        const session = saveSession({ token: authToken, user: res.user, inWorkspace: true })
        setUserProfile(session.userProfile)
        setIsLoggedIn(true)
        // Keep the onboarding page in front if the name step is still pending
        if (!onboardingSource) setShowWorkspace(true)
      })
      .catch((err) => {
        if (cancelled) return
        if (err?.status === 401) {
          clearSession()
          setAuthToken(null)
          setUserProfile(null)
          setIsLoggedIn(false)
          setShowWorkspace(false)
          return
        }
        const cached = loadSession()
        if (cached?.token) {
          setIsLoggedIn(true)
          setShowWorkspace(cached.inWorkspace !== false)
        }
      })
    return () => { cancelled = true }
  }, [authToken])

  function handleNavigate(targetView = 'Home', targetTool = null, targetLabel = null) {
    if (!isLoggedIn) {
      setPendingNavigation({ view: targetView, tool: targetTool, label: targetLabel || targetView })
      setShowLogin(true)
    } else {
      setActiveView(targetView)
      setSelectedTool(targetTool)
      setShowWorkspace(true)
      persistWorkspace(true, targetView)
    }
  }

  function handleLoginSuccess(profile) {
    const token = profile?.token || loadSession()?.token || null
    const nextView = pendingNavigation?.view || 'Home'
    // New Google connections AND freshly created accounts get the onboarding page
    const onboardSource = profile?.source === 'google' ? 'google' : profile?.source === 'signup' ? 'signup' : null
    const needsOnboard = Boolean(onboardSource)
    if (needsOnboard) {
      /* fresh journey → drop any half-finished progress from an earlier account */
      try {
        localStorage.setItem(ONBOARDING_KEY, onboardSource)
        localStorage.removeItem('nexora_onboarding_progress')
      } catch { /* private mode */ }
      setOnboardingSource(onboardSource)
    }
    setAuthToken(token)
    setIsLoggedIn(true)
    setUserProfile(profile)
    setShowLogin(false)
    setShowWorkspace(!needsOnboard)
    if (pendingNavigation) {
      setActiveView(nextView)
      if (pendingNavigation.tool) {
        setSelectedTool(pendingNavigation.tool)
      }
      setPendingNavigation(null)
    } else {
      setActiveView('Home')
    }
    if (token) {
      saveSession({
        token,
        user: profile,
        inWorkspace: !needsOnboard,
        activeView: nextView,
      })
    }
  }

  function handleOnboardingComplete(updatedUser) {
    try { localStorage.removeItem(ONBOARDING_KEY) } catch { /* private mode */ }
    setOnboardingSource(null)
    if (updatedUser && authToken) {
      const session = saveSession({ token: authToken, user: updatedUser, inWorkspace: true })
      setUserProfile(session.userProfile)
    } else {
      persistWorkspace(true)
    }
    setShowWorkspace(true)
  }

  function handleLogout() {
    clearSession()
    /* Wipe every per-user local config so the NEXT person on this browser cannot
       inherit this account's AI name / persona / voice (privacy on a shared device).
       The persona lives in the onboarding-progress + ai-profile blobs; showWorkspace
       → false also unmounts Workspace, dropping the in-memory chat transcript. */
    try {
      localStorage.removeItem(ONBOARDING_KEY)
      localStorage.removeItem(ONBOARDING_PROGRESS_KEY)
      localStorage.removeItem(VOICE_PREFS_KEY)
      localStorage.removeItem('nexora_ai_profile')
    } catch { /* private mode */ }
    setIsLoggedIn(false)
    setUserProfile(null)
    setAuthToken(null)
    setShowWorkspace(false)
    setOnboardingSource(null)
    setSelectedTool(null)
    setPendingNavigation(null)
  }

  /* Any Upgrade button opens the pricing modal rather than silently flipping the
     plan. Signed-out visitors are sent to sign in first (the plan change needs an
     account), which is also what the landing "Get Pro" card does. */
  function handleUpgrade(message) {
    if (!authToken) {
      setShowLogin(true)
      return
    }
    setPricingError(null)
    setPayPlan(null)
    /* An optional reason string (e.g. the demo cap) is shown INSIDE the modal, since
       the low-z-index toast would otherwise render behind the modal backdrop. */
    setPricingNotice(typeof message === 'string' ? message : null)
    setShowPricing(true)
  }

  /* Load the payment options once and keep them for the session of the modal. */
  async function ensureBilling() {
    if (billing) return billing
    try { const s = await billingStatus(authToken); setBilling(s); return s }
    catch (err) { setPricingError(err?.message); return null }
  }

  /* Picking a plan. 'free' (a downgrade) changes directly — it is always allowed.
     A paid plan never flips the badge itself; it opens the manual-payment stage so
     the user can send the money and submit the transaction id for approval. */
  async function handleChoose(plan) {
    if (!authToken) { setShowPricing(false); setShowLogin(true); return }
    setPricingError(null)
    setPricingNotice(null)
    if (plan === 'free') {
      setPricingBusy(true)
      try { const res = await upgradePlan(authToken, 'free'); const session = saveSession({ token: authToken, user: res.user }); setUserProfile(session.userProfile); setShowPricing(false) }
      catch (err) { setPricingError(err?.message || 'Could not change your plan.') }
      finally { setPricingBusy(false) }
      return
    }
    setPayPlan(plan)
    setPayTxn('')
    const s = await ensureBilling()
    if (s?.methods?.length) setPayMethod(s.methods[0].id)
  }

  function backToPlans() { setPayPlan(null); setPayTxn(''); setPricingError(null); setPricingNotice(null) }

  /* Submit the paid plan + transaction id for the owner to approve. Does not change
     the plan; refreshes billing so the modal flips to the "awaiting approval" box. */
  async function submitPayment() {
    if (!authToken || !payPlan) return
    const method = payMethod || billing?.methods?.[0]?.id
    const txnId = payTxn.trim()
    if (!method || txnId.length < 4) return
    setPricingBusy(true)
    setPricingError(null)
    try {
      const res = await billingRequest(authToken, { plan: payPlan, method, txnId })
      setBilling(await billingStatus(authToken))
      setPayTxn('')
      setPricingNotice(res?.message || 'Payment submitted — the owner will approve it shortly.')
    } catch (err) {
      console.error('[nexora] payment request failed', err)
      setPricingError(err?.message || 'Could not submit your payment.')
    } finally {
      setPricingBusy(false)
    }
  }

  function handleProfileUpdate(user) {
    if (!authToken || !user) return
    const session = saveSession({ token: authToken, user })
    setUserProfile(session.userProfile)
  }

  /* Swap in a freshly-rotated auth token (password change revokes the old one on the
     server) — update in-memory state AND the persisted session so this tab keeps its
     own access without forcing a re-login. */
  function handleTokenChange(token) {
    if (!token) return
    setAuthToken(token)
    saveSession({ token })
  }

  return (
    <>
      <CursorTrail />
      {showLogin ? (
        <SignIn
          onBack={() => setShowLogin(false)}
          onLoginSuccess={handleLoginSuccess}
          targetLabel={pendingNavigation?.label}
        />
      ) : onboardingSource ? (
        <Suspense fallback={null}>
          <Onboarding userProfile={userProfile} source={onboardingSource} onComplete={handleOnboardingComplete} />
        </Suspense>
      ) : showWorkspace ? (
        <Workspace
          activeView={activeView}
          setActiveView={setActiveView}
          selectedTool={selectedTool}
          setSelectedTool={setSelectedTool}
          onBack={() => {
            setShowWorkspace(false)
            persistWorkspace(false)
          }}
          isLoggedIn={isLoggedIn}
          userProfile={userProfile}
          authToken={authToken}
          onLogin={() => setShowLogin(true)}
          onLogout={handleLogout}
          onUpgrade={handleUpgrade}
          onProfileUpdate={handleProfileUpdate}
          onTokenChange={handleTokenChange}
        />
      ) : (
        <Landing
          onLogin={() => {
            setPendingNavigation({ view: 'Home', tool: null, label: 'Workspace' })
            setShowLogin(true)
          }}
          onNavigate={handleNavigate}
          isLoggedIn={isLoggedIn}
          userProfile={userProfile}
          onUpgrade={handleUpgrade}
        />
      )}
      <PricingModal
        open={showPricing}
        currentPlan={userProfile?.plan}
        busy={pricingBusy}
        error={pricingError}
        notice={pricingNotice}
        billing={billing}
        payPlan={payPlan}
        payMethod={payMethod}
        setPayMethod={setPayMethod}
        payTxn={payTxn}
        setPayTxn={setPayTxn}
        onChoose={handleChoose}
        onBack={backToPlans}
        onSubmit={submitPayment}
        onClose={() => { setShowPricing(false); setPricingError(null); setPricingNotice(null); setPayPlan(null); setPayTxn(''); setPayMethod(''); setBilling(null) }}
      />
    </>
  )
}
