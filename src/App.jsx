import { useEffect, useRef, useState } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { FigmaControlsComponent } from './FigmaControlsComponent'
import { TileManager } from './TileManager'
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

// Worker pool
class TileLoaderPool {
  constructor(poolSize = 4) {
    this.workers = Array.from({ length: poolSize }, () => new TileWorker())
    this.nextWorker = 0
    this.pending = new Map()
    this.idCounter = 0

    this.workers.forEach(worker => {
      worker.onmessage = (e) => this.handleMessage(e.data)
    })
  }

  handleMessage(data) {
    const { id, status } = data
    if (status === 'done' || status === 'error') {
      const pending = this.pending.get(id)
      if (pending) {
        if (status === 'done') {
          pending.resolve(data)
        } else {
          pending.reject(new Error(data.error))
        }
        this.pending.delete(id)
      }
    }
  }

  loadImageTiles(url, imageIndex, lodLevel) {
    return new Promise((resolve, reject) => {
      const id = this.idCounter++
      this.pending.set(id, { resolve, reject })

      const worker = this.workers[this.nextWorker]
      this.nextWorker = (this.nextWorker + 1) % this.workers.length

      worker.postMessage({ url, imageIndex, lodLevel, id })
    })
  }

  dispose() {
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
  const instances = []

  // For rotated images, tiles are positioned relative to image center, then rotated
  // First, calculate image center offset
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)

  for (let i = 0; i < tiles.length; i++) {
    const { tx, ty, tileWorldW, tileWorldH } = tiles[i]
    const bitmap = bitmaps[i]

    const tileKey = `${imageIndex}_lod${lodLevel}_${tx}_${ty}`
    const slot = tileManager.uploadTile(tileKey, bitmap)

    if (slot) {
      // Local position relative to image origin (top-left)
      const localX = tx * tileWorldSize + tileWorldW / 2
      const localY = -(ty * tileWorldSize + tileWorldH / 2)

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
        tileWorldW,
        tileWorldH,
        rotation
      })
    }

    bitmap.close()
  }

  return instances
}

// Track loaded data per image per LOD with priority loading
class TileDataStore {
  constructor() {
    this.data = new Map() // imageIndex -> Map(lodLevel -> instances)
    this.loadingPromises = new Map() // "imageIndex_lodLevel" -> Promise
    this.requestedLod = new Map() // imageIndex -> highest requested LOD
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

  set(imageIndex, lodLevel, instances) {
    if (!this.data.has(imageIndex)) {
      this.data.set(imageIndex, new Map())
    }
    this.data.get(imageIndex).set(lodLevel, instances)
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

  // Track the highest requested LOD for prioritization
  setRequestedLod(imageIndex, lodLevel) {
    const current = this.requestedLod.get(imageIndex) ?? -1
    if (lodLevel > current) {
      this.requestedLod.set(imageIndex, lodLevel)
    }
  }

  getRequestedLod(imageIndex) {
    return this.requestedLod.get(imageIndex) ?? 0
  }

  // Check if this LOD should be loaded (is it the highest requested?)
  shouldPrioritize(imageIndex, lodLevel) {
    return lodLevel >= this.getRequestedLod(imageIndex)
  }

  // Get best available LOD for an image (current or fallback to lower)
  getBestAvailableLod(imageIndex, targetLod) {
    for (let lod = targetLod; lod >= 0; lod--) {
      if (this.has(imageIndex, lod)) {
        return lod
      }
    }
    return -1
  }
}

function TileSystem({ onTileCountChange, onVisibleImagesChange, onStatsChange }) {
  const { gl, scene, camera } = useThree()
  const tileManagerRef = useRef(null)
  const visibilityCheckerRef = useRef(null)
  const tileDataStoreRef = useRef(null)
  const currentLodRef = useRef(0)
  const visibleImagesRef = useRef([])
  const needsRebuildRef = useRef(false)
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
      imageRotations
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

    // Check LOD
    const zoom = camera.zoom
    const targetLod = getLodLevel(zoom)
    const lodChanged = targetLod !== currentLodRef.current

    if (lodChanged) {
      currentLodRef.current = targetLod
    }

    // Load tiles for visible images at current LOD if not already loaded
    const imagesToLoad = visibleImages.filter(
      idx => !tileDataStore.has(idx, targetLod) && !tileDataStore.isLoading(idx, targetLod)
    )

    if (imagesToLoad.length > 0) {
      // Progressive loading - rebuild as each image loads
      loadImagesAtLod(imagesToLoad, targetLod, tileManager, tileDataStore, () => {
        needsRebuildRef.current = true
      })
    }

    if (visibilityChanged || lodChanged) {
      needsRebuildRef.current = true
    }

    // Rebuild instances if needed
    if (needsRebuildRef.current) {
      needsRebuildRef.current = false
      rebuildInstances(visibleImages, targetLod, tileManager, tileDataStore)
      onTileCountChange?.(tileManager.getTileCount())

      // Stats
      const stats = {
        visibleImages: visibleImages.length,
        currentLod: targetLod,
        tilesRendered: tileManager.getTileCount()
      }
      onStatsChange?.(stats)
    }
  })

