// Midway settings.
//
// Live squad rooms (everyone adds their own spot from their own phone, votes sync live) need a free
// Firebase project. Paste the config object Firebase gives you here (see README, "Turn on live rooms").
// Leave it as null and the app still works: one person can add everyone, or share a squad link.
export const FIREBASE_CONFIG = null;

// Free, keyless services built on OpenStreetMap. Each one has a fair-use policy: light use only.
export const SERVICES = {
  search: "https://photon.komoot.io",                          // place search as you type
  routing: {                                                   // travel times (OSRM "table" service)
    car: ["https://routing.openstreetmap.de/routed-car", "https://router.project-osrm.org"],
    foot: ["https://routing.openstreetmap.de/routed-foot"],
  },
  places: [                                                   // asked two at a time; the first good answer wins
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ],
  tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",    // light OSM tiles, turned dark with a CSS filter
};

// Restaurant ratings and real photos from Google (optional). OpenStreetMap has no ratings.
// Paste a Google Maps API key here (see README, "Turn on Google ratings"). It is meant to be public:
// what protects it is the website restriction and the daily cap you set in Google Cloud.
// Leave it as null and Midway works without ratings.
export const GOOGLE_MAPS_KEY = null;

export const MAX_FRIENDS = 8;
