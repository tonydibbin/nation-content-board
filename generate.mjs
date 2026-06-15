// Nation Content Board — self-running idea engine (free).
// PRIMARY: Google Gemini with Google Search grounding (knows what's live this week).
// BACKUP:  Groq (free, very reliable) kicks in automatically if Gemini is overloaded,
//          working from known events + the curated events.json so the board still
//          refreshes with solid content during a Gemini outage.
// Writes moments.json. Runs on a schedule (see .github/workflows/refresh.yml).

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { jsonrepair } from "jsonrepair";
import { writeFileSync, readFileSync } from "node:fs";

const today = new Date().toISOString().slice(0, 10);
const GEMINI_MODEL = process.env.MODEL || "gemini-2.5-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// The Nation Broadcasting network the board serves.
const NETWORK = `
Groups and their stations:
- nation-network (Nation Network): Nation Radio London, Scotland, Wales, South, Westcountry, Yorkshire, Suffolk, North East
- decades-genres (Decades & Genres): Nation Classic Hits, Nation Easy, Nation 60s, 70s, 80s, 90s, 00s, Nation Dance, Nation Hits, Nation Love, Nation Rocks, Nation Xmas
- welsh-local (Local Welsh Network): Bridge FM, Swansea Bay Radio, Radio Carmarthenshire, Radio Pembrokeshire
- radio-exe (Radio Exe): Exeter / Devon local
- dragon (Dragon Radio): Wales local`;

// Shared voice + mapping rules (used by both the primary and backup models).
const RULES = `
${NETWORK}

STATION MAPPING — be specific. Do NOT default everything to nation-network:
- Reserve "nation-network" ONLY for UK-wide news, national sport, and broad seasonal moments not tied to a music era or a place.
- ANY music artist, band, song, album or musician birthday MUST be tagged to the specific Nation decade/genre station(s) that play them — never nation-network. Use the artist's main era(s); list several stations when they span more than one. Examples:
  - Paul McCartney / The Beatles / Wings -> Nation 60s AND Nation 70s
  - 1980s acts (Duran Duran, Madonna, Wham!) -> Nation 80s
  - 1990s acts (Oasis, Spice Girls) -> Nation 90s ; 2000s acts -> Nation 00s ; 1960s/1970s acts -> Nation 60s / Nation 70s
  - current chart pop -> Nation Hits ; dance/electronic -> Nation Dance ; rock/indie -> Nation Rocks
  - soul, Motown, crooners, easy listening -> Nation Easy and/or Nation Classic Hits ; love songs/ballads -> Nation Love
  - an artist who spans eras gets several stations, e.g. Lionel Richie -> Nation 80s AND Nation Easy
- Put the single most relevant station FIRST in "fits" (it is shown as the headline tag).
- Welsh subjects -> welsh-local and/or dragon. Devon/Exeter -> radio-exe. A specific UK city's or nation's story -> that area's Nation Radio sub (e.g. a Glasgow/Scotland story or a Scottish festival like TRNSMT -> Nation Radio Scotland; a London story -> Nation Radio London).

VOICE of the copy starters:
- Sharp, fast, witty, specific. A clever human presenter, not a brand bot.
- Minimal or NO emoji. One hashtag or none. No engagement-bait ("tag a mate").
- Each moment gets 2-3 distinct ANGLES (different creative takes), each with a ready copy starter.

NEVER write "happy birthday" for someone who has died. Several well-known artists have died recently (for example Brian Wilson of the Beach Boys, who passed in 2025). For anyone no longer living, either skip them, or frame it respectfully as a tribute (e.g. "would have been 84 today"). If you are not certain a person is still alive, skip them.

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
"off" is whole days from today (${today}); 0 = today.`;

// Primary (Gemini + Google Search): can see what's genuinely live this week.
const SYSTEM_SEARCH = `You are the content desk for Nation Broadcasting, a UK radio network. You produce a feed of LIVE, talked-about content ideas for social media, mapped to the right station(s). A human will design and post; you only supply the thinking.

HARD RULES on what counts as a good moment:
- It must be genuinely live and being talked about right now or in the next ~10 days: results, fixtures, gigs that week, chart news, big TV, notable birthdays of relevant artists, real seasonal moments.
- NO "on this day" / anniversary trivia. NO worthy awareness days. NO generic filler or invented listener shout-outs.
- Verify facts with Google Search. Get ages and dates RIGHT (compute age from birth year).
${RULES}
Aim for 14-20 strong moments covering as many stations as the real news allows, including some local Welsh, Dragon and Radio Exe stories where genuine local hooks exist. Keep it concise so the whole JSON object is complete and not cut off.`;

