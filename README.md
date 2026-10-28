# DSH Session Search

跨会话的消息级搜索插件，给 DSH 桌面端用。

> Full-text search across every past session in DSH. Chinese single characters and keywords both work; results are compact conversation-turn rows with jump-and-highlight. Everything stays local in a SQLite index — no network, no uploads.

## Features

- **Sidebar panel + header shortcut** — a magnifier entry in the sidebar, plus a compact "Search history" button next to the session title.
- **Search every session** — message-level full-text search across all workspaces. Chinese single characters, words, Markdown source and LaTeX formulas are all searchable.
- **Compact turn rows** — one row per conversation turn, WeChat-style: title + turn number + date, a single highlighted snippet, and an expand button for the remaining hits. The first screen returns 5 turns; "View all" extends it to 200 in place.
- **Relevance-first ranking** — BM25 relevance for user/assistant text, plus keyword position, source type and exponential recency. Switch between *Relevance* and *Newest* at any time.
- **Jump and highlight** — clicking a result opens the session, scrolls to the exact turn, expands collapsed tool calls or reasoning blocks when the hit lives inside them, and highlights the match in the chat.
- **Local-only index** — SQLite FTS5 (trigram) built automatically on first use, kept up to date incrementally, and compacted automatically. Roughly 40 MB for 22k messages; the session logs themselves are never modified.
- **Robustness** — a corrupted index is rebuilt automatically; one unreadable session never stops the build; missing host services only disable the panel, not the app.

## Requirements

- DSH desktop **0.2.1-rc.3** (tested).
- Host services `webServer`, `sessionPersistence` / `sessionQuery`, and Node's `node:sqlite`.
  If any of them is missing, the plugin still loads and the panel explains what is unavailable.

## Installation

Download the `.tgz` from the repository release, then either:

**Plugin manager**

1. Open DSH → **Plugins** → **Add** → **Local path**.
2. Select the `.tgz` (or an extracted directory if your plugin manager only accepts folders).
3. Restart DSH, or wait for the hot reload.

**CLI**

```sh
dsh plugin --profile desktop add ./dsh-session-search-1.1.0.tgz
```

After activation, open **Session search** from the sidebar. The first open builds the index in the background and shows progress; already-indexed content is searchable meanwhile.

## Usage

- Type a keyword and press Enter. Single Chinese characters work too.
- **Source filters** — by default only *You* and *Assistant* are searched. Enable *Tools*, *Reasoning* or *System* when needed; the index already contains them, they are just filtered out by default.
- **Sort** — *Relevance* (default) or *Newest*.
- **View all** — the first screen shows 5 turns; the button at the bottom expands the same result set to 200 turns without re-running the query.
- **Click a row** — opens the source session at that turn and highlights the match. If the hit is inside a collapsed tool call or reasoning block, the plugin expands it first. If the chat UI genuinely does not render the hit (injected system context, truncated tool cards), a toast tells you so instead of highlighting the wrong place.
- **State is remembered** — query, filters, sort, expanded rows and scroll position survive jumping into a conversation and coming back.

## How it works

```
session logs ──> Host indexer ──> SQLite (messages + FTS5 trigram)
                                        │
                              HTTP  /.dsh-session-search/*
                                        │
                            Client panel (Cordis slots)
```

- The host half reads session events through `sessionPersistence` / `sessionQuery`, folds them into searchable messages, and stores them in `~/.dsh/storages/session-search.sqlite`.
- The FTS index only covers conversation text (user + assistant). Tool, reasoning and system text are searched with `LIKE` when those sources are enabled, which keeps the index an order of magnitude smaller.
- The client half is a normal Cordis client plugin: a `sidebar.panellist` entry, a `main` panel keyed by the same id, and a `conversation.header.leading` shortcut. It talks to the host over the same-origin HTTP routes above.
- The index is derived data: you can delete it at any time, or use **Rebuild index** in the panel.

## Privacy

- Everything is local. The plugin does not send any message content anywhere.
- The index stores message text (that is what makes it searchable). Treat `~/.dsh/storages/session-search.sqlite` as sensitive; delete it if you want to remove the index.
- Session logs are opened read-only and are never modified.

## Known limitations

- Very old session log formats may be refused by the host; the panel shows how many sessions were skipped.
- Searching tools / reasoning / system is slower (roughly 60–80 ms) because it uses a substring scan instead of the trigram index.
- Some hits cannot be highlighted because the chat surface does not render them: injected system context, tool cards that only show a truncated summary, and reasoning hidden by the current display mode. The plugin locates the turn and explains instead.
- Jumping to an old turn in a very large session can take a few seconds while the chat loads history.
- The jump/highlight integration relies on DSH chat DOM contracts; it is tested against 0.2.1-rc.3 and may need updates for other versions.

## Development

```
index.js        host half: indexer + HTTP routes
client.js       client half: sidebar panel, result list, jump/highlight
cordis.patch.yml
package.json
```

Build an installable package:

```sh
pnpm pack
```

Quick checks:

```sh
node --check index.js
node --check client.js
```

## License

MIT — see [LICENSE](./LICENSE).
