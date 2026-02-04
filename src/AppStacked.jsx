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

// Stack configuration
const IMAGES_PER_STACK = 100
const STACK_COUNT = Math.ceil(IMAGE_COUNT / IMAGES_PER_STACK)
const STACK_COLS = Math.ceil(Math.sqrt(STACK_COUNT)) // ~10 for 100 stacks

// Layout
const BASE_WORLD_SIZE = 4
const GAP = 30.0 // Gap between stacks (3x previous)
const STACK_OFFSET_RADIUS = 10.5 // Max radius for random offset from stack center

// Pre-generate random offsets for each image (seeded by index for consistency)
function seededRandom(seed) {
  const x = Math.sin(seed * 9999) * 10000
  return x - Math.floor(x)
}

// Use polar coordinates for circular distribution around stack center
const imageOffsets = images.map((_, i) => {
  const angle = seededRandom(i * 2) * Math.PI * 2 // Random angle 0-2π
  const radius = seededRandom(i * 2 + 1) * STACK_OFFSET_RADIUS // Random radius
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    rotation: (seededRandom(i * 3) - 0.5) * 0.1 // Slight random rotation (-0.05 to 0.05 rad)
  }
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

// Get stack index and position within stack for an image
function getImageStackInfo(imageIndex) {
  const stackIndex = Math.floor(imageIndex / IMAGES_PER_STACK)
  const indexInStack = imageIndex % IMAGES_PER_STACK
  return { stackIndex, indexInStack }
}

// Get world position for a stack
function getStackPosition(stackIndex) {
  const col = stackIndex % STACK_COLS
  const row = Math.floor(stackIndex / STACK_COLS)
  const x = col * (BASE_WORLD_SIZE + GAP)
  const y = -row * (BASE_WORLD_SIZE + GAP)
  return { x, y }
}

// Get world position for an image (stack position + random offset from center)
function getImagePosition(imageIndex) {
  const { stackIndex, indexInStack } = getImageStackInfo(imageIndex)
  const { x: stackX, y: stackY } = getStackPosition(stackIndex)

  // Each card gets a random offset from the stack center (circular distribution)
  const offset = imageOffsets[imageIndex] || { x: 0, y: 0, rotation: 0 }

  return {
    x: stackX + BASE_WORLD_SIZE / 2 + offset.x,
    y: stackY - BASE_WORLD_SIZE / 2 + offset.y,
    z: indexInStack * 0.001, // Small z offset for proper ordering
    rotation: offset.rotation
  }
}

function processTiles(data, tileManager) {
  const { imageIndex, lodLevel, tileWorldSize, tiles, bitmaps } = data

  const { x: imageX, y: imageY, z: imageZ, rotation } = getImagePosition(imageIndex)
  const instances = []

  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)

  for (let i = 0; i < tiles.length; i++) {
    const { tx, ty, tileWorldW, tileWorldH } = tiles[i]
    const bitmap = bitmaps[i]

    const tileKey = `${imageIndex}_lod${lodLevel}_${tx}_${ty}`
    const slot = tileManager.uploadTile(tileKey, bitmap)

    if (slot) {
      // Local position relative to image center (not top-left)
      const localX = tx * tileWorldSize + tileWorldW / 2 - BASE_WORLD_SIZE / 2
      const localY = -(ty * tileWorldSize + tileWorldH / 2) + BASE_WORLD_SIZE / 2

      // Apply rotation around image center
      const rotatedX = localX * cos - localY * sin
      const rotatedY = localX * sin + localY * cos

      instances.push({
        slot,
        worldX: imageX + rotatedX,
        worldY: imageY + rotatedY,
        worldZ: imageZ,
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
    this.data = new Map()
    this.loadingPromises = new Map()
    this.requestedLod = new Map()
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

  setRequestedLod(imageIndex, lodLevel) {
    const current = this.requestedLod.get(imageIndex) ?? -1
    if (lodLevel > current) {
      this.requestedLod.set(imageIndex, lodLevel)
    }
  }

  getRequestedLod(imageIndex) {
    return this.requestedLod.get(imageIndex) ?? 0
  }

  shouldPrioritize(imageIndex, lodLevel) {
    return lodLevel >= this.getRequestedLod(imageIndex)
  }

  getBestAvailableLod(imageIndex, targetLod) {
    for (let lod = targetLod; lod >= 0; lod--) {
      if (this.has(imageIndex, lod)) {
        return lod
      }
    }
    return -1
  }
}

// Visibility checker for stacked layout
class StackedVisibilityChecker {
  constructor() {
    this.frustum = new THREE.Frustum()
    this.projScreenMatrix = new THREE.Matrix4()
    this.boundingBox = new THREE.Box3()
  }

  getVisibleImages(camera) {
    camera.updateMatrixWorld()
    this.projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    )
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix)

    const visible = []

    for (let i = 0; i < IMAGE_COUNT; i++) {
      const { x, y } = getImagePosition(i)

      // Create bounding box for this image (position is now centered)
      const halfSize = BASE_WORLD_SIZE / 2
      this.boundingBox.min.set(x - halfSize, y - halfSize, -1)
      this.boundingBox.max.set(x + halfSize, y + halfSize, 1)

      if (this.frustum.intersectsBox(this.boundingBox)) {
        visible.push(i)
      }
    }

    return visible
  }

  dispose() {}
}

import * as THREE from 'three'

function TileSystem({ onStatsChange }) {
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

    const visibilityChecker = new StackedVisibilityChecker()
    visibilityCheckerRef.current = visibilityChecker

    const tileDataStore = new TileDataStore()
    tileDataStoreRef.current = tileDataStore

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

    const visibleImages = visibilityChecker.getVisibleImages(camera)
    const prevVisible = visibleImagesRef.current

    const visibilityChanged =
      visibleImages.length !== prevVisible.length ||
      visibleImages.some((v, i) => v !== prevVisible[i])

    if (visibilityChanged) {
      visibleImagesRef.current = visibleImages
    }

    const zoom = camera.zoom
    const targetLod = getLodLevel(zoom)
    const lodChanged = targetLod !== currentLodRef.current

    if (lodChanged) {
      currentLodRef.current = targetLod
    }

    const imagesToLoad = visibleImages.filter(
      idx => !tileDataStore.has(idx, targetLod) && !tileDataStore.isLoading(idx, targetLod)
    )

    if (imagesToLoad.length > 0) {
      loadImagesAtLod(imagesToLoad, targetLod, tileManager, tileDataStore, () => {
        needsRebuildRef.current = true
      })
    }

    if (visibilityChanged || lodChanged) {
      needsRebuildRef.current = true
    }

    if (needsRebuildRef.current) {
      needsRebuildRef.current = false
      rebuildInstances(visibleImages, targetLod, tileManager, tileDataStore)

      const stats = {
        visibleImages: visibleImages.length,
        currentLod: targetLod,
        tilesRendered: tileManager.getTileCount(),
        stacks: STACK_COUNT
      }
      onStatsChange?.(stats)
    }
  })

  return null
}

