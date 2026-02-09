import { useEffect, useRef, useState } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { FigmaControlsComponent } from './FigmaControlsComponent'
import { TileManager } from './TileManager'
import { TileDataStore } from './TileDataStore'
import { VisibilityChecker } from './VisibilityChecker'
import TileWorker from './tileWorker.js?worker'
import './App.css'

// Load all images from public folder
const imageFiles = import.meta.glob('/public/*.jpg', { eager: true, query: '?url', import: 'default' })
const images = Object.keys(imageFiles).map(path => imageFiles[path])
const IMAGE_COUNT = images.length

// Grid layout
const GRID_COLS = Math.ceil(Math.sqrt(IMAGE_COUNT))
const BASE_WORLD_SIZE = 4
const GAP = 0.5

// Random rotation for each image (some at 0, some at 45 degrees, etc.)
const imageRotations = images.map((_, i) => {
  // Every 10th image rotated by 45 degrees for testing
  return (i % 10 === 0) ? Math.PI / 4 : 0
})

// Per-image scale (some images are larger)
const imageScales = images.map((_, i) => {
  // Every 40th image scaled 10x for testing
  return (i % 40 === 0) ? 10 : 1
})

// LOD levels
const MAX_LOD = 4
const LOD_ZOOM_THRESHOLDS = [0, 80, 160, 320, 640]

function getLodLevel(zoom) {
  for (let i = MAX_LOD; i >= 0; i--) {
    if (zoom >= LOD_ZOOM_THRESHOLDS[i]) {
      return i
    }
  }
  return 0
}

function getImageLodLevel(zoom, imageIndex) {
  const effectiveZoom = zoom * (imageScales[imageIndex] || 1)
  return getLodLevel(effectiveZoom)
}

// Worker pool — pull-based priority queue (highest LOD dispatched first)
class TileLoaderPool {
  constructor(poolSize = 4) {
    this.workers = Array.from({ length: poolSize }, () => new TileWorker())
    this.idleWorkers = [...Array(poolSize).keys()]
    this.queue = [] // kept sorted: highest LOD first
    this.active = new Map() // id -> { resolve, reject, workerIdx }
    this.idCounter = 0

    this.workers.forEach((worker, idx) => {
      worker.onmessage = (e) => {
        const { id, status } = e.data
        if (status !== 'done' && status !== 'error') return // ignore intermediate messages
        const entry = this.active.get(id)
        if (entry) {
          if (status === 'done') entry.resolve(e.data)
          else entry.reject(new Error(e.data.error))
          this.active.delete(id)
          this.idleWorkers.push(idx)
          this._dispatch()
        }
      }
    })
  }

  _dispatch() {
    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const task = this.queue.shift()
      const workerIdx = this.idleWorkers.pop()
      this.active.set(task.id, { resolve: task.resolve, reject: task.reject, workerIdx })
      this.workers[workerIdx].postMessage({
        url: task.url, imageIndex: task.imageIndex, lodLevel: task.lodLevel, id: task.id
      })
    }
  }

  loadImageTiles(url, imageIndex, lodLevel, priority = lodLevel) {
    return new Promise((resolve, reject) => {
      const id = this.idCounter++
      // Insert in priority order (highest first)
      let i = 0
      while (i < this.queue.length && this.queue[i].priority >= priority) i++
      this.queue.splice(i, 0, { id, url, imageIndex, lodLevel, priority, resolve, reject })
      this._dispatch()
    })
  }

  // Cancel queued (not yet dispatched to worker) tasks for an image below a given LOD
  cancelPending(imageIndex, belowLod) {
    const kept = []
    for (const task of this.queue) {
      if (task.imageIndex === imageIndex && task.lodLevel < belowLod) {
        task.reject(new Error('cancelled'))
      } else {
        kept.push(task)
      }
    }
    this.queue = kept
  }

  dispose() {
    for (const task of this.queue) task.reject(new Error('disposed'))
    this.queue = []
    this.workers.forEach(w => w.terminate())
  }
}

let loaderPool = null
function getLoaderPool() {
  if (!loaderPool) {
    loaderPool = new TileLoaderPool(4)
  }
  return loaderPool
}

function getImagePosition(imageIndex) {
  const col = imageIndex % GRID_COLS
  const row = Math.floor(imageIndex / GRID_COLS)
  const x = col * (BASE_WORLD_SIZE + GAP)
  const y = -row * (BASE_WORLD_SIZE + GAP)
  return { x, y }
}

