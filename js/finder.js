// The search: coarse grid -> finer grid -> places to eat -> time every trip -> rank.
import { candidateGrid, centroid, gridAround, haversine, rankSpots, summarise, estCost, vibeOf, isVegFriendly } from "./fair.js?v=9";
import { travelMatrix, placesNear, reverseGeocode } from "./services.js?v=9";

export const STEPS = [
  "Testing 49 possible meeting points",
  "Sharpening the best area",
  "Finding places to eat around it",
  "Timing every trip to every place",
];

export async function findFairSpot(friends, filters, onStep = () => {}, signal) {
  let estimated = false;
  const mid = centroid(friends);

  // 1 · coarse grid over the whole squad, plus the plain midpoint for comparison
  const coarse = candidateGrid(friends, 7);
  onStep(0, { grid: coarse });
  const m1 = await travelMatrix(friends, [...coarse, mid], signal);
  estimated ||= m1.estimated;
  const midTimes = m1.matrix.map((row) => row[coarse.length]);
  const rankedCoarse = rankSpots(coarse, m1.matrix.map((row) => row.slice(0, coarse.length)));
  if (!rankedCoarse.length) throw new Error("NO_ROUTES");

  // 2 · finer grid around the best coarse point (half a cell either side)
  const cell = haversine(coarse[0], coarse[1]) || 800;
  const fine = gridAround(rankedCoarse[0], Math.max(cell * 0.6, 400), 5);
  onStep(1, { grid: fine });
  const m2 = await travelMatrix(friends, fine, signal);
  estimated ||= m2.estimated;
  const rankedFine = rankSpots(fine, m2.matrix);
  const spot = (rankedFine[0] && rankedFine[0].cost <= rankedCoarse[0].cost) ? rankedFine[0] : rankedCoarse[0];

  // 3 · places to eat near the spot, widening the circle if the area is quiet
  onStep(2);
  // 1.5 km is plenty in a busy area; only a quiet area needs a second, wider request.
  // If every places server is down, the fair spot is still shown, just without restaurants.
  let places = [], placesDown = false, placesWhy = "";
  try {
    places = await placesNear(spot, 1500, signal);
    if (filterPlaces(places, filters, spot).length < 8) places = await placesNear(spot, 4500, signal);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    placesDown = true;
    placesWhy = e.message;
  }
  let picked = filterPlaces(places, filters, spot);
  let relaxed = false;
  if (picked.length < 4 && places.length) {           // filters too strict here: keep their order, relax them
    picked = filterPlaces(places, { ...filters, vibes: [], budget: 0 }, spot);
    relaxed = true;
  }
  picked = picked.slice(0, 45);

  // 4 · time every friend to every place, rank by fairness
  onStep(3);
  let venues = [];
  if (picked.length) {
    const m3 = await travelMatrix(friends, picked, signal);
    estimated ||= m3.estimated;
    venues = rankSpots(picked, m3.matrix).map((v) => ({
      id: v.id.replace("/", "_"), osm: v.id, name: v.name, lat: v.lat, lon: v.lon,
      vibe: vibeOf(v.tags), cost: estCost(v.tags), veg: isVegFriendly(v.tags),
      cuisine: (v.tags.cuisine || "").split(";").filter(Boolean).slice(0, 2).map((c) => c.replace(/_/g, " ")),
      times: v.times.map((t) => Math.round(t)), balance: v.balance, max: Math.round(v.max),
      fromSpot: Math.round(haversine(v, spot)),
      ...photoTags(v.tags),
    }));
    if (filters.veg) venues.sort((a, b) => Number(b.veg) - Number(a.veg));   // stable: fairness order inside each group
    venues = venues.slice(0, 12);
  }

  // 5 · how far friends are from each other, for "ride together" tips
  // (kept as a list of objects: Firestore can't store an array inside an array)
  const mb = await travelMatrix(friends, friends, signal);
  const between = mb.matrix.map((row) => ({ t: row.map((x) => (x == null ? null : Math.round(x))) }));

  const where = await reverseGeocode(spot, signal);
  return {
    spot: { lat: spot.lat, lon: spot.lon, name: where.name, area: where.area, times: spot.times.map((t) => Math.round(t)),
            ...pick(summarise(spot.times), ["max", "min", "mean", "balance"]) },
    midpoint: { lat: mid.lat, lon: mid.lon, times: midTimes.map((t) => (t == null ? null : Math.round(t))) },
    venues, between, estimated, relaxed, placesDown, placesWhy, foundAt: Date.now(),
  };
}

// A photo of the place itself, when OpenStreetMap links one (photos.js turns it into a picture and a credit)
function photoTags(tags = {}) {
  const c = tags.wikimedia_commons || "";
  const fromUrl = (tags.image || "").match(/commons\.wikimedia\.org\/wiki\/(File:[^?#]+)/i);
  const file = /^File:/i.test(c) ? c : fromUrl ? decodeURIComponent(fromUrl[1]) : null;
  const wikidata = /^Q\d+$/.test(tags.wikidata || "") ? tags.wikidata : null;
  return file ? { photo: { file } } : wikidata ? { photo: { wikidata } } : {};
}

function pick(o, keys) {
  return Object.fromEntries(keys.map((k) => [k, typeof o[k] === "number" ? Math.round(o[k]) : o[k]]));
}

function filterPlaces(places, filters, spot) {
  return places
    .filter((p) => !filters.vibes?.length || filters.vibes.includes(vibeOf(p.tags)))
    .filter((p) => !filters.budget || estCost(p.tags) <= filters.budget)          // budget = rupees per head
    .sort((a, b) => haversine(a, spot) - haversine(b, spot));
}
