import { describe, it, expect } from 'vitest'
import { getTilePixelDensity, selectLod, getMaxUsefulLod, selectImageLod } from './lodSelection'

const TILE_SIZE = 256
const BASE_WORLD_SIZE = 4
const MAX_LOD = 4

describe('getTilePixelDensity', () => {
  it('LOD 0: 256 / 4 = 64 px/unit', () => {
    expect(getTilePixelDensity(0, TILE_SIZE, BASE_WORLD_SIZE)).toBe(64)
  })

  it('LOD 1: 128 px/unit', () => {
    expect(getTilePixelDensity(1, TILE_SIZE, BASE_WORLD_SIZE)).toBe(128)
  })

  it('LOD 2: 256 px/unit', () => {
    expect(getTilePixelDensity(2, TILE_SIZE, BASE_WORLD_SIZE)).toBe(256)
  })

  it('LOD 3: 512 px/unit', () => {
    expect(getTilePixelDensity(3, TILE_SIZE, BASE_WORLD_SIZE)).toBe(512)
  })

  it('LOD 4: 1024 px/unit', () => {
    expect(getTilePixelDensity(4, TILE_SIZE, BASE_WORLD_SIZE)).toBe(1024)
  })

  it('doubles with each LOD level', () => {
    for (let i = 0; i < 4; i++) {
      const d0 = getTilePixelDensity(i, TILE_SIZE, BASE_WORLD_SIZE)
      const d1 = getTilePixelDensity(i + 1, TILE_SIZE, BASE_WORLD_SIZE)
      expect(d1).toBe(d0 * 2)
    }
  })
})

