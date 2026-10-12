# status-board

A demo plugin that uses all three plugin capabilities at once, so you can see how they combine.
Everything it touches is **api.github.com** — a fast, key-less, CORS-enabled endpoint — so a failed call means
something is wrong here, not that the demo host is down.

| capability | what it is here |
| --- | --- |
| declarative endpoint | `status-board.rate_limit` — a plain GET, no parameters |
| **js tool** | `status-board.summarise` (pure calculation) and `status-board.probe` (does a network call through `ctx.fetch`) |
| **shipped interface** | the `board` screen — a TSX module the plugin carries, put on screen with `plugin_ui` |

## The update field

The plugin panel has an **update address prefix** field. When the user fills it with this app's own origin
(e.g. `http://127.0.0.1:19387`), the panel's "check for updates" reads
`<that address>/plugins/status-board.version.json` and can install version 1.1 from it.
That field is in the host allow-list as `{config:update_base}`, so updates do not open a new network door —
the user's own value defines it.

## Workflow

1. `status-board.summarise` with the numbers the user mentioned → you get count/sum/min/max/average.
2. `plugin_ui` with `id: "status-board"`, `ui: "board"`, and `data`:

       { "title": "今天的数字", "rows": [ { "label": "合计", "value": "23" } ] }

3. Fill the rows from whatever you actually computed. **Do not invent values** — the board shows exactly what
   you pass, so a wrong number is a wrong board.

## About the js tools

- `summarise` runs in a sandboxed Worker with **no network of its own**; it only sees the arguments and the
  plugin fields. Use it for arithmetic instead of doing it in your head.
- `probe` calls `ctx.fetch` to `api.github.com/rate_limit` — that is the plugin's only way out to the network,
  and the main thread checks the host against the plugin allow-list. A refusal is a plugin configuration problem,
  not something you can work around.
- A js tool that throws or times out comes back as a failed operation with the error text; report that text.

## The board is plugin code

`plugin_ui` creates a **locked** window: patch_source on it will be refused. If the board needs a different
look, tell the user to unlock it in the Nodes panel, or use a normal component instead.
