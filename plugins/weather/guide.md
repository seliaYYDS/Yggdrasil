# weather

Live weather and forecasts for any city, via Open-Meteo. No API key needed.

## Workflow: "what is the weather in <city>"

1. `weather.find_city` with `name`. **Never invent coordinates** — take them from the result.
2. `weather.forecast` with that `latitude`, `longitude` and `timezone`.
3. Build a component that shows: city name, current temperature (and feels-like), the condition as words, humidity, wind, and the next few days' high/low.

## Rules

- **Units come from the response**: `current_units` / `daily_units` say °C or °F and km/h or mph. Never hardcode "°C" — if the user changed the unit field, hardcoding it would be wrong.
- **Several cities with the same name is normal** (there are three "北京" in China). Pick the one with the largest `population` unless the user's wording points elsewhere, and **say which one you used** ("北京市，中国").
- The `timezone` from `find_city` matters: "today's high" is meaningless without it. Pass it through instead of guessing.
- Do not present stale or remembered weather as current. If the call fails, say it failed.
- Keep the window compact: current conditions first, then a small row per day. This is a glanceable window, not a report.

## WMO weather_code → words

`weather_code` is a number. Map it, and write the label in the user's language (the table below gives both):

| code | English | 中文 |
| --- | --- | --- |
| 0 | Clear sky | 晴 |
| 1 | Mainly clear | 大致晴朗 |
| 2 | Partly cloudy | 局部多云 |
| 3 | Overcast | 阴 |
| 45, 48 | Fog | 雾 |
| 51, 53, 55 | Drizzle | 毛毛雨 |
| 56, 57 | Freezing drizzle | 冻雨（小雨） |
| 61, 63, 65 | Rain | 雨 |
| 66, 67 | Freezing rain | 冻雨 |
| 71, 73, 75 | Snow | 雪 |
| 77 | Snow grains | 米雪 |
| 80, 81, 82 | Rain showers | 阵雨 |
| 85, 86 | Snow showers | 阵雪 |
| 95 | Thunderstorm | 雷阵雨 |
| 96, 99 | Thunderstorm with hail | 雷阵雨伴冰雹 |

Anything not in the table: render the raw number, do not guess a word for it.

## Failure modes to report instead of working around

- `find_city` returns nothing → see the hint in its result; try one alternative spelling, then tell the user.
- `forecast` returns an error or nothing → report it; the coordinate pair may be out of range (latitude -90..90, longitude -180..180).
- If the user asks about a place, not a city (a lake, a mountain), `find_city` may still match it by name — check the returned `admin1`/`country` before trusting it.
