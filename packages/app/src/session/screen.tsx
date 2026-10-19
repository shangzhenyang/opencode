import {
  ErrorBoundary,
  For,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  on,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Slot, type BackgroundTask, type MountedSession, type SessionScreen } from "@opencode/gui-extensions/sdk"
import { MessageTimeline } from "@/session/timeline/message-timeline"
import { ComposerDropzone } from "@/composer/dropzone"
import { useSettings } from "@/settings/model"
import type { SessionModel } from "@/session/model"
import { SESSION_PANEL_WIDTH_MIN } from "@/session/session-panel-width"
import { SessionPanelFrame } from "@/session/session-frame"
import { useExtensionHost } from "@/runtime/extension/host"
import { ExtensionLinks } from "@/runtime/extension/render"
import { createPanelSidebar, createRegion, MobilePanel } from "@/runtime/extension/panels"
import { createMobileViews, MobileViewTabs } from "@/runtime/extension/mobile"
import { useExtensionAttachment } from "@/runtime/extension/host-apis"
import { createMountedSession } from "@/runtime/extension/mounted-session"
import { useUsageExceededDialogs } from "./usage-exceeded-dialogs"
import { SessionErrorFallback } from "./route-error"
import { createSessionScreenLayout } from "./screen-layout"
import { SideRegion } from "@/runtime/extension/side-region"
import { createSessionTimelineInteraction } from "./timeline/interaction"
import { createTimelineSearchController } from "./timeline/search-controller"
import { TimelineSearchBar } from "./timeline/search-bar"
import { ActiveSessionComposerRegion, createActiveSessionRegion } from "./composer/region"
import { SessionIdentityHeader } from "./session-identity-header"
import { SessionReviewToggle } from "./header/session-header-actions"
import { createPanelMotion, panelSprings, replayPanelToggle } from "@/shell/panel-motion"
import { createTimelineCache } from "./timeline/cache"

export function SessionScreenView(props: { session: SessionModel }) {
  // The timeline cache captures its owner when created, so link handling must be provided above it.
  const mounted = createMountedSession(props.session)

  return (
    <ExtensionLinks session={mounted.view()}>
      <SessionScreenContent
        session={props.session}
        screen={mounted.screen}
        view={mounted.view}
        bindBackground={mounted.bindBackground}
      />
    </ExtensionLinks>
  )
}

