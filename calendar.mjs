// Syncs the team's published calendar (iCloud webcal/.ics) into the board.
// Runs server-side on the GitHub runner (no browser CORS limits): fetches the
// feed, expands recurring entries (e.g. yearly birthdays), and uses Gemini to
// map each entry to the right station(s) with an on-brand angle. Writes
// calendar.json. Fully non-fatal — any problem just writes an empty file so the
// board never breaks, and the rest of the workflow carries on.

import ical from "node-ical";
import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import { writeFileSync } from "node:fs";

const CAL_URL = process.env.CAL_URL;
const writeEmpty = (msg) => {
  writeFileSync("calendar.json", JSON.stringify({ updated: new Date().toISOString(), events: [] }, null, 1));
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
For each entry: decide which station(s) it best suits (a decade/genre artist -> the matching Nation decade or genre station; a Welsh subject -> Welsh/Dragon; a Devon subject -> Radio Exe; national/general -> nation-network) and write ONE sharp, on-brand angle. Voice: clever UK radio presenter, minimal or NO emoji, one hashtag or none, no engagement-bait. Skip entries that aren't useful for radio social.
Output ONLY a JSON object, no markdown fences, every string on one line:
{"events":[{"id":"shortslug","date":"YYYY-MM-DD","type":"birthday|gig|sport|culture|seasonal|community|tv","title":"short headline","blurb":"one factual sentence","fits":[{"g":"groupid","sub":"Station name or empty string"}],"angles":[{"name":"angle name","copy":"the ready copy starter","channels":["instagram","facebook","x"],"time":"HH:MM","tags":["#Hashtag"]}]}]}`;

const run = async () => {
  if (!CAL_URL) { writeEmpty("No CAL_URL secret set — skipping calendar sync."); return; }

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
  if (!items.length) { writeEmpty("No upcoming calendar entries within the next 110 days."); return; }

  const prompt = `Today is ${today.toISOString().slice(0, 10)}. Turn these calendar entries into board events:\n` +
    items.map(e => `${e.date} — ${e.title}${e.notes ? (" — " + e.notes) : ""}`).join("\n");

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const withRetry = async (fn, tries = 5) => {
    for (let i = 0; i < tries; i++) {
      try { return await fn(); }
      catch (e) {
        const msg = String((e && e.message) || e);
        const transient = /\b(429|500|502|503)\b|unavailable|resource_exhausted|overloaded|high demand|try again/i.test(msg);
        if (i === tries - 1 || !transient) throw e;
        await new Promise(r => setTimeout(r, 6000 * (i + 1)));
      }
    }
  };
  const r = await withRetry(() => ai.models.generateContent({
    model: process.env.MODEL || "gemini-2.5-flash",
    contents: prompt,
    config: { systemInstruction: SYSTEM, temperature: 0.6, maxOutputTokens: 16384 }
  }));

  const t = (r.text || "").replace(/`+/g, " ").replace(new RegExp("[\\u0000-\\u001F]+", "g"), " ");
  const s = t.indexOf("{"), en = t.lastIndexOf("}");
  if (s < 0 || en < 0) throw new Error("No JSON returned from enrichment.");
  const slice = t.slice(s, en + 1);
  let out;
  try { out = JSON.parse(slice); } catch { out = JSON.parse(jsonrepair(slice)); }

  const groups = ["nation-network", "decades-genres", "welsh-local", "radio-exe", "dragon"];
  const validCh = ["instagram", "facebook", "x", "tiktok", "threads"];
  let events = (Array.isArray(out.events) ? out.events : []).filter(m =>
    m && m.date && m.title && Array.isArray(m.fits) && m.fits.length && m.fits.every(f => f && groups.includes(f.g)) &&
    Array.isArray(m.angles) && m.angles.length
  );
  events.forEach(m => m.angles.forEach(a => {
    a.channels = (Array.isArray(a.channels) ? a.channels : []).filter(c => validCh.includes(c));
    if (!a.channels.length) a.channels = ["instagram", "facebook"];
    if (!Array.isArray(a.tags)) a.tags = [];
  }));

  writeFileSync("calendar.json", JSON.stringify({ updated: new Date().toISOString(), events }, null, 1));
  console.log(`calendar.json written: ${events.length} events from ${items.length} calendar entries.`);
};

run().catch(e => writeEmpty("Calendar sync failed (non-fatal): " + e.message));
