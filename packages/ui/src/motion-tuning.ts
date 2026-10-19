import type { DurationOptions } from "./motion"

// Live motion settings for developer mode. Each surface registers knobs under its own group with their shipped defaults,
// plus actions that replay its motion; the Motion workspace (`motion-tuning-panel`) shows a section per group. Edits
// persist on this device.

type Knob<Kind extends string, Value> = {
  kind: Kind
  id: string
  label: string
  group: string
  initial: Value
  value: Value
}

export type MotionKnob =
  | Knob<"spring", DurationOptions>
  | Knob<"toggle", boolean>
  | (Knob<"number", number> & { min: number; max: number; step: number; unit?: string })

export type MotionAction = { id: string; label: string; group: string; run: () => void }

type Meta = { label: string; group: string }

const key = "opencode.motion.v1"

const knobs = new Map<string, MotionKnob>()

const actions = new Map<string, MotionAction>()

const listeners = new Set<() => void>()

// Saved as numbers only: `<id>.duration` and `<id>.bounce` for springs, 0 or 1 for toggles.
const saved = load()

export const motionTuning = {
  /** The spring to run now: its tuned duration scaled by the global speed and slow motion. */
  spring(id: string, meta: Meta & DurationOptions) {
    const initial = { duration: meta.duration, bounce: meta.bounce }

    const knob = register({
      kind: "spring",
      id,
      label: meta.label,
      group: meta.group,
      initial,
      value: { duration: number(`${id}.duration`, meta.duration), bounce: number(`${id}.bounce`, meta.bounce) },
    })

    return (): DurationOptions => ({
      duration: Math.max(0.03, (knob.value.duration * (slow.value ? 4 : 1)) / speed.value),
      bounce: Math.min(0.95, Math.max(0, knob.value.bounce)),
    })
  },
  toggle(id: string, meta: Meta & { value: boolean }) {
    const knob = register({
      kind: "toggle",
      id,
      label: meta.label,
      group: meta.group,
      initial: meta.value,
      value: number(id, meta.value ? 1 : 0) === 1,
    })

    return () => knob.value
  },
  /**
   * A tuned number. A `time` of "duration" is seconds, stretched by the global speed and slow motion; "rate" is per
   * second, so it shrinks by the same factor.
   */
  number(
    id: string,
    meta: Meta & { value: number; min: number; max: number; step: number; unit?: string; time?: "duration" | "rate" },
  ) {
    const knob = register({
      kind: "number",
      id,
      label: meta.label,
      group: meta.group,
      initial: meta.value,
      value: number(id, meta.value),
      min: meta.min,
      max: meta.max,
      step: meta.step,
      unit: meta.unit,
    })

    return () => {
      if (meta.time === "duration") return knob.value * timeScale()

      if (meta.time === "rate") return knob.value / timeScale()

      return knob.value
    }
  },
  /** A button that replays the motion it names. Returns its removal, for actions bound to a mounted surface. */
  action(action: MotionAction) {
    actions.set(action.id, action)
    notify()

    return () => {
      if (actions.get(action.id) !== action) return
      actions.delete(action.id)
      notify()
    }
  },
  list: () => [...knobs.values()],
  actions: () => [...actions.values()],
  /** Applies an edit and saves every knob that differs from its default. */
  set<K extends MotionKnob>(knob: K, value: K["value"]) {
    knob.value = value
    save()
    notify()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)

    return () => {
      listeners.delete(listener)
    }
  },
}

const speed = register({
  kind: "number",
  id: "speed",
  label: "Speed",
  group: "Global",
  initial: 1,
  value: number("speed", 1),
  min: 0.25,
  max: 4,
  step: 0.05,
})

const slow = register({
  kind: "toggle",
  id: "slow",
  label: "Slow motion (0.25×)",
  group: "Global",
  initial: false,
  value: number("slow", 0) === 1,
})

export const motionGlobals = { speed, slow }

// How many times longer motion takes than tuned.
function timeScale() {
  return (slow.value ? 4 : 1) / speed.value
}

function register<K extends MotionKnob>(knob: K) {
  knobs.set(knob.id, knob)
  notify()

  return knob
}

function notify() {
  listeners.forEach((listener) => listener())
}

function number(id: string, fallback: number) {
  const value = Number(saved[id])

  return id in saved && Number.isFinite(value) ? value : fallback
}

function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}")
  } catch {
    return {}
  }
}

function save() {
  const entries = [...knobs.values()]
    .flatMap((knob): [string, number, number][] => {
      if (knob.kind === "spring")
        return [
          [`${knob.id}.duration`, knob.value.duration, knob.initial.duration],
          [`${knob.id}.bounce`, knob.value.bounce, knob.initial.bounce],
        ]

      if (knob.kind === "toggle") return [[knob.id, Number(knob.value), Number(knob.initial)]]

      return [[knob.id, knob.value, knob.initial]]
    })
    .flatMap(([id, value, initial]) => (value === initial ? [] : [[id, value]]))

  try {
    if (entries.length === 0) return localStorage.removeItem(key)
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)))
  } catch {}
}
