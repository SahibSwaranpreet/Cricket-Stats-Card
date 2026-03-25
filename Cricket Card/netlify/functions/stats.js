// netlify/functions/stats.js
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let player, league;
  try {
    ({ player, league } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!player || !league) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing player or league" }) };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "API key not configured" }) };
  }

  const prompt = `You are a cricket statistics expert with deep knowledge of all international and franchise cricket.

Generate a COMPLETE and ACCURATE stats card for: "${player}" in "${league}" format.

IMPORTANT:
- Use REAL verified career statistics for this player
- If they play in IPL, use their actual IPL team and IPL stats
- If they play in BBL, use their actual BBL team and BBL stats  
- For international formats (T20I/ODI/Test), use their international career stats
- Radar scores should reflect their actual skill profile (a pure bowler gets low batting radar, etc.)
- jerseyPrimary should be their actual team's primary kit color in hex
- Recent form should reflect actual recent results if known, otherwise plausible
- Fixtures should be realistic upcoming opponents for that league/format

Return ONLY valid JSON, absolutely no markdown, no explanation, just the raw JSON object:

{
  "name": "exact full name",
  "team": "franchise name or country",
  "teamCode": "3-4 letter abbreviation",
  "role": "Batsman | Bowler | All-Rounder | Wicket-Keeper Batsman",
  "nat": "nationality/country",
  "age": number,
  "price": "auction price like ₹14 Cr or £8.5M",
  "own": ownership percentage as number like 24.5,
  "rank": "ranking like #3 or —",
  "rankLabel": "ICC Test | ICC ODI | ICC T20I | IPL etc",
  "jerseyPrimary": "#hexcolor",
  "jerseyAccent": "#hexcolor",
  "stats": {
    "runs": number or null,
    "avg": number or null,
    "sr": number or null,
    "hs": number or null,
    "h": number or null,
    "f": number or null,
    "wkts": number or null,
    "be": bowling average as number or null,
    "eco": economy as number or null,
    "mat": number
  },
  "radar": [batting 0-100, consistency 0-100, power 0-100, bowling 0-100, fielding 0-100, experience 0-100],
  "radarLabels": ["Batting", "Consistency", "Power", "Bowling", "Fielding", "Experience"],
  "form": ["W","L","W","W","L"],
  "bio": "2-sentence accurate bio about their career highlights and current status",
  "fixtures": [
    {"m": "OPP (H/A)", "d": "easy|medium|hard"},
    {"m": "OPP (H/A)", "d": "easy|medium|hard"},
    {"m": "OPP (H/A)", "d": "easy|medium|hard"},
    {"m": "OPP (H/A)", "d": "easy|medium|hard"},
    {"m": "OPP (H/A)", "d": "easy|medium|hard"},
    {"m": "OPP (H/A)", "d": "easy|medium|hard"}
  ]
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: data.error?.message || "API error" }) };
    }

    const text = data.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not parse stats" }) };
    }

    const stats = JSON.parse(match[0]);
    return { statusCode: 200, headers, body: JSON.stringify(stats) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
