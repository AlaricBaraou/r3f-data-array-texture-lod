// Web Worker for off-thread tile loading and decoding

const TILE_SIZE = 256
const BASE_WORLD_SIZE = 4

self.onmessage = async (e) => {
  const { url, imageIndex, lodLevel, id } = e.data

  try {
    // Fetch image
    self.postMessage({ id, status: 'fetching' })
    const response = await fetch(url)
    const blob = await response.blob()

    // Get image dimensions
    const fullBitmap = await createImageBitmap(blob)
    const imageWidth = fullBitmap.width
    const imageHeight = fullBitmap.height
    fullBitmap.close()

    // Calculate image world size (maintaining aspect ratio)
    const aspect = imageWidth / imageHeight
    let worldWidth, worldHeight
    if (aspect >= 1) {
      worldWidth = BASE_WORLD_SIZE
      worldHeight = BASE_WORLD_SIZE / aspect
    } else {
      worldWidth = BASE_WORLD_SIZE * aspect
      worldHeight = BASE_WORLD_SIZE
    }

    // Fixed tile world size at this LOD
    const tileWorldSize = BASE_WORLD_SIZE / Math.pow(2, lodLevel)

    // How many tiles needed to cover this image
    const tilesX = Math.ceil(worldWidth / tileWorldSize)
    const tilesY = Math.ceil(worldHeight / tileWorldSize)

    // Pixels per world unit
    const pixelsPerWorldX = imageWidth / worldWidth
    const pixelsPerWorldY = imageHeight / worldHeight

    self.postMessage({ id, status: 'decoding', tilesX, tilesY })

    // Create all tile bitmaps
    const tilePromises = []
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        // World space bounds for this tile
        const worldX0 = tx * tileWorldSize
        const worldY0 = ty * tileWorldSize
        const worldX1 = Math.min((tx + 1) * tileWorldSize, worldWidth)
        const worldY1 = Math.min((ty + 1) * tileWorldSize, worldHeight)

        // Actual tile world size (may be smaller for edge tiles)
        const tileW = worldX1 - worldX0
        const tileH = worldY1 - worldY0

        // Convert to pixel coordinates
        const srcX = Math.round(worldX0 * pixelsPerWorldX)
        const srcY = Math.round(worldY0 * pixelsPerWorldY)
        const srcW = Math.round(tileW * pixelsPerWorldX)
        const srcH = Math.round(tileH * pixelsPerWorldY)

        const promise = createImageBitmap(
          blob,
          srcX,
          srcY,
          srcW,
          srcH,
          {
            resizeWidth: TILE_SIZE,
            resizeHeight: TILE_SIZE,
            imageOrientation: 'flipY',
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none'
          }
        ).then(bitmap => ({
          bitmap,
          tx,
          ty,
          tileWorldW: tileW,
          tileWorldH: tileH
        }))
        tilePromises.push(promise)
      }
    }

    const tiles = await Promise.all(tilePromises)
    const bitmaps = tiles.map(t => t.bitmap)

    self.postMessage(
      {
        id,
        status: 'done',
        imageIndex,
        lodLevel,
        imageWidth,
        imageHeight,
        worldWidth,
        worldHeight,
        tileWorldSize,
        tilesX,
        tilesY,
        tiles: tiles.map(({ tx, ty, tileWorldW, tileWorldH }) => ({
          tx, ty, tileWorldW, tileWorldH
        })),
        bitmaps
      },
      bitmaps
    )
  } catch (err) {
    self.postMessage({ id, status: 'error', error: err.message })
  }
}
