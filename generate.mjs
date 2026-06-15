// Nation Content Board — self-running idea engine (free, Google Gemini).
// Researches what's live & talked-about with Google Search, writes moments.json.
// Runs on a schedule (see .github/workflows/refresh.yml). Needs a free GEMINI_API_KEY.

import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import { writeFileSync } from "node:fs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const today = new Date().toISOString().slice(0, 10);

// The Nation Broadcasting network the board serves.
const NETWORK = `
Groups and their stations:
- nation-network (Nation Network): Nation Radio London, Scotland, Wales, South, Westcountry, Yorkshire, Suffolk, North East
- decades-genres (Decades & Genres): Nation Classic Hits, Nation Easy, Nation 60s, 70s, 80s, 90s, 00s, Nation Dance, Nation Hits, Nation Love, Nation Rocks, Nation Xmas
- welsh-local (Local Welsh Network): Bridge FM, Swansea Bay Radio, Radio Carmarthenshire, Radio Pembrokeshire
- radio-exe (Radio Exe): Exeter / Devon local
- dragon (Dragon Radio): Wales local`;

const SYSTEM = `You are the content desk for Nation Broadcasting, a UK radio network. You produce a feed of LIVE, talked-about content ideas for social media, mapped to the right station(s). A human will design and post; you only supply the thinking.

${NETWORK}

HARD RULES on what counts as a good moment:
- It must be genuinely live and being talked about right now or in the next ~10 days: results, fixtures, gigs that week, chart news, big TV, notable birthdays of relevant artists, real seasonal moments.
- NO "on this day" / anniversary trivia. NO worthy awareness days. NO generic filler or invented listener shout-outs.
- Verify facts with Google Search. Get ages and dates RIGHT (compute age from birth year).
- NEVER write "happy birthday" for someone who has died. Several well-known artists have died recently (for example Brian Wilson of the Beach Boys, who passed in 2025). For anyone no longer living, either skip them, or frame it respectfully as a tribute (e.g. "would have been 84 today"). If you are not certain a person is still alive, skip them.
- Map each moment to the station(s) it actually suits. Local stories go to local stations; decade/genre stories to the matching sub-station.

VOICE of the copy starters:
- Sharp, fast, witty, specific. A clever human presenter, not a brand bot.
- Minimal or NO emoji. One hashtag or none. No engagement-bait ("tag a mate").
- Each moment gets 2-3 distinct ANGLES (different creative takes), each with a ready copy starter.

OUTPUT: Return ONLY a JSON object, no prose, no markdown fences. All string values must be on a single line (no raw line breaks inside strings). Schema:
{
 "updated": "ISO timestamp",
 "moments": [
   {
     "id": "shortslug",
     "off": 0,
     "type": "sport|gig|birthday|tv|seasonal|culture",
     "hot": true,
     "title": "short headline",
     "blurb": "one factual sentence on what it is and why it matters",
     "source": { "l": "Source name", "u": "https://..." },
     "fits": [ { "g": "groupid", "sub": "Station name or empty string" } ],
     "angles": [
       { "name": "angle name", "for": "optional station this angle suits best",
         "copy": "the ready-to-use copy starter", "channels": ["instagram","facebook","x","tiktok","threads"],
         "time": "HH:MM", "tags": ["#Hashtag"] }
     ]
   }
 ]
}
"off" is whole days from today (${today}); 0 = today. Aim for 14-20 strong moments covering as many stations as the real news allows, including some local Welsh, Dragon and Radio Exe stories where genuine local hooks exist. Keep it concise so the whole JSON object is complete and not cut off.`;

const PROMPT = `Today is ${today}. Use Google Search to find what's live and talked-about in the UK right now (sport incl. any World Cup/football, big gigs this week, the singles chart, major TV, notable artist birthdays, seasonal moments) and produce the moments JSON for the Nation Broadcasting board. No almanac/"on this day", no awareness-day filler, get every age and date right. Output only the JSON object, with every string on a single line.`;

// Retry transient model errors (503 high demand, 429 rate limit, overload).
async function withRetry(fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = String((e && e.message) || e);
      const transient = /\b(429|500|502|503)\b|unavailable|resource_exhausted|overloaded|high demand|try again/i.test(msg);
      if (i === tries - 1 || !transient) throw e;
      console.log(`Transient model error, retrying in ${6 * (i + 1)}s…`);
      await new Promise(r => setTimeout(r, 6000 * (i + 1)));
    }
  }
}

const run = async () => {
  const res = await withRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: PROMPT,
    config: {
      systemInstruction: SYSTEM,
      tools: [{ googleSearch: {} }],
      temperature: 0.7,
      maxOutputTokens: 16384
    }
  }));

  const text = res.text || "";
  // Strip markdown code fences / backticks and any control characters, then take the
  // outermost { ... } — models often wrap JSON in ```json fences or stray line breaks.
  const clean = text.replace(/`+/g, " ").replace(new RegExp("[\\u0000-\\u001F]+", "g"), " ");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON found in model output:\n" + text.slice(0, 500));
  const slice = clean.slice(start, end + 1);
  let data;
  try { data = JSON.parse(slice); } catch { data = JSON.parse(jsonrepair(slice)); }

  if (!Array.isArray(data.moments) || data.moments.length === 0) throw new Error("No moments generated");
  data.updated = new Date().toISOString();

  // Light validation so a bad run can't wipe the board.
  const groups = ["nation-network", "decades-genres", "welsh-local", "radio-exe", "dragon"];
  const validCh = ["instagram", "facebook", "x", "tiktok", "threads"];
  for (const m of data.moments) {
    if (Array.isArray(m.fits)) m.fits = m.fits.filter(f => f && groups.includes(f.g));
    if (Array.isArray(m.angles)) for (const a of m.angles) {
      a.channels = (Array.isArray(a.channels) ? a.channels : []).filter(c => validCh.includes(c));
      if (!a.channels.length) a.channels = ["instagram", "facebook"];
      if (!Array.isArray(a.tags)) a.tags = [];
    }
  }
  data.moments = data.moments.filter(m =>
    m && m.id && m.title && Array.isArray(m.fits) && m.fits.length && m.fits.every(f => groups.includes(f.g)) &&
    Array.isArray(m.angles) && m.angles.length && m.angles.every(a => a.copy && a.copy.trim())
  );
  // Guard: never let a "happy birthday" slip through for someone who has died.
  const DECEASED = ["brian wilson"];
  data.moments = data.moments.filter(m => {
    const text = ((m.title || "") + " " + (m.angles || []).map(a => a.copy || "").join(" ")).toLowerCase();
    const birthdayish = m.type === "birthday" || /happy|birthday/.test(text);
    return !(birthdayish && DECEASED.some(n => text.includes(n)) && !/would have been|tribute|remember/.test(text));
  });
  if (data.moments.length === 0) throw new Error("All moments failed validation");

  writeFileSync("moments.json", JSON.stringify(data, null, 1));
  console.log(`Wrote moments.json: ${data.moments.length} moments, ${data.moments.reduce((n, m) => n + m.angles.length, 0)} angles.`);
};

run().catch(e => { console.error("Generation failed:", e.message); process.exit(1); });