// Backup (Groq, no web access): grounded in known events + the curated events list,
// so it stays accurate without inventing live results it can't verify.
const SYSTEM_NOSEARCH = `You are the content desk for Nation Broadcasting, a UK radio network. You produce a feed of content ideas for social media, mapped to the right station(s). A human will design and post.

IMPORTANT: You do NOT have web access right now. So do NOT invent live sports scores, this-week chart positions, or "tonight's" gigs — you cannot verify them and must not guess. Instead build the feed from: (a) the list of confirmed upcoming events provided below, and (b) well-known, reliable facts you are confident about — notably famous musicians' birthdays around today's date and genuine seasonal moments. If you are not certain a fact or a person being alive, skip it. Quality over quantity.
${RULES}
Aim for 10-16 solid moments. Lean on the provided events and confident evergreen hooks. Keep it concise so the whole JSON object is complete and not cut off.`;

const PROMPT_SEARCH = `Today is ${today}. Use Google Search to find what's live and talked-about in the UK right now (sport incl. any World Cup/football, big gigs this week, the singles chart, major TV, notable artist birthdays, seasonal moments) and produce the moments JSON for the Nation Broadcasting board. No almanac/"on this day", no awareness-day filler, get every age and date right. Output only the JSON object, with every string on a single line.`;

// Retry transient model errors (503 high demand, 429 rate limit, overload, timeouts).
function isTransient(e) {
  const msg = String((e && e.message) || e);
  return /\b(429|500|502|503|504)\b|unavailable|resource_exhausted|overloaded|high demand|try again|timeout|ETIMEDOUT|ECONNRESET/i.test(msg);
}
async function withRetry(fn, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1 || !isTransient(e)) throw e;
      const wait = 5000 * (i + 1);
      console.log(`Transient model error, retrying in ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// Pull the outermost { ... }, strip fences/control chars, parse (repair if needed).
function parseModelJson(text) {
  const clean = String(text || "").replace(/`+/g, " ").replace(new RegExp("[\\u0000-\\u001F]+", "g"), " ");
  const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON found in model output:\n" + String(text).slice(0, 400));
  const slice = clean.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { return JSON.parse(jsonrepair(slice)); }
}

// ---- PRIMARY: Gemini with Google Search grounding ----
async function generateWithGemini() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await withRetry(() => ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: PROMPT_SEARCH,
    config: { systemInstruction: SYSTEM_SEARCH, tools: [{ googleSearch: {} }], temperature: 0.7, maxOutputTokens: 16384 }
  }));
  return parseModelJson(res.text || "");
}

// ---- BACKUP: Groq (free, reliable), grounded in curated events ----
function curatedContext() {
  let events = [];
  try { events = JSON.parse(readFileSync("events.json", "utf8")).events || []; } catch (_) {}
  const horizon = new Date(); horizon.setDate(horizon.getDate() + 21);
  const soon = events
    .filter(e => e && e.date && new Date(e.date) >= new Date(today) && new Date(e.date) <= horizon)
    .map(e => `${e.date} — ${e.title}${e.blurb ? (": " + e.blurb) : ""}`);
  return soon.length ? `\nConfirmed upcoming events (use these):\n${soon.join("\n")}` : "";
}
async function generateWithGroq() {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const prompt = `Today is ${today}. Build the moments JSON for the Nation Broadcasting board from confident, known hooks (famous musicians' birthdays around today, genuine seasonal moments) and the confirmed events below. Do not invent live results you cannot verify. Output only the JSON object, every string on a single line.${curatedContext()}`;
  const res = await withRetry(() => groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: "system", content: SYSTEM_NOSEARCH }, { role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 8000,
    response_format: { type: "json_object" }
  }));
  return parseModelJson(res.choices?.[0]?.message?.content || "");
}

// Shared validation so a bad run can't wipe the board.
function clean(data, source) {
  if (!data || !Array.isArray(data.moments) || data.moments.length === 0) throw new Error("No moments generated");
  data.updated = new Date().toISOString();
  data.source = source;
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
    const t = ((m.title || "") + " " + (m.angles || []).map(a => a.copy || "").join(" ")).toLowerCase();
    const birthdayish = m.type === "birthday" || /happy|birthday/.test(t);
    return !(birthdayish && DECEASED.some(n => t.includes(n)) && !/would have been|tribute|remember/.test(t));
  });
  if (data.moments.length === 0) throw new Error("All moments failed validation");
  return data;
}

const run = async () => {
  let data, source;
  try {
    data = clean(await generateWithGemini(), "gemini");
    source = "gemini";
  } catch (e) {
    console.log(`Primary (Gemini) unavailable: ${e.message}`);
    if (!process.env.GROQ_API_KEY) throw new Error("Gemini failed and no GROQ_API_KEY backup is set.");
    console.log("Falling back to Groq backup model…");
    data = clean(await generateWithGroq(), "groq");
    source = "groq";
  }
  writeFileSync("moments.json", JSON.stringify(data, null, 1));
  console.log(`Wrote moments.json via ${source}: ${data.moments.length} moments, ${data.moments.reduce((n, m) => n + m.angles.length, 0)} angles.`);
};

run().catch(e => { console.error("Generation failed (both models):", e.message); process.exit(1); });
