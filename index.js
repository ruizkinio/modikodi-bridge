const express = require("express");
const fetch = require("node-fetch");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1); // Trust first proxy (Fly.io, Cloudflare, etc.)
app.use(express.json());

// Rate limiting (100 requests per minute per IP)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Log ALL requests for debugging
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// CORS + OPTIONS preflight — required by Stremio addon protocol
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Base64url encode/decode helpers
function b64encode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function b64decode(str) {
  return Buffer.from(
    str.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString();
}

// --- Content tracking store (zero-config side-channel) ---
// Maps client IP -> { imdb, type, season, episode, ts }
const contentStore = new Map();
const CONTENT_TTL = 120000; // 2 minutes

// --- Resume position store ---
// Key: "tt1234567" (movies) or "tt1234567:1:3" (series S1E3)
// Value: { position: ms, duration: ms, ts: Date.now() }
const resumeStore = new Map();
const RESUME_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- TMDB metadata cache ---
// Key: "tt1234567", Value: { name, poster, ts }
const metaCache = new Map();
const META_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const TMDB_API_KEY = "8d6d91941230817f7807d643736e8a49"; // Public TMDB v3 key (free tier)

async function getTmdbMeta(imdbId) {
  const cached = metaCache.get(imdbId);
  if (cached && Date.now() - cached.ts < META_CACHE_TTL) return cached;

  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
      { timeout: 5000 }
    );
    if (!res.ok) return null;
    const data = await res.json();

    const movie = (data.movie_results || [])[0];
    const tv = (data.tv_results || [])[0];
    const item = movie || tv;
    if (!item) return null;

    const meta = {
      name: item.title || item.name || imdbId,
      poster: item.poster_path
        ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
        : `https://images.metahub.space/poster/small/${imdbId}/img`,
      ts: Date.now(),
    };
    metaCache.set(imdbId, meta);
    return meta;
  } catch (err) {
    console.error(`[tmdb] Failed for ${imdbId}: ${err.message}`);
    return null;
  }
}

// --- Semver comparison ---
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function getClientIp(req) {
  // Cloudflare tunnel sends CF-Connecting-IP with the real client IP
  const cfIp = req.headers["cf-connecting-ip"];
  const fwd = req.headers["x-forwarded-for"];
  let ip = cfIp || (fwd ? fwd.split(",")[0].trim() : req.ip);
  // Normalize all localhost variants to a single key
  if (ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "127.0.0.1") {
    ip = "localhost";
  }
  return ip;
}

// Cleanup expired entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of contentStore) {
    if (now - val.ts > CONTENT_TTL) contentStore.delete(key);
  }
  for (const [key, val] of resumeStore) {
    if (now - val.ts > RESUME_TTL) resumeStore.delete(key);
  }
}, 30000);

function storeContent(req, type, id) {
  const parts = id.split(":");
  const ip = getClientIp(req);
  contentStore.set(ip, {
    imdb: parts[0],
    type,
    season: parts[1] || "",
    episode: parts[2] || "",
    ts: Date.now(),
  });
}

// --- Root: redirect to configure ---
app.get("/", (req, res) => res.redirect("/configure"));

