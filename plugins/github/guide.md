# github

Browse GitHub through its public API, and (with a token) create issues.

## About the token field

- **It is optional.** Without it every read-only operation here still works, but you get **60 requests per hour**
  for the anonymous IP (and 10 per minute for search). With a fine-grained token it becomes 5000 per hour.
- **`create_issue` needs it.** Without a token that call returns 401/403 — tell the user to fill the token field
  instead of retrying.
- The token is sent as an `Authorization` header by the plugin. **Never print it, never put it in a component,
  and never ask the user to paste it into the chat** — it belongs in the plugin panel only.

## What you can do

| Question | Operations |
| --- | --- |
| "找一下 xxx 的仓库" | `search_repos` |
| "facebook/react 是什么项目、多少 star" | `repo` |
| "这个项目怎么装 / 是干什么的" | `repo_readme` |
| "有什么还没关的 issue" | `repo_issues` |
| "torvalds 是谁" | `user` |
| "帮我提一个 issue" | `create_issue` (needs token) |
| "还能调几次" | `rate_limit` |

## Rules

- **`owner` and `repo` are separate parameters.** A search result gives you `full_name` like
  `facebook/react` — split it: owner=`facebook`, repo=`react`.
- **`repo_issues` also returns pull requests.** An entry is a PR when `pull_request.url` is non-null.
  Filter them out unless the user asked for PRs, and say which you filtered if it changes the count.
- **Rate limits are real and easy to hit.** Search is 10/minute unauthenticated. If a call returns 403 or 429,
  call `rate_limit`, report `remaining` and the reset time, and **stop** — do not retry in a loop.
- **`repo_readme` is plain markdown, not JSON.** Do not try to parse it as JSON. Quote the lines that answer
  the question (install / usage / what it is) rather than dumping thousands of characters into a window.
- **Numbers change between calls** (stars, issue counts). Report what the response said, with no "currently" if
  you are not sure when it was fetched; the response has the timestamps (`pushed_at`, `created_at`).
- Keep windows compact: a repo card (name, description, stars, language, link) or a short issue list beats a dump.

## create_issue — treat it as a real-world action

It posts to a public repository. Therefore:

1. **Only when the user explicitly asked** for an issue ("帮我提一个 issue"). Never "helpfully" file one.
2. **Show them the exact title and body first** and get a yes, unless they already dictated both.
3. Right after it succeeds, show the issue **number and html_url** so they can open it.
4. If it fails with 401/403, say it is a token/permission problem. Do not try a different URL or method.

## Failure modes

- **404** → wrong owner/repo (or private). Report it; check the spelling from a search result.
- **403 / 429** → rate limit or missing permission. Use `rate_limit`, then stop.
- **422 on create_issue** → the repo has issues disabled, or the title is empty. Report the API message.
- Empty array from `repo_issues` → genuinely no issues in that state; try `state: all` once.
