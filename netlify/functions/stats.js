// netlify/functions/stats.js
const https = require("https");

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Parse body
  let player, league;
  try {
    ({ player, league } = JSON.parse(event.body));
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body: " + e.message }) };
  }

  if (!player || !league) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing player or league parameter" }) };
  }

  // Check API key
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "API key not set. Go to Netlify → Site Configuration → Environment Variables → add ANTHROPIC_API_KEY" })
    };
  }

  const prompt = `You are a cricket statistics expert. Generate accurate stats for "${player}" in "${league}".

Use REAL career statistics. Be accurate — don't underrate players.

Return ONLY a raw JSON object (no markdown, no backticks, no explanation):

{
  "name": "${player}",
  "team": "their actual team name for ${league}",
  "teamCode": "3-letter code",
  "role": "Batsman or Bowler or All-Rounder or Wicket-Keeper Batsman",
  "nat": "their nationality",
  "age": their real age as a number,
  "price": "their auction price like 14 Cr or £8.5M",
  "own": their fantasy ownership as a number like 24.5,
  "rank": "their ICC ranking like #3 or —",
  "rankLabel": "ICC Test or ICC ODI or ICC T20I or IPL",
  "jerseyPrimary": "#hexcolor of their actual team kit",
  "jerseyAccent": "#hexcolor",
  "stats": {
    "runs": their career runs as number or null if not applicable,
    "avg": their batting average as number or null,
    "sr": their strike rate as number or null,
    "hs": their highest score as number or null,
    "h": their centuries as number or null,
    "f": their fifties as number or null,
    "wkts": their wickets as number or null if not a bowler,
    "be": their bowling average as number or null,
    "eco": their economy rate as number or null,
    "mat": their total matches as number
  },
  "radar": [batting 0-100, consistency 0-100, power 0-100, bowling 0-100, fielding 0-100, experience 0-100],
  "radarLabels": ["Batting", "Consistency", "Power", "Bowling", "Fielding", "Experience"],
  "form": ["W", "L", "W", "W", "L"],
  "bio": "Two sentences about their career highlights and current form.",
  "fixtures": [
    {"m": "OPP (H)", "d": "easy"},
    {"m": "OPP (A)", "d": "medium"},
    {"m": "OPP (H)", "d": "hard"},
    {"m": "OPP (A)", "d": "easy"},
    {"m": "OPP (H)", "d": "medium"},
    {"m": "OPP (A)", "d": "hard"}
  ]
}`;

  const requestBody = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }],
  });

  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(requestBody),
    },
  };

  try {
    const response = await httpsPost(options, requestBody);

    if (response.status !== 200) {
      const errData = JSON.parse(response.body);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: `Anthropic API error: ${errData.error?.message || response.body}` })
      };
    }

    const data = JSON.parse(response.body);
    const text = data.content?.[0]?.text || "";

    // Strip any markdown fences just in case
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Could not parse stats from AI response. Raw: " + text.slice(0, 200) })
      };
    }

    const stats = JSON.parse(match[0]);
    return { statusCode: 200, headers, body: JSON.stringify(stats) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Function crashed: " + err.message })
    };
  }
};
