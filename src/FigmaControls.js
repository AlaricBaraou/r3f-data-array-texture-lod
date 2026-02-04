import { MapControls } from 'three/examples/jsm/controls/MapControls.js'

export class FigmaControls extends MapControls {
  constructor(camera, domElement) {
    super(camera, domElement)

    // Override the default wheel handler
    this._onWheel = this._onWheel.bind(this)

    // Remove the original wheel listener and add our custom one
    domElement.removeEventListener('wheel', this._onMouseWheel)
    domElement.addEventListener('wheel', this._onWheel, { passive: false })
  }

  _onWheel(event) {
    if (this.enabled === false) return

    event.preventDefault()

    // Pinch gesture (zoom) - ctrlKey is true for trackpad pinch on macOS/Chrome
    if (event.ctrlKey || event.metaKey) {
      if (this.enableZoom === false) return

      this._handlePinchZoom(event)
    } else {
      // Two-finger scroll (pan)
      if (this.enablePan === false) return

      this._handleTrackpadPan(event)
    }
  }

  _handlePinchZoom(event) {
    this._updateZoomParameters(event.clientX, event.clientY)

    const zoomSpeed = 20
    const delta = event.deltaY * zoomSpeed

    if (delta < 0) {
      this._dollyIn(this._getZoomScale(delta))
    } else if (delta > 0) {
      this._dollyOut(this._getZoomScale(delta))
    }

    this.update()
  }

  _handleTrackpadPan(event) {
    this._pan(-event.deltaX, -event.deltaY)
    this.update()
  }

  dispose() {
    this.domElement.removeEventListener('wheel', this._onWheel)
    super.dispose()
  }
}
