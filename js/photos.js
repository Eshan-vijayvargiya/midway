// Photos for the swipe cards.
// OpenStreetMap rarely has a photo of a café or restaurant, so each card gets the best free photo available:
//   1  the place's own photo, when OpenStreetMap links one (a Wikimedia Commons file, or a Wikidata item with an image)
//   2  otherwise a typical dish for that kind of place: the lead photo of the dish's Wikipedia article
// Only free-licensed images (Commons files and Wikipedia's "free" page images), each credited with its author and licence.
// The "Photos on Maps" button on each card opens the real place in Google Maps.
const WP = "https://en.wikipedia.org/w/api.php";
const WD = "https://www.wikidata.org/w/api.php";

// dish key -> Wikipedia article whose lead photo is used
export const DISHES = {
  pizza: "Pizza", burger: "Veggie burger", friedchicken: "Fried chicken", momo: "Momo (food)", noodles: "Chow mein",
  dosa: "Masala dosa", biryani: "Biryani", paratha: "Paratha", punjabi: "Paneer tikka", pavbhaji: "Pav bhaji",
  vadapav: "Vada pav", dabeli: "Dabeli", chaat: "Chaat", dhokla: "Dhokla", thali: "Thali", shawarma: "Shawarma",
  pasta: "Pasta", taco: "Taco", sandwich: "Sandwich", waffle: "Waffle", shake: "Milkshake", juice: "Juice",
  chai: "Masala chai", coffee: "Coffee", icecream: "Ice cream", cake: "Cake", sweets: "Mithai",
};
const LABEL = { momo: "momos", icecream: "ice cream", friedchicken: "fried chicken" };
const VIBE_DISH = { cafe: "coffee", dessert: "icecream", quick: "pavbhaji", restaurant: "thali" };

// Read the place's name and cuisine for a clue. Order matters: "Pizza Café" is pizza, not coffee.
const RULES = [
  [/pizz|pino'?z|domino/, "pizza"],
  [/burger|mc ?donald|wendy'?s/, "burger"],
  [/\bkfc\b|fried chicken/, "friedchicken"],
  [/momo|tibet|nepal/, "momo"],
  [/chinese|hakka|noodle|manchurian|asian|thai|\bwok\b|chow ?mein|szechuan|schezwan/, "noodles"],
  [/south ?indian|dosa|idli|udupi|udipi|madras|sankalp/, "dosa"],
  [/biryani|biriyani|hyderabadi|mughlai/, "biryani"],
  [/parath/, "paratha"],
  [/punjabi|north ?indian|dhaba|tandoor|paneer|amritsari/, "punjabi"],
  [/pav ?bhaji|\bbhaji\b/, "pavbhaji"],
  [/[vw]ada ?pav/, "vadapav"],
  [/dabeli/, "dabeli"],
  [/chaat|pani ?puri|golgappa|\bbhel\b|sev ?puri|street/, "chaat"],
  [/dhokla|khaman|farsan|namkeen/, "dhokla"],
  [/thali|gujarati|kathi[ay]awadi|rajasthani|marwari|dining hall|bhojanal|\bjain\b/, "thali"],
  [/shawarma|kebab|kabab|lebanese|\barab|turkish|mediterranean|falafel/, "shawarma"],
  [/pasta|italian|continental/, "pasta"],
  [/mexican|taco|burrito|nacho/, "taco"],
  [/sandwich|subway/, "sandwich"],
  [/waffle|pancake|crepe/, "waffle"],
  [/shake|smoothie/, "shake"],
  [/juice/, "juice"],
  [/\b(chai|tea|chaay|chah)\b|tea ?post/, "chai"],
  [/coffee|caf[eé]|starbucks|barista|\bccd\b|brew|espresso/, "coffee"],
  [/ice ?cream|gelato|havmor|vadilal|naturals|baskin|kulfi|frozen/, "icecream"],
  [/cake|baker|\bbake|patisserie|pastry|donut|brownie|dessert/, "cake"],
  [/sweet|mithai|mishthan|halwai/, "sweets"],
];

export function dishFor(v) {
  const text = `${v.name || ""} ${(v.cuisine || []).join(" ")}`.toLowerCase().replace(/_/g, " ");
  for (const [re, key] of RULES) if (re.test(text)) return key;
  return VIBE_DISH[v.vibe] || "thali";
}
export const dishLabel = (key) => LABEL[key] || DISHES[key].replace(/ \(.*\)$/, "").toLowerCase();

/* ---------------- cache: in memory, plus a week in this browser ---------------- */
const KEY = "midway.photos.v1", WEEK = 7 * 24 * 3600 * 1000;
const dishPhoto = new Map();       // dish key -> photo | null
const placePhoto = new Map();      // venue id -> photo | null
let busy = 0;                      // lookups in flight
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (saved && Date.now() - saved.at < WEEK) Object.entries(saved.dishes || {}).forEach(([k, p]) => dishPhoto.set(k, p));
} catch { /* private window */ }
function remember() {
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), dishes: Object.fromEntries(dishPhoto) })); } catch { /* ignore */ }
}

