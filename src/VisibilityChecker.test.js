import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three'
import { VisibilityChecker } from './VisibilityChecker'

// Helper: create an orthographic camera looking top-down at a given center
function makeCamera(centerX, centerY, zoom) {
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


const BASE_WORLD_SIZE = 4
const GAP = 0.5

/**
 * GROUND TRUTH: Uses THREE.Frustum + THREE.Box3, exactly like the old
 * working VisibilityChecker. This is what the real Three.js rendering
 * pipeline would produce.
 */
function frustumReference(checker, camera) {
  camera.updateMatrixWorld()
  const projScreenMatrix = new THREE.Matrix4()
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const frustum = new THREE.Frustum()
  frustum.setFromProjectionMatrix(projScreenMatrix)

  const box = new THREE.Box3()
  const visible = []

  for (let i = 0; i < checker.imageCount; i++) {
    const bounds = checker.getImageBounds(i)
    box.min.set(bounds.minX, bounds.minY, -0.01)
    box.max.set(bounds.maxX, bounds.maxY, 0.01)

    if (frustum.intersectsBox(box)) {
      visible.push(i)
    }
  }

  return visible
}

describe('VisibilityChecker', () => {
  let checker

  afterEach(() => {
    checker?.dispose()
  })

  describe('getImageBounds correctness', () => {
    it('scale=1, no rotation: AABB spans [x, x+size] x [y-size, y]', () => {
      checker = new VisibilityChecker(4, 2, BASE_WORLD_SIZE, GAP)

      const b0 = checker.getImageBounds(0)
      expect(b0.minX).toBeCloseTo(0)
      expect(b0.maxX).toBeCloseTo(BASE_WORLD_SIZE)
      expect(b0.minY).toBeCloseTo(-BASE_WORLD_SIZE)
      expect(b0.maxY).toBeCloseTo(0)

      const b1 = checker.getImageBounds(1)
      expect(b1.minX).toBeCloseTo(BASE_WORLD_SIZE + GAP)
      expect(b1.maxX).toBeCloseTo(2 * BASE_WORLD_SIZE + GAP)

      const b2 = checker.getImageBounds(2)
      expect(b2.minY).toBeCloseTo(-(BASE_WORLD_SIZE + GAP) - BASE_WORLD_SIZE)
      expect(b2.maxY).toBeCloseTo(-(BASE_WORLD_SIZE + GAP))
    })

    it('scale=10: AABB spans scaled extent', () => {
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, null, [10])
      const b = checker.getImageBounds(0)
      expect(b.minX).toBeCloseTo(0)
      expect(b.maxX).toBeCloseTo(40)
      expect(b.minY).toBeCloseTo(-40)
      expect(b.maxY).toBeCloseTo(0)
    })

    it('rotation=PI/4: center rotates and AABB expands', () => {
      const rotation = Math.PI / 4
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, [rotation])
      const b = checker.getImageBounds(0)

      const h = BASE_WORLD_SIZE / 2
      const s = Math.sin(rotation)
      const c = Math.cos(rotation)
      const cx = h * (c + s)
      const cy = h * (s - c)
      const extent = h * (Math.abs(s) + Math.abs(c))

      expect(b.centerX).toBeCloseTo(cx)
      expect(b.centerY).toBeCloseTo(cy)
      expect(b.minX).toBeCloseTo(cx - extent)
      expect(b.maxX).toBeCloseTo(cx + extent)
    })

    it('returns null for out-of-range index', () => {
      checker = new VisibilityChecker(4, 2, BASE_WORLD_SIZE, GAP)
      expect(checker.getImageBounds(-1)).toBeNull()
      expect(checker.getImageBounds(4)).toBeNull()
    })
  })

  describe('getCameraBounds matches THREE.Frustum world bounds', () => {
    // Verify that getCameraBounds produces the same visible world rectangle
    // as the Three.js frustum planes would define.
    it('should match frustum at various positions and zoom levels', () => {
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP)

      const cases = [
        { cx: 0, cy: 0, zoom: 1 },
        { cx: 0, cy: 0, zoom: 40 },
        { cx: 0, cy: 0, zoom: 400 },
        { cx: 0, cy: 0, zoom: 1000 },
        { cx: 10, cy: -10, zoom: 40 },
        { cx: 20.25, cy: -20.25, zoom: 40 },
        { cx: -50, cy: 100, zoom: 10 },
        { cx: 100, cy: -200, zoom: 5 },
      ]

      for (const { cx, cy, zoom } of cases) {
        const camera = makeCamera(cx, cy, zoom)
        const computed = checker.getCameraBounds(camera)

        // Extract frustum bounds via Three.js unproject (ground truth)
        const mat = new THREE.Matrix4()
        mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        mat.invert()
        const bl = new THREE.Vector3(-1, -1, 0).applyMatrix4(mat)
        const tr = new THREE.Vector3(1, 1, 0).applyMatrix4(mat)

        expect(computed.minX).toBeCloseTo(Math.min(bl.x, tr.x), 4)
        expect(computed.maxX).toBeCloseTo(Math.max(bl.x, tr.x), 4)
        expect(computed.minY).toBeCloseTo(Math.min(bl.y, tr.y), 4)
        expect(computed.maxY).toBeCloseTo(Math.max(bl.y, tr.y), 4)
      }
    })
  })

  describe('getVisibleImages matches THREE.Frustum ground truth', () => {
    // THE critical test suite: our optimized method must produce EXACTLY
    // the same results as THREE.Frustum.intersectsBox for every scenario.

    describe('simple grid (no rotation, no scale)', () => {
      it('camera at grid center, various zoom levels', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP)
        const stride = BASE_WORLD_SIZE + GAP
        const cx = 4.5 * stride + BASE_WORLD_SIZE / 2
        const cy = -4.5 * stride - BASE_WORLD_SIZE / 2

        for (const zoom of [1, 5, 10, 20, 40, 80, 160, 400, 1000]) {
          const camera = makeCamera(cx, cy, zoom)
          expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
        }
      })

      it('camera at various positions, zoom=40', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP)
        const stride = BASE_WORLD_SIZE + GAP

        const positions = [
          [0, 0],
          [2, -2],
          [stride * 9 + 2, -stride * 9 - 2],
          [stride * 4.5, -stride * 4.5],
          [-10, 10],
          [stride * 12, -stride * 12],
          [stride * 5, 0],
          [0, -stride * 5],
        ]

        for (const [px, py] of positions) {
          const camera = makeCamera(px, py, 40)
          expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
        }
      })

      it('every image center at various zoom levels', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP)

        for (const zoom of [1, 40, 200, 1000]) {
          for (let i = 0; i < 100; i++) {
            const b = checker.getImageBounds(i)
            const camera = makeCamera(b.centerX, b.centerY, zoom)
            const actual = checker.getVisibleImages(camera)
            const expected = frustumReference(checker, camera)
            expect(actual).toEqual(expected)
          }
        }
      })
    })

    describe('with mixed scales', () => {
      const scales100 = Array.from({ length: 100 }, (_, i) => (i % 40 === 0) ? 10 : 1)

      it('camera at grid center, various zoom levels', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP, null, scales100)
        const stride = BASE_WORLD_SIZE + GAP
        const cx = 4.5 * stride + BASE_WORLD_SIZE / 2
        const cy = -4.5 * stride - BASE_WORLD_SIZE / 2

        for (const zoom of [1, 5, 10, 20, 40, 80, 160, 400]) {
          const camera = makeCamera(cx, cy, zoom)
          expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
        }
      })

      it('camera near scale-10 image edges', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP, null, scales100)

        const positions = [
          [5, -5], [20, -20], [35, -35], [38, -38],
        ]
        for (const [px, py] of positions) {
          for (const zoom of [10, 40, 100, 400]) {
            const camera = makeCamera(px, py, zoom)
            expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
          }
        }
      })

      it('every image center at zoom=40', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP, null, scales100)

        for (let i = 0; i < 100; i++) {
          const b = checker.getImageBounds(i)
          const camera = makeCamera(b.centerX, b.centerY, 40)
          expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
        }
      })
    })

    describe('with mixed rotations', () => {
      const rotations100 = Array.from({ length: 100 }, (_, i) => (i % 10 === 0) ? Math.PI / 4 : 0)

      it('camera at grid center, various zoom levels', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP, rotations100)
        const stride = BASE_WORLD_SIZE + GAP
        const cx = 4.5 * stride + BASE_WORLD_SIZE / 2
        const cy = -4.5 * stride - BASE_WORLD_SIZE / 2

        for (const zoom of [1, 10, 40, 100, 400]) {
          const camera = makeCamera(cx, cy, zoom)
          expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
        }
      })
    })

    describe('full app config (rotations + scales)', () => {
      const rotations100 = Array.from({ length: 100 }, (_, i) => (i % 10 === 0) ? Math.PI / 4 : 0)
      const scales100 = Array.from({ length: 100 }, (_, i) => (i % 40 === 0) ? 10 : 1)

      it('camera at grid center, various zoom levels', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP, rotations100, scales100)
        const stride = BASE_WORLD_SIZE + GAP
        const cx = 4.5 * stride + BASE_WORLD_SIZE / 2
        const cy = -4.5 * stride - BASE_WORLD_SIZE / 2

        for (const zoom of [1, 5, 10, 20, 40, 80, 160, 400]) {
          const camera = makeCamera(cx, cy, zoom)
          expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
        }
      })

      it('camera at various positions, various zoom levels', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP, rotations100, scales100)
        const stride = BASE_WORLD_SIZE + GAP

        const positions = [
          [0, 0],
          [stride * 4.5, -stride * 4.5],
          [30, -15],
          [50, -5],
          [stride * 2, -stride * 7],
          [-5, -5],
          [stride * 9, -stride * 9],
        ]

        for (const [px, py] of positions) {
          for (const zoom of [1, 10, 40, 100, 400]) {
            const camera = makeCamera(px, py, zoom)
            expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
          }
        }
      })

      it('every image center at various zoom levels', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP, rotations100, scales100)

        for (const zoom of [1, 10, 40, 200, 1000]) {
          for (let i = 0; i < 100; i++) {
            const b = checker.getImageBounds(i)
            const camera = makeCamera(b.centerX, b.centerY, zoom)
            expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
          }
        }
      })

      it('camera at origin zoom=40 (initial R3F state)', () => {
        checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP, rotations100, scales100)
        const camera = makeCamera(0, 0, 40)
        const actual = checker.getVisibleImages(camera)
        const expected = frustumReference(checker, camera)
        expect(actual).toEqual(expected)
        expect(actual).toContain(0)
      })
    })
  })

  describe('isImageVisible agrees with getVisibleImages', () => {
    it('consistent for all images at various cameras', () => {
      const rotations = Array.from({ length: 16 }, (_, i) => (i % 4 === 0) ? Math.PI / 4 : 0)
      const scales = Array.from({ length: 16 }, (_, i) => (i % 8 === 0) ? 5 : 1)
      checker = new VisibilityChecker(16, 4, BASE_WORLD_SIZE, GAP, rotations, scales)

      const cameras = [
        makeCamera(0, 0, 40),
        makeCamera(10, -10, 40),
        makeCamera(2, -2, 200),
        makeCamera(0, 0, 5),
      ]

      for (const camera of cameras) {
        const visibleSet = new Set(checker.getVisibleImages(camera))
        for (let i = 0; i < 16; i++) {
          expect(checker.isImageVisible(i, camera)).toBe(visibleSet.has(i))
        }
      }
    })
  })

  describe('edge cases', () => {
    it('single image grid', () => {
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP)
      const camera = makeCamera(2, -2, 40)
      expect(checker.getVisibleImages(camera)).toEqual(frustumReference(checker, camera))
    })

    it('camera far from grid sees nothing', () => {
      checker = new VisibilityChecker(4, 2, BASE_WORLD_SIZE, GAP)
      const camera = makeCamera(1000, 1000, 40)
      expect(checker.getVisibleImages(camera)).toEqual([])
    })

    it('zoomed out sees more than zoomed in', () => {
      checker = new VisibilityChecker(16, 4, BASE_WORLD_SIZE, GAP)
      const stride = BASE_WORLD_SIZE + GAP
      const cx = 1.5 * stride + BASE_WORLD_SIZE / 2
      const cy = -1.5 * stride - BASE_WORLD_SIZE / 2

      const visibleOut = checker.getVisibleImages(makeCamera(cx, cy, 10))
      const visibleIn = checker.getVisibleImages(makeCamera(cx, cy, 200))
      expect(visibleOut.length).toBeGreaterThan(visibleIn.length)
    })

    it('updateScales changes visibility', () => {
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP, null, [1])
      const camera = makeCamera(30, -30, 100)
      expect(checker.getVisibleImages(camera)).toEqual([])

      checker.updateScales([10])
      expect(checker.getVisibleImages(camera)).toContain(0)
    })

    it('updateRotations changes bounds', () => {
      checker = new VisibilityChecker(1, 1, BASE_WORLD_SIZE, GAP)
      const b1 = checker.getImageBounds(0)
      checker.updateRotations([Math.PI / 4])
      const b2 = checker.getImageBounds(0)
      expect(b2.maxX - b2.minX).toBeGreaterThan(b1.maxX - b1.minX)
    })

    it('isImageVisible returns false for out-of-range', () => {
      checker = new VisibilityChecker(4, 2, BASE_WORLD_SIZE, GAP)
      const camera = makeCamera(0, 0, 40)
      expect(checker.isImageVisible(-1, camera)).toBe(false)
      expect(checker.isImageVisible(4, camera)).toBe(false)
    })

    it('results are sorted by index', () => {
      checker = new VisibilityChecker(100, 10, BASE_WORLD_SIZE, GAP)
      const camera = makeCamera(20, -20, 20)
      const visible = checker.getVisibleImages(camera)
      for (let i = 1; i < visible.length; i++) {
        expect(visible[i]).toBeGreaterThan(visible[i - 1])
      }
    })
  })
})
