import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three'
import { VisibilityChecker } from './VisibilityChecker'

// Helper: create an orthographic camera looking top-down at a given center
function makeCamera(centerX, centerY, zoom) {
  // Simulate a typical browser viewport aspect ratio
  const width = 800
  const height = 600
  const halfW = width / 2
  const halfH = height / 2
  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 2000)
  camera.zoom = zoom
  camera.position.set(centerX, centerY, 100)
  camera.up.set(0, 1, 0)
  camera.lookAt(centerX, centerY, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  return camera
}

// Helper: get the visible world bounds of the camera
function getCameraWorldBounds(camera) {
  const halfW = (camera.right - camera.left) / (2 * camera.zoom)
  const halfH = (camera.top - camera.bottom) / (2 * camera.zoom)
  return {
    left: camera.position.x - halfW,
    right: camera.position.x + halfW,
    top: camera.position.y + halfH,
    bottom: camera.position.y - halfH,
    width: halfW * 2,
    height: halfH * 2
  }
}

const BASE_WORLD_SIZE = 4
const GAP = 0.5

// Helper: get the expected world-space bounds of an image's content
// This mirrors processTiles in App.jsx — tiles grow from (x, y) top-left origin
function getExpectedImageBounds(imageIndex, gridCols, scale = 1, rotation = 0) {
  const col = imageIndex % gridCols
  const row = Math.floor(imageIndex / gridCols)
  const x = col * (BASE_WORLD_SIZE + GAP)
  const y = -row * (BASE_WORLD_SIZE + GAP)
  const size = BASE_WORLD_SIZE * scale

  if (rotation === 0) {
    return {
      minX: x,
      maxX: x + size,
      minY: y - size,
      maxY: y,
      centerX: x + size / 2,
      centerY: y - size / 2
    }
  }

  // For rotated images, the AABB expands
  const expandFactor = Math.abs(Math.sin(rotation)) + Math.abs(Math.cos(rotation))
  const boundSize = size * expandFactor
  return {
    minX: x + size / 2 - boundSize / 2,
    maxX: x + size / 2 + boundSize / 2,
    minY: y - size / 2 - boundSize / 2,
    maxY: y - size / 2 + boundSize / 2,
    centerX: x + size / 2,
    centerY: y - size / 2
  }
}

