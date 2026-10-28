/**
 * dsh-session-search — Host half.
 *
 * Maintains a derived SQLite FTS5 index of every session's messages (the session
 * log stays the only source of truth) and serves a small JSON API for the Client
 * search panel:
 *
 *   GET  /.dsh-session-search/status    index state, build progress, counts
 *   GET  /.dsh-session-search/search    ?q=&kinds=&limit=&sessions=
 *   GET  /.dsh-session-search/sessions  most recent sessions (empty-state list)
 *   POST /.dsh-session-search/rebuild   drop and rebuild the index
 *
 * Robustness rules:
 *   - nothing here throws out of `apply`: initialization is asynchronous and
 *     failures become a reported `dbError` the panel renders;
 *   - `node:sqlite` and the session services are optional lookups, so the plugin
 *     stays loaded (and visible) on a Host that lacks them;
 *   - a corrupt index file is deleted and rebuilt once, automatically;
 *   - every session is indexed inside try/catch so one bad log cannot stop the
 *     build;
 *   - the first activation builds the whole index in the background; the panel
 *     shows progress and searches whatever is already indexed.
 */

import { mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROUTE_PREFIX = '/.dsh-session-search'
const STORAGE_DIR = 'storages'
const DB_FILE = 'session-search.sqlite'
const SCHEMA_VERSION = 5

const ALL_KINDS = ['user', 'assistant', 'system', 'tool', 'tool-result', 'reasoning']
const DEFAULT_KINDS = ['user', 'assistant']
const MAX_TEXT_CHARS = 20000
const MAX_TOOL_CHARS = 6000
const MAX_REASONING_CHARS = 8000
const SNIPPET_WIDTH = 22
const SNIPPET_TAIL = 110
// Ranking: recall top candidates, score them, return per-turn rows.
const RECALL_FTS = 300
const RECALL_LIKE = 2500
const FRESH_LAMBDA = 0.015
const LONG_MESSAGE = 4000
const LONG_FACTOR = 0.85
const EXACT_FACTOR = 1.05
const TITLE_BONUS = 0.06
const SCORE_WEIGHT = { relevance: 0.55, position: 0.15, type: 0.15, freshness: 0.15 }
const TYPE_SCORE = { user: 0.75, assistant: 0.5, tool: 0.2, 'tool-result': 0.2, reasoning: 0.2, system: 0.2 }
const SEARCH_SYNC_WAIT_MS = 3000
const DIRTY_DEBOUNCE_MS = 900
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL DEFAULT '',
  cwd        TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  stamp      TEXT NOT NULL DEFAULT '',
  msg_count  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT -1,
  kind       TEXT NOT NULL,
  time       INTEGER NOT NULL DEFAULT 0,
  turn       INTEGER NOT NULL DEFAULT 0,
  turn_time  INTEGER NOT NULL DEFAULT 0,
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(session_id, turn);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='', contentless_delete=1, tokenize='trigram'
);
`

export function apply(ctx) {
  const state = {
    disposed: false,
    initPromise: null,
    syncPromise: null,
    db: null,
    dbError: '',
    lastError: '',
    ready: false,
    readyIndex: false,
    building: false,
    progress: { done: 0, total: 0 },
    lastSyncAt: 0,
    lastBuildAt: 0,
    lastCompactAt: 0,
    failedSessions: 0,
    dirty: new Set(),
    dirtyTimer: null,
    interval: null,
    routeDisposer: null,
    routesReady: false,
    routesVia: '',
    searchCount: 0,
    dbPath: '',
  }

  // ── small utilities ─────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const errText = (error) => (error && error.message ? error.message : String(error))

  function safeGet(name) {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  function homeDir() {
    const homePaths = safeGet('homePaths')
    if (homePaths && typeof homePaths.home === 'string' && homePaths.home) return homePaths.home
    return process.env.DSH_HOME || join(homedir(), '.dsh')
  }

  function dbPath() {
    return join(homeDir(), STORAGE_DIR, DB_FILE)
  }

  function dbBytes() {
    let total = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += statSync(state.dbPath + suffix).size
      } catch {
        // missing sidecar files are normal
      }
    }
    return total
  }

  // ── database ────────────────────────────────────────────────────────────

  function tableExists(name) {
    try {
      return Boolean(state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))
    } catch {
      return false
    }
  }

  /**
   * Create or migrate the index schema.
   *
   * v3 added `turn`/`turn_time` so results can be grouped by conversation turn,
   * v4 added `reasoning` as an indexed kind, and v5 narrows the FTS index to
   * actual conversation (user/assistant): tool, reasoning and injected system
   * text are searched with LIKE only when the reader enables those sources.
   * That keeps the trigram index roughly two orders of magnitude smaller while
   * the default search stays on the fast path.
   */
  function applySchema() {
    let current = 0
    if (tableExists('meta')) {
      const row = state.db.prepare("SELECT value FROM meta WHERE key='schema'").get()
      current = row ? Number(row.value) || 0 : 0
    }
    if (current > 0 && current < SCHEMA_VERSION) {
      const columns = state.db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name)
      for (const name of ['turn', 'turn_time']) {
        if (!columns.includes(name)) {
          try {
            state.db.exec(`ALTER TABLE messages ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`)
          } catch {
            // a concurrent ALTER already applied it
          }
        }
      }
      if (current < 5) {
        try {
          state.db.exec('DROP TABLE IF EXISTS messages_fts')
        } catch {
          // the virtual table is recreated by SCHEMA_SQL below
        }
        try {
          state.db.exec('DROP INDEX IF EXISTS idx_messages_session')
        } catch {
          // the redundant index may already be gone
        }
      }
      // Every schema change so far also changes what the fold extracts, so a
      // full per-session re-index is required.
      try {
        state.db.exec("UPDATE sessions SET stamp = ''")
      } catch {
        // force-reindex is best effort; an empty index rebuilds anyway
      }
    }
    state.db.exec(SCHEMA_SQL)
    if (current !== SCHEMA_VERSION) {
      state.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema', ?)").run(String(SCHEMA_VERSION))
    }
  }

  function dropAllTables() {
    for (const name of ['messages_fts', 'messages', 'sessions', 'meta']) {
      try {
        state.db.exec(`DROP TABLE IF EXISTS ${name}`)
      } catch {
        // ignore: a partially created schema is exactly what this repairs
      }
    }
  }

  function closeDb() {
    if (!state.db) return
    try {
      state.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // best effort
    }
    try {
      state.db.close()
    } catch {
      // already closed
    }
    state.db = null
  }

  function resetDatabaseFiles() {
    closeDb()
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(state.dbPath + suffix, { force: true })
      } catch {
        // a locked file will fail the reopen and be reported
      }
    }
  }

  async function openDatabase({ fresh = false } = {}) {
    const sqlite = await import('node:sqlite')
    mkdirSync(join(homeDir(), STORAGE_DIR), { recursive: true, mode: 0o700 })
    state.dbPath = dbPath()
    if (fresh) resetDatabaseFiles()
    closeDb()
    state.db = new sqlite.DatabaseSync(state.dbPath)
    state.db.exec('PRAGMA journal_mode = WAL')
    state.db.exec('PRAGMA synchronous = NORMAL')
    state.db.exec('PRAGMA busy_timeout = 5000')
    state.db.exec('PRAGMA journal_size_limit = 16777216')
    applySchema()
  }

  function isEmptyIndex() {
    if (!state.db) return true
    try {
      return Number(state.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n) === 0
    } catch {
      return true
    }
  }

  // ── source of truth readers ─────────────────────────────────────────────

  function stampOf(snapshot) {
    if (typeof snapshot.eventCount === 'number' && typeof snapshot.sizeBytes === 'number') {
      return `c${snapshot.eventCount}:${snapshot.sizeBytes}`
    }
    if (snapshot.revision !== undefined && snapshot.revision !== null) return `r${String(snapshot.revision)}`
    return ''
  }

  async function listSessionMeta() {
    const persistence = safeGet('sessionPersistence')
    if (persistence && typeof persistence.list === 'function') {
      const snapshots = await persistence.list()
      return (snapshots || [])
        .map((snapshot) => ({
          id: snapshot && snapshot.header && typeof snapshot.header.id === 'string' ? snapshot.header.id : '',
          header: (snapshot && snapshot.header) || {},
          stamp: stampOf(snapshot || {}),
        }))
        .filter((item) => item.id)
    }
    const sessionQuery = safeGet('sessionQuery')
    if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
      const records = await sessionQuery.listSessions()
      return (records || [])
        .map((record) => ({
          id: record && record.header && typeof record.header.id === 'string' ? record.header.id : '',
          header: (record && record.header) || {},
          stamp: '',
        }))
        .filter((item) => item.id)
    }
    throw new Error('sessionPersistence / sessionQuery 都不可用，无法读取会话日志')
  }

  async function readSessionEvents(id) {
    const sessionQuery = safeGet('sessionQuery')
    if (sessionQuery && typeof sessionQuery.readSession === 'function') {
      try {
        const snapshot = await sessionQuery.readSession(id)
        if (snapshot && Array.isArray(snapshot.events)) return snapshot.events
      } catch {
        // fall through to persistence
      }
    }
    const persistence = safeGet('sessionPersistence')
    if (persistence && typeof persistence.open === 'function') {
      const handle = await persistence.open(id, 'read')
      try {
        let result
        try {
          result = await handle.read()
        } catch {
          result = await handle.read(0)
        }
        if (result && Array.isArray(result.events)) return result.events
        return []
      } finally {
        try {
          await handle.close()
        } catch {
          // ignore close failures
        }
      }
    }
    return []
  }

  // ── folding session events into indexable messages ──────────────────────

  function textBlocks(content, limit) {
    if (!Array.isArray(content)) return []
    const out = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text) {
        out.push(block.text.length > limit ? block.text.slice(0, limit) : block.text)
      }
    }
    return out
  }

  /**
   * Assistant reasoning is indexed as its own `reasoning` kind so search can
   * separate "what the model thought" from "what it answered"; the ranking
   * gives it the same low weight as injected system context.
   */
  function reasoningBlocks(content, limit) {
    if (!Array.isArray(content)) return []
    const out = []
    for (const block of content) {
      if (block && block.type === 'reasoning' && typeof block.text === 'string' && block.text) {
        out.push(block.text.length > limit ? block.text.slice(0, limit) : block.text)
      }
    }
    return out
  }

  /**
   * Fold session events into indexable messages, tagging each message with the
   * conversation turn it belongs to.
   *
   * Turn attribution:
   *   - `assistant/message`, `tool/call`, `tool/result` carry `data.turn` and use it;
   *   - `user/message` has no turn: while a turn is open (between `turn/start`
   *     and `turn/end`) it belongs to that turn, and a message submitted while
   *     idle waits for the next `turn/start` — this covers both queued prompts
   *     logged before the turn starts and mid-turn steering.
   * `turn_time` is the turn's start time, so every hit in one turn shares the
   * time the results list sorts and displays.
   */
  function foldEvents(events) {
    let title = ''
    const messages = []
    let activeTurn = null
    let activeTurnTime = 0
    const pending = []
    const push = (kind, seq, time, text, turn, turnTime) => {
      if (!text) return
      messages.push({
        kind,
        seq: Number(seq) || 0,
        time: Number(time) || 0,
        text,
        turn: turn === null ? 0 : Number(turn),
        turnTime: Number(turnTime) || 0,
      })
    }
    const pushOrQueue = (kind, seq, time, text) => {
      if (activeTurn === null) {
        if (text) pending.push({ kind, seq: Number(seq) || 0, time: Number(time) || 0, text })
        return
      }
      push(kind, seq, time, text, activeTurn, activeTurnTime)
    }
    const turnHintOf = (data) => (typeof data.turn === 'number' ? data.turn : null)

    for (const event of events || []) {
      if (!event || typeof event !== 'object') continue
      const type = event.type
      const data = event.data || {}
      const seq = Number(event.seq ?? -1)
      const time = Number(event.time ?? 0)
      if (type === 'session/title') {
        if (typeof data.title === 'string' && data.title) title = data.title
        continue
      }
      if (type === 'turn/start') {
        const turn = Number(data.turn)
        if (Number.isFinite(turn)) {
          activeTurn = turn
          activeTurnTime = time
          for (const item of pending) push(item.kind, item.seq, item.time, item.text, turn, time)
          pending.length = 0
        }
        continue
      }
      if (type === 'turn/end') {
        activeTurn = null
        activeTurnTime = 0
        continue
      }
      if (type === 'user/message') {
        const kind = data.source && data.source.kind === 'user' ? 'user' : 'system'
        for (const text of textBlocks(data.content, MAX_TEXT_CHARS)) pushOrQueue(kind, seq, time, text)
        continue
      }
      if (type === 'assistant/message') {
        const hint = turnHintOf(data)
        const content = data.message && data.message.content
        for (const text of textBlocks(content, MAX_TEXT_CHARS)) {
          if (hint === null) pushOrQueue('assistant', seq, time, text)
          else push('assistant', seq, time, text, hint, hint === activeTurn ? activeTurnTime : time)
        }
        for (const text of reasoningBlocks(content, MAX_REASONING_CHARS)) {
          if (hint === null) pushOrQueue('reasoning', seq, time, text)
          else push('reasoning', seq, time, text, hint, hint === activeTurn ? activeTurnTime : time)
        }
        continue
      }
      if (type === 'system/message' || type === 'developer/message') {
        const hint = turnHintOf(data)
        const content = data.message && data.message.content
        for (const text of textBlocks(content, MAX_TEXT_CHARS)) {
          if (hint === null) pushOrQueue('system', seq, time, text)
          else push('system', seq, time, text, hint, hint === activeTurn ? activeTurnTime : time)
        }
        continue
      }
      if (type === 'tool/call') {
        const hint = turnHintOf(data)
        const name = typeof data.name === 'string' ? data.name : ''
        let args = data.arguments
        if (typeof args !== 'string') {
          try {
            args = JSON.stringify(args ?? '')
          } catch {
            args = ''
          }
        }
        const text = `${name} ${args}`.trim()
        const clipped = text.length > MAX_TOOL_CHARS ? text.slice(0, MAX_TOOL_CHARS) : text
        if (hint === null) pushOrQueue('tool', seq, time, clipped)
        else push('tool', seq, time, clipped, hint, hint === activeTurn ? activeTurnTime : time)
        continue
      }
      if (type === 'tool/result') {
        const hint = turnHintOf(data)
        const content = data.message && data.message.content
        const texts = textBlocks(content, MAX_TOOL_CHARS)
        if (data.error && typeof data.error === 'object') {
          try {
            texts.push(JSON.stringify(data.error).slice(0, MAX_TOOL_CHARS))
          } catch {
            // ignore unserializable error payloads
          }
        }
        for (const text of texts) {
          if (hint === null) pushOrQueue('tool-result', seq, time, text)
          else push('tool-result', seq, time, text, hint, hint === activeTurn ? activeTurnTime : time)
        }
      }
    }
    for (const item of pending) push(item.kind, item.seq, item.time, item.text, 0, item.time)
    return { title, messages }
  }

  // ── index writes ────────────────────────────────────────────────────────

  function deleteSessionMessages(sessionId) {
    const rows = state.db.prepare('SELECT id FROM messages WHERE session_id = ?').all(sessionId)
    const removeFts = state.db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
    const removeRow = state.db.prepare('DELETE FROM messages WHERE id = ?')
    for (const row of rows) {
      removeFts.run(row.id)
      removeRow.run(row.id)
    }
    return rows.length
  }

  async function indexSession(meta) {
    const events = await readSessionEvents(meta.id)
    const folded = foldEvents(events)

    state.db.exec('BEGIN IMMEDIATE')
    let written = 0
    try {
      deleteSessionMessages(meta.id)
      const insertMessage = state.db.prepare(
        'INSERT INTO messages(session_id, seq, kind, time, turn, turn_time, text) VALUES(?, ?, ?, ?, ?, ?, ?)',
      )
      const insertFts = state.db.prepare('INSERT INTO messages_fts(rowid, text) VALUES(?, ?)')
      for (const message of folded.messages) {
        const result = insertMessage.run(
          meta.id,
          message.seq,
          message.kind,
          message.time,
          message.turn,
          message.turnTime,
          message.text,
        )
        // Tool, reasoning and system text is opt-in and searched with LIKE, so
        // it never pays the trigram index cost.
        if (message.kind === 'user' || message.kind === 'assistant') {
          insertFts.run(Number(result.lastInsertRowid), message.text)
        }
        written += 1
      }
      const header = meta.header || {}
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      const createdAt = Number(header.createdAt || 0)
      let updatedAt = createdAt
      for (const message of folded.messages) if (message.time > updatedAt) updatedAt = message.time
      state.db
        .prepare(
          `INSERT INTO sessions(id, project, cwd, title, created_at, updated_at, stamp, msg_count)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project=excluded.project, cwd=excluded.cwd, title=excluded.title,
             created_at=excluded.created_at, updated_at=excluded.updated_at,
             stamp=excluded.stamp, msg_count=excluded.msg_count`,
        )
        .run(meta.id, cwd, cwd, folded.title, createdAt, updatedAt, meta.stamp, written)
      state.db.exec('COMMIT')
    } catch (error) {
      try {
        state.db.exec('ROLLBACK')
      } catch {
        // transaction already gone
      }
      throw error
    }
    return written
  }

  // ── synchronization ─────────────────────────────────────────────────────

  function markDirty(session) {
    const id = session && (typeof session.id === 'string' ? session.id : typeof session.sessionId === 'string' ? session.sessionId : '')
    if (!id) return
    state.dirty.add(id)
    if (state.dirtyTimer) clearTimeout(state.dirtyTimer)
    state.dirtyTimer = setTimeout(() => {
      state.dirtyTimer = null
      const only = new Set(state.dirty)
      state.dirty.clear()
      requestSync({ only }).catch(() => {})
    }, DIRTY_DEBOUNCE_MS)
  }

  async function syncOnce({ full = false, only = null } = {}) {
    const metas = await listSessionMeta()
    const known = new Set(metas.map((meta) => meta.id))
    const total = full ? metas.length : only ? metas.filter((meta) => only.has(meta.id)).length : metas.length
    state.building = full || !state.readyIndex
    state.progress = { done: 0, total }
    state.lastError = ''

    // ghost sessions: index rows whose log disappeared from the source listing
    try {
      const stored = state.db.prepare('SELECT id FROM sessions').all()
      for (const row of stored) {
        if (!known.has(row.id)) {
          state.db.exec('BEGIN IMMEDIATE')
          try {
            deleteSessionMessages(row.id)
            state.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id)
            state.db.exec('COMMIT')
          } catch {
            try {
              state.db.exec('ROLLBACK')
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ghost cleanup is best effort
    }

    let indexed = 0
    let failed = 0
    for (const meta of metas) {
      if (state.disposed) return
      if (only && !only.has(meta.id) && !full) continue
      if (!full && !only) {
        const stored = state.db.prepare('SELECT stamp FROM sessions WHERE id = ?').get(meta.id)
        if (stored && meta.stamp && stored.stamp === meta.stamp) {
          state.progress.done += 1
          continue
        }
      }
      try {
        await indexSession(meta)
        indexed += 1
      } catch (error) {
        failed += 1
        state.lastError = `索引 ${meta.id} 失败：${errText(error)}`
      }
      state.progress.done += 1
      if (state.progress.done % 2 === 0) await tick()
    }

    state.lastSyncAt = Date.now()
    if (full) state.lastBuildAt = Date.now()
    state.building = false
    try {
      const indexed = Number(state.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n) || 0
      // Source sessions the Host refuses to load (old format, migration-required)
      // stay visible as a count instead of silently disappearing.
      state.failedSessions = Math.max(0, metas.length - indexed)
    } catch {
      state.failedSessions = failed
    }
    try {
      state.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('lastSync', ?)").run(String(state.lastSyncAt))
      state.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // meta and checkpoint are advisory
    }
    if (failed > 0 && indexed === 0 && state.lastError === '') {
      state.lastError = `${failed} 个会话索引失败`
    }
  }

  /**
   * Re-indexing deletes and re-inserts a session's rows; without compaction the
   * freed pages (and contentless-FTS tombstones) pile up and the file keeps
   * growing. Compact only when the free ratio is worth a VACUUM, at most hourly.
   */
  function maybeCompact() {
    try {
      const pages = Number(state.db.prepare('PRAGMA page_count').get().page_count) || 0
      const free = Number(state.db.prepare('PRAGMA freelist_count').get().freelist_count) || 0
      if (pages === 0 || free < 500 || free / pages < 0.2) return
      if (Date.now() - state.lastCompactAt < 60 * 60 * 1000) return
      state.lastCompactAt = Date.now()
      state.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')")
      state.db.exec('VACUUM')
      state.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // compaction is best effort; the next sync retries
    }
  }

  function requestSync(options = {}) {
    if (state.disposed) return Promise.resolve()
    if (state.syncPromise) return state.syncPromise
    state.syncPromise = (async () => {
      try {
        if (!state.db) await ensureInit()
        if (state.dbError) return
        await syncOnce(options)
        maybeCompact()
      } catch (error) {
        state.lastError = errText(error)
        // A corrupt index is repaired once, then rebuilt in the background.
        if (isCorruption(error)) await recoverFromCorruption()
      } finally {
        state.syncPromise = null
        state.building = false
      }
    })()
    return state.syncPromise
  }

  function isCorruption(error) {
    const text = `${errText(error)} ${error && error.code ? error.code : ''}`.toLowerCase()
    return text.includes('malformed') || text.includes('corrupt') || text.includes('not a database') || text.includes('sqlite_corrupt')
  }

  async function recoverFromCorruption() {
    try {
      state.lastError = '索引文件损坏，正在自动重建'
      await openDatabase({ fresh: true })
      state.readyIndex = false
      requestSync({ full: true })
    } catch (error) {
      state.dbError = errText(error)
    }
  }

  // ── search ──────────────────────────────────────────────────────────────

  function likePattern(query) {
    const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    return `%${escaped}%`
  }

  function ftsPhrase(query) {
    return '"' + query.replace(/"/g, '""') + '"'
  }

  function makeSnippet(text, query) {
    const flat = String(text).replace(/\s+/g, ' ').trim()
    const index = flat.toLowerCase().indexOf(query.toLowerCase())
    if (index < 0) return [{ t: 'text', s: flat.slice(0, SNIPPET_WIDTH * 2) }]
    const start = Math.max(0, index - SNIPPET_WIDTH)
    const end = Math.min(flat.length, index + query.length + SNIPPET_TAIL)
    const segments = []
    if (start > 0) segments.push({ t: 'text', s: '…' })
    if (index > start) segments.push({ t: 'text', s: flat.slice(start, index) })
    segments.push({ t: 'hit', s: flat.slice(index, index + query.length) })
    if (end > index + query.length) segments.push({ t: 'text', s: flat.slice(index + query.length, end) })
    if (end < flat.length) segments.push({ t: 'text', s: '…' })
    return segments
  }

  function sessionRows() {
    const rows = state.db
      .prepare('SELECT id, project, cwd, title, created_at, updated_at, msg_count FROM sessions')
      .all()
    const map = new Map()
    for (const row of rows) map.set(row.id, row)
    return map
  }

  function dedupeForked(rows, sessionMap) {
    // DSH forks share the parent's inherited history, so the same message can be
    // indexed once per fork. Keep the copy whose session has a title / is newest.
    const seen = new Map()
    const out = []
    for (const row of rows) {
      const key = `${row.kind}\u0000${row.seq}\u0000${row.text.slice(0, 160)}`
      const previous = seen.get(key)
      if (previous === undefined) {
        seen.set(key, out.length)
        out.push(row)
        continue
      }
      const current = out[previous]
      const currentInfo = sessionMap.get(current.session_id)
      const nextInfo = sessionMap.get(row.session_id)
      const currentRank = (currentInfo && currentInfo.title ? 1 : 0) * 1e15 + ((currentInfo && currentInfo.updated_at) || 0)
      const nextRank = (nextInfo && nextInfo.title ? 1 : 0) * 1e15 + ((nextInfo && nextInfo.updated_at) || 0)
      if (nextRank > currentRank) out[previous] = row
    }
    return out
  }

  // Inside one turn hits are ordered by source priority: question → answer →
  // tool traffic → reasoning → injected system context.
  const KIND_ORDER = { user: 0, assistant: 1, tool: 2, 'tool-result': 2, reasoning: 3, system: 4 }

  /**
   * Normalized match window, used to fold repeated system/tool hits that share
   * the same surrounding text. DSH re-logs the assembled system context (for
   * example `<system-reminder> Updated instructions from: AGENTS.md …`) once per
   * turn; those copies differ only in their tail, so the same query keeps
   * landing in the identical window.
   */
  function contextKey(text, query) {
    const flat = String(text).replace(/\s+/g, ' ').trim()
    const index = flat.toLowerCase().indexOf(query.toLowerCase())
    if (index < 0) return flat.slice(0, 220)
    const start = Math.max(0, index - SNIPPET_WIDTH)
    const end = Math.min(flat.length, index + query.length + SNIPPET_WIDTH)
    return flat.slice(start, end)
  }

  /**
   * Search returns conversation turns, not whole sessions: one item per
   * (session, turn). Within an item hits are grouped by source in KIND_ORDER.
   * `sortMode` is 'weight' (source weight × recency, the default) or 'time'
   * (purely newest turn first).
   */
  /**
   * Sessions not owned by any registered Workspace cannot be navigated to from
   * the UI (opening them falls back to the workspace picker / a blank chat).
   * The registry is the authority for ownership; without it, keep everything.
   */
  function ownedSessionIds() {
    try {
      const registry = safeGet('workspaceRegistry')
      if (!registry || typeof registry.list !== 'function') return null
      const ids = new Set()
      for (const workspace of registry.list()) {
        for (const id of (workspace && workspace.sessionIds) || []) ids.add(String(id))
      }
      return ids.size > 0 ? ids : null
    } catch {
      return null
    }
  }

  let bm25Checked = false
  let bm25Usable = false

  /** FTS5 contentless tables may or may not expose bm25(); probe once. */
  function canUseBm25() {
    if (bm25Checked) return bm25Usable
    bm25Checked = true
    try {
      state.db
        .prepare("SELECT bm25(messages_fts) AS s FROM messages_fts WHERE messages_fts MATCH ? LIMIT 1")
        .all('abcdef')
      bm25Usable = true
    } catch {
      bm25Usable = false
    }
    return bm25Usable
  }

  /** Length-normalized TF used when BM25 is unavailable (LIKE / mixed kinds). */
  function tfRelevance(tf, length, averageLength) {
    const k1 = 1.2
    const b = 0.75
    const avg = averageLength > 0 ? averageLength : Math.max(1, length)
    return (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / avg))
  }

  function positionScore(index, length) {
    if (index < 0) return 0
    const ratio = index / Math.max(1, length)
    if (ratio < 0.2) return 0.8
    if (ratio < 0.6) return 0.5
    return 0.2
  }

  function recencyScore(time) {
    const ageDays = Math.max(0, (Date.now() - (Number(time) || 0)) / 86400000)
    return Math.exp(-FRESH_LAMBDA * ageDays)
  }

  function search(query, kinds, limitPerTurn, turnLimit, sortMode) {
    const q = String(query || '').trim()
    const wanted = kinds.filter((kind) => ALL_KINDS.includes(kind))
    if (q === '' || wanted.length === 0) {
      return { query: q, mode: 'none', rows: 0, items: [], totalHits: 0, totalOccurrences: 0, totalTurns: 0, totalSessions: 0, hasMore: false }
    }
    const placeholders = wanted.map(() => '?').join(', ')
    const dialogOnly = wanted.every((kind) => kind === 'user' || kind === 'assistant')
    const useFts = q.length >= 3 && dialogOnly
    const useBm25 = useFts && canUseBm25()
    const started = Date.now()
    let rows
    if (useFts) {
      const bm25Column = useBm25 ? 'bm25(messages_fts) AS bm25_raw' : 'NULL AS bm25_raw'
      const orderBy = useBm25 ? 'bm25(messages_fts)' : 'rank'
      rows = state.db
        .prepare(
          `SELECT m.id AS id, m.session_id AS session_id, m.kind AS kind, m.seq AS seq,
                  m.time AS time, m.turn AS turn, m.turn_time AS turn_time, m.text AS text, ${bm25Column}
             FROM messages_fts f JOIN messages m ON m.id = f.rowid
            WHERE messages_fts MATCH ? AND m.kind IN (${placeholders})
            ORDER BY ${orderBy}
            LIMIT ${RECALL_FTS}`,
        )
        .all(ftsPhrase(q), ...wanted)
    } else {
      rows = state.db
        .prepare(
          `SELECT id, session_id, kind, seq, time, turn, turn_time, text, NULL AS bm25_raw FROM messages
            WHERE text LIKE ? ESCAPE '\\' AND kind IN (${placeholders})
            LIMIT ${RECALL_LIKE}`,
        )
        .all(likePattern(q), ...wanted)
    }

    const sessionMap = sessionRows()
    rows = dedupeForked(rows, sessionMap)

    const lowerQuery = q.toLowerCase()
    const prepared = []
    let averageLength = 0
    let bm25Min = 0
    let bm25Max = 0
    for (const row of rows) {
      const text = String(row.text || '')
      const lower = text.toLocaleLowerCase()
      const index = lower.indexOf(lowerQuery)
      let tf = 0
      if (index >= 0) {
        let cursor = index
        while (cursor !== -1 && tf < 50) {
          tf += 1
          cursor = lower.indexOf(lowerQuery, cursor + q.length)
        }
      }
      const length = text.length
      averageLength += length
      const raw = typeof row.bm25_raw === 'number' ? row.bm25_raw : null
      if (raw !== null) {
        if (prepared.length === 0) {
          bm25Min = raw
          bm25Max = raw
        } else {
          if (raw < bm25Min) bm25Min = raw
          if (raw > bm25Max) bm25Max = raw
        }
      }
      prepared.push({ row, lower, index, tf, length, raw })
    }
    averageLength = prepared.length > 0 ? averageLength / prepared.length : 0

    const relevance = new Map()
    if (useBm25) {
      for (const entry of prepared) {
        const span = bm25Max - bm25Min
        const normalized = entry.raw === null || span <= 0 ? 0.5 : (bm25Max - entry.raw) / span
        relevance.set(entry, Math.max(0, Math.min(1, normalized)))
      }
    } else {
      let maxTfScore = 0
      for (const entry of prepared) {
        const tfScore = tfRelevance(entry.tf, entry.length, averageLength)
        entry.tfScore = tfScore
        if (tfScore > maxTfScore) maxTfScore = tfScore
      }
      for (const entry of prepared) {
        relevance.set(entry, maxTfScore > 0 ? entry.tfScore / maxTfScore : 0)
      }
    }

    const titleHits = new Set()
    for (const info of sessionMap.values()) {
      if (info.title && info.title.toLowerCase().includes(lowerQuery)) titleHits.add(info.id)
    }

    const byTurn = new Map()
    const bucketOf = (sessionId, info, turn, titleHit) => {
      const key = `${sessionId}\u0000${turn}`
      let bucket = byTurn.get(key)
      if (!bucket) {
        bucket = {
          key,
          sessionId,
          turn,
          turnTime: 0,
          latestHitTime: 0,
          title: info.title || '',
          project: info.project || '',
          cwd: info.cwd || '',
          createdAt: info.created_at || 0,
          updatedAt: info.updated_at || 0,
          msgCount: info.msg_count || 0,
          titleHit,
          score: 0,
          groups: new Map(),
        }
        byTurn.set(key, bucket)
      }
      return bucket
    }

    for (const entry of prepared) {
      const row = entry.row
      const info = sessionMap.get(row.session_id)
      if (!info) continue
      const turn = Number(row.turn) || 0
      const bucket = bucketOf(row.session_id, info, turn, titleHits.has(row.session_id))
      if (Number(row.turn_time) > 0) bucket.turnTime = Number(row.turn_time)
      if (row.time > bucket.latestHitTime) bucket.latestHitTime = row.time

      const typeScore = TYPE_SCORE[row.kind] || 0.2
      let score =
        SCORE_WEIGHT.relevance * (relevance.get(entry) || 0) +
        SCORE_WEIGHT.position * positionScore(entry.index, entry.length) +
        SCORE_WEIGHT.type * typeScore +
        SCORE_WEIGHT.freshness * recencyScore(row.time)
      if (entry.length > LONG_MESSAGE) score *= LONG_FACTOR
      if (entry.length === q.length && entry.lower === lowerQuery) score *= EXACT_FACTOR
      if ((row.kind === 'assistant' || row.kind === 'tool' || row.kind === 'tool-result') && (entry.lower.includes('$') || entry.lower.includes('\\'))) {
        score *= 1.03
      }
      if (score > 1.2) score = 1.2

      const isDialog = row.kind === 'user' || row.kind === 'assistant'
      const key = isDialog ? `id:${row.id}` : `${row.kind}|${contextKey(row.text, q)}`
      const existing = bucket.groups.get(key)
      if (existing) {
        existing.occurrences += 1
        if (row.time > existing.lastTime) existing.lastTime = row.time
        if (score > existing.score) existing.score = score
        if (score > bucket.score) bucket.score = score
        continue
      }
      bucket.groups.set(key, {
        kind: row.kind,
        seq: row.seq,
        time: row.time,
        lastTime: row.time,
        occurrences: 1,
        score,
        snippet: makeSnippet(row.text, q),
      })
      if (score > bucket.score) bucket.score = score
    }

    // Title-only matches stay as low-priority rows; a title hit on a session with
    // message hits just nudges its best turn, never floats the whole session up.
    for (const sessionId of titleHits) {
      const info = sessionMap.get(sessionId)
      if (!info) continue
      let hasItem = false
      for (const bucket of byTurn.values()) {
        if (bucket.sessionId === sessionId) {
          bucket.titleHit = true
          bucket.score += TITLE_BONUS
          hasItem = true
        }
      }
      if (!hasItem) {
        const bucket = bucketOf(sessionId, info, 0, true)
        bucket.turnTime = Number(info.created_at) || 0
        bucket.latestHitTime = Number(info.updated_at) || 0
        bucket.score = 0.15 + 0.1 * recencyScore(bucket.updatedAt)
        bucket.titleOnly = true
      }
    }

    const list = []
    let totalHits = 0
    let totalOccurrences = 0
    const owned = ownedSessionIds()
    for (const bucket of byTurn.values()) {
      if (owned && !owned.has(String(bucket.sessionId))) continue
      const hits = [...bucket.groups.values()]
      hits.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.time - b.time)
      const kindCounts = { user: 0, assistant: 0, tool: 0, reasoning: 0, system: 0 }
      let occurrences = 0
      for (const hit of hits) {
        occurrences += hit.occurrences
        if (hit.kind === 'user') kindCounts.user += 1
        else if (hit.kind === 'assistant') kindCounts.assistant += 1
        else if (hit.kind === 'reasoning') kindCounts.reasoning += 1
        else if (hit.kind === 'system') kindCounts.system += 1
        else kindCounts.tool += 1
      }
      bucket.kindCounts = kindCounts
      bucket.totalGroups = hits.length
      bucket.occurrences = occurrences
      bucket.hasMore = hits.length > limitPerTurn
      bucket.hits = hits.slice(0, limitPerTurn)
      bucket.time = bucket.turnTime || bucket.latestHitTime
      bucket.score = Math.round(Math.max(0, Math.min(1.2, bucket.score)) * 1000) / 1000
      delete bucket.groups
      totalHits += hits.length
      totalOccurrences += occurrences
      list.push(bucket)
    }

    if (sortMode === 'time') {
      list.sort((a, b) => b.time - a.time || b.latestHitTime - a.latestHitTime)
    } else {
      list.sort((a, b) => b.score - a.score || b.time - a.time || b.latestHitTime - a.latestHitTime)
    }

    const sessions = new Set(list.map((item) => item.sessionId))
    return {
      query: q,
      mode: useFts ? 'fts' : 'like',
      sort: sortMode === 'time' ? 'time' : 'weight',
      weights: SCORE_WEIGHT,
      bm25: useBm25,
      tookMs: Date.now() - started,
      totalHits,
      totalOccurrences,
      totalTurns: list.length,
      totalSessions: sessions.size,
      rowsScanned: prepared.length,
      hasMore: list.length > turnLimit,
      items: list.slice(0, turnLimit),
    }
  }

  // ── HTTP routes ─────────────────────────────────────────────────────────

  function json(res, status, payload) {
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    } catch {
      // the socket may already be gone
    }
  }

  function statusPayload() {
    let sessions = 0
    let messages = 0
    if (state.db && !state.dbError) {
      try {
        sessions = Number(state.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n) || 0
        messages = Number(state.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n) || 0
      } catch {
        // reported through dbError below
      }
    }
    return {
      ok: !state.dbError,
      hostVersion: 2,
      dbError: state.dbError,
      lastError: state.lastError,
      ready: state.ready,
      building: state.building,
      progress: state.progress,
      sessions,
      messages,
      failedSessions: state.failedSessions,
      routesReady: state.routesReady,
      routesVia: state.routesVia,
      dbBytes: state.db ? dbBytes() : 0,
      dbPath: state.dbPath,
      lastSyncAt: state.lastSyncAt,
      lastBuildAt: state.lastBuildAt,
      searchCount: state.searchCount,
      syncing: Boolean(state.syncPromise),
    }
  }

  async function ensureInit() {
    if (!state.initPromise) {
      state.initPromise = (async () => {
        try {
          await openDatabase()
          state.ready = true
          state.readyIndex = !isEmptyIndex()
          // First activation (or an empty cache) builds everything in the
          // background; the panel shows progress while it runs.
          requestSync({ full: !state.readyIndex })
        } catch (error) {
          state.dbError = `索引不可用：${errText(error)}`
          state.ready = true
        }
      })()
    }
    return state.initPromise
  }

  async function ensureFresh() {
    if (!state.ready) await ensureInit()
    if (state.dbError) return
    const changed = state.dirty.size > 0
    const stale = Date.now() - state.lastSyncAt > 20000
    if (changed) {
      const only = new Set(state.dirty)
      state.dirty.clear()
      await Promise.race([requestSync({ only }), sleep(SEARCH_SYNC_WAIT_MS)])
      return
    }
    if (stale && !state.syncPromise) await Promise.race([requestSync({}), sleep(SEARCH_SYNC_WAIT_MS)])
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    try {
      if (route === '/status' && req.method === 'GET') {
        if (!state.ready) await ensureInit()
        return json(res, 200, statusPayload())
      }
      if (route === '/search' && req.method === 'GET') {
        await ensureFresh()
        if (state.dbError) return json(res, 503, { ok: false, error: state.dbError })
        const query = url.searchParams.get('q') || ''
        const kindsParam = url.searchParams.get('kinds') || ''
        const kinds = kindsParam ? kindsParam.split(',').map((kind) => kind.trim()).filter(Boolean) : DEFAULT_KINDS
        const limit = Math.min(Number(url.searchParams.get('limit')) || 6, 30)
        const turns = Math.min(Number(url.searchParams.get('turns') || url.searchParams.get('sessions')) || 20, 60)
        const sort = url.searchParams.get('sort') === 'time' ? 'time' : 'weight'
        if (!query.trim()) {
          return json(res, 200, {
            ok: true,
            query: '',
            mode: 'none',
            sort,
            items: [],
            totalHits: 0,
            totalOccurrences: 0,
            totalTurns: 0,
            totalSessions: 0,
          })
        }
        state.searchCount += 1
        const result = search(query, kinds, limit, turns, sort)
        return json(res, 200, { ok: true, ...result })
      }
      if (route === '/sessions' && req.method === 'GET') {
        await ensureFresh()
        if (state.dbError) return json(res, 503, { ok: false, error: state.dbError })
        const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 100)
        const rows = state.db
          .prepare(
            `SELECT id, project, cwd, title, created_at, updated_at, msg_count
               FROM sessions WHERE msg_count > 0
              ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
          )
          .all(limit)
        return json(res, 200, {
          ok: true,
          sessions: rows.map((row) => ({
            id: row.id,
            project: row.project || '',
            cwd: row.cwd || '',
            title: row.title || '',
            createdAt: row.created_at || 0,
            updatedAt: row.updated_at || 0,
            msgCount: row.msg_count || 0,
          })),
        })
      }
      if (route === '/rebuild' && req.method === 'POST') {
        await ensureInit()
        if (state.dbError) return json(res, 503, { ok: false, error: state.dbError })
        try {
          state.db.exec('BEGIN IMMEDIATE')
          state.db.exec('DELETE FROM messages_fts')
          state.db.exec('DELETE FROM messages')
          state.db.exec('DELETE FROM sessions')
          state.db.exec('COMMIT')
        } catch (error) {
          state.lastError = errText(error)
          return json(res, 500, { ok: false, error: state.lastError })
        }
        state.readyIndex = false
        requestSync({ full: true })
        return json(res, 200, { ok: true, started: true })
      }
      if (route === '/optimize' && req.method === 'POST') {
        await ensureInit()
        if (state.dbError) return json(res, 503, { ok: false, error: state.dbError })
        try {
          state.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')")
          state.db.exec('VACUUM')
          state.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } catch (error) {
          state.lastError = errText(error)
          return json(res, 500, { ok: false, error: state.lastError })
        }
        return json(res, 200, { ok: true, dbBytes: dbBytes() })
      }
      return json(res, 404, { ok: false, error: `unknown route ${route}` })
    } catch (error) {
      state.lastError = errText(error)
      return json(res, 500, { ok: false, error: state.lastError })
    }
  }

  // ── activation ──────────────────────────────────────────────────────────

  const disposeEffect = ctx.effect(() => {
    void ensureInit()

    /**
     * Register the HTTP routes from an injected context rather than reading
     * `webServer` once during `apply`. On a cold boot this row can activate
     * before the Web carrier mounts (and the carrier is replaced when its bind
     * changes), which is exactly how the panel ended up with a 404 after a
     * restart: the service existed by the time the browser loaded, but the
     * registration had already been skipped.
     */
    const registerRoutes = (ownerCtx) => {
      const webServer =
        ownerCtx && typeof ownerCtx.get === 'function' ? ownerCtx.get('webServer') : undefined
      if (!webServer || typeof webServer.register !== 'function') return
      ownerCtx.effect(() => {
        let dispose = null
        try {
          dispose = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleRoute })
          state.routesReady = true
          state.routesVia = ownerCtx === ctx ? 'retry' : 'inject'
          if (state.lastError === '当前 Host 没有 webServer，搜索面板拿不到数据') state.lastError = ''
        } catch (error) {
          const text = errText(error)
          if (/duplicate|already/i.test(text)) {
            // Another activation path already owns the route.
            state.routesReady = true
          } else {
            state.routesReady = false
            state.lastError = `路由注册失败：${text}`
          }
        }
        return () => {
          state.routesReady = false
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            // already removed
          }
        }
      }, 'dsh-session-search.routes')
    }

    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], registerRoutes)
      } else if (safeGet('webServer')) {
        // Older Host without ctx.inject: at least register when already mounted.
        registerRoutes(ctx)
      } else {
        state.lastError = '当前 Host 没有 webServer，搜索面板拿不到数据'
      }
    } catch (error) {
      state.lastError = `webServer 注入失败：${errText(error)}`
      try {
        if (safeGet('webServer')) registerRoutes(ctx)
      } catch {
        // reported through lastError
      }
    }

    const stopEvents = ctx.on('session/event', (_session, _event) => markDirty(_session))
    // Defensive cold-boot path: if the injected registration has not produced a
    // route within a few seconds (older Host, unexpected loader order), retry
    // directly. Duplicate registration is tolerated above.
    const routeRetries = [
      setTimeout(() => {
        if (!state.routesReady && !state.disposed) registerRoutes(ctx)
      }, 3000),
      setTimeout(() => {
        if (!state.routesReady && !state.disposed) registerRoutes(ctx)
      }, 10000),
    ]
    state.interval = setInterval(() => {
      if (state.dirty.size === 0 && !state.building) requestSync({}).catch(() => {})
    }, RECONCILE_INTERVAL_MS)

    return () => {
      state.disposed = true
      state.routesReady = false
      for (const timer of routeRetries) clearTimeout(timer)
      try {
        stopEvents()
      } catch {
        // ignore
      }
      if (state.dirtyTimer) clearTimeout(state.dirtyTimer)
      if (state.interval) clearInterval(state.interval)
      try {
        if (typeof state.routeDisposer === 'function') state.routeDisposer()
      } catch {
        // ignore
      }
      if (state.syncPromise) state.syncPromise.catch(() => {})
      closeDb()
    }
  }, 'dsh-session-search')
}
