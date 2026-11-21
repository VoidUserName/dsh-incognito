/**
 * Web Client implementation of the DeepSeek Harness Incognito Mode plugin (@local/dsh-incognito).
 *
 * Provides:
 * - Pre-conversation Incognito toggle in `conversation.input.left` (locked once conversation starts).
 * - Active Incognito status banner + "End & Destroy" action in `conversation.input.dock`.
 * - Header utility badge + quick exit button in `conversation.session.header.utilities`.
 * - Slash command `/incognito` UI decoration and post-command state synchronization.
 * - Client-side session list filtering, Hero workspace preservation while blank, `localStorage`
 *   hygiene, and automatic session destruction on session switch, cancel, or tab close/refresh.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-incognito',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useLayoutEffect } = React

    const DICT_ZH = {
      toggleOff: '无痕浏览',
      toggleOn: '无痕已开启',
      lockedActive: '无痕对话中（已锁定）',
      lockedDisabled: '无痕浏览（仅限对话前开启）',
      lockedDisabledTip: '无痕浏览只能在开始对话前选择，不可以对话到一半切换为无痕模式',
      preStartTipOff: '点击在开始对话前开启无痕浏览：内容不进历史、不写日志、其他插件不可读',
      preStartTipOn: '无痕浏览已就绪（发送首条消息后将锁定；点击可在对话开始前关闭）',
      bannerTitle: '无痕浏览已开启',
      bannerDescPre: '发送首条消息后将锁定无痕状态。当前对话绝不进入历史、不被其他插件读取、不写入 session log；取消或离开后立即销毁且无法恢复。',
      bannerDescLocked: '当前无痕对话已锁定：内容仅保存在隔离内存中，不写入任何历史或日志；切换会话、刷新页面或点击右侧按钮将立即永久销毁。',
      bannerHintPre: '发送首条消息后锁定 · 不进历史 · 不写日志',
      bannerHintLocked: '仅存于内存 · 不进历史 · 离开即销毁',
      endButton: '结束并销毁',
      endButtonTitle: '立即取消并永久销毁当前无痕对话（不可恢复）',
      destroyedNotice: '无痕会话已彻底销毁且无法恢复',
    }

    const DICT_EN = {
      toggleOff: 'Incognito',
      toggleOn: 'Incognito ON',
      lockedActive: 'Incognito (Locked)',
      lockedDisabled: 'Incognito (Pre-chat only)',
      lockedDisabledTip: 'Incognito mode can only be selected before starting a conversation',
      preStartTipOff: 'Enable Incognito Mode before starting the conversation: zero history, zero session log, hidden from all plugins',
      preStartTipOn: 'Incognito Mode is armed (locks upon first message; click to turn off before chatting)',
      bannerTitle: 'Incognito Mode Active',
      bannerDescPre: 'Locks once the first message is sent. Conversation never enters history or session logs, is unreadable by other plugins, and self-destructs on exit.',
      bannerDescLocked: 'Locked in Incognito Mode: held only in isolated memory with zero disk logs; switching sessions, refreshing, or clicking End permanently destroys it.',
      bannerHintPre: 'Locks on first message · No history · No logs',
      bannerHintLocked: 'Memory only · No history · Destroyed on exit',
      endButton: 'End & Destroy',
      endButtonTitle: 'Cancel and permanently destroy this incognito session (unrecoverable)',
      destroyedNotice: 'Incognito session permanently destroyed',
    }

    function IncognitoIcon({ size = 14 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': 'true',
          style: { flexShrink: 0, display: 'inline-block' },
        },
        // Sunglasses: frame bar, two filled lenses, and a bridge
        h('path', {
          d: 'M1.5 9.25h21',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', { d: 'M2.25 9.25h8.25v2.5a3.75 3.75 0 0 1-3.75 3.75h-.75a3.75 3.75 0 0 1-3.75-3.75z' }),
        h('path', { d: 'M13.5 9.25h8.25v2.5a3.75 3.75 0 0 1-3.75 3.75h-.75a3.75 3.75 0 0 1-3.75-3.75z' }),
        h('path', {
          d: 'M10.5 10.6q1.5-1 3 0',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    const SWITCH_ON_COLOR = '#3b82f6'
    const SWITCH_OFF_TRACK = '#e2e8f0'

    /**
     * Compact iOS-style switch: gray-white when off, blue when on.
     * @param {{ checked: boolean, disabled?: boolean }} props
     */
    function SwitchTrack({ checked }) {
      return h(
        'span',
        {
          'aria-hidden': 'true',
          style: {
            position: 'relative',
            display: 'inline-block',
            flexShrink: 0,
            width: '28px',
            height: '16px',
            borderRadius: '999px',
            background: checked ? SWITCH_ON_COLOR : SWITCH_OFF_TRACK,
            boxShadow: checked ? 'none' : 'inset 0 0 0 1px rgba(15, 23, 42, 0.06)',
            transition: 'background-color 0.2s ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: checked ? '14px' : '2px',
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            background: '#ffffff',
            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.25)',
            transition: 'left 0.2s ease',
          },
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const getService = (name) => {
          try {
            return ctx.get(name)
          } catch {
            return undefined
          }
        }

        // Register bilingual strings if locale service is present
        const registerLocale = (localeSvc) => {
          if (localeSvc && typeof localeSvc.register === 'function') {
            try {
              localeSvc.register('zh', { incognito: DICT_ZH })
              localeSvc.register('zh-CN', { incognito: DICT_ZH })
              localeSvc.register('en', { incognito: DICT_EN })
              localeSvc.register('en-US', { incognito: DICT_EN })
            } catch {
              // Ignore duplicate registration.
            }
          }
        }
        registerLocale(getService('locale'))
        ctx.inject?.(['locale'], (c) => registerLocale(c.locale))

        function tr(key) {
          const localeSvc = getService('locale')
          if (localeSvc && typeof localeSvc.t === 'function') {
            try {
              const val = localeSvc.t(`incognito.${key}`)
              if (typeof val === 'string' && val !== `incognito.${key}`) return val
            } catch {
              // Fall back to local dictionary.
            }
          }
          const lang = (typeof navigator !== 'undefined' && navigator.language) || 'zh'
          return lang.toLowerCase().startsWith('zh') ? DICT_ZH[key] : DICT_EN[key]
        }

        /**
         * Per-session status cache on the client:
         * `{ enabled: boolean, locked: boolean, destroyed: boolean, workspaceId?: string }`
         * @type {Map<string, { enabled: boolean, locked: boolean, destroyed: boolean, workspaceId?: string }>}
         */
        const statusBySession = new Map()
        const subscribers = new Set()
        let activeViewedSessionId = undefined
        let errorToastMessage = undefined
        let errorToastTimer = undefined

        function notifyClientSubscribers() {
          for (const fn of subscribers) {
            try {
              fn()
            } catch {
              // Ignore subscriber error.
            }
          }
        }

        function showTransientError(msg) {
          errorToastMessage = msg
          if (errorToastTimer !== undefined) clearTimeout(errorToastTimer)
          notifyClientSubscribers()
          errorToastTimer = setTimeout(() => {
            errorToastMessage = undefined
            notifyClientSubscribers()
          }, 4000)
        }

        /**
         * Purge browser `localStorage` keys that might reference an incognito sessionId.
         * @param {string} sessionId
         */
        function scrubBrowserStorage(sessionId) {
          if (typeof window === 'undefined' || !window.localStorage || !sessionId) return
          try {
            const current = window.localStorage.getItem('dsh.sessions.current')
            if (current && current.includes(sessionId)) {
              window.localStorage.removeItem('dsh.sessions.current')
            }
            for (let i = window.localStorage.length - 1; i >= 0; i--) {
              const key = window.localStorage.key(i)
              if (!key) continue
              if (key.includes(sessionId)) {
                window.localStorage.removeItem(key)
              }
            }
          } catch {
            // Ignore storage access restrictions.
          }
        }

        /**
         * Fetch current incognito status for `sessionId` from `/api/incognito`.
         * @param {string} sessionId
         */
        async function fetchSessionStatus(sessionId) {
          if (!sessionId) return undefined
          try {
            const res = await fetch(`/api/incognito?sessionId=${encodeURIComponent(sessionId)}`, {
              method: 'GET',
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            const data = await res.json()
            if (data && typeof data === 'object') {
              const prev = statusBySession.get(sessionId)
              const next = {
                enabled: Boolean(data.enabled),
                locked: Boolean(data.locked),
                destroyed: Boolean(data.destroyed),
                workspaceId: data.workspaceId ?? prev?.workspaceId,
              }
              if (next.destroyed) {
                statusBySession.delete(sessionId)
                scrubBrowserStorage(sessionId)
              } else {
                statusBySession.set(sessionId, next)
                if (next.enabled) scrubBrowserStorage(sessionId)
              }
              notifyClientSubscribers()
              return next
            }
          } catch {
            // Ignore network error.
          }
          return statusBySession.get(sessionId)
        }

        /**
         * Remember which workspace owns `sessionId` before Incognito detaches it on the Host,
         * so the Hero screen (`ConversationContent.tsx`) keeps its workspace chip while blank.
         * @param {string} sessionId
         * @returns {string | undefined}
         */
        function detectOwningWorkspaceId(sessionId) {
          try {
            const snap = getService('workspaces')?.list?.getSnapshot?.()
            const found = snap?.items?.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId))
            return found?.workspaceId
          } catch {
            return undefined
          }
        }

        /**
         * Call `/api/incognito` to mutate incognito status (`enable`, `disable`, `toggle`, `destroy`).
         * @param {string} sessionId
         * @param {'enable' | 'disable' | 'toggle' | 'destroy'} action
         * @param {string} [reason]
         */
        async function mutateIncognito(sessionId, action, reason) {
          if (!sessionId) return undefined
          const preWorkspaceId = detectOwningWorkspaceId(sessionId)
          try {
            const res = await fetch('/api/incognito', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ sessionId, action, reason }),
            })
            const data = await res.json()
            if (!res.ok || data?.ok === false) {
              if (data?.message) showTransientError(data.message)
              await fetchSessionStatus(sessionId)
              return undefined
            }
            const next = {
              enabled: Boolean(data.enabled),
              locked: Boolean(data.locked),
              destroyed: Boolean(data.destroyed || action === 'destroy'),
              workspaceId: data.workspaceId ?? preWorkspaceId ?? statusBySession.get(sessionId)?.workspaceId,
            }
            if (next.destroyed) {
              statusBySession.delete(sessionId)
              scrubBrowserStorage(sessionId)
            } else {
              statusBySession.set(sessionId, next)
              if (next.enabled) scrubBrowserStorage(sessionId)
            }
            notifyClientSubscribers()
            return next
          } catch (err) {
            showTransientError(err instanceof Error ? err.message : String(err))
            return undefined
          }
        }

        /**
         * Permanently destroy an incognito session and navigate the UI to a fresh blank session.
         * @param {string} sessionId
         * @param {string} [reason]
         */
        async function destroyAndLeaveIncognitoSession(sessionId, reason = 'user-end') {
          if (!sessionId) return
          const cached = statusBySession.get(sessionId)
          const wsId = cached?.workspaceId ?? detectOwningWorkspaceId(sessionId)
          statusBySession.delete(sessionId)
          scrubBrowserStorage(sessionId)
          notifyClientSubscribers()

          await mutateIncognito(sessionId, 'destroy', reason)

          // Open a fresh blank session so the destroyed session is immediately replaced in the viewport
          try {
            const uiWorkspace = getService('uiWorkspace')
            const sessionsSvc = getService('sessions')
            if (wsId && typeof uiWorkspace?.createWorkspaceSession === 'function') {
              await uiWorkspace.createWorkspaceSession(wsId)
              return
            }
            if (typeof sessionsSvc?.create === 'function') {
              const created = await sessionsSvc.create(wsId ? { workspaceId: wsId } : {})
              if (created?.sessionId && typeof uiWorkspace?.openSession === 'function') {
                uiWorkspace.openSession(created.sessionId)
              }
            }
          } catch {
            // Ignore navigation fallback error.
          }
        }

        // ============================================================================
        // Wrap Client `ctx.sessions` & `ctx.workspaces` for sidebar hiding & cancel hook
        // ============================================================================
        const wrappedClientServices = new WeakSet()

        function wrapClientSessions(sessionsSvc) {
          if (!sessionsSvc || wrappedClientServices.has(sessionsSvc)) return
          wrappedClientServices.add(sessionsSvc)

          if (sessionsSvc.list && typeof sessionsSvc.list.getSnapshot === 'function') {
            const origGetSnapshot = sessionsSvc.list.getSnapshot.bind(sessionsSvc.list)
            const origSubscribe = sessionsSvc.list.subscribe?.bind(sessionsSvc.list)
            let lastRawSnap = undefined
            let lastFilteredSnap = undefined

            sessionsSvc.list.getSnapshot = function incognitoFilteredListSnapshot() {
              const raw = origGetSnapshot()
              if (!raw || typeof raw !== 'object' || !raw.byId) return raw
              let needsFilter = false
              for (const id of Object.keys(raw.byId)) {
                const st = statusBySession.get(id)
                if (st?.enabled) {
                  needsFilter = true
                  break
                }
              }
              if (!needsFilter) {
                lastRawSnap = raw
                lastFilteredSnap = raw
                return raw
              }
              if (raw === lastRawSnap && lastFilteredSnap) {
                return lastFilteredSnap
              }
              const nextById = {}
              for (const [id, summary] of Object.entries(raw.byId)) {
                const st = statusBySession.get(id)
                if (st?.enabled) continue
                nextById[id] = summary
              }
              lastRawSnap = raw
              lastFilteredSnap = {
                ...raw,
                byId: nextById,
                ...(Array.isArray(raw.ids)
                  ? { ids: raw.ids.filter(id => Object.prototype.hasOwnProperty.call(nextById, id)) }
                  : {}),
              }
              return lastFilteredSnap
            }

            if (typeof origSubscribe === 'function') {
              sessionsSvc.list.subscribe = function incognitoFilteredListSubscribe(listener) {
                const unsubRaw = origSubscribe(listener)
                const unsubIncognito = () => {
                  lastRawSnap = undefined
                  lastFilteredSnap = undefined
                  listener()
                }
                subscribers.add(unsubIncognito)
                return () => {
                  unsubRaw()
                  subscribers.delete(unsubIncognito)
                }
              }
            }
          }

          if (typeof sessionsSvc.prompt === 'function') {
            const origPrompt = sessionsSvc.prompt.bind(sessionsSvc)
            sessionsSvc.prompt = async function incognitoGuardedClientPrompt(sessionId, ...rest) {
              const st = statusBySession.get(sessionId)
              if (st) {
                statusBySession.set(sessionId, { ...st, locked: true })
                notifyClientSubscribers()
              }
              return origPrompt(sessionId, ...rest)
            }
          }

          if (typeof sessionsSvc.cancel === 'function') {
            const origCancel = sessionsSvc.cancel.bind(sessionsSvc)
            sessionsSvc.cancel = async function incognitoGuardedClientCancel(sessionId, ...rest) {
              const st = statusBySession.get(sessionId)
              if (st?.enabled) {
                try {
                  await origCancel(sessionId, ...rest)
                } catch {
                  // Ignore if already destroyed by Host cancel interceptor.
                }
                await destroyAndLeaveIncognitoSession(sessionId, 'client-cancel')
                return
              }
              return origCancel(sessionId, ...rest)
            }
          }
        }

        function wrapClientWorkspaces(workspacesSvc) {
          if (!workspacesSvc || wrappedClientServices.has(workspacesSvc)) return
          wrappedClientServices.add(workspacesSvc)

          if (workspacesSvc.list && typeof workspacesSvc.list.getSnapshot === 'function') {
            const origWsGetSnapshot = workspacesSvc.list.getSnapshot.bind(workspacesSvc.list)
            let lastRawWsSnap = undefined
            let lastPatchedWsSnap = undefined

            workspacesSvc.list.getSnapshot = function incognitoPatchedWorkspaceSnapshot() {
              const raw = origWsGetSnapshot()
              if (!raw || !Array.isArray(raw.items)) return raw
              if (!activeViewedSessionId) return raw
              const st = statusBySession.get(activeViewedSessionId)
              if (!st?.enabled || st.locked || st.destroyed || !st.workspaceId) {
                return raw
              }
              if (raw === lastRawWsSnap && lastPatchedWsSnap) {
                return lastPatchedWsSnap
              }
              let modified = false
              const items = raw.items.map((ws) => {
                if (ws.workspaceId !== st.workspaceId) return ws
                if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(activeViewedSessionId)) {
                  return ws
                }
                modified = true
                return {
                  ...ws,
                  sessionIds: [activeViewedSessionId, ...(ws.sessionIds ?? [])],
                }
              })
              if (!modified) return raw
              lastRawWsSnap = raw
              lastPatchedWsSnap = { ...raw, items }
              return lastPatchedWsSnap
            }
          }
        }

        wrapClientSessions(getService('sessions'))
        ctx.inject?.(['sessions'], (c) => wrapClientSessions(c.sessions))
        wrapClientWorkspaces(getService('workspaces'))
        ctx.inject?.(['workspaces'], (c) => wrapClientWorkspaces(c.workspaces))

        // Destroy active incognito session when tab is closed or refreshed
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          const handlePageUnload = () => {
            for (const [id, st] of statusBySession.entries()) {
              if (st.enabled && !st.destroyed) {
                scrubBrowserStorage(id)
                const url = `/api/incognito?action=destroy&sessionId=${encodeURIComponent(id)}&reason=page-unload`
                if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
                  navigator.sendBeacon(
                    url,
                    new Blob([JSON.stringify({ sessionId: id, action: 'destroy', reason: 'page-unload' })], {
                      type: 'application/json',
                    }),
                  )
                } else {
                  fetch(url, { method: 'POST', keepalive: true }).catch(() => {})
                }
              }
            }
          }
          window.addEventListener('pagehide', handlePageUnload)
          window.addEventListener('beforeunload', handlePageUnload)
          ctx.effect(() => () => {
            window.removeEventListener('pagehide', handlePageUnload)
            window.removeEventListener('beforeunload', handlePageUnload)
          })
        }

        // Decorate `/incognito` slash command and synchronize after command execution
        const registerCommandUiDecoration = (commandUi) => {
          if (commandUi && typeof commandUi.decorate === 'function') {
            ctx.effect(() => commandUi.decorate({
              name: 'incognito',
              description: '开启、查询或结束无痕浏览（仅限对话开始前选择） / Toggle or end Incognito Mode',
            }))
          }
        }
        registerCommandUiDecoration(getService('commandUi'))
        ctx.inject?.(['commandUi'], (c) => registerCommandUiDecoration(c.commandUi))

        if (typeof ctx.on === 'function') {
          ctx.on('command/executed', (payload) => {
            if (payload?.name !== 'incognito') return
            const sessionId = payload?.sessionId ?? activeViewedSessionId
            if (!sessionId) return
            void fetchSessionStatus(sessionId).then((st) => {
              if (st?.destroyed) {
                void destroyAndLeaveIncognitoSession(sessionId, 'slash-command-destroyed')
              }
            })
          })
        }

        /**
         * React hook tracking the incognito state of `sessionId` and triggering automatic
         * destruction when the user switches away from an active incognito session.
         * @param {string} sessionId
         * @param {boolean} [blankHint]
         */
        function useIncognitoSession(sessionId, blankHint) {
          const [, setTick] = useState(0)

          useEffect(() => {
            const listener = () => setTick(t => t + 1)
            subscribers.add(listener)
            return () => subscribers.delete(listener)
          }, [])

          useEffect(() => {
            if (!sessionId) return
            const previousId = activeViewedSessionId
            activeViewedSessionId = sessionId

            // If switching away from an incognito session to another session, destroy the previous one
            if (previousId && previousId !== sessionId) {
              const prevSt = statusBySession.get(previousId)
              if (prevSt?.enabled && !prevSt.destroyed) {
                void mutateIncognito(previousId, 'destroy', 'switched-session')
              }
            }

            void fetchSessionStatus(sessionId)
          }, [sessionId])

          // Keep `locked` synchronized when `blankHint` transitions from `true` to `false`
          useEffect(() => {
            if (!sessionId || blankHint !== false) return
            const st = statusBySession.get(sessionId)
            if (st && !st.locked) {
              statusBySession.set(sessionId, { ...st, locked: true })
              notifyClientSubscribers()
            }
          }, [sessionId, blankHint])

          const st = statusBySession.get(sessionId) ?? {
            enabled: false,
            locked: blankHint === false,
            destroyed: false,
          }

          return {
            enabled: st.enabled,
            locked: st.locked || blankHint === false,
            destroyed: st.destroyed,
            errorToastMessage,
          }
        }

        // ============================================================================
        // UI Component 1: `conversation.input.left` Toggle Pill
        // ============================================================================
        function IncognitoInputToggle(props) {
          const sessionId = props?.sessionId
          const blank = props?.blank
          const { enabled, locked, destroyed } = useIncognitoSession(sessionId, blank)
          const [busy, setBusy] = useState(false)

          const handleToggle = useCallback(async () => {
            if (!sessionId || busy || locked || destroyed) return
            setBusy(true)
            try {
              await mutateIncognito(sessionId, enabled ? 'disable' : 'enable')
            } finally {
              setBusy(false)
            }
          }, [sessionId, busy, locked, destroyed, enabled])

          if (!sessionId || destroyed) return null

          // Single switch rendering for all states:
          // - blank session: interactive (off = gray-white, on = blue)
          // - conversation started: locked in its current state (non-interactive)
          const interactive = !locked && !busy
          const title = locked
            ? (enabled ? tr('bannerDescLocked') : tr('lockedDisabledTip'))
            : (enabled ? tr('preStartTipOn') : tr('preStartTipOff'))
          const accent = enabled ? SWITCH_ON_COLOR : 'var(--dsw-alias-label-sec, #64748b)'

          return h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': enabled ? 'true' : 'false',
              'aria-disabled': locked ? 'true' : undefined,
              disabled: locked || busy,
              onClick: handleToggle,
              'data-testid': locked
                ? (enabled ? 'incognito-locked-badge' : 'incognito-toggle-disabled')
                : 'incognito-toggle-button',
              title,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                height: '28px',
                padding: '0 6px',
                border: 'none',
                borderRadius: '8px',
                background: 'transparent',
                color: accent,
                fontSize: '13px',
                fontWeight: 500,
                lineHeight: 1,
                cursor: locked ? 'not-allowed' : busy ? 'wait' : 'pointer',
                opacity: locked && !enabled ? 0.5 : 1,
                userSelect: 'none',
                transition: 'color 0.2s ease',
              },
              onMouseEnter: (e) => {
                if (interactive) e.currentTarget.style.background = 'var(--dsw-alias-bg-hover, rgba(15, 23, 42, 0.05))'
              },
              onMouseLeave: (e) => {
                e.currentTarget.style.background = 'transparent'
              },
            },
            h(IncognitoIcon, { size: 16 }),
            h('span', null, tr('toggleOff')),
            h(SwitchTrack, { checked: enabled }),
          )
        }

        // ============================================================================
        // UI Component 2: `conversation.input.dock` Active Incognito Banner & Destroy Action
        // ============================================================================
        function IncognitoDockBanner(props) {
          const sessionId = props?.sessionId
          const blank = props?.blank
          const { enabled, locked, destroyed, errorToastMessage: toastMsg } = useIncognitoSession(sessionId, blank)
          const [ending, setEnding] = useState(false)

          const handleEndAndDestroy = useCallback(async () => {
            if (!sessionId || ending) return
            setEnding(true)
            try {
              await destroyAndLeaveIncognitoSession(sessionId, 'dock-end-button')
            } finally {
              setEnding(false)
            }
          }, [sessionId, ending])

          // Align the banner with the composer card so its width matches the input field.
          const bannerRef = useRef(null)
          const [align, setAlign] = useState(null)
          const visible = (enabled || !!toastMsg) && !destroyed
          useLayoutEffect(() => {
            if (!visible) return undefined
            const el = bannerRef.current
            const parent = el && el.parentElement
            if (!el || !parent) return undefined
            const findComposer = () => {
              let scope = parent
              for (let i = 0; i < 6 && scope; i++, scope = scope.parentElement) {
                const input = scope.querySelector('textarea, [contenteditable="true"]')
                if (!input || el.contains(input)) continue
                // Outermost rounded + bordered ancestor of the input = the composer card
                let card = null
                for (let n = input.parentElement; n && n !== scope; n = n.parentElement) {
                  const cs = getComputedStyle(n)
                  if (parseFloat(cs.borderTopLeftRadius) >= 8 && parseFloat(cs.borderTopWidth) > 0) card = n
                }
                return card || input.parentElement
              }
              return null
            }
            let composer = null
            const measure = () => {
              if (!composer || !composer.isConnected) composer = findComposer()
              if (!composer) return setAlign(null)
              const c = composer.getBoundingClientRect()
              const p = parent.getBoundingClientRect()
              if (!c.width || c.width >= p.width - 1) return setAlign(null)
              const next = { width: Math.round(c.width), left: Math.round(c.left - p.left) }
              setAlign((prev) => (prev && prev.width === next.width && prev.left === next.left ? prev : next))
            }
            measure()
            const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
            if (ro) {
              ro.observe(parent)
              if (composer) ro.observe(composer)
            }
            window.addEventListener('resize', measure)
            return () => {
              if (ro) ro.disconnect()
              window.removeEventListener('resize', measure)
            }
          }, [visible])

          if (!visible) return null

          const ACCENT = '#3b82f6'
          const DANGER = '#ef4444'
          const DANGER_SOFT = 'rgba(239, 68, 68, 0.1)'
          const fullDesc = toastMsg ? '' : (locked ? tr('bannerDescLocked') : tr('bannerDescPre'))
          const hint = toastMsg ? '' : (locked ? tr('bannerHintLocked') : tr('bannerHintPre'))

          return h(
            'div',
            {
              ref: bannerRef,
              'data-testid': 'incognito-dock-banner',
              role: 'status',
              title: fullDesc || undefined,
              style: Object.assign(
                {
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  height: '36px',
                  padding: '0 5px 0 12px',
                  marginBottom: '8px',
                  borderRadius: '12px',
                  border: '1px solid rgba(59, 130, 246, 0.22)',
                  background: 'rgba(59, 130, 246, 0.06)',
                  fontSize: '12.5px',
                  lineHeight: '20px',
                  whiteSpace: 'nowrap',
                },
                align
                  ? { width: align.width + 'px', marginLeft: align.left + 'px' }
                  : { width: '100%', maxWidth: '960px', marginLeft: 'auto', marginRight: 'auto' },
              ),
            },
            h('span', { style: { display: 'inline-flex', color: ACCENT } }, h(IncognitoIcon, { size: 16 })),
            h(
              'span',
              { style: { fontWeight: 600, color: ACCENT, flexShrink: 0 } },
              toastMsg ? toastMsg : tr('bannerTitle'),
            ),
            hint
              && h('span', {
                'aria-hidden': 'true',
                style: { width: '1px', height: '12px', background: 'currentColor', opacity: 0.2, flexShrink: 0 },
              }),
            h(
              'span',
              { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.6 } },
              hint,
            ),
            enabled
              && h(
                'button',
                {
                  type: 'button',
                  onClick: handleEndAndDestroy,
                  disabled: ending,
                  'data-testid': 'incognito-destroy-button',
                  title: tr('endButtonTitle'),
                  style: {
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: '26px',
                    padding: '0 10px',
                    borderRadius: '8px',
                    border: 'none',
                    background: DANGER_SOFT,
                    color: DANGER,
                    fontSize: '12px',
                    fontWeight: 600,
                    fontFamily: 'inherit',
                    cursor: ending ? 'wait' : 'pointer',
                    opacity: ending ? 0.6 : 1,
                    transition: 'background 0.15s, color 0.15s',
                  },
                  onMouseEnter: (e) => {
                    if (ending) return
                    e.currentTarget.style.background = DANGER
                    e.currentTarget.style.color = '#fff'
                  },
                  onMouseLeave: (e) => {
                    e.currentTarget.style.background = DANGER_SOFT
                    e.currentTarget.style.color = DANGER
                  },
                },
                tr('endButton'),
              ),
          )
        }

        // ============================================================================
        // UI Component 3: `conversation.session.header.utilities` Header Pill
        // ============================================================================
        function IncognitoHeaderUtility(props) {
          const sessionId = props?.sessionId
          const { enabled, destroyed } = useIncognitoSession(sessionId, undefined)
          const [ending, setEnding] = useState(false)

          const handleEnd = useCallback(async () => {
            if (!sessionId || ending) return
            setEnding(true)
            try {
              await destroyAndLeaveIncognitoSession(sessionId, 'header-end-button')
            } finally {
              setEnding(false)
            }
          }, [sessionId, ending])

          if (!sessionId || !enabled || destroyed) return null

          return h(
            'button',
            {
              type: 'button',
              onClick: handleEnd,
              disabled: ending,
              'data-testid': 'incognito-header-destroy-button',
              title: tr('endButtonTitle'),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                height: '26px',
                padding: '0 10px',
                borderRadius: '999px',
                border: '1px solid var(--dsw-alias-border-def, rgba(248, 113, 113, 0.45))',
                background: 'var(--dsw-alias-bg-layer-2, rgba(239, 68, 68, 0.14))',
                color: 'var(--dsw-alias-label-pri, #fca5a5)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: ending ? 'wait' : 'pointer',
              },
            },
            h(IncognitoIcon, { size: 13 }),
            h('span', null, tr('endButton')),
          )
        }

        // Mount into Conversation UI slots
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-incognito-toggle',
              order: 15,
            },
            IncognitoInputToggle,
          ),
        )

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-incognito-banner',
              order: 5,
            },
            IncognitoDockBanner,
          ),
        )

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'dsh-incognito-header',
              order: 5,
            },
            IncognitoHeaderUtility,
          ),
        )
      },
    }
  },
})
