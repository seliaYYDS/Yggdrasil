# netease-music

Search NetEase Cloud Music, get a playable audio URL, and show lyrics — through **the user's own
NeteaseCloudMusicApiEnhanced server**. This plugin does not talk to NetEase directly.

## Before anything: the API address

Every call needs the `base_url` field to be filled in the plugin panel (the user's own server,
usually `http://localhost:3000`). If a call comes back with "这个插件还没配好", tell the user to fill
that field — do not try to guess an address or work around it.

If `cookie` is empty the plugin still works for free songs; VIP / high-quality tracks return a null url.

## Workflow: "play <song>"

1. `netease-music.search` with `keywords`.
2. Pick a hit by name and artist. `fee` tells you what to expect:
   - `0` free — the playable link should come back;
   - `1` VIP-only, `4` paid album, `8` trial-only — the link may be null or a short preview.
3. `netease-music.song_url` with that `id` (keep the default `level: exhigh` unless the user asks for
   lossless/hires).
4. Build a component: title, `ar[].name`, cover (`al.picUrl`), and `<audio controls src={url}>`.
   Optionally call `netease-music.lyric` and render the words next to the player.

## Rules

- **Never autoplay.** Browsers block sound without a user gesture: always render `controls` and let the
  user press play.
- **Do not fetch the audio bytes** (`fetch_url` / `view_image` on the url). The `<audio>` element
  streams it; reading cross-origin binary is blocked and unnecessary.
- **You cannot hear it.** Your job is the right track plus a working player — never claim you verified
  how it sounds.
- **A null `url` is an answer, not an error.** Say the track needs VIP / is unavailable and offer the
  alternatives (another version of the song, lower quality, or filling the cookie field).
- **Album covers are `.jpg` URLs that accept a `?param=WxH` suffix** — e.g. append `?param=300y300`
  for a sharper cover instead of the default thumbnail.
- Keep one player per request unless the user asks for a playlist.

## Lyrics

`lrc.lyric` is LRC: each line starts with `[mm:ss.xx]`. For a plain panel, drop the tags and keep the
text lines; for a scrolling lyric view keep them. `tlyric.lyric` is the translation (often empty);
`yrc.lyric` is word-by-word and is often `null` — treat both as optional.

## Quality levels

`standard` < `higher` < `exhigh` < `lossless` < `hires` < `jyeffect` / `sky` / `jymaster`.
Higher levels need a VIP account and a filled cookie. If the user does not care, stay on `exhigh`:
asking for `lossless` without the account just returns a null url.

## Failure modes to report instead of working around

- `code` is not 200 → the server answered with an error. Report the code; do not retry in a loop.
- The browser says the request failed → the server is not running, the address is wrong, or its CORS
  setting blocks this page (`CORS_ALLOW_ORIGIN`; the default `*` works).
- `songCount` is 0 → nothing matched. Try a shorter keyword or the artist name once, then say what you
  searched.
- Every song returns a null url → the account needs VIP, or the cookie is missing/expired.
