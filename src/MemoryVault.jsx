import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { getConversation } from './api/nexora.js'
import { Icon } from './icons.jsx'
import './MemoryVault.css'
/* ─────────────────────────────────────────────────────────────────────────────
   The Memory vault.

   The old page spilled two lists the moment you landed on it. This is the door
   version: a closed page, one button, and when it is pressed the screen fills
   with white light the way a dark room does in the movies when someone opens
   the door — for a beat you see nothing at all — then the light recedes and
   nano particles assemble into a brain with cables running out of its mass to
   every remembered fact and every saved thread, wired into each other wherever
   a fact was actually spoken in that thread.
   ───────────────────────────────────────────────────────────────────────────── */

/* The door opens straight onto the assembling brain — no white light flash.
   FORM_DELAY is the short beat before particles begin their flight so the
   (now full-page) stage has laid out at its final size. */
const FORM_DELAY = 0.5
const FORM_SECONDS = 1.9
const PARTICLES = 9000
/* Provenance is read from the locally saved messages, thread by thread, so a
   cable can say "this memory was discussed in that chat" instead of guessing.
   No model call, no tokens, nothing leaves this machine. Newest threads only —
   drawing lines must not cost a hundred requests. */
const PROVENANCE_LIMIT = 12
/* Past these counts the labels stop being a map and become a smear; the ledger
   under the stage holds the rest. */
const FACT_LIMIT = 14
const CHAT_LIMIT = 10

const AXIS_X = new THREE.Vector3(1, 0, 0)
const VIOLET = new THREE.Color('#bd6cff')
const CYAN = new THREE.Color('#5fd0ff')
const SPARK = new THREE.Color('#f3f4ff')
const ROOT_GLOW = new THREE.Color('#d8b4ff')

/* Shared empty link map: a fresh `{}` every render would re-make the graph, and a
   new graph identity rebuilds the whole WebGL scene. */
const NO_LINKS = {}

/* Filler words: without them every thread that says "project" again lights up a
   cable to every memory that mentions it. */
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'are', 'you', 'your', 'please', 'about', 'into', 'using', 'will', 'would', 'could', 'should', 'because', 'what', 'when', 'where', 'which', 'who', 'how', 'not', 'can', 'did', 'make', 'made', 'just', 'like', 'need', 'want', 'some', 'more', 'them', 'they', 'their', 'here', 'there', 'today', 'really', 'things', 'thing', 'message', 'tell', 'asked', 'answer'])

function tokenize(text) {
  return String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter((word) => word.length > 3 && !STOP_WORDS.has(word))
}

/* Distinctive words of a memory, deduplicated. */
function keywordsOf(text) {
  return Array.from(new Set(tokenize(text)))
}

/* Two tilted orbits — memories on the inner ring, threads on the outer — so the
   graph reads as layered rather than as a random smear of labels. */
function orbit(index, count, radius, tilt, phase, lift) {
  const angle = (index / Math.max(count, 1)) * Math.PI * 2 + phase
  return new THREE.Vector3(Math.cos(angle) * radius, lift * (((index % 2) - 0.5) * 2), Math.sin(angle) * radius)
    .applyAxisAngle(AXIS_X, tilt)
}

/* One lumpy cerebrum sample: a unit sphere direction pushed through an
   ellipsoid, three summed ripples (gyri and sulci), a flattened base, then the
   longitudinal fissure that splits the hemispheres. Deterministic shape, random
   point — the wrinkle field is what stops it reading as a ball. */
function brainDirection(out) {
  const u = Math.random() * 2 - 1
  const theta = Math.random() * Math.PI * 2
  const spread = Math.sqrt(1 - u * u)
  let x = spread * Math.cos(theta)
  let y = u
  let z = spread * Math.sin(theta)
  if (y < -0.35) y = -0.35 + (y + 0.35) * 0.5
  const wrinkle = 1
    + 0.075 * Math.sin(x * 6.1 + z * 2.4) * Math.sin(y * 5.6 - x * 1.9)
    + 0.04 * Math.sin(z * 9.3 + y * 4.1)
    + 0.03 * Math.sin(x * 12.7 - y * 8.2)
  x = x * 1.04 * wrinkle
  y = y * 0.94 * wrinkle
  z = z * 1.28 * wrinkle
  x += Math.sign(x) * (0.05 + 0.03 * Math.abs(z))
  out[0] = x
  out[1] = y
  out[2] = z
}

