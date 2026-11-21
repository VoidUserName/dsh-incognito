/**
 * Host implementation of the DeepSeek Harness Incognito Mode plugin (@local/dsh-incognito).
 *
 * Enforces five strict guarantees for incognito sessions:
 * 1. Pre-conversation selection only: Incognito Mode can only be enabled while a session is blank
 *    (before any turn, user message, assistant message, tool call, or non-incognito command occurs).
 *    Enabling Incognito Mode mid-conversation is rejected; disabling it once a conversation starts is rejected.
 * 2. Zero durable session log or cache writes: Incognito sessions never write to `sessionPersistence`
 *    (JSONL/zstd), `sessionProjectionCache`, `workspaceRegistry` storage, or `sessionTitle`. Any
 *    pre-materialized blank-session artifacts created before the user toggled Incognito Mode are
 *    immediately purged from disk and memory.
 * 3. Complete invisibility to history & extraction plugins: `sessions.list()`, `sessionQuery`
 *    (`listSessions`, `readSession`, `readSurface`, `filterSessions`, `listEvents`, `filterEvents`,
 *    `readTitle`, `readTitleSnapshot`, `readTitleSnapshots`, `traceSession`, `traceEvent`,
 *    `readEvent`, `searchSessions`, `searchEvents`, `observeSession`), `sessionReferenceResolver`,
 *    `session-log-export`, `sessionTelemetry`, and external `session/event` listeners cannot read or
 *    discover incognito sessions.
 * 4. Multi-turn in-memory operation: While the incognito session remains active, `AgentLoop` and
 *    `sessionProjections` maintain multi-turn context purely in memory, and the user's active viewport
 *    can stream events until the session ends.
 * 5. True hard-delete on cancel or exit (zero tombstone residue): Cancelling/ending an incognito
 *    session, switching to another session, starting a new session, or disconnecting the active
 *    session stream immediately disposes the agent and session, wipes in-memory events and temporary
 *    spill files, and removes `sessionId` from all maps so not even the session ID string remains in
 *    memory. Any subsequent resume/open/read naturally fails with NotFound as if the session never existed.
 */

import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'incognito'

/**
 * Structured error thrown by the Incognito Mode service when an operation violates
 * pre-conversation selection, post-start locking, or post-destruction unrecoverability.
 */
