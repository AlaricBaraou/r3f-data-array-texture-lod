import { useEffect, useRef, useState } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { FigmaControlsComponent } from './FigmaControlsComponent'
import { TileManager } from './TileManager'
import { TileDataStore } from './TileDataStore'
import { getLoaderPool } from './TileLoaderPool'
import { selectLod } from './lodSelection'
import './App.css'

// Load all images from public folder
const imageFiles = import.meta.glob('/public/*.jpg', { eager: true, query: '?url', import: 'default' })
const images = Object.keys(imageFiles).map(path => imageFiles[path])
const IMAGE_COUNT = images.length

// Stack configuration
const IMAGES_PER_STACK = 100
const STACK_COUNT = Math.ceil(IMAGE_COUNT / IMAGES_PER_STACK)
const STACK_COLS = Math.ceil(Math.sqrt(STACK_COUNT))

// Layout
const BASE_WORLD_SIZE = 4
const GAP = 30.0
const STACK_OFFSET_RADIUS = 10.5

// Pre-generate random offsets for each image (seeded by index for consistency)
function seededRandom(seed) {
  const x = Math.sin(seed * 9999) * 10000
  return x - Math.floor(x)
}

const imageOffsets = images.map((_, i) => {
  const angle = seededRandom(i * 2) * Math.PI * 2
  const radius = seededRandom(i * 2 + 1) * STACK_OFFSET_RADIUS
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    rotation: (seededRandom(i * 3) - 0.5) * 0.1
  }
})

// LOD config
const TILE_SIZE = 256
const MAX_LOD = 4

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

  const offset = imageOffsets[imageIndex] || { x: 0, y: 0, rotation: 0 }

  return {
    x: stackX + BASE_WORLD_SIZE / 2 + offset.x,
    y: stackY - BASE_WORLD_SIZE / 2 + offset.y,
    z: indexInStack * 0.001,
    rotation: offset.rotation
  }
}

function processTiles(data, tileManager) {
  const { imageIndex, lodLevel, tileWorldSize, tiles, bitmaps } = data

  const { x: imageX, y: imageY, z: imageZ, rotation } = getImagePosition(imageIndex)
  const instances = []
  const tileKeyList = []

  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)

  let complete = true

  for (let i = 0; i < tiles.length; i++) {
    const { tx, ty, tileWorldW, tileWorldH } = tiles[i]
    const bitmap = bitmaps[i]

    const tileKey = `${imageIndex}_lod${lodLevel}_${tx}_${ty}`
    const slot = tileManager.uploadTile(tileKey, bitmap)

    if (slot) {
      tileKeyList.push(tileKey)
      // Local position relative to image center
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
    } else {
      complete = false
    }

    bitmap.close()
  }

  return { instances, tileKeyList, complete }
}

// Visibility checker for stacked layout using frustum
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

