/**
 * dsh-session-search — Client half.
 *
 * Registers:
 *   - `sidebar.panellist`   a magnifier entry whose id matches the `main` key;
 *   - `main`                the search page (input, kind filters, results);
 *   - `conversation.header.leading`  a compact shortcut beside the session title.
 *
 * The page reads the Host half over `/.dsh-session-search/*` (same origin). It
 * borrows the Host's theme tokens and locale only; it imports no Harness Client
 * package, so a Host rename cannot blank the entry.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-search',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const ROUTE = '/.dsh-session-search'
    const PANEL_ID = 'session-search'

    /**
     * The main panel unmounts when the reader jumps into a conversation, so the
     * search surface keeps its last state outside React: query, filters, sort,
     * results, expanded rows and the scroll offset all come back on return.
     */
    const PANEL_MEMORY = {
      query: '',
      kinds: ['user', 'assistant'],
      sortMode: 'weight',
      pageSize: 5,
      expanded: new Set(),
      result: null,
      scrollTop: 0,
      jumpNote: '',
      searchError: '',
    }
    const ALL_KIND_SET = ['user', 'assistant', 'tool', 'reasoning', 'system']

    const COPY = {
      zh: {
        nav: '会话搜索',
        title: '搜索历史会话',
        lead: '跨所有会话检索消息内容；中文单字、关键词都可以。默认只搜用户与助手内容，系统 / 思考 / 工具可在「来源」里打开。',
        placeholder: '输入关键词或单字，回车搜索…',
        search: '搜索',
        clear: '清空',
        kinds: '来源',
        kindUser: '用户',
        kindAssistant: '助手',
        kindSystem: '系统',
        kindTool: '工具',
        kindReasoning: '思考',
        empty: '还没有搜索。输入关键词，或直接看下面的最近会话。',
        emptyResult: '没有找到匹配内容。试试更短的关键词、单个汉字，或在「来源」里打开思考 / 工具 / 系统。',
        recent: '最近会话',
        noRecent: '索引里还没有会话。首次建库完成后会自动出现。',
        hitsLabel: '命中',
        sessionsLabel: '会话',
        openHint: '跳转到该轮并高亮命中',
        jumpHidden: '已定位到第 {n} 轮，但命中内容不在聊天界面渲染（例如系统注入），可看下方片段。',
        jumpDone: '已在第 {turn} 轮定位并高亮 {n} 处命中',
        jumpStart: '正在定位第 {turn} 轮…',
        jumpArchived: '该会话已归档，无法直接打开；请先在侧栏取消归档后再试。',
        jumpNoWorkspace: '该会话不属于任何工作区，无法直接打开。',
        jumpFailed: '没能定位到该轮，已为你打开会话。',
        jumpTurnOnly: '该条目没有轮次信息，已为你打开会话。',
        closeNote: '知道了',
        building: '正在建立索引',
        buildingHint: '首次启用会在后台把历史会话写入索引，期间可以继续搜索已索引的部分。',
        ready: '索引就绪',
        statusIndex: '索引',
        statusMessages: '条消息',
        statusSynced: '最近同步',
        skipped: '个旧格式会话无法索引',
        rebuild: '重建索引',
        rebuilding: '已开始重建…',
        retry: '重试',
        failed: '请求失败',
        unavailable: '索引不可用',
        errorPrefix: '搜索失败：',
        loadingLabel: '搜索中…',
        close: '返回会话',
        shortcut: '搜索历史',
        shortcutTip: '搜索所有会话的历史消息',
        justNow: '刚刚',
        minutesAgo: '分钟前',
        hoursAgo: '小时前',
        daysAgo: '天前',
        moreHits: '还有 {n} 条命中未显示',
        occurrences: '处出现',
        turnsLabel: '轮',
        roundLabel: '第 {n} 轮',
        roundUnknown: '未标记轮次',
        titleOnly: '仅标题命中，没有消息内容',
        sortLabel: '排序',
        sortWeight: '相关优先',
        sortTime: '最新优先',
        viewAll: '查看全部（还有 {n} 轮）',
        totalShort: '共 {n} 条相关命中',
        expand: '展开',
        collapse: '收起',
      },
      en: {
        nav: 'Session search',
        title: 'Search past sessions',
        lead: 'Full-text search across every session. Chinese single characters and keywords both work. By default only your messages and assistant answers are searched; System / Reasoning / Tools can be enabled under Source.',
        placeholder: 'Type a keyword or a single character, then press Enter…',
        search: 'Search',
        clear: 'Clear',
        kinds: 'Source',
        kindUser: 'You',
        kindAssistant: 'Assistant',
        kindSystem: 'System',
        kindTool: 'Tools',
        kindReasoning: 'Reasoning',
        empty: 'Nothing searched yet. Type a keyword, or open a recent session below.',
        emptyResult: 'No matches. Try a shorter keyword, a single character, or enable Reasoning / Tools / System under Source.',
        recent: 'Recent sessions',
        noRecent: 'No sessions indexed yet. They appear as soon as the first build finishes.',
        hitsLabel: 'hits',
        sessionsLabel: 'sessions',
        openHint: 'Jump to that turn and highlight the match',
        jumpHidden: 'Located turn {n}, but this match is not rendered by the chat UI (for example injected system context); see the snippet below.',
        jumpDone: 'Found and highlighted {n} match(es) in turn {turn}',
        jumpStart: 'Locating turn {turn}…',
        jumpArchived: 'This session is archived and cannot be opened directly; unarchive it in the sidebar first.',
        jumpNoWorkspace: 'This session does not belong to any workspace and cannot be opened.',
        jumpFailed: 'Could not locate that turn; the session was opened.',
        jumpTurnOnly: 'This result has no turn number; the session was opened.',
        closeNote: 'Got it',
        building: 'Building index',
        buildingHint: 'The first activation indexes past sessions in the background; searching already-indexed content still works meanwhile.',
        ready: 'Index ready',
        statusIndex: 'Index',
        statusMessages: 'messages',
        statusSynced: 'Synced',
        skipped: 'older-format sessions skipped',
        rebuild: 'Rebuild index',
        rebuilding: 'Rebuild started…',
        retry: 'Retry',
        failed: 'Request failed',
        unavailable: 'Index unavailable',
        errorPrefix: 'Search failed: ',
        loadingLabel: 'Searching…',
        close: 'Back to conversation',
        shortcut: 'Search history',
        shortcutTip: 'Search messages across all sessions',
        justNow: 'just now',
        minutesAgo: 'min ago',
        hoursAgo: 'h ago',
        daysAgo: 'd ago',
        moreHits: 'and {n} more hits',
        occurrences: 'occurrences',
        turnsLabel: 'turns',
        roundLabel: 'Turn {n}',
        roundUnknown: 'unmarked turn',
        titleOnly: 'Title matched; no message hits',
        sortLabel: 'Sort',
        sortWeight: 'Relevance',
        sortTime: 'Newest',
        viewAll: 'View all ({n} more turns)',
        totalShort: '{n} matches',
        expand: 'more',
        collapse: 'less',
      },
    }

    function copy() {
      const lang = `${(document.documentElement && document.documentElement.lang) || ''}${navigator.language || ''}`
      return lang.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
    }

    async function request(path, options) {
      const response = await fetch(`${ROUTE}${path}`, {
        cache: 'no-store',
        ...options,
        headers: { accept: 'application/json', ...(options && options.headers ? options.headers : {}) },
      })
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = { ok: false, error: text.slice(0, 300) }
      }
      if (!response.ok) {
        const error = new Error((body && body.error) || `HTTP ${response.status}`)
        error.body = body
        throw error
      }
      return body
    }

    function formatCount(value) {
      const text = String(value || 0)
      return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    // ── Jump into the conversation and highlight the match ──────────────────
    //
    // The Chat surface renders one `[data-chat-turn="N"]` box per turn and a
    // fixed turn rail whose buttons carry localized aria-labels
    // ("跳转到第 N 轮" / "加载并跳转到第 N 轮", "Jump to turn N"). Clicking the
    // rail entry loads and scrolls to the turn; collapsed tool-process groups
    // and reasoning disclosures are then expanded until the query becomes
    // visible, and CSS Custom Highlight marks it without touching the DOM.

    const HIT_HIGHLIGHT = 'dsh-session-search-hit'
    const FLASH_CLASS = 'dsh-session-search-flash'
    const FORMULA_HIT_CLASS = 'dsh-session-search-formula'
    const toastBus = new EventTarget()
    const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function notifyToast(text, tone = 'info') {
      try {
        if (text) toastBus.dispatchEvent(new CustomEvent('toast', { detail: { text: String(text), tone } }))
      } catch {
        // notifications must never break navigation
      }
    }

    const ICON_TOAST_CHECK = h(
      'svg',
      { viewBox: '0 0 16 16', width: 11, height: 11, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M3.5 8.5 6.5 11.5 12.5 5' }),
    )
    const ICON_TOAST_INFO = h(
      'svg',
      { viewBox: '0 0 16 16', width: 11, height: 11, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
      h('circle', { cx: 8, cy: 8, r: 5.2 }),
      h('path', { d: 'M8 7.3v3.6' }),
      h('circle', { cx: 8, cy: 5.3, r: 0.85, fill: 'currentColor', stroke: 'none' }),
    )
    const ICON_TOAST_WARN = h(
      'svg',
      { viewBox: '0 0 16 16', width: 11, height: 11, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true },
      h('path', { d: 'M8 3.5v5' }),
      h('circle', { cx: 8, cy: 11.6, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    )

    /** Small transient notice rendered through the shell overlay. */
    function ToastHost() {
      const [toast, setToast] = useState(null)
      useEffect(() => {
        const handler = (event) => {
          const detail = event.detail || {}
          setToast({ text: String(detail.text || ''), tone: detail.tone || 'info', closing: false })
        }
        toastBus.addEventListener('toast', handler)
        return () => toastBus.removeEventListener('toast', handler)
      }, [])
      useEffect(() => {
        if (!toast || toast.closing) return undefined
        const timer = setTimeout(() => setToast((current) => (current ? { ...current, closing: true } : current)), 3600)
        return () => clearTimeout(timer)
      }, [toast])
      useEffect(() => {
        if (!toast || !toast.closing) return undefined
        const timer = setTimeout(() => setToast(null), 190)
        return () => clearTimeout(timer)
      }, [toast])
      if (!toast || !toast.text) return null
      const icon =
        toast.tone === 'busy'
          ? h('span', { className: 'sex-spinner' })
          : toast.tone === 'success'
            ? ICON_TOAST_CHECK
            : toast.tone === 'warn'
              ? ICON_TOAST_WARN
              : ICON_TOAST_INFO
      return h(
        'div',
        { className: `sex-toast ${toast.tone}${toast.closing ? ' closing' : ''}`, role: 'status' },
        h('span', { className: 'sex-toast-icon' }, icon),
        h('span', { className: 'sex-toast-text' }, toast.text),
      )
    }

    function elementVisible(element) {
      try {
        if (!element || !element.isConnected) return false
        if (typeof element.checkVisibility === 'function') {
          if (!element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false
        }
        const rect = element.getBoundingClientRect()
        return rect.width > 0 || rect.height > 0
      } catch {
        return true
      }
    }

    async function waitFor(find, timeoutMs, intervalMs = 90) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = find()
        if (value) return value
        await sleepMs(intervalMs)
      }
      return null
    }

    function visibleChatRoot() {
      for (const scroller of document.querySelectorAll('[data-conversation-scroll]')) {
        if (!elementVisible(scroller)) continue
        const rect = scroller.getBoundingClientRect()
        if (rect.width < 120 || rect.height < 120) continue
        if (rect.right <= 0 || rect.left >= window.innerWidth) continue
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue
        return scroller
      }
      return null
    }

    function turnRows(turn) {
      const root = visibleChatRoot()
      if (!root) return []
      return [...root.querySelectorAll(`[data-chat-turn="${Number(turn)}"]`)]
    }

    function allTurnButtons(root) {
      const scope = root || visibleChatRoot()
      if (!scope) return []
      return [...scope.querySelectorAll('button[aria-label]')]
    }

    function railScroller(button) {
      let element = button && button.parentElement
      while (element && element !== document.body) {
        let style
        try {
          style = getComputedStyle(element)
        } catch {
          return null
        }
        if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4) return element
        element = element.parentElement
      }
      return null
    }

    /**
     * The turn rail virtualizes its marks, so an off-screen turn may have no
     * button in the DOM. Find any rail button, scroll the rail roughly to the
     * turn's position, and look again.
     */
    async function findTurnJumpButtonAsync(turn) {
      const direct = findTurnJumpButton(turn)
      if (direct) return direct
      const any = allTurnButtons().find(
        (button) => /(跳转|jump)/i.test(button.getAttribute('aria-label') || '') && /(轮|turn)/i.test(button.getAttribute('aria-label') || ''),
      )
      if (!any) return null
      const scroller = railScroller(any)
      if (!scroller) return null
      const estimate = Math.max(1, Number(turn)) - 1
      const candidates = [
        estimate * 10 - scroller.clientHeight / 2,
        0,
        scroller.scrollHeight,
        Math.max(0, estimate * 10 - scroller.clientHeight * 0.75),
        Math.max(0, estimate * 10 - scroller.clientHeight * 0.25),
      ]
      for (const top of candidates) {
        scroller.scrollTop = Math.max(0, top)
        await sleepMs(130)
        const found = findTurnJumpButton(turn)
        if (found) return found
      }
      return findTurnJumpButton(turn)
    }

    function findTurnJumpButton(turn) {
      const number = Number(turn)
      for (const button of allTurnButtons()) {
        const label = button.getAttribute('aria-label') || ''
        if (!/(跳转|jump)/i.test(label)) continue
        if (!/(轮|turn)/i.test(label)) continue
        if (!new RegExp(`(?:第\\s*${number}\\s*轮|Turn\\s*${number}(?:\\D|$))`, 'i').test(label)) continue
        if (!elementVisible(button)) continue
        return button
      }
      return null
    }

    function matchRanges(rows, query) {
      const needle = String(query || '').toLocaleLowerCase()
      if (!needle) return []
      const ranges = []
      for (const row of rows) {
        if (!elementVisible(row)) continue
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.nodeValue && node.nodeValue.toLocaleLowerCase().includes(needle)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT
          },
        })
        while (walker.nextNode() && ranges.length < 200) {
          const node = walker.currentNode
          const parent = node.parentElement
          // Collapsed tool/reasoning bodies keep their text nodes in the DOM but
          // are not rendered; never mark text the reader cannot see.
          if (!parent || !elementVisible(parent)) continue
          const text = node.nodeValue || ''
          const lower = text.toLocaleLowerCase()
          let index = lower.indexOf(needle)
          while (index !== -1 && ranges.length < 200) {
            const range = document.createRange()
            range.setStart(node, index)
            range.setEnd(node, index + needle.length)
            if (range.getClientRects().length > 0) ranges.push(range)
            index = lower.indexOf(needle, index + needle.length)
          }
        }
      }
      return ranges
    }

    /**
     * Math is rendered by KaTeX, so raw Markdown such as `t_k` never appears as
     * one contiguous text node. Compare the query against the TeX annotation and
     * mark the formula element itself instead of a text range.
     */
    function normalizeMath(value) {
      return String(value || '')
        .toLocaleLowerCase()
        .replace(/[\s$_{}^\\]/g, '')
    }

    function formulaHits(rows, query) {
      const needle = normalizeMath(query)
      if (!needle) return []
      const hits = []
      const seen = new Set()
      for (const row of rows) {
        if (!elementVisible(row)) continue
        for (const element of row.querySelectorAll('.katex, mjx-container, math')) {
          if (seen.has(element) || !elementVisible(element)) continue
          seen.add(element)
          const annotation = element.querySelector('annotation[encoding="application/x-tex"]')
          const tex = annotation ? annotation.textContent : element.getAttribute('data-tex') || element.textContent || ''
          if (!normalizeMath(tex).includes(needle)) continue
          hits.push(element)
          if (hits.length >= 20) return hits
        }
      }
      return hits
    }

    /**
     * Last-resort match across split inline content (subscripts, emphasis, links):
     * walk visible text in a block, strip whitespace/markdown punctuation, and map
     * the match back to a multi-node Range.
     */
    function normalizedTextRanges(rows, query) {
      const needle = normalizeMath(query)
      if (!needle) return []
      const ranges = []
      for (const row of rows) {
        if (!elementVisible(row)) continue
        const blocks = row.querySelectorAll('p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote')
        const containers = blocks.length > 0 ? blocks : [row]
        for (const block of containers) {
          if (!elementVisible(block)) continue
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
          let normalized = ''
          const map = []
          while (walker.nextNode()) {
            const node = walker.currentNode
            const parent = node.parentElement
            if (!parent || !elementVisible(parent)) continue
            if (parent.closest('annotation, .katex-mathml, script, style, [hidden], [aria-hidden="true"]')) continue
            const text = node.nodeValue || ''
            for (let index = 0; index < text.length; index += 1) {
              const char = text[index]
              if (!char || /[\s_^{}\\]/.test(char)) continue
              normalized += char.toLocaleLowerCase()
              map.push({ node, offset: index })
            }
          }
          if (!normalized || map.length < needle.length) continue
          let index = normalized.indexOf(needle)
          const localSeen = new Set()
          while (index !== -1 && ranges.length < 40) {
            const start = map[index]
            const end = map[index + needle.length - 1]
            if (start && end && !localSeen.has(index)) {
              localSeen.add(index)
              const range = document.createRange()
              range.setStart(start.node, start.offset)
              range.setEnd(end.node, end.offset + 1)
              if (range.getClientRects().length > 0) ranges.push(range)
            }
            index = normalized.indexOf(needle, index + needle.length)
          }
        }
      }
      return ranges
    }

    function clearHighlight() {
      try {
        if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HIT_HIGHLIGHT)
      } catch {
        // older engines without the Custom Highlight API
      }
      clearFormulaHits()
    }

    function paintHighlight(ranges) {
      clearHighlight()
      if (!ranges.length) return false
      try {
        if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight !== 'function') return false
        CSS.highlights.set(HIT_HIGHLIGHT, new Highlight(...ranges))
        return true
      } catch {
        return false
      }
    }

    const formulaHitElements = new Set()

    function clearFormulaHits() {
      for (const element of formulaHitElements) element.classList.remove(FORMULA_HIT_CLASS)
      formulaHitElements.clear()
    }

    function paintFormulaHits(elements) {
      for (const element of elements || []) {
        if (!element || formulaHitElements.has(element)) continue
        formulaHitElements.add(element)
        element.classList.add(FORMULA_HIT_CLASS)
      }
    }

    function flashRowOf(range) {
      try {
        const node = range.startContainer
        const element = node && node.parentElement
        const row = element && element.closest('[data-chat-turn]')
        if (!row) return
        row.classList.add(FLASH_CLASS)
        setTimeout(() => row.classList.remove(FLASH_CLASS), 1600)
      } catch {
        // purely cosmetic
      }
    }

    /** Center the exact matched text, not just its row, in every scrollable ancestor. */
    function scrollRangeToCenter(range) {
      try {
        const host = range.startContainer && range.startContainer.parentElement
        if (!host) return
        host.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
        // Correct the outer scrollport once the smooth scroll settles; measuring
        // immediately would race the animation.
        setTimeout(() => {
          try {
            const rect = range.getBoundingClientRect()
            if (!rect || (!rect.width && !rect.height)) return
            let element = host
            while (element && element !== document.body) {
              const style = getComputedStyle(element)
              if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 8) {
                const view = element.getBoundingClientRect()
                const delta = rect.top + rect.height / 2 - (view.top + view.height / 2)
                if (Math.abs(delta) > 16) element.scrollBy({ top: delta, behavior: 'smooth' })
              }
              element = element.parentElement
            }
          } catch {
            // secondary correction only
          }
        }, 300)
      } catch {
        // scrolling is best effort
      }
    }

    function workspaceSnapshot(clientCtx) {
      try {
        const service = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('workspaces') : undefined
        if (!service) return { service: null, snapshot: null }
        const snapshot = service.list && typeof service.list.getSnapshot === 'function' ? service.list.getSnapshot() : null
        return { service, snapshot }
      } catch {
        return { service: null, snapshot: null }
      }
    }

    function workspaceIdForSession(clientCtx, sessionId) {
      const { snapshot } = workspaceSnapshot(clientCtx)
      if (!snapshot || !Array.isArray(snapshot.items)) return ''
      for (const workspace of snapshot.items) {
        if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
          return workspace.workspaceId || ''
        }
      }
      return ''
    }

    function currentSessionId(clientCtx) {
      try {
        const sessions = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : undefined
        const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
        if (!snapshot || !snapshot.byId) return ''
        for (const row of Object.values(snapshot.byId)) {
          if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.sessionId || ''
        }
      } catch {
        // unknown selection
      }
      return ''
    }

    function archivedSessionIds(clientCtx) {
      const { snapshot } = workspaceSnapshot(clientCtx)
      return snapshot && Array.isArray(snapshot.archivedSessionIds) ? new Set(snapshot.archivedSessionIds) : null
    }

    /**
     * Archived sessions are deliberately hidden from navigation; clicking one
     * would fall back to the workspace picker / a blank chat. Drop them from the
     * result list and keep the counters consistent with what is shown.
     */
    function filterOpenableResults(clientCtx, body) {
      try {
        const archived = archivedSessionIds(clientCtx)
        if (!archived || !body || !Array.isArray(body.items)) return body
        const kept = body.items.filter((item) => item && !archived.has(item.sessionId))
        if (kept.length === body.items.length) return body
        const totalHits = kept.reduce((sum, item) => sum + (item.totalGroups || 0), 0)
        const totalOccurrences = kept.reduce((sum, item) => sum + (item.occurrences || 0), 0)
        return {
          ...body,
          items: kept,
          totalHits,
          totalOccurrences,
          totalTurns: kept.length,
          totalSessions: new Set(kept.map((item) => item.sessionId)).size,
        }
      } catch {
        return body
      }
    }

    async function ensureTurnLoaded(clientCtx, sessionId, seq) {
      try {
        const sessions = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : undefined
        if (!sessions || !sessionId) return false
        let binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
        if (!binding && typeof sessions.using === 'function') {
          await sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
            binding = reference.binding
          })
        }
        const face = binding && binding.session
        if (!face) return false
        if (seq && typeof face.loadThrough === 'function') {
          await face.loadThrough(seq)
          await sleepMs(220)
          return true
        }
        if (typeof face.loadOlder === 'function') {
          await face.loadOlder()
          await sleepMs(180)
          return true
        }
      } catch {
        // fall back to the turn rail
      }
      return false
    }

    /**
     * Opening a session re-mounts the Chat and restores its saved reading
     * position slightly after mount; a jump issued before that settle gets
     * overwritten. Wait until the conversation scrollport exists and its
     * scrollTop stops moving.
     */
    async function waitForChatSettled(timeoutMs = 5000) {
      const findScroller = () => {
        for (const scroller of document.querySelectorAll('[data-conversation-scroll]')) {
          if (!elementVisible(scroller)) continue
          if (scroller.getBoundingClientRect().width < 120) continue
          return scroller
        }
        return null
      }
      const scroller = await waitFor(findScroller, timeoutMs)
      if (!scroller) return false
      let previous = null
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const current = findScroller()
        const top = current ? Math.round(current.scrollTop) : null
        if (top !== null && previous !== null && Math.abs(top - previous) <= 2) return true
        previous = top
        await sleepMs(200)
      }
      return true
    }

    /**
     * Open nothing by itself: the caller selects the session first. Returns
     * 'highlighted' when the match is visibly marked, 'turn' when the turn was
     * reached but the match is not rendered by the Chat surface (for example
     * injected system context), or 'failed'.
     */
    function rowKindOf(row) {
      if (row.querySelector('[data-tool]')) return 'tool'
      if (row.querySelector('[data-variant="think"]')) return 'reasoning'
      const kind = row.getAttribute('data-chat-flow-kind') || ''
      if (kind === 'user' || kind === 'steering') return 'user'
      if (kind.startsWith('assistant')) return 'assistant'
      return kind
    }

    /** Rows the clicked hit should live in; falls back to the whole turn. */
    function scopeRowsFor(rows, kind) {
      if (kind === 'tool' || kind === 'tool-result') {
        return rows.filter((row) => row.querySelector('[data-tool]'))
      }
      if (kind === 'reasoning') {
        return rows.filter((row) => row.querySelector('[data-variant="think"]'))
      }
      if (kind === 'user') {
        return rows.filter((row) => {
          const flow = row.getAttribute('data-chat-flow-kind') || ''
          return flow === 'user' || flow === 'steering'
        })
      }
      return rows
    }

    /**
     * Collapsed disclosures relevant to the clicked source: the inner rows of
     * that kind first (tool cards / reasoning bodies), and only when none are
     * mounted yet, the enclosing process-group headers that reveal them.
     */
    function disclosureCandidates(rows, kind) {
      const innerSelector =
        kind === 'reasoning' ? '[data-variant="think"]' : kind === 'tool' || kind === 'tool-result' ? '[data-tool]' : ''
      const inner = []
      const outer = []
      for (const row of rows) {
        for (const element of row.querySelectorAll('[aria-expanded="false"]')) {
          if (!(element instanceof HTMLElement)) continue
          if (element.getAttribute('aria-haspopup')) continue
          if (!elementVisible(element)) continue
          const inTool = element.closest('[data-tool]')
          const inReasoning = element.closest('[data-variant="think"]')
          if (innerSelector && element.closest(innerSelector)) inner.push(element)
          else if (!inTool && !inReasoning) outer.push(element)
        }
      }
      return inner.length ? inner : outer
    }

    async function focusTurnAndHighlight(turn, query, expectedTitle, options = {}) {
      const number = Number(turn)
      const slow = options.slow === true
      const kind = options.kind || ''
      if (!number) return { outcome: 'failed', count: 0, expanded: 0 }
      clearHighlight()
      if (expectedTitle) {
        await waitFor(() => String(document.title || '').includes(expectedTitle), 800, 100)
      }
      await waitForChatSettled(slow ? 9000 : 3500)
      const jump = (await waitFor(() => findTurnJumpButton(number), slow ? 6000 : 3000)) || (await findTurnJumpButtonAsync(number))
      if (jump) {
        try {
          jump.click()
        } catch {
          // fall through to whatever the turn already exposes
        }
      }
      let rows = await waitFor(() => {
        const list = turnRows(number)
        return list.length > 0 ? list : null
      }, slow ? 10000 : 5000)
      if (!rows) {
        // A freshly connected workspace can need a second settling pass.
        await sleepMs(1200)
        await waitForChatSettled(slow ? 6000 : 2500)
        const retry = (await waitFor(() => findTurnJumpButton(number), slow ? 6000 : 3000)) || (await findTurnJumpButtonAsync(number))
        if (retry) {
          try {
            retry.click()
          } catch {
            // retry is best effort
          }
        }
        rows = await waitFor(() => {
          const list = turnRows(number)
          return list.length > 0 ? list : null
        }, slow ? 8000 : 4000)
      }
      if (!rows) return { outcome: 'failed', count: 0, expanded: 0 }
      await sleepMs(300)
      rows = turnRows(number)
      const firstRow = rows.find((row) => elementVisible(row)) || rows[0]
      if (firstRow) {
        try {
          firstRow.scrollIntoView({ block: 'start', behavior: 'auto' })
        } catch {
          // scrolling is best effort
        }
      }

      let expanded = 0
      let ranges = matchRanges(scopeRowsFor(rows, kind), query)

      // Tool and reasoning hits start collapsed. Expand one disclosure at a time,
      // scanning only the clicked hit's own row kind after each click, and stop
      // at the first match instead of expanding the whole turn.
      const needsExpand = kind === 'tool' || kind === 'tool-result' || kind === 'reasoning'
      if (needsExpand && !ranges.length) {
        const attempted = new Set()
        const deadline = Date.now() + 6000
        while (Date.now() < deadline && expanded < 30) {
          const candidates = disclosureCandidates(turnRows(number), kind).filter((element) => !attempted.has(element))
          if (!candidates.length) break
          let clicked = false
          for (const candidate of candidates) {
            attempted.add(candidate)
            expanded += 1
            clicked = true
            try {
              candidate.click()
            } catch {
              // a stale disclosure is skipped
            }
            await sleepMs(70)
            const fresh = turnRows(number)
            const scope = scopeRowsFor(fresh, kind)
            ranges = matchRanges(scope, query)
            if (ranges.length) break
            if (formulaHits(scope, query).length) break
            if (expanded >= 30 || Date.now() > deadline) break
          }
          if (ranges.length || !clicked) break
        }
      }
      let formulaEls = []
      if (!ranges.length) {
        // Markdown-rendered math (`t_k` → KaTeX) has no literal text node for the
        // raw source, so match the TeX annotation and mark the formula element.
        formulaEls = formulaHits(scopeRowsFor(turnRows(number), kind), query)
        if (!formulaEls.length) formulaEls = formulaHits(turnRows(number), query)
      }
      if (!ranges.length && (kind === '' || kind === 'user' || kind === 'assistant')) {
        // Last resort for plain conversation hits: any visible occurrence, then
        // a cross-node match that tolerates subscripts/emphasis splitting.
        ranges = matchRanges(turnRows(number), query)
        if (!ranges.length) ranges = normalizedTextRanges(turnRows(number), query)
      }

      if (ranges.length || formulaEls.length) {
        paintHighlight(ranges)
        paintFormulaHits(formulaEls)
        const target = formulaEls[0] || null
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' })
          const row = target.closest('[data-chat-turn]')
          if (row) {
            row.classList.add(FLASH_CLASS)
            setTimeout(() => row.classList.remove(FLASH_CLASS), 1600)
          }
        } else {
          flashRowOf(ranges[0])
          scrollRangeToCenter(ranges[0])
        }
        return { outcome: 'highlighted', count: ranges.length + formulaEls.length, expanded }
      }

      // Even when the match itself is not rendered (injected system context),
      // scroll and flash the turn so the user still sees where the hit lives.
      const visibleRow = turnRows(number).find((row) => elementVisible(row))
      if (visibleRow) {
        visibleRow.classList.add(FLASH_CLASS)
        setTimeout(() => visibleRow.classList.remove(FLASH_CLASS), 1600)
        visibleRow.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      return { outcome: 'turn', count: 0, expanded }
    }

    function formatTime(ms) {
      if (!ms) return ''
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function formatRelative(ms) {
      if (!ms) return ''
      const t = copy()
      const diff = Date.now() - ms
      const minute = 60000
      const hour = 60 * minute
      const day = 24 * hour
      if (diff < minute) return t.justNow
      if (diff < hour) return `${Math.floor(diff / minute)} ${t.minutesAgo}`
      if (diff < day) return `${Math.floor(diff / hour)} ${t.hoursAgo}`
      if (diff < 30 * day) return `${Math.floor(diff / day)} ${t.daysAgo}`
      return formatTime(ms).slice(0, 10)
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B'
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    const KIND_META = {
      user: { zh: '用户', en: 'You', tone: 'user' },
      assistant: { zh: '助手', en: 'Assistant', tone: 'assistant' },
      system: { zh: '系统', en: 'System', tone: 'system' },
      tool: { zh: '工具', en: 'Tool', tone: 'tool' },
      'tool-result': { zh: '工具', en: 'Tool', tone: 'tool' },
      reasoning: { zh: '思考', en: 'Reasoning', tone: 'reasoning' },
    }

    function kindLabel(kind) {
      const bilingual = copy()
      if (kind === 'user') return bilingual.kindUser
      if (kind === 'assistant') return bilingual.kindAssistant
      if (kind === 'tool' || kind === 'tool-result') return bilingual.kindTool
      if (kind === 'reasoning') return bilingual.kindReasoning
      return bilingual.kindSystem
    }

    const STYLES = `
.sex-panel { display: flex; flex-direction: column; gap: 0; height: 100%; min-height: 100%; overflow-y: auto; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.sex-inner { display: flex; flex-direction: column; gap: 18px; width: 100%; max-width: 900px; margin: 0 auto; padding: 28px 32px 40px; box-sizing: border-box; }
.sex-head { display: flex; flex-direction: column; gap: 6px; }
.sex-panel {
  --sex-accent: #4176e6;
  --sex-accent-strong: #3564d8;
  --sex-accent-soft: color-mix(in srgb, #4176e6 9%, transparent);
  --sex-accent-mid: color-mix(in srgb, #4176e6 17%, transparent);
  --sex-accent-line: color-mix(in srgb, #4176e6 30%, transparent);
  --sex-surface: var(--dsw-alias-bg-layer-1);
  --sex-surface-raised: var(--dsw-alias-bg-layer-2);
  --sex-rising: cubic-bezier(.2, .8, .2, 1);
}
.sex-title { margin: 0; font-size: 18.5px; line-height: 1.35; font-weight: 600; letter-spacing: -0.012em; }
.sex-lead { margin: 0; font-size: 12.5px; line-height: 1.62; color: var(--dsw-alias-label-secondary); }
.sex-searchbar { display: flex; align-items: center; gap: 10px; }
.sex-inputwrap { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.sex-input-icon { position: absolute; left: 13px; display: flex; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); pointer-events: none; transition: color .16s ease; }
.sex-inputwrap:focus-within .sex-input-icon { color: var(--sex-accent); }
.sex-input { box-sizing: border-box; width: 100%; height: 42px; padding: 0 38px 0 37px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--sex-surface); font: inherit; font-size: 14px; line-height: 1.5; color: var(--dsw-alias-label-primary); transition: border-color .16s ease, box-shadow .16s ease, background .16s ease; }
.sex-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .8; }
.sex-input:focus { outline: none; border-color: var(--sex-accent-line); box-shadow: 0 0 0 3px var(--sex-accent-soft); background: var(--dsw-alias-bg-base); }
.sex-clear { position: absolute; right: 8px; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background .14s ease, color .14s ease; }
.sex-clear:hover { background: var(--sex-surface-raised); color: var(--dsw-alias-label-primary); }
.sex-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 34px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px; background: transparent; font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); cursor: pointer; transition: background .15s ease, border-color .15s ease, transform .12s ease, box-shadow .15s ease; }
.sex-button:hover:not(:disabled) { background: var(--sex-surface-raised); }
.sex-button:active:not(:disabled) { transform: scale(.975); }
.sex-button:disabled { opacity: .45; cursor: default; }
.sex-button.primary { flex: 0 0 auto; min-width: 72px; border-color: transparent; background: var(--sex-accent); color: #ffffff; font-weight: 550; box-shadow: 0 6px 16px -10px var(--sex-accent); }
.sex-button.primary:hover:not(:disabled) { background: var(--sex-accent-strong); box-shadow: 0 8px 20px -10px var(--sex-accent); }
.sex-chips { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.sex-chips-label { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-right: 2px; }
.sex-chip { display: inline-flex; align-items: center; gap: 6px; height: 27px; padding: 0 11px; border: 0.5px solid transparent; border-radius: 999px; background: transparent; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background .15s ease, color .15s ease, box-shadow .15s ease, transform .12s ease; }
.sex-chip:hover { background: var(--sex-surface-raised); }
.sex-chip:active { transform: scale(.97); }
.sex-chip[aria-pressed='true'] { color: var(--sex-accent-strong); background: var(--sex-accent-soft); box-shadow: inset 0 0 0 0.5px var(--sex-accent-line); }
.sex-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: color-mix(in srgb, currentColor 55%, transparent); transition: background .15s ease, transform .15s ease; }
.sex-chip[aria-pressed='true'] .sex-chip-dot { background: var(--sex-accent); transform: scale(1.15); }
.sex-sort { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.sex-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; row-gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sex-statusline { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.sex-statusdot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); transition: background .2s ease; }
.sex-statusdot.busy { background: var(--dsw-alias-state-warn-primary); animation: sex-pulse 1.4s ease-in-out infinite; }
.sex-banner { display: flex; align-items: flex-start; gap: 10px; padding: 10px 13px; border-radius: 10px; font-size: 12.5px; line-height: 1.6; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); color: var(--dsw-alias-label-primary); border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); }
.sex-banner.info { background: var(--sex-surface); border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.sex-progress { display: flex; flex-direction: column; gap: 8px; padding: 13px 15px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--sex-surface); }
.sex-progress-head { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; }
.sex-progress-title { font-weight: 550; color: var(--sex-accent-strong); }
.sex-progress-text { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.sex-bar { position: relative; height: 3px; border-radius: 999px; background: var(--sex-surface-raised); overflow: hidden; }
.sex-bar-fill { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 999px; background: linear-gradient(90deg, var(--sex-accent), #7aaaff); transition: width .4s var(--sex-rising); }
.sex-bar-fill::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.5), transparent); transform: translateX(-100%); animation: sex-shimmer 1.6s ease-in-out infinite; }
.sex-hit-text { color: var(--dsw-alias-label-primary); word-break: break-word; }
.sex-hit-text mark { padding: 0 3px; border-radius: 4px; background: var(--sex-accent-mid); color: var(--sex-accent-strong); font-weight: 550; box-decoration-break: clone; }
.sex-list { display: flex; flex-direction: column; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--sex-surface); overflow: hidden; }
.sex-row { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border: 0; background: none; font: inherit; text-align: left; cursor: pointer; color: inherit; transition: background .15s ease; }
.sex-row + .sex-row { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.sex-row:hover { background: var(--sex-surface-raised); }
.sex-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.sex-row-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sex-row-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sex-row-count { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sex-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 44px 20px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.7; text-align: center; }
.sex-empty-icon { color: var(--dsw-alias-label-secondary); opacity: .5; }
.sex-shortcut { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0.5px solid transparent; border-radius: 8px; background: transparent; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background .15s ease, color .15s ease; }
.sex-shortcut:hover { color: var(--dsw-alias-label-primary); background: var(--sex-surface-raised); }
.sex-shortcut:focus-visible { outline: 2px solid var(--sex-accent); outline-offset: 1px; }
.sex-rail { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: currentColor; }
.sex-spinner { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent; animation: sex-spin 720ms linear infinite; }
@keyframes sex-spin { to { transform: rotate(360deg); } }
@keyframes sex-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes sex-shimmer { to { transform: translateX(100%); } }
@keyframes sex-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes sex-row-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@keyframes sex-toast-in { from { opacity: 0; transform: translate(-50%, 10px) scale(.98); } to { opacity: 1; transform: translate(-50%, 0) scale(1); } }
@keyframes sex-toast-out { from { opacity: 1; transform: translate(-50%, 0) scale(1); } to { opacity: 0; transform: translate(-50%, 6px) scale(.99); } }

/* Compact result list: one WeChat-style row per turn, no per-source section
   headers, so snippets sit right under the title instead of in tall cards. */
.sex-inner { gap: 15px; padding: 22px 26px 34px; animation: sex-rise .36s cubic-bezier(.16, 1, .3, 1) both; }
.sex-results { display: flex; flex-direction: column; gap: 0; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--sex-surface); overflow: hidden; box-shadow: 0 1px 2px rgba(15, 23, 42, .03); animation: sex-rise .38s cubic-bezier(.16, 1, .3, 1) both; }
.sex-hit-row { display: flex; flex-direction: column; gap: 2px; padding: 9px 13px 10px; cursor: pointer; transition: background .14s ease; animation: sex-row-in .3s var(--sex-rising) both; }
.sex-hit-row:hover { background: var(--sex-surface-raised); }
.sex-hit-row:focus-visible { outline: 2px solid var(--sex-accent); outline-offset: -2px; }
.sex-hit-row + .sex-hit-row { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.sex-hit-row:nth-child(1) { animation-delay: 0ms; }
.sex-hit-row:nth-child(2) { animation-delay: 15ms; }
.sex-hit-row:nth-child(3) { animation-delay: 30ms; }
.sex-hit-row:nth-child(4) { animation-delay: 45ms; }
.sex-hit-row:nth-child(5) { animation-delay: 60ms; }
.sex-hit-row:nth-child(6) { animation-delay: 75ms; }
.sex-hit-row:nth-child(n+7) { animation-delay: 85ms; }
.sex-hit-row-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.sex-hit-row-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.2px; font-weight: 560; letter-spacing: -0.006em; color: var(--dsw-alias-label-primary); }
.sex-hit-row-turn { flex: 0 0 auto; font-size: 10.5px; padding: 1px 6px; border-radius: 999px; color: var(--dsw-alias-label-secondary); background: var(--sex-surface-raised); }
.sex-hit-row-date { flex: 0 0 auto; margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.sex-hit-row-snippet { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.sex-hit-row-snippet .sex-hit-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; line-height: 1.58; color: var(--dsw-alias-label-secondary); }
.sex-hit-row-snippet .sex-hit-text mark,
.sex-hit-row-extra .sex-hit-text mark { padding: 0 3px; border-radius: 4px; background: var(--sex-accent-mid); color: var(--sex-accent-strong); font-weight: 550; }
.sex-kind-tag { flex: 0 0 auto; padding: 1px 6px; border-radius: 6px; font-size: 10px; line-height: 1.5; letter-spacing: .01em; color: var(--dsw-alias-label-secondary); background: var(--sex-surface-raised); }
.sex-kind-tag.user { color: var(--sex-accent-strong); background: var(--sex-accent-soft); }
.sex-kind-tag.assistant { color: var(--dsw-alias-label-primary); }
.sex-kind-tag.tool { color: #b7791f; background: color-mix(in srgb, #f59e0b 14%, transparent); }
.sex-kind-tag.reasoning { color: var(--dsw-alias-label-secondary); opacity: .85; }
.sex-kind-tag.system { color: var(--dsw-alias-label-secondary); }
.sex-hit-row-meta { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.sex-hit-row-counts { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sex-hit-row-more { flex: 0 0 auto; margin-left: auto; padding: 2px 8px; border: 0; border-radius: 999px; background: transparent; font: inherit; font-size: 11px; color: var(--sex-accent-strong); cursor: pointer; transition: background .14s ease; }
.sex-hit-row-more:hover { background: var(--sex-accent-soft); }
.sex-hit-row-extra { display: flex; align-items: baseline; gap: 7px; min-width: 0; margin-top: 4px; padding-top: 5px; border-top: 0.5px dashed var(--dsw-alias-border-l1); animation: sex-row-in .22s var(--sex-rising) both; }
.sex-hit-row-extra .sex-hit-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sex-hit-row-note { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sex-viewall { align-self: center; margin: 10px 0 2px; padding: 5px 14px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--sex-surface); font: inherit; font-size: 12px; color: var(--sex-accent-strong); cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.sex-viewall:hover { background: var(--sex-accent-soft); border-color: var(--sex-accent-line); }
.sex-viewall { align-self: center; margin: 10px 0 2px; padding: 5px 14px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--sex-surface); font: inherit; font-size: 12px; color: var(--sex-accent-strong); cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.sex-viewall:hover { background: var(--sex-accent-soft); border-color: var(--sex-accent-line); }

/* Loading skeleton: keep the layout stable while a query is in flight. */
.sex-skeleton { display: flex; flex-direction: column; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--sex-surface); overflow: hidden; animation: sex-rise .3s var(--sex-rising) both; }
.sex-skeleton-row { display: flex; flex-direction: column; gap: 7px; padding: 10px 13px 12px; }
.sex-skeleton-row + .sex-skeleton-row { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.sex-skeleton-line { height: 9px; border-radius: 6px; background: linear-gradient(90deg, var(--sex-surface-raised) 25%, var(--dsw-alias-bg-base) 37%, var(--sex-surface-raised) 63%); background-size: 400% 100%; animation: sex-skeleton 1.5s ease-in-out infinite; }
.sex-skeleton-line.title { width: 38%; height: 10px; }
.sex-skeleton-line.body { width: 82%; }
@keyframes sex-skeleton { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

/* Matches inside the real conversation use the CSS Custom Highlight API, so no
   chat node is touched. A soft blue wash with a crisp underline reads better
   than a solid blue block, and stays legible in both themes. */
::highlight(dsh-session-search-hit) {
  background-color: color-mix(in srgb, #4176e6 22%, transparent);
  color: inherit;
  text-decoration: underline 2px #4176e6;
  text-underline-offset: 2px;
}
body[data-ds-dark-theme] ::highlight(dsh-session-search-hit) {
  background-color: color-mix(in srgb, #7aaaff 28%, transparent);
  text-decoration-color: #7aaaff;
}
.dsh-session-search-flash { animation: dsh-session-search-flash 1.5s var(--sex-rising); }
@keyframes dsh-session-search-flash {
  0% { box-shadow: inset 3px 0 0 #4176e6; background: color-mix(in srgb, #4176e6 8%, transparent); }
  60% { box-shadow: inset 3px 0 0 color-mix(in srgb, #4176e6 45%, transparent); }
  100% { box-shadow: inset 3px 0 0 transparent; background: transparent; }
}
.dsh-session-search-formula {
  background: color-mix(in srgb, #4176e6 14%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, #4176e6 24%, transparent);
  border-radius: 6px;
  transition: background .2s ease, box-shadow .2s ease;
}
.dsh-session-search-formula {
  background: color-mix(in srgb, #4176e6 14%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, #4176e6 24%, transparent);
  border-radius: 6px;
  transition: background .2s ease, box-shadow .2s ease;
}

/* Toast lives in the shell overlay: a compact tinted pill with a status icon. */
.sex-toast {
  position: fixed; left: 50%; bottom: 36px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
  max-width: min(72vw, 640px); padding: 8px 15px 8px 10px;
  border-radius: 999px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 94%, transparent);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 14px 34px -18px rgba(15, 23, 42, .38), 0 0 0 0.5px rgba(255,255,255,.02) inset;
  font-size: 12.5px; line-height: 1.5; pointer-events: none;
  animation: sex-toast-in .3s var(--sex-rising) both;
}
.sex-toast.closing { animation: sex-toast-out .18s ease both; }
.sex-toast-icon { flex: none; width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #4176e6; background: color-mix(in srgb, #4176e6 12%, transparent); }
.sex-toast.success .sex-toast-icon { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.sex-toast.warn .sex-toast-icon { color: var(--dsw-alias-state-warn-primary, #b7791f); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b7791f) 15%, transparent); }
.sex-toast.busy .sex-toast-icon { color: #4176e6; background: color-mix(in srgb, #4176e6 12%, transparent); }
.sex-toast.busy .sex-spinner { width: 11px; height: 11px; border-width: 1.4px; }
.sex-toast-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 720px) {
  .sex-inner { padding: 18px 14px 28px; }
  .sex-searchbar { flex-wrap: wrap; }
  .sex-button.primary { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .sex-panel *, .sex-panel *::before, .sex-panel *::after, .sex-toast, .sex-toast * {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
  .sex-bar-fill::after { display: none; }
}
`

    const ICON_SEARCH = h(
      'svg',
      { viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('circle', { cx: 7, cy: 7, r: 4.5 }),
      h('path', { d: 'M10.4 10.4 14 14' }),
    )

    const ICON_CLOSE = h(
      'svg',
      { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true },
      h('path', { d: 'M4 4l8 8M12 4l-8 8' }),
    )

    function useStatus() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const load = useCallback(async () => {
        try {
          const next = await request('/status')
          setStatus(next)
          setError('')
        } catch (cause) {
          setError(cause.message || String(cause))
        }
      }, [])
      useEffect(() => {
        let alive = true
        const tick = async () => {
          if (!alive) return
          await load()
        }
        void tick()
        const timer = setInterval(tick, 1500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])
      return [status, error, load]
    }

    function SearchPage(props) {
      const ctx = props && props.ctx
      const t = copy()
      const [query, setQuery] = useState(PANEL_MEMORY.query)
      const [kinds, setKinds] = useState(() => [...PANEL_MEMORY.kinds])
      const [sortMode, setSortMode] = useState(PANEL_MEMORY.sortMode)
      const [pageSize, setPageSize] = useState(PANEL_MEMORY.pageSize || 5)
      const [expanded, setExpanded] = useState(() => new Set(PANEL_MEMORY.expanded))
      const [result, setResult] = useState(PANEL_MEMORY.result)
      const [recent, setRecent] = useState([])
      const [loading, setLoading] = useState(false)
      const [searchError, setSearchError] = useState(PANEL_MEMORY.searchError)
      const [rebuildNote, setRebuildNote] = useState('')
      const [jumpNote, setJumpNote] = useState(PANEL_MEMORY.jumpNote)
      const [status, statusError] = useStatus()
      const inputRef = useRef(null)
      const panelRef = useRef(null)
      const requestId = useRef(0)
      const jumpTicket = useRef(0)
      const skipAutoRun = useRef(Boolean(PANEL_MEMORY.result))
      const building = Boolean(status && status.building)
      const previousBuilding = useRef(false)

      useEffect(() => {
        PANEL_MEMORY.query = query
        PANEL_MEMORY.kinds = [...kinds]
        PANEL_MEMORY.sortMode = sortMode
        PANEL_MEMORY.pageSize = pageSize
        PANEL_MEMORY.expanded = new Set(expanded)
        PANEL_MEMORY.result = result
        PANEL_MEMORY.jumpNote = jumpNote
        PANEL_MEMORY.searchError = searchError
      }, [query, kinds, sortMode, pageSize, expanded, result, jumpNote, searchError])

      useEffect(() => {
        const top = PANEL_MEMORY.scrollTop
        if (!top) return undefined
        const apply = () => {
          if (panelRef.current) panelRef.current.scrollTop = top
        }
        const raf = requestAnimationFrame(apply)
        const timer = setTimeout(apply, 260)
        return () => {
          cancelAnimationFrame(raf)
          clearTimeout(timer)
        }
      }, [])

      const openSession = useCallback(
        (id) => {
          try {
            const workspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
            if (workspace && typeof workspace.openSession === 'function') workspace.openSession(id)
          } catch {
            // navigation is best effort
          }
        },
        [ctx],
      )

      const jumpToTurn = useCallback(
        (item) => {
          const text = (result && result.query) || query.trim()
          setJumpNote('')
          const ticket = ++jumpTicket.current
          notifyToast(copy().jumpStart.replace('{turn}', String(item.turn)), 'busy')
          if (!item.turn) {
            openSession(item.sessionId)
            setJumpNote(copy().jumpTurnOnly)
            return
          }
          const archived = archivedSessionIds(ctx)
          if (archived && archived.has(item.sessionId)) {
            notifyToast(copy().jumpArchived, 'warn')
            setJumpNote(copy().jumpArchived)
            return
          }
          const workspaceId = workspaceIdForSession(ctx, item.sessionId)
          if (!workspaceId) {
            notifyToast(copy().jumpNoWorkspace, 'warn')
            setJumpNote(copy().jumpNoWorkspace)
            return
          }
          void (async () => {
            try {
              const { service: workspaceService } = workspaceSnapshot(ctx)
              const currentWorkspace = workspaceIdForSession(ctx, currentSessionId(ctx))
              const sameWorkspace = Boolean(currentWorkspace) && currentWorkspace === workspaceId
              if (!sameWorkspace && workspaceService && typeof workspaceService.openWorkspace === 'function') {
                // Cross-workspace hits need their workspace connected first;
                // opening the session alone falls back to the workspace picker.
                await Promise.race([workspaceService.openWorkspace(workspaceId), sleepMs(6000)])
              }
              openSession(item.sessionId)
              const seq = Math.max(0, ...((item.hits || []).map((hit) => Number(hit.seq) || 0)))
              await sleepMs(180)
              // The host round-trip must never pin the jump; the turn rail is
              // still there as a fallback when history loading is slow.
              await Promise.race([ensureTurnLoaded(ctx, item.sessionId, seq), sleepMs(2600)])
              const primary = (item.hits && item.hits[0]) || null
              const outcome = await focusTurnAndHighlight(item.turn, text, item.title, {
                slow: !sameWorkspace,
                kind: primary ? primary.kind : '',
              })
              if (ticket !== jumpTicket.current) return
              if (outcome.outcome === 'highlighted') {
                notifyToast(copy().jumpDone.replace('{turn}', String(item.turn)).replace('{n}', String(outcome.count)), 'success')
                setJumpNote('')
              } else if (outcome.outcome === 'turn') {
                notifyToast(copy().jumpHidden.replace('{n}', String(item.turn)), 'warn')
                setJumpNote(copy().jumpHidden.replace('{n}', String(item.turn)))
              } else {
                notifyToast(copy().jumpFailed, 'warn')
                setJumpNote(copy().jumpFailed)
              }
            } catch {
              if (ticket === jumpTicket.current) {
                notifyToast(copy().jumpFailed, 'warn')
                setJumpNote(copy().jumpFailed)
              }
            }
          })()
        },
        [ctx, openSession, query, result],
      )

      const runSearch = useCallback(
        async (text, kindList, sort, size) => {
          const trimmed = String(text || '').trim()
          if (trimmed === '') {
            setResult(null)
            setSearchError('')
            return
          }
          const expandedKinds = kindList.flatMap((kind) => (kind === 'tool' ? ['tool', 'tool-result'] : [kind]))
          const ticket = ++requestId.current
          setLoading(true)
          setSearchError('')
          try {
            const body = await request(
              `/search?q=${encodeURIComponent(trimmed)}&kinds=${encodeURIComponent(expandedKinds.join(','))}` +
                `&limit=6&turns=${Number(size) || 5}&sort=${sort === 'time' ? 'time' : 'weight'}`,
            )
            if (ticket !== requestId.current) return
            setResult(filterOpenableResults(ctx, body))
          } catch (cause) {
            if (ticket !== requestId.current) return
            setSearchError(cause.message || String(cause))
            setResult(null)
          } finally {
            if (ticket === requestId.current) setLoading(false)
          }
        },
        [ctx],
      )

      useEffect(() => {
        if (skipAutoRun.current) {
          skipAutoRun.current = false
          return undefined
        }
        const trimmed = query.trim()
        if (trimmed === '') {
          setResult(null)
          setSearchError('')
          return undefined
        }
        const timer = setTimeout(() => {
          void runSearch(trimmed, kinds, sortMode, pageSize)
        }, 240)
        return () => clearTimeout(timer)
      }, [query, kinds, sortMode, pageSize, runSearch])

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const body = await request('/sessions?limit=24')
            if (alive) setRecent(body.sessions || [])
          } catch {
            // the empty state simply stays empty
          }
        }
        void load()
        return () => {
          alive = false
        }
      }, [status ? status.sessions : 0])

      useEffect(() => {
        const focus = () => {
          if (inputRef.current) {
            try {
              inputRef.current.focus({ preventScroll: true })
            } catch {
              inputRef.current.focus()
            }
          }
        }
        const timer = setTimeout(focus, 60)
        return () => clearTimeout(timer)
      }, [])

      useEffect(() => {
        // A finished build may have produced matches the earlier query missed.
        if (previousBuilding.current && status && !status.building && query.trim() !== '') {
          void runSearch(query, kinds, sortMode, pageSize)
        }
        previousBuilding.current = Boolean(status && status.building)
      }, [status, query, kinds, sortMode, pageSize, runSearch])

      const toggleKind = (kind) => {
        setPageSize(5)
        setKinds((current) => {
          if (current.includes(kind)) {
            const next = current.filter((item) => item !== kind)
            return next.length === 0 ? current : next
          }
          return [...current, kind]
        })
      }

      const rebuild = async () => {
        setRebuildNote(t.rebuilding)
        try {
          await request('/rebuild', { method: 'POST' })
        } catch (cause) {
          setSearchError(cause.message || String(cause))
        }
      }

      const total = result ? result.totalHits || 0 : 0
      const sessionCount = result ? result.totalSessions || 0 : 0
      const turnCount = result ? result.totalTurns || 0 : 0
      const progressPercent = status && status.progress && status.progress.total > 0 ? Math.round((status.progress.done / status.progress.total) * 100) : 0

      const renderSnippet = (segments, key) =>
        h(
          'span',
          { key, className: 'sex-hit-text' },
          (segments || []).map((part, index) => (part.t === 'hit' ? h('mark', { key: index }, part.s) : h('span', { key: index }, part.s))),
        )

      const renderStatusLine = () => {
        if (!status) return null
        const parts = []
        parts.push(`${t.statusIndex} ${formatCount(status.sessions)} ${t.sessionsLabel}`)
        parts.push(`${formatCount(status.messages)} ${t.statusMessages}`)
        if (status.dbBytes) parts.push(formatBytes(status.dbBytes))
        if (status.lastSyncAt) parts.push(`${t.statusSynced} ${formatRelative(status.lastSyncAt)}`)
        if (status.failedSessions) parts.push(`${status.failedSessions} ${t.skipped}`)
        return h(
          'div',
          { className: 'sex-statusline' },
          h('span', { className: `sex-statusdot${status.building ? ' busy' : ''}` }),
          h('span', null, parts.join(' · ')),
        )
      }

      const chips = h(
        'div',
        { className: 'sex-chips' },
        h('span', { className: 'sex-chips-label' }, `${t.kinds}:`),
        ...ALL_KIND_SET.map((kind) => {
          const label =
            kind === 'user'
              ? t.kindUser
              : kind === 'assistant'
                ? t.kindAssistant
                : kind === 'tool'
                  ? t.kindTool
                  : kind === 'reasoning'
                    ? t.kindReasoning
                    : t.kindSystem
          return h(
            'button',
            {
              key: kind,
              type: 'button',
              className: 'sex-chip',
              'aria-pressed': kinds.includes(kind) ? 'true' : 'false',
              onClick: () => toggleKind(kind),
              title: label,
            },
            h('span', { className: 'sex-chip-dot' }),
            label,
          )
        }),
      )

      const sortControls = h(
        'div',
        { className: 'sex-sort' },
        h('span', { className: 'sex-chips-label' }, `${t.sortLabel}:`),
        h(
          'button',
          {
            type: 'button',
            className: 'sex-chip',
            'aria-pressed': sortMode === 'weight' ? 'true' : 'false',
            onClick: () => {
              setPageSize(5)
              setSortMode('weight')
            },
          },
          t.sortWeight,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'sex-chip',
            'aria-pressed': sortMode === 'time' ? 'true' : 'false',
            onClick: () => {
              setPageSize(5)
              setSortMode('time')
            },
          },
          t.sortTime,
        ),
      )

      const searchBar = h(
        'div',
        { className: 'sex-searchbar' },
        h(
          'div',
          { className: 'sex-inputwrap' },
          h('span', { className: 'sex-input-icon' }, ICON_SEARCH),
          h('input', {
            ref: inputRef,
            className: 'sex-input',
            value: query,
            placeholder: t.placeholder,
            spellCheck: false,
            onChange: (event) => {
              setPageSize(5)
              setQuery(event.target.value)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                setPageSize(5)
                void runSearch(query, kinds, sortMode, 5)
              }
              if (event.key === 'Escape') setQuery('')
            },
          }),
          query !== ''
            ? h('button', { type: 'button', className: 'sex-clear', onClick: () => setQuery(''), title: t.clear, 'aria-label': t.clear }, ICON_CLOSE)
            : null,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'sex-button primary',
            onClick: () => {
              setPageSize(5)
              void runSearch(query, kinds, sortMode, 5)
            },
            disabled: loading || query.trim() === '',
            'aria-busy': loading ? 'true' : 'false',
          },
          loading ? h('span', { className: 'sex-spinner' }) : null,
          t.search,
        ),
      )

      const header = h(
        'div',
        { className: 'sex-head' },
        h('h2', { className: 'sex-title' }, t.title),
        h('p', { className: 'sex-lead' }, t.lead),
      )

      const progress = building
        ? h(
            'div',
            { className: 'sex-progress' },
            h(
              'div',
              { className: 'sex-progress-head' },
              h('span', { className: 'sex-progress-title' }, `${t.building}…`),
              h('span', { className: 'sex-progress-text' }, `${status.progress.done} / ${status.progress.total} · ${progressPercent}%`),
            ),
            h('div', { className: 'sex-bar' }, h('div', { className: 'sex-bar-fill', style: { width: `${progressPercent}%` } })),
            h('div', { className: 'sex-progress-text' }, t.buildingHint),
          )
        : null

      const errorBanner = searchError
        ? h('div', { className: 'sex-banner' }, `${t.errorPrefix}${searchError}`, h('button', { type: 'button', className: 'sex-button', onClick: () => void runSearch(query, kinds, sortMode, pageSize) }, t.retry))
        : null

      const statusUnavailable = status && status.dbError
        ? h('div', { className: 'sex-banner' }, `${t.unavailable}：${status.dbError}`)
        : statusError
          ? h('div', { className: 'sex-banner' }, `${t.failed}：${statusError}`)
          : null

      const jumpBanner = jumpNote
        ? h(
            'div',
            { className: 'sex-banner info' },
            jumpNote,
            h(
              'button',
              { type: 'button', className: 'sex-button', style: { marginLeft: 'auto' }, onClick: () => setJumpNote('') },
              t.closeNote,
            ),
          )
        : null

      const roundLabel = (item) =>
        item.turn > 0 ? t.roundLabel.replace('{n}', String(item.turn)) : t.roundUnknown
      const toggleExpanded = (key) =>
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      const kindTag = (kind) =>
        h(
          'span',
          { className: `sex-kind-tag ${KIND_META[kind] ? KIND_META[kind].tone : 'system'}` },
          kindLabel(kind),
        )

      /**
       * One compact row per (session, turn), WeChat-search style: title + date on
       * the first line, the best matching snippet on the second (with an inline
       * source tag), counts and an expand control on the third. No per-category
       * section headers, so nothing is spread out vertically.
       */
      const renderCompactRow = (item) => {
        const hits = item.hits || []
        const key = item.key || `${item.sessionId}#${item.turn}`
        const open = expanded.has(key)
        const extra = open ? hits.slice(1, 5) : []
        const first = hits[0]
        const counts = item.kindCounts || {}
        const countParts = [
          counts.user ? `${t.kindUser} ${counts.user}` : '',
          counts.assistant ? `${t.kindAssistant} ${counts.assistant}` : '',
          counts.tool ? `${t.kindTool} ${counts.tool}` : '',
          counts.reasoning ? `${t.kindReasoning} ${counts.reasoning}` : '',
          counts.system ? `${t.kindSystem} ${counts.system}` : '',
        ].filter(Boolean)
        const totalGroups = item.totalGroups || hits.length
        const canExpand = totalGroups > 1 || hits.length > 1
        const showMeta = totalGroups > 1 || hits.length > 1 || Boolean(first && first.occurrences > 1)
        return h(
          'div',
          {
            key,
            className: 'sex-hit-row',
            role: 'button',
            tabIndex: 0,
            onClick: () => jumpToTurn(item),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                jumpToTurn(item)
              }
            },
            title: t.openHint,
          },
          h(
            'div',
            { className: 'sex-hit-row-head' },
            h('span', { className: 'sex-hit-row-title' }, item.title || item.sessionId),
            item.turn > 0 ? h('span', { className: 'sex-hit-row-turn' }, roundLabel(item)) : null,
            h('span', { className: 'sex-hit-row-date' }, formatTime(item.time || item.turnTime)),
          ),
          h(
            'div',
            { className: 'sex-hit-row-snippet' },
            first ? kindTag(first.kind) : null,
            first ? renderSnippet(first.snippet, 's0') : h('span', { className: 'sex-hit-text' }, t.titleOnly),
          ),
          showMeta
            ? h(
                'div',
                { className: 'sex-hit-row-meta' },
                totalGroups > 1 ? h('span', { className: 'sex-hit-row-counts' }, t.totalShort.replace('{n}', String(totalGroups))) : null,
                totalGroups > 1 && countParts.length > 0
                  ? h('span', { className: 'sex-hit-row-counts' }, countParts.join(' · '))
                  : null,
                first && first.occurrences > 1 ? h('span', { className: 'sex-hit-row-counts' }, `×${first.occurrences}`) : null,
                canExpand
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'sex-hit-row-more',
                        onClick: (event) => {
                          event.stopPropagation()
                          toggleExpanded(key)
                        },
                      },
                      open ? t.collapse : t.expand,
                    )
                  : null,
              )
            : null,
          ...extra.map((hit, index) =>
            h(
              'div',
              { key: `x-${index}`, className: 'sex-hit-row-extra' },
              kindTag(hit.kind),
              renderSnippet(hit.snippet, `x-${index}`),
              hit.occurrences > 1 ? h('span', { className: 'sex-hit-row-counts' }, `×${hit.occurrences}`) : null,
            ),
          ),
          open && totalGroups > hits.length
            ? h('div', { className: 'sex-hit-row-note' }, t.moreHits.replace('{n}', String(totalGroups - hits.length)))
            : null,
        )
      }

      const skeleton = loading && !result
        ? h(
            'div',
            { className: 'sex-skeleton', 'aria-hidden': 'true' },
            ...[0, 1, 2].map((index) =>
              h(
                'div',
                { key: index, className: 'sex-skeleton-row' },
                h('div', { className: 'sex-skeleton-line title' }),
                h('div', { className: 'sex-skeleton-line body' }),
              ),
            ),
          )
        : null

      const results = result && (result.items || []).length > 0
        ? h('div', { className: 'sex-results' }, ...result.items.map(renderCompactRow))
        : null

      const viewAll = result && result.hasMore && pageSize < 200
        ? h(
            'button',
            {
              type: 'button',
              className: 'sex-viewall',
              onClick: () => {
                setPageSize(200)
                void runSearch(query, kinds, sortMode, 200)
              },
            },
            t.viewAll.replace('{n}', String(Math.max(1, (result.totalTurns || 0) - (result.items || []).length))),
          )
        : null

      const empty = !result && !loading
        ? h(
            'div',
            { className: 'sex-empty' },
            h('span', { className: 'sex-empty-icon' }, ICON_SEARCH),
            h('span', null, t.empty),
          )
        : null

      const noResult = result && (result.items || []).length === 0
        ? h('div', { className: 'sex-empty' }, h('span', null, t.emptyResult))
        : null

      const recentList = !result && !loading
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
              h('span', { style: { fontSize: '12.5px', fontWeight: 500 } }, t.recent),
              h('span', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } }, status ? `${formatCount(status.sessions)} ${t.sessionsLabel}` : ''),
            ),
            recent.length === 0
              ? h('div', { className: 'sex-empty' }, h('span', null, t.noRecent))
              : h(
                  'div',
                  { className: 'sex-list' },
                  ...recent.map((session) =>
                    h(
                      'button',
                      { key: session.id, type: 'button', className: 'sex-row', onClick: () => openSession(session.id) },
                      h(
                        'span',
                        { className: 'sex-row-main' },
                        h('span', { className: 'sex-row-title' }, session.title || session.id),
                        h('span', { className: 'sex-row-sub' }, `${session.project || ''}${session.project ? ' · ' : ''}${formatRelative(session.updatedAt)} · ${session.msgCount || 0} ${t.statusMessages}`),
                      ),
                      h('span', { className: 'sex-row-count' }, formatTime(session.createdAt).slice(5)),
                    ),
                  ),
                ),
          )
        : null

      return h(
        'div',
        {
          className: 'sex-panel',
          ref: panelRef,
          onScroll: (event) => {
            PANEL_MEMORY.scrollTop = event.currentTarget.scrollTop
          },
        },
        h(
          'div',
          { className: 'sex-inner' },
          header,
          searchBar,
          chips,
          sortControls,
          h(
            'div',
            { className: 'sex-meta' },
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '7px' } },
              loading ? h('span', { className: 'sex-spinner', style: { width: '10px', height: '10px', opacity: .65 } }) : null,
              loading
                ? t.loadingLabel
                : result
                  ? `${t.hitsLabel} ${formatCount(total)} · ${formatCount(turnCount)} ${t.turnsLabel} · ${formatCount(sessionCount)} ${t.sessionsLabel}` +
                    (result.totalOccurrences && result.totalOccurrences > total ? ` · ${formatCount(result.totalOccurrences)} ${t.occurrences}` : '') +
                    (result.tookMs !== undefined ? ` · ${result.tookMs} ms` : '')
                  : t.ready,
            ),
            h(
              'span',
              { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
              renderStatusLine(),
              h('button', { type: 'button', className: 'sex-button', onClick: () => void rebuild(), disabled: building || Boolean(status && !status.ok) }, t.rebuild),
            ),
          ),
          progress,
          rebuildNote ? h('div', { className: 'sex-banner info' }, rebuildNote) : null,
          jumpBanner,
          statusUnavailable,
          errorBanner,
          skeleton,
          results,
          viewAll,
          empty,
          noResult,
          recentList,
        ),
      )
    }

    function HeaderButton(props) {
      const ctx = props && props.ctx
      const t = copy()
      const onClick = () => {
        try {
          const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : undefined
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
        } catch {
          // navigation is best effort
        }
      }
      return h(
        'button',
        { type: 'button', className: 'sex-shortcut', onClick, title: t.shortcutTip, 'aria-label': t.shortcutTip },
        ICON_SEARCH,
        h('span', null, t.shortcut),
      )
    }

    function RailIcon() {
      return h('span', { className: 'sex-rail', 'aria-hidden': true }, ICON_SEARCH)
    }

    function installStyles() {
      const id = 'dsh-session-search/styles.css'
      const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
      if (existing) return () => {}
      const style = document.createElement('style')
      style.dataset.pluginCss = id
      style.textContent = STYLES
      document.head.appendChild(style)
      return () => style.remove()
    }

    const name = 'dsh-session-search'
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => {
        const removeStyles = installStyles()
        const disposePanel = ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(SearchPage, { ctx })),
        )
        const disposeRail = ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => copy().nav },
            RailIcon,
          ),
        )
        const disposeShortcut = ctx.slots.inject('conversation.header.leading', () =>
          ctx.slots.register({ name: 'conversation.header.leading' }, () => h(HeaderButton, { ctx })),
        )
        const disposeToast = ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'session-search-toast', order: 100 }, ToastHost),
        )
        return () => {
          disposeToast()
          disposeShortcut()
          disposeRail()
          disposePanel()
          removeStyles()
        }
      })
    }

    return { name, inject, apply }
  },
})
