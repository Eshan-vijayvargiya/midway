// Google ratings and photos. Optional: switched on only when GOOGLE_MAPS_KEY is set in config.js.
// OpenStreetMap has no ratings, so after a search Midway asks Google once for the places around the fair spot
// and matches them to its own OpenStreetMap places by name and distance.
// Ratings are kept in memory for this visit only, never saved: Google's terms don't allow storing them.
import { GOOGLE_MAPS_KEY } from "./config.js?v=9";
import { haversine } from "./fair.js?v=9";

export const googleOn = Boolean(GOOGLE_MAPS_KEY);
const byVenue = new Map();          // venue id -> { rating, count, url, photo } | null (no match)
const MAX_CALLS = 12;               // per visit: a guard on top of the daily cap set in Google Cloud
let lib = null, calls = 0, problem = "";

function loadLibrary() {
  lib ||= new Promise((resolve, reject) => {
    window.__midwayGoogle = () => google.maps.importLibrary("places").then(resolve, reject);
    window.gm_authFailure = () => { problem = "Google refused the key. Check its website restriction in Google Cloud."; };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_KEY)}&v=weekly&language=en&region=IN&loading=async&callback=__midwayGoogle`;
    s.async = true;
    s.onerror = () => { lib = null; reject(new Error("the Google Maps script didn't load")); };
    document.head.appendChild(s);
  });
  return lib;
}

const TYPES = ["restaurant", "cafe", "coffee_shop", "fast_food_restaurant", "ice_cream_shop", "bakery", "dessert_shop"];

// One Nearby Search: up to 20 places. "DISTANCE" = nearest the spot first, "POPULARITY" = best known first.
async function nearby(center, radius, rank) {
  if (calls >= MAX_CALLS) throw new Error("Google lookups paused for this visit");
  calls++;
  const { Place, SearchNearbyRankPreference } = await loadLibrary();
  const { places } = await Place.searchNearby({
    fields: ["id", "displayName", "location", "rating", "userRatingCount", "photos", "googleMapsURI"],
    locationRestriction: { center: { lat: center.lat, lng: center.lon }, radius: Math.round(Math.min(radius, 5000)) },
    includedTypes: TYPES,
    maxResultCount: 20,
    rankPreference: SearchNearbyRankPreference[rank],
  });
  return (places || []).map((p) => ({
    name: p.displayName || "", lat: p.location?.lat(), lon: p.location?.lng(),
    rating: p.rating ?? null, count: p.userRatingCount ?? 0, url: p.googleMapsURI || "",
    photo: p.photos?.[0] ? {
      src: p.photos[0].getURI({ maxWidth: 640, maxHeight: 420 }),
      author: p.photos[0].authorAttributions?.[0]?.displayName || "a Google Maps user",
      authorUrl: p.photos[0].authorAttributions?.[0]?.uri || p.googleMapsURI || "",
    } : null,
  })).filter((p) => p.lat != null);
}

/* ---------------- matching Google's places to Midway's ---------------- */
const STOP = new Set(["the", "restaurant", "restro", "cafe", "and", "n", "bar", "kitchen", "food", "foods", "pvt", "ltd",
  "hotel", "dining", "family", "pure", "veg", "co", "shop"]);
function words(s) {
  const all = s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const kept = all.filter((w) => !STOP.has(w));
  return kept.length ? kept : all;
}
// 1 = same name. "La Pino'z" vs "La Pino'z Pizza - Navrangpura" counts as the same.
export function nameMatch(a, b) {
  const A = [...new Set(words(a))], B = [...new Set(words(b))];
  if (!A.length || !B.length) return 0;
  const inB = new Set(B);
  let sim = A.filter((w) => inB.has(w)).length / Math.min(A.length, B.length);
  const ca = A.join(""), cb = B.join("");
  if (Math.min(ca.length, cb.length) >= 4 && (ca.includes(cb) || cb.includes(ca))) sim = Math.max(sim, 0.9);
  return Math.min(1, sim);
}

// Pair each venue with at most one Google place: similar name and close by, best pairs first.
export function matchPlaces(venues, gplaces) {
  const pairs = [];
  venues.forEach((v, i) => gplaces.forEach((g, j) => {
    const d = haversine(v, g), sim = nameMatch(v.name, g.name);
    if ((sim >= 0.5 && d <= 200) || (sim >= 0.9 && d <= 500)) pairs.push({ i, j, sim, d });
  }));
  pairs.sort((a, b) => b.sim - a.sim || a.d - b.d);
  const usedV = new Set(), usedG = new Set(), out = new Map();
  for (const p of pairs) {
    if (usedV.has(p.i) || usedG.has(p.j)) continue;
    usedV.add(p.i); usedG.add(p.j);
    out.set(venues[p.i].id, gplaces[p.j]);
  }
  return out;
}

// Look up ratings for a result's venues. Returns true if anything new arrived. Never throws.
export async function loadRatings(result) {
  if (!googleOn || !result?.venues?.length) return false;
  const todo = result.venues.filter((v) => !byVenue.has(v.id));
  if (!todo.length) return false;
  const radius = Math.max(...todo.map((v) => v.fromSpot || 0)) + 150;
  try {
    let found = matchPlaces(todo, await nearby(result.spot, radius, "DISTANCE"));
    if (found.size < Math.ceil(todo.length / 2)) {                // few matches: also ask for the best-known places
      const rest = todo.filter((v) => !found.has(v.id));
      found = new Map([...found, ...matchPlaces(rest, await nearby(result.spot, radius, "POPULARITY"))]);
    }
    todo.forEach((v) => byVenue.set(v.id, found.get(v.id) || null));
    problem = "";
    return found.size > 0;
  } catch (e) {
    problem ||= `Google ratings didn't load: ${e.message || e}`;
    console.warn("[Midway]", problem);
    return false;
  }
}

export const ratingFor = (v) => (v ? byVenue.get(v.id) || null : null);
export const googleProblem = () => problem;

// A rating you can compare fairly: 4.8 from 6 reviews shouldn't beat 4.5 from 3,000.
// Bayesian average: pull each rating towards 4.0 by the weight of 30 imaginary reviews.
export function trustedRating(r) {
  if (!r?.rating) return null;
  const m = 30, prior = 4.0;
  return (r.count * r.rating + m * prior) / (r.count + m);
}

export const shortCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
