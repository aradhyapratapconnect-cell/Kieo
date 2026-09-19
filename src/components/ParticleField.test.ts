// src/components/ParticleField.test.ts — KIEO-050 ambient loop coverage.
//
// The canvas itself is manual-tested (no headless GPU in CI); the motion
// math that guarantees a seamless, never-restarting loop is unit-tested:
// normalized coords always wrap modulo 1, so no particle ever leaves or
// pops — the field is continuous by construction.
import { describe, expect, it } from 'vitest'
import { createParticles, stepParticles, type Particle } from './ParticleField'

describe('KIEO-050 particle field (seamless ambient loop)', () => {
  it('spawns normalized particles', () => {
    const particles = createParticles(70)
    expect(particles).toHaveLength(70)
    for (const p of particles) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThan(1)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThan(1)
    }
  })

  it('drifts with velocity and wraps at edges', () => {
    const p: Particle = { x: 0.5, y: 0.5, vx: 0.1, vy: -0.2, r: 1.5, color: '#06B6D4', alpha: 0.3 }
    stepParticles([p], 0.05)
    expect(p.x).toBeCloseTo(0.505)
    expect(p.y).toBeCloseTo(0.49)

    // dt is clamped to 0.05s: 0.99 + 0.4*0.05 wraps past 1 -> ~0.01.
    const edge: Particle = { x: 0.99, y: 0.01, vx: 0.4, vy: -0.4, r: 1, color: '#06B6D4', alpha: 0.3 }
    stepParticles([edge], 0.05)
    expect(edge.x).toBeGreaterThanOrEqual(0)
    expect(edge.x).toBeLessThan(1)
    expect(edge.y).toBeGreaterThanOrEqual(0)
    expect(edge.y).toBeLessThan(1)
    // 0.99 + 0.02 wraps past 1 -> ~0.01; 0.01 - 0.02 wraps below 0 -> ~0.99.
    expect(edge.x).toBeCloseTo(0.01)
    expect(edge.y).toBeCloseTo(0.99)
  })

  it('clamps huge frame gaps so background tabs never teleport the field', () => {
    const a: Particle = { x: 0.5, y: 0.5, vx: 1, vy: 0, r: 1, color: '#06B6D4', alpha: 0.3 }
    const b: Particle = { x: 0.5, y: 0.5, vx: 1, vy: 0, r: 1, color: '#06B6D4', alpha: 0.3 }
    stepParticles([a], 10)
    stepParticles([b], 0.05)
    expect(a.x).toBeCloseTo(b.x)
  })
})
