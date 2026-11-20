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
  places: ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"],
  tiles: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
};

export const MAX_FRIENDS = 8;
