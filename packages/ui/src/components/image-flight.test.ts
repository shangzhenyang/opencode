import { describe, expect, test } from "bun:test"
import { elementFrame, fittedImage, flightKeyframes, flightStyle, lerpFrame } from "./image-flight"

// A 1600×900 screenshot.
const natural = { width: 1600, height: 900 }

describe("fittedImage", () => {
  test("covers a box of another shape, overflowing it evenly", () => {
    // A 58×46 thumbnail is taller than 16:9, so the image fills its height and overflows its width.
    expect(fittedImage({ x: 100, y: 200, width: 58, height: 46 }, natural, "cover")).toEqual({
      x: 100 - (46 * (16 / 9) - 58) / 2,
      y: 200,
      width: 46 * (16 / 9),
      height: 46,
    })
  })

  test("contains within a box, letterboxed evenly", () => {
    expect(fittedImage({ x: 0, y: 0, width: 400, height: 400 }, natural, "contain")).toEqual({
      x: 0,
      y: 87.5,
      width: 400,
      height: 225,
    })
  })

  test("matches the box when the shapes agree", () => {
    const box = { x: 10, y: 20, width: 320, height: 180 }

    expect(fittedImage(box, natural, "fill")).toEqual(box)
    expect(fittedImage(box, natural, "contain")).toEqual(box)
  })
})

describe("flightStyle", () => {
  const base = { x: 200, y: 100, width: 800, height: 450 }

  test("is the identity at the base frame", () => {
    expect(flightStyle(base, { image: base, clip: base, radius: 6 })).toEqual({
      transform: "translate(0px, 0px) scale(1)",
      clipPath: "inset(0px 0px 0px 0px round 6px)",
    })
  })

  test("shrinks uniformly onto an uncropped thumbnail, keeping its on-screen radius", () => {
    const thumbnail = { x: 40, y: 600, width: 320, height: 180 }

    expect(flightStyle(base, { image: thumbnail, clip: thumbnail, radius: 6 })).toEqual({
      transform: "translate(-160px, 500px) scale(0.4)",
      clipPath: "inset(0px 0px 0px 0px round 15px)",
    })
  })

  test("crops to a cover thumbnail instead of squashing the image", () => {
    const frame = elementFrame({ x: 100, y: 200, width: 40, height: 45 }, natural, "cover", 6)
    const style = flightStyle(base, frame)
    // The image is 80×45 on screen, half the base, and 20px of it hangs past each side of the box.
    expect(frame.image).toEqual({ x: 80, y: 200, width: 80, height: 45 })
    expect(style).toEqual({
      transform: "translate(-120px, 100px) scale(0.1)",
      clipPath: "inset(0px 200px 0px 200px round 60px)",
    })
  })

  test("clips a zoomed image to the viewport it is seen through", () => {
    const image = { x: -200, y: -125, width: 1600, height: 900 }
    const clip = { x: 0, y: 0, width: 1200, height: 650 }

    expect(flightStyle(base, { image, clip, radius: 0 })).toEqual({
      transform: "translate(-400px, -225px) scale(2)",
      clipPath: "inset(62.5px 100px 62.5px 100px round 0px)",
    })
  })
})

describe("flightKeyframes", () => {
  const base = { x: 200, y: 100, width: 800, height: 450 }
  const preview = { image: base, clip: base, radius: 6 }
  const thumbnail = elementFrame({ x: 980, y: 80, width: 58, height: 46 }, natural, "cover", 6)

  test("keeps the on-screen corner radius steady while the image shrinks", () => {
    const radii = flightKeyframes(base, preview, thumbnail).map((frame) => {
      const scale = Number(frame.transform.match(/scale\((.+)\)/)?.[1])
      const local = Number(frame.clipPath.match(/round (.+)px/)?.[1])

      return local * scale
    })

    radii.forEach((radius) => expect(radius).toBeCloseTo(6, 1))
  })

  test("starts and ends exactly on both frames", () => {
    const frames = flightKeyframes(base, preview, thumbnail)

    expect(frames[0]).toEqual(flightStyle(base, preview))
    expect(frames.at(-1)).toEqual(flightStyle(base, thumbnail))
  })
})

describe("lerpFrame", () => {
  test("finds the frame part way through a flight, so a reversal starts from it", () => {
    const from = {
      image: { x: 0, y: 0, width: 100, height: 50 },
      clip: { x: 0, y: 0, width: 100, height: 50 },
      radius: 0,
    }

    const to = {
      image: { x: 100, y: 50, width: 300, height: 150 },
      clip: { x: 120, y: 50, width: 260, height: 150 },
      radius: 8,
    }

    expect(lerpFrame(from, to, 0.25)).toEqual({
      image: { x: 25, y: 12.5, width: 150, height: 75 },
      clip: { x: 30, y: 12.5, width: 140, height: 75 },
      radius: 2,
    })
  })
})
