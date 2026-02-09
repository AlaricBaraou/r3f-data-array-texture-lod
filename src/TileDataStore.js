export class TileDataStore {
  constructor(maxLod = 4) {
    this.maxLod = maxLod
    this.data = new Map() // imageIndex -> Map(lodLevel -> instances)
    this.tileKeys = new Map() // imageIndex -> Map(lodLevel -> string[])
    this.loadingPromises = new Map() // "imageIndex_lodLevel" -> Promise
    this.requestedLod = new Map() // imageIndex -> current requested LOD
  }

  getKey(imageIndex, lodLevel) {
    return `${imageIndex}_${lodLevel}`
  }

  has(imageIndex, lodLevel) {
    return this.data.get(imageIndex)?.has(lodLevel) ?? false
  }

  get(imageIndex, lodLevel) {
    return this.data.get(imageIndex)?.get(lodLevel)
  }

  set(imageIndex, lodLevel, instances, tileKeyList) {
    if (!this.data.has(imageIndex)) {
      this.data.set(imageIndex, new Map())
    }
    this.data.get(imageIndex).set(lodLevel, instances)
    if (tileKeyList) {
      if (!this.tileKeys.has(imageIndex)) {
        this.tileKeys.set(imageIndex, new Map())
      }
      this.tileKeys.get(imageIndex).set(lodLevel, tileKeyList)
    }
  }

  isLoading(imageIndex, lodLevel) {
    return this.loadingPromises.has(this.getKey(imageIndex, lodLevel))
  }

  getLoadingPromise(imageIndex, lodLevel) {
    return this.loadingPromises.get(this.getKey(imageIndex, lodLevel))
  }

  setLoadingPromise(imageIndex, lodLevel, promise) {
    this.loadingPromises.set(this.getKey(imageIndex, lodLevel), promise)
  }

  clearLoadingPromise(imageIndex, lodLevel) {
    this.loadingPromises.delete(this.getKey(imageIndex, lodLevel))
  }

  setRequestedLod(imageIndex, lodLevel) {
    this.requestedLod.set(imageIndex, lodLevel)
  }

  getRequestedLod(imageIndex) {
    return this.requestedLod.get(imageIndex) ?? 0
  }

  shouldPrioritize(imageIndex, lodLevel) {
    return lodLevel >= this.getRequestedLod(imageIndex)
  }

  // Incrementally evict least-valuable entries to free atlas slots
  evictStale(renderedSet, tileManager, visibleImages, targetFreeSlots = 512) {
    const visibleSet = new Set(visibleImages)

    // Build eviction candidates with priority (lower = evict first)
    const candidates = []
    for (const [imageIndex, lodMap] of this.data) {
      for (const [lodLevel] of lodMap) {
        const key = this.getKey(imageIndex, lodLevel)
        if (renderedSet.has(key)) continue
        if (this.loadingPromises.has(key)) continue

        const isVisible = visibleSet.has(imageIndex)
        const isTargetLod = this.requestedLod.get(imageIndex) === lodLevel
        // 0 = off-screen stale LOD (evict first)
        // 1 = off-screen but target LOD (might pan back)
        // 2 = on-screen non-rendered fallback (least likely to evict)
        const priority = !isVisible ? (isTargetLod ? 1 : 0) : 2

        const keys = this.tileKeys.get(imageIndex)?.get(lodLevel)
        candidates.push({ imageIndex, lodLevel, priority, tileCount: keys ? keys.length : 0, keys })
      }
    }

    candidates.sort((a, b) => a.priority - b.priority)

    let currentFree = tileManager.getTotalSlots() - tileManager.getUsedSlotCount()

    for (const { imageIndex, lodLevel, keys, tileCount } of candidates) {
      if (currentFree >= targetFreeSlots) break

      if (keys) {
        for (const tileKey of keys) tileManager.freeTile(tileKey)
        this.tileKeys.get(imageIndex)?.delete(lodLevel)
      }
      this.data.get(imageIndex)?.delete(lodLevel)

      if (this.data.get(imageIndex)?.size === 0) {
        this.data.delete(imageIndex)
        this.tileKeys.delete(imageIndex)
      }

      currentFree += tileCount
    }
  }

  // Get best available LOD for an image (prefer target or lower, fall back to higher)
  getBestAvailableLod(imageIndex, targetLod) {
    for (let lod = targetLod; lod >= 0; lod--) {
      if (this.has(imageIndex, lod)) {
        return lod
      }
    }
    for (let lod = targetLod + 1; lod <= this.maxLod; lod++) {
      if (this.has(imageIndex, lod)) {
        return lod
      }
    }
    return -1
  }
}
