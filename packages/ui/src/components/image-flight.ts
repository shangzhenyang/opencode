/**
 * Geometry for flying a preview image between its place on the page and the open preview.
 *
 * The flying image is laid out once at `base` and only ever transformed, so the flight runs on transform and
 * clip-path alone. A frame says where the whole image would be drawn (`image`, always the image's own aspect ratio),
 * which part of it shows (`clip`), and the corner radius of that visible part, all in viewport pixels.
 */
export type Box = { x: number; y: number; width: number; height: number }

export type FlightFrame = { image: Box; clip: Box; radius: number }

/** Where an element draws its whole image for an `object-fit`, centered as with the default `object-position`. */
export function fittedImage(box: Box, natural: { width: number; height: number }, fit: string): Box {
  const ratio = natural.width / natural.height

  // `fill` stretches the image; the flight keeps its aspect ratio, so it covers the box instead.
  const contain = fit === "contain" || fit === "scale-down"
  const wide = box.width / box.height > ratio
  const width = contain === wide ? box.height * ratio : box.width
  const height = contain === wide ? box.height : box.width / ratio

  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  }
}

/** The frame of an element showing an image, cropped to the element's box. */
export function elementFrame(box: Box, natural: { width: number; height: number }, fit: string, radius: number) {
  const image = fittedImage(box, natural, fit)

  return { image, clip: intersect(image, box), radius }
}

/**
 * Keyframes for a flight from one frame to another. The clip and radius live in the image's own coordinates, which
 * shrink with it, so a straight interpolation between the two ends would bulge them mid-flight; sampling the screen-space
 * path keeps the visible corners and crop moving evenly.
 */
export function flightKeyframes(base: Box, from: FlightFrame, to: FlightFrame, steps = 16) {
  return Array.from({ length: steps + 1 }, (_, index) => flightStyle(base, lerpFrame(from, to, index / steps)))
}

export function lerpFrame(from: FlightFrame, to: FlightFrame, progress: number): FlightFrame {
  return {
    image: lerpBox(from.image, to.image, progress),
    clip: lerpBox(from.clip, to.clip, progress),
    radius: lerp(from.radius, to.radius, progress),
  }
}

/** Styles that move an image laid out at `base` to `frame`, with `transform-origin: 0 0`. */
export function flightStyle(base: Box, frame: FlightFrame) {
  const scale = frame.image.width / base.width
  const top = (frame.clip.y - frame.image.y) / scale
  const right = (frame.image.x + frame.image.width - frame.clip.x - frame.clip.width) / scale
  const bottom = (frame.image.y + frame.image.height - frame.clip.y - frame.clip.height) / scale
  const left = (frame.clip.x - frame.image.x) / scale

  return {
    transform: `translate(${frame.image.x - base.x}px, ${frame.image.y - base.y}px) scale(${scale})`,
    clipPath: `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${px(frame.radius / scale)})`,
  }
}

export function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)

  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  }
}

function lerpBox(from: Box, to: Box, progress: number): Box {
  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
    width: lerp(from.width, to.width, progress),
    height: lerp(from.height, to.height, progress),
  }
}

function lerp(from: number, to: number, progress: number) {
  return from * (1 - progress) + to * progress
}

function px(value: number) {
  return `${Math.max(0, Math.round(value * 100) / 100)}px`
}
