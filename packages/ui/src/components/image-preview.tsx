import { Dialog as Kobalte, useDialogContext } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { animate, type AnimationPlaybackControls } from "motion"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useDialog, useDialogLayer } from "../context/dialog"
import { useI18n } from "../context/i18n"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { frameLoop, prefersReducedMotion, Spring, type DurationOptions } from "../motion"
import { motionTuning } from "../motion-tuning"
import {
  createFlight,
  elementFrame,
  FLIGHT_SPRING,
  flightStyle,
  intersect,
  KICK,
  type Box,
  type FlightFrame,
} from "./image-flight"
import { clampView, detailScale, FIT_VIEW, maxScale, panBy, wheelZoomFactor, zoomAt, type ZoomView } from "./image-zoom"

export interface ImagePreviewProps {
  src: string
  alt?: string
  /** The image on the page that the preview grows out of and shrinks back into. */
  origin?: HTMLElement
}

const STEP = Math.SQRT2

const group = "Image open"

// Claude's backdrop dims from rest, more gently than the image flies. Without a flight (reduced motion, or no thumbnail
// to fly to), the preview only fades.
const claude = {
  springs: {
    imageOpen: FLIGHT_SPRING,
    imageClose: FLIGHT_SPRING,
    imageScrimOpen: { duration: 0.34, bounce: 0 },
    imageScrimClose: { duration: 0.2, bounce: 0 },
  },
  numbers: { imageOpenKick: KICK.open, imageCloseKick: KICK.close, imageFade: 0.15 },
}

const presets = {
  "Claude match": claude,
  Calm: {
    springs: {
      imageOpen: { duration: 0.32, bounce: 0 },
      imageClose: { duration: 0.26, bounce: 0 },
      imageScrimOpen: { duration: 0.45, bounce: 0 },
      imageScrimClose: { duration: 0.28, bounce: 0 },
    },
    numbers: { imageOpenKick: 6, imageCloseKick: 16, imageFade: 0.2 },
  },
}

const kick = { group, min: 0, max: 60, step: 0.5, unit: "×/s", time: "rate" } as const

const tuning = {
  open: motionTuning.spring("imageOpen", { label: "Open spring", group, ...claude.springs.imageOpen }),
  openKick: motionTuning.number("imageOpenKick", {
    ...kick,
    label: "Open launch velocity",
    value: claude.numbers.imageOpenKick,
  }),
  close: motionTuning.spring("imageClose", { label: "Close spring", group, ...claude.springs.imageClose }),
  closeKick: motionTuning.number("imageCloseKick", {
    ...kick,
    label: "Close launch velocity",
    value: claude.numbers.imageCloseKick,
  }),
  scrimOpen: motionTuning.spring("imageScrimOpen", { label: "Backdrop in", group, ...claude.springs.imageScrimOpen }),
  scrimClose: motionTuning.spring("imageScrimClose", {
    label: "Backdrop out",
    group,
    ...claude.springs.imageScrimClose,
  }),
  fade: motionTuning.number("imageFade", {
    label: "Reduced-motion fade",
    group,
    value: claude.numbers.imageFade,
    min: 0.05,
    max: 1,
    step: 0.01,
    unit: "s",
    time: "duration",
  }),
}

Object.entries(presets).forEach(([name, preset]) =>
  motionTuning.action({
    id: `imagePreview.preset.${name}`,
    label: `Preset: ${name}`,
    group,
    run: () => {
      const knobs = motionTuning.list()

      Object.entries(preset.springs).forEach(([id, value]) => {
        const knob = knobs.find((item) => item.id === id)

        if (knob?.kind === "spring") motionTuning.set(knob, value)
      })

      Object.entries(preset.numbers).forEach(([id, value]) => {
        const knob = knobs.find((item) => item.id === id)

        if (knob?.kind === "number") motionTuning.set(knob, value)
      })
    },
  }),
)

