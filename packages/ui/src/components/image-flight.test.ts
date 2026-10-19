import { describe, expect, test } from "bun:test"
import { createFlight, elementFrame, fittedImage, flightStyle, KICK, type FlightFrame } from "./image-flight"

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

describe("createFlight", () => {
  const box = (x: number, width: number) => ({ x, y: 100, width, height: width * 0.75 })

  const frame = (x: number, width: number, radius: number): FlightFrame => ({
    image: box(x, width),
    clip: box(x, width),
    radius,
  })

  const thumbnail = frame(495, 285, 8)

  const preview = frame(314, 651, 6)

  const progress = (flight: ReturnType<typeof createFlight>) =>
    (flight.frame().image.width - thumbnail.image.width) / (preview.image.width - thumbnail.image.width)

  test("opens fast and settles without overshoot, like Claude's measured preview", () => {
    const flight = createFlight(thumbnail)
    flight.to(preview, KICK.open)
    const path = Array.from({ length: 30 }, () => (flight.step(1 / 60), progress(flight)))

    // Measured: 25% after one frame, 61% after three, 91% after seven.
    expect(path[0]).toBeCloseTo(0.25, 1)
    expect(path[2]).toBeCloseTo(0.61, 1)
    expect(path[6]).toBeCloseTo(0.91, 1)
    path.forEach((value) => expect(value).toBeLessThanOrEqual(1))
    expect(flight.frame()).toEqual(preview)
  })

  test("turns around mid-flight from where it is, carrying its velocity", () => {
    const flight = createFlight(thumbnail)
    flight.to(preview, KICK.open)
    Array.from({ length: 4 }, () => flight.step(1 / 60))
    const turn = flight.frame()
    flight.to(thumbnail, KICK.close)

    expect(flight.frame()).toEqual(turn)

    // A fresh close launched from the same frame, at rest, moves further on its first frame than the reversed flight,
    // which first has to cancel the outward velocity it still carries.
    const fresh = createFlight(turn)
    fresh.to(thumbnail, KICK.close)
    flight.step(1 / 60)
    fresh.step(1 / 60)
    expect(turn.image.width - flight.frame().image.width).toBeGreaterThan(0)
    expect(turn.image.width - flight.frame().image.width).toBeLessThan(turn.image.width - fresh.frame().image.width)

    while (flight.step(1 / 60));
    expect(flight.frame()).toEqual(thumbnail)
  })
})
