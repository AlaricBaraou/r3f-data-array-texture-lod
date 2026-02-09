/**
 * LOD selection based on physical pixel density.
 *
 * Key relationships:
 *   tilePixelDensity(lod) = tileSize * 2^lod / baseWorldSize   (px per world unit)
 *   screenPixelDensity    = camera.zoom                         (for standard ortho camera)
 *
 * We pick the lowest LOD where tilePixelDensity >= screenPixelDensity,
 * capped by maxLod and optionally by the image's native resolution.
 */

/**
 * Tile pixel density at a given LOD level (pixels per world unit).
 */
export function getTilePixelDensity(lodLevel, tileSize, baseWorldSize) {
  return tileSize * Math.pow(2, lodLevel) / baseWorldSize
}

/**
 * Select the appropriate LOD for a given screen pixel density.
 *
 * @param {number} screenPxPerUnit - Screen pixels per world unit (= camera.zoom for ortho)
 * @param {number} tileSize - Tile resolution in pixels (e.g. 256)
 * @param {number} baseWorldSize - World units an image occupies (e.g. 4)
 * @param {number} maxLod - Maximum LOD level available
 * @returns {number} LOD level (0 to maxLod)
 */
export function selectLod(screenPxPerUnit, tileSize, baseWorldSize, maxLod) {
  if (screenPxPerUnit <= 0) return 0
  const baseDensity = tileSize / baseWorldSize // px/unit at LOD 0
  const ratio = screenPxPerUnit / baseDensity
  if (ratio <= 1) return 0
  const lod = Math.ceil(Math.log2(ratio))
  return Math.min(lod, maxLod)
}

/**
 * Maximum useful LOD given the image's native pixel size.
 * Beyond this, tiles would just upscale source pixels.
 *
 * @param {number} imagePixelSize - Larger dimension of the source image in pixels
 * @param {number} tileSize - Tile resolution in pixels (e.g. 256)
 * @returns {number} Maximum LOD where source pixels >= tile pixels
 */
export function getMaxUsefulLod(imagePixelSize, tileSize) {
  if (imagePixelSize <= tileSize) return 0
  return Math.floor(Math.log2(imagePixelSize / tileSize))
}

/**
 * Full LOD selection: considers both screen density and image native resolution.
 *
 * @param {number} screenPxPerUnit - Screen pixels per world unit
 * @param {number} tileSize - Tile resolution in pixels
 * @param {number} baseWorldSize - World units an image occupies
 * @param {number} maxLod - Maximum LOD level available
 * @param {number} [imagePixelSize] - Source image pixel size (optional, caps LOD if provided)
 * @param {number} [imageScale=1] - Per-image world scale multiplier
 * @returns {number} LOD level
 */
export function selectImageLod(screenPxPerUnit, tileSize, baseWorldSize, maxLod, imagePixelSize, imageScale = 1) {
  // A scaled image's tiles cover scale× more world space, so tile density
  // is scale× lower. Compensate by multiplying the screen density requirement.
  const effectivePxPerUnit = screenPxPerUnit * imageScale
  let lod = selectLod(effectivePxPerUnit, tileSize, baseWorldSize, maxLod)
  if (imagePixelSize != null) {
    lod = Math.min(lod, getMaxUsefulLod(imagePixelSize, tileSize))
  }
  return lod
}
