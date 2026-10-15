<p align="center"><img src="yggdrasil-180.png" width="120" alt="Yggdrasil"></p>

# Yggdrasil

A desktop with no chat log — a sentence goes in, and the interface that grows out of it is the answer.

[中文说明](../README.md) · [Plugin reference](plugins.md)

## Run

```bash
pnpm install
pnpm dev
```

Build and preview:

```bash
pnpm build      # tsc --noEmit && vite build
pnpm preview
```

On first use, open settings with the `⚙` in the input window title bar and fill in Base / Key / Model for any OpenAI-compatible endpoint. Configuration is stored in the browser only.

## Usage

| Action | Notes |
| --- | --- |
| Submit a task | `Enter` in the input box; `Shift + Enter` for a newline |
| Move / resize a window | Drag the title bar to move, the bottom-right corner to resize |
| Minimize | Sends the window to the taskbar in the bottom-left; click to restore |
| Widget | No title bar, transparent background; hover reveals move / resize / close buttons in its bottom-right |
| Multiple input boxes | Each input box is an independent session, up to 6 |
| Export / import a scene | Two buttons in the top-left, producing a `.seed` file |
| Upload files | Drop onto the input window or paste; files enter the agent workspace on submit, and only their names enter the prompt |

Window positions and sizes are saved and survive a refresh.

## What it does

- Generates windows and components: charts, lists, calendars, dashboards, clocks
- Fetches pages and images from the network
- Reads images (requires a model with vision)
- Opens and drives real browser windows
- Inspects and adjusts the built-in windows: panels, the input box, window chrome
- Computation and text processing

## Plugins

A plugin (`.graft`) adds operations and tools to the agent, or makes declarative changes to the prompt and the interface.
The full manifest format and security model are in the [plugin reference](plugins.md).

Bundled examples are built into `public/plugins/` and can be installed from the plugins panel:

| File | What it provides |
| --- | --- |
| `weather.graft` | Weather lookup, no key required |
| `netease-music.graft` | NetEase Cloud Music; needs your own self-hosted service URL |
| `github.graft` | GitHub queries and issue creation; token optional |
| `toolbox.graft` | Eight computation tools, no network access |
| `nya.graft` | Changes the agent name and speech style; prompt only |

```bash
pnpm plugin:build weather      # package
pnpm plugin:try weather        # run from the command line
pnpm plugin:sign               # sign
```

## Settings

- **Endpoint**: Base / Key / Model, with presets for common providers
- **Security level**: strict / standard / relaxed / unrestricted (standard by default)
- **Generation**: context window, compaction threshold, max output, temperature
- **Terse mode**: reduces the explanatory text sent to the model each round
- **Adult mode**: adjusts the content policy
- **Image relay**: an optional proxy address for images

## Layout

    src/kernel/    model calls and operation execution
    src/host/      window rendering and component compilation
    src/ui/        interface components
    src/store/     state and persistence
    src/styles/    styles
    plugins/       plugin sources
    scripts/       packaging / trial run / signing scripts
    docs/          documentation
    public/        static assets and built plugins

## Development

```bash
pnpm typecheck
```

Keys are stored in the browser only and pass through no backend; model requests go from the browser straight to the endpoint you configure.

## License

MIT — see [LICENSE](../LICENSE).