  return null
}

async function loadImagesAtLod(imageIndices, lodLevel, tileManager, tileDataStore, onProgress = null) {
  const pool = getLoaderPool()

  // Update requested LOD for all images (for prioritization)
  imageIndices.forEach(idx => tileDataStore.setRequestedLod(idx, lodLevel))

  // Sort by LOD priority - load highest requested LOD first
  const sortedIndices = [...imageIndices].sort((a, b) => {
    const lodA = tileDataStore.getRequestedLod(a)
    const lodB = tileDataStore.getRequestedLod(b)
    return lodB - lodA // Higher LOD first
  })

  const promises = sortedIndices.map(async (imageIndex) => {
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

    const promise = (async () => {
      try {
        // Double-check priority before actually loading
        if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
          return
        }

        const data = await pool.loadImageTiles(images[imageIndex], imageIndex, lodLevel)

        // Check again after async load - maybe a higher LOD was requested
        if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
          // Still save the data but don't trigger rebuild
          tileDataStore.set(imageIndex, lodLevel, processTiles(data, tileManager))
          return
        }

        const instances = processTiles(data, tileManager)
        tileDataStore.set(imageIndex, lodLevel, instances)

        // Trigger progress callback for progressive loading
        onProgress?.()
      } catch (err) {
        console.error(`Failed to load image ${imageIndex} at LOD ${lodLevel}:`, err)
      } finally {
        tileDataStore.clearLoadingPromise(imageIndex, lodLevel)
      }
    })()

    tileDataStore.setLoadingPromise(imageIndex, lodLevel, promise)
    return promise
  })

  await Promise.all(promises)
}

function rebuildInstances(visibleImages, targetLod, tileManager, tileDataStore) {
  tileManager.clearInstances()

  for (const imageIndex of visibleImages) {
    // Use best available LOD (target or fallback)
    const availableLod = tileDataStore.getBestAvailableLod(imageIndex, targetLod)
    if (availableLod < 0) continue

    const instances = tileDataStore.get(imageIndex, availableLod)
    if (!instances) continue

    for (const { slot, worldX, worldY, tileWorldW, tileWorldH, rotation } of instances) {
      tileManager.addInstance(slot, worldX, worldY, tileWorldW, tileWorldH, rotation)
    }
  }

  tileManager.update()
}

function Scene({ onTileCountChange, onVisibleImagesChange, onStatsChange }) {
  const controlsRef = useRef()

  return (
    <>
      <SetupCamera controlsRef={controlsRef} />
      <FigmaControlsComponent
        ref={controlsRef}
        enableRotate={false}
        screenSpacePanning={true}
      />
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

    if (controlsRef.current) {
      controlsRef.current.target.set(centerX, centerY, 0)
      controlsRef.current.update()
    }
  }, [camera, controlsRef])

  return null
}

function App() {
  const [stats, setStats] = useState({ visibleImages: 0, currentLod: 0, tilesRendered: 0 })

  return (
    <div className="container">
      <div className="controls-info">
        <p>Images: {IMAGE_COUNT}</p>
        <p>Visible: {stats.visibleImages}</p>
        <p>LOD: {stats.currentLod}</p>
        <p>Tiles: {stats.tilesRendered}</p>
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