const fade = () => ({ duration: Math.max(0.03, tuning.fade()), bounce: 0 })

// How long the dialog stays mounted after a close starts, in milliseconds: the flight lands well within this.
const exitDuration = () => Math.max(tuning.close().duration, tuning.scrimClose().duration, tuning.fade()) * 1800

const CENTER = { x: 0, y: 0 }

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  const dialog = useDialogContext()
  let scrim!: HTMLDivElement
  let content!: HTMLDivElement
  let viewport!: HTMLDivElement
  let image!: HTMLImageElement
  let standIn!: HTMLImageElement
  let close: HTMLButtonElement | undefined
  // Nothing shows until the image has loaded and the preview knows where it lands; while flying, a stand-in image
  // travels above the dialog in place of the real one.
  const [stage, setStage] = createSignal<"pending" | "flying" | "rest">("pending")
  // The flight under way: where the stand-in is laid out (the flight only transforms and clips it), its springs, and
  // what happens when it lands.
  let course: { at: Box; flight: ReturnType<typeof createFlight>; landed: () => void } | undefined
  const dim = Spring.fromDuration(0, claude.springs.imageScrimOpen)
  // Without a flight the panel and any stand-in fade with the backdrop; with one, the panel follows it more steeply,
  // so it settles in around the image as it lands and clears before the image leaves.
  let plain = false
  let stop: (() => void) | undefined
  const [view, setView] = createSignal(FIT_VIEW)
  const [fitRatio, setFitRatio] = createSignal(1)
  const [drag, setDrag] = createSignal<{ id: number; x: number; y: number }>()
  // Where an eased zoom is heading, so repeated steps build on the destination rather than the frame in flight.
  let goal = FIT_VIEW
  let animation: AnimationPlaybackControls | undefined

  const percent = createMemo(() => new Intl.NumberFormat(i18n.locale(), { style: "percent", maximumFractionDigits: 0 }))

  const bounds = () => ({
    width: image.offsetWidth,
    height: image.offsetHeight,
    viewportWidth: viewport.clientWidth,
    viewportHeight: viewport.clientHeight,
    maxScale: maxScale(fitRatio()),
  })

  // Pinch, wheel and drag follow the hand directly and take over from an eased zoom mid-flight.
  const follow = (next: ZoomView) => {
    animation?.stop()
    animation = undefined
    goal = next
    setView(next)
  }

  const ease = (target: ZoomView) => {
    animation?.stop()
    goal = target

    if (prefersReducedMotion()) return setView(target)
    const from = view()
    animation = animate(0, 1, {
      type: "spring",
      visualDuration: 0.25,
      bounce: 0,
      onUpdate: (progress) =>
        setView({
          scale: from.scale + (target.scale - from.scale) * progress,
          x: from.x + (target.x - from.x) * progress,
          y: from.y + (target.y - from.y) * progress,
        }),
    })
  }

  const step = (factor: number) => ease(zoomAt(goal, goal.scale * factor, CENTER, bounds()))

  // Kobalte keeps the content mounted while an exit animation runs; the dialog stack waits for the flight too.
  const layer = useDialogLayer()
  const [exit, setExit] = createSignal(0)

  const holdExit = () => {
    setExit(exitDuration())
    layer?.setExitDuration(exit())
  }

  holdExit()

  const reveal = async () => {
    await Promise.all([image.decode(), standIn.decode()]).catch(() => undefined)

    if (stage() !== "pending" || !dialog.isOpen()) return
    const from = prefersReducedMotion() ? undefined : originFrame()
    holdExit()
    dimTo(1, from ? tuning.scrimOpen() : fade())

    if (!from) {
      plain = true
      paint()
      setStage("rest")

      return run()
    }

    const flight = createFlight(from)
    flight.to(restFrame(), tuning.openKick(), tuning.open())
    course = { at: place(fitted()), flight, landed: () => setStage("rest") }
    hideOrigin()
    paint()
    setStage("flying")
    run()
  }

  const dismiss = () => {
    animation?.stop()

    if (stage() === "pending") return
    const to = prefersReducedMotion() ? undefined : originFrame()
    dimTo(0, to ? tuning.scrimClose() : fade())

    if (!to) {
      plain = true

      return run()
    }

    // A close mid-open turns the flight around where it is, keeping its velocity.
    course ??= { at: place(fitted()), flight: createFlight(restFrame()), landed: showOrigin }
    course.flight.to(to, tuning.closeKick(), tuning.close())
    course.landed = showOrigin
    hideOrigin()
    paint()
    setStage("flying")
    run()
  }

  const dimTo = (target: number, spring: DurationOptions) => {
    dim.omega = (2 * Math.PI) / spring.duration
    dim.zeta = 1 - spring.bounce
    dim.set(target)
  }

  // One job on the shared frame loop steps the flight and the backdrop together and writes them straight to the DOM.
  const run = () => {
    stop ??= frameLoop.add((dt) => {
      const flying = course?.flight.step(dt)
      dim.step(dt)
      paint()

      // The real image takes over only once the panel holding it is fully opaque, so its brightness doesn't step.
      if (course && !flying && dim.resting) {
        const landed = course.landed
        course = undefined
        landed()
      }

      if (course || !dim.resting) return true
      stop = undefined

      return false
    })
  }

  const paint = () => {
    scrim.style.opacity = String(dim.value)
    content.style.opacity = String(plain ? dim.value : dim.value ** 2)
    standIn.style.opacity = String(plain ? dim.value : 1)

    if (!course) return
    const style = flightStyle(course.at, course.flight.frame())
    standIn.style.transform = style.transform
    standIn.style.clipPath = style.clipPath
  }

  const place = (box: Box) => {
    Object.assign(standIn.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    })

    return box
  }

  // The image as shown now: zoomed and panned, and cropped to the viewport.
  const restFrame = (): FlightFrame => {
    const shown = image.getBoundingClientRect()
    const clip = intersect(shown, viewport.getBoundingClientRect())
    const cropped = clip.width < shown.width - 0.5 || clip.height < shown.height - 0.5

    return {
      image: shown,
      clip,
      radius: cropped ? 0 : parseFloat(getComputedStyle(image).borderTopLeftRadius) * view().scale,
    }
  }

  // The origin's frame, or nothing when it is gone or scrolled out of sight.
  const originFrame = () => {
    const origin = props.origin

    if (!origin?.isConnected || !image.naturalWidth) return
    const rect = origin.getBoundingClientRect()

    if (!rect.width || !rect.height) return

    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return
    const style = getComputedStyle(origin)

    return elementFrame(
      rect,
      { width: image.naturalWidth, height: image.naturalHeight },
      style.objectFit,
      parseFloat(style.borderTopLeftRadius) || 0,
    )
  }

  // The image's fitted layout box, wherever zoom has moved it.
  const fitted = (): Box => {
    const shown = image.getBoundingClientRect()

    return {
      x: shown.x + shown.width / 2 - view().x - image.offsetWidth / 2,
      y: shown.y + shown.height / 2 - view().y - image.offsetHeight / 2,
      width: image.offsetWidth,
      height: image.offsetHeight,
    }
  }

  const hideOrigin = () => props.origin?.setAttribute("data-image-preview-origin", "")
  const showOrigin = () => props.origin?.removeAttribute("data-image-preview-origin")

  onCleanup(() => {
    stop?.()
    showOrigin()
  })

  createEffect(
    on(
      () => dialog.isOpen(),
      (open) => {
        if (!open) dismiss()
      },
      { defer: true },
    ),
  )

  const point = (event: MouseEvent) => {
    const rect = viewport.getBoundingClientRect()

    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
  }

  const measure = () => {
    if (!image.naturalWidth) return
    setFitRatio(image.offsetWidth / image.naturalWidth)
    follow(clampView(view(), bounds()))
  }

  createResizeObserver(() => [viewport, image], measure)

  createEffect(
    on(
      () => props.src,
      () => follow(FIT_VIEW),
      { defer: true },
    ),
  )

  onCleanup(() => animation?.stop())

  // The preview owns zoom gestures while it is open: the page behind must neither scroll nor zoom the whole window.
  makeEventListener(
    window,
    "wheel",
    (event: WheelEvent) => {
      const inside = event.target instanceof Node && viewport.contains(event.target)
      const zoom = event.ctrlKey || event.metaKey

      if (!inside && !zoom) return
      event.preventDefault()
      event.stopPropagation()

      if (!inside) return
      const current = view()

      if (zoom) {
        follow(zoomAt(current, current.scale * wheelZoomFactor(pixels(event, event.deltaY)), point(event), bounds()))

        return
      }

      const horizontal = event.shiftKey && event.deltaX === 0
      follow(
        panBy(
          current,
          {
            x: -pixels(event, horizontal ? event.deltaY : event.deltaX),
            y: horizontal ? 0 : -pixels(event, event.deltaY),
          },
          bounds(),
        ),
      )
    },
    { passive: false, capture: true },
  )

  // Captured ahead of the desktop shell, which zooms the whole window on the same shortcuts.
  makeEventListener(
    window,
    "keydown",
    (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const action = shortcut(event.key)

      if (!action) return
      event.preventDefault()
      event.stopPropagation()

      if (action === "fit") return ease(FIT_VIEW)
      step(action === "in" ? STEP : 1 / STEP)
    },
    { capture: true },
  )

  return (
    <div data-component="image-preview" data-stage={stage()} style={{ "--image-preview-exit": `${exit()}ms` }}>
      <div ref={scrim} data-slot="image-preview-scrim" />
      <div data-slot="image-preview-container">
        <Kobalte.Content
          ref={content}
          data-slot="image-preview-content"
          onOpenAutoFocus={(event) => {
            // Open with focus on Close, as before, rather than on the zoom controls that now precede it.
            event.preventDefault()
            close?.focus()
          }}
        >
          <div data-slot="image-preview-header">
            <div data-slot="image-preview-zoom">
              <IconButton
                data-slot="image-preview-zoom-out"
                icon={<Icon name="minus" />}
                variant="ghost"
                aria-label={i18n.t("ui.imagePreview.zoomOut")}
                onClick={() => step(1 / STEP)}
              />
              <Button
                data-slot="image-preview-zoom-level"
                variant="ghost-muted"
                size="small"
                aria-label={i18n.t("ui.imagePreview.zoomToFit")}
                title={i18n.t("ui.imagePreview.zoomToFit")}
                onClick={() => ease(FIT_VIEW)}
              >
                {percent().format(view().scale * fitRatio())}
              </Button>
              <IconButton
                data-slot="image-preview-zoom-in"
                icon={<Icon name="plus" />}
                variant="ghost"
                aria-label={i18n.t("ui.imagePreview.zoomIn")}
                onClick={() => step(STEP)}
              />
            </div>
            <Kobalte.CloseButton
              ref={close}
              data-slot="image-preview-close"
              as={IconButton}
              icon={<Icon name="close" />}
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div
            ref={viewport}
            data-slot="image-preview-body"
            data-zoomed={view().scale > 1 ? "" : undefined}
            data-dragging={drag() ? "" : undefined}
            onDblClick={(event) => {
              if (goal.scale > 1) return ease(FIT_VIEW)
              ease(zoomAt(goal, detailScale(fitRatio()), point(event), bounds()))
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || view().scale <= 1) return
              event.preventDefault()
              viewport.setPointerCapture(event.pointerId)
              setDrag({ id: event.pointerId, x: event.clientX, y: event.clientY })
            }}
            onPointerMove={(event) => {
              const current = drag()

              if (current?.id !== event.pointerId) return
              setDrag({ id: current.id, x: event.clientX, y: event.clientY })
              follow(panBy(view(), { x: event.clientX - current.x, y: event.clientY - current.y }, bounds()))
            }}
            onPointerUp={(event) => {
              if (drag()?.id === event.pointerId) setDrag(undefined)
            }}
            onPointerCancel={(event) => {
              if (drag()?.id === event.pointerId) setDrag(undefined)
            }}
          >
            <img
              ref={image}
              src={props.src}
              alt={props.alt ?? i18n.t("ui.imagePreview.alt")}
              data-slot="image-preview-image"
              draggable={false}
              onLoad={() => {
                measure()
                void reveal()
              }}
              onError={() => void reveal()}
              style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().scale})` }}
            />
          </div>
        </Kobalte.Content>
      </div>
      <img data-slot="image-preview-flight" src={props.src} alt="" aria-hidden="true" ref={standIn} />
    </div>
  )
}

// Dialogs of the mounted surfaces that can show a preview; the Motion workspace's buttons use the newest.
const replayers: ReturnType<typeof useDialog>[] = []

let removeReplay: (() => void) | undefined

/**
 * Adds buttons to the Motion workspace's Image open section while any caller is mounted: they open the newest image in
 * view, or a sample thumbnail when there is none, and close the preview, also mid-flight.
 */
export function replayImagePreview() {
  const dialog = useDialog()
  replayers.push(dialog)
  removeReplay ??= addReplayActions()

  onCleanup(() => {
    replayers.splice(replayers.indexOf(dialog), 1)

    if (replayers.length > 0) return
    removeReplay?.()
    removeReplay = undefined
  })
}

function addReplayActions() {
  const open = () => {
    const image = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-slot="user-message-attachment"][data-type="image"], img[aria-haspopup="dialog"]',
      ),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect()

        return rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight
      })
      .at(-1)

    if (image) return image.click()
    const sample = document.createElement("img")
    sample.src = SAMPLE
    sample.alt = "Sample image"
    sample.style.cssText =
      "position: fixed; left: 24px; bottom: 24px; z-index: 40; width: 160px; height: 100px; object-fit: cover; border-radius: 8px;"
    document.body.append(sample)
    replayers.at(-1)?.show(
      () => <ImagePreview src={SAMPLE} alt={sample.alt} origin={sample} />,
      () => setTimeout(() => sample.remove(), exitDuration() + 100),
    )
  }

  const close = () => {
    if (document.querySelector('[data-component="image-preview"]')) replayers.at(-1)?.close()
  }

  const removals = [
    motionTuning.action({ id: "imagePreview.open", label: "Open", group, run: open }),
    motionTuning.action({ id: "imagePreview.close", label: "Close", group, run: close }),
    motionTuning.action({
      id: "imagePreview.reverse",
      label: "Open, close mid-flight",
      group,
      run: () => {
        open()
        const start = performance.now()

        // The flight starts once the image has decoded; close a little way into it.
        const wait = () => {
          if (document.querySelector('[data-component="image-preview"][data-stage="flying"]'))
            return void setTimeout(close, tuning.open().duration * 350)

          if (performance.now() - start < 2000) requestAnimationFrame(wait)
        }

        requestAnimationFrame(wait)
      },
    }),
  ]

  return () => removals.forEach((remove) => remove())
}

const SAMPLE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="sky" x2="0" y2="1"><stop offset="0" stop-color="#ff8a5b"/><stop offset="1" stop-color="#ffd27a"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#sky)"/><circle cx="1120" cy="360" r="170" fill="#fff4d6"/><path d="M0 1000V720Q400 580 800 720T1600 700V1000Z" fill="#2f7d48"/></svg>',
)}`

function shortcut(key: string) {
  if (key === "=" || key === "+") return "in"

  if (key === "-" || key === "_") return "out"

  if (key === "0") return "fit"
}

function pixels(event: WheelEvent, delta: number) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * window.innerHeight

  return delta
}
