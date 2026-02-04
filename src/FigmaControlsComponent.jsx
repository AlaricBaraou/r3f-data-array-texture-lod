import { useThree, useFrame } from '@react-three/fiber'
import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { FigmaControls } from './FigmaControls'

export const FigmaControlsComponent = forwardRef(({ enableRotate = false, screenSpacePanning = true, target, ...props }, ref) => {
  const { camera, gl } = useThree()
  const controlsRef = useRef()

  useEffect(() => {
    const controls = new FigmaControls(camera, gl.domElement)
    controls.enableRotate = enableRotate
    controls.screenSpacePanning = screenSpacePanning

    // Lock to top-down view (polar angle = PI/2 for camera looking down -Z axis)
    controls.minPolarAngle = Math.PI / 2
    controls.maxPolarAngle = Math.PI / 2

    // Set target if provided
    if (target) {
      controls.target.set(target[0], target[1], target[2])
    }

    // Apply any additional props
    Object.assign(controls, props)

    // Force update to apply settings
    controls.update()

    controlsRef.current = controls

    return () => {
      controls.dispose()
    }
  }, [camera, gl, enableRotate, screenSpacePanning, target])

  useImperativeHandle(ref, () => controlsRef.current, [])

  useFrame(() => {
    controlsRef.current?.update()
  })

  return null
})
