// Syncs the team's published calendar (iCloud webcal/.ics) into the board.
// Runs server-side on the GitHub runner (no browser CORS limits): fetches the
// feed, expands recurring entries (e.g. yearly birthdays), and maps each entry to
// the right station(s) with an on-brand angle.
//
// Resilience: tries Gemini first, then Groq (free backup) if Gemini is overloaded.
// If BOTH AI models are unavailable, it STILL writes the calendar entries with a
// simple factual angle — so your calendar always shows in the look-ahead, AI or not.
// Writes calendar.json. Fully non-fatal.

import ical from "node-ical";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { jsonrepair } from "jsonrepair";
import { writeFileSync } from "node:fs";

const CAL_URL = process.env.CAL_URL;
const GEMINI_MODEL = process.env.MODEL || "gemini-2.5-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const writeOut = (events, msg) => {
  writeFileSync("calendar.json", JSON.stringify({ updated: new Date().toISOString(), events }, null, 1));
  console.log(msg);
};

const NETWORK = `
Groups and their stations:
- nation-network (Nation Network): Nation Radio London, Scotland, Wales, South, Westcountry, Yorkshire, Suffolk, North East
- decades-genres (Decades & Genres): Nation Classic Hits, Nation Easy, Nation 60s, 70s, 80s, 90s, 00s, Nation Dance, Nation Hits, Nation Love, Nation Rocks, Nation Xmas
- welsh-local (Local Welsh Network): Bridge FM, Swansea Bay Radio, Radio Carmarthenshire, Radio Pembrokeshire
- radio-exe (Radio Exe): Exeter / Devon local
- dragon (Dragon Radio): Wales local`;

const SYSTEM = `You are the content desk for Nation Broadcasting (UK radio). You turn dated calendar entries into ready-to-use board events.
${NETWORK}
STATION MAPPING — be specific, do NOT default to nation-network. Reserve nation-network only for UK-wide news/sport/general. ANY music artist or band goes to the specific Nation decade/genre station(s) that play them, never nation-network — use their main era(s) and list several when they span more than one. Examples: Paul McCartney/The Beatles -> Nation 60s and Nation 70s; an 80s act -> Nation 80s; current pop -> Nation Hits; dance -> Nation Dance; rock -> Nation Rocks; soul/easy-listening -> Nation Easy/Classic Hits; Lionel Richie -> Nation 80s and Nation Easy. Put the most relevant station FIRST. Welsh -> welsh-local/dragon; Devon -> radio-exe; a city/nation story or its festival (e.g. TRNSMT in Glasgow) -> that area's Nation Radio sub. Then write ONE sharp, on-brand angle. Voice: clever UK radio presenter, minimal or NO emoji, one hashtag or none, no engagement-bait. Skip entries that aren't useful for radio social. Never write "happy birthday" for someone who has died; frame as a tribute or skip.
AGES — for every birthday, state the EXACT age the person turns on that date, worked out as (the year of the date) minus (their birth year). Look up and verify the real birth year; never guess and never write vague phrases like "another year older" or "a year older". Example: someone born in 1940 with a birthday in 2026 turns 86 — so the title is "Ringo Starr turns 86" and the copy names the number too. For someone who has died, use "would have been N" with the same calculation. If you genuinely cannot establish a birth year (e.g. no web access on a backup run), leave the age out rather than inventing one.
Output ONLY a JSON object, no markdown fences, every string on one line:
{"events":[{"id":"shortslug","date":"YYYY-MM-DD","type":"birthday|gig|sport|culture|seasonal|community|tv","title":"short headline","blurb":"one factual sentence","fits":[{"g":"groupid","sub":"Station name or empty string"}],"angles":[{"name":"angle name","copy":"the ready copy starter","channels":["instagram","facebook","x"],"time":"HH:MM","tags":["#Hashtag"]}]}]}`;

const groups = ["nation-network", "decades-genres", "welsh-local", "radio-exe", "dragon"];
const validCh = ["instagram", "facebook", "x", "tiktok", "threads"];

