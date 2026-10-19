import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createPanelMotion } from "../src/shell/panel-motion"

let frames: Map<number, FrameRequestCallback>

let id: number

let time: number

const cleanups: (() => void)[] = []

const originals = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame }

beforeEach(() => {
  frames = new Map()
  id = 0
  time = 0
  spyOn(performance, "now").mockImplementation(() => time)
  globalThis.requestAnimationFrame = (fn: FrameRequestCallback) => {
    frames.set(++id, fn)

    return id
  }

  globalThis.cancelAnimationFrame = (key: number) => {
    frames.delete(key)
  }
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  globalThis.requestAnimationFrame = originals.raf
  globalThis.cancelAnimationFrame = originals.caf
})

function frame() {
  time += 1000 / 60
  const next = [...frames.values()]
  frames.clear()

  for (const callback of next) callback(time)
}

function settle() {
  for (let i = 0; i < 120 && frames.size; i++) frame()
}

function setup(initial: boolean) {
  const [open, setOpen] = createSignal(initial)
  const [identity, setIdentity] = createSignal("a")
  const [size, setSize] = createSignal(200)
  const closed: number[] = []
  const painted = { width: 0 }

  const motion = createRoot((dispose) => {
    cleanups.push(dispose)

    return createPanelMotion({
      open,
      spring: () => ({ duration: 0.2, bounce: 0 }),
      paint: (shut) => {
        painted.width = size() * (1 - shut)
      },
      identity,
      onClosed: () => closed.push(time),
    })
  })

  return { painted, setOpen, setIdentity, setSize, closed, present: motion.present }
}

it("sizes a pointer toggle open and closed on a spring, present until the close settles", () => {
  window.dispatchEvent(new Event("pointerdown"))
  const panel = setup(false)
  expect(panel.present()).toBe(false)
  expect(panel.painted.width).toBe(0)

  panel.setOpen(true)
  expect(panel.present()).toBe(true)
  expect(panel.painted.width).toBe(0)
  frame()
  expect(panel.painted.width).toBeGreaterThan(0)
  expect(panel.painted.width).toBeLessThan(200)
  settle()
  expect(panel.painted.width).toBe(200)

  panel.setOpen(false)
  frame()
  expect(panel.present()).toBe(true)
  expect(panel.closed).toEqual([])
  settle()
  expect(panel.painted.width).toBe(0)
  expect(panel.present()).toBe(false)
  expect(panel.closed).toHaveLength(1)
})

it("moves the panel's size a little on every frame, with no jump at the start or settle", () => {
  window.dispatchEvent(new Event("pointerdown"))
  const panel = setup(false)
  panel.setOpen(true)
  const widths: number[] = []

  for (let i = 0; i < 120 && frames.size; i++) {
    frame()
    widths.push(panel.painted.width)
  }

  const steps = widths.map((width, index) => width - (widths[index - 1] ?? 0))
  expect(steps.every((step) => step >= 0)).toBe(true)
  expect(Math.max(...steps)).toBeLessThan(60)
  // The last moving frame lands within a pixel of rest.
  expect(200 - widths.findLast((width) => width < 200)!).toBeLessThan(1)
})

it("turns around mid-flight from where it is", () => {
  window.dispatchEvent(new Event("pointerdown"))
  const panel = setup(false)
  panel.setOpen(true)
  frame()
  frame()
  frame()
  const before = panel.painted.width

  panel.setOpen(false)
  expect(panel.painted.width).toBe(before)
  frame()
  // Still carrying its opening velocity, it does not jump back closed.
  expect(Math.abs(panel.painted.width - before)).toBeLessThan(30)
  settle()
  expect(panel.present()).toBe(false)
  expect(panel.painted.width).toBe(0)
})

it("repaints at rest when the open size changes, like a resize drag", () => {
  window.dispatchEvent(new Event("pointerdown"))
  const panel = setup(true)
  expect(panel.painted.width).toBe(200)

  panel.setSize(260)
  expect(panel.painted.width).toBe(260)
  expect(frames.size).toBe(0)
})

it("applies keyboard toggles at once", () => {
  window.dispatchEvent(new Event("keydown"))
  const panel = setup(true)

  panel.setOpen(false)
  expect(panel.painted.width).toBe(0)
  expect(panel.present()).toBe(false)
  expect(panel.closed).toHaveLength(1)
  expect(frames.size).toBe(0)
})

it("shows another layout's state without motion or a close", () => {
  window.dispatchEvent(new Event("pointerdown"))
  const panel = setup(true)

  panel.setIdentity("b")
  panel.setOpen(false)
  expect(frames.size).toBeGreaterThan(0)
  settle()

  panel.setOpen(true)
  settle()
  panel.setOpen(false)
  panel.setIdentity("c")
  expect(panel.present()).toBe(false)
  expect(panel.painted.width).toBe(0)
  expect(panel.closed).toHaveLength(1)
  expect(frames.size).toBe(0)
})
