# netease-music

Work with NetEase Cloud Music through **the user's own NeteaseCloudMusicApiEnhanced server**.
This plugin never talks to NetEase directly.

Operation names mirror the API's own routes, so the documentation the user has maps 1:1:
`search` is `/search`, `song_url_v1` is `/song/url/v1`, `playlist_track_all` is `/playlist/track/all`,
`artist_top_song` is `/artist/top/song`, and so on. Every operation is a GET with query parameters.

## Setup

- **`base_url` (required)** — the user's server, usually `http://localhost:3000`. Without it every call fails
  with "这个插件还没配好". Never guess an address.
- **`cookie` (optional)** — needed for anything account-bound: `recommend_songs`, `record_recent_song`,
  `user_playlist`, VIP or high-quality audio. When such a call comes back empty, check `login_status` first
  and then tell the user to fill the Cookie field.

## Workflow: "play <song>"

1. `search` with `keywords`.
2. Choose a hit by name and artist. `fee` tells you what to expect:
   `0` free, `1` VIP-only, `4` paid album, `8` trial-only.
3. `song_url_v1` with that `id` (keep `level: exhigh` unless the user asks for lossless/hires).
4. Build a component: title, `ar[].name`, cover (`al.picUrl`), and `<audio controls src={url}>`.
   Optionally `lyric` for the words, or `comment_music` for the top comments.

## Workflow: "play this playlist" / "something by <artist>" / "what is hot"

- Playlist: `search_playlist` → `playlist_track_all` (paged) or `playlist_detail` (full tracks) → `song_url_v1`.
  For a chart, `toplist` gives the official list; their ids work with `playlist_detail`.
- Artist: `search_artist` → `artists` (profile + hotSongs) or `artist_top_song` / `artist_songs` (paged)
  or `artist_album` → `album`.
- Discover: `personalized` (recommended playlists), `personalized_newsong`, `top_playlist` (filtered by
  `cat`, see `playlist_catlist`), `search_hot` (what people search), `recommend_songs` (daily, needs cookie).
- MV: `mv_detail` for metadata, `mv_url` for the video URL (put it in `<video controls>`).

## Rules

- **Never autoplay.** Browsers block sound without a user gesture: always render `controls` and let the user
  press play.
- **Do not fetch the audio/video bytes** (`fetch_url` / `view_image` on a `url`): `<audio>` / `<video>` stream
  it, and reading cross-origin binary is blocked anyway.
- **You cannot hear or watch it.** Your job is the right track plus a working player — never claim you verified
  the sound or the picture.
- **A null `url` is an answer, not an error.** Say the track needs VIP / is unavailable and offer an
  alternative (another version, lower `level`, or filling the cookie). Do not retry the same id in a loop.
- **Album covers accept a `?param=WxH` suffix** — append `?param=300y300` for a sharper cover.
- One player per request unless the user asks for a list.

## Song fields (the shape everything returns)

```
id, name, dt (duration in ms), fee (0/1/4/8), publishTime (ms)
ar[]  -> artists: id, name        al -> album: id, name, picUrl
```

Older responses use `artists[]` / `album` instead of `ar[]` / `al`; both are selected for you where it matters.
`fee`: 0 free · 1 VIP · 4 paid album · 8 trial only.

## Quality levels

`standard` < `higher` < `exhigh` < `lossless` < `hires` < `jyeffect` / `sky` / `jymaster`.
Higher levels need a VIP account and a cookie. Asking for `lossless` without the account just returns a
null url, so stay on `exhigh` unless the user asks.

## Lyrics

`lrc.lyric` is LRC: each line begins with `[mm:ss.xx]`. Drop the tags for a plain panel, keep them for a
scrolling view. `tlyric.lyric` is the translation (often empty), `yrc.lyric` is word-by-word (often null).

## Failure modes to report instead of working around

- `code` is not 200 → the server answered with an error. Report the code; do not retry in a loop.
- The request fails in the browser → the user's server is not running, the address is wrong, or its CORS
  setting (`CORS_ALLOW_ORIGIN`) blocks this page. The default `*` works.
- Empty result that needs an account → fill the Cookie field; say which call needed it.
- The observation says the picked fields are all empty while the body had content → **the response shape
  changed** and the plugin's `pick` paths no longer match. Report that to the user as a plugin bug; do not
  present it as "nothing found".
- Paging: `limit` + `offset` is how every list endpoint works. Two pages is enough unless the user asks for more.
