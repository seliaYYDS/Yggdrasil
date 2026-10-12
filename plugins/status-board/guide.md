# status-board

A demo plugin that uses all three plugin capabilities at once, so you can see how they combine:

| capability | what it is here |
| --- | --- |
| declarative endpoint | `status-board.ping` — a plain GET with one parameter |
| **js tool** | `status-board.summarise` (pure calculation) and `status-board.probe` (does a network call through `ctx.fetch`) |
| **shipped interface** | the `board` screen — a TSX module the plugin carries, put on screen with `plugin_ui` |

## Workflow

1. `status-board.summarise` with the numbers the user mentioned → you get count/sum/min/max/average.
2. `plugin_ui` with `id: "status-board"`, `ui: "board"`, and `data`:

       { "title": "今天的数字", "rows": [ { "label": "合计", "value": "23" } ] }

3. Fill the rows from whatever you actually computed. **Do not invent values** — the board shows exactly what
   you pass, so a wrong number is a wrong board.

## About the js tools

- `summarise` runs in a sandboxed Worker with **no network of its own**; it only sees the arguments and the
  plugin fields. Use it for arithmetic instead of doing it in your head.
- `probe` calls `ctx.fetch` — that is the plugin's only way out to the network, and the main thread checks the
  host against the plugin allow-list. If you want to show what happens when it is refused, that is a plugin bug,
  not something you can work around.
- A js tool that throws or times out comes back as a failed operation with the error text; report that text.

## The board is plugin code

`plugin_ui` creates a **locked** window: patch_source on it will be refused. If the board needs a different
look, tell the user to unlock it in the Nodes panel, or use a normal component instead.
