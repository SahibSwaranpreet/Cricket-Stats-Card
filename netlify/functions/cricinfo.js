// netlify/functions/cricinfo.js
// Proxies ESPNCricinfo's unofficial API — no API key needed
// Handles: /search?q=name  and  /player?id=123

const https = require("https");

// Fetch any URL server-side with browser headers to bypass CORS/CDN
function fetch(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espncricinfo.com/",
        "Origin": "https://www.espncricinfo.com",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
      },
    };
    https.get(url, opts, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    }).on("error", reject);
  });
}

// Build player image URL from ESPNCricinfo image path
function buildImageUrl(imagePath, size = "w_320") {
  if (!imagePath) return null;
  return `https://img1.hscicdn.com/image/upload/f_auto,t_ds_square_${size},q_60/lsci${imagePath}`;
}

// Parse batting career stats from ESPNCricinfo API response
function parseBatting(statsArr, label) {
  const row = statsArr?.find(
    (s) =>
      s.heading?.toLowerCase().includes(label.toLowerCase()) ||
      s.matchClassId === label
  );
  if (!row) return null;
  return {
    m: row.matches ?? row.mat,
    r: row.runs,
    avg: row.avg,
    sr: row.strikeRate,
    hs: row.highScore,
    h: row.hundreds,
    f: row.fifties,
  };
}

// Parse bowling career stats
function parseBowling(statsArr, label) {
  const row = statsArr?.find(
    (s) =>
      s.heading?.toLowerCase().includes(label.toLowerCase()) ||
      s.matchClassId === label
  );
  if (!row) return null;
  return {
    m: row.matches ?? row.mat,
    w: row.wickets,
    avg: row.avg,
    eco: row.economy,
    bb: row.bestBowling,
  };
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const params = event.queryStringParameters || {};
  const action = params.action || "search";

  try {
    // ── SEARCH ──────────────────────────────────────────────────────────
    if (action === "search") {
      const q = encodeURIComponent(params.q || "");
      if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing q" }) };

      const url = `https://hs-consumer-api.espncricinfo.com/v1/pages/player/search?lang=en&search=${q}`;
      const res = await fetch(url);

      if (res.status !== 200) {
        return { statusCode: res.status, headers, body: JSON.stringify({ error: `Cricinfo returned ${res.status}` }) };
      }

      const data = JSON.parse(res.body);
      const players = (data.results || []).slice(0, 10).map((p) => ({
        id: p.objectId,
        name: p.longName || p.name,
        country: p.country?.name || p.country,
        role: p.playingRole,
        team: p.teamName,
        image: buildImageUrl(p.imageUrl, "w_160"),
        imageLarge: buildImageUrl(p.imageUrl, "w_640"),
      }));

      return { statusCode: 200, headers, body: JSON.stringify({ players }) };
    }

    // ── PLAYER STATS ─────────────────────────────────────────────────────
    if (action === "player") {
      const id = params.id;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing id" }) };

      const profileUrl = `https://hs-consumer-api.espncricinfo.com/v1/pages/player/home?playerId=${id}&lang=en`;
      const profileRes = await fetch(profileUrl);
      if (profileRes.status !== 200) {
        return { statusCode: profileRes.status, headers, body: JSON.stringify({ error: `Cricinfo returned ${profileRes.status}` }) };
      }

      const pd = JSON.parse(profileRes.body);
      const player = pd.player || pd;
      const content = pd.content || {};

      // Biography details
      const bio = {
        id: player.objectId || id,
        name: player.longName || player.name,
        country: player.country?.name || player.country,
        role: player.playingRole,
        batting: player.battingStyles?.[0]?.id || "Right-hand bat",
        bowling: player.bowlingStyles?.[0]?.id || "Right-arm Medium",
        dob: player.dateOfBirth,
        image: buildImageUrl(player.imageUrl || player.image, "w_640"),
        imageThumb: buildImageUrl(player.imageUrl || player.image, "w_160"),
        iccRankings: content.rankings || [],
        currentTeams: (content.teams || []).map((t) => t.team?.name || t.name),
      };

      // Career stats
      const batting = content.stats?.batting || content.battingStats || [];
      const bowling = content.stats?.bowling || content.bowlingStats || [];

      // Parse different formats
      const stats = {
        testBat: parseBatting(batting, "Test") || parseBatting(batting, "1"),
        odiBat: parseBatting(batting, "ODI") || parseBatting(batting, "2"),
        t20iBat: parseBatting(batting, "Twenty20 Internationals") || parseBatting(batting, "3"),
        iplBat: parseBatting(batting, "Indian Premier League") || parseBatting(batting, "21"),
        testBowl: parseBowling(bowling, "Test") || parseBowling(bowling, "1"),
        odiBowl: parseBowling(bowling, "ODI") || parseBowling(bowling, "2"),
        t20iBowl: parseBowling(bowling, "Twenty20 Internationals") || parseBowling(bowling, "3"),
        iplBowl: parseBowling(bowling, "Indian Premier League") || parseBowling(bowling, "21"),
        raw: batting.slice(0, 8), // send raw for debugging
      };

      return { statusCode: 200, headers, body: JSON.stringify({ bio, stats }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action. Use action=search or action=player" }) };

  } catch (err) {
    console.error("cricinfo proxy error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
