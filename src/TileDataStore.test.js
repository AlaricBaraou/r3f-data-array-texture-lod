import { describe, it, expect } from 'vitest'
import { TileDataStore } from './TileDataStore'
import { SlotAllocator } from './SlotAllocator'

/**
 * Mock TileManager backed by a real SlotAllocator so slot counts are accurate.
 */
function makeMockTileManager(maxLayers = 2, tilesPerRow = 4) {
  const slots = new SlotAllocator(maxLayers, tilesPerRow)
  return {
    slots,
    freeTile(key) { slots.free(key) },
    getUsedSlotCount() { return slots.getUsedCount() },
    getTotalSlots() { return slots.getTotalSlots() },
    // Helper: allocate a key (simulates uploadTile without WebGL)
    uploadTile(key) { return slots.allocate(key) },
  }
}

describe('TileDataStore', () => {
  describe('has / get / set', () => {
    it('has returns false for empty store', () => {
      const store = new TileDataStore()
      expect(store.has(0, 0)).toBe(false)
    })

    it('set then has returns true', () => {
      const store = new TileDataStore()
      store.set(0, 0, [{ fake: true }], ['key_0_0'])
      expect(store.has(0, 0)).toBe(true)
    })

    it('get returns stored instances', () => {
      const store = new TileDataStore()
      const instances = [{ slot: {}, worldX: 0, worldY: 0 }]
      store.set(5, 2, instances, ['k'])
      expect(store.get(5, 2)).toBe(instances)
    })

    it('different LODs for same image are independent', () => {
      const store = new TileDataStore()
      store.set(0, 0, ['lod0'], ['k0'])
      store.set(0, 1, ['lod1'], ['k1'])
      expect(store.has(0, 0)).toBe(true)
      expect(store.has(0, 1)).toBe(true)
      expect(store.get(0, 0)).toEqual(['lod0'])
      expect(store.get(0, 1)).toEqual(['lod1'])
    })
  })

  describe('getBestAvailableLod', () => {
    it('returns exact match', () => {
      const store = new TileDataStore()
      store.set(0, 2, ['inst'])
      expect(store.getBestAvailableLod(0, 2)).toBe(2)
    })

    it('falls back to lower LOD', () => {
      const store = new TileDataStore()
      store.set(0, 0, ['inst'])
      expect(store.getBestAvailableLod(0, 2)).toBe(0)
    })

    it('falls back to higher LOD when no lower exists', () => {
      const store = new TileDataStore()
      store.set(0, 3, ['inst'])
      expect(store.getBestAvailableLod(0, 1)).toBe(3)
    })

    it('prefers lower LOD over higher LOD', () => {
      const store = new TileDataStore()
      store.set(0, 0, ['low'])
      store.set(0, 4, ['high'])
      // Target LOD 2: should pick LOD 0 (lower) not LOD 4 (higher)
      expect(store.getBestAvailableLod(0, 2)).toBe(0)
    })

    it('returns -1 when nothing available', () => {
      const store = new TileDataStore()
      expect(store.getBestAvailableLod(0, 2)).toBe(-1)
    })

    it('respects maxLod boundary', () => {
      const store = new TileDataStore(3) // maxLod = 3
      store.set(0, 4, ['inst']) // LOD 4 is above maxLod
      // Won't find LOD 4 because loop stops at maxLod
      expect(store.getBestAvailableLod(0, 2)).toBe(-1)
    })
  })

  describe('loading state', () => {
    it('tracks loading promises', () => {
      const store = new TileDataStore()
      expect(store.isLoading(0, 1)).toBe(false)
      const p = Promise.resolve()
      store.setLoadingPromise(0, 1, p)
      expect(store.isLoading(0, 1)).toBe(true)
      expect(store.getLoadingPromise(0, 1)).toBe(p)
      store.clearLoadingPromise(0, 1)
      expect(store.isLoading(0, 1)).toBe(false)
    })
  })

  describe('requestedLod / shouldPrioritize', () => {
    it('getRequestedLod defaults to 0', () => {
      const store = new TileDataStore()
      expect(store.getRequestedLod(5)).toBe(0)
    })

    it('setRequestedLod updates the value', () => {
      const store = new TileDataStore()
      store.setRequestedLod(5, 3)
      expect(store.getRequestedLod(5)).toBe(3)
    })

    it('shouldPrioritize returns true for equal or higher LOD', () => {
      const store = new TileDataStore()
      store.setRequestedLod(0, 2)
      expect(store.shouldPrioritize(0, 2)).toBe(true)
      expect(store.shouldPrioritize(0, 3)).toBe(true)
      expect(store.shouldPrioritize(0, 1)).toBe(false)
    })
  })

  describe('evictStale', () => {
    function setupScenario() {
      // 2 layers × 4×4 = 32 total slots
      const tm = makeMockTileManager(2, 4)
      const store = new TileDataStore()

      // Load 5 images at LOD 0 (1 tile each) — images 0-4
      for (let i = 0; i < 5; i++) {
        const key = `img${i}_lod0_0_0`
        tm.uploadTile(key)
        store.set(i, 0, [{ fake: true }], [key])
        store.setRequestedLod(i, 0)
      }

      // Load 3 images at LOD 2 (4 tiles each) — images 10-12
      for (let i = 10; i < 13; i++) {
        const keys = []
        for (let t = 0; t < 4; t++) {
          const key = `img${i}_lod2_${t}_0`
          tm.uploadTile(key)
          keys.push(key)
        }
        store.set(i, 2, [{ fake: true }], keys)
        store.setRequestedLod(i, 2)
      }

      // Total used: 5 + 12 = 17 slots
      expect(tm.getUsedSlotCount()).toBe(17)
      return { tm, store }
    }

    it('does not evict rendered entries', () => {
      const { tm, store } = setupScenario()
      // Render images 0-4 at LOD 0
      const rendered = new Set(['0_0', '1_0', '2_0', '3_0', '4_0'])
      // All visible, target = 32 (evict everything possible)
      store.evictStale(rendered, tm, [0, 1, 2, 3, 4], 32)
      // Images 0-4 should NOT be evicted
      for (let i = 0; i < 5; i++) {
        expect(store.has(i, 0)).toBe(true)
      }
      // Images 10-12 should be evicted (not rendered)
      for (let i = 10; i < 13; i++) {
        expect(store.has(i, 2)).toBe(false)
      }
      expect(tm.getUsedSlotCount()).toBe(5)
    })

    it('does not evict entries currently loading', () => {
      const { tm, store } = setupScenario()
      // Mark image 10 LOD 2 as loading
      store.setLoadingPromise(10, 2, Promise.resolve())
      const rendered = new Set()
      store.evictStale(rendered, tm, [], 32)
      // Image 10 LOD 2 should survive (loading)
      expect(store.has(10, 2)).toBe(true)
      // Image 11, 12 should be evicted
      expect(store.has(11, 2)).toBe(false)
      expect(store.has(12, 2)).toBe(false)
    })

    it('stops evicting once targetFreeSlots is reached', () => {
      const { tm, store } = setupScenario()
      // 17 used, 32 total → 15 free
      // Target: 20 free → need to evict 5 slots
      const rendered = new Set()
      store.evictStale(rendered, tm, [], 20)
      // Should have evicted just enough (5 slots = at least 2 entries)
      // Priority 0 (off-screen stale LOD) gets evicted first
      // All entries are off-screen. LOD 0 images have requestedLod=0, so they're "target LOD" → priority 1
      // LOD 2 images have requestedLod=2, so they're "target LOD" → priority 1
      // All are priority 1 (off-screen target LOD), so eviction order depends on iteration order
      // With 15 free and target 20, we need 5 more → evicting one LOD-0 image (1 tile) then
      // still need 4 more → evict another (now at 17) → still need 3 → evict one 4-tile image → at 21 ≥ 20, stop
      const remaining = tm.getUsedSlotCount()
      expect(32 - remaining).toBeGreaterThanOrEqual(20)
    })

    it('evicts off-screen stale LODs before off-screen target LODs', () => {
      const tm = makeMockTileManager(2, 4)
      const store = new TileDataStore()

      // Image 0: LOD 0 (target LOD = 2, so LOD 0 is stale) — priority 0
      const k0 = 'img0_lod0_0_0'
      tm.uploadTile(k0)
      store.set(0, 0, [{ fake: true }], [k0])
      store.setRequestedLod(0, 2)

      // Image 1: LOD 2 (target LOD = 2, matches) — priority 1
      const keys1 = []
      for (let t = 0; t < 4; t++) {
        const k = `img1_lod2_${t}_0`
        tm.uploadTile(k)
        keys1.push(k)
      }
      store.set(1, 2, [{ fake: true }], keys1)
      store.setRequestedLod(1, 2)

      // 5 used, 32 total → 27 free
      expect(tm.getUsedSlotCount()).toBe(5)

      // Evict with target 28 → need 1 more slot
      const rendered = new Set()
      store.evictStale(rendered, tm, [], 28)

      // Image 0 LOD 0 (priority 0) should be evicted first
      expect(store.has(0, 0)).toBe(false)
      // Image 1 LOD 2 (priority 1) should survive — 1 slot freed is enough
      expect(store.has(1, 2)).toBe(true)
    })

    it('evicts on-screen non-rendered fallbacks last (priority 2)', () => {
      const tm = makeMockTileManager(2, 4)
      const store = new TileDataStore()

      // Image 0: LOD 0 visible, rendered at LOD 2 (so LOD 0 is on-screen non-rendered → priority 2)
      const k0 = 'img0_lod0_0_0'
      tm.uploadTile(k0)
      store.set(0, 0, [{ fake: true }], [k0])
      store.setRequestedLod(0, 2)

      // Image 5: LOD 1 off-screen, target LOD = 1 → priority 1
      const k5 = 'img5_lod1_0_0'
      tm.uploadTile(k5)
      store.set(5, 1, [{ fake: true }], [k5])
      store.setRequestedLod(5, 1)

      // 2 used, 32 total → 30 free. Need target 31 → evict 1 slot
      const rendered = new Set(['0_2']) // Image 0 rendered at LOD 2
      const visibleImages = [0] // Image 0 is visible
      store.evictStale(rendered, tm, visibleImages, 31)

      // Image 5 (priority 1, off-screen) evicted first
      expect(store.has(5, 1)).toBe(false)
      // Image 0 LOD 0 (priority 2, on-screen fallback) survives
      expect(store.has(0, 0)).toBe(true)
    })

    it('frees atlas slots via tileManager', () => {
      const tm = makeMockTileManager(2, 4)
      const store = new TileDataStore()

      for (let i = 0; i < 10; i++) {
        const key = `tile_${i}`
        tm.uploadTile(key)
        store.set(i, 0, [{ fake: true }], [key])
      }
      expect(tm.getUsedSlotCount()).toBe(10)

      store.evictStale(new Set(), tm, [], 32)
      expect(tm.getUsedSlotCount()).toBe(0)
    })

    it('cleans up empty data maps after eviction', () => {
      const tm = makeMockTileManager(2, 4)
      const store = new TileDataStore()

      const k = 'tile_0'
      tm.uploadTile(k)
      store.set(0, 0, [{ fake: true }], [k])

      store.evictStale(new Set(), tm, [], 32)
      expect(store.has(0, 0)).toBe(false)
      // Internal data map for image 0 should be cleaned up
      expect(store.data.has(0)).toBe(false)
      expect(store.tileKeys.has(0)).toBe(false)
    })
  })

  describe('zoom in/out scenario', () => {
    it('zoom out then zoom in: eviction frees enough for new tiles', () => {
      // Simulates: zoomed in on 5 images at LOD 3 (16 tiles each = 80 slots),
      // then zoom out to see 20 images at LOD 0 (1 tile each = 20 slots),
      // then zoom back in on different 5 images at LOD 3
      const tm = makeMockTileManager(4, 4) // 4 layers × 16 = 64 total
      const store = new TileDataStore()

      // Step 1: Zoom in — load 5 images at LOD 3, 10 tiles each
      for (let i = 0; i < 5; i++) {
        const keys = []
        for (let t = 0; t < 10; t++) {
          const k = `img${i}_lod3_${t % 4}_${Math.floor(t / 4)}`
          tm.uploadTile(k)
          keys.push(k)
        }
        store.set(i, 3, [{ fake: true }], keys)
        store.setRequestedLod(i, 3)
      }
      expect(tm.getUsedSlotCount()).toBe(50)

      // Step 2: Zoom out — need 20 images at LOD 0
      // Update requested LODs
      for (let i = 0; i < 20; i++) {
        store.setRequestedLod(i, 0)
      }

      // Rendered set: nothing yet (all need loading)
      // Visible: images 0-19
      const visibleImages = Array.from({ length: 20 }, (_, i) => i)
      // Need 20 free slots. Currently 14 free. Need to evict.
      store.evictStale(new Set(), tm, visibleImages, 20)

      // Should have freed enough
      const freeAfterEvict = tm.getTotalSlots() - tm.getUsedSlotCount()
      expect(freeAfterEvict).toBeGreaterThanOrEqual(20)

      // Allocate the 20 LOD 0 tiles
      for (let i = 0; i < 20; i++) {
        const k = `img${i}_lod0_0_0`
        const slot = tm.uploadTile(k)
        expect(slot).not.toBeNull()
        store.set(i, 0, [{ fake: true }], [k])
      }

      // Step 3: Zoom back in on images 15-19 at LOD 3
      for (let i = 15; i < 20; i++) {
        store.setRequestedLod(i, 3)
      }

      // Rendered: images 15-19 at LOD 0 (fallback until LOD 3 loads)
      const rendered = new Set(['15_0', '16_0', '17_0', '18_0', '19_0'])
      const zoomedVisibleImages = [15, 16, 17, 18, 19]

      // Need 50 slots for LOD 3 (5 images × 10 tiles)
      store.evictStale(rendered, tm, zoomedVisibleImages, 50)

      const freeForZoomIn = tm.getTotalSlots() - tm.getUsedSlotCount()
      expect(freeForZoomIn).toBeGreaterThanOrEqual(50)
    })

    it('repeated zoom cycles do not leak slots', () => {
      const tm = makeMockTileManager(2, 4) // 32 total
      const store = new TileDataStore()

      for (let cycle = 0; cycle < 5; cycle++) {
        // Zoom in: 3 images × 8 tiles = 24 slots
        for (let i = 0; i < 3; i++) {
          const keys = []
          for (let t = 0; t < 8; t++) {
            const k = `c${cycle}_img${i}_lod2_${t}_0`
            const slot = tm.uploadTile(k)
            expect(slot).not.toBeNull()
            keys.push(k)
          }
          store.set(i, 2, [{ fake: true }], keys)
          store.setRequestedLod(i, 2)
        }

        // Zoom out: evict all, load 10 images × 1 tile = 10
        for (let i = 0; i < 10; i++) store.setRequestedLod(i, 0)
        const rendered = new Set()
        store.evictStale(rendered, tm, Array.from({ length: 10 }, (_, i) => i), 10)

        for (let i = 0; i < 10; i++) {
          const k = `c${cycle}_img${i}_lod0_0_0`
          const slot = tm.uploadTile(k)
          expect(slot).not.toBeNull()
          store.set(i, 0, [{ fake: true }], [k])
        }

        // Clean up for next cycle
        store.evictStale(new Set(), tm, [], 32)
      }

      expect(tm.getUsedSlotCount()).toBe(0)
    })
  })
})
