// Nation Content Board — self-running idea engine (free, Google Gemini).
// Researches what's live & talked-about with Google Search, writes moments.json.
// Runs on a schedule (see .github/workflows/refresh.yml). Needs a free GEMINI_API_KEY.

import { GoogleGenAI } from "@google/genai";
import { writeFileSync } from "node:fs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.MODEL || "gemini-2.0-flash";
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
- Verify facts with Google Search. Get ages and dates RIGHT (compute age from birth year). Do not feature anyone who has died as if alive.
- Map each moment to the station(s) it actually suits. Local stories go to local stations; decade/genre stories to the matching sub-station.

VOICE of the copy starters:
- Sharp, fast, witty, specific. A clever human presenter, not a brand bot.
- Minimal or NO emoji. One hashtag or none. No engagement-bait ("tag a mate").
- Each moment gets 2-3 distinct ANGLES (different creative takes), each with a ready copy starter.

OUTPUT: Return ONLY a JSON object, no prose, no markdown fences. Schema:
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
"off" is whole days from today (${today}); 0 = today. Aim for 18-30 strong moments covering as many stations as the real news allows, including some local Welsh, Dragon and Radio Exe stories where genuine local hooks exist.`;

const PROMPT = `Today is ${today}. Use Google Search to find what's live and talked-about in the UK right now (sport incl. any World Cup/football, big gigs this week, the singles chart, major TV, notable artist birthdays, seasonal moments) and produce the moments JSON for the Nation Broadcasting board. No almanac/"on this day", no awareness-day filler, get every age and date right. Output only the JSON object.`;

const run = async () => {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: PROMPT,
    config: {
      systemInstruction: SYSTEM,
      tools: [{ googleSearch: {} }],
      temperature: 0.7,
      maxOutputTokens: 8192
    }
  });

  const text = res.text || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON found in model output:\n" + text.slice(0, 500));
  const data = JSON.parse(text.slice(start, end + 1));

  if (!Array.isArray(data.moments) || data.moments.length === 0) throw new Error("No moments generated");
  data.updated = new Date().toISOString();

  // Light validation so a bad run can't wipe the board.
  const groups = ["nation-network", "decades-genres", "welsh-local", "radio-exe", "dragon"];
  data.moments = data.moments.filter(m =>
    m && m.id && m.title && Array.isArray(m.fits) && m.fits.length && m.fits.every(f => groups.includes(f.g)) &&
    Array.isArray(m.angles) && m.angles.length && m.angles.every(a => a.copy && a.copy.trim())
  );
  if (data.moments.length === 0) throw new Error("All moments failed validation");

  writeFileSync("moments.json", JSON.stringify(data, null, 1));
  console.log(`Wrote moments.json: ${data.moments.length} moments, ${data.moments.reduce((n, m) => n + m.angles.length, 0)} angles.`);
};

run().catch(e => { console.error("Generation failed:", e.message); process.exit(1); });
