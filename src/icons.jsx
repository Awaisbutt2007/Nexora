// Central icon system for the UI.
//
// The app used to paint interface affordances with raw Unicode emoji/glyphs
// (📎 ⚠️ ✦ ◈ ▦ …), which render as inconsistent colour emoji — or as tofu — depending
// on the OS font. This module replaces every UI icon with one coherent, stroke-based
// line icon (lucide-react) that inherits `currentColor`, so the existing violet→cyan
// icon colours carried by the wrapping element's CSS still apply.
//
// Two ways to use it:
//   • Data arrays (navItems, tools, quickActions, ChatPop presets) store a *key*
//    (`'chat'`, `'image'`…) and render `<Icon name={key} />`, keeping them data-driven.
//   • Inline JSX uses `<Icon name="send" size={18} />` directly.
//
// This file maps keys ONLY to the icons the UI needs; conversational emoji that live
// inside AI reply text are intentionally left as emoji — they are content, not chrome.
import {
  MessageSquare, MessagesSquare, AlarmClock, Clock, Brain, LayoutGrid, Monitor, Settings,
  User, Sparkles, WandSparkles, TriangleAlert, Check, X, Mic, MicOff, Volume2, VolumeX,
  Send, Square, Paperclip, Camera, RefreshCw, RotateCw, Hourglass, Lightbulb, PenLine, Zap,
  Link, Lock, Eye, Globe, Play, Pause, KeyRound, LogOut, Pin, Reply, ArrowUpRight, ArrowLeft,
  Search, Circle, CircleDot, Venus, Mars, Banknote, CreditCard, Image, Code, FileText,
  MonitorPlay, ClipboardList, Share2, Radio, Plus, Copy, MoreHorizontal, Folder, Mouse,
  Download, Mail, MessageCircle, HelpCircle,
} from 'lucide-react'

const ICONS = {
  // navigation + sections
  chat: MessageSquare, thread: MessagesSquare, schedule: AlarmClock, clock: Clock,
  memory: Brain, tools: LayoutGrid, desktop: Monitor, settings: Settings, user: User,
  // brand + status
  sparkle: Sparkles, magic: WandSparkles, warn: TriangleAlert, check: Check, cross: X,
  dotOn: CircleDot, dotOff: Circle, record: Radio, hourglass: Hourglass,
  // composer + voice
  mic: Mic, micOff: MicOff, asleep: MicOff, volOn: Volume2, volOff: VolumeX,
  send: Send, stop: Square, attach: Paperclip, camera: Camera, flip: RefreshCw,
  // account + settings rows
  key: KeyRound, logout: LogOut, pin: Pin, link: Link, lock: Lock, eye: Eye, globe: Globe,
  // media + play
  play: Play, pause: Pause, search: Search, refresh: RotateCw,
  reply: Reply, external: ArrowUpRight, arrowLeft: ArrowLeft,
  // gender toggles
  female: Venus, male: Mars,
  // billing
  dollar: Banknote, card: CreditCard,
  // tool cards
  image: Image, code: Code, pdf: FileText, youtube: MonitorPlay, meeting: ClipboardList,
  social: Share2,
  // quick actions / starters
  bulb: Lightbulb, pen: PenLine, zap: Zap, brain: Brain, diamond: Brain,
  // composer extras, footer socials, desktop scopes, lightbox
  plus: Plus, copy: Copy, more: MoreHorizontal, folder: Folder, mouse: Mouse,
  download: Download, mail: Mail, whatsapp: MessageCircle, help: HelpCircle,
}

// A line icon that always reads as decoration to assistive tech (the button/label
// next to it carries the accessible name), inherits colour, and sits on the text
// baseline so swapping an emoji `<span>` for it doesn't nudge the line box.
export function Icon({ name, size = 16, strokeWidth = 2, className = '', ...rest }) {
  const Cmp = ICONS[name]
  if (!Cmp) return null
  return <Cmp size={size} strokeWidth={strokeWidth} className={`ui-icon ${className}`.trim()} aria-hidden="true" focusable="false" {...rest} />
}