function TileSystem({ onStatsChange }) {
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

    // Compute per-image LOD — use physical pixel density (zoom × DPR) for sharp rendering
    const zoom = camera.zoom * gl.getPixelRatio()
    const imageLodCache = imageLodCacheRef.current
    let anyLodChanged = false

    const perImageLod = new Map()
    const pool = getLoaderPool()
    for (const idx of visibleImages) {
      const targetLod = selectLod(zoom, TILE_SIZE, BASE_WORLD_SIZE, MAX_LOD)
      perImageLod.set(idx, targetLod)

      const prevLod = imageLodCache.get(idx)
      if (prevLod !== targetLod) {
        anyLodChanged = true
        imageLodCache.set(idx, targetLod)
        if (targetLod > (prevLod ?? -1)) {
          pool.cancelPending(idx, targetLod)
        }
      }
    }

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

    // Evict stale tiles when we need room
    if (loadByLod.size > 0) {
      let estimatedNeeded = 0
      for (const [lodLevel, indices] of loadByLod) {
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

    if (needsRebuildRef.current) {
      needsRebuildRef.current = false
      rebuildInstances(visibleImages, perImageLod, tileManager, tileDataStore, renderedSetRef)

      const lodValues = [...perImageLod.values()]
      const minLod = lodValues.length > 0 ? Math.min(...lodValues) : 0
      const maxLod = lodValues.length > 0 ? Math.max(...lodValues) : 0
      const usedSlots = tileManager.getUsedSlotCount()
      const totalSlots = tileManager.getTotalSlots()
      const stats = {
        visibleImages: visibleImages.length,
        currentLod: minLod === maxLod ? minLod : `${minLod}-${maxLod}`,
        tilesRendered: tileManager.getTileCount(),
        stacks: STACK_COUNT,
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

  imageIndices.forEach(idx => tileDataStore.setRequestedLod(idx, lodLevel))

  const promises = imageIndices.map(async (imageIndex) => {
    if (tileDataStore.has(imageIndex, lodLevel)) return

    if (tileDataStore.isLoading(imageIndex, lodLevel)) {
      return tileDataStore.getLoadingPromise(imageIndex, lodLevel)
    }

    if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
      return
    }

    // Priority: LOD as primary, distance-from-center as secondary
    const { x, y } = getImagePosition(imageIndex)
    const dx = x - cameraX
    const dy = y - cameraY
    const dist = Math.sqrt(dx * dx + dy * dy)
    const priority = lodLevel + 1 / (1 + dist)

    const promise = (async () => {
      try {
        if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
          return
        }

        const data = await pool.loadImageTiles(images[imageIndex], imageIndex, lodLevel, priority)

        if (!tileDataStore.shouldPrioritize(imageIndex, lodLevel)) {
          const { instances, tileKeyList, complete } = processTiles(data, tileManager)
          if (complete) {
            tileDataStore.set(imageIndex, lodLevel, instances, tileKeyList)
          } else {
            for (const tk of tileKeyList) tileManager.freeTile(tk)
          }
          return
        }

        const { instances, tileKeyList, complete } = processTiles(data, tileManager)
        if (complete) {
          tileDataStore.set(imageIndex, lodLevel, instances, tileKeyList)
          onProgress?.()
        } else {
          for (const tk of tileKeyList) tileManager.freeTile(tk)
          onProgress?.()
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

  // Sort by z-index (images at back of stack first)
  const sortedImages = [...visibleImages].sort((a, b) => {
    const { indexInStack: indexA } = getImageStackInfo(a)
    const { indexInStack: indexB } = getImageStackInfo(b)
    return indexA - indexB
  })

  for (const imageIndex of sortedImages) {
    const targetLod = perImageLod.get(imageIndex) ?? 0
    const availableLod = tileDataStore.getBestAvailableLod(imageIndex, targetLod)
    if (availableLod < 0) continue

    renderedSet.add(`${imageIndex}_${availableLod}`)

    const instances = tileDataStore.get(imageIndex, availableLod)
    if (!instances) continue

    for (const { slot, worldX, worldY, worldZ, tileWorldW, tileWorldH, rotation } of instances) {
      tileManager.addInstanceWithZ(slot, worldX, worldY, worldZ, tileWorldW, tileWorldH, rotation)
    }
  }

  renderedSetRef.current = renderedSet
  tileManager.update()
}

function Scene({ onStatsChange }) {
  const controlsRef = useRef()

  return (
    <>
      <SetupCamera controlsRef={controlsRef} />
      <FigmaControlsComponent ref={controlsRef} />
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
  }, [camera, controlsRef])

  return null
}

function App() {
  const [stats, setStats] = useState({ visibleImages: 0, currentLod: 0, tilesRendered: 0, stacks: 0, slotsUsed: 0, slotsTotal: 0 })

  return (
    <div className="container">
      <div className="controls-info">
        <p>Images: {IMAGE_COUNT}</p>
        <p>Stacks: {stats.stacks} ({IMAGES_PER_STACK}/stack)</p>
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