export class IncognitoError extends Error {
  /**
   * @param {string} code - Machine-readable error code (`incognito/*`).
   * @param {string} message - Human-readable diagnostic message.
   * @param {Record<string, unknown>} [details] - Structured diagnostic context.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'IncognitoError'
    this.code = code
    this.details = details
  }
}

/**
 * Event prefixes that may be appended during blank session creation (e.g. by `permission-presets`)
 * before any user conversation has started.
 */
const SETUP_ONLY_EVENT_PREFIXES = ['permission/']

/**
 * Determine whether an event type name represents conversation activity rather than blank-session setup.
 * @param {unknown} eventType - Session event type string.
 * @returns {boolean} True when the event marks the session as having started a conversation.
 */
function isConversationEventType(eventType) {
  if (typeof eventType !== 'string' || eventType.length === 0) return false
  for (const prefix of SETUP_ONLY_EVENT_PREFIXES) {
    if (eventType.startsWith(prefix)) return false
  }
  return true
}

/**
 * Determine whether a single session event represents conversation activity.
 * @param {{ readonly type?: unknown } | undefined} event - Session event envelope.
 * @returns {boolean}
 */
function isConversationEvent(event) {
  return isConversationEventType(event?.type)
}

/**
 * Determine whether a Session instance already has conversation activity in its log.
 * @param {{ readonly log?: readonly { readonly type?: string }[] } | undefined} session
 * @returns {boolean} True when at least one conversation event exists in `session.log`.
 */
function hasConversationStartedInLog(session) {
  if (!session || !Array.isArray(session.log)) return false
  return session.log.some(isConversationEvent)
}

/**
 * Mount the Host Incognito Mode controller, service interceptors, `/incognito` slash command,
 * and `/api/incognito` Web endpoint.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host Cordis context.
 */
export function apply(ctx) {
  /**
   * Active incognito session records keyed by sessionId.
   * Once an incognito session is cancelled or exited, its entry is hard-deleted from this Map
   * so no sessionId string or metadata remains in memory.
   * @type {Map<string, {
   *   sessionId: string,
   *   enabled: true,
   *   engaged: boolean,
   *   createdAt: number,
   *   workspaceId: string | undefined,
   *   cwd: string | undefined,
   *   spillIds: Set<string>,
   *   activeFollowers: number,
   *   disconnectTimer: ReturnType<typeof setTimeout> | undefined,
   * }>}
   */
  const incognitoSessions = new Map()

  /**
   * WeakSet of disposed `Session` object instances so if a caller retains a stale JS reference
   * to a hard-deleted `Session` object in a local variable, `session.append` still refuses writes,
   * while allowing V8 garbage collection to reclaim the object with zero ID retention.
   * @type {WeakSet<object>}
   */
  const destroyedSessionObjects = new WeakSet()

  /**
   * Captured AgentHandle (`{ agent, session, dispose }`) or Session detach callbacks for clean disposal.
   * Entries are deleted immediately upon session destruction.
   * @type {Map<string, { agent?: any, session?: any, dispose?: () => Promise<void> | void }>}
   */
  const handlesBySessionId = new Map()

  /**
   * Wrapped object tracker to guarantee idempotence across multiple `ctx.inject` notifications.
   * @type {WeakSet<object>}
   */
  const wrappedObjects = new WeakSet()

  /**
   * When true, the next session created via `sessions.create` / `agentLoop.create` / `agentLoop.createAgent`
   * starts in Incognito Mode from birth without touching disk.
   */
  let stagedForNextSession = false

  /**
   * Counter tracking authorized internal reads from the active user viewport (`SessionHistoryController.follow` / `page`).
   */
  let authorizedUiReadDepth = 0

  /**
   * Counter tracking internal runtime lookups (`SessionCommandController`, `CommandRuntime`, `AgentLoop`).
   */
  let authorizedInternalLookupDepth = 0

  /**
   * Counter tracking execution of the `/incognito` slash command so `command/run` and `command/done`
   * do not pollute `session.log` or transition a blank session out of the Hero state.
   */
  let activeIncognitoCommandDepth = 0

  /**
   * Session ID currently being created in incognito mode (before `sessions.enter` completes).
   * @type {string | undefined}
   */
  let creatingIncognitoSessionId = undefined

  /**
   * Session ID currently mid-destruction (only during the synchronous/async teardown steps,
   * immediately cleared in `finally` so no ID is retained after teardown completes).
   * @type {Set<string>}
   */
  const destroyingInFlightIds = new Set()

  /**
   * Listeners notified when incognito state changes.
   * @type {Set<(snapshot: any) => void>}
   */
  const stateListeners = new Set()

  /**
   * Check whether `sessionId` is currently an active (or mid-teardown) incognito session.
   * @param {string | undefined} sessionId
   * @returns {boolean}
   */
  function isHiddenSession(sessionId) {
    if (typeof sessionId !== 'string') return false
    return (
      incognitoSessions.has(sessionId)
      || destroyingInFlightIds.has(sessionId)
      || creatingIncognitoSessionId === sessionId
    )
  }

  /**
   * Check whether `sessionId` is an active incognito session.
   * @param {string | undefined} sessionId
   * @returns {boolean}
   */
  function isActiveIncognito(sessionId) {
    if (typeof sessionId !== 'string') return false
    return incognitoSessions.has(sessionId)
  }

  /**
   * Resolve the live `Session` object directly from `SessionStore.store` (or via `_incognitoOrigGet`),
   * bypassing external-caller filtering.
   * @param {string} sessionId
   * @returns {any | undefined}
   */
  function getRawLiveSession(sessionId) {
    const sessionsSvc = ctx.get('sessions')
    if (!sessionsSvc) return undefined
    if (sessionsSvc.store instanceof Map) {
      return sessionsSvc.store.get(sessionId)?.session
    }
    if (typeof sessionsSvc._incognitoOrigGet === 'function') {
      return sessionsSvc._incognitoOrigGet(sessionId)
    }
    authorizedInternalLookupDepth++
    try {
      return sessionsSvc.get?.(sessionId)
    } finally {
      authorizedInternalLookupDepth--
    }
  }

  /**
   * Determine whether a session has already started a conversation (in memory or on disk).
   * @param {string} sessionId
   * @param {any} [sessionObj]
   * @returns {Promise<boolean>}
   */
  async function hasSessionConversationStarted(sessionId, sessionObj) {
    const entry = incognitoSessions.get(sessionId)
    if (entry?.engaged) return true
    const session = sessionObj ?? getRawLiveSession(sessionId)
    if (session && hasConversationStartedInLog(session)) {
      return true
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence && typeof persistence._incognitoOrigOpen === 'function') {
      try {
        const handle = await persistence._incognitoOrigOpen(sessionId, 'read')
        try {
          const readRes = await handle.read?.(0)
          const events = readRes?.events ?? (await handle.readEvents?.())
          if (Array.isArray(events) && events.some(isConversationEvent)) {
            return true
          }
        } finally {
          await handle.close?.().catch(() => {})
        }
      } catch {
        // Not on disk or no persisted events — still blank.
      }
    }
    return false
  }

  /**
   * Create a genuine `SessionPersistenceNotFoundError` from the underlying `sessionPersistence`
   * service so `instanceof SessionPersistenceNotFoundError` checks in callers succeed.
   * @param {string} sessionId
   * @returns {Promise<Error>}
   */
  async function createPersistenceNotFoundError(sessionId) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence && typeof persistence._incognitoOrigOpen === 'function') {
      try {
        await persistence._incognitoOrigOpen(`incognito-missing-${Date.now()}`, 'read')
      } catch (err) {
        if (err && typeof err === 'object') {
          try {
            const Ctor = err.constructor
            if (typeof Ctor === 'function' && Ctor !== Error) {
              const instance = new Ctor(sessionId)
              if (instance instanceof Ctor) return instance
            }
          } catch {
            // Fall through to returning probed error.
          }
          return err
        }
      }
    }
    const fallback = new Error(`Session "${sessionId}" not found`)
    fallback.name = 'SessionPersistenceNotFoundError'
    fallback.sessionId = sessionId
    return fallback
  }

  /**
   * Create a genuine `SessionQueryError` (`SESSION_QUERY_SESSION_NOT_FOUND`) from `sessionQuery`
   * so callers checking `error instanceof SessionQueryError` succeed.
   * @param {string} sessionId
   * @returns {Promise<Error>}
   */
  async function createQueryNotFoundError(sessionId) {
    const query = ctx.get('sessionQuery')
    if (query && typeof query._incognitoOrigReadSession === 'function') {
      try {
        await query._incognitoOrigReadSession(`incognito-missing-${Date.now()}`)
      } catch (err) {
        if (err && typeof err === 'object') {
          try {
            const Ctor = err.constructor
            if (typeof Ctor === 'function' && Ctor !== Error) {
              const instance = new Ctor(
                `session "${sessionId}" not found`,
                err.code ?? 'SESSION_QUERY_SESSION_NOT_FOUND',
              )
              if (instance instanceof Ctor) return instance
            }
          } catch {
            // Fall through to returning probed error.
          }
          return err
        }
      }
    }
    const fallback = new Error(`session "${sessionId}" not found`)
    fallback.name = 'SessionQueryError'
    fallback.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
    return fallback
  }

  /**
   * Neutralize an open `JsonlSessionHandle` in place so any caller holding a reference to it
   * (`AgentLoop`'s `stored.handle`) can never write or flush events to disk.
   * @param {any} handle
   */
  async function neutralizePersistenceHandle(handle) {
    if (!handle || typeof handle !== 'object') return
    try {
      if (Array.isArray(handle.buffered)) {
        handle.buffered.length = 0
      }
      if (handle.batchTimer !== undefined) {
        clearTimeout(handle.batchTimer)
        handle.batchTimer = undefined
      }
      if (handle.state && typeof handle.state === 'object') {
        handle.state.materialized = false
      }
      const lease = handle.lease
      handle.lease = undefined
      if (lease && typeof lease.release === 'function') {
        await lease.release().catch(() => {})
      }
      handle.enqueueLive = () => {}
      handle.drainLive = async () => {}
      handle.append = async () => {}
      handle.flush = async () => {}
      handle.close = async () => {}
    } catch {
      // Ignore neutralization errors.
    }
  }

  /**
   * Purge any pre-materialized JSONL session files, writer handles, pending entries, and cold-log
   * memo entries for `sessionId` from `sessionPersistence`.
   * @param {string} sessionId
   */
  async function purgeSessionPersistence(sessionId) {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) return

    const tracker = persistence.tracker
    if (tracker) {
      tracker.pending?.delete?.(sessionId)
      const writer = tracker.writers?.get?.(sessionId)
      tracker.writers?.delete?.(sessionId)
      if (writer) {
        tracker.openHandles?.delete?.(writer)
        await neutralizePersistenceHandle(writer)
      }
      if (tracker.openHandles instanceof Set) {
        for (const h of [...tracker.openHandles]) {
          if (h?.id === sessionId) {
            tracker.openHandles.delete(h)
            await neutralizePersistenceHandle(h)
          }
        }
      }
    }

    if (persistence.coldLogMemo instanceof Map) {
      persistence.coldLogMemo.delete(sessionId)
    } else {
      persistence.coldLogMemo?.evict?.(sessionId)
    }

    const rootDir = persistence.root
    if (typeof rootDir === 'string' && existsSync(rootDir)) {
      try {
        for (const projectEntry of readdirSync(rootDir, { withFileTypes: true })) {
          if (!projectEntry.isDirectory()) continue
          const candidateDir = join(rootDir, projectEntry.name, sessionId)
          if (existsSync(candidateDir)) {
            rmSync(candidateDir, { recursive: true, force: true })
            try {
              rmdirSync(join(rootDir, projectEntry.name))
            } catch {
              // Non-empty project directory; keep it.
            }
          }
        }
      } catch {
        // Ignore scan errors on missing root directory.
      }
    }
  }

  /**
   * Purge any cached projection snapshot or pending dirty timer for `sessionId`
   * from `sessionProjectionCache` and `sessionQuery._observations`.
   * @param {string} sessionId
   */
  async function purgeProjectionCache(sessionId) {
    const query = ctx.get('sessionQuery')
    query?._observations?.cache?.delete?.(sessionId)

    const cache = ctx.get('sessionProjectionCache')
    if (!cache) return
    try {
      cache.dirty?.delete?.(sessionId)
      const timer = cache.timers?.get?.(sessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        cache.timers.delete(sessionId)
      }
      const inFlight = cache.inFlight?.get?.(sessionId)
      if (inFlight) {
        await inFlight.catch(() => {})
      }
      cache.dirty?.delete?.(sessionId)
      if (typeof cache.table === 'function') {
        const table = await cache.table()
        await table?.delete?.(sessionId)
      } else if (cache.domain && typeof cache.domain.table === 'function') {
        const table = await cache.domain.table('snapshots')
        await table?.delete?.(sessionId)
      }
    } catch {
      // Ignore projection cache cleanup errors when storage is not mounted.
    }
  }

  /**
   * Detach `sessionId` from all workspaces in `workspaceRegistry` and purge its cached header/path.
   * Returns the workspaceId it belonged to (if any) so the Client UI can preserve workspace context while blank.
   * @param {string} sessionId
   * @returns {Promise<string | undefined>}
   */
  async function purgeWorkspaceMembership(sessionId) {
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return undefined
    let foundWorkspaceId = undefined
    try {
      const workspaces = typeof registry.list === 'function' ? registry.list() : []
      for (const ws of workspaces) {
        const recordIds = ws.record?.sessionIds ?? ws.sessionIds ?? []
        if (Array.isArray(recordIds) && recordIds.includes(sessionId)) {
          foundWorkspaceId = String(ws.id)
          await ws.detachSession?.(sessionId).catch(() => {})
        }
      }
      if (typeof registry.unpinSession === 'function') {
        await registry.unpinSession(sessionId).catch(() => {})
      }
      if (typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(sessionId).catch(() => {})
      }
      registry.headers?.delete?.(sessionId)
      registry.sessionPaths?.delete?.(sessionId)
    } catch {
      // Ignore workspace detach errors if registry is closing.
    }
    return foundWorkspaceId
  }

  /**
   * Purge any spilled tool output files recorded during the incognito session.
   * @param {{ spillIds?: Set<string> } | undefined} entry
   */
  async function purgeSpillFiles(entry) {
    if (!entry || !(entry.spillIds instanceof Set) || entry.spillIds.size === 0) return
    const spillStore = ctx.get('spillStore')
    const rootDir = spillStore?.rootDir ?? spillStore?.config?.rootDir
    for (const spillId of entry.spillIds) {
      try {
        if (typeof spillStore?.delete === 'function') {
          await spillStore.delete(spillId)
        } else if (typeof rootDir === 'string') {
          rmSync(join(rootDir, `${spillId}.txt`), { force: true })
          rmSync(join(rootDir, spillId), { force: true })
        }
      } catch {
        // Ignore missing spill files.
      }
    }
    entry.spillIds.clear()
  }

  /**
   * Emit `api-session/removed` so the Web Client sidebar and `SessionListController`
   * immediately drop `sessionId` from their visible session maps.
   * @param {string} sessionId
   */
  function emitApiSessionRemoved(sessionId) {
    try {
      ctx.emit?.('api-session/removed', { id: sessionId })
    } catch {
      // Ignore if no listeners are attached.
    }
  }

  /**
   * Notify all registered state listeners of an incognito status change.
   * @param {string} sessionId
   */
  function notifyStateListeners(sessionId) {
    const status = getStatus(sessionId)
    for (const listener of stateListeners) {
      try {
        listener(status)
      } catch {
        // Ignore listener errors.
      }
    }
  }

  /**
   * Mark an active incognito session as engaged (conversation started; locked into incognito mode).
   * @param {string} sessionId
   */
  function markIncognitoEngaged(sessionId) {
    const entry = incognitoSessions.get(sessionId)
    if (!entry || entry.engaged) return
    entry.engaged = true
    void purgeSessionPersistence(sessionId)
    void purgeProjectionCache(sessionId)
    void purgeWorkspaceMembership(sessionId)
    emitApiSessionRemoved(sessionId)
    notifyStateListeners(sessionId)
  }

  /**
   * Wrap a live `Session` instance's `append(type, data, ...opts)` method to:
   * 1. Reject appends to hard-deleted `Session` object instances via `destroyedSessionObjects` WeakSet.
   * 2. Suppress `command/run` and `command/done` events generated by `/incognito` so the command
   *    leaves zero trace in `session.log` and keeps blank sessions on the Hero screen.
   * 3. Automatically lock (`engaged = true`) an incognito session as soon as the first conversation
   *    event is appended.
   * @param {any} session
   */
  function guardSessionInstance(session) {
    if (!session || typeof session !== 'object' || typeof session.append !== 'function' || wrappedObjects.has(session)) {
      return
    }
    wrappedObjects.add(session)

    const origAppend = session.append.bind(session)
    session.append = function incognitoGuardedAppend(type, data, ...opts) {
      const eventType = typeof type === 'string' ? type : type?.type
      const eventData = typeof type === 'string' ? data : type?.data

      const isIncognitoCommandEvent =
        (eventType === 'command/run' || eventType === 'command/done')
        && (activeIncognitoCommandDepth > 0 || eventData?.name === 'incognito')

      if (isIncognitoCommandEvent) {
        return Object.freeze({
          type: eventType,
          seq: Array.isArray(session.log) ? session.log.length : 0,
          time: Date.now(),
          data: eventData,
        })
      }

      if (destroyedSessionObjects.has(session) || destroyingInFlightIds.has(session.id)) {
        throw new IncognitoError(
          'incognito/session-destroyed',
          `Incognito session "${session.id}" has been hard-deleted and cannot be modified or recovered.`,
          { sessionId: session.id },
        )
      }

      if (incognitoSessions.has(session.id) && isConversationEventType(eventType)) {
        markIncognitoEngaged(session.id)
      }

      const appended = origAppend(type, data, ...opts)

      if (incognitoSessions.has(session.id)) {
        void purgeProjectionCache(session.id)
      }

      return appended
    }
  }

  /**
   * Enable Incognito Mode for `sessionId`.
   * Rejects if the session does not exist (e.g. was already hard-deleted) or if the conversation
   * has already started.
   * @param {string} sessionId
   */
  async function enableIncognito(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new IncognitoError('incognito/invalid-session', 'A valid sessionId is required.')
    }

    const existing = incognitoSessions.get(sessionId)
    if (existing) {
      return getStatus(sessionId)
    }

    const session = getRawLiveSession(sessionId)
    if (!session || destroyedSessionObjects.has(session)) {
      throw new IncognitoError(
        'incognito/session-not-found',
        '该会话不存在或已被彻底销毁，无法开启或恢复。 / Session does not exist or has been permanently destroyed.',
        { sessionId },
      )
    }

    const started = await hasSessionConversationStarted(sessionId, session)
    if (started) {
      throw new IncognitoError(
        'incognito/conversation-already-started',
        '无痕浏览只能在开始对话前选择，不可以对话到一半切换为无痕模式。 / Incognito mode can only be selected before starting a conversation.',
        { sessionId },
      )
    }

    guardSessionInstance(session)

    // Hard-delete any OTHER previously active incognito session when enabling a new one
    for (const [otherId] of [...incognitoSessions.entries()]) {
      if (otherId !== sessionId && session?.header?.parentSession !== otherId) {
        await destroyIncognitoSession(otherId, 'switched-session')
      }
    }

    const workspaceId = await purgeWorkspaceMembership(sessionId)
    const entry = {
      sessionId,
      enabled: true,
      engaged: false,
      createdAt: Date.now(),
      workspaceId,
      cwd: session?.header?.cwd,
      spillIds: new Set(),
      activeFollowers: 0,
      disconnectTimer: undefined,
    }
    incognitoSessions.set(sessionId, entry)

    await Promise.all([
      purgeSessionPersistence(sessionId),
      purgeProjectionCache(sessionId),
    ])

    emitApiSessionRemoved(sessionId)
    notifyStateListeners(sessionId)
    return getStatus(sessionId)
  }

  /**
   * Disable Incognito Mode for `sessionId` ONLY if the conversation has not started yet.
   * Once the conversation has started (`entry.engaged === true`), disabling Incognito Mode is
   * forbidden; the user must cancel/end the incognito session instead.
   * @param {string} sessionId
   */
  async function disableIncognito(sessionId) {
    const entry = incognitoSessions.get(sessionId)
    if (!entry) {
      return getStatus(sessionId)
    }

    const session = getRawLiveSession(sessionId)
    if (entry.engaged || hasConversationStartedInLog(session)) {
      throw new IncognitoError(
        'incognito/locked-after-start',
        '无痕对话已开始，无法中途退出无痕模式；如需结束请取消或关闭当前无痕会话。 / Incognito mode is locked once the conversation starts; cancel or close the session to exit.',
        { sessionId },
      )
    }

    if (entry.disconnectTimer !== undefined) {
      clearTimeout(entry.disconnectTimer)
    }
    incognitoSessions.delete(sessionId)

    // Re-register with persistence and workspace if the session is still blank
    const persistence = ctx.get('sessionPersistence')
    if (session && persistence && typeof persistence._incognitoOrigCreate === 'function') {
      try {
        const handle = await persistence._incognitoOrigCreate(session.header, {
          inheritedEventCount: session.inheritedEventCount,
        })
        if (Array.isArray(session.log) && session.log.length > 0) {
          await handle.append?.(session.log)
        }
      } catch {
        // Ignore re-registration failure in memory-only setups.
      }
    }

    const registry = ctx.get('workspaceRegistry')
    if (registry && entry.workspaceId) {
      try {
        const ws = registry.get?.(entry.workspaceId)
        if (ws && typeof ws.attachSession === 'function') {
          if (session?.header?.cwd) {
            registry.rememberSessionPath?.(sessionId, session.header.cwd)
          }
          await ws.attachSession(sessionId)
        }
      } catch {
        // Ignore re-attach error if workspace no longer exists.
      }
    }

    if (session) {
      try {
        ctx.emit?.('api-session/added', {
          id: session.id,
          header: session.header,
          title: undefined,
          updatedAt: Date.now(),
          blank: true,
        })
      } catch {
        // Ignore if listener is absent.
      }
    }

    notifyStateListeners(sessionId)
    return getStatus(sessionId)
  }

  /**
   * Toggle Incognito Mode on a blank session.
   * @param {string} sessionId
   */
  async function toggleIncognito(sessionId) {
    if (incognitoSessions.has(sessionId)) {
      return disableIncognito(sessionId)
    }
    return enableIncognito(sessionId)
  }

  /**
   * Perform a complete, physical hard-delete of an incognito session:
   * - Stops and disposes the `Agent` and `Session` from `AgentRegistry` and `SessionStore`
   * - Wipes all in-memory events (`session.log`), derived messages (`session.derived`), and projections
   * - Deletes any temporary spill files, projection caches, or disk handles
   * - Removes `sessionId` from `incognitoSessions` and `handlesBySessionId` so NOT EVEN the
   *   `sessionId` string remains in memory (zero soft-delete / tombstone residue).
   * @param {string} sessionId
   * @param {string} [reason]
   * @returns {Promise<{ sessionId: string, destroyed: true, reason: string }>}
   */
  async function destroyIncognitoSession(sessionId, reason = 'cancelled') {
    if (!sessionId || typeof sessionId !== 'string') {
      return { sessionId: String(sessionId ?? ''), destroyed: true, reason }
    }
    if (destroyingInFlightIds.has(sessionId)) {
      return { sessionId, destroyed: true, reason }
    }
    destroyingInFlightIds.add(sessionId)

    try {
      const entry = incognitoSessions.get(sessionId)
      if (entry?.disconnectTimer !== undefined) {
        clearTimeout(entry.disconnectTimer)
        entry.disconnectTimer = undefined
      }
      // Hard-delete from `incognitoSessions` Map — no string ID tombstone kept!
      incognitoSessions.delete(sessionId)

      // Hard-delete any child subagent sessions whose parentSession is `sessionId`
      const sessionsSvc = ctx.get('sessions')
      if (sessionsSvc?.store instanceof Map) {
        for (const [candidateId, storeEntry] of [...sessionsSvc.store.entries()]) {
          if (candidateId !== sessionId && storeEntry?.session?.header?.parentSession === sessionId) {
            await destroyIncognitoSession(candidateId, `parent-${reason}`)
          }
        }
      }

      const handle = handlesBySessionId.get(sessionId)
      handlesBySessionId.delete(sessionId)

      const session = handle?.session ?? getRawLiveSession(sessionId)
      const agentsSvc = ctx.get('agents')
      const agent = handle?.agent ?? agentsSvc?._incognitoOrigGet?.(sessionId) ?? agentsSvc?.get?.(sessionId)

      if (session && typeof session === 'object') {
        destroyedSessionObjects.add(session)
      }

      // 1. Cancel any running agent work and wipe inbox queues
      if (agent) {
        try {
          agent.inbox?.clear?.()
          agent.cancel?.({ kind: 'disposed' }, { keepInbox: false })
        } catch {
          // Ignore cancellation errors on already-stopped agent.
        }
      }

      // 2. Physically wipe in-memory session log events, surface nodes, and derived message caches
      if (session) {
        try {
          if (Array.isArray(session.log)) session.log.length = 0
          if (Array.isArray(session.derived)) session.derived.length = 0
          if (Array.isArray(session.surfaceManager?.nodes)) session.surfaceManager.nodes.length = 0
          session.eventsSnapshot = undefined
        } catch {
          // Ignore if log array is frozen.
        }
      }

      // 3. Dispose the AgentHandle and remove the live SessionStore & AgentRegistry entries
      if (typeof handle?.dispose === 'function') {
        await Promise.resolve(handle.dispose()).catch(() => {})
      }
      if (sessionsSvc?.store instanceof Map) {
        const storeEntry = sessionsSvc.store.get(sessionId)
        if (storeEntry) {
          try {
            storeEntry.detach?.()
          } catch {
            sessionsSvc.store.delete(sessionId)
          }
        }
      }

      // 4. Evict from in-memory SessionProjectionRegistry cache
      const projection = ctx.get('sessionProjection')
      projection?.entries?.delete?.(sessionId)
      const projections = ctx.get('sessionProjections')
      projections?.entries?.delete?.(sessionId)
      projections?.cache?.delete?.(sessionId)

      // 5. Evict from ApiSessionAgentController (`sessionController.agents`) if present
      const sessionController = ctx.get('sessionController')
      if (sessionController?.agents) {
        sessionController.agents.handles?.delete?.(sessionId)
        sessionController.agents.selections?.delete?.(sessionId)
        sessionController.agents.creating?.delete?.(sessionId)
      }

      // 6. Purge any disk persistence, projection cache, workspace references, and spill files
      await Promise.all([
        purgeSessionPersistence(sessionId),
        purgeProjectionCache(sessionId),
        purgeWorkspaceMembership(sessionId),
        purgeSpillFiles(entry),
      ])

      emitApiSessionRemoved(sessionId)
      notifyStateListeners(sessionId)
      return { sessionId, destroyed: true, reason }
    } finally {
      destroyingInFlightIds.delete(sessionId)
    }
  }

  /**
   * Read the current incognito status for `sessionId` (and global `stagedForNextSession` state).
   * Because destroyed sessions are hard-deleted with zero ID retention, querying a non-existent
   * `sessionId` reports `exists: false, destroyed: true`.
   * @param {string} [sessionId]
   */
  function getStatus(sessionId) {
    if (!sessionId) {
      return {
        sessionId: undefined,
        exists: false,
        enabled: false,
        locked: false,
        destroyed: false,
        staged: stagedForNextSession,
        activeIncognitoSessionIds: [...incognitoSessions.keys()],
      }
    }
    const entry = incognitoSessions.get(sessionId)
    const session = getRawLiveSession(sessionId)
    if (!entry && !session) {
      return {
        sessionId,
        exists: false,
        enabled: false,
        locked: true,
        destroyed: true,
        staged: stagedForNextSession,
        workspaceId: undefined,
      }
    }
    const conversationStarted = Boolean(entry?.engaged || hasConversationStartedInLog(session))
    return {
      sessionId,
      exists: true,
      enabled: Boolean(entry),
      locked: conversationStarted,
      destroyed: false,
      staged: stagedForNextSession,
      workspaceId: entry?.workspaceId,
    }
  }

  /**
   * Stage (or unstage) Incognito Mode for the next created session.
   * @param {boolean} staged
   */
  function setStagedForNextSession(staged) {
    stagedForNextSession = Boolean(staged)
    notifyStateListeners('')
    return { staged: stagedForNextSession }
  }

  // Expose the public `ctx.incognito` service API on Context
  const incognitoApi = {
    enable: enableIncognito,
    disable: disableIncognito,
    toggle: toggleIncognito,
    destroy: destroyIncognitoSession,
    cancel: destroyIncognitoSession,
    getStatus,
    isIncognito: isActiveIncognito,
    isHidden: isHiddenSession,
    setStagedForNextSession,
    subscribe(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
  }

  try {
    ctx.provide?.('incognito', incognitoApi)
  } catch {
    // Service may already be declared; assign directly.
  }
  ctx.incognito = incognitoApi

  // ============================================================================
  // 1. Intercept Cordis `ctx.events.dispatch(type, args)` to isolate incognito events
  // ============================================================================
  function wrapEventsService(eventsSvc) {
    if (!eventsSvc || typeof eventsSvc.dispatch !== 'function' || wrappedObjects.has(eventsSvc)) return
    wrappedObjects.add(eventsSvc)

    const origDispatch = eventsSvc.dispatch.bind(eventsSvc)
    eventsSvc.dispatch = function incognitoGuardedDispatch(dispatchMode, args) {
      if (!Array.isArray(args) || args.length === 0) {
        return origDispatch(dispatchMode, args)
      }

      const hasThisArg = typeof args[0] === 'object' || typeof args[0] === 'function'
      const eventName = hasThisArg ? args[1] : args[0]
      const payload0 = hasThisArg ? args[2] : args[1]
      const payload1 = hasThisArg ? args[3] : args[2]

      if (typeof eventName !== 'string') {
        return origDispatch(dispatchMode, args)
      }

      const dispatchWithFilteredHooks = (predicate) => {
        const currentHooks = eventsSvc._hooks?.[eventName]
        if (!Array.isArray(currentHooks) || currentHooks.length === 0) {
          return origDispatch(dispatchMode, args)
        }
        const savedHooks = currentHooks
        eventsSvc._hooks[eventName] = currentHooks.filter(predicate)
        try {
          return origDispatch(dispatchMode, args)
        } finally {
          eventsSvc._hooks[eventName] = savedHooks
        }
      }

      if (eventName === 'session/flush') {
        const targetId = typeof payload0 === 'string' ? payload0 : payload0?.id
        if (typeof targetId === 'string' && isHiddenSession(targetId)) {
          return dispatchWithFilteredHooks(() => false)
        }
      }

      if (eventName === 'api-session/added' || eventName === 'api-session/activity') {
        const targetId = payload0?.id ?? payload0?.session?.id
        if (typeof targetId === 'string' && isHiddenSession(targetId)) {
          return dispatchWithFilteredHooks(() => false)
        }
      }

      if (eventName === 'session/telemetry' || eventName === 'session/title') {
        const targetId = typeof payload0 === 'string'
          ? payload0
          : (payload0?.id ?? payload0?.sessionId ?? payload0?.session?.id)
        if (typeof targetId === 'string' && isHiddenSession(targetId)) {
          return dispatchWithFilteredHooks(() => false)
        }
      }

      if (eventName === 'agent/pre-step') {
        const sessionId = payload0?.agent?.session?.id ?? payload0?.session?.id
        if (typeof sessionId === 'string' && isActiveIncognito(sessionId)) {
          markIncognitoEngaged(sessionId)
        }
      }

      if (eventName === 'session/event' || eventName === 'session/created' || eventName === 'session/disposed') {
        const session = payload0
        const sessionId = session?.id
        if (typeof sessionId === 'string') {
          guardSessionInstance(session)
          if (eventName === 'session/event' && isActiveIncognito(sessionId) && isConversationEvent(payload1)) {
            markIncognitoEngaged(sessionId)
          }
          if (isHiddenSession(sessionId)) {
            return dispatchWithFilteredHooks((hook) => {
              const cb = hook?.callback
              if (typeof cb !== 'function') return false
              if (cb._incognitoAllowHook === true) return true
              const src = Function.prototype.toString.call(cb)
              if (eventName === 'session/event') {
                if (src.includes('applySessionEvent') || src.includes('this.entries.get(session.id)')) {
                  return true
                }
                if (
                  !destroyingInFlightIds.has(sessionId)
                  && (src.includes("kind: 'event'") || src.includes('kind: "event"') || src.includes('onEvent(event)'))
                ) {
                  return true
                }
                return false
              }
              if (eventName === 'session/created') {
                if (src.includes('permission/') || src.includes('this.entries')) {
                  return true
                }
                return false
              }
              if (eventName === 'session/disposed') {
                if (
                  src.includes('this.entries.delete')
                  || src.includes('this.handles.delete')
                  || src.includes('this.sessions.delete')
                ) {
                  return true
                }
                return false
              }
              return false
            })
          }
        }
      }

      return origDispatch(dispatchMode, args)
    }
  }

  wrapEventsService(ctx.events ?? ctx._events)

  const onSessionCreated = (session) => {
    if (!session || typeof session.id !== 'string') return
    guardSessionInstance(session)
    const parentId = session.header?.parentSession
    if (
      creatingIncognitoSessionId === session.id
      || (typeof parentId === 'string' && isHiddenSession(parentId))
    ) {
      if (!incognitoSessions.has(session.id)) {
        incognitoSessions.set(session.id, {
          sessionId: session.id,
          enabled: true,
          engaged: false,
          createdAt: Date.now(),
          workspaceId: undefined,
          cwd: session.header?.cwd,
          spillIds: new Set(),
          activeFollowers: 0,
          disconnectTimer: undefined,
        })
      }
      void purgeSessionPersistence(session.id)
      void purgeProjectionCache(session.id)
      emitApiSessionRemoved(session.id)
    }
  }
  onSessionCreated._incognitoAllowHook = true
  ctx.on('session/created', onSessionCreated)

  // ============================================================================
  // 2. Intercept `ctx.sessions` (`SessionStore`)
  // ============================================================================
  function wrapSessionsService(sessionsSvc) {
    if (!sessionsSvc || wrappedObjects.has(sessionsSvc)) return
    wrappedObjects.add(sessionsSvc)

    if (sessionsSvc.store instanceof Map) {
      for (const entry of sessionsSvc.store.values()) {
        if (entry?.session) guardSessionInstance(entry.session)
      }
    }

    if (typeof sessionsSvc.prepare === 'function') {
      const origPrepare = sessionsSvc.prepare.bind(sessionsSvc)
      sessionsSvc.prepare = function incognitoGuardedSessionPrepare(id, options) {
        const parentId = options?.meta?.parentSession
        const shouldStartIncognito =
          stagedForNextSession || (typeof parentId === 'string' && isHiddenSession(parentId))
        if (stagedForNextSession && !parentId) {
          stagedForNextSession = false
        }
        const session = origPrepare(id, options)
        guardSessionInstance(session)
        if (shouldStartIncognito && session?.id) {
          incognitoSessions.set(session.id, {
            sessionId: session.id,
            enabled: true,
            engaged: false,
            createdAt: Date.now(),
            workspaceId: undefined,
            cwd: session.header?.cwd,
            spillIds: new Set(),
            activeFollowers: 0,
            disconnectTimer: undefined,
          })
        }
        return session
      }
    }

    if (typeof sessionsSvc.enter === 'function') {
      const origEnter = sessionsSvc.enter.bind(sessionsSvc)
      sessionsSvc.enter = function incognitoGuardedSessionEnter(session) {
        guardSessionInstance(session)
        const detach = origEnter(session)
        if (session?.id && !handlesBySessionId.has(session.id)) {
          handlesBySessionId.set(session.id, {
            session,
            dispose: detach,
          })
        }
        return detach
      }
    }

    if (typeof sessionsSvc.flush === 'function') {
      const origFlush = sessionsSvc.flush.bind(sessionsSvc)
      sessionsSvc.flush = async function incognitoGuardedSessionStoreFlush(session) {
        if (isHiddenSession(session?.id)) {
          return false
        }
        return origFlush(session)
      }
    }

    if (typeof sessionsSvc.list === 'function') {
      const origList = sessionsSvc.list.bind(sessionsSvc)
      sessionsSvc.list = function incognitoGuardedSessionList(...args) {
        const all = origList(...args)
        if (!Array.isArray(all)) return all
        return all.filter(s => !isHiddenSession(s?.id))
      }
    }

    if (typeof sessionsSvc.get === 'function') {
      const origGet = sessionsSvc.get.bind(sessionsSvc)
      sessionsSvc._incognitoOrigGet = origGet
      sessionsSvc.get = function incognitoGuardedSessionGet(sessionId) {
        const session = origGet(sessionId)
        if (session) guardSessionInstance(session)
        if (!isActiveIncognito(sessionId)) {
          return session
        }
        if (authorizedInternalLookupDepth > 0 || authorizedUiReadDepth > 0) {
          return session
        }
        const stack = new Error().stack ?? ''
        if (
          stack.includes('session-query')
          || stack.includes('SessionCorpus')
          || stack.includes('SessionObservationReader')
          || stack.includes('session-reference')
          || stack.includes('SessionReferenceResolver')
          || stack.includes('session-log-export')
          || stack.includes('session-telemetry')
          || stack.includes('session-title')
          || stack.includes('SessionListController')
        ) {
          return undefined
        }
        if (
          stack.includes('SessionAgentRegistry')
          || stack.includes('ApiSessionAgentController')
          || stack.includes('SessionCommandController')
          || stack.includes('CommandRuntime')
          || stack.includes('AgentLoop')
          || stack.includes('ReactLoopAgent')
        ) {
          return session
        }
        return undefined
      }
    }

    if (typeof sessionsSvc.fork === 'function') {
      const origFork = sessionsSvc.fork.bind(sessionsSvc)
      sessionsSvc.fork = function incognitoGuardedSessionFork(source, ...rest) {
        const sourceId = typeof source === 'string' ? source : source?.id
        if (isHiddenSession(sourceId)) {
          throw new IncognitoError(
            'incognito/forbidden-operation',
            '无痕会话不支持分支复制（fork）。 / Incognito sessions cannot be forked.',
            { sessionId: sourceId },
          )
        }
        return origFork(source, ...rest)
      }
    }
  }

  wrapSessionsService(ctx.get('sessions'))
  ctx.inject(['sessions'], (c) => wrapSessionsService(c.sessions))

  // ============================================================================
  // 3. Intercept `ctx.sessionPersistence` (`JsonlSessionPersistence`)
  // ============================================================================
  function wrapSessionPersistence(persistence) {
    if (!persistence || wrappedObjects.has(persistence)) return
    wrappedObjects.add(persistence)

    const origCreate = persistence.create?.bind(persistence)
    const origOpen = persistence.open?.bind(persistence)
    const origStat = persistence.stat?.bind(persistence)
    const origList = persistence.list?.bind(persistence)
    const origFlush = persistence.flush?.bind(persistence)
    const origPersistBatch = persistence.persistBatch?.bind(persistence)
    const origPersistHeader = persistence.persistHeader?.bind(persistence)
    const origAcquireWriteLease = persistence.acquireWriteLease?.bind(persistence)

    persistence._incognitoOrigCreate = origCreate
    persistence._incognitoOrigOpen = origOpen
    persistence._incognitoOrigStat = origStat
    persistence._incognitoOrigPersistBatch = origPersistBatch

    function createInertHandle(header, inheritedEventCount = 0) {
      return {
        id: header?.id,
        header,
        access: 'write',
        inheritedEventCount,
        async read() {
          return { eventState: 'detached', events: [] }
        },
        async append() {},
        async flush() {},
        async close() {},
      }
    }

    if (typeof origCreate === 'function') {
      persistence.create = async function incognitoGuardedPersistenceCreate(header, options, ...rest) {
        const sessionId = header?.id
        const parentId = header?.parentSession
        if (
          isHiddenSession(sessionId)
          || (typeof parentId === 'string' && isHiddenSession(parentId))
        ) {
          return createInertHandle(header, options?.inheritedEventCount ?? 0)
        }
        return origCreate(header, options, ...rest)
      }
    }

    if (typeof origAcquireWriteLease === 'function') {
      persistence.acquireWriteLease = async function incognitoGuardedAcquireWriteLease(header, ...rest) {
        const sessionId = typeof header === 'string' ? header : header?.id
        if (isHiddenSession(sessionId)) {
          return {
            async release() {},
            [Symbol.dispose]() {},
            async [Symbol.asyncDispose]() {},
          }
        }
        return origAcquireWriteLease(header, ...rest)
      }
    }

    if (typeof origPersistBatch === 'function') {
      persistence.persistBatch = async function incognitoGuardedPersistBatch(header, events, ...rest) {
        const sessionId = typeof header === 'string' ? header : header?.id
        if (isHiddenSession(sessionId)) return
        return origPersistBatch(header, events, ...rest)
      }
    }

    if (typeof origPersistHeader === 'function') {
      persistence.persistHeader = async function incognitoGuardedPersistHeader(header, ...rest) {
        const sessionId = typeof header === 'string' ? header : header?.id
        if (isHiddenSession(sessionId)) return
        return origPersistHeader(header, ...rest)
      }
    }

    if (typeof origFlush === 'function') {
      persistence.flush = async function incognitoGuardedFlush(sessionId, ...rest) {
        if (typeof sessionId === 'string' && isHiddenSession(sessionId)) return
        return origFlush(sessionId, ...rest)
      }
    }

    if (typeof origOpen === 'function') {
      persistence.open = async function incognitoGuardedOpen(sessionId, ...rest) {
        if (isHiddenSession(sessionId)) {
          await purgeSessionPersistence(sessionId)
        }
        return origOpen(sessionId, ...rest)
      }
    }

    if (typeof origStat === 'function') {
      persistence.stat = async function incognitoGuardedStat(sessionId, ...rest) {
        if (isHiddenSession(sessionId)) {
          await purgeSessionPersistence(sessionId)
          return undefined
        }
        return origStat(sessionId, ...rest)
      }
    }

    if (typeof origList === 'function') {
      persistence.list = async function incognitoGuardedList(...args) {
        const items = await origList(...args)
        if (!Array.isArray(items)) return items
        return items.filter(item => !isHiddenSession(item?.id ?? item?.header?.id))
      }
    }
  }

  wrapSessionPersistence(ctx.get('sessionPersistence'))
  ctx.inject(['sessionPersistence'], (c) => wrapSessionPersistence(c.sessionPersistence))

  // ============================================================================
  // 4. Intercept `ctx.sessionProjectionCache` (durable projection cache)
  // ============================================================================
  function wrapSessionProjectionCache(cache) {
    if (!cache || wrappedObjects.has(cache)) return
    wrappedObjects.add(cache)

    if (typeof cache.write === 'function') {
      const origWrite = cache.write.bind(cache)
      cache.write = async function incognitoGuardedCacheWrite(sessionId, ...rest) {
        if (isHiddenSession(sessionId)) {
          cache.dirty?.delete?.(sessionId)
          return
        }
        return origWrite(sessionId, ...rest)
      }
    }

    if (typeof cache.put === 'function') {
      const origPut = cache.put.bind(cache)
      cache.put = async function incognitoGuardedCachePut(sessionId, ...rest) {
        if (isHiddenSession(sessionId)) return
        return origPut(sessionId, ...rest)
      }
    }

    if (typeof cache.cachedSnapshot === 'function') {
      const origCachedSnapshot = cache.cachedSnapshot.bind(cache)
      cache.cachedSnapshot = async function incognitoGuardedCachedSnapshot(sessionId, ...rest) {
        if (isHiddenSession(sessionId)) return undefined
        return origCachedSnapshot(sessionId, ...rest)
      }
    }

    if (typeof cache.cachedPredecessorTitle === 'function') {
      const origPredecessorTitle = cache.cachedPredecessorTitle.bind(cache)
      cache.cachedPredecessorTitle = async function incognitoGuardedPredecessorTitle(sessionId, ...rest) {
        if (isHiddenSession(sessionId)) return undefined
        return origPredecessorTitle(sessionId, ...rest)
      }
    }
  }

  wrapSessionProjectionCache(ctx.get('sessionProjectionCache'))
  ctx.inject(['sessionProjectionCache'], (c) => wrapSessionProjectionCache(c.sessionProjectionCache))

  // ============================================================================
  // 5. Intercept `ctx.sessionQuery` (`SessionQueryEngine` & SQLite FTS)
  // ============================================================================
  function wrapSessionQuery(query) {
    if (!query || wrappedObjects.has(query)) return
    wrappedObjects.add(query)

    if (typeof query.readSession === 'function') {
      query._incognitoOrigReadSession = query.readSession.bind(query)
    }

    if (typeof query.searchSessions === 'function') {
      const origSearchSessions = query.searchSessions.bind(query)
      query.searchSessions = async function incognitoGuardedSearchSessions(request, ...rest) {
        const res = await origSearchSessions(request, ...rest)
        if (res && Array.isArray(res.items)) {
          return {
            ...res,
            items: res.items.filter(
              item => !isHiddenSession(item?.session?.id ?? item?.sessionId ?? item?.id ?? item?.header?.id),
            ),
          }
        }
        return res
      }
    }

    if (typeof query.searchEvents === 'function') {
      const origSearchEvents = query.searchEvents.bind(query)
      query.searchEvents = async function incognitoGuardedSearchEvents(request, ...rest) {
        const targetId = request?.sessionId
        if (typeof targetId === 'string' && isHiddenSession(targetId)) {
          throw await createQueryNotFoundError(targetId)
        }
        return origSearchEvents(request, ...rest)
      }
    }

    if (typeof query.listSessions === 'function') {
      const origListSessions = query.listSessions.bind(query)
      query.listSessions = async function incognitoGuardedListSessions(...args) {
        const records = await origListSessions(...args)
        if (!Array.isArray(records)) return records
        return records.filter(r => !isHiddenSession(r?.header?.id ?? r?.id))
      }
    }

    if (typeof query.filterSessions === 'function') {
      const origFilterSessions = query.filterSessions.bind(query)
      query.filterSessions = async function incognitoGuardedFilterSessions(...args) {
        const records = await origFilterSessions(...args)
        if (!Array.isArray(records)) return records
        return records.filter(r => !isHiddenSession(r?.header?.id ?? r?.id))
      }
    }

    const byIdMethods = [
      'readSession',
      'readSurface',
      'listEvents',
      'filterEvents',
      'readTitle',
      'readTitleSnapshot',
      'traceSession',
    ]
    for (const method of byIdMethods) {
      if (typeof query[method] !== 'function') continue
      const orig = query[method].bind(query)
      query[method] = async function incognitoGuardedByIdMethod(sessionId, ...rest) {
        if (isActiveIncognito(sessionId)) {
          if (method === 'readSurface' && authorizedUiReadDepth > 0) {
            return orig(sessionId, ...rest)
          }
          throw await createQueryNotFoundError(sessionId)
        }
        return orig(sessionId, ...rest)
      }
    }

    const byRequestMethods = ['traceEvent', 'readEvent']
    for (const method of byRequestMethods) {
      if (typeof query[method] !== 'function') continue
      const orig = query[method].bind(query)
      query[method] = async function incognitoGuardedByRequestMethod(request, ...rest) {
        const sessionId = typeof request === 'string' ? request : request?.sessionId
        if (typeof sessionId === 'string' && isHiddenSession(sessionId)) {
          throw await createQueryNotFoundError(sessionId)
        }
        return orig(request, ...rest)
      }
    }

    if (typeof query.readTitleSnapshots === 'function') {
      const origReadTitles = query.readTitleSnapshots.bind(query)
      query.readTitleSnapshots = async function incognitoGuardedReadTitles(sessionIds, ...rest) {
        const results = await origReadTitles(sessionIds, ...rest)
        if (!Array.isArray(results)) return results
        return Promise.all(
          results.map(async (item) => {
            if (item && isHiddenSession(item.sessionId)) {
              return {
                sessionId: item.sessionId,
                status: 'rejected',
                reason: await createQueryNotFoundError(item.sessionId),
              }
            }
            return item
          }),
        )
      }
    }

    if (typeof query.observeSession === 'function') {
      const origObserve = query.observeSession.bind(query)
      query.observeSession = async function incognitoGuardedObserveSession(sessionId, ...rest) {
        if (isActiveIncognito(sessionId) && authorizedUiReadDepth === 0) {
          throw await createQueryNotFoundError(sessionId)
        }
        return origObserve(sessionId, ...rest)
      }
    }
  }

  wrapSessionQuery(ctx.get('sessionQuery'))
  ctx.inject(['sessionQuery'], (c) => wrapSessionQuery(c.sessionQuery))

  // ============================================================================
  // 6. Intercept `ctx.agentLoop` & `ctx.agents` to capture AgentHandles
  // ============================================================================
  function wrapAgentLoop(agentLoop) {
    if (!agentLoop || wrappedObjects.has(agentLoop)) return
    wrappedObjects.add(agentLoop)

    if (typeof agentLoop.prepare === 'function') {
      const origPrepare = agentLoop.prepare.bind(agentLoop)
      agentLoop.prepare = function incognitoGuardedPrepare(
        ownerCtx,
        id,
        options,
        session,
        callerSignal,
        handle,
        parentAgent,
      ) {
        if (session) guardSessionInstance(session)
        const prepared = origPrepare(ownerCtx, id, options, session, callerSignal, handle, parentAgent)
        if (typeof id === 'string' && prepared) {
          handlesBySessionId.set(id, {
            agent: prepared.agent,
            session,
            dispose: prepared.dispose,
          })
          const parentId = parentAgent?.session?.id ?? session?.header?.parentSession
          if (typeof parentId === 'string' && isHiddenSession(parentId) && !incognitoSessions.has(id)) {
            incognitoSessions.set(id, {
              sessionId: id,
              enabled: true,
              engaged: false,
              createdAt: Date.now(),
              workspaceId: undefined,
              cwd: session?.header?.cwd,
              spillIds: new Set(),
              activeFollowers: 0,
              disconnectTimer: undefined,
            })
            void purgeSessionPersistence(id)
            void purgeProjectionCache(id)
          }
        }
        return prepared
      }
    }

    if (typeof agentLoop.createAgent === 'function') {
      const origCreateAgent = agentLoop.createAgent.bind(agentLoop)
      agentLoop.createAgent = async function incognitoGuardedCreateAgent(ownerCtx, options) {
        const actualOptions = options ?? ownerCtx
        const requestedId = actualOptions?.sessionId
        const parentId = actualOptions?.parentAgent?.session?.id ?? actualOptions?.meta?.parentSession
        const shouldBeIncognito =
          stagedForNextSession
          || (typeof requestedId === 'string' && isActiveIncognito(requestedId))
          || (typeof parentId === 'string' && isHiddenSession(parentId))

        if (stagedForNextSession && !parentId) {
          stagedForNextSession = false
        }

        const prevCreating = creatingIncognitoSessionId
        if (shouldBeIncognito && typeof requestedId === 'string') {
          creatingIncognitoSessionId = requestedId
        }
        let handle
        try {
          handle = await origCreateAgent(ownerCtx, options)
        } finally {
          creatingIncognitoSessionId = prevCreating
        }

        const session = handle?.agent?.session
        const sessionId = session?.id ?? handle?.agent?.id
        if (session) guardSessionInstance(session)
        if (typeof sessionId === 'string') {
          handlesBySessionId.set(sessionId, {
            agent: handle?.agent,
            session,
            dispose: handle?.dispose,
          })
          if (shouldBeIncognito) {
            if (!incognitoSessions.has(sessionId)) {
              incognitoSessions.set(sessionId, {
                sessionId,
                enabled: true,
                engaged: false,
                createdAt: Date.now(),
                workspaceId: undefined,
                cwd: session?.header?.cwd,
                spillIds: new Set(),
                activeFollowers: 0,
                disconnectTimer: undefined,
              })
            }
            await Promise.all([
              purgeSessionPersistence(sessionId),
              purgeProjectionCache(sessionId),
              purgeWorkspaceMembership(sessionId),
            ])
            emitApiSessionRemoved(sessionId)
          }
        }
        return handle
      }
    }

    if (typeof agentLoop.resume === 'function') {
      const origResume = agentLoop.resume.bind(agentLoop)
      agentLoop.resume = async function incognitoGuardedResume(ownerCtx, options) {
        const actualOptions = options ?? ownerCtx
        const targetId = actualOptions?.resumeSessionId ?? actualOptions?.sessionId
        if (typeof targetId === 'string' && isHiddenSession(targetId)) {
          throw await createPersistenceNotFoundError(targetId)
        }
        return origResume(ownerCtx, options)
      }
    }
  }

  wrapAgentLoop(ctx.get('agentLoop'))
  ctx.inject(['agentLoop'], (c) => wrapAgentLoop(c.agentLoop))

  function wrapAgentsService(agentsSvc) {
    if (!agentsSvc || wrappedObjects.has(agentsSvc)) return
    wrappedObjects.add(agentsSvc)

    if (typeof agentsSvc.resume === 'function') {
      const origResume = agentsSvc.resume.bind(agentsSvc)
      agentsSvc.resume = async function incognitoGuardedAgentsResume(options = {}) {
        const targetId = options?.resumeSessionId ?? options?.sessionId
        if (typeof targetId === 'string' && isHiddenSession(targetId)) {
          throw await createPersistenceNotFoundError(targetId)
        }
        return origResume(options)
      }
    }

    if (typeof agentsSvc.get === 'function') {
      const origGet = agentsSvc.get.bind(agentsSvc)
      agentsSvc._incognitoOrigGet = origGet
    }
  }

  wrapAgentsService(ctx.get('agents'))
  ctx.inject(['agents'], (c) => wrapAgentsService(c.agents))

  // ============================================================================
  // 7. Intercept `ctx.workspaceRegistry` so incognito sessions never attach on disk
  // ============================================================================
  function wrapWorkspaceEntity(ws) {
    if (!ws || typeof ws !== 'object' || wrappedObjects.has(ws)) return ws
    wrappedObjects.add(ws)

    if (typeof ws.attachSession === 'function') {
      const origAttach = ws.attachSession.bind(ws)
      ws.attachSession = async function incognitoGuardedAttachSession(sessionId, ...rest) {
        if (isHiddenSession(sessionId)) {
          const entry = incognitoSessions.get(sessionId)
          if (entry && !entry.workspaceId) {
            entry.workspaceId = String(ws.id)
          }
          return
        }
        return origAttach(sessionId, ...rest)
      }
    }
    return ws
  }

  function wrapWorkspaceRegistry(registry) {
    if (!registry || wrappedObjects.has(registry)) return
    wrappedObjects.add(registry)

    if (typeof registry.list === 'function') {
      const origList = registry.list.bind(registry)
      for (const ws of origList()) {
        wrapWorkspaceEntity(ws)
      }
      registry.list = function incognitoGuardedWorkspaceList(...args) {
        const list = origList(...args)
        if (Array.isArray(list)) {
          for (const ws of list) wrapWorkspaceEntity(ws)
        }
        return list
      }
    }

    if (typeof registry.get === 'function') {
      const origGet = registry.get.bind(registry)
      registry.get = function incognitoGuardedWorkspaceGet(id, ...rest) {
        return wrapWorkspaceEntity(origGet(id, ...rest))
      }
    }

    if (typeof registry.rememberSessionPath === 'function') {
      const origRemember = registry.rememberSessionPath.bind(registry)
      registry.rememberSessionPath = function incognitoGuardedRememberPath(sessionId, cwd) {
        if (isHiddenSession(sessionId)) return
        return origRemember(sessionId, cwd)
      }
    }
  }

  wrapWorkspaceRegistry(ctx.get('workspaceRegistry'))
  ctx.inject(['workspaceRegistry'], (c) => wrapWorkspaceRegistry(c.workspaceRegistry))

  // ============================================================================
  // 8. Intercept `ctx.spillStore` to track and clean up spilled tool outputs
  // ============================================================================
  function wrapSpillStore(spillStore) {
    if (!spillStore || wrappedObjects.has(spillStore)) return
    wrappedObjects.add(spillStore)

    if (typeof spillStore.write === 'function') {
      const origWrite = spillStore.write.bind(spillStore)
      spillStore.write = async function incognitoGuardedSpillWrite(content, options, ...rest) {
        const result = await origWrite(content, options, ...rest)
        const spillId = typeof result === 'string' ? result : result?.id ?? result?.spillId
        if (typeof spillId === 'string') {
          for (const entry of incognitoSessions.values()) {
            entry.spillIds.add(spillId)
          }
        }
        return result
      }
    }
  }

  wrapSpillStore(ctx.get('spillStore'))
  ctx.inject(['spillStore'], (c) => wrapSpillStore(c.spillStore))

  // ============================================================================
  // 9. Intercept `ctx.sessionController` (Remote BFF for Web & SDK clients)
  // ============================================================================
  function wrapSessionController(controller) {
    if (!controller || wrappedObjects.has(controller)) return
    wrappedObjects.add(controller)

    if (typeof controller.create === 'function') {
      const origCreate = controller.create.bind(controller)
      controller.create = async function incognitoGuardedControllerCreate(request, ...rest) {
        const requestedId = request?.sessionId
        for (const [existingId, entry] of [...incognitoSessions.entries()]) {
          if (existingId !== requestedId && entry.engaged) {
            await destroyIncognitoSession(existingId, 'new-session-created')
          }
        }
        authorizedInternalLookupDepth++
        try {
          return await origCreate(request, ...rest)
        } finally {
          authorizedInternalLookupDepth--
        }
      }
    }

    const activeSessionVerbs = ['prompt', 'updateQueue', 'selectModel', 'executeCommand', 'attachment']
    for (const verb of activeSessionVerbs) {
      if (typeof controller[verb] !== 'function') continue
      const origVerb = controller[verb].bind(controller)
      controller[verb] = async function incognitoGuardedVerb(request, ...rest) {
        const sessionId = request?.sessionId ?? request?.id
        if (verb === 'prompt' && typeof sessionId === 'string' && isActiveIncognito(sessionId)) {
          markIncognitoEngaged(sessionId)
        }
        authorizedInternalLookupDepth++
        try {
          return await origVerb(request, ...rest)
        } finally {
          authorizedInternalLookupDepth--
        }
      }
    }

    if (typeof controller.cancel === 'function') {
      const origCancel = controller.cancel.bind(controller)
      controller.cancel = async function incognitoGuardedCancel(request, ...rest) {
        const sessionId = request?.sessionId ?? request?.id
        if (typeof sessionId === 'string' && isActiveIncognito(sessionId)) {
          authorizedInternalLookupDepth++
          try {
            try {
              await origCancel(request, ...rest)
            } catch {
              // Ignore if agent was idle when cancel was requested.
            }
          } finally {
            authorizedInternalLookupDepth--
          }
          await destroyIncognitoSession(sessionId, 'session-cancelled')
          return { accepted: true }
        }
        return origCancel(request, ...rest)
      }
    }

    if (typeof controller.fork === 'function') {
      const origFork = controller.fork.bind(controller)
      controller.fork = async function incognitoGuardedControllerFork(request, ...rest) {
        const sessionId = request?.sessionId ?? request?.id
        if (typeof sessionId === 'string' && isHiddenSession(sessionId)) {
          throw new IncognitoError(
            'incognito/forbidden-operation',
            '无痕会话不支持分支复制（fork）。 / Incognito sessions cannot be forked.',
            { sessionId },
          )
        }
        return origFork(request, ...rest)
      }
    }

    if (typeof controller.page === 'function') {
      const origPage = controller.page.bind(controller)
      controller.page = async function incognitoGuardedPage(request, ...rest) {
        const sessionId = request?.sessionId ?? request?.id
        if (typeof sessionId === 'string' && isActiveIncognito(sessionId)) {
          authorizedUiReadDepth++
          authorizedInternalLookupDepth++
          try {
            return await origPage(request, ...rest)
          } finally {
            authorizedUiReadDepth--
            authorizedInternalLookupDepth--
          }
        }
        return origPage(request, ...rest)
      }
    }

    if (typeof controller.follow === 'function') {
      const origFollow = controller.follow.bind(controller)
      controller.follow = async function* incognitoGuardedFollow(request, signal, ...rest) {
        const sessionId = request?.sessionId ?? request?.id

        if (typeof sessionId === 'string') {
          for (const [otherId, otherEntry] of [...incognitoSessions.entries()]) {
            if (otherId !== sessionId && (otherEntry.engaged || !isActiveIncognito(sessionId))) {
              await destroyIncognitoSession(otherId, 'switched-to-another-session')
            }
          }
        }

        const entry = typeof sessionId === 'string' ? incognitoSessions.get(sessionId) : undefined
        if (entry) {
          entry.activeFollowers++
          if (entry.disconnectTimer !== undefined) {
            clearTimeout(entry.disconnectTimer)
            entry.disconnectTimer = undefined
          }
        }

        let iterator
        authorizedUiReadDepth++
        authorizedInternalLookupDepth++
        try {
          const iterable = origFollow(request, signal, ...rest)
          iterator = iterable[Symbol.asyncIterator]()
        } finally {
          authorizedUiReadDepth--
          authorizedInternalLookupDepth--
        }

        try {
          while (true) {
            authorizedUiReadDepth++
            authorizedInternalLookupDepth++
            let step
            try {
              step = await iterator.next()
            } finally {
              authorizedUiReadDepth--
              authorizedInternalLookupDepth--
            }
            if (step.done) break
            if (typeof sessionId === 'string' && destroyingInFlightIds.has(sessionId)) {
              break
            }
            yield step.value
          }
        } finally {
          authorizedUiReadDepth++
          authorizedInternalLookupDepth++
          try {
            await iterator?.return?.()
          } catch {
            // Ignore generator teardown errors.
          } finally {
            authorizedUiReadDepth--
            authorizedInternalLookupDepth--
          }

          const currentEntry = typeof sessionId === 'string' ? incognitoSessions.get(sessionId) : undefined
          if (currentEntry) {
            currentEntry.activeFollowers = Math.max(0, currentEntry.activeFollowers - 1)
            if (currentEntry.activeFollowers === 0 && currentEntry.engaged) {
              currentEntry.disconnectTimer = setTimeout(() => {
                if (currentEntry.activeFollowers === 0 && incognitoSessions.has(sessionId)) {
                  void destroyIncognitoSession(sessionId, 'stream-disconnected')
                }
              }, 150)
              currentEntry.disconnectTimer.unref?.()
            }
          }
        }
      }
    }
  }

  wrapSessionController(ctx.get('sessionController'))
  ctx.inject(['sessionController'], (c) => wrapSessionController(c.sessionController))

  // ============================================================================
  // 10. Register `/incognito` slash command via `ctx.commands`
  // ============================================================================
  function registerIncognitoCommand(commandsSvc) {
    if (!commandsSvc || typeof commandsSvc.register !== 'function' || wrappedObjects.has(commandsSvc)) return
    wrappedObjects.add(commandsSvc)

    if (typeof commandsSvc.execute === 'function') {
      const origExecute = commandsSvc.execute.bind(commandsSvc)
      commandsSvc.execute = async function incognitoGuardedCommandExecute(
        agent,
        line,
        submittedAttachments = [],
        signal = AbortSignal.timeout(30_000),
      ) {
        const isIncognitoLine = typeof line === 'string' && /^\/?incognito(?:\s|$)/iu.test(line.trim())
        if (isIncognitoLine) {
          activeIncognitoCommandDepth++
          authorizedInternalLookupDepth++
          try {
            return await origExecute(agent, line, submittedAttachments, signal)
          } finally {
            activeIncognitoCommandDepth--
            authorizedInternalLookupDepth--
          }
        }
        return origExecute(agent, line, submittedAttachments, signal)
      }
    }

    commandsSvc.register({
      name: 'incognito',
      description: '开启、查询或结束无痕浏览模式（仅限对话开始前开启，取消或结束即彻底硬删除且不可恢复） / Enable, inspect, or end Incognito Mode',
      input: {
        hint: 'on | off | toggle | end | cancel | status',
      },
      recordInput: false,
      async handler({ agent, rawInput }) {
        const sessionId = agent?.session?.id
        const rawAction = String(rawInput ?? '').trim().toLowerCase()
        const action = rawAction || 'toggle'

        if (!sessionId) {
          return {
            kind: 'error',
            text: '无法获取当前会话 ID。 / Unable to resolve current session ID.',
          }
        }

        if (action === 'status') {
          const st = getStatus(sessionId)
          if (st.destroyed) {
            return {
              kind: 'success',
              text: '当前无痕会话已被彻底硬删除且无法恢复。 / This incognito session has been permanently hard-deleted and cannot be recovered.',
            }
          }
          if (st.enabled) {
            return {
              kind: 'success',
              text: st.locked
                ? '🕶️ 无痕浏览已开启并锁定（对话进行中）：内容不会进入历史或日志，取消或离开后将立即彻底硬删除。 / Incognito mode is ON and locked.'
                : '🕶️ 无痕浏览已开启（等待首条消息）：发送消息后将锁定无痕状态，内容绝不写入历史或日志。 / Incognito mode is ON (pre-conversation).',
            }
          }
          return {
            kind: 'success',
            text: st.locked
              ? '当前会话已开始普通对话，无法在中途开启无痕浏览。 / Conversation already started; Incognito mode cannot be enabled mid-conversation.'
              : '当前为普通会话模式（发送消息前可通过 /incognito on 开启无痕浏览）。 / Standard mode (use /incognito on before starting the conversation).',
          }
        }

        if (action === 'end' || action === 'cancel' || action === 'close' || action === 'destroy') {
          if (!isActiveIncognito(sessionId)) {
            return {
              kind: 'error',
              text: '当前会话未开启无痕浏览。 / Current session is not in Incognito mode.',
            }
          }
          await destroyIncognitoSession(sessionId, 'slash-command-end')
          return {
            kind: 'success',
            text: '🕶️ 无痕会话已永久取消并彻底硬删除，所有内存上下文与会话记录已清空且无法恢复。 / Incognito session permanently cancelled and hard-deleted.',
          }
        }

        if (action === 'on' || action === 'enable' || action === 'start') {
          await enableIncognito(sessionId)
          return {
            kind: 'success',
            text: '🕶️ 已开启无痕浏览：当前对话内容将完全不会进入历史、无法被任何历史提取插件读取、不会写入 session log，取消或离开后将立即彻底硬删除且不可恢复。 / Incognito mode enabled.',
          }
        }

        if (action === 'off' || action === 'disable') {
          await disableIncognito(sessionId)
          return {
            kind: 'success',
            text: '已关闭无痕浏览（当前尚未开始对话，已恢复为普通会话）。 / Incognito mode disabled before conversation start.',
          }
        }

        if (action === 'toggle') {
          const st = await toggleIncognito(sessionId)
          return {
            kind: 'success',
            text: st.enabled
              ? '🕶️ 已开启无痕浏览：当前对话内容将完全不会进入历史、无法被任何历史提取插件读取、不会写入 session log，取消或离开后将立即彻底硬删除且不可恢复。 / Incognito mode enabled.'
              : '已关闭无痕浏览（当前尚未开始对话，已恢复为普通会话）。 / Incognito mode disabled.',
          }
        }

        throw new IncognitoError(
          'incognito/invalid-command-action',
          `未知的 /incognito 参数 "${action}"，可用值：on | off | toggle | end | status`,
        )
      },
    })
  }

  registerIncognitoCommand(ctx.get('commands'))
  ctx.inject(['commands'], (c) => registerIncognitoCommand(c.commands))

  // ============================================================================
  // 11. Register `/api/incognito` HTTP route for the Web Client UI
  // ============================================================================
  async function handleIncognitoHttpRequest(methodRaw, urlStr, readBodyText) {
    const url = new URL(urlStr, 'http://localhost')
    const method = String(methodRaw || 'GET').toUpperCase()
    try {
      if (method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        return { status: 200, body: { ok: true, ...getStatus(sessionId) } }
      }

      let body = {}
      try {
        const text = await readBodyText()
        if (typeof text === 'string' && text.trim().length > 0) body = JSON.parse(text)
      } catch {
        // Empty or non-JSON body; fall back to query params.
      }

      const sessionId = body.sessionId ?? url.searchParams.get('sessionId') ?? undefined
      const action = body.action ?? url.searchParams.get('action') ?? (method === 'DELETE' ? 'destroy' : 'toggle')

      if (action === 'stage') {
        return { status: 200, body: { ok: true, ...setStagedForNextSession(Boolean(body.staged ?? true)) } }
      }

      if (action === 'destroy' || action === 'cancel' || action === 'end' || method === 'DELETE') {
        if (!sessionId) {
          const ids = [...incognitoSessions.keys()]
          for (const id of ids) {
            await destroyIncognitoSession(id, body.reason ?? 'http-destroy-all')
          }
          return { status: 200, body: { ok: true, destroyedIds: ids } }
        }
        const res = await destroyIncognitoSession(sessionId, body.reason ?? 'http-destroy')
        return { status: 200, body: { ok: true, ...res, ...getStatus(sessionId) } }
      }

      if (!sessionId) {
        return {
          status: 400,
          body: { ok: false, code: 'incognito/invalid-session', message: 'sessionId is required' },
        }
      }

      if (action === 'enable' || action === 'on') {
        const status = await enableIncognito(sessionId)
        return { status: 200, body: { ok: true, ...status } }
      }

      if (action === 'disable' || action === 'off') {
        const status = await disableIncognito(sessionId)
        return { status: 200, body: { ok: true, ...status } }
      }

      const status = await toggleIncognito(sessionId)
      return { status: 200, body: { ok: true, ...status } }
    } catch (error) {
      const code = error?.code ?? 'incognito/error'
      const message = error instanceof Error ? error.message : String(error)
      return { status: 409, body: { ok: false, code, message } }
    }
  }

  function registerWebServerRoute(webServer) {
    if (!webServer || typeof webServer.register !== 'function' || wrappedObjects.has(webServer)) return
    wrappedObjects.add(webServer)

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/incognito',
      async handler(req, res) {
        const result = await handleIncognitoHttpRequest(req.method, req.url ?? '/api/incognito', async () => {
          const chunks = []
          for await (const chunk of req) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
          }
          return Buffer.concat(chunks).toString('utf8')
        })
        res.statusCode = result.status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(result.body))
      },
    }), 'dsh-incognito.webserver-route')
  }

  registerWebServerRoute(ctx.get('webServer'))
  ctx.inject(['webServer'], (c) => registerWebServerRoute(c.webServer))

  function registerHttpRoute(connectionSvc) {
    if (!connectionSvc?.fetch?.register || wrappedObjects.has(connectionSvc)) return
    wrappedObjects.add(connectionSvc)

    ctx.effect(() => connectionSvc.fetch.register({
      path: '/api/incognito',
      methods: ['GET', 'POST', 'DELETE'],
      requestBody: 'buffered',
      async fetch(request) {
        const result = await handleIncognitoHttpRequest(
          request.method,
          request.url,
          () => request.text(),
        )
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        })
      },
    }), 'dsh-incognito.http-route')
  }

  registerHttpRoute(ctx.get('connection'))
  ctx.inject(['connection'], (c) => registerHttpRoute(c.connection))

  ctx.effect(() => () => {
    for (const [sessionId] of [...incognitoSessions.entries()]) {
      void destroyIncognitoSession(sessionId, 'plugin-dispose')
    }
  }, 'dsh-incognito.cleanup')
}

export default { name, apply }
