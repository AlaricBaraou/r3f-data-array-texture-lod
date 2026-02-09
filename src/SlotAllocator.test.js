import { describe, it, expect } from 'vitest'
import { SlotAllocator } from './SlotAllocator'

describe('SlotAllocator', () => {
  describe('basics', () => {
    it('reports correct total slots', () => {
      const a = new SlotAllocator(2, 4) // 2 layers × 16 slots = 32
      expect(a.getTotalSlots()).toBe(32)
    })

    it('starts with 0 used slots', () => {
      const a = new SlotAllocator(2, 4)
      expect(a.getUsedCount()).toBe(0)
    })

    it('allocate returns a valid slot', () => {
      const a = new SlotAllocator(2, 4)
      const slot = a.allocate('tile_0')
      expect(slot).not.toBeNull()
      expect(slot).toHaveProperty('layer')
      expect(slot).toHaveProperty('slotX')
      expect(slot).toHaveProperty('slotY')
    })

    it('allocate increments used count', () => {
      const a = new SlotAllocator(2, 4)
      a.allocate('tile_0')
      a.allocate('tile_1')
      a.allocate('tile_2')
      expect(a.getUsedCount()).toBe(3)
    })
  })

  describe('deduplication', () => {
    it('allocating the same key twice returns the same slot', () => {
      const a = new SlotAllocator(2, 4)
      const s1 = a.allocate('tile_0')
      const s2 = a.allocate('tile_0')
      expect(s1).toEqual(s2)
      expect(a.getUsedCount()).toBe(1)
    })

    it('has() returns true for allocated keys', () => {
      const a = new SlotAllocator(2, 4)
      a.allocate('tile_0')
      expect(a.has('tile_0')).toBe(true)
      expect(a.has('tile_1')).toBe(false)
    })

    it('get() returns the slot for allocated keys', () => {
      const a = new SlotAllocator(2, 4)
      const slot = a.allocate('tile_0')
      expect(a.get('tile_0')).toEqual(slot)
      expect(a.get('tile_1')).toBeUndefined()
    })
  })

  describe('capacity', () => {
    it('fills all slots across layers', () => {
      const a = new SlotAllocator(2, 2) // 2 layers × 4 slots = 8 total
      for (let i = 0; i < 8; i++) {
        expect(a.allocate(`tile_${i}`)).not.toBeNull()
      }
      expect(a.getUsedCount()).toBe(8)
    })

    it('returns null when full', () => {
      const a = new SlotAllocator(1, 2) // 1 layer × 4 slots = 4 total
      for (let i = 0; i < 4; i++) {
        a.allocate(`tile_${i}`)
      }
      expect(a.allocate('tile_overflow')).toBeNull()
      expect(a.getUsedCount()).toBe(4)
    })

    it('uses second layer when first is full', () => {
      const a = new SlotAllocator(2, 2) // 2 layers × 4 slots
      // Fill layer 0
      for (let i = 0; i < 4; i++) {
        const slot = a.allocate(`tile_${i}`)
        expect(slot.layer).toBe(0)
      }
      // Next allocation should go to layer 1
      const slot = a.allocate('tile_4')
      expect(slot.layer).toBe(1)
    })
  })

  describe('free', () => {
    it('free decrements used count', () => {
      const a = new SlotAllocator(2, 4)
      a.allocate('tile_0')
      a.allocate('tile_1')
      a.free('tile_0')
      expect(a.getUsedCount()).toBe(1)
    })

    it('free makes has() return false', () => {
      const a = new SlotAllocator(2, 4)
      a.allocate('tile_0')
      a.free('tile_0')
      expect(a.has('tile_0')).toBe(false)
    })

    it('freeing a non-existent key is a no-op', () => {
      const a = new SlotAllocator(2, 4)
      a.free('nonexistent')
      expect(a.getUsedCount()).toBe(0)
    })

    it('freed slot can be reallocated', () => {
      const a = new SlotAllocator(1, 2) // 4 total
      const slots = []
      for (let i = 0; i < 4; i++) {
        slots.push(a.allocate(`tile_${i}`))
      }
      // Full
      expect(a.allocate('tile_new')).toBeNull()

      // Free one
      a.free('tile_1')
      expect(a.getUsedCount()).toBe(3)

      // Now can allocate again
      const newSlot = a.allocate('tile_new')
      expect(newSlot).not.toBeNull()
      expect(a.getUsedCount()).toBe(4)
    })

    it('freed slot reuses the same position', () => {
      const a = new SlotAllocator(1, 2) // 4 total
      const original = a.allocate('tile_0')
      a.free('tile_0')
      const reused = a.allocate('tile_replacement')
      expect(reused).toEqual(original) // same layer/slotX/slotY
    })
  })

  describe('fill and drain cycle', () => {
    it('can be completely filled, drained, and refilled', () => {
      const a = new SlotAllocator(1, 3) // 9 total
      // Fill
      for (let i = 0; i < 9; i++) {
        expect(a.allocate(`a_${i}`)).not.toBeNull()
      }
      expect(a.getUsedCount()).toBe(9)
      expect(a.allocate('overflow')).toBeNull()

      // Drain
      for (let i = 0; i < 9; i++) {
        a.free(`a_${i}`)
      }
      expect(a.getUsedCount()).toBe(0)

      // Refill with different keys
      for (let i = 0; i < 9; i++) {
        expect(a.allocate(`b_${i}`)).not.toBeNull()
      }
      expect(a.getUsedCount()).toBe(9)
    })
  })

  describe('slot coordinate correctness', () => {
    it('slots have correct coordinates within a layer', () => {
      const a = new SlotAllocator(1, 3) // 3×3 = 9 slots in one layer
      const coords = []
      for (let i = 0; i < 9; i++) {
        coords.push(a.allocate(`tile_${i}`))
      }
      // Should fill (0,0), (1,0), (2,0), (0,1), (1,1), (2,1), (0,2), (1,2), (2,2)
      expect(coords[0]).toEqual({ layer: 0, slotX: 0, slotY: 0 })
      expect(coords[1]).toEqual({ layer: 0, slotX: 1, slotY: 0 })
      expect(coords[2]).toEqual({ layer: 0, slotX: 2, slotY: 0 })
      expect(coords[3]).toEqual({ layer: 0, slotX: 0, slotY: 1 })
      expect(coords[8]).toEqual({ layer: 0, slotX: 2, slotY: 2 })
    })

    it('freeing middle slot and reallocating reuses its position', () => {
      const a = new SlotAllocator(1, 3)
      for (let i = 0; i < 5; i++) a.allocate(`tile_${i}`)
      // tile_2 is at (2, 0)
      const original = a.get('tile_2')
      a.free('tile_2')
      const reused = a.allocate('tile_new')
      expect(reused).toEqual(original)
    })
  })

  describe('production-scale scenario', () => {
    it('handles 1015 allocations with 16 layers × 16×16 tiles', () => {
      const a = new SlotAllocator(16, 16) // 4096 total — matches production
      for (let i = 0; i < 1015; i++) {
        expect(a.allocate(`img${i}_lod0_0_0`)).not.toBeNull()
      }
      expect(a.getUsedCount()).toBe(1015)
      expect(a.getTotalSlots() - a.getUsedCount()).toBe(3081)
    })
  })
})
