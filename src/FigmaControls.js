import * as THREE from 'three'

export class FigmaControls {
  constructor(camera, domElement) {
    this.camera = camera
    this.domElement = domElement
    this.enabled = true
    this.zoomSpeed = 1
    this.minZoom = 0.1
    this.maxZoom = Infinity

    this._onWheel = this._onWheel.bind(this)
    domElement.addEventListener('wheel', this._onWheel, { passive: false })
  }

  _onWheel(event) {
    if (!this.enabled) return
    event.preventDefault()

    if (event.ctrlKey || event.metaKey) {
      this._handleZoom(event)
    } else {
      this._handlePan(event)
    }
  }

  _handlePan(event) {
    const scale = 1 / this.camera.zoom
    this.camera.position.x += event.deltaX * scale
    this.camera.position.y -= event.deltaY * scale
    this.update()
  }

  _handleZoom(event) {
    const camera = this.camera

    // Get cursor position in NDC before zoom
    const rect = this.domElement.getBoundingClientRect()
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1

    // Unproject cursor to world space before zoom
    const before = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera)

    // Apply zoom
    const factor = Math.pow(0.95, this.zoomSpeed * event.deltaY * 0.1)
    camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, camera.zoom * factor))
    camera.updateProjectionMatrix()

    // Unproject cursor to world space after zoom
    const after = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera)

    // Shift camera so the world point under the cursor stays fixed
    camera.position.x += before.x - after.x
    camera.position.y += before.y - after.y

    this.update()
  }

  update() {
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
  }

  dispose() {
    this.domElement.removeEventListener('wheel', this._onWheel)
  }
}