function processTiles(data, tileManager) {
  const { imageIndex, lodLevel, tileWorldSize, tiles, bitmaps } = data

  const { x: imageX, y: imageY } = getImagePosition(imageIndex)
  const rotation = imageRotations[imageIndex] || 0
  const scale = imageScales[imageIndex] || 1
  const instances = []
  const tileKeyList = []

  // For rotated images, tiles are positioned relative to image center, then rotated
  // First, calculate image center offset
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)

  const scaledTileWorldSize = tileWorldSize * scale

  let complete = true

  for (let i = 0; i < tiles.length; i++) {
    const { tx, ty, tileWorldW, tileWorldH } = tiles[i]
    const bitmap = bitmaps[i]

    const tileKey = `${imageIndex}_lod${lodLevel}_${tx}_${ty}`
    const slot = tileManager.uploadTile(tileKey, bitmap)

    if (slot) {
      tileKeyList.push(tileKey)
      const scaledW = tileWorldW * scale
      const scaledH = tileWorldH * scale

      // Local position relative to image origin (top-left)
      const localX = tx * scaledTileWorldSize + scaledW / 2
      const localY = -(ty * scaledTileWorldSize + scaledH / 2)

      // Apply rotation around image origin
      const rotatedX = localX * cos - localY * sin
      const rotatedY = localX * sin + localY * cos

      // Final world position
      const worldX = imageX + rotatedX
      const worldY = imageY + rotatedY

      instances.push({
        slot,
        worldX,
        worldY,
        tileWorldW: scaledW,
        tileWorldH: scaledH,
        rotation
      })
    } else {
      complete = false
    }

    bitmap.close()
  }

  return { instances, tileKeyList, complete }
}

