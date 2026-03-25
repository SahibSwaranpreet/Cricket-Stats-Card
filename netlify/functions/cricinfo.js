// netlify/functions/cricinfo.js
// Uses multiple cricket data sources with fallback chain:
// 1. cricbuzz-live (Vercel-hosted unofficial proxy — open CORS)
// 2. ESPN cricket API (site.api.espn.com — publicly accessible)
// 3. ESPNCricinfo hs-consumer-api with full browser headers

const https = require("https");

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, text/html, */*;q=0.9",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Cache-Control": "no-cache",
      ...extraHeaders,
    };

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers,
    };

    const req = https.request(options, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return httpsGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }

      // Handle gzip
      let body = Buffer.alloc(0);
      res.on("data", (chunk) => { body = Buffer.concat([body, chunk]); });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: body.toString("utf8"), headers: res.headers });
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Build ESPNCricinfo image URL from path
function imgUrl(path, size = "w_320") {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `https://img1.hscicdn.com/image/upload/f_auto,t_ds_square_${size},q_60/lsci${path}`;
}

// ── SOURCE 1: cricbuzz-live Vercel proxy ──────────────────────────────────
async function searchCricbuzz(q) {
  const url = `https://cricbuzz-live.vercel.app/player/search?search=${encodeURIComponent(q)}`;
  try {
    const r = await httpsGet(url);
    if (r.status !== 200) return null;
    const data = JSON.parse(r.body);
    const list = data?.player || data?.players || data?.results || data || [];
    if (!Array.isArray(list) || !list.length) return null;
    return list.slice(0, 10).map(p => ({
      id: p.id || p.objectId || p.player_id,
      name: p.name || p.fullName || p.longName,
      country: p.country || p.nationality,
      role: p.role || p.playing_role,
      team: p.teamName,
      image: p.imageUrl || p.image_url || p.imageLink || null,
    })).filter(p => p.id && p.name);
  } catch { return null; }
}

// ── SOURCE 2: ESPN cricket search API ────────────────────────────────────
async function searchESPN(q) {
  const url = `https://site.api.espn.com/apis/search/v2?query=${encodeURIComponent(q)}&type=cricket_player&limit=10`;
  try {
    const r = await httpsGet(url, {
      "Referer": "https://www.espn.com/",
      "Origin": "https://www.espn.com",
    });
    if (r.status !== 200) return null;
    const data = JSON.parse(r.body);
    const hits = data?.results?.[0]?.contents || data?.hits || [];
    if (!hits.length) return null;
    return hits.slice(0, 10).map(h => ({
      id: h.id || h.uid?.replace("s:0~a:", ""),
      name: h.displayName || h.name,
      country: h.nationality || h.country,
      role: h.position?.name || h.role,
      team: h.team?.name,
      image: h.headshot?.href || h.image || null,
    })).filter(p => p.id && p.name);
  } catch { return null; }
}

// ── SOURCE 3: ESPNCricinfo hs-consumer-api with aggressive headers ────────
async function searchCricinfo(q) {
  const url = `https://hs-consumer-api.espncricinfo.com/v1/pages/player/search?lang=en&search=${encodeURIComponent(q)}`;
  try {
    const r = await httpsGet(url, {
      "Referer": "https://www.espncricinfo.com/cricketers",
      "Origin": "https://www.espncricinfo.com",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "x-requested-with": "XMLHttpRequest",
    });
    if (r.status !== 200) return null;
    const data = JSON.parse(r.body);
    const results = data?.results || [];
    if (!results.length) return null;
    return results.slice(0, 10).map(p => ({
      id: p.objectId,
      name: p.longName || p.name,
      country: p.country?.name || p.country,
      role: p.playingRole,
      team: p.teamName,
      image: imgUrl(p.imageUrl, "w_160"),
      imageLarge: imgUrl(p.imageUrl, "w_640"),
    })).filter(p => p.id && p.name);
  } catch { return null; }
}

// ── SOURCE: ESPN cricket player stats ────────────────────────────────────
async function getPlayerESPN(id) {
  const url = `https://site.api.espn.com/apis/common/v3/sports/cricket/players/${id}`;
  try {
    const r = await httpsGet(url, {
      "Referer": "https://www.espn.com/cricket/",
      "Origin": "https://www.espn.com",
    });
    if (r.status !== 200) return null;
    const d = JSON.parse(r.body);
    const a = d.athlete || d;
    return {
      id: a.id,
      name: a.displayName || a.fullName || a.name,
      country: a.citizenship || a.nationality,
      role: a.position?.name,
      batting: a.bats,
      bowling: a.throws,
      dob: a.dateOfBirth,
      age: a.age,
      image: a.headshot?.href || null,
      stats: a.statistics || d.statistics || [],
      teams: (a.teams || []).map(t => t.team?.displayName || t.displayName),
    };
  } catch { return null; }
}

// ── SOURCE: cricbuzz-live player detail ──────────────────────────────────
async function getPlayerCricbuzz(id) {
  const url = `https://cricbuzz-live.vercel.app/player/${id}`;
  try {
    const r = await httpsGet(url);
    if (r.status !== 200) return null;
    const d = JSON.parse(r.body);
    const p = d?.player || d;

    // Build stats object
    const batting = {};
    const bowling = {};
    const formats = ["test", "odi", "t20i", "ipl", "t20"];
    formats.forEach(fmt => {
      const batKey = `${fmt}_bat` in p ? p[`${fmt}_bat`] : null;
      const bowlKey = `${fmt}_bowl` in p ? p[`${fmt}_bowl`] : null;
      if (batKey) batting[fmt] = batKey;
      if (bowlKey) bowling[fmt] = bowlKey;
    });

    // Also check career stats
    const career = p.career || p.stats || p.careerStats || {};

    return {
      id,
      name: p.name || p.fullName,
      country: p.country || p.nationality,
      role: p.role || p.playingRole || p.playing_role,
      batting: p.battingStyle || p.bat_style,
      bowling: p.bowlingStyle || p.bowl_style,
      dob: p.dob || p.dateOfBirth,
      age: p.age,
      image: p.imageUrl || p.image_url || p.imageLink,
      career,
      rawStats: batting,
      rawBowlStats: bowling,
    };
  } catch { return null; }
}

// ── ESPNCricinfo player with better headers ───────────────────────────────
async function getPlayerCricinfo(id) {
  const url = `https://hs-consumer-api.espncricinfo.com/v1/pages/player/home?playerId=${id}&lang=en`;
  try {
    const r = await httpsGet(url, {
      "Referer": `https://www.espncricinfo.com/cricketers/player-${id}`,
      "Origin": "https://www.espncricinfo.com",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
    });
    if (r.status !== 200) return null;
    const pd = JSON.parse(r.body);
    const player = pd.player || pd;
    const content = pd.content || {};

    // Parse stats tables
    const batRows = content.stats?.batting || content.battingStats || [];
    const bowlRows = content.stats?.bowling || content.bowlingStats || [];

    const parseBat = (label) => {
      const row = batRows.find(s =>
        (s.heading || "").toLowerCase().includes(label.toLowerCase()) ||
        String(s.matchClassId) === label
      );
      return row ? { m: row.matches, r: row.runs, avg: row.avg, sr: row.strikeRate, hs: row.highScore, h: row.hundreds, f: row.fifties } : null;
    };
    const parseBowl = (label) => {
      const row = bowlRows.find(s =>
        (s.heading || "").toLowerCase().includes(label.toLowerCase()) ||
        String(s.matchClassId) === label
      );
      return row ? { m: row.matches, w: row.wickets, avg: row.avg, eco: row.economy, bb: row.bestBowling } : null;
    };

    return {
      id,
      name: player.longName || player.name,
      country: player.country?.name || player.country,
      role: player.playingRole,
      batting: player.battingStyles?.[0]?.id,
      bowling: player.bowlingStyles?.[0]?.id,
      dob: player.dateOfBirth,
      image: imgUrl(player.imageUrl || player.image, "w_640"),
      currentTeams: (content.teams || []).map(t => t.team?.name || t.name),
      rankings: content.rankings || [],
      stats: {
        iplBat: parseBat("Indian Premier League") || parseBat("21"),
        t20iBat: parseBat("Twenty20 Internationals") || parseBat("3"),
        odiBat: parseBat("ODI") || parseBat("2"),
        testBat: parseBat("Test") || parseBat("1"),
        iplBowl: parseBowl("Indian Premier League") || parseBowl("21"),
        t20iBowl: parseBowl("Twenty20 Internationals") || parseBowl("3"),
        odiBowl: parseBowl("ODI") || parseBowl("2"),
        testBowl: parseBowl("Test") || parseBowl("1"),
      }
    };
  } catch { return null; }
}

// ── HANDLER ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  const p = event.queryStringParameters || {};
  const action = p.action || "search";

  try {
    // ── SEARCH ────────────────────────────────────────────────────────────
    if (action === "search") {
      const q = p.q || "";
      if (!q.trim()) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing q" }) };

      console.log(`Searching for: "${q}"`);

      // Try sources in order
      let players = await searchCricinfo(q);
      console.log("Cricinfo search:", players ? players.length : "failed");

      if (!players || !players.length) {
        players = await searchCricbuzz(q);
        console.log("Cricbuzz search:", players ? players.length : "failed");
      }
      if (!players || !players.length) {
        players = await searchESPN(q);
        console.log("ESPN search:", players ? players.length : "failed");
      }

      if (!players || !players.length) {
        // Last resort: try a Google-style search via DuckDuckGo instant answers
        players = [];
        return {
          statusCode: 404,
          headers: cors,
          body: JSON.stringify({ error: `No results found for "${q}". All sources returned empty. Try a more specific name.` })
        };
      }

      return { statusCode: 200, headers: cors, body: JSON.stringify({ players, source: "live" }) };
    }

    // ── PLAYER DETAIL ─────────────────────────────────────────────────────
    if (action === "player") {
      const id = p.id;
      if (!id) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing id" }) };

      console.log(`Fetching player: ${id}`);

      // Try cricinfo first (best stats), then cricbuzz, then ESPN
      let playerData = await getPlayerCricinfo(id);
      console.log("Cricinfo player:", playerData ? "OK" : "failed");

      if (!playerData) {
        playerData = await getPlayerCricbuzz(id);
        console.log("Cricbuzz player:", playerData ? "OK" : "failed");
      }
      if (!playerData) {
        playerData = await getPlayerESPN(id);
        console.log("ESPN player:", playerData ? "OK" : "failed");
      }

      if (!playerData) {
        return { statusCode: 404, headers: cors, body: JSON.stringify({ error: `Could not load stats for player ID ${id}` }) };
      }

      return { statusCode: 200, headers: cors, body: JSON.stringify(playerData) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error("Handler error:", err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
