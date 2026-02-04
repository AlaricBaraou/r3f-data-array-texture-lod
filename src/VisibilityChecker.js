import * as THREE from 'three'

/**
 * Maintains a shadow scene with placeholder planes for frustum culling checks
 */
export class VisibilityChecker {
  constructor(imageCount, gridCols, imageWorldSize, gap, rotations = null) {
    this.imageCount = imageCount
    this.gridCols = gridCols
    this.imageWorldSize = imageWorldSize
    this.gap = gap

    // Shadow scene for visibility checks
    this.scene = new THREE.Scene()
    this.planes = []

    // Frustum for culling
    this.frustum = new THREE.Frustum()
    this.projScreenMatrix = new THREE.Matrix4()

    // Create placeholder planes for each image
    const material = new THREE.MeshBasicMaterial({ visible: false })

    for (let i = 0; i < imageCount; i++) {
      const col = i % gridCols
      const row = Math.floor(i / gridCols)
      const x = col * (imageWorldSize + gap)
      const y = -row * (imageWorldSize + gap)

      const rotation = rotations ? rotations[i] : 0

      // For rotated images, expand the bounding box
      // A rotated square needs a larger AABB
      const expandFactor = rotation !== 0 ? Math.abs(Math.sin(rotation)) + Math.abs(Math.cos(rotation)) : 1
      const boundSize = imageWorldSize * expandFactor

      const geometry = new THREE.PlaneGeometry(boundSize, boundSize)
      const plane = new THREE.Mesh(geometry, material)
      plane.position.set(x + imageWorldSize / 2, y - imageWorldSize / 2, 0)
      plane.userData.imageIndex = i

      // Compute bounding box for frustum checks
      plane.geometry.computeBoundingBox()
      plane.updateMatrixWorld()

      this.planes.push(plane)
      this.scene.add(plane)
    }

    // Reusable bounding box
    this.boundingBox = new THREE.Box3()
  }

  /**
   * Update rotations (if they change dynamically)
   */
  updateRotations(rotations) {
    for (let i = 0; i < this.planes.length; i++) {
      const rotation = rotations ? rotations[i] : 0
      const expandFactor = rotation !== 0 ? Math.abs(Math.sin(rotation)) + Math.abs(Math.cos(rotation)) : 1
      const boundSize = this.imageWorldSize * expandFactor

      // Update geometry size
      const plane = this.planes[i]
      plane.geometry.dispose()
      plane.geometry = new THREE.PlaneGeometry(boundSize, boundSize)
      plane.geometry.computeBoundingBox()
    }
  }

  /**
   * Get list of visible image indices based on camera frustum
   * @param {THREE.Camera} camera
   * @returns {number[]} Array of visible image indices
   */
  getVisibleImages(camera) {
    // Update frustum from camera
    camera.updateMatrixWorld()
    this.projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    )
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix)

    const visible = []

    for (const plane of this.planes) {
      // Get world bounding box
      this.boundingBox.copy(plane.geometry.boundingBox)
      this.boundingBox.applyMatrix4(plane.matrixWorld)

      if (this.frustum.intersectsBox(this.boundingBox)) {
        visible.push(plane.userData.imageIndex)
      }
    }

    return visible
  }

  /**
   * Check if a specific image is visible
   * @param {number} imageIndex
   * @param {THREE.Camera} camera
   * @returns {boolean}
   */
  isImageVisible(imageIndex, camera) {
    if (imageIndex < 0 || imageIndex >= this.planes.length) return false

    camera.updateMatrixWorld()
    this.projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    )
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix)

    const plane = this.planes[imageIndex]
    this.boundingBox.copy(plane.geometry.boundingBox)
    this.boundingBox.applyMatrix4(plane.matrixWorld)

    return this.frustum.intersectsBox(this.boundingBox)
  }

  dispose() {
    this.planes.forEach(plane => {
      plane.geometry.dispose()
      plane.material.dispose()
    })
    this.scene.clear()
  }
}
