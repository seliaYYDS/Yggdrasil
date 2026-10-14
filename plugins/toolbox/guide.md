# toolbox

A demo plugin whose contribution is **new tools**, not new operations. Compare it with
`status-board`, which contributes operations.

## The difference that matters

| | this plugin | `status-board` |
| --- | --- | --- |
| what the Agent sees | three entries under **Available tools**, tagged `[plugin]` | operations in the operation catalog |
| how the Agent calls it | `call_tool` with a name and named arguments | writes the op kind directly |
| why | these are re-usable primitives the Agent should discover and re-apply | these are "do this one thing now" actions |

A plugin tool lands in the same list as the built-in `calc` / `now` / `random`, and as anything the
Agent wrote itself with `create_tool`. Nothing about calling it is special — that is the point.

## What it gives you

| tool | what it returns |
| --- | --- |
| `text_stats` | `chars`, `lines`, `cjkChars`, `words`, `uniqueWords`, `frequentWords[]` |
| `slugify` | `slug` (lowercase ASCII, hyphen separated) |
| `chunk` | `chunks[][]`, `chunkCount`, `total` |

All three are pure computation: `cap` is `null`, so every Agent can use them, and the host allow-list
is empty because none of them touches the network.

## Workflow

    call_tool with name "text_stats" and args { "text": "<the text>", "top": "5" }

Then use the numbers you got back. **Do not estimate counts by eye when a tool can count them** — the
whole reason this is a tool rather than an operation is that the Agent can call it whenever it needs
arithmetic on text, including twice in one round.

## Two traps this plugin documents

1. `slugify` returns an empty slug for a Chinese title and says so, rather than inventing a pinyin
   transliteration. Inventing one would look like a working feature while being a fabrication.
2. `text_stats` reports `cjkChars` separately. Splitting on whitespace alone reports a whole paragraph
   of Chinese as a single "word", which reads like a bug in the tool.
