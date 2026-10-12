// @vitest-environment jsdom
/**
 * The interaction chain against the BUILT bundle, not the sources.
 *
 * Every other interaction test imports `src/`. This one imports the artifact the
 * browser actually loads, so a build that drops a module (tree-shaken, renamed,
 * bundled away) cannot pass unnoticed — which is the failure mode where the
 * tests are green and the feature is dead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'

/**
 * The bundle is an IIFE/CJS artifact built for the GUI's module loader, so it
 * cannot be imported directly. Reading it and asserting on the emitted code is
 * the honest check available here: it proves the shipped artifact carries the
 * modules, and the source-level integration test proves they work together.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BUNDLE = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the built client bundle', () => {
  it('carries every interaction module', () => {
    // A module the bundler dropped would leave the feature dead in the browser
    // while every source-level test still passed.
    for (const marker of [
      'usePetWorldPresence',
      'usePetInteractions',
      'useSpontaneousActs',
      'celebrate-notice',
      'failure-notice',
      'resolveChain',
    ]) {
      expect(BUNDLE, marker).toContain(marker)
    }
  })

  it('carries the tuned act cadence', () => {
    // The visible cadence is a product decision; shipping the old numbers would
    // make the feature effectively invisible (the 25s/0.45 tuning averaged over
    // five minutes between interactions).
    //
    // Anchor on the constant's own block rather than a bare `intervalMs:` —
    // the ambient roam declares one too, so an unanchored match would pass on
    // the wrong numbers.
    const block = BUNDLE.slice(BUNDLE.indexOf('DEFAULT_ACT_CONFIG'))
    expect(block).toMatch(/intervalMs:\s*12e3/)
    expect(block).toMatch(/probability:\s*\.?0?\.?6\b/)
  })

  it('weights the interactable acts highest', () => {
    // `jumping` and `failed` are the states the shipped rules listen for, so
    // they must outrank the purely cosmetic acts or interactions become rare
    // again.
    const block = BUNDLE.slice(BUNDLE.indexOf('DEFAULT_ACTS'))
    const jumping = /track:\s*"jumping",\s*holdMs:\s*\d+,\s*weight:\s*(\d+)/.exec(block)
    const review = /track:\s*"review",\s*holdMs:\s*\d+,\s*weight:\s*(\d+)/.exec(block)
    expect(jumping).not.toBeNull()
    expect(review).not.toBeNull()
    expect(Number(jumping![1])).toBeGreaterThan(Number(review![1]))
  })

  it('carries the personality profiles', () => {
    // Without these the rules would still run but every pet would answer
    // identically, which is the "always in sync" problem the offset exists to
    // solve.
    expect(BUNDLE).toContain('onCelebrate')
    expect(BUNDLE).toContain('long-niang')
  })

  it('carries the world module', () => {
    expect(BUNDLE).toContain('setPresence')
    expect(BUNDLE).toContain('lastOfKind')
  })
})
