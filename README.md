# ModiKodi Bridge

[![GitHub stars](https://img.shields.io/github/stars/ruizkinio/modikodi-bridge?style=flat-square)](https://github.com/ruizkinio/modikodi-bridge/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/ruizkinio/modikodi-bridge?style=flat-square)](https://github.com/ruizkinio/modikodi-bridge/network)
![GitHub last commit](https://img.shields.io/github/last-commit/ruizkinio/modikodi-bridge?style=flat-square)
![Docker Pulls](https://img.shields.io/docker/pulls/ruizkinio/modikodi-bridge?style=flat-square)

**[Install in Stremio](https://modikodi-bridge.fly.dev/configure)** | **[Configure Page](https://modikodi-bridge.fly.dev/configure)**

A Stremio addon that enables **Trakt scrobbling** and **content identification** when using [ModiKodi](https://github.com/ruizkinio/ModiKodi-kodi) as an external player.

## What is ModiKodi?

ModiKodi is a modified Kodi build that acts as a proper external player for Stremio. When you play content in Stremio, ModiKodi handles playback and automatically:

- Scrobbles to **Trakt** (real-time watching status + history)
- Downloads **subtitles** from OpenSubtitles
- **Resumes playback** across different sources and devices
- Returns position/duration to Stremio when you stop

**The problem**: Stremio sends zero content metadata in its intents — only a video URL. ModiKodi needs to know *what* you're watching to scrobble to Trakt.

**The solution**: This Bridge addon.

## How It Works

### Zero-Config Mode (Recommended)

1. Install this addon in Stremio
2. When you browse content in Stremio, the addon silently records what you're looking at
3. When ModiKodi starts playing, it asks the Bridge "what was the user just watching?"
4. The Bridge responds with the IMDB ID, type, season, and episode
5. ModiKodi scrobbles to Trakt

No configuration needed. Just install and forget.

### Wrapper Mode (Optional)

For 100% reliable identification with opaque debrid URLs, you can wrap your existing stream addon. This embeds IMDB metadata directly into stream URLs.

## Install

### One Click (Public Instance)

Visit the configure page and click "Install in Stremio":

```
https://modikodi-bridge.fly.dev/configure
```

Or paste the manifest URL directly into Stremio's addon search:

```
https://modikodi-bridge.fly.dev/manifest.json
```

### Self-Host

```bash
git clone https://github.com/ruizkinio/modikodi-bridge.git
cd modikodi-bridge
npm install
node index.js
```

The server starts on port `7515`. Open `http://localhost:7515/configure` to install.

### Docker

```bash
docker build -t modikodi-bridge .
docker run -p 7515:7515 modikodi-bridge
```

### Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ruizkinio/modikodi-bridge)

Uses the included `render.yaml` for one-click deployment.

## Features

| Feature | Description |
|---------|-------------|
| Zero-config content ID | Tracks what you browse in Stremio, serves it to ModiKodi |
| Wrapper mode | Wraps upstream addons, injects IMDB metadata into stream URLs |
| Continue Watching | Catalog that shows your partially-watched content in Stremio |
| Resume sync | Stores playback positions, serves them back on re-watch |
| Version endpoint | ModiKodi checks for updates via `/version` |
| Rate limiting | 100 req/min/IP to prevent abuse |
| CORS ready | Works with Stremio web and desktop |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /manifest.json` | Stremio addon manifest |
| `GET /configure` | Web UI for installation |
| `GET /stream/:type/:id.json` | Records content, returns empty streams |
| `GET /identify` | ModiKodi queries this for content metadata |
| `POST /resume` | ModiKodi reports playback position |
| `GET /catalog/:type/modikodi-continue.json` | Continue Watching catalog |
| `GET /version` | Returns current version for update checks |
| `GET /:upstream/manifest.json` | Wrapper mode manifest |
| `GET /:upstream/stream/:type/:id.json` | Wrapper mode streams |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7515` | Server port |
| `NODE_ENV` | - | Set to `production` for deployment |

## Important Notes

- **HTTPS required**: Stremio Android rewrites HTTP addon URLs to HTTPS. Use a reverse proxy (Cloudflare, nginx) or deploy to a platform that provides HTTPS.
- **IP-based matching**: Zero-config mode matches by client IP. May not work with carrier-grade NAT (shared public IP). Wrapper mode is the fallback.
- **In-memory storage**: Content tracking and resume positions are stored in memory. They reset on server restart. For persistence, deploy with Docker volumes or use Trakt's built-in playback sync.

## License

MIT
