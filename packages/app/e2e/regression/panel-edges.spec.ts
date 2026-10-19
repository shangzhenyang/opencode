import { expect, test, type Locator, type Page } from "@playwright/test"
import { seed, sessionHref } from "../utils/app"
import { fixture, installStressSessionTabs, mockStressTimeline } from "../utils/session-fixture"

test.use({ viewport: { width: 1440, height: 900 } })

// Samples every frame of a click toggle: the moving edge, and the gap from the element before it to the one after.
async function trace(page: Page, toggle: Locator, before: string, after: string) {
  const frames = page.evaluate(
    ([before, after]) =>
      new Promise<{ edge: number; gap?: number }[]>((resolve) => {
        const start = performance.now()
        const out: { edge: number; gap?: number }[] = []

        const tick = (now: number) => {
          const a = document.querySelector(before)?.getBoundingClientRect()
          const b = document.querySelector(after)?.getBoundingClientRect()

          out.push({ edge: (a ?? b)!.right, gap: a && b && b.left - a.right })

          if (now - start < 700) return requestAnimationFrame(tick)
          resolve(out)
        }

        requestAnimationFrame(tick)
      }),
    [before, after] as const,
  )

  await toggle.click({ force: true })

  return frames
}

test("the content beside a panel follows the panel's edge on every frame of a toggle", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await seed(page, { settings: { appearance: { tabLayout: "vertical", sidebarOpen: true } } })
  await page.goto(sessionHref(fixture.targetID))
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()

  const sidebar = page
    .locator(
      '[data-slot="vertical-tabs-sidebar"] button[aria-controls="vertical-tabs-sidebar"], main button[aria-controls="vertical-tabs-sidebar"]',
    )
    .locator("visible=true")
    .first()

  const review = page.locator('[data-slot="session-review-toggle"] button')

  const runs = [
    { toggle: sidebar, before: '[data-slot="vertical-tabs-sidebar"] > div > div', after: "main", gap: 0 },
    { toggle: sidebar, before: '[data-slot="vertical-tabs-sidebar"] > div > div', after: "main", gap: 0 },
    { toggle: review, before: '[data-slot="session-chat-panel"]', after: "#review-panel", gap: 8 },
    { toggle: review, before: '[data-slot="session-chat-panel"]', after: "#review-panel", gap: 8 },
  ]

  for (const run of runs) {
    const frames = await trace(page, run.toggle, run.before, run.after)
    // The toggle animates over several frames rather than jumping to its end.
    expect(new Set(frames.map((frame) => Math.round(frame.edge))).size).toBeGreaterThan(3)
    frames.flatMap((frame) => frame.gap ?? []).forEach((gap) => expect(gap).toBeCloseTo(run.gap, 0))
  }
})