// --- Configure page ---
app.get("/configure", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ModiKodi Bridge - Configure</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           max-width: 640px; margin: 0 auto; padding: 40px 20px;
           background: #0f0f0f; color: #e0e0e0; }
    h1 { color: #fff; margin-bottom: 4px; }
    .subtitle { color: #888; margin-bottom: 32px; }
    label { display: block; font-weight: 600; margin-bottom: 6px; color: #ccc; }
    input { width: 100%; padding: 10px 12px; margin-bottom: 6px;
            background: #1a1a2e; border: 1px solid #333; border-radius: 6px;
            color: #fff; font-size: 14px; }
    input:focus { outline: none; border-color: #7b68ee; }
    .hint { color: #777; font-size: 13px; margin-bottom: 24px; line-height: 1.5; }
    .btn { display: inline-block; padding: 12px 28px; border: none; border-radius: 6px;
           font-size: 16px; font-weight: 600; cursor: pointer; text-decoration: none; color: #fff; }
    .btn-primary { background: #7b68ee; }
    .btn-primary:hover { background: #6a5acd; }
    .btn-secondary { background: #2a2a3e; color: #ccc; }
    .btn-secondary:hover { background: #3a3a4e; }
    .section { margin-bottom: 32px; padding: 24px; background: #1a1a1a; border-radius: 8px;
               border: 1px solid #2a2a2a; }
    .section h2 { color: #fff; margin-top: 0; margin-bottom: 8px; font-size: 18px; }
    .section p { color: #999; margin-bottom: 16px; font-size: 14px; line-height: 1.5; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px;
             font-weight: 700; text-transform: uppercase; margin-left: 8px; }
    .badge-green { background: #1a3a1a; color: #4ade80; }
    .badge-blue { background: #1a1a3a; color: #60a5fa; }
    .divider { border: none; border-top: 1px solid #2a2a2a; margin: 32px 0; }
    .success { color: #4ade80; font-size: 14px; margin-top: 12px; display: none; }
    details { margin-top: 32px; }
    summary { cursor: pointer; color: #888; font-size: 14px; padding: 8px 0; }
    summary:hover { color: #ccc; }
    .info { margin-top: 24px; padding: 16px; background: #1a1a1a; border-radius: 6px;
            border-left: 3px solid #7b68ee; }
    .info h3 { color: #fff; margin-top: 0; }
    .info p { color: #999; margin-bottom: 8px; font-size: 14px; line-height: 1.5; }
    code { background: #2a2a3e; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
    .result { margin-top: 16px; padding: 16px; background: #0f0f0f; border-radius: 6px;
              border: 1px solid #333; display: none; }
    .result input { background: #1a1a2e; }
    .buttons { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <h1>ModiKodi Bridge</h1>
  <p class="subtitle">Content metadata for Trakt scrobbling in ModiKodi</p>

  <div class="section">
    <h2>Install <span class="badge badge-green">Recommended</span></h2>
    <p>One click. No setup needed. ModiKodi will automatically identify what you're watching
       for Trakt scrobbling.</p>
    <button class="btn btn-primary" onclick="quickInstall()">Install in Stremio</button>
    <p class="success" id="quickSuccess">Addon installed! If Stremio didn't open, copy this URL
       and paste it in Stremio &rarr; Addons &rarr; search bar:</p>
    <input type="text" id="quickUrl" style="display:none" readonly onclick="this.select()" />
  </div>

  <div class="info">
    <h3>How it works</h3>
    <p>The addon silently tracks what content you browse in Stremio. When ModiKodi starts playing,
       it asks the addon "what was the user just looking at?" and gets the IMDB ID for Trakt
       scrobbling. Zero configuration — just install and forget.</p>
  </div>

  <script>
    function quickInstall() {
      var url = location.origin + "/manifest.json";
      document.getElementById("quickUrl").value = url;
      document.getElementById("quickUrl").style.display = "block";
      document.getElementById("quickSuccess").style.display = "block";
      window.location.href = "stremio://" + location.host + "/manifest.json";
    }
    function copyUrl(id) {
      var el = document.getElementById(id);
      el.select();
      navigator.clipboard.writeText(el.value).catch(function() { document.execCommand("copy"); });
    }
  </script>
</body>
</html>`);
});

// --- Version ---
const BRIDGE_VERSION = "3.0.0";

// --- Root manifest (zero-config side-channel mode) ---
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "com.modikodi.bridge",
    version: BRIDGE_VERSION,
    name: "ModiKodi Bridge",
    description:
      "Enables Trakt scrobbling in ModiKodi external player. Just install — no setup needed.",
    logo: "https://raw.githubusercontent.com/xbmc/xbmc/master/media/icon256x256.png",
    catalogs: [
      { type: "movie", id: "modikodi-continue", name: "Continue Watching" },
      { type: "series", id: "modikodi-continue", name: "Continue Watching" },
    ],
    resources: ["stream", "catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    behaviorHints: {
      configurable: true,
    },
  });
});

// --- Version endpoint: ModiKodi checks for updates ---
app.get("/version", (req, res) => {
  const parts = BRIDGE_VERSION.split(".").map(Number);
  res.json({
    version: BRIDGE_VERSION,
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
  });
});

// --- Continue Watching catalog ---
app.get("/catalog/:type/modikodi-continue.json", async (req, res) => {
  const { type } = req.params;
  const entries = [];

  for (const [key, val] of resumeStore) {
    if (Date.now() - val.ts > RESUME_TTL) continue;
    if (!val.duration || val.duration <= 0) continue;

    const pct = val.position / val.duration;
    if (pct < 0.05 || pct > 0.9) continue;

    const parts = key.split(":");
    const imdb = parts[0];
    const season = parts[1];
    const episode = parts[2];

    const isEpisode = season !== undefined && episode !== undefined;
    const entryType = isEpisode ? "series" : "movie";

    if (entryType !== type) continue;
    entries.push({ imdb, season, episode, isEpisode, entryType, pct });
  }

  // Fetch TMDB metadata in parallel
  const metas = await Promise.all(
    entries.map(async ({ imdb, season, episode, isEpisode, entryType, pct }) => {
      const tmdb = await getTmdbMeta(imdb);
      const name = tmdb ? tmdb.name : imdb;
      const poster = tmdb
        ? tmdb.poster
        : `https://images.metahub.space/poster/small/${imdb}/img`;

      return {
        id: imdb,
        type: entryType,
        name: name + (isEpisode ? ` S${season}E${episode}` : ""),
        poster,
        description: `${Math.round(pct * 100)}% watched`,
      };
    })
  );

  console.log(`[catalog] ${type}/modikodi-continue -> ${metas.length} items`);
  res.json({ metas });
});

// --- Zero-config stream handler: records content, returns empty streams ---
app.get("/stream/:type/:id.json", (req, res) => {
  const ip = getClientIp(req);
  console.log(`[stream] ${req.params.type}/${req.params.id} from ${ip}`);
  storeContent(req, req.params.type, req.params.id);
  res.json({ streams: [] });
});

// --- Identify endpoint: ModiKodi queries this to get content metadata ---
app.get("/identify", (req, res) => {
  const ip = getClientIp(req);
  const info = contentStore.get(ip);

  if (info && Date.now() - info.ts < CONTENT_TTL) {
    console.log(`[identify] ${ip} -> ${info.imdb} ${info.type} S${info.season}E${info.episode}`);
    // Build resume key and look up saved position
    let resumeKey = info.imdb;
    if (info.season && info.episode) resumeKey += `:${info.season}:${info.episode}`;
    const resumeInfo = resumeStore.get(resumeKey);
    const result = {
      found: true,
      imdb: info.imdb,
      type: info.type,
      season: info.season,
      episode: info.episode,
    };
    if (resumeInfo && Date.now() - resumeInfo.ts < RESUME_TTL) {
      result.resume = { position: resumeInfo.position, duration: resumeInfo.duration };
      console.log(`[identify] resume data: pos=${resumeInfo.position} dur=${resumeInfo.duration}`);
    }
    res.json(result);
  } else {
    console.log(`[identify] ${ip} -> not found (store size: ${contentStore.size})`);
    res.json({ found: false });
  }
});

// --- Resume endpoint: ModiKodi reports playback position on stop ---
app.post("/resume", (req, res) => {
  const { imdb, season, episode, position, duration } = req.body;
  if (!imdb) return res.status(400).json({ error: "imdb required" });

  let key = imdb;
  if (season && episode) key += `:${season}:${episode}`;

  // If playback completed (>90%), remove resume entry
  if (duration > 0 && position / duration > 0.9) {
    resumeStore.delete(key);
    console.log(`[resume] ${key} completed (${Math.round(position/duration*100)}%), cleared`);
  } else {
    resumeStore.set(key, { position, duration, ts: Date.now() });
    console.log(`[resume] ${key} saved pos=${position} dur=${duration}`);
  }

  res.json({ ok: true });
});

// --- Configured manifest (wrapper mode with upstream encoded in path) ---
app.get("/:upstream/manifest.json", (req, res) => {
  let upstreamName = "";
  try {
    const decoded = b64decode(req.params.upstream);
    upstreamName = new URL(decoded).hostname;
  } catch (e) {
    /* ignore parse errors */
  }

  res.json({
    id: "com.modikodi.bridge",
    version: BRIDGE_VERSION,
    name: "ModiKodi Bridge" + (upstreamName ? ` (${upstreamName})` : ""),
    description:
      "Embeds content metadata (IMDB, season, episode) in stream URLs for ModiKodi Trakt scrobbling.",
    logo: "https://raw.githubusercontent.com/xbmc/xbmc/master/media/icon256x256.png",
    catalogs: [],
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    behaviorHints: {
      configurable: true,
    },
  });
});

// --- Wrapper mode stream handler: wraps upstream + injects _mk_* params ---
app.get("/:upstream/stream/:type/:id.json", async (req, res) => {
  try {
    const upstreamBase = b64decode(req.params.upstream);
    const { type, id } = req.params;

    // Parse Stremio content ID: "tt1234567" or "tt1234567:1:3"
    const parts = id.split(":");
    const imdbId = parts[0];
    const season = parts[1] || "";
    const episode = parts[2] || "";

    // Also record in side-channel store (wrapper mode gets both)
    storeContent(req, type, id);

    // Fetch streams from upstream addon
    const upstreamUrl = `${upstreamBase}/stream/${type}/${id}.json`;
    const upstreamRes = await fetch(upstreamUrl, { timeout: 15000 });

    if (!upstreamRes.ok) {
      console.error(`Upstream ${upstreamRes.status}: ${upstreamUrl}`);
      return res.json({ streams: [] });
    }

    const data = await upstreamRes.json();

    // Append _mk_* metadata to each stream URL
    const streams = (data.streams || []).map((stream) => {
      // Only modify streams with a direct URL (skip infoHash/externalUrl-only)
      if (!stream.url) return stream;

      const sep = stream.url.includes("?") ? "&" : "?";
      let meta = `${sep}_mk_imdb=${encodeURIComponent(imdbId)}&_mk_type=${type}`;
      if (season) meta += `&_mk_s=${season}`;
      if (episode) meta += `&_mk_e=${episode}`;

      return { ...stream, url: stream.url + meta };
    });

    res.json({ streams });
  } catch (err) {
    console.error("Stream handler error:", err.message);
    res.json({ streams: [] });
  }
});

// Local development server (skipped on Vercel)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 7515;
  app.listen(PORT, () => {
    console.log(`ModiKodi Bridge running on port ${PORT}`);
    console.log(`Configure at: http://localhost:${PORT}/configure`);
  });
}

module.exports = app;