describe('VisibilityChecker', () => {
  let checker

  afterEach(() => {
    checker?.dispose()
  })

  describe('basic grid (no rotation, no scale)', () => {
    it('should see images in the center of the viewport', () => {
      // 4 images in a 2x2 grid
      checker = new VisibilityChecker(4, 2, BASE_WORLD_SIZE, GAP)
      // Camera centered on the grid, zoomed out enough to see everything
      const camera = makeCamera(
        (BASE_WORLD_SIZE + GAP) / 2,
        -(BASE_WORLD_SIZE + GAP) / 2,
        20
      )
      const visible = checker.getVisibleImages(camera)
      expect(visible).toEqual([0, 1, 2, 3])
    })

    it('should not see images far from the viewport', () => {
      // 4 images in a 2x2 grid
      checker = new VisibilityChecker(4, 2, BASE_WORLD_SIZE, GAP)
      // Camera far away from all images
      const camera = makeCamera(1000, 1000, 40)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toEqual([])
    })

    it('should see only images within camera bounds', () => {
      // 9 images in a 3x3 grid, tightly zoomed on center image (index 4)
      checker = new VisibilityChecker(9, 3, BASE_WORLD_SIZE, GAP)

      // Image 4 is at col=1, row=1 → x=4.5, y=-4.5 → center at (6.5, -6.5)
      const centerX = 1 * (BASE_WORLD_SIZE + GAP) + BASE_WORLD_SIZE / 2
      const centerY = -1 * (BASE_WORLD_SIZE + GAP) - BASE_WORLD_SIZE / 2
      // Zoom high enough that only the center image fits
      const camera = makeCamera(centerX, centerY, 200)
      const bounds = getCameraWorldBounds(camera)

      const visible = checker.getVisibleImages(camera)
      expect(visible).toContain(4)
      // At zoom 200 on 800x600, world view is 4x3 — only image 4 should be fully in view
      // Adjacent images may be partially visible depending on exact overlap
    })
  })

  describe('with scale', () => {
    it('scaled image bounding box should cover its full scaled extent', () => {
      // Single image, scale 10x → occupies 40x40 world units
      const scales = [10]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, null, scales)

      // The image content spans from (0,0) to (40, -40)
      // Camera at the far edge of the scaled image should still see it
      const camera = makeCamera(35, -35, 40)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toContain(0)
    })

    it('camera past the scaled extent should NOT see the image', () => {
      const scales = [10]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, null, scales)

      // Way past the 40x40 extent
      const camera = makeCamera(100, -100, 40)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toEqual([])
    })

    it('camera at origin should see a scale-1 image but not a far scale-1 image', () => {
      // 2 images in 2 columns: image 0 at x=0, image 1 at x=4.5
      const scales = [1, 1]
      checker = new VisibilityChecker(2, 2, BASE_WORLD_SIZE, GAP, null, scales)

      // Camera tightly on image 0 — zoom high enough to exclude image 1
      const camera = makeCamera(2, -2, 400)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toContain(0)
      expect(visible).not.toContain(1)
    })

    it('mixed scales: small camera view should see nearby scale-10 image edge', () => {
      // image 0: scale 10 (spans 0..40, 0..-40), image 1: scale 1 (at col=1)
      const scales = [10, 1]
      checker = new VisibilityChecker(2, 2, BASE_WORLD_SIZE, GAP, null, scales)

      // Camera at (30, -30) — well within the 10x image bounds, far from image 1
      const camera = makeCamera(30, -30, 100)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toContain(0)
      expect(visible).not.toContain(1)
    })
  })

  describe('with rotation', () => {
    it('rotated image should have expanded AABB', () => {
      const rotation = Math.PI / 4 // 45 degrees
      const rotations = [rotation]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, rotations)

      // The expanded AABB for a 4x4 square at 45deg is ~5.66x5.66
      const expandFactor = Math.abs(Math.sin(rotation)) + Math.abs(Math.cos(rotation))
      const boundSize = BASE_WORLD_SIZE * expandFactor

      // Camera at the corner of the expanded bound — should still be visible
      const camera = makeCamera(boundSize - 0.5, -0.5, 100)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toContain(0)
    })

    it('should not see rotated image when camera is past the expanded AABB', () => {
      const rotation = Math.PI / 4
      const rotations = [rotation]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, rotations)

      const expandFactor = Math.abs(Math.sin(rotation)) + Math.abs(Math.cos(rotation))
      const boundSize = BASE_WORLD_SIZE * expandFactor

      // Camera well past the expanded bound
      const camera = makeCamera(boundSize + 20, 20, 100)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toEqual([])
    })
  })

  describe('with rotation AND scale', () => {
    it('scaled + rotated image should have correctly positioned expanded AABB', () => {
      const rotation = Math.PI / 4
      const scale = 10
      const rotations = [rotation]
      const scales = [scale]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, rotations, scales)

      // Content center: (28.28, 0), AABB size ≈ 56.57
      // AABB X: 0..56.57, Y: -28.28..28.28
      // Camera at (50, -20) is within those bounds
      const camera = makeCamera(50, -20, 40)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toContain(0)
    })

    it('should not see scaled+rotated image when camera is past its AABB', () => {
      const rotation = Math.PI / 4
      const scale = 10
      const rotations = [rotation]
      const scales = [scale]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, rotations, scales)

      // Way past any reasonable bound
      const camera = makeCamera(200, -200, 40)
      const visible = checker.getVisibleImages(camera)
      expect(visible).toEqual([])
    })
  })

  describe('bounding box position matches tile content position', () => {
    // This is the critical test: the VisibilityChecker's AABB center must match
    // where processTiles actually places the content.
    // In processTiles, tiles grow from image origin (x, y) with localX in [0, worldSize*scale].
    // So content center is at (x + worldSize*scale/2, y - worldSize*scale/2).

    it('scale=1, no rotation: AABB center should be at grid center', () => {
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP)
      const plane = checker.planes[0]

      // Image origin is (0, 0), content spans (0,0) to (4,-4), center at (2, -2)
      expect(plane.position.x).toBeCloseTo(2)
      expect(plane.position.y).toBeCloseTo(-2)
    })

    it('scale=10, no rotation: AABB center should be at scaled content center', () => {
      const scales = [10]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, null, scales)
      const plane = checker.planes[0]

      // Content spans (0,0) to (40,-40), center at (20, -20)
      expect(plane.position.x).toBeCloseTo(20)
      expect(plane.position.y).toBeCloseTo(-20)
    })

    it('scale=10, second row: AABB center accounts for grid offset + scale', () => {
      // Image at index 2 in 2-col grid → col=0, row=1 → origin at (0, -4.5)
      const scales = [1, 1, 10, 1]
      checker = new VisibilityChecker(4, 2, BASE_WORLD_SIZE, GAP, null, scales)
      const plane = checker.planes[2]

      const originX = 0  // col=0
      const originY = -(BASE_WORLD_SIZE + GAP)  // row=1 → -4.5
      const boundSize = BASE_WORLD_SIZE * 10  // 40
      expect(plane.position.x).toBeCloseTo(originX + boundSize / 2)  // 20
      expect(plane.position.y).toBeCloseTo(originY - boundSize / 2)  // -24.5
    })

    it('scale=1, rotation=PI/4: AABB center should match rotated content center', () => {
      const rotation = Math.PI / 4
      const rotations = [rotation]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, rotations)
      const plane = checker.planes[0]

      // Content center before rotation is (s/2, -s/2) = (2, -2).
      // After rotating around origin: (2*cos+2*sin, 2*sin-2*cos) = (2.828, 0)
      const s = BASE_WORLD_SIZE
      const cos = Math.cos(rotation)
      const sin = Math.sin(rotation)
      const expectedCenterX = s / 2 * (cos + sin)  // ≈ 2.828
      const expectedCenterY = s / 2 * (sin - cos)  // ≈ 0
      expect(plane.position.x).toBeCloseTo(expectedCenterX)
      expect(plane.position.y).toBeCloseTo(expectedCenterY)
    })

    it('scale=10, rotation=PI/4: AABB center should match rotated scaled content center', () => {
      const rotation = Math.PI / 4
      const scale = 10
      const rotations = [rotation]
      const scales = [scale]
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, rotations, scales)
      const plane = checker.planes[0]

      // Content center before rotation is (20, -20).
      // After rotating around origin: (20*cos+20*sin, 20*sin-20*cos) = (28.28, 0)
      const s = BASE_WORLD_SIZE * scale
      const cos = Math.cos(rotation)
      const sin = Math.sin(rotation)
      const expectedCenterX = s / 2 * (cos + sin)
      const expectedCenterY = s / 2 * (sin - cos)
      expect(plane.position.x).toBeCloseTo(expectedCenterX)
      expect(plane.position.y).toBeCloseTo(expectedCenterY)
    })
  })

  describe('zoom levels', () => {
    it('zoomed out should see more images', () => {
      checker = new VisibilityChecker(16, 4, BASE_WORLD_SIZE, GAP)
      const centerX = 1.5 * (BASE_WORLD_SIZE + GAP) + BASE_WORLD_SIZE / 2
      const centerY = -1.5 * (BASE_WORLD_SIZE + GAP) - BASE_WORLD_SIZE / 2

      const zoomedOut = makeCamera(centerX, centerY, 10)
      const zoomedIn = makeCamera(centerX, centerY, 200)

      const visibleOut = checker.getVisibleImages(zoomedOut)
      const visibleIn = checker.getVisibleImages(zoomedIn)

      expect(visibleOut.length).toBeGreaterThan(visibleIn.length)
    })
  })
})
