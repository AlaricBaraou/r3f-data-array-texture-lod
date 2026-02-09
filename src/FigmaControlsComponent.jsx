import { useThree, useFrame } from '@react-three/fiber'
import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { FigmaControls } from './FigmaControls'

export const FigmaControlsComponent = forwardRef(({ zoomSpeed, minZoom, maxZoom, ...props }, ref) => {
  const { camera, gl } = useThree()
  const controlsRef = useRef()

  useEffect(() => {
    const controls = new FigmaControls(camera, gl.domElement)

    if (zoomSpeed !== undefined) controls.zoomSpeed = zoomSpeed
    if (minZoom !== undefined) controls.minZoom = minZoom
    if (maxZoom !== undefined) controls.maxZoom = maxZoom

    controls.update()

    controlsRef.current = controls

    return () => {
      controls.dispose()
    }
  }, [camera, gl, zoomSpeed, minZoom, maxZoom])

  useImperativeHandle(ref, () => controlsRef.current, [])

  useFrame(() => {
    controlsRef.current?.update()
  })

  return null
})