export default function MemoryVault({ aiName, isLoggedIn, authToken, facts, chats }) {
  const [phase, setPhase] = useState('gate')
  const [selected, setSelected] = useState(null)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [provenance, setProvenance] = useState(null)
  const sceneRef = useRef(null)
  const labelLayerRef = useRef(null)
  const labelEls = useRef([])
  const selectedRef = useRef(null)
  const reduceRef = useRef(false)
  /* Set once the particles have already flown in: re-opening a cable because a
     memory was added must not replay the whole assembly. */
  const formedOnceRef = useRef(false)

  const memories = facts.items
  const conversations = chats.items
  const open = phase !== 'gate'

  useEffect(() => { selectedRef.current = selected }, [selected])

  /* Reduced motion is read in an effect, not in the click handler — the lint
     rule that keeps render pure is also the one that stops the door flashing at
     someone who cannot tolerate it. */
  useEffect(() => {
    try { reduceRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { /* no matchMedia */ }
  }, [])

  /* Escape shuts the detail sheet — the map is a mouse-and-drag surface, so the
     keyboard needs the same out it has everywhere else in the workspace. */
  useEffect(() => {
    if (!selected) return undefined
    const onKey = (event) => { if (event.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  /* Nothing to correlate until there is both a memory and a thread to read: in
     that case the map is settled and empty by derivation, so no effect has to
     set state synchronously. */
  const correlatable = Boolean(authToken) && conversations.length > 0 && memories.length > 0
  const links = correlatable ? provenance : NO_LINKS
  const linksSettled = !correlatable || provenance !== null

  useEffect(() => {
    if (!open || !correlatable) return undefined
    let cancelled = false
    const keys = memories.map((m) => ({ id: m.id, words: keywordsOf(`${m.key} ${m.value}`) }))
    const run = async () => {
      const found = {}
      for (const thread of conversations.slice(0, PROVENANCE_LIMIT)) {
        if (cancelled) return
        try {
          const detail = await getConversation(authToken, thread.id)
          const tokens = new Set([
            ...tokenize(detail.title ?? thread.title),
            ...(detail.messages ?? []).flatMap((msg) => tokenize(msg.content)),
          ])
          /* One shared word is coincidence; two is the memory being discussed. */
          const hits = keys.filter((k) => k.words.filter((word) => tokens.has(word)).length >= 2).map((k) => k.id)
          if (hits.length) found[thread.id] = hits
        } catch { /* offline, or a thread deleted mid-read — that cable is simply not drawn */ }
      }
      if (!cancelled) setProvenance(found)
    }
    run()
    return () => { cancelled = true }
  }, [open, correlatable, authToken, conversations, memories])

  /* Identity changes exactly when the graph does, which is what the WebGL effect
     below keys on — a rebuilt scene then gets the fresh nodes without needing
     the arrays themselves in its deps. */
  const graph = useMemo(() => {
    const factList = memories.slice(0, FACT_LIMIT)
    const chatList = conversations.slice(0, CHAT_LIMIT)
    const nodes = [
      ...factList.map((m, i) => ({ id: `fact:${m.id}`, kind: 'fact', label: m.key, sub: m.value, ref: m, pos: orbit(i, factList.length, 3.35, 0.5, 0.4, 0.34) })),
      ...chatList.map((c, i) => ({ id: `chat:${c.id}`, kind: 'chat', label: c.title, sub: new Date(c.updatedAt).toLocaleString(), ref: c, pos: orbit(i, chatList.length, 4.0, -0.34, 0.4 + Math.PI / Math.max(chatList.length, 1), 0.5) })),
    ]
    const seen = new Set()
    const edges = []
    for (const [chatId, factIds] of Object.entries(links ?? {})) {
      for (const factId of factIds) {
        const key = `fact:${factId}|chat:${chatId}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ from: `fact:${factId}`, to: `chat:${chatId}` })
      }
    }
    return { nodes, edges }
  }, [memories, conversations, links])

  const wiredCount = useMemo(() => new Set(graph.edges.map((e) => e.from)).size, [graph])

  const openDoor = () => { formedOnceRef.current = false; setPhase('brain') }
  const closeDoor = () => { setPhase('gate'); setSelected(null) }

  const nodeById = (id) => graph.nodes.find((n) => n.id === id)
  const selectedNode = selected ? nodeById(selected) : null
  const linkedChats = selectedNode?.kind === 'fact' ? graph.edges.filter((e) => e.from === selectedNode.id).map((e) => nodeById(e.to)).filter(Boolean) : []
  const linkedFacts = selectedNode?.kind === 'chat' ? graph.edges.filter((e) => e.to === selectedNode.id).map((e) => nodeById(e.from)).filter(Boolean) : []

  useEffect(() => {
    const mount = sceneRef.current
    const labelLayer = labelLayerRef.current
    if (!open || !mount || !labelLayer) return undefined

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60)
    camera.position.set(0, 0.3, 8.4)
    /* preserveDrawingBuffer for the same reason ThreeHero and NanoParticles pay it:
       without it the WebGL buffer is cleared after compositing, so "her own eyes on
       the app" (selfCapture) sees a black rectangle where the brain is — and a
       harness cannot prove a single particle was drawn. */
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    let width = 1
    let height = 1
    const applySize = () => {
      width = mount.clientWidth || 640
      height = mount.clientHeight || 460
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const canvas = renderer.domElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    mount.appendChild(canvas)
    applySize()
    const resizeObserver = new ResizeObserver(() => applySize())
    resizeObserver.observe(mount)

    const group = new THREE.Group()
    group.rotation.x = -0.1
    scene.add(group)

    /* Soft round sprite: additive blending multiplies it by the vertex colour, so
       one texture gives every particle its own glow tint. */
    const spriteCanvas = document.createElement('canvas')
    spriteCanvas.width = spriteCanvas.height = 64
    const paint = spriteCanvas.getContext('2d')
    const falloff = paint.createRadialGradient(32, 32, 0, 32, 32, 32)
    falloff.addColorStop(0, 'rgba(255,255,255,1)')
    falloff.addColorStop(0.35, 'rgba(255,255,255,.7)')
    falloff.addColorStop(1, 'rgba(255,255,255,0)')
    paint.fillStyle = falloff
    paint.fillRect(0, 0, 64, 64)
    const sprite = new THREE.CanvasTexture(spriteCanvas)

    /* ---- the brain: nano particles on a wrinkled, split ellipsoid ---- */
    const start = new Float32Array(PARTICLES * 3)
    const target = new Float32Array(PARTICLES * 3)
    const current = new Float32Array(PARTICLES * 3)
    const colors = new Float32Array(PARTICLES * 3)
    const phases = new Float32Array(PARTICLES)
    const sample = [0, 0, 0]
    const tint = new THREE.Color()
    for (let i = 0; i < PARTICLES; i += 1) {
      const i3 = i * 3
      brainDirection(sample)
      /* ~30% of the mass sits inside the shell, so the brain has volume and not
         the papery look of a single surface. */
      const scale = 1.5 * (Math.random() < 0.3 ? 0.45 + 0.52 * Math.cbrt(Math.random()) : 1)
      /* Every ninth particle is the cerebellum tucked under the back — the shape
         is unreadable as a brain without it. */
      if (i % 9 === 0) {
        target[i3] = sample[0] * 0.4
        target[i3 + 1] = -1.12 + sample[1] * 0.3
        target[i3 + 2] = -1.42 + sample[2] * 0.4
      } else {
        target[i3] = sample[0] * scale
        target[i3 + 1] = sample[1] * scale
        target[i3 + 2] = sample[2] * scale
      }
      /* Assembly flies in from a wide shell, so the particles read as arriving. */
      const u = Math.random() * 2 - 1
      const theta = Math.random() * Math.PI * 2
      const spread = Math.sqrt(1 - u * u)
      const reach = 5.5 + Math.random() * 4
      start[i3] = spread * Math.cos(theta) * reach
      start[i3 + 1] = u * reach
      start[i3 + 2] = spread * Math.sin(theta) * reach
      current[i3] = start[i3]
      current[i3 + 1] = start[i3 + 1]
      current[i3 + 2] = start[i3 + 2]
      phases[i] = Math.random() * Math.PI * 2
      tint.copy(VIOLET).lerp(CYAN, Math.min(1, Math.max(0, 0.5 + target[i3 + 1] * 0.26 + target[i3 + 2] * 0.18)))
      if (Math.random() < 0.1) tint.lerp(SPARK, 0.85)
      colors[i3] = tint.r
      colors[i3 + 1] = tint.g
      colors[i3 + 2] = tint.b
    }
    const cloudGeometry = new THREE.BufferGeometry()
    cloudGeometry.setAttribute('position', new THREE.BufferAttribute(current, 3))
    cloudGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const cloudMaterial = new THREE.PointsMaterial({ size: 0.06, map: sprite, vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false, blending: THREE.AdditiveBlending })
    const cloud = new THREE.Points(cloudGeometry, cloudMaterial)
    group.add(cloud)

    const coreGeometry = new THREE.SphereGeometry(0.95, 32, 32)
    const coreMaterial = new THREE.MeshBasicMaterial({ color: 0x6a3fd8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    const core = new THREE.Mesh(coreGeometry, coreMaterial)
    const haloGeometry = new THREE.SphereGeometry(1.8, 32, 32)
    const haloMaterial = new THREE.MeshBasicMaterial({ color: 0x8b5cff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    const halo = new THREE.Mesh(haloGeometry, haloMaterial)
    group.add(core, halo)

    /* ---- the cables: one tube per node, rooted INSIDE the particle mass ---- */
    const cables = []
    const disposables = []
    const anchor = new THREE.Vector3()
    const perp = new THREE.Vector3()
    const beadGeometry = new THREE.SphereGeometry(0.055, 10, 10)
    graph.nodes.forEach((node, i) => {
      const end = node.pos
      const base = node.kind === 'fact' ? VIOLET : CYAN
      anchor.copy(end).normalize()
      perp.set(0, 1, 0).cross(anchor).normalize()
      const curve = new THREE.CatmullRomCurve3([
        /* Buried at 0.25 — the wire has to come out of the brain, not start on
           its skin, which is what makes it read as a cable from inside. */
        anchor.clone().multiplyScalar(0.25),
        anchor.clone().multiplyScalar(1.4).addScaledVector(perp, 0.24 * (i % 2 ? 1 : -1)),
        anchor.clone().multiplyScalar(2.05).addScaledVector(perp, -0.14),
        end,
      ])
      const tubeGeometry = new THREE.TubeGeometry(curve, 44, node.kind === 'fact' ? 0.013 : 0.01, 6, false)
      const uv = tubeGeometry.attributes.uv
      const tubeColors = new Float32Array(uv.count * 3)
      for (let v = 0; v < uv.count; v += 1) {
        const t = uv.getX(v)
        /* Additive blending reads a dark colour as a thin wire, so the cable
           dims towards its node instead of ending in a hard cut, and glows
           brightest where it leaves the brain. */
        tint.copy(ROOT_GLOW).lerp(base, Math.min(1, t * 1.7)).multiplyScalar(0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, t * 1.12)))
        tubeColors[v * 3] = tint.r
        tubeColors[v * 3 + 1] = tint.g
        tubeColors[v * 3 + 2] = tint.b
      }
      tubeGeometry.setAttribute('color', new THREE.BufferAttribute(tubeColors, 3))
      const tubeMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
      group.add(new THREE.Mesh(tubeGeometry, tubeMaterial))
      disposables.push(tubeGeometry, tubeMaterial)

      const pulseGeometry = new THREE.SphereGeometry(0.032, 8, 8)
      const pulseMaterial = new THREE.MeshBasicMaterial({ color: node.kind === 'fact' ? 0xe2c6ff : 0xbdefff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
      const pulse = new THREE.Mesh(pulseGeometry, pulseMaterial)
      group.add(pulse)
      disposables.push(pulseGeometry, pulseMaterial)

      const beadMaterial = new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
      const bead = new THREE.Mesh(beadGeometry, beadMaterial)
      bead.position.copy(end)
      group.add(bead)
      disposables.push(beadMaterial)

      cables.push({ id: node.id, curve, pulse, tubeMaterial, pulseMaterial, bead, speed: 0.26 + (i % 5) * 0.05, offset: i / Math.max(graph.nodes.length, 1) })
    })

    /* ---- fact ↔ thread fibres, only where the memory was really spoken ---- */
    let fibreGeometry = null
    let fibreMaterial = null
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const fibrePoints = []
    for (const edge of graph.edges) {
      const a = byId.get(edge.from)
      const b = byId.get(edge.to)
      if (a && b) fibrePoints.push(a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z)
    }
    if (fibrePoints.length) {
      fibreGeometry = new THREE.BufferGeometry()
      fibreGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fibrePoints, 3))
      fibreMaterial = new THREE.LineBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
      group.add(new THREE.LineSegments(fibreGeometry, fibreMaterial))
    }

    /* ---- drag to spin: the canvas only, so labels stay clickable ---- */
    let dragging = false
    let lastX = 0
    let lastY = 0
    let spin = 0
    let tilt = -0.1
    const onPointerDown = (event) => { dragging = true; lastX = event.clientX; lastY = event.clientY; canvas.style.cursor = 'grabbing' }
    const onPointerMove = (event) => {
      if (!dragging) return
      spin += (event.clientX - lastX) * 0.006
      tilt = Math.min(0.45, Math.max(-0.55, tilt + (event.clientY - lastY) * 0.004))
      lastX = event.clientX
      lastY = event.clientY
    }
    const onPointerUp = () => { dragging = false; canvas.style.cursor = 'grab' }
    canvas.style.cursor = 'grab'
    canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    const reduce = reduceRef.current
    const formationStart = formedOnceRef.current ? 0 : FORM_DELAY
    formedOnceRef.current = true

    /* THREE.Clock is deprecated (logs a console warning on every mount); a plain
       performance.now() delta gives the same seconds-since-mount for the animation. */
    const startTime = performance.now()
    const world = new THREE.Vector3()
    const projected = new THREE.Vector3()
    let raf = 0
    const animate = () => {
      const elapsed = (performance.now() - startTime) / 1000
      const formT = Math.min(1, Math.max(0, (elapsed - formationStart) / FORM_SECONDS))
      const ease = 1 - (1 - formT) ** 3
      for (let i = 0; i < PARTICLES; i += 1) {
        const i3 = i * 3
        const breathe = Math.sin(elapsed * 1.15 + phases[i]) * 0.02 * ease
        current[i3] = start[i3] + (target[i3] - start[i3]) * ease
        current[i3 + 1] = start[i3 + 1] + (target[i3 + 1] - start[i3 + 1]) * ease + breathe
        current[i3 + 2] = start[i3 + 2] + (target[i3 + 2] - start[i3 + 2]) * ease
      }
      cloudGeometry.attributes.position.needsUpdate = true

      /* Cables, glow and labels all fade in on the same curve as the assembly, so
         the map arrives as one object instead of popping element by element. */
      coreMaterial.opacity = 0.2 * ease
      haloMaterial.opacity = 0.07 * ease
      if (fibreMaterial) fibreMaterial.opacity = 0.34 * ease * (0.8 + Math.sin(elapsed * 1.6) * 0.2)
      const picked = selectedRef.current
      for (const cable of cables) {
        const t = (elapsed * cable.speed + cable.offset) % 1
        cable.tubeMaterial.opacity = 0.9 * ease
        cable.pulseMaterial.opacity = Math.sin(t * Math.PI) * 0.95 * ease
        cable.curve.getPoint(t, cable.pulse.position)
        /* The bead is the node's own light: it swells when its label is open so
           the sheet always has something pointing back into the brain. */
        cable.bead.scale.setScalar(cable.id === picked ? 1.8 : 1)
        cable.bead.material.opacity = ease * (cable.id === picked ? 1 : 0.5 + 0.35 * Math.sin(elapsed * 2.2 + cable.offset * 6))
      }

      if (!dragging) spin += reduce ? 0.0004 : 0.0019
      group.rotation.y += (spin - group.rotation.y) * 0.07
      group.rotation.x += (tilt - group.rotation.x) * 0.08
      scene.updateMatrixWorld()

      /* Screen-space labels: the DOM carries the text (selectable, focusable,
         crisp) while three.js decides where it floats and how deep it sits. */
      labelLayer.style.opacity = String(ease)
      graph.nodes.forEach((node, i) => {
        const el = labelEls.current[i]
        if (!el) return
        world.copy(node.pos).applyMatrix4(group.matrixWorld)
        const depth = world.distanceTo(camera.position)
        projected.copy(world).project(camera)
        const x = (projected.x * 0.5 + 0.5) * width
        const y = (-projected.y * 0.5 + 0.5) * height
        /* 8.4 is the camera distance, ±3.2 the ring radius: near nodes land on
           full opacity and full size, far ones recede behind the brain. */
        const near = Math.min(1, Math.max(0, (11.4 - depth) / 6))
        const isOn = selectedRef.current === node.id
        el.style.transform = `translate(-50%,-50%) translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${(0.82 + near * 0.22 + (isOn ? 0.06 : 0)).toFixed(3)})`
        el.style.opacity = (ease * (0.3 + near * 0.7)).toFixed(3)
        el.style.zIndex = isOn ? '3' : String(10 + Math.round(near * 100))
      })

      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      resizeObserver.disconnect()
      cancelAnimationFrame(raf)
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      cloudGeometry.dispose()
      cloudMaterial.dispose()
      coreGeometry.dispose()
      coreMaterial.dispose()
      haloGeometry.dispose()
      haloMaterial.dispose()
      beadGeometry.dispose()
      fibreGeometry?.dispose()
      fibreMaterial?.dispose()
      for (const item of disposables) item.dispose()
      sprite.dispose()
      renderer.dispose()
      if (canvas.parentNode === mount) mount.removeChild(canvas)
      labelLayer.style.opacity = '0'
    }
  }, [open, graph])

  return <section className="workspace-page-panel memory-page vault-page">
    {phase === 'gate' ? <div className="vault-gate">
      <div className="settings-icon" aria-hidden="true"><Icon name="memory" size={26} /></div>
      <h2>Everything {aiName} remembers about you is behind this door.</h2>
      <p>Every fact she has kept, and every chat and Talk call the two of you have saved — folded up and strung together as one living map.</p>
      <p>Nothing shows until you open it. Press the button and the vault lights up.</p>
      <div className="vault-gate-actions">
        <button type="button" className="vault-open" onClick={openDoor} disabled={!isLoggedIn}><Icon name="memory" size={16} />View memory</button>
        <small className="vault-gate-hint">{isLoggedIn ? 'It spins once it opens — drag to turn it.' : `Sign in and ${aiName} will start remembering you — every fact and every chat lands behind this door.`}</small>
      </div>
    </div> : <div className="vault-stage">
      <div className="vault-scene" ref={sceneRef} aria-hidden="true" />
      <div className="vault-labels" ref={labelLayerRef}>{graph.nodes.map((node, i) => <button
        type="button"
        key={node.id}
        ref={(el) => { labelEls.current[i] = el }}
        className={`vault-node${selected === node.id ? ' is-selected' : ''}`}
        data-kind={node.kind}
        aria-expanded={selected === node.id}
        onClick={() => setSelected(selected === node.id ? null : node.id)}
      ><i aria-hidden="true"><Icon name={node.kind === 'fact' ? 'memory' : 'thread'} size={13} /></i><b>{node.label}</b></button>)}</div>
      <div className="vault-topline">
        <button type="button" className="vault-close-door" onClick={closeDoor}><Icon name="arrowLeft" size={15} />Close the door</button>
        <span className="vault-legend" aria-hidden="true"><em className="lg-fact"><Icon name="memory" size={12} /> memory</em><em className="lg-chat"><Icon name="thread" size={12} /> chat</em></span>
        <button type="button" className="vault-ledger-btn" aria-expanded={ledgerOpen} onClick={() => setLedgerOpen((isOpen) => !isOpen)}>{ledgerOpen ? 'Hide' : 'Manage'} the ledger</button>
      </div>
      {selectedNode ? <div className="vault-sheet" role="dialog" aria-label={selectedNode.kind === 'fact' ? 'Memory detail' : 'Conversation detail'}>
        <header><span aria-hidden="true"><Icon name={selectedNode.kind === 'fact' ? 'memory' : 'thread'} size={15} /></span><b>{selectedNode.label}</b><button type="button" className="vault-sheet-close" aria-label="Close detail" onClick={() => setSelected(null)}>×</button></header>
        {selectedNode.kind === 'fact' ? <p className="vault-sheet-value">{selectedNode.sub}</p> : <small className="vault-sheet-when">{selectedNode.sub}</small>}
        <div className="vault-sheet-links">
          <small aria-live="polite">{selectedNode.kind === 'fact'
            ? (linkedChats.length ? `Cabled into ${linkedChats.length} ${linkedChats.length === 1 ? 'thread' : 'threads'}` : 'No thread mentions this yet')
            : (linkedFacts.length ? `${linkedFacts.length} memor${linkedFacts.length === 1 ? 'y' : 'ies'} cabled in here` : 'No memory cabled in here yet')}</small>
          {(selectedNode.kind === 'fact' ? linkedChats : linkedFacts).map((other) => <button type="button" className="vault-link" key={other.id} onClick={() => (selectedNode.kind === 'fact' ? chats.open(other.ref.id) : setSelected(other.id))}>
            <span aria-hidden="true"><Icon name={selectedNode.kind === 'fact' ? 'thread' : 'memory'} size={14} /></span>{other.label}
          </button>)}
          {selectedNode.kind === 'chat' && <button type="button" className="vault-link" onClick={() => chats.open(selectedNode.ref.id)}><Icon name="external" size={13} />Open this chat with {aiName}</button>}
        </div>
        <div className="vault-sheet-actions">
          {selectedNode.kind === 'fact' ? <>
            <button type="button" className="vault-sheet-del" onClick={() => { facts.remove(selectedNode.ref.id); setSelected(null) }}>Forget this</button>
            <button type="button" className="vault-sheet-go" onClick={() => { facts.setDraft({ key: selectedNode.ref.key, value: selectedNode.ref.value, editingId: selectedNode.ref.id }); setLedgerOpen(true); setSelected(null) }}>Edit in ledger</button>
          </> : <>
            <button type="button" className="vault-sheet-del" onClick={() => { chats.remove(selectedNode.ref.id); setSelected(null) }}>Delete chat</button>
            <button type="button" className="vault-sheet-go" onClick={() => chats.open(selectedNode.ref.id)}>Open chat →</button>
          </>}
        </div>
      </div> : <p className="vault-hint" aria-live="polite">
        {linksSettled ? (wiredCount ? `${wiredCount} of ${memories.length} memor${memories.length === 1 ? 'y is' : 'ies are'} cabled into the threads they were spoken in.` : memories.length && conversations.length ? `Nothing is cabled yet — tell ${aiName} something you want her to remember, in a chat, and the wire will appear here.` : `Empty in here. Tell ${aiName} something about yourself and it will show up as a node.`) : 'Reading which chats each memory lives in…'}
        <small>Drag to spin · click a node to open it</small>
      </p>}
    </div>}
    {open && ledgerOpen && <div className="vault-drawer" role="region" aria-label="Memory ledger">
      <div className="memory-grid">
        <section className="memory-card" aria-label="Remembered facts">
          <header><Icon name="memory" size={16} /><b>Remembered facts</b><small>{memories.length} {memories.length === 1 ? 'note' : 'notes'}</small></header>
          <form className="memory-add" onSubmit={facts.submit}>
            <input value={facts.draft.key} onChange={(event) => facts.setDraft((draft) => ({ ...draft, key: event.target.value }))} placeholder="Topic (e.g. Preferred language)" maxLength={80} aria-label="Memory topic" />
            <input value={facts.draft.value} onChange={(event) => facts.setDraft((draft) => ({ ...draft, value: event.target.value }))} placeholder="Detail (e.g. Reply in Roman Urdu)" maxLength={2000} aria-label="Memory detail" />
            <button className="button" type="submit" disabled={facts.busy || !facts.draft.key.trim() || !facts.draft.value.trim()}>{facts.draft.editingId ? 'Save' : 'Add'}</button>
            {facts.draft.editingId && <button className="button button-ghost" type="button" onClick={() => facts.setDraft({ key: '', value: '', editingId: null })}>Cancel</button>}
          </form>
          {facts.loading && <p className="memory-status">Loading memories…</p>}
          {!facts.loading && memories.length === 0 && <p className="memory-status">No facts yet. Add one above, or tell {aiName} during a Talk call — she only stores what you approve here.</p>}
          <ul className="memory-list">{memories.map((m) => <li key={m.id}>
            <div className="memory-text"><strong>{m.key}</strong><span>{m.value}</span></div>
            <div className="memory-ops">
              <button type="button" onClick={() => facts.setDraft({ key: m.key, value: m.value, editingId: m.id })}>Edit</button>
              <button type="button" className="memory-danger" onClick={() => facts.remove(m.id)}>Delete</button>
            </div>
          </li>)}</ul>
        </section>
        <section className="memory-card" aria-label="Conversations">
          <header><Icon name="thread" size={16} /><b>Conversations</b><small>{conversations.length} saved</small></header>
          {conversations.length > 0 && <div className="history-toolbar">
            <label className="history-search">
              <Icon name="search" size={15} />
              <input type="search" value={chats.query} onChange={(event) => chats.setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" autoComplete="off" />
            </label>
            {chats.confirming ? <div className="history-confirm" role="group" aria-label="Confirm delete all">
              <span>Delete all {conversations.length}?</span>
              <button type="button" className="history-confirm-yes" onClick={chats.removeAll}>Yes, delete all</button>
              <button type="button" className="history-confirm-no" onClick={() => chats.setConfirming(false)}>Cancel</button>
            </div> : <button type="button" className="history-clear-all" onClick={() => chats.setConfirming(true)}>Delete all</button>}
          </div>}
          {chats.loading && <p className="history-empty">Loading…</p>}
          {!chats.loading && conversations.length === 0 && <p className="history-empty">Nothing saved yet. Start a chat or a Talk call and it will show up here.</p>}
          {!chats.loading && conversations.length > 0 && chats.visible.length === 0 && <p className="history-empty">No conversations match “{chats.query.trim()}”.</p>}
          <ul className="history-list">{chats.visible.map((c) => <li key={c.id}>
            <button type="button" className="history-open" onClick={() => chats.open(c.id)}>
              <strong>{c.title}</strong>
              {/* The stored model id used to be printed here, which showed every
                  user the exact engine behind each thread — the private plumbing,
                  on purpose. A row needs a timestamp, not a part number. */}
              <small>{new Date(c.updatedAt).toLocaleString()}</small>
            </button>
            <button type="button" className="history-del" aria-label={`Delete ${c.title}`} onClick={() => chats.remove(c.id)}>×</button>
          </li>)}</ul>
          {conversations.length > CHAT_LIMIT && <p className="memory-status">The map draws the {CHAT_LIMIT} newest threads — every one of them is listed here.</p>}
        </section>
      </div>
    </div>}
  </section>
}