function isTransient(e) {
  const msg = String((e && e.message) || e);
  return /\b(429|500|502|503|504)\b|unavailable|resource_exhausted|overloaded|high demand|try again|timeout|ETIMEDOUT|ECONNRESET/i.test(msg);
}
async function withRetry(fn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1 || !isTransient(e)) throw e;
      await new Promise(r => setTimeout(r, 5000 * (i + 1)));
    }
  }
}
function parseModelJson(text) {
  const t = String(text || "").replace(/`+/g, " ").replace(new RegExp("[\\u0000-\\u001F]+", "g"), " ");
  const s = t.indexOf("{"), en = t.lastIndexOf("}");
  if (s < 0 || en < 0) throw new Error("No JSON returned from enrichment.");
  const slice = t.slice(s, en + 1);
  try { return JSON.parse(slice); } catch { return JSON.parse(jsonrepair(slice)); }
}

async function enrichWithGemini(prompt) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const r = await withRetry(() => ai.models.generateContent({
    model: GEMINI_MODEL, contents: prompt,
    config: { systemInstruction: SYSTEM, tools: [{ googleSearch: {} }], temperature: 0.6, maxOutputTokens: 16384 }
  }));
  return parseModelJson(r.text || "");
}
async function enrichWithGroq(prompt) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const r = await withRetry(() => groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    temperature: 0.6, max_tokens: 8000, response_format: { type: "json_object" }
  }));
  return parseModelJson(r.choices?.[0]?.message?.content || "");
}

// Last-resort: turn raw calendar entries into clean, simple board events with no AI,
// so the calendar still appears even when every model is down.
function basicEvents(items) {
  return items.map((e, i) => ({
    id: "cal" + i,
    date: e.date,
    type: "community",
    title: e.title,
    blurb: e.notes || "",
    fits: [{ g: "nation-network", sub: "" }],
    angles: [{
      name: "Diary note",
      copy: e.title,
      channels: ["instagram", "facebook"],
      time: "09:00",
      tags: []
    }]
  }));
}

function validate(out) {
  let events = (Array.isArray(out.events) ? out.events : []).filter(m =>
    m && m.date && m.title && Array.isArray(m.fits) && m.fits.length && m.fits.every(f => f && groups.includes(f.g)) &&
    Array.isArray(m.angles) && m.angles.length
  );
  events.forEach(m => m.angles.forEach(a => {
    a.channels = (Array.isArray(a.channels) ? a.channels : []).filter(c => validCh.includes(c));
    if (!a.channels.length) a.channels = ["instagram", "facebook"];
    if (!Array.isArray(a.tags)) a.tags = [];
  }));
  return events;
}

const run = async () => {
  if (!CAL_URL) { writeOut([], "No CAL_URL secret set — skipping calendar sync."); return; }

  const url = CAL_URL.replace(/^webcal:/i, "https:");
  const text = await (await fetch(url)).text();
  const data = ical.sync.parseICS(text);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + 110);

  const raw = [];
  for (const k in data) {
    const e = data[k];
    if (!e || e.type !== "VEVENT") continue;
    const title = (e.summary || "").toString().trim();
    if (!title) continue;
    const notes = (e.description || "").toString().trim().slice(0, 160);
    if (e.rrule) {
      let occ = [];
      try { occ = e.rrule.between(today, horizon, true); } catch (_) {}
      occ.forEach(d => raw.push({ date: new Date(d).toISOString().slice(0, 10), title, notes }));
    } else if (e.start) {
      const d = new Date(e.start);
      if (d >= today && d <= horizon) raw.push({ date: d.toISOString().slice(0, 10), title, notes });
    }
  }
  raw.sort((a, b) => a.date.localeCompare(b.date));
  const items = raw.slice(0, 50);
  if (!items.length) { writeOut([], "No upcoming calendar entries within the next 110 days."); return; }

  const prompt = `Today is ${today.toISOString().slice(0, 10)}. Turn these calendar entries into board events:\n` +
    items.map(e => `${e.date} — ${e.title}${e.notes ? (" — " + e.notes) : ""}`).join("\n");

  // Try Gemini, then Groq, then fall back to plain (non-AI) entries — always write something.
  try {
    const events = validate(await enrichWithGemini(prompt));
    if (!events.length) throw new Error("Gemini returned no usable events.");
    writeOut(events, `calendar.json via Gemini: ${events.length} events from ${items.length} entries.`);
  } catch (e1) {
    console.log(`Calendar enrichment via Gemini unavailable: ${e1.message}`);
    try {
      if (!process.env.GROQ_API_KEY) throw new Error("no GROQ_API_KEY backup set");
      const events = validate(await enrichWithGroq(prompt));
      if (!events.length) throw new Error("Groq returned no usable events.");
      writeOut(events, `calendar.json via Groq backup: ${events.length} events from ${items.length} entries.`);
    } catch (e2) {
      console.log(`Calendar enrichment via Groq unavailable: ${e2.message}`);
      const events = basicEvents(items);
      writeOut(events, `calendar.json via basic (no-AI) fallback: ${events.length} entries shown without angles.`);
    }
  }
};

run().catch(e => writeOut([], "Calendar sync failed (non-fatal): " + e.message));
