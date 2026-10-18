import { Dialog as Kobalte, useDialogContext } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { animate, type AnimationPlaybackControls } from "motion"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useDialogLayer } from "../context/dialog"
import { useI18n } from "../context/i18n"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { elementFrame, flightKeyframes, intersect, lerpFrame, type Box, type FlightFrame } from "./image-flight"
import { clampView, detailScale, FIT_VIEW, maxScale, panBy, wheelZoomFactor, zoomAt, type ZoomView } from "./image-zoom"

export interface ImagePreviewProps {
  src: string
  alt?: string
  /** The image on the page that the preview grows out of and shrinks back into. */
  origin?: HTMLElement
}

const STEP = Math.SQRT2

// Matched to Claude's desktop preview, measured frame by frame: a strong ease-out with no overshoot, and a close
// about a third shorter than the open. The backdrop dims over the same time on a gentler curve.
const OPEN = 280

const CLOSE = 180

const FLIGHT_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)"

const FADE = 150

// How long the dialog stays mounted after a close starts, with a few frames' slack for the flight to land.
const EXIT = CLOSE + 50

const CENTER = { x: 0, y: 0 }

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  const dialog = useDialogContext()
  let scrim!: HTMLDivElement
  let content!: HTMLDivElement
  let viewport!: HTMLDivElement
  let image!: HTMLImageElement
  let flight!: HTMLImageElement
  let close: HTMLButtonElement | undefined
  // Nothing shows until the image has loaded and the preview knows where it lands; while flying, a stand-in image
  // travels above the dialog in place of the real one.
  const [stage, setStage] = createSignal<"pending" | "flying" | "rest">("pending")
  // The latest flight: where the stand-in is laid out (the flight only transforms and clips it), and its two ends.
  let course: { at: Box; from: FlightFrame; to: FlightFrame; animation: Animation } | undefined
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

    if (reduced()) return setView(target)
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
  useDialogLayer()?.setExitDuration(EXIT)

  const reveal = async () => {
    await Promise.all([image.decode(), flight.decode()]).catch(() => undefined)

    if (stage() !== "pending" || !dialog.isOpen()) return
    const from = reduced() ? undefined : originFrame()

    // Fade from the hidden pending state before leaving it. The panel settles in around the image as it lands.
    fade(content, 1, from ? OPEN * 0.6 : FADE, from ? OPEN * 0.4 : 0)
    fade(scrim, 1, from ? OPEN : FADE)

    if (!from) return setStage("rest")
    const at = place(fitted())
    hideOrigin()
    setStage("flying")
    void fly(at, from, restFrame(), OPEN).then((done) => done && setStage("rest"))
  }

  const dismiss = () => {
    animation?.stop()

    if (stage() === "pending") return
    const to = reduced() ? undefined : originFrame()

    // The panel clears before the image leaves it.
    fade(content, 0, to ? CLOSE / 2 : FADE)
    fade(scrim, 0, to ? CLOSE : FADE)

    if (!to) {
      // A stand-in still opening keeps its course as it fades.
      flight.animate({ opacity: [1, 0] }, { duration: FADE, easing: "ease", fill: "both" })
      content.animate({ transform: ["none", "scale(0.96)"] }, { duration: FADE, easing: "ease", fill: "both" })

      return
    }

    // A close mid-open turns around from the frame on screen.
    const turning = stage() === "flying" ? course : undefined
    const progress = turning?.animation.effect?.getComputedTiming().progress
    const from = turning && progress != null ? lerpFrame(turning.from, turning.to, progress) : restFrame()
    const at = turning?.at ?? place(fitted())
    hideOrigin()
    setStage("flying")
    void fly(at, from, to, CLOSE).then((done) => done && showOrigin())
  }

  const place = (box: Box) => {
    Object.assign(flight.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    })

    return box
  }

  const fly = (at: Box, from: FlightFrame, to: FlightFrame, duration: number) => {
    cancel(flight)
    const animation = flight.animate(flightKeyframes(at, from, to), { duration, easing: FLIGHT_EASING, fill: "both" })
    course = { at, from, to, animation }

    return animation.finished.then(
      () => true,
      () => false,
    )
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

  onCleanup(showOrigin)

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
    <div data-component="image-preview" data-stage={stage()} style={{ "--image-preview-exit": `${EXIT}ms` }}>
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
      <img data-slot="image-preview-flight" src={props.src} alt="" aria-hidden="true" ref={flight} />
    </div>
  )
}

function reduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Animates opacity from wherever an earlier fade left the element. */
function fade(element: HTMLElement, opacity: number, duration: number, delay = 0) {
  const from = getComputedStyle(element).opacity

  cancel(element)
  element.animate({ opacity: [from, String(opacity)] }, { duration, delay, easing: "ease", fill: "both" })
}

/** Stops this preview's own animations, leaving CSS ones such as the content's exit hold to Kobalte. */
function cancel(element: HTMLElement) {
  element
    .getAnimations()
    .filter((running) => !(running instanceof CSSAnimation))
    .forEach((running) => running.cancel())
}

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
