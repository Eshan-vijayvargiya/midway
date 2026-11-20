// The maths behind "fair": pure functions, no network, so they are easy to test.

const R = 6371000; // Earth radius in metres

export function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function centroid(points) {
  const n = points.length;
  return { lat: points.reduce((s, p) => s + p.lat, 0) / n, lon: points.reduce((s, p) => s + p.lon, 0) / n };
}

// Geometric median (Weiszfeld): the point with the smallest total straight-line distance to everyone.
export function geometricMedian(points, iterations = 60) {
  let m = centroid(points);
  for (let k = 0; k < iterations; k++) {
    let wSum = 0, lat = 0, lon = 0;
    for (const p of points) {
      const d = Math.max(haversine(m, p), 1);
      wSum += 1 / d; lat += p.lat / d; lon += p.lon / d;
    }
    m = { lat: lat / wSum, lon: lon / wSum };
  }
  return m;
}

// An n x n grid of candidate meeting points covering a box around everyone (padded a little).
export function candidateGrid(points, n = 7, pad = 0.12) {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  let [s, nn, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const padLat = Math.max((nn - s) * pad, 0.004), padLon = Math.max((e - w) * pad, 0.004);
  s -= padLat; nn += padLat; w -= padLon; e += padLon;
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
    out.push({ lat: s + ((nn - s) * i) / (n - 1), lon: w + ((e - w) * j) / (n - 1) });
  return out;
}

// A finer grid around one point (used to sharpen the best coarse cell).
export function gridAround(center, halfSizeM, n = 5) {
  const dLat = halfSizeM / 111320, dLon = halfSizeM / (111320 * Math.cos((center.lat * Math.PI) / 180));
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
    out.push({ lat: center.lat - dLat + (2 * dLat * i) / (n - 1), lon: center.lon - dLon + (2 * dLon * j) / (n - 1) });
  return out;
}

// times = minutes for each friend to reach one spot. Fair = the longest trip is as short as possible;
// the average breaks ties so we don't pick a spot that is equally far for everyone.
export function cost(times) {
  const max = Math.max(...times), mean = times.reduce((a, b) => a + b, 0) / times.length;
  return max + 0.25 * mean;
}

// 100 = everyone travels exactly the same time. 50 = the average trip is half the longest one.
export function balance(times) {
  const max = Math.max(...times), mean = times.reduce((a, b) => a + b, 0) / times.length;
  return max <= 0 ? 100 : Math.round((100 * mean) / max);
}

export function summarise(times) {
  const max = Math.max(...times), min = Math.min(...times);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { max, min, mean, gap: max - min, balance: balance(times), cost: cost(times) };
}

// matrix[i][j] = minutes from friend i to spot j (null = no route). Returns spots ranked fairest first.
export function rankSpots(spots, matrix) {
  const ranked = [];
  spots.forEach((spot, j) => {
    const times = matrix.map((row) => row[j]);
    if (times.some((t) => t == null || !isFinite(t))) return;
    ranked.push({ ...spot, times, ...summarise(times) });
  });
  return ranked.sort((a, b) => a.cost - b.cost);
}

// Rough cost per head in rupees from the kind of place. OpenStreetMap rarely has prices, so this is
// shown as an estimate: quick bites ~₹200, cafés ~₹350, restaurants ~₹500, bars and fine dining ~₹1,100.
export function estCost(tags = {}) {
  const a = tags.amenity, c = (tags.cuisine || "").toLowerCase();
  if (["bar", "pub", "biergarten"].includes(a) || /fine_dining|steak|sushi|seafood|italian|continental/.test(c)) return 1100;
  if (["fast_food", "food_court", "ice_cream"].includes(a) || /street|chaat|snack|tea|juice|sandwich|burger|pizza/.test(c)) return 200;
  if (a === "cafe") return 350;
  return 500;
}

export function vibeOf(tags = {}) {
  const a = tags.amenity, c = (tags.cuisine || "").toLowerCase();
  if (a === "cafe" || /coffee|tea/.test(c)) return "cafe";
  if (a === "ice_cream" || /dessert|ice_cream|cake|bakery|sweets/.test(c)) return "dessert";
  if (a === "fast_food" || a === "food_court" || /burger|pizza|street|chaat|sandwich|snack/.test(c)) return "quick";
  return "restaurant";
}

export function isVegFriendly(tags = {}) {
  const v = (tags["diet:vegetarian"] || "").toLowerCase(), c = (tags.cuisine || "").toLowerCase();
  return v === "yes" || v === "only" || /vegetarian|vegan|gujarati|south_indian|jain/.test(c);
}

// Who can ride together. Friend d picks up friend r on the way when:
//   the extra time for d (d to r, then r to the place, minus d's own ride) is small, and r isn't far off.
// toDest[i] = minutes from friend i to the place; between[i][j] = minutes from friend i to friend j.
// Walkers who live close can walk over together. Each friend appears in at most one pair, best pairs first.
export function rideTogether(friends, toDest, between) {
  if (!between) return [];
  const cands = [];
  friends.forEach((d, i) => friends.forEach((r, j) => {
    if (i === j || d.lat == null || r.lat == null) return;
    const t = between[i]?.[j], td = toDest[i], tr = toDest[j];
    if (t == null || td == null || tr == null) return;
    const footD = d.mode === "foot", footR = r.mode === "foot";
    if (footD !== footR) return;                           // a walker and a rider: no shared trip
    const extra = Math.max(0, Math.round(t + tr - td));
    const ok = footD ? t <= 10 && extra <= 8 : t <= 15 && extra <= Math.max(6, 0.35 * td);
    if (ok) cands.push({ driver: i, rider: j, pickup: Math.round(t), extra, walk: footD });
  }));
  cands.sort((a, b) => a.extra - b.extra || a.pickup - b.pickup);
  const used = new Set(), out = [];
  for (const c of cands) {
    if (used.has(c.driver) || used.has(c.rider)) continue;
    used.add(c.driver); used.add(c.rider);
    out.push(c);
  }
  return out;
}
