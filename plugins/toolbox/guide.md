# toolbox

A demo plugin whose contribution is **new tools**, not new operations — compare it with
`status-board`, which contributes operations.

## Why these tools exist

Every one of them covers something the Agent **cannot do itself, or gets wrong**:

- its own tools (`create_tool`) can do pure computation, but it has to *write and compile* one
  first — two extra rounds for arithmetic it should just be able to ask for;
- the built-in tools are only `calc` (one arithmetic expression), `now` (the current instant)
  and `random`. There is no statistics, no regex, no date arithmetic, no table parsing;
- and for several of these, a wrong answer **looks plausible** — which is the real problem.
  A model that miscounts the matches in a 5 KB log, or reads the wrong field out of a JSON blob,
  produces something that reads fine and is wrong.

## The eight

| tool | what it is for | why it needs to be a tool |
| --- | --- | --- |
| `stats` | median / mean / stddev (population **and** sample) / p25–p99 / IQR | `calc` cannot do statistics at all |
| `regex_extract` | every match plus capture groups, with a flattened list if you name a group | enumerating exact matches by reading is exactly what models get wrong; `g` is forced on |
| `json_query` | pull only the fields you need (`data.items[].name`) | reading a large JSON by eye is unreliable, and costs context |
| `diff_text` | added / removed counts plus a unified-diff body | counting changed lines by eye is where patches go wrong |
| `date_math` | add a span, or measure a gap, on a real calendar | `now` gives no arithmetic; month lengths and leap years are what models trip on |
| `table_parse` | CSV / TSV → JSON rows | quoted fields with delimiters or newlines inside silently shift every row if you split naively |
| `encode` | base64 both ways, URL, hex, sha256, byte length | easy to get subtly wrong; needed for data: URIs and checksums |
| `decode_layers` | peel escaping layers and say what each one was | working out the nesting depth of an escaped payload by eye is guesswork |

## Three decisions worth knowing

1. **`date_math` clamps to the end of the month.** `2024-01-31 + 1mo` is **2024-02-29**, not
   2024-03-02. The latter is what JavaScript's `setMonth` produces by overflowing "February 31st";
   "one month later" to a human means the month's end, and that is what date libraries do.
   This was the first real bug found while building it.
2. **`date_math` does calendar arithmetic in UTC** and uses `tz` only for the rendered local time.
   `setMonth`/`setDate` follow the *runner's* timezone, so the same input would give different
   answers on different machines — a tool the Agent relies on should not have that kind of
   uncertainty.
3. **`decode_layers` never auto-decodes base64.** A string that merely happens to be valid base64
   decodes into garbage, and garbage is worse than a hint. It is reported as a hint instead.
   Likewise it does **not** treat "reformatting JSON" as a decode layer — that would add a step
   that decoded nothing and hide how many layers were really there.

## Workflow

    call_tool with name "stats" and args { "values": "3, 8, 12, 7, 15, 21" }

Args may be passed as `--key=value` on the CLI. Note that all parameters arrive in the sandbox
as **strings** (that is the plugin contract), so the tools parse numbers themselves — except
`json_query`, which additionally accepts an object/array directly.

## Testing them without a browser

    node scripts/try-plugin.mjs --dir plugins/toolbox
    node scripts/try-plugin.mjs --dir plugins/toolbox tool:stats --values "3, 8, 12, 7, 15, 21"
    node scripts/try-plugin.mjs --dir plugins/toolbox tool:encode --op sha256 --text abc

All eight are pure computation (`cap: null`), so `hosts` is empty and nothing here touches
the network — a network-backed plugin tool looks like `status-board.probe` instead.