function SessionScreenContent(props: {
  session: SessionModel
  /** One object per routed session; renders receive each through a reactive prop instead of remounting. */
  view: Accessor<MountedSession>
  screen: SessionScreen
  bindBackground: (tasks: () => readonly BackgroundTask[]) => void
}) {
  const session = props.session
  const host = useExtensionHost()
  const attachment = useExtensionAttachment()
  const settings = useSettings()
  const isDesktop = session.isDesktop
  const bottomMobileTabs = () => settings.general.mobileTitlebarPosition() === "bottom"
  const sidebar = createPanelSidebar()

  const region = createRegion({
    region: "side",
    view: props.view,
    screen: props.screen,
    tabs: session.layout.tabs,
  })

  onCleanup(attachment.region(region))
  const mobile = createMobileViews()

  const screen = createSessionScreenLayout(session, {
    wide: region.wide,
    sidebar: () => host.items(Slot).some((item) => item.value.at === "session.panel.sidebar"),
  })

  const timeline = createSessionTimelineInteraction(session)

  const timelineSearch = createTimelineSearchController({
    sessionID: session.identity.sessionID,
    scrollRef: timeline.scroller,
    revealMessage: timeline.actions.revealMessage,
    pauseAutoScroll: timeline.view.unpin,
  })

  const messagesReady = timeline.ready

  const [store, setStore] = createStore<{
    timelineScrollbarHidden: boolean
    sideRegionPresent: boolean
    sideTabsPresent: boolean
    mobileCached: string[]
  }>({
    timelineScrollbarHidden: false,
    sideRegionPresent: false,
    sideTabsPresent: false,
    mobileCached: [],
  })

  const sideVisible = createMemo(() => isDesktop() && screen.side.open())

  // The chat keeps its open width as the far end of a close's travel.
  const chatOpenWidth = createMemo<string>((previous) => (sideVisible() ? screen.panel.width() : previous), "100%")
  let chat: HTMLDivElement | undefined

  const sideMotion = createPanelMotion({
    open: sideVisible,
    spring: panelSprings.side,
    identity: session.layout.tabKey,
    // The chat's real width moves the side panel's edge, whose contents keep their open width pinned to it.
    paint: (closed) => {
      if (!chat) return
      const open = chatOpenWidth()

      if (closed === 1) {
        chat.style.width = "100%"

        return
      }

      chat.style.width = closed === 0 ? open : `calc(${open} + (100% - ${open}) * ${closed})`
    },
    onClosed: () => {
      setStore("sideRegionPresent", false)
      setStore("sideTabsPresent", false)
    },
  })

  replayPanelToggle({
    id: "sidePanel",
    group: "Side panel",
    toggle: () => session.layout.view().side.toggle(),
    spring: panelSprings.side,
  })

  const sideFileTree = createMemo<boolean>((previous) => (sideVisible() ? screen.files.open() : previous), false)

  const hideTimelineScrollbar = () => setStore("timelineScrollbarHidden", true)

  const revealTimelineScrollbar = (event: Event) => {
    if (!store.timelineScrollbarHidden) return

    if (!(event.target instanceof Element) || !event.target.closest('[data-slot="session-timeline-scroll"]')) return
    setStore("timelineScrollbarHidden", false)
  }

  createEffect(() => {
    if (screen.side.open()) setStore("sideRegionPresent", true)

    if (screen.side.tabs.open()) setStore("sideTabsPresent", true)
  })

  const mobileView = attachment.mobile.current

  const mobileEntry = createMemo(() => {
    const key = mobileView()

    return key === "session" ? undefined : mobile.find(key)
  })

  const conversationVisible = createMemo(() => isDesktop() || mobileView() === "session")

  // Narrow-screen views that ask to stay mounted once shown, e.g. a terminal that keeps its shell's screen.
  createEffect(() => {
    const entry = mobileEntry()

    if (isDesktop() || !entry?.mobile.cached || store.mobileCached.includes(entry.key)) return
    setStore("mobileCached", (keys) => [...keys, entry.key])
  })

  const cachedViews = createMemo(() => store.mobileCached.flatMap((key) => mobile.find(key) ?? []))

  const composer = createActiveSessionRegion({
    session,
    screen,
    timeline,
    region,
    visible: conversationVisible,
  })

  props.bindBackground(composer.requests.background.tasks)
  useUsageExceededDialogs()

  const sessionErrorFallback = (cause: unknown, reset: () => void) => {
    createEffect(on(session.identity.sessionKey, reset, { defer: true }))

    return <SessionErrorFallback error={cause} sessionID={session.identity.params.id} />
  }

  const timelineView = createTimelineCache(
    session,
    (source, active) => {
      // A cached timeline keeps its own session's latest object while another session is routed.
      const own = createMemo<MountedSession>((previous) => {
        const view = props.view()

        return view.id === source.identity.sessionID() ? view : previous
      }, untrack(props.view))

      return (
        <MessageTimeline
          active={active()}
          hideHeader={!isDesktop()}
          session={source}
          view={own()}
          screen={props.screen}
          background={composer.requests.background}
          actions={composer.actions.timeline}
          scroll={timeline.scroll}
          onResumeScroll={timeline.actions.resume}
          setScrollRef={timeline.view.setScrollRef}
          onScheduleScrollState={timeline.view.scheduleScrollState}
          onPin={timeline.view.pin}
          onUnpin={timeline.view.unpin}
          onUserScroll={timeline.view.markUserScroll}
          onHistoryScroll={timeline.view.onHistoryScroll}
          onSelectionInteraction={timeline.view.selectionInteraction}
          pinned={timeline.view.pinned()}
          centered={screen.centered()}
          reserveReviewToggle={!sideVisible()}
          setContentRef={timeline.view.setContentRef}
          anchor={timeline.view.anchor}
          setRevealMessage={timeline.view.setRevealMessage}
          setRevealPart={timeline.view.setRevealPart}
          reveal={timeline.view.reveal}
          setScrollToEnd={timeline.view.setScrollToEnd}
          search={
            <Show when={active()}>
              <TimelineSearchBar controller={timelineSearch} />
            </Show>
          }
        />
      )
    },
    () => conversationVisible() && messagesReady(),
  )

  const mobileTabs = () => (
    <Show when={session.identity.sessionKey()} keyed>
      {(_key) => (
        <MobileViewTabs
          bottom={bottomMobileTabs()}
          screen={props.screen}
          views={mobile}
          region={region}
          current={mobileView()}
          session={props.view()}
          sidebar={sidebar}
          onSelect={attachment.mobile.select}
        />
      )}
    </Show>
  )

  const sessionPanelContent = () => (
    <>
      <ComposerDropzone
        active={composer.drop.active()}
        input={composer.drop.input()}
        identity={session.layout.tabKey}
      />
      <Show when={!isDesktop() && !!session.identity.params.id && !bottomMobileTabs()}>{mobileTabs()}</Show>
      {/* Surface query errors without suspending session metadata while messages load. */}
      <Show when={timeline.resource.error}>
        {(error) => {
          throw error()
        }}
      </Show>
      <div class="relative flex-1 min-h-0 overflow-hidden">
        <Show when={!isDesktop() && session.identity.params.id}>
          <For each={cachedViews()}>
            {(entry) => (
              <div
                class="absolute inset-0"
                classList={{ invisible: mobileView() !== entry.key }}
                inert={mobileView() !== entry.key || undefined}
              >
                <MobilePanel
                  screen={props.screen}
                  entry={entry}
                  view={props.view()}
                  sidebar={sidebar}
                  visible={mobileView() === entry.key}
                  open={() => region.openFor(entry.extension)}
                />
              </div>
            )}
          </For>
        </Show>
        <Switch>
          <Match when={!isDesktop() && mobileEntry()?.mobile.cached}>
            <></>
          </Match>
          <Match when={!isDesktop() && session.identity.params.id ? mobileEntry() : undefined}>
            {(entry) => (
              <MobilePanel
                screen={props.screen}
                entry={entry()}
                view={props.view()}
                sidebar={sidebar}
                visible
                open={() => region.openFor(entry().extension)}
              />
            )}
          </Match>
          <Match when={session.identity.params.id}>
            <Show when={isDesktop() && !messagesReady()}>
              <SessionIdentityHeader sessionID={session.identity.params.id ?? ""} session={session.data.info()} />
            </Show>
            <Show when={messagesReady() && session.identity.params.id}>{timelineView()}</Show>
          </Match>
        </Switch>
      </div>

      <Show when={composer.active()} keyed>
        {(model) => (
          <ActiveSessionComposerRegion
            session={session}
            model={model}
            suggestionBoundary={timeline.scroller}
            onReveal={timeline.actions.revealPart}
          />
        )}
      </Show>
      <Show when={!isDesktop() && !!session.identity.params.id && bottomMobileTabs()}>{mobileTabs()}</Show>
    </>
  )

  return (
    <>
      <div class="flex-1 min-h-0 flex flex-col gap-2 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
        <div ref={screen.panel.ref} class="relative flex-1 min-h-0 flex flex-col md:flex-row gap-2">
          {/* Keep the control outside panel animations. */}
          <Show when={isDesktop() && messagesReady() && session.identity.params.id}>
            <div
              class="absolute end-3 top-0 z-30 h-12 flex items-center"
              data-slot="session-review-toggle"
              onPointerDown={hideTimelineScrollbar}
              onClick={hideTimelineScrollbar}
            >
              <SessionReviewToggle />
            </div>
          </Show>
          <div
            ref={chat}
            class="@container relative z-10 min-w-0 shrink-0 flex flex-col min-h-0 h-full flex-1 md:flex-none"
            data-slot="session-chat-panel"
            data-scrollbar-hidden={store.timelineScrollbarHidden}
            onPointerMove={revealTimelineScrollbar}
            onPointerDown={revealTimelineScrollbar}
            on:wheel={{ passive: true, handleEvent: revealTimelineScrollbar }}
            onKeyDown={revealTimelineScrollbar}
          >
            <Show when={!!session.identity.params.id}>
              <SessionPanelFrame raised>
                <ErrorBoundary fallback={sessionErrorFallback}>{sessionPanelContent()}</ErrorBoundary>
              </SessionPanelFrame>
            </Show>

            <Show when={screen.panel.resizable()}>
              <div onPointerDown={() => screen.size.start()}>
                <ResizeHandle
                  class="-end-1"
                  direction="horizontal"
                  size={screen.panel.resizedWidth()}
                  min={SESSION_PANEL_WIDTH_MIN}
                  max={screen.panel.max()}
                  onResize={(width) => {
                    screen.size.touch()
                    session.layout.view().session.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>

          <Show when={sideMotion.present() || store.sideTabsPresent}>
            <div
              data-slot="session-side-panel-presence"
              classList={{
                "relative z-0 min-w-0 h-full flex-1 overflow-visible": sideMotion.present(),
                "absolute inset-y-0 end-0 z-0 w-0 invisible pointer-events-none overflow-visible":
                  !sideMotion.present(),
              }}
            >
              <div
                data-slot="session-side-panel-content"
                class="absolute inset-y-0 start-0 size-full"
                style={{ "--session-side-content-width": screen.side.contentWidth() }}
              >
                <div data-slot="session-side-region" class="absolute inset-0 min-h-0 overflow-visible">
                  <Show when={store.sideRegionPresent}>
                    <div
                      data-slot="session-side-region-presence"
                      class="absolute inset-0"
                      classList={{ invisible: !sideMotion.present() }}
                    >
                      <SideRegion
                        screen={props.screen}
                        view={props.view()}
                        region={region}
                        sidebar={sidebar}
                        fileTree={sideFileTree()}
                        present={store.sideTabsPresent}
                        size={screen.size}
                      />
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </>
  )
}
