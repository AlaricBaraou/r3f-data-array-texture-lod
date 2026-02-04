import * as THREE from 'three'

const TILE_SIZE = 256
const ATLAS_SIZE = 4096 // Each layer is 4096x4096
const TILES_PER_LAYER = ATLAS_SIZE / TILE_SIZE // 16x16 = 256 tiles per layer
const MAX_LAYERS = 16 // 8 layers × 256 tiles = 2,048 tile slots (~512MB)
const MAX_INSTANCES = MAX_LAYERS * TILES_PER_LAYER * TILES_PER_LAYER

const vertexShader = /* glsl */ `
  attribute float aLayer;
  attribute vec2 aUvOffset;
  attribute vec2 aUvScale;

  varying vec2 vUv;
  varying float vLayer;
  varying vec2 vUvOffset;
  varying vec2 vUvScale;

  void main() {
    vUv = uv;
    vLayer = aLayer;
    vUvOffset = aUvOffset;
    vUvScale = aUvScale;

    vec4 worldPos = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * worldPos;
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uTileAtlas;
  uniform bool uShowBorders;

  varying vec2 vUv;
  varying float vLayer;
  varying vec2 vUvOffset;
  varying vec2 vUvScale;

  void main() {
    // Map local UV to atlas UV
    vec2 atlasUv = vUvOffset + vUv * vUvScale;
    vec4 color = texture(uTileAtlas, vec3(atlasUv, vLayer));

    if (uShowBorders) {
      float borderWidth = 0.02;
      if (vUv.x < borderWidth || vUv.x > 1.0 - borderWidth ||
          vUv.y < borderWidth || vUv.y > 1.0 - borderWidth) {
        color = vec4(1.0, 0.0, 0.0, 1.0);
      }
    }

    gl_FragColor = color;
  }
`

export class TileManager {
  constructor(renderer, maxLayers = MAX_LAYERS) {
    this.renderer = renderer
    this.gl = renderer.getContext()
    this.maxLayers = maxLayers
    this.tilesPerLayer = TILES_PER_LAYER * TILES_PER_LAYER // 256

    // Track slot usage: layerIndex -> Set of slotIndex (0-255)
    this.layerSlots = Array.from({ length: maxLayers }, () => new Set())
    this.usedSlots = new Map() // tileKey -> { layer, slotX, slotY }

    // Create the DataArrayTexture
    this.tileAtlas = new THREE.DataArrayTexture(
      new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4 * maxLayers),
      ATLAS_SIZE,
      ATLAS_SIZE,
      maxLayers
    )
    this.tileAtlas.format = THREE.RGBAFormat
    this.tileAtlas.type = THREE.UnsignedByteType
    this.tileAtlas.minFilter = THREE.LinearFilter
    this.tileAtlas.magFilter = THREE.LinearFilter
    this.tileAtlas.needsUpdate = true

    // Create instanced mesh
    this.geometry = new THREE.PlaneGeometry(1, 1)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTileAtlas: { value: this.tileAtlas },
        uShowBorders: { value: true }
      },
      vertexShader,
      fragmentShader,
    })

    const maxInstances = MAX_INSTANCES
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, maxInstances)
    this.mesh.count = 0
    this.mesh.frustumCulled = false

    // Instance attributes
    this.layerAttribute = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances), 1
    )
    this.uvOffsetAttribute = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances * 2), 2
    )
    this.uvScaleAttribute = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances * 2), 2
    )

    this.geometry.setAttribute('aLayer', this.layerAttribute)
    this.geometry.setAttribute('aUvOffset', this.uvOffsetAttribute)
    this.geometry.setAttribute('aUvScale', this.uvScaleAttribute)

    this.instances = []
    this.uvScale = TILE_SIZE / ATLAS_SIZE // 0.0625 for 256/4096
  }

  /**
   * Find a free slot in any layer
   * @returns {{ layer: number, slotX: number, slotY: number } | null}
   */
  findFreeSlot() {
    for (let layer = 0; layer < this.maxLayers; layer++) {
      const usedSlots = this.layerSlots[layer]
      if (usedSlots.size < this.tilesPerLayer) {
        // Find first free slot
        for (let i = 0; i < this.tilesPerLayer; i++) {
          if (!usedSlots.has(i)) {
            const slotX = i % TILES_PER_LAYER
            const slotY = Math.floor(i / TILES_PER_LAYER)
            return { layer, slotX, slotY, slotIndex: i }
          }
        }
      }
    }
    return null
  }

  /**
   * Upload a tile ImageBitmap to the atlas
   * @returns {{ layer: number, slotX: number, slotY: number } | null}
   */
  uploadTile(tileKey, imageBitmap) {
    // Check if already uploaded
    if (this.usedSlots.has(tileKey)) {
      return this.usedSlots.get(tileKey)
    }

    const slot = this.findFreeSlot()
    if (!slot) {
      console.warn('TileManager: No free slots available')
      return null
    }

    const { layer, slotX, slotY, slotIndex } = slot
    this.layerSlots[layer].add(slotIndex)
    this.usedSlots.set(tileKey, { layer, slotX, slotY })

    // Upload ImageBitmap to the specific slot
    const texture = this.renderer.properties.get(this.tileAtlas).__webglTexture
    if (texture) {
      const gl = this.gl
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        slotX * TILE_SIZE, // x offset in layer
        slotY * TILE_SIZE, // y offset in layer
        layer,             // layer index
        TILE_SIZE, TILE_SIZE, 1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        imageBitmap
      )
    }

    return { layer, slotX, slotY }
  }

  /**
   * Add a tile instance to be rendered
   */
  addInstance(slot, x, y, scaleX = 1, scaleY = 1, rotation = 0) {
    return this.addInstanceWithZ(slot, x, y, 0, scaleX, scaleY, rotation)
  }

  /**
   * Add a tile instance with z-position (for stacking)
   */
  addInstanceWithZ(slot, x, y, z = 0, scaleX = 1, scaleY = 1, rotation = 0) {
    if (!slot) return -1

    const instanceIndex = this.instances.length
    const { layer, slotX, slotY } = slot

    // Build matrix: scale -> rotate -> translate
    const matrix = new THREE.Matrix4()
    const scaleMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, 1)
    const rotationMatrix = new THREE.Matrix4().makeRotationZ(rotation)
    const translationMatrix = new THREE.Matrix4().makeTranslation(x, y, z)

    matrix.multiplyMatrices(translationMatrix, rotationMatrix)
    matrix.multiply(scaleMatrix)

    this.mesh.setMatrixAt(instanceIndex, matrix)

    // Set attributes
    this.layerAttribute.setX(instanceIndex, layer)
    this.uvOffsetAttribute.setXY(instanceIndex, slotX * this.uvScale, slotY * this.uvScale)
    this.uvScaleAttribute.setXY(instanceIndex, this.uvScale, this.uvScale)

    this.instances.push({ slot, x, y, z, scaleX, scaleY, rotation })
    this.mesh.count = this.instances.length

    return instanceIndex
  }

  clearInstances() {
    this.instances = []
    this.mesh.count = 0
  }

  update() {
    this.mesh.instanceMatrix.needsUpdate = true
    this.layerAttribute.needsUpdate = true
    this.uvOffsetAttribute.needsUpdate = true
    this.uvScaleAttribute.needsUpdate = true
  }

  getMesh() {
    return this.mesh
  }

  setShowBorders(show) {
    this.material.uniforms.uShowBorders.value = show
  }

  getTileCount() {
    return this.mesh.count
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
    this.tileAtlas.dispose()
  }
}
