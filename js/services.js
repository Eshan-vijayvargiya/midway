// Talking to the outside world: place search, travel times and places to eat.
// Every call has a fallback, so a slow or busy free server never leaves the app stuck.
import { SERVICES } from "./config.js?v=7";
import { haversine } from "./fair.js?v=7";

// signal = the person's Stop button; timeoutMs = give up on one slow server and try the next
async function getJSON(url, opts = {}, timeoutMs = 15000, signal) {
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const stop = () => ctrl.abort();
  signal?.addEventListener("abort", stop);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    throw e;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", stop);
  }
}
const stopped = (e) => e?.name === "AbortError";

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

export async function reverseGeocode(pt, signal) {
  try {
    const data = await getJSON(`${SERVICES.search}/reverse?lat=${pt.lat}&lon=${pt.lon}&lang=en`, {}, 8000, signal);
    const f = (data.features || [])[0];
    return f ? placeLabel(f) : { name: "My location", area: "" };
  } catch (e) {
    if (stopped(e)) throw e;
    return { name: "My location", area: "" };
  }
}

// Minutes from each origin to each destination. mode: "car" (bike/auto/cab, by road) or "foot".
// Returns { matrix, source } where source says whether real routing or an estimate was used.
async function osrmTable(bases, origins, dests, signal) {
  const coords = [...origins, ...dests].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const src = origins.map((_, i) => i).join(";");
  const dst = dests.map((_, j) => origins.length + j).join(";");
  let lastErr;
  for (const base of bases) {
    try {
      const data = await getJSON(`${base}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration`, {}, 15000, signal);
      if (data.code !== "Ok") throw new Error(data.code);
      return data.durations.map((row) => row.map((s) => (s == null ? null : s / 60)));
    } catch (e) {
      if (stopped(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("routing failed");
}

function estimateTable(origins, dests, mode) {
  const kmh = mode === "foot" ? 4.8 : 22;                // city average, traffic included
  return origins.map((o) => dests.map((d) => ((haversine(o, d) * 1.35) / 1000 / kmh) * 60));
}

export async function travelMatrix(friends, dests, signal) {
  const rows = new Array(friends.length);
  let estimated = false;
  for (const mode of ["car", "foot"]) {
    const idx = friends.map((f, i) => ((f.mode || "car") === mode ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const origins = idx.map((i) => friends[i]);
    let part;
    try {
      part = await osrmTable(SERVICES.routing[mode], origins, dests, signal);
    } catch (e) {
      if (stopped(e)) throw e;
      part = estimateTable(origins, dests, mode);
      estimated = true;
    }
    idx.forEach((i, k) => { rows[i] = part[k]; });
  }
  return { matrix: rows, estimated };
}

// Named places to eat within radiusM metres of a point. Three free sources, best first:
//   1 Overpass (richest data: cuisine, veg tags)   2 Photon (fast, already used for search)   3 Nominatim
// Each returns the same shape: { id, name, lat, lon, tags }.
export async function placesNear(pt, radiusM, signal) {
  const why = [];
  for (const source of [overpassPlaces, photonPlaces, nominatimPlaces]) {
    try {
      const found = (await source(pt, radiusM, signal, why)).filter((p) => p.name && p.lat != null && haversine(p, pt) <= radiusM * 1.15);
      if (found.length) return found;
      why.push(`${source.label}: nothing found`);
    } catch (e) {
      if (stopped(e)) throw e;
      why.push(`${source.label}: ${e.message}`);
    }
  }
  throw new Error(`PLACES_DOWN (${why.join("; ")})`);
}

const AMENITIES = ["restaurant", "cafe", "fast_food", "ice_cream", "food_court"];

// 1 · Overpass. Public servers are often busy, so two are asked at once and the first good answer wins.
async function overpassPlaces(pt, radiusM, signal, whyOut) {
  const q = `[out:json][timeout:15];
nwr(around:${Math.round(radiusM)},${pt.lat.toFixed(5)},${pt.lon.toFixed(5)})["amenity"~"^(restaurant|cafe|fast_food|ice_cream|food_court)$"]["name"];
out center tags 400;`;
  const why = [];                                            // what each server said, for the on-screen note
  const ask = async (base) => {
    try {
      const data = await getJSON(base, { method: "POST", body: new URLSearchParams({ data: q }) }, 12000, signal);
      if (!Array.isArray(data.elements)) throw new Error(data.remark || "bad answer");
      return data.elements;
    } catch (e) {
      why.push(`${new URL(base).hostname}: ${e.name === "TypeError" ? "blocked or offline" : e.message}`);
      throw e;
    }
  };
  let elements = null;
  for (let i = 0; i < SERVICES.places.length && !elements; i += 2) {
    try {
      elements = await Promise.any(SERVICES.places.slice(i, i + 2).map(ask));
    } catch {
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    }
  }
  if (!elements) { whyOut.push(...why); throw new Error("no server answered"); }
  return elements.map((e) => ({
    id: `${e.type}/${e.id}`,
    name: e.tags.name,
    lat: e.lat ?? e.center?.lat,
    lon: e.lon ?? e.center?.lon,
    tags: e.tags,
  })).filter((p) => p.lat != null);
}
overpassPlaces.label = "Overpass";

// 2 · Photon reverse search, one request per kind of place, nearest first.
async function photonPlaces(pt, radiusM, signal) {
  const kinds = ["restaurant", "cafe", "fast_food", "ice_cream"];
  const lists = await Promise.all(kinds.map(async (k) => {
    const u = `${SERVICES.search}/reverse?lat=${pt.lat.toFixed(5)}&lon=${pt.lon.toFixed(5)}&limit=40&radius=${(radiusM / 1000).toFixed(1)}&osm_tag=amenity:${k}&lang=en`;
    try {
      const data = await getJSON(u, {}, 10000, signal);
      return (data.features || []).filter((f) => f.properties?.osm_key === "amenity" && AMENITIES.includes(f.properties?.osm_value));
    } catch (e) {
      if (stopped(e)) throw e;
      return [];
    }
  }));
  const seen = new Set();
  return lists.flat().map((f) => {
    const pr = f.properties;
    return { id: `${pr.osm_type === "W" ? "way" : pr.osm_type === "R" ? "relation" : "node"}/${pr.osm_id}`, name: pr.name,
             lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], tags: { amenity: pr.osm_value, name: pr.name } };
  }).filter((p) => p.name && !seen.has(p.id) && seen.add(p.id));
}
photonPlaces.label = "Photon";

// 3 · Nominatim, searching each kind of place inside a box around the spot (one request a second, as its rules ask).
async function nominatimPlaces(pt, radiusM, signal) {
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos((pt.lat * Math.PI) / 180));
  const box = [pt.lon - dLon, pt.lat + dLat, pt.lon + dLon, pt.lat - dLat].map((x) => x.toFixed(5)).join(",");
  const out = [], seen = new Set();
  for (const k of ["restaurant", "cafe", "fast food", "ice cream"]) {
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(k)}&viewbox=${box}&bounded=1&limit=40&extratags=1&accept-language=en`;
    try {
      const rows = await getJSON(u, {}, 10000, signal);
      for (const r of rows) {
        if (r.category !== "amenity" || !AMENITIES.includes(r.type)) continue;
        const id = `${r.osm_type}/${r.osm_id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: r.name || r.display_name.split(",")[0], lat: Number(r.lat), lon: Number(r.lon),
                   tags: { amenity: r.type, name: r.name, ...(r.extratags || {}) } });
      }
    } catch (e) {
      if (stopped(e)) throw e;
    }
    await new Promise((res) => setTimeout(res, 1100));
  }
  return out;
}
nominatimPlaces.label = "Nominatim";

// The road route from one friend to the spot, as [lat, lon] points for the map (null if no server answers).
export async function routeLine(from, to, mode = "car", signal) {
  const coords = `${from.lon.toFixed(5)},${from.lat.toFixed(5)};${to.lon.toFixed(5)},${to.lat.toFixed(5)}`;
  for (const base of SERVICES.routing[mode === "foot" ? "foot" : "car"]) {
    try {
      const d = await getJSON(`${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`, {}, 12000, signal);
      const r = d.code === "Ok" && d.routes?.[0];
      if (r) return { line: r.geometry.coordinates.map(([lo, la]) => [la, lo]), minutes: r.duration / 60, km: r.distance / 1000 };
    } catch (e) {
      if (stopped(e)) throw e;
    }
  }
  return null;
}
