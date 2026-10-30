import { useState } from 'react'
import { Icon } from './icons.jsx'

/* ── Quick actions / Continue chat ─────────────────────────────────────────
   The floating panel that docks to the top-right of the working area: one big
   "Start new chat" button, then Pinned chats, then Recent chats, then the six
   starter prompts.

   It lives in its own module because two surfaces need the identical panel —
   Home/Chat (always open, no handle) and the Memory vault (docking it to the
   brain costs the stage height, so it can fold away to a small round button).
   Declaring it inside Workspace instead would have locked it to that file and
   made MemoryVault import back into it.

   Nothing is fetched here: the parent already holds the conversation list, and
   the two handlers decide what "open" means on that surface — Home resumes the
   thread in place, the vault leaves Memory (which has no thread area). Pinned
   ids are the only thing this component owns, kept in localStorage so a pin
   survives a reload. */
/* icon · label · tooltip · what lands in the composer when it is clicked */
const POP_STARTERS = [
  ['mic', 'Talk call', 'Start a voice call with her', ''],
  ['zap', 'Quick question', 'Ask and get a short answer', 'Ask me a short answer'],
  ['pen', 'Brainstorm', 'Throw ideas around', 'Brainstorm ideas for:'],
  ['globe', 'Research online', 'Look something up and fact-check it', 'Research and fact-check:'],
  ['bulb', 'Explain simply', 'Break a hard thing down', 'Explain this in simple words:'],
  ['magic', 'More presets', 'See every starter she has', 'Show me every prompt preset'],
]

const PIN_KEY = 'nexora_pinned_chats'
/* A hand-edited blob must not take the panel down with it. */
const readPins = () => {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]') } catch { return [] }
}
const threadTitle = (c) => c.title || c.topic || 'Untitled chat'

export default function ChatPop({ collapsible, open, setOpen, conversations, onNewChat, onOpenChat, onPrompt, onTalk }) {
  const [pinned, setPinned] = useState(readPins)
  const collapsed = collapsible && !open
  const fold = () => setOpen((isOpen) => !isOpen)

  const togglePin = (id) => {
    const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [id, ...pinned].slice(0, 12)
    setPinned(next)
    try { localStorage.setItem(PIN_KEY, JSON.stringify(next)) } catch { /* private mode: pins just do not stick */ }
  }

  /* Pinned first, then the newest threads that are not already pinned. */
  const byId = new Map(conversations.map((c) => [c.id, c]))
  const pinnedThreads = pinned.map((id) => byId.get(id)).filter(Boolean)
  const recentThreads = conversations.filter((c) => !pinned.includes(c.id)).slice(0, 6)

  /* Collapsed, the panel is gone and only the round handle stays — pinned to the
     same corner so it never jumps when you fold or unfold. */
  if (collapsed) {
    return <button type="button" className="chat-popover-orb" aria-label="Open chat panel" aria-expanded={false} onClick={fold}><Icon name="sparkle" size={16} /></button>
  }

  const group = (label, threads) => threads.length ? <div className="chat-popover-group">
    <small>{label}</small>
    <ul>{threads.map((c) => <li key={c.id}>
      <button type="button" className="chat-popover-item" onClick={() => onOpenChat(c.id)}>
        <span>{threadTitle(c)}</span>
        <small>{new Date(c.updatedAt || c.createdAt).toLocaleDateString()}{c.messageCount ? ` · ${c.messageCount} turns` : ''}</small>
      </button>
      <button type="button" className={`chat-popover-pin${pinned.includes(c.id) ? ' on' : ''}`} aria-pressed={pinned.includes(c.id)} aria-label={`${pinned.includes(c.id) ? 'Unpin' : 'Pin'} ${threadTitle(c)}`} onClick={() => togglePin(c.id)}><Icon name="pin" size={13} /></button>
    </li>)}</ul>
  </div> : null

  return <div className="chat-popover">
    <header>
      <Icon name="sparkle" size={15} />
      <b>Quick actions</b>
      <small>Continue chat</small>
      {/* Home cannot fold the panel, so it shows no handle at all — a triangle
          that did nothing would just be noise. */}
      {collapsible && <button type="button" className="chat-popover-toggle" aria-expanded aria-label="Collapse chat panel" onClick={fold}><Icon name="play" size={13} /></button>}
    </header>

    <button type="button" className="chat-popover-new" onClick={onNewChat}><Icon name="plus" size={14} />Start new chat</button>

    {group('Pinned chats', pinnedThreads)}
    {group('Recent chats', recentThreads)}
    {!pinnedThreads.length && !recentThreads.length && <p className="chat-popover-empty">No saved chats yet. Start one and she will keep it here.</p>}

    <div className="chat-popover-starters" role="group" aria-label="Prompt presets">
      {POP_STARTERS.map(([icon, label, hint, preset]) => <button
        type="button"
        key={label}
        title={hint}
        onClick={() => (icon === 'mic' ? onTalk() : onPrompt(preset))}
      ><Icon name={icon} size={15} />{label}</button>)}
      <button type="button" className="chat-popover-trail" onClick={onNewChat}>Trail: Start new chat →</button>
    </div>
  </div>
}
