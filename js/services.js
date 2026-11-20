// Talking to the outside world: place search, travel times and places to eat.
// Every call has a fallback, so a slow or busy free server never leaves the app stuck.
import { SERVICES } from "./config.js";
import { haversine } from "./fair.js";

async function getJSON(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function placeLabel(p) {
  const pr = p.properties || {};
  const main = pr.name || [pr.street, pr.housenumber].filter(Boolean).join(" ") || pr.city || "Pinned spot";
  const area = [pr.district || pr.locality, pr.city, pr.state].filter((x) => x && x !== main);
  return { name: main, area: [...new Set(area)].slice(0, 2).join(", ") };
}

// Search as you type. "near" biases results to the squad's city.
export async function searchPlaces(q, near) {
  const u = new URL(`${SERVICES.search}/api/`);
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "6");
  u.searchParams.set("lang", "en");
  if (near) { u.searchParams.set("lat", near.lat.toFixed(4)); u.searchParams.set("lon", near.lon.toFixed(4)); }
  const data = await getJSON(u, {}, 8000);
  return (data.features || []).map((f) => ({
    ...placeLabel(f), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
  }));
}

export async function reverseGeocode(pt) {
  try {
    const data = await getJSON(`${SERVICES.search}/reverse?lat=${pt.lat}&lon=${pt.lon}&lang=en`, {}, 8000);
    const f = (data.features || [])[0];
    return f ? placeLabel(f) : { name: "My location", area: "" };
  } catch {
    return { name: "My location", area: "" };
  }
}

// Minutes from each origin to each destination. mode: "car" (bike/auto/cab, by road) or "foot".
// Returns { matrix, source } where source says whether real routing or an estimate was used.
async function osrmTable(bases, origins, dests) {
  const coords = [...origins, ...dests].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const src = origins.map((_, i) => i).join(";");
  const dst = dests.map((_, j) => origins.length + j).join(";");
  let lastErr;
  for (const base of bases) {
    try {
      const data = await getJSON(`${base}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration`, {}, 20000);
      if (data.code !== "Ok") throw new Error(data.code);
      return data.durations.map((row) => row.map((s) => (s == null ? null : s / 60)));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("routing failed");
}

function estimateTable(origins, dests, mode) {
  const kmh = mode === "foot" ? 4.8 : 22;                // city average, traffic included
  return origins.map((o) => dests.map((d) => ((haversine(o, d) * 1.35) / 1000 / kmh) * 60));
}

export async function travelMatrix(friends, dests) {
  const rows = new Array(friends.length);
  let estimated = false;
  for (const mode of ["car", "foot"]) {
    const idx = friends.map((f, i) => ((f.mode || "car") === mode ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const origins = idx.map((i) => friends[i]);
    let part;
    try {
      part = await osrmTable(SERVICES.routing[mode], origins, dests);
    } catch {
      part = estimateTable(origins, dests, mode);
      estimated = true;
    }
    idx.forEach((i, k) => { rows[i] = part[k]; });
  }
  return { matrix: rows, estimated };
}

// Named places to eat within radiusM metres of a point (OpenStreetMap via Overpass).
export async function placesNear(pt, radiusM) {
  const q = `[out:json][timeout:20];
nwr(around:${Math.round(radiusM)},${pt.lat.toFixed(5)},${pt.lon.toFixed(5)})["amenity"~"^(restaurant|cafe|fast_food|ice_cream|food_court)$"]["name"];
out center tags 120;`;
  let lastErr;
  for (const base of SERVICES.places) {
    try {
      const data = await getJSON(base, { method: "POST", body: new URLSearchParams({ data: q }) }, 25000);
      return (data.elements || []).map((e) => ({
        id: `${e.type}/${e.id}`,
        name: e.tags.name,
        lat: e.lat ?? e.center?.lat,
        lon: e.lon ?? e.center?.lon,
        tags: e.tags,
      })).filter((p) => p.lat != null);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("places failed");
}