function TileSystem({ onTileCountChange, onVisibleImagesChange, onStatsChange }) {
  const { gl, scene, camera } = useThree()
  const tileManagerRef = useRef(null)
  const visibilityCheckerRef = useRef(null)
  const tileDataStoreRef = useRef(null)
  const imageLodCacheRef = useRef(new Map())
  const visibleImagesRef = useRef([])
  const needsRebuildRef = useRef(false)
  const renderedSetRef = useRef(new Set())
  const initRef = useRef(false)

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    const tileManager = new TileManager(gl)
    tileManagerRef.current = tileManager
    scene.add(tileManager.getMesh())

    const visibilityChecker = new VisibilityChecker(
      IMAGE_COUNT,
      GRID_COLS,
      BASE_WORLD_SIZE,
      GAP,
      imageRotations,
      imageScales
    )
    visibilityCheckerRef.current = visibilityChecker

    const tileDataStore = new TileDataStore()
    tileDataStoreRef.current = tileDataStore

    // Don't preload all images - let visibility system handle it
    // Initial visible images will be loaded in useFrame

    return () => {
      scene.remove(tileManager.getMesh())
      tileManager.dispose()
      visibilityChecker.dispose()
    }
  }, [gl, scene])

  useFrame(() => {
    const tileManager = tileManagerRef.current
    const visibilityChecker = visibilityCheckerRef.current
    const tileDataStore = tileDataStoreRef.current
    if (!tileManager || !visibilityChecker || !tileDataStore) return

    // Check visibility
    const visibleImages = visibilityChecker.getVisibleImages(camera)
    const prevVisible = visibleImagesRef.current

    const visibilityChanged =
      visibleImages.length !== prevVisible.length ||
      visibleImages.some((v, i) => v !== prevVisible[i])

    if (visibilityChanged) {
      visibleImagesRef.current = visibleImages
      onVisibleImagesChange?.(visibleImages)
    }

    // Compute per-image LOD based on effective zoom (camera zoom * image scale)
    const zoom = camera.zoom
    const imageLodCache = imageLodCacheRef.current
    let anyLodChanged = false

    const perImageLod = new Map()
    const pool = getLoaderPool()
    for (const idx of visibleImages) {
      const targetLod = getImageLodLevel(zoom, idx)
      perImageLod.set(idx, targetLod)

      const prevLod = imageLodCache.get(idx)
      if (prevLod !== targetLod) {
        anyLodChanged = true
        imageLodCache.set(idx, targetLod)
        // Zooming in: cancel queued lower-LOD work for this image
        if (targetLod > (prevLod ?? -1)) {
          pool.cancelPending(idx, targetLod)
        }
      }
    }

    // Clean stale entries for images no longer visible
    if (visibilityChanged) {
      const visibleSet = new Set(visibleImages)
      for (const idx of imageLodCache.keys()) {
        if (!visibleSet.has(idx)) {
          imageLodCache.delete(idx)
        }
      }
    }

    // Group images that need loading by their target LOD
    const loadByLod = new Map()
    for (const idx of visibleImages) {
      const targetLod = perImageLod.get(idx)
      if (!tileDataStore.has(idx, targetLod) && !tileDataStore.isLoading(idx, targetLod)) {
        if (!loadByLod.has(targetLod)) {
          loadByLod.set(targetLod, [])
        }
        loadByLod.get(targetLod).push(idx)
      }
    }

    // Evict stale tiles only when we need room for new ones
    if (loadByLod.size > 0) {
      // Estimate how many slots the pending loads will need
      let estimatedNeeded = 0
      for (const [lodLevel, indices] of loadByLod) {
        // Conservative: 4^lodLevel tiles per image (1 at LOD0, 4 at LOD1, 16 at LOD2...)
        const tilesPerImage = Math.min(Math.pow(4, lodLevel), 64)
        estimatedNeeded += indices.length * tilesPerImage
      }
      const freeSlots = tileManager.getTotalSlots() - tileManager.getUsedSlotCount()
      if (freeSlots < estimatedNeeded) {
        tileDataStore.evictStale(renderedSetRef.current, tileManager, visibleImages, estimatedNeeded)
      }
    }

    const camX = camera.position.x
    const camY = camera.position.y
    for (const [lodLevel, imageIndices] of loadByLod) {
      loadImagesAtLod(imageIndices, lodLevel, tileManager, tileDataStore, camX, camY, () => {
        needsRebuildRef.current = true
      })
    }

    if (visibilityChanged || anyLodChanged) {
      needsRebuildRef.current = true
    }

    // Rebuild instances if needed
    if (needsRebuildRef.current) {
      needsRebuildRef.current = false
      rebuildInstances(visibleImages, perImageLod, tileManager, tileDataStore, renderedSetRef)
      onTileCountChange?.(tileManager.getTileCount())

      const lodValues = [...perImageLod.values()]
      const minLod = lodValues.length > 0 ? Math.min(...lodValues) : 0
      const maxLod = lodValues.length > 0 ? Math.max(...lodValues) : 0
      const usedSlots = tileManager.getUsedSlotCount()
      const totalSlots = tileManager.getTotalSlots()
      const stats = {
        visibleImages: visibleImages.length,
        currentLod: minLod === maxLod ? minLod : `${minLod}-${maxLod}`,
        tilesRendered: tileManager.getTileCount(),
        slotsUsed: usedSlots,
        slotsTotal: totalSlots
      }
      onStatsChange?.(stats)
    }
  })

  return null
}

async function loadImagesAtLod(imageIndices, lodLevel, tileManager, tileDataStore, cameraX, cameraY, onProgress = null) {
  const pool = getLoaderPool()

  // Update requested LOD for all images (for prioritization)
  imageIndices.forEach(idx => tileDataStore.setRequestedLod(idx, lodLevel))

  const promises = imageIndices.map(async (imageIndex) => {
    // Skip if already loaded
    if (tileDataStore.has(imageIndex, lodLevel)) return

    // Skip if already loading this exact LOD
    if (tileDataStore.isLoading(imageIndex, lodLevel)) {
      return tileDataStore.getLoadingPromise(imageIndex, lodLevel)
    }

    // Skip if a higher LOD was requested (prioritize higher)
    if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
      return
    }

    // Priority: LOD as primary, distance-from-center as secondary (0-1 fractional)
    const { x, y } = getImagePosition(imageIndex)
    const dx = x - cameraX
    const dy = y - cameraY
    const dist = Math.sqrt(dx * dx + dy * dy)
    const priority = lodLevel + 1 / (1 + dist)

    const promise = (async () => {
      try {
        // Double-check priority before actually loading
        if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
          return
        }

        const data = await pool.loadImageTiles(images[imageIndex], imageIndex, lodLevel, priority)

        // Check again after async load - maybe a higher LOD was requested
        if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
          // Still save the data but don't trigger rebuild
          const { instances, tileKeyList, complete } = processTiles(data, tileManager)
          if (complete) {
            tileDataStore.set(imageIndex, lodLevel, instances, tileKeyList)
          } else {
            // Incomplete — free partial uploads to avoid leaking atlas slots
            for (const tk of tileKeyList) tileManager.freeTile(tk)
          }
          return
        }

        const { instances, tileKeyList, complete } = processTiles(data, tileManager)
        if (complete) {
          tileDataStore.set(imageIndex, lodLevel, instances, tileKeyList)
          onProgress?.()
        } else {
          // Incomplete — free partial uploads, will be retried next frame
          for (const tk of tileKeyList) tileManager.freeTile(tk)
          onProgress?.() // still trigger rebuild to re-evaluate
        }
      } catch (err) {
        if (err.message !== 'cancelled') {
          console.error(`Failed to load image ${imageIndex} at LOD ${lodLevel}:`, err)
        }
      } finally {
        tileDataStore.clearLoadingPromise(imageIndex, lodLevel)
      }
    })()

    tileDataStore.setLoadingPromise(imageIndex, lodLevel, promise)
    return promise
  })

  await Promise.all(promises)
}

