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

The `market` field in the plugin panel is a two-letter country code (default `CN`). Different markets have different catalogues; if a search comes back empty for a regional artist, tell the user which market was used instead of retrying blindly.

## Failure modes you should report instead of working around

- Empty `results` → the term or the market did not match anything. Say that.
- HTTP 403 / 429 / network error → the API refused or is rate-limiting. Report it; do not retry in a loop.
