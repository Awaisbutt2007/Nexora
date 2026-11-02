import { useState } from 'react'
import { ArrowLeft, Check, Copy, Download, Laptop, Monitor, MonitorSmartphone, ShieldCheck, Smartphone, Tablet, Zap } from 'lucide-react'
import { detectPlatform, useInstallApp } from './InstallApp.jsx'
import './DownloadPage.css'

/* /download — one page with every way to get Nexora on a device.
   The visitor's own device is detected and shown first; every other platform stays
   listed below it, so someone on a laptop can still read how to install on a phone. */

const EXE_URL = '/downloads/Nexora-Setup.exe'

const PLATFORMS = [
  {
    id: 'windows',
    name: 'Windows',
    note: 'Windows 10 and 11',
    Icon: Monitor,
    steps: [
      'Click Download for Windows below.',
      'Open Nexora-Setup.exe and choose Yes to install.',
      'Open Nexora from the Desktop or Start Menu icon.',
    ],
    tip: 'If Windows shows “Windows protected your PC”, click More info → Run anyway.',
  },
  {
    id: 'mac',
    name: 'macOS',
    note: 'MacBook, iMac, Mac mini',
    Icon: Laptop,
    steps: [
      'Open this page in Safari (macOS Sonoma or newer) or Chrome.',
      'Safari: File → Add to Dock. Chrome: click the install icon in the address bar.',
      'Open Nexora from the Dock or Launchpad.',
    ],
  },
  {
    id: 'android',
    name: 'Android',
    note: 'Phones and tablets',
    Icon: Smartphone,
    steps: [
      'Open this page in Chrome.',
      'Tap Install now below — or tap the ⋮ menu → Install app.',
      'Open Nexora from your home screen.',
    ],
  },
  {
    id: 'ios',
    name: 'iPhone & iPad',
    note: 'iOS and iPadOS',
    Icon: Tablet,
    steps: [
      'Open this page in Safari.',
      'Tap the Share button (square with an arrow).',
      'Scroll down, tap Add to Home Screen, then Add.',
    ],
  },
  {
    id: 'other',
    name: 'Linux & Chromebook',
    note: 'Chrome, Edge or Brave',
    Icon: MonitorSmartphone,
    steps: [
      'Open this page in Chrome or Edge.',
      'Click Install now below, or the install icon in the address bar.',
      'Nexora opens in its own window like any other app.',
    ],
  },
]

function platformKey(p) {
  if (p === 'mac-safari' || p === 'mac-chromium') return 'mac'
  return PLATFORMS.some((x) => x.id === p) ? p : 'other'
}

function PlatformCard({ platform, featured, canPrompt, onInstall, installed }) {
  const { id, name, note, Icon, steps, tip } = platform
  const promptable = canPrompt && featured && id !== 'ios'
  return <article className={`dl-card${featured ? ' dl-card-featured' : ''}`} id={`dl-${id}`}>
    <header className="dl-card-head">
      <span className="dl-card-icon"><Icon size={24} strokeWidth={1.8} /></span>
      <div>
        <h2>{name}</h2>
        <p>{note}</p>
      </div>
      {featured && <span className="dl-badge">Your device</span>}
    </header>
    <ol className="dl-steps">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
    {tip && <p className="dl-tip">{tip}</p>}
    <div className="dl-actions">
      {installed && featured ? <span className="dl-done"><Check size={16} /> Installed on this device</span> : <>
        {id === 'windows' && <a className="dl-btn dl-btn-primary" href={EXE_URL} download><Download size={17} /> Download for Windows</a>}
        {promptable && <button type="button" className={`dl-btn ${id === 'windows' ? 'dl-btn-ghost' : 'dl-btn-primary'}`} onClick={onInstall}><Zap size={17} /> Install now</button>}
      </>}
    </div>
  </article>
}

export default function DownloadPage() {
  const { canPrompt, installed, prompt } = useInstallApp()
  const [mine] = useState(() => platformKey(typeof navigator === 'undefined' ? 'other' : detectPlatform()))
  const [copied, setCopied] = useState(false)
  const link = typeof window === 'undefined' ? '' : `${window.location.origin}/download`

  const ordered = [...PLATFORMS].sort((a, b) => (a.id === mine ? -1 : b.id === mine ? 1 : 0))

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* clipboard blocked */ }
  }

  return <main className="dl-page">
    <div className="dl-glow" aria-hidden="true" />
    <nav className="dl-nav">
      <a className="dl-back" href="/"><ArrowLeft size={17} /> <span>Back to Nexora</span></a>
      <a className="dl-brand" href="/" aria-label="Nexora home"><img src="/pwa-icon-192.png" alt="" width="30" height="30" /> Nexora</a>
    </nav>

    <section className="dl-hero">
      <p className="dl-eyebrow"><ShieldCheck size={15} /> Free · Safe · No app store needed</p>
      <h1>Download <span>Nexora</span></h1>
      <p className="dl-lead">Install Nexora on your phone, tablet or computer. It opens in its own window with its own icon, just like any app — and your account works the same everywhere.</p>
      {!installed && canPrompt && mine !== 'ios' && <button type="button" className="dl-btn dl-btn-primary dl-btn-large" onClick={prompt}><Zap size={18} /> Install on this device</button>}
      {!installed && mine === 'windows' && !canPrompt && <a className="dl-btn dl-btn-primary dl-btn-large" href={EXE_URL} download><Download size={18} /> Download for Windows</a>}
      {installed && <p className="dl-done dl-done-hero"><Check size={17} /> Nexora is already installed on this device.</p>}
    </section>

    <section className="dl-grid" aria-label="Choose your device">
      {ordered.map((p) => <PlatformCard key={p.id} platform={p} featured={p.id === mine} canPrompt={canPrompt} installed={installed} onInstall={prompt} />)}
    </section>

    <section className="dl-share">
      <div>
        <h2>Installing on another device?</h2>
        <p>Open this link on your phone or computer:</p>
      </div>
      <div className="dl-link">
        <code>{link.replace(/^https?:\/\//, '')}</code>
        <button type="button" onClick={copy} aria-label="Copy link">{copied ? <Check size={16} /> : <Copy size={16} />}<span>{copied ? 'Copied' : 'Copy'}</span></button>
      </div>
    </section>
  </main>
}
