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
    const { useState, useEffect, useCallback } = React

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
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { flexShrink: 0, display: 'inline-block' },
        },
        h('path', { d: 'M3 11h18' }),
        h('path', { d: 'M5 11l2-6.5a2 2 0 0 1 2.4-1.3L12 4l2.6-.8A2 2 0 0 1 17 4.5L19 11' }),
        h('circle', { cx: '8.5', cy: '16.5', r: '3' }),
        h('circle', { cx: '15.5', cy: '16.5', r: '3' }),
        h('path', { d: 'M11.5 16.5h1' }),
      )
    }

    return {
      inject: {
        required: ['slots'],
        optional: ['locale', 'commandUi', 'sessions', 'workspaces', 'uiWorkspace', 'uiSession'],
      },
      apply(ctx) {
        // Register bilingual strings if locale service is present
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          try {
            ctx.locale.register('zh', { incognito: DICT_ZH })
            ctx.locale.register('zh-CN', { incognito: DICT_ZH })
            ctx.locale.register('en', { incognito: DICT_EN })
            ctx.locale.register('en-US', { incognito: DICT_EN })
          } catch {
            // Ignore duplicate registration.
          }
        }

        function tr(key) {
          if (ctx.locale && typeof ctx.locale.t === 'function') {
            try {
              const val = ctx.locale.t(`incognito.${key}`)
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
            const snap = ctx.workspaces?.list?.getSnapshot?.()
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
            if (wsId && typeof ctx.uiWorkspace?.createWorkspaceSession === 'function') {
              await ctx.uiWorkspace.createWorkspaceSession(wsId)
              return
            }
            if (typeof ctx.sessions?.create === 'function') {
              const created = await ctx.sessions.create(wsId ? { workspaceId: wsId } : {})
              if (created?.sessionId && typeof ctx.uiWorkspace?.openSession === 'function') {
                ctx.uiWorkspace.openSession(created.sessionId)
              }
            }
          } catch {
            // Ignore navigation fallback error.
          }
        }

        // ============================================================================
        // Wrap Client `ctx.sessions` & `ctx.workspaces` for sidebar hiding & cancel hook
        // ============================================================================
        if (ctx.sessions?.list && typeof ctx.sessions.list.getSnapshot === 'function') {
          const origGetSnapshot = ctx.sessions.list.getSnapshot.bind(ctx.sessions.list)
          const origSubscribe = ctx.sessions.list.subscribe?.bind(ctx.sessions.list)
          let lastRawSnap = undefined
          let lastFilteredSnap = undefined

          ctx.sessions.list.getSnapshot = function incognitoFilteredListSnapshot() {
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
            ctx.sessions.list.subscribe = function incognitoFilteredListSubscribe(listener) {
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

        // Preserve `workspaceId` membership in browser memory ONLY while the incognito session
        // is still blank (`!locked`) so `ConversationContent.tsx` keeps the Hero input enabled,
        // while `ctx.sessions.list` omits its summary so the sidebar tree still hides it!
        if (ctx.workspaces?.list && typeof ctx.workspaces.list.getSnapshot === 'function') {
          const origWsGetSnapshot = ctx.workspaces.list.getSnapshot.bind(ctx.workspaces.list)
          let lastRawWsSnap = undefined
          let lastPatchedWsSnap = undefined

          ctx.workspaces.list.getSnapshot = function incognitoPatchedWorkspaceSnapshot() {
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

        // Hook `ctx.sessions.prompt` so sending the first message immediately marks the client state locked
        if (ctx.sessions && typeof ctx.sessions.prompt === 'function') {
          const origPrompt = ctx.sessions.prompt.bind(ctx.sessions)
          ctx.sessions.prompt = async function incognitoGuardedClientPrompt(sessionId, ...rest) {
            const st = statusBySession.get(sessionId)
            if (st) {
              statusBySession.set(sessionId, { ...st, locked: true })
              notifyClientSubscribers()
            }
            return origPrompt(sessionId, ...rest)
          }
        }

        // Hook `ctx.sessions.cancel`: cancelling an incognito session destroys it and leaves
        if (ctx.sessions && typeof ctx.sessions.cancel === 'function') {
          const origCancel = ctx.sessions.cancel.bind(ctx.sessions)
          ctx.sessions.cancel = async function incognitoGuardedClientCancel(sessionId, ...rest) {
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

        // Destroy active incognito session when tab is closed or refreshed
        if (typeof window !== 'undefined') {
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
        if (ctx.commandUi && typeof ctx.commandUi.decorate === 'function') {
          ctx.effect(() => ctx.commandUi.decorate({
            name: 'incognito',
            description: '开启、查询或结束无痕浏览（仅限对话开始前选择） / Toggle or end Incognito Mode',
          }))
        }

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

          // Case A: Mid-conversation in a standard session -> disabled button explaining pre-chat rule
          if (locked && !enabled) {
            return h(
              'button',
              {
                type: 'button',
                disabled: true,
                'aria-disabled': 'true',
                'data-testid': 'incognito-toggle-disabled',
                title: tr('lockedDisabledTip'),
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  height: '28px',
                  padding: '0 10px',
                  borderRadius: '999px',
                  border: '1px solid var(--dsw-alias-border-def, rgba(148, 163, 184, 0.22))',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-ter, #64748b)',
                  fontSize: '12px',
                  lineHeight: 1,
                  cursor: 'not-allowed',
                  opacity: 0.55,
                  userSelect: 'none',
                },
              },
              h(IncognitoIcon, { size: 13 }),
              h('span', null, tr('toggleOff')),
            )
          }

          // Case B: Mid-conversation in an active Incognito session -> locked badge
          if (locked && enabled) {
            return h(
              'span',
              {
                'data-testid': 'incognito-locked-badge',
                title: tr('bannerDescLocked'),
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  height: '28px',
                  padding: '0 10px',
                  borderRadius: '999px',
                  border: '1px solid var(--dsw-alias-accent-primary, #38bdf8)',
                  background: 'var(--dsw-alias-bg-layer-2, rgba(56, 189, 248, 0.14))',
                  color: 'var(--dsw-alias-label-pri, #e2e8f0)',
                  fontSize: '12px',
                  fontWeight: 600,
                  lineHeight: 1,
                  userSelect: 'none',
                },
              },
              h(IncognitoIcon, { size: 13 }),
              h('span', null, tr('lockedActive')),
            )
          }

          // Case C: Pre-conversation (blank session) -> interactive toggle button
          return h(
            'button',
            {
              type: 'button',
              onClick: handleToggle,
              disabled: busy,
              'aria-pressed': enabled ? 'true' : 'false',
              'data-testid': 'incognito-toggle-button',
              title: enabled ? tr('preStartTipOn') : tr('preStartTipOff'),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                height: '28px',
                padding: '0 10px',
                borderRadius: '999px',
                border: enabled
                  ? '1px solid var(--dsw-alias-accent-primary, #38bdf8)'
                  : '1px solid var(--dsw-alias-border-def, rgba(148, 163, 184, 0.3))',
                background: enabled
                  ? 'var(--dsw-alias-bg-layer-2, rgba(56, 189, 248, 0.16))'
                  : 'var(--dsw-alias-bg-layer-1, transparent)',
                color: enabled
                  ? 'var(--dsw-alias-label-pri, #38bdf8)'
                  : 'var(--dsw-alias-label-sec, #94a3b8)',
                fontSize: '12px',
                fontWeight: enabled ? 600 : 500,
                lineHeight: 1,
                cursor: busy ? 'wait' : 'pointer',
                transition: 'all 0.15s ease',
              },
            },
            h(IncognitoIcon, { size: 13 }),
            h('span', null, enabled ? tr('toggleOn') : tr('toggleOff')),
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

          if (!enabled && !toastMsg) return null
          if (destroyed) return null

          return h(
            'div',
            {
              'data-testid': 'incognito-dock-banner',
              role: 'status',
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                padding: '8px 12px',
                marginBottom: '6px',
                borderRadius: '10px',
                border: '1px solid var(--dsw-alias-border-def, rgba(56, 189, 248, 0.35))',
                background: 'var(--dsw-alias-bg-layer-2, rgba(15, 23, 42, 0.75))',
                color: 'var(--dsw-alias-label-pri, #e2e8f0)',
                fontSize: '12px',
                lineHeight: 1.4,
              },
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  minWidth: 0,
                  flex: 1,
                },
              },
              h(IncognitoIcon, { size: 16 }),
              h(
                'div',
                { style: { minWidth: 0 } },
                h(
                  'div',
                  { style: { fontWeight: 600, color: 'var(--dsw-alias-label-pri, #f8fafc)' } },
                  toastMsg ? toastMsg : tr('bannerTitle'),
                ),
                !toastMsg
                  && h(
                    'div',
                    {
                      style: {
                        color: 'var(--dsw-alias-label-sec, #94a3b8)',
                        fontSize: '11.5px',
                      },
                    },
                    locked ? tr('bannerDescLocked') : tr('bannerDescPre'),
                  ),
              ),
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
                    padding: '4px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--dsw-alias-border-def, rgba(248, 113, 113, 0.45))',
                    background: 'var(--dsw-alias-bg-layer-3, rgba(239, 68, 68, 0.15))',
                    color: 'var(--dsw-alias-label-pri, #fca5a5)',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: ending ? 'wait' : 'pointer',
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