describe('selectLod', () => {
  // Exact transition points: LOD 0 covers up to 64 px/unit,
  // LOD 1 up to 128, LOD 2 up to 256, etc.

  describe('transition boundaries', () => {
    it('zoom ≤ baseDensity (64) → LOD 0', () => {
      expect(selectLod(1, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(0)
      expect(selectLod(32, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(0)
      expect(selectLod(64, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(0)
    })

    it('zoom just above 64 → LOD 1', () => {
      expect(selectLod(65, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(1)
    })

    it('zoom = 128 → LOD 1 (exactly matches LOD 1 density)', () => {
      expect(selectLod(128, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(1)
    })

    it('zoom just above 128 → LOD 2', () => {
      expect(selectLod(129, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(2)
    })

    it('zoom = 256 → LOD 2', () => {
      expect(selectLod(256, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(2)
    })

    it('zoom = 512 → LOD 3', () => {
      expect(selectLod(512, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(3)
    })

    it('zoom = 1024 → LOD 4', () => {
      expect(selectLod(1024, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(4)
    })
  })

  describe('never pixelated guarantee', () => {
    // At every zoom level up to the max LOD's capability, the selected LOD
    // should provide tile pixel density >= screen pixel density
    it('tile density >= screen density for zoom within max LOD range', () => {
      const maxDensity = getTilePixelDensity(MAX_LOD, TILE_SIZE, BASE_WORLD_SIZE) // 1024
      for (let zoom = 1; zoom <= maxDensity; zoom++) {
        const lod = selectLod(zoom, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)
        const tileDensity = getTilePixelDensity(lod, TILE_SIZE, BASE_WORLD_SIZE)
        expect(tileDensity).toBeGreaterThanOrEqual(zoom)
      }
    })

    it('beyond max LOD capability, LOD is capped (pixelation unavoidable)', () => {
      const maxDensity = getTilePixelDensity(MAX_LOD, TILE_SIZE, BASE_WORLD_SIZE)
      const lod = selectLod(maxDensity + 1, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)
      expect(lod).toBe(MAX_LOD)
    })
  })

  describe('no over-provisioning', () => {
    // The selected LOD should be the LOWEST that provides enough density.
    // If LOD n is selected, LOD n-1 must have been insufficient.
    it('LOD n-1 would be insufficient (under-provisioned)', () => {
      const maxDensity = getTilePixelDensity(MAX_LOD, TILE_SIZE, BASE_WORLD_SIZE)
      for (let zoom = 1; zoom <= maxDensity; zoom++) {
        const lod = selectLod(zoom, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)
        if (lod > 0) {
          const lowerDensity = getTilePixelDensity(lod - 1, TILE_SIZE, BASE_WORLD_SIZE)
          expect(lowerDensity).toBeLessThan(zoom)
        }
      }
    })
  })

  describe('devicePixelRatio awareness', () => {
    // The caller should pass camera.zoom * devicePixelRatio as screenPxPerUnit.
    // On a Retina/4K display (DPR=2), physical pixel density is 2× the CSS zoom.
    it('DPR=2: zoom=200 needs LOD 3 (not LOD 2)', () => {
      const cssZoom = 200
      const dpr = 2
      const physicalPxPerUnit = cssZoom * dpr // 400

      const lodWithoutDpr = selectLod(cssZoom, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)
      const lodWithDpr = selectLod(physicalPxPerUnit, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)

      expect(lodWithoutDpr).toBe(2) // tile density=256, under 400 → blurry
      expect(lodWithDpr).toBe(3)    // tile density=512, covers 400 → sharp
    })

    it('DPR=2: tile density at selected LOD covers physical pixels', () => {
      const dpr = 2
      const maxDensity = getTilePixelDensity(MAX_LOD, TILE_SIZE, BASE_WORLD_SIZE)
      // Test all CSS zoom levels where physical density is within max LOD range
      for (let cssZoom = 1; cssZoom <= maxDensity / dpr; cssZoom++) {
        const physicalPx = cssZoom * dpr
        const lod = selectLod(physicalPx, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)
        const tileDensity = getTilePixelDensity(lod, TILE_SIZE, BASE_WORLD_SIZE)
        expect(tileDensity).toBeGreaterThanOrEqual(physicalPx)
      }
    })
  })

  describe('edge cases', () => {
    it('zoom = 0 → LOD 0', () => {
      expect(selectLod(0, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(0)
    })

    it('negative zoom → LOD 0', () => {
      expect(selectLod(-5, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(0)
    })

    it('zoom beyond max LOD capability → capped at maxLod', () => {
      expect(selectLod(5000, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)).toBe(MAX_LOD)
    })

    it('maxLod = 0 always returns 0', () => {
      expect(selectLod(1000, TILE_SIZE, BASE_WORLD_SIZE, 0)).toBe(0)
    })
  })
})

describe('getMaxUsefulLod', () => {
  it('256px image → max LOD 0 (1 tile is enough)', () => {
    expect(getMaxUsefulLod(256, TILE_SIZE)).toBe(0)
  })

  it('512px image → max LOD 1', () => {
    expect(getMaxUsefulLod(512, TILE_SIZE)).toBe(1)
  })

  it('1024px image → max LOD 2', () => {
    expect(getMaxUsefulLod(1024, TILE_SIZE)).toBe(2)
  })

  it('2048px image → max LOD 3', () => {
    expect(getMaxUsefulLod(2048, TILE_SIZE)).toBe(3)
  })

  it('4096px image → max LOD 4', () => {
    expect(getMaxUsefulLod(4096, TILE_SIZE)).toBe(4)
  })

  it('non-power-of-two: 1500px → max LOD 2 (floor of log2(1500/256) = 2.55)', () => {
    expect(getMaxUsefulLod(1500, TILE_SIZE)).toBe(2)
  })

  it('tiny image (128px) → max LOD 0', () => {
    expect(getMaxUsefulLod(128, TILE_SIZE)).toBe(0)
  })

  it('exact match: at max useful LOD, source pixels = tile pixels (no upscale)', () => {
    // 1024px image, max LOD = 2
    // At LOD 2: tile covers baseWorldSize/4 = 1 unit, source has 1024/4 = 256 px/unit
    // tile is 256px, source crop is 256px → 1:1, valid
    expect(getMaxUsefulLod(1024, TILE_SIZE)).toBe(2)
  })

  it('one LOD above max useful would upscale', () => {
    // 1024px image, maxUseful = 2
    // At LOD 3: tile covers 0.5 units, source has 256 px/unit → 128 source px → upscaled to 256 tile px
    const maxLod = getMaxUsefulLod(1024, TILE_SIZE)
    // Source pixels per tile at maxLod+1: imageSize / 2^(maxLod+1)
    const sourcePxAtNext = 1024 / Math.pow(2, maxLod + 1)
    expect(sourcePxAtNext).toBeLessThan(TILE_SIZE)
  })
})

describe('selectImageLod', () => {
  describe('without native resolution cap', () => {
    it('behaves like selectLod for scale=1', () => {
      for (const zoom of [1, 64, 65, 128, 256, 512, 1024]) {
        expect(selectImageLod(zoom, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD))
          .toBe(selectLod(zoom, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD))
      }
    })
  })

  describe('with imageScale', () => {
    // A 10x scaled image's tiles cover 10x more world space, so tile density
    // is 10x lower. We need higher LOD to compensate: effective zoom = zoom * scale.
    it('scale=10 at zoom=6 → effective=60 < 64 → LOD 0', () => {
      expect(selectImageLod(6, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, undefined, 10)).toBe(0)
    })

    it('scale=10 at zoom=6.4 → effective=64 (exactly baseDensity) → LOD 0', () => {
      expect(selectImageLod(6.4, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, undefined, 10)).toBe(0)
    })

    it('scale=10 at zoom=7 → effective=70 > 64 → LOD 1', () => {
      expect(selectImageLod(7, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, undefined, 10)).toBe(1)
    })

    it('scale=10 at zoom=40 → effective=400 → LOD 3', () => {
      // effective=400, baseDensity=64, ratio=6.25, ceil(log2(6.25))=3
      expect(selectImageLod(40, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, undefined, 10)).toBe(3)
    })

    it('never pixelated: tile density >= screen density (accounting for scale)', () => {
      const scale = 10
      const maxEffective = getTilePixelDensity(MAX_LOD, TILE_SIZE, BASE_WORLD_SIZE)
      const maxZoom = maxEffective / scale // 1024/10 = 102.4
      for (let zoom = 1; zoom <= Math.floor(maxZoom); zoom++) {
        const lod = selectImageLod(zoom, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, undefined, scale)
        // Effective tile density in world coords = tileDensity / scale
        const tileDensity = getTilePixelDensity(lod, TILE_SIZE, BASE_WORLD_SIZE) / scale
        expect(tileDensity).toBeGreaterThanOrEqual(zoom)
      }
    })
  })

  describe('with native resolution cap', () => {
    it('1024px image: zoom demands LOD 4 but capped at LOD 2', () => {
      // zoom=1024 → selectLod would give LOD 4
      // but 1024px image max useful LOD is 2
      expect(selectImageLod(1024, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, 1024)).toBe(2)
    })

    it('4096px image: no cap, full LOD range available', () => {
      expect(selectImageLod(1024, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, 4096)).toBe(4)
    })

    it('512px image at high zoom: capped at LOD 1', () => {
      expect(selectImageLod(500, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, 512)).toBe(1)
    })

    it('when zoom demands LOD below the cap, cap has no effect', () => {
      // zoom=64 → LOD 0, cap doesn't matter
      expect(selectImageLod(64, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, 512)).toBe(0)
    })
  })

  describe('combined scale + native resolution cap', () => {
    it('scale=10, 1024px image, high zoom: capped by native resolution', () => {
      // zoom=40, scale=10 → effective=400 → selectLod gives LOD 3
      // but 1024px image caps at LOD 2
      expect(selectImageLod(40, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, 1024, 10)).toBe(2)
    })

    it('scale=10, 4096px image, moderate zoom: scale drives LOD up', () => {
      // zoom=7, scale=10 → effective=70 → LOD 1
      // 4096px image caps at LOD 4, no restriction
      expect(selectImageLod(7, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD, 4096, 10)).toBe(1)
    })
  })
})
