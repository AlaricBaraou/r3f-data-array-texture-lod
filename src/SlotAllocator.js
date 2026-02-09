const DEFAULT_TILES_PER_ROW = 16 // 4096 / 256
const DEFAULT_MAX_LAYERS = 16

export class SlotAllocator {
  constructor(maxLayers = DEFAULT_MAX_LAYERS, tilesPerRow = DEFAULT_TILES_PER_ROW) {
    this.maxLayers = maxLayers
    this.tilesPerRow = tilesPerRow
    this.tilesPerLayer = tilesPerRow * tilesPerRow

    this.layerSlots = Array.from({ length: maxLayers }, () => new Set())
    this.usedSlots = new Map() // tileKey -> { layer, slotX, slotY }
  }

  findFreeSlot() {
    for (let layer = 0; layer < this.maxLayers; layer++) {
      const used = this.layerSlots[layer]
      if (used.size < this.tilesPerLayer) {
        for (let i = 0; i < this.tilesPerLayer; i++) {
          if (!used.has(i)) {
            const slotX = i % this.tilesPerRow
            const slotY = Math.floor(i / this.tilesPerRow)
            return { layer, slotX, slotY, slotIndex: i }
          }
        }
      }
    }
    return null
  }

  allocate(tileKey) {
    if (this.usedSlots.has(tileKey)) {
      return this.usedSlots.get(tileKey)
    }
    const slot = this.findFreeSlot()
    if (!slot) return null
    const { layer, slotX, slotY, slotIndex } = slot
    this.layerSlots[layer].add(slotIndex)
    this.usedSlots.set(tileKey, { layer, slotX, slotY })
    return { layer, slotX, slotY }
  }

  free(tileKey) {
    const slot = this.usedSlots.get(tileKey)
    if (!slot) return
    const slotIndex = slot.slotY * this.tilesPerRow + slot.slotX
    this.layerSlots[slot.layer].delete(slotIndex)
    this.usedSlots.delete(tileKey)
  }

  has(tileKey) {
    return this.usedSlots.has(tileKey)
  }

  get(tileKey) {
    return this.usedSlots.get(tileKey)
  }

  getUsedCount() {
    let count = 0
    for (const set of this.layerSlots) count += set.size
    return count
  }

  getTotalSlots() {
    return this.maxLayers * this.tilesPerLayer
  }
}