function rebuildInstances(visibleImages, perImageLod, tileManager, tileDataStore, renderedSetRef) {
  tileManager.clearInstances()

  const renderedSet = new Set()

  for (const imageIndex of visibleImages) {
    const targetLod = perImageLod.get(imageIndex) ?? 0
    // Use best available LOD (target or fallback)
    const availableLod = tileDataStore.getBestAvailableLod(imageIndex, targetLod)
    if (availableLod < 0) continue

    renderedSet.add(`${imageIndex}_${availableLod}`)

    const instances = tileDataStore.get(imageIndex, availableLod)
    if (!instances) continue

    for (const { slot, worldX, worldY, tileWorldW, tileWorldH, rotation } of instances) {
      tileManager.addInstance(slot, worldX, worldY, tileWorldW, tileWorldH, rotation)
    }
  }

  renderedSetRef.current = renderedSet
  tileManager.update()
}

function Scene({ onTileCountChange, onVisibleImagesChange, onStatsChange }) {
  const controlsRef = useRef()

  const totalCols = GRID_COLS
  const totalRows = Math.ceil(IMAGE_COUNT / GRID_COLS)
  const centerX = ((totalCols - 1) * (BASE_WORLD_SIZE + GAP)) / 2
  const centerY = -((totalRows - 1) * (BASE_WORLD_SIZE + GAP)) / 2

  return (
    <>
      <SetupCamera controlsRef={controlsRef} />
      <FigmaControlsComponent ref={controlsRef} />
      <TileSystem
        onTileCountChange={onTileCountChange}
        onVisibleImagesChange={onVisibleImagesChange}
        onStatsChange={onStatsChange}
      />
      <ambientLight intensity={1} />
    </>
  )
}

function SetupCamera({ controlsRef }) {
  const { camera } = useThree()

  useEffect(() => {
    const totalCols = GRID_COLS
    const totalRows = Math.ceil(IMAGE_COUNT / GRID_COLS)
    const centerX = ((totalCols - 1) * (BASE_WORLD_SIZE + GAP)) / 2
    const centerY = -((totalRows - 1) * (BASE_WORLD_SIZE + GAP)) / 2

    camera.position.set(centerX, centerY, 100)
    camera.up.set(0, 1, 0)
    camera.lookAt(centerX, centerY, 0)
  }, [camera, controlsRef])

  return null
}

function App() {
  const [stats, setStats] = useState({ visibleImages: 0, currentLod: 0, tilesRendered: 0, slotsUsed: 0, slotsTotal: 0 })

  return (
    <div className="container">
      <div className="controls-info">
        <p>Images: {IMAGE_COUNT}</p>
        <p>Visible: {stats.visibleImages}</p>
        <p>LOD: {stats.currentLod}</p>
        <p>Tiles: {stats.tilesRendered}</p>
        <p>Slots: {stats.slotsUsed}/{stats.slotsTotal}</p>
      </div>
      <Canvas
        orthographic
        camera={{ position: [0, 0, 100], zoom: 40, up: [0, 1, 0] }}
        frameloop="always"
      >
        <Scene onStatsChange={setStats} />
      </Canvas>
    </div>
  )
}

export default App
