// src/components/ParticleField.tsx — seamless ambient background (KIEO-050).
//
// Frontend Spec v4 calls for a soft cyan/emerald particle field drifting on
// the base canvas (not the v3 ticket's video file — no binary asset ships
// with the repo, and a procedural field loops forever with zero restart
// flash by construction). DOM-free motion math lives in stepParticles() so
// vitest covers wrapping/drift without a canvas.
import { useEffect, useRef } from 'react'

export interface Particle {
  /** Normalized coords (0..1) — resolution-independent, wraps modulo 1. */
  x: number
  y: number
  /** Drift velocity in normalized units per second. */
  vx: number
  vy: number
  /** Radius in CSS pixels. */
  r: number
  color: string
  alpha: number
}

const PALETTE = ['#06B6D4', '#10B981', '#8B5CF6', '#4CD7F6']

export const PARTICLE_COUNT = 70

export function createParticles(
  count: number = PARTICLE_COUNT,
  rand: () => number = Math.random
): Particle[] {
  const out: Particle[] = []
  for (let i = 0; i < count; i++) {
    const speed = 0.008 + rand() * 0.02
    const angle = rand() * Math.PI * 2
    out.push({
      x: rand(),
      y: rand(),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.7,
      r: 1 + rand() * 1.6,
      color: PALETTE[Math.floor(rand() * PALETTE.length)],
      alpha: 0.12 + rand() * 0.3
    })
  }
  return out
}

/** Advance particles by dt seconds, wrapping at the unit-square edges. */
export function stepParticles(particles: Particle[], dtSeconds: number): void {
  const dt = Math.max(0, Math.min(dtSeconds, 0.05))
  for (const p of particles) {
    p.x = (((p.x + p.vx * dt) % 1) + 1) % 1
    p.y = (((p.y + p.vy * dt) % 1) + 1) % 1
  }
}

export default function ParticleField(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let particles = createParticles()
    let last = performance.now()
    let disposed = false

    const resize = (): void => {
      const parent = canvas.parentElement
      if (!parent) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.max(1, Math.floor(parent.clientWidth * dpr))
      const h = Math.max(1, Math.floor(parent.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = (now: number): void => {
      if (disposed) return
      const dt = (now - last) / 1000
      last = now
      stepParticles(particles, dt)
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      for (const p of particles) {
        ctx.globalAlpha = p.alpha
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x * w, p.y * h, p.r * (w / 800 + 0.6), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }

    // Reduced motion: one static frame, no loop (WCAG + battery).
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      for (const p of particles) {
        ctx.globalAlpha = p.alpha
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x * w, p.y * h, p.r * (w / 800 + 0.6), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    } else {
      raf = requestAnimationFrame(draw)
    }

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}