async function loadImagesAtLod(imageIndices, lodLevel, tileManager, tileDataStore, onProgress = null) {
  const pool = getLoaderPool()

  imageIndices.forEach(idx => tileDataStore.setRequestedLod(idx, lodLevel))

  const sortedIndices = [...imageIndices].sort((a, b) => {
    const lodA = tileDataStore.getRequestedLod(a)
    const lodB = tileDataStore.getRequestedLod(b)
    return lodB - lodA
  })

  const promises = sortedIndices.map(async (imageIndex) => {
    if (tileDataStore.has(imageIndex, lodLevel)) return

    if (tileDataStore.isLoading(imageIndex, lodLevel)) {
      return tileDataStore.getLoadingPromise(imageIndex, lodLevel)
    }

    if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
      return
    }

    const promise = (async () => {
      try {
        if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
          return
        }

        const data = await pool.loadImageTiles(images[imageIndex], imageIndex, lodLevel)

        if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
          tileDataStore.set(imageIndex, lodLevel, processTiles(data, tileManager))
          return
        }

        const instances = processTiles(data, tileManager)
        tileDataStore.set(imageIndex, lodLevel, instances)
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

  // Sort by z-index (images at back of stack first)
  const sortedImages = [...visibleImages].sort((a, b) => {
    const { indexInStack: indexA } = getImageStackInfo(a)
    const { indexInStack: indexB } = getImageStackInfo(b)
    return indexA - indexB
  })

  for (const imageIndex of sortedImages) {
    const availableLod = tileDataStore.getBestAvailableLod(imageIndex, targetLod)
    if (availableLod < 0) continue

    const instances = tileDataStore.get(imageIndex, availableLod)
    if (!instances) continue

    for (const { slot, worldX, worldY, worldZ, tileWorldW, tileWorldH, rotation } of instances) {
      tileManager.addInstanceWithZ(slot, worldX, worldY, worldZ, tileWorldW, tileWorldH, rotation)
    }
  }

  tileManager.update()
}

function Scene({ onStatsChange }) {
  const controlsRef = useRef()

  return (
    <>
      <SetupCamera controlsRef={controlsRef} />
      <FigmaControlsComponent
        ref={controlsRef}
        enableRotate={false}
        screenSpacePanning={true}
      />
      <TileSystem onStatsChange={onStatsChange} />
      <ambientLight intensity={1} />
    </>
  )
}

function SetupCamera({ controlsRef }) {
  const { camera } = useThree()

  useEffect(() => {
    const totalCols = STACK_COLS
    const totalRows = Math.ceil(STACK_COUNT / STACK_COLS)
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
  const [stats, setStats] = useState({ visibleImages: 0, currentLod: 0, tilesRendered: 0, stacks: 0 })

  return (
    <div className="container">
      <div className="controls-info">
        <p>Images: {IMAGE_COUNT}</p>
        <p>Stacks: {stats.stacks} ({IMAGES_PER_STACK}/stack)</p>
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
