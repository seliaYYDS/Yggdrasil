# music-search

Search the iTunes catalogue and get **30-second audio previews** that the browser can play.

## Workflow: "play <song>"

1. `music-search.search` with `term` = the song (plus artist if you know it).
2. Pick the hit whose `trackName` / `artistName` matches. **If nothing matches well, say so** — do not guess a URL.
3. Build a component with `create_component` that renders:
   - the track title and artist,
   - `<img src={artworkUrl100}>` for the cover (you may swap `100x100` in the URL for `300x300` to get a sharper image),
   - `<audio controls src={previewUrl}>` for playback.

## Rules that matter here

- **Never autoplay.** Browsers block sound without a user gesture, so always render `controls` and let the user press play.
- **Do not fetch the audio bytes** (`fetch_url` / `view_image` on `previewUrl`): reading cross-origin binary is blocked, and you do not need the bytes. The `<audio>` element streams the URL directly.
- **You cannot hear the audio.** Your job is to find the right track and put a working player on screen; never claim you verified how it sounds.
- Previews are **30 seconds** and some tracks have none (`previewUrl` missing or empty). When it is missing, show the track info and say the preview is unavailable.
- `previewUrl` often ends in `.m4a`. That is expected; browsers play it fine.
- Keep it to one player per request unless the user asks for a list.

## "More songs by this artist"

Take `artistId` from any search hit and call `music-search.artist_tracks`.

## Market

`market` is a two-letter storefront code. It comes from the plugin panel (default `TW`), and **you can override it per call** by passing `market` as a parameter.

Different storefronts carry different catalogues, and **`CN` has no music catalogue at all** — every search there returns `resultCount: 0`. Measured working: `TW`, `HK`, `US`, `JP`, `SG`, `GB`. For Chinese-language songs `TW` and `HK` give the best matches; `US` romanises names (`稻香` shows up as "Rice Field").

## When resultCount is 0

An empty result is information, not a failure. Order of work:

1. **Retry once with another market** — this is the most common cause (a regional artist on a foreign storefront, or `CN`).
2. Simplify the term: drop the artist, keep the title (or vice versa). Try a `term` in the artist's own script — `周杰倫` often matches where `周杰伦` does not, and the romanised `Jay Chou` matches on `US`/`GB`.
3. If it is still empty, **tell the user what you searched and on which market**, and stop. Two attempts is the budget; do not loop.

## Failure modes you should report instead of working around

- Empty `results` → the term or the market did not match anything. Say that.
- HTTP 403 / 429 / network error → the API refused or is rate-limiting. Report it; do not retry in a loop.
