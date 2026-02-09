export class VisibilityChecker {
  constructor(imageCount, gridCols, imageWorldSize, gap, rotations = null, scales = null) {
    this.imageCount = imageCount
    this.gridCols = gridCols
    this.imageWorldSize = imageWorldSize
    this.gap = gap
    this.stride = imageWorldSize + gap

    // State
    this.rotations = rotations
    this.scales = scales

    // Track max scale to determine safe search radius (padding)
    this.maxScale = 1.0
    if (scales) this.updateMaxScale()

    this.baseHalfSize = imageWorldSize / 2
  }

  updateRotations(rotations) {
    this.rotations = rotations
  }

  updateScales(scales) {
    this.scales = scales
    this.updateMaxScale()
  }

  updateMaxScale() {
    let max = 1.0
    if (this.scales) {
      for (let i = 0; i < this.imageCount; i++) {
        if (this.scales[i] > max) max = this.scales[i]
      }
    }
    this.maxScale = max
  }

  /**
   * Compute the world AABB for a specific image index.
   */
  getImageBounds(i) {
    if (i < 0 || i >= this.imageCount) return null

    const col = i % this.gridCols
    const row = Math.floor(i / this.gridCols)

    // Pivot (Top-Left of grid cell)
    const pivotX = col * this.stride
    const pivotY = -row * this.stride

    // Transform Data
    const rotation = this.rotations ? this.rotations[i] : 0
    const scale = this.scales ? this.scales[i] : 1

    // Center Calculation (includes scale)
    const h = this.baseHalfSize * scale

    const s = Math.sin(rotation)
    const c = Math.cos(rotation)

    // Rotate the center vector (h, -h)
    const centerOffsetX = h * c - (-h) * s
    const centerOffsetY = h * s + (-h) * c

    const centerX = pivotX + centerOffsetX
    const centerY = pivotY + centerOffsetY

    // Extent (Half-Size of AABB)
    const extent = h * (Math.abs(s) + Math.abs(c))

    return {
      minX: centerX - extent,
      maxX: centerX + extent,
      minY: centerY - extent,
      maxY: centerY + extent,
      centerX,
      centerY,
      scale,
      rotation
    }
  }

  /**
   * Compute the world-space AABB visible to the orthographic camera.
   * Camera is always looking straight down -Z, so this is just
   * position +/- half-extents adjusted by zoom.
   */
  getCameraBounds(camera) {
    camera.updateMatrixWorld()
    const halfW = (camera.right - camera.left) / (2 * camera.zoom)
    const halfH = (camera.top - camera.bottom) / (2 * camera.zoom)
    const cx = camera.position.x
    const cy = camera.position.y
    const EPS = 1e-6
    return {
      minX: cx - halfW - EPS,
      maxX: cx + halfW + EPS,
      minY: cy - halfH - EPS,
      maxY: cy + halfH + EPS
    }
  }

  getVisibleImages(camera) {
    const visible = []

    const { minX, maxX, minY, maxY } = this.getCameraBounds(camera)

    // Dynamic Padding based on max possible AABB extent from a grid cell pivot
    const searchPadding = this.imageWorldSize * this.maxScale * 1.42

    const searchMinX = minX - searchPadding
    const searchMaxX = maxX + searchPadding
    const searchMinY = minY - searchPadding
    const searchMaxY = maxY + searchPadding

    // Grid Traversal
    const minCol = Math.floor(searchMinX / this.stride)
    const maxCol = Math.ceil(searchMaxX / this.stride)
    const minRow = Math.floor(-searchMaxY / this.stride)
    const maxRow = Math.ceil(-searchMinY / this.stride)

    for (let r = minRow; r <= maxRow; r++) {
      if (r < 0) continue

      for (let c = minCol; c <= maxCol; c++) {
        if (c < 0 || c >= this.gridCols) continue

        const i = r * this.gridCols + c
        if (i < 0 || i >= this.imageCount) continue

        const bounds = this.getImageBounds(i)

        if (
          bounds.maxX >= minX &&
          bounds.minX <= maxX &&
          bounds.maxY >= minY &&
          bounds.minY <= maxY
        ) {
          visible.push(i)
        }
      }
    }

    return visible
  }

  isImageVisible(imageIndex, camera) {
    if (imageIndex < 0 || imageIndex >= this.imageCount) return false

    const { minX, maxX, minY, maxY } = this.getCameraBounds(camera)
    const bounds = this.getImageBounds(imageIndex)

    return (
      bounds.maxX >= minX &&
      bounds.minX <= maxX &&
      bounds.maxY >= minY &&
      bounds.minY <= maxY
    )
  }

  dispose() {
    this.rotations = null
    this.scales = null
  }
}
