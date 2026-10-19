import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { frameLoop, prefersReducedMotion, Spring, type DurationOptions } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"

const sidebar = motionTuning.spring("sidebar", { label: "Spring", group: "Left sidebar", duration: 0.2, bounce: 0 })

const side = motionTuning.spring("sidePanel", { label: "Spring", group: "Side panel", duration: 0.2, bounce: 0 })

const linked = motionTuning.toggle("sidePanelLinked", {
  label: "Follow the left sidebar's spring",
  group: "Side panel",
  value: true,
})

const keyboardInstant = motionTuning.toggle("keyboardInstant", {
  label: "Keyboard toggles are instant",
  group: "Global",
  value: true,
})

export const panelSprings = {
  sidebar,
  side: () => (linked() ? sidebar() : side()),
}

/** Adds buttons that play a panel's toggle to its Motion workspace section while the panel is mounted. */
export function replayPanelToggle(input: {
  id: string
  group: string
  toggle: () => void
  spring: () => DurationOptions
}) {
  onCleanup(
    motionTuning.action({ id: `${input.id}.toggle`, label: "Open / close", group: input.group, run: input.toggle }),
  )

  onCleanup(
    motionTuning.action({
      id: `${input.id}.reverse`,
      label: "Toggle, reverse mid-flight",
      group: input.group,
      run: () => {
        input.toggle()
        setTimeout(input.toggle, input.spring().duration * 350)
      },
    }),
  )
}

// Whether the input that caused a toggle was a key press, so shortcuts can skip the motion.
let keyboard = false

if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (keyboard = true), true)
  window.addEventListener("pointerdown", () => (keyboard = false), true)
}

/**
 * Opens and closes an edge panel on a spring. `paint` receives how far closed the panel is, from 0 (open) to 1
 * (closed), every frame of a flight and whenever a signal it reads changes at rest. It sizes the panel's real
 * layout box, so the neighbouring content's edge follows the panel's edge on every frame. `present` stays true until
 * a close settles.
 */
export function createPanelMotion(input: {
  open: Accessor<boolean>
  spring: () => DurationOptions
  paint: (closed: number) => void
  /** A change shows the new state without motion, e.g. switching to another session's layout. */
  identity?: Accessor<unknown>
  onClosed?: () => void
}) {
  const [present, setPresent] = createSignal(input.open())
  // Percent closed, so the spring's rest threshold stays well under a pixel.
  const spring = new Spring(input.open() ? 0 : 100)
  let stop: (() => void) | undefined

  const paint = () => input.paint(Math.min(1, Math.max(0, spring.value / 100)))

  const settle = () => {
    stop?.()
    stop = undefined

    if (input.open()) return
    setPresent(false)
    input.onClosed?.()
  }

  createEffect(
    on(
      () => [input.open(), input.identity?.()] as const,
      ([open, identity], previous) => {
        const target = open ? 0 : 100

        if (open) setPresent(true)

        if (previous === undefined || previous[1] !== identity) {
          stop?.()
          stop = undefined
          spring.snap(target)
          paint()

          if (!open) setPresent(false)

          return
        }

        if (prefersReducedMotion() || (keyboard && keyboardInstant())) {
          spring.snap(target)
          paint()
          settle()

          return
        }

        const tuning = input.spring()
        spring.omega = (2 * Math.PI) / tuning.duration
        spring.zeta = 1 - tuning.bounce
        spring.set(target)
        stop ??= frameLoop.add((dt) => {
          spring.step(dt)
          paint()

          if (!spring.resting) return true
          stop = undefined
          settle()

          return false
        })
      },
    ),
  )

  // Repaints at rest when the open size changes, e.g. a resize drag or a window resize.
  createEffect(paint)

  onCleanup(() => stop?.())

  return { present }
}