// What a card shows right now. undefined = still loading; null = no photo, show the illustration.
export function photoFor(v) {
  const p = placePhoto.get(v.id) || dishPhoto.get(dishFor(v)) || dishPhoto.get(VIBE_DISH[v.vibe] || "thali");
  return p || (busy ? undefined : null);
}

async function api(base, params) {
  const u = new URL(base);
  Object.entries({ format: "json", formatversion: "2", origin: "*", ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(u, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const fileKey = (name) => {
  const n = name.replace(/^(File|Image):/i, "").replace(/_/g, " ").trim();
  return n.charAt(0).toUpperCase() + n.slice(1);
};
const clean = (html) => {
  const d = document.createElement("div");
  d.innerHTML = html || "";
  return d.textContent.replace(/\s+/g, " ").trim();
};

// Thumbnail URL, size and credit for up to 50 files in one request.
async function fileInfo(names) {
  const out = new Map();
  if (!names.length) return out;
  const data = await api(WP, {
    action: "query", prop: "imageinfo", iiprop: "url|size|extmetadata", iiurlwidth: "500",
    iiextmetadatafilter: "Artist|LicenseShortName", titles: names.slice(0, 50).map((n) => `File:${n}`).join("|"),
  });
  for (const p of data.query?.pages || []) {
    const ii = p.imageinfo?.[0];
    if (!ii?.thumburl) continue;
    const md = ii.extmetadata || {};
    const big = ii.width > 960 && /\/500px-/.test(ii.thumburl) ? ii.thumburl.replace("/500px-", "/960px-") : null;
    out.set(fileKey(p.title), {
      src: ii.thumburl, srcset: big ? `${ii.thumburl} 500w, ${big} 960w` : "",
      author: clean(md.Artist?.value).slice(0, 48) || "Wikimedia Commons",
      license: clean(md.LicenseShortName?.value) || "free licence",
      link: ii.descriptionurl,
    });
  }
  return out;
}

// Look up photos for a list of venues. Never throws: a card simply keeps its illustration.
export async function loadPhotos(venues) {
  busy++;
  try {
    // the place's own photo, when OpenStreetMap links one
    const own = new Map();                                   // venue id -> file name
    const qids = new Map();                                  // Q id -> venue ids
    for (const v of venues) {
      if (placePhoto.has(v.id)) continue;
      if (v.photo?.file) own.set(v.id, fileKey(v.photo.file));
      else if (v.photo?.wikidata) qids.set(v.photo.wikidata, [...(qids.get(v.photo.wikidata) || []), v.id]);
    }
    const dishes = [...new Set(venues.flatMap((v) => [dishFor(v), VIBE_DISH[v.vibe] || "thali"]))].filter((k) => !dishPhoto.has(k));

    const [wd, pages] = await Promise.all([
      qids.size ? api(WD, { action: "wbgetentities", props: "claims", ids: [...qids.keys()].slice(0, 50).join("|") }).catch(() => null) : null,
      dishes.length ? api(WP, { action: "query", prop: "pageimages", piprop: "name", pilicense: "free", redirects: "1",
                                titles: dishes.map((k) => DISHES[k]).join("|") }).catch(() => null) : null,
    ]);
    for (const [q, ids] of qids) {
      const file = wd?.entities?.[q]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (file) ids.forEach((id) => own.set(id, fileKey(file)));
    }
    // map each dish's article (after Wikipedia's own renames and redirects) to its lead photo
    const dishFile = new Map();
    if (pages?.query) {
      const hop = new Map([...(pages.query.normalized || []), ...(pages.query.redirects || [])].map((x) => [x.from, x.to]));
      const byTitle = new Map((pages.query.pages || []).map((p) => [p.title, p.pageimage]));
      for (const k of dishes) {
        let t = DISHES[k];
        for (let i = 0; i < 3 && hop.has(t); i++) t = hop.get(t);
        if (byTitle.get(t)) dishFile.set(k, fileKey(byTitle.get(t)));
      }
    }

    const info = await fileInfo([...new Set([...own.values(), ...dishFile.values()])]).catch(() => new Map());
    for (const [id, f] of own) placePhoto.set(id, info.get(f) ? { ...info.get(f), kind: "place" } : null);
    for (const k of dishes) {
      const p = info.get(dishFile.get(k));
      if (pages) dishPhoto.set(k, p ? { ...p, kind: "dish", dish: dishLabel(k) } : null);   // don't cache a failed request
    }
    remember();
  } catch { /* offline or blocked: illustrations stay */ }
  busy--;
}

// Google Maps search for the place, centred on it: real photos and reviews live there.
export const mapsPhotosUrl = (v) => `https://www.google.com/maps/search/${encodeURIComponent(v.name)}/@${v.lat.toFixed(6)},${v.lon.toFixed(6)},18z`;
