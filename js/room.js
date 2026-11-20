// Squads: live rooms (Firebase) when configured, otherwise a squad link that carries the friends list.
import { FIREBASE_CONFIG } from "./config.js?v=9";

export const liveRooms = Boolean(FIREBASE_CONFIG);
const FB = "https://www.gstatic.com/firebasejs/10.12.2";
let db, fs;

async function init() {
  if (db) return;
  const app = await import(`${FB}/firebase-app.js`);
  fs = await import(`${FB}/firebase-firestore.js`);
  db = fs.getFirestore(app.initializeApp(FIREBASE_CONFIG));
}

export function newCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";                   // no 0/O or 1/I mix-ups
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => abc[b % abc.length]).join("");
}

// Spots are rounded to about 100 m before they are shared, so nobody posts their exact door.
export function shareable(friend) {
  const r = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  return { id: friend.id, name: friend.name || "", emoji: friend.emoji, color: friend.color, mode: friend.mode || "car",
           place: friend.place || "", lat: r(friend.lat), lon: r(friend.lon), upi: friend.upi || "" };
}

export async function createRoom(code, friends, filters) {
  await init();
  await fs.setDoc(fs.doc(db, "rooms", code), {
    created: fs.serverTimestamp(),
    expires: new Date(Date.now() + 7 * 24 * 3600 * 1000),   // a Firestore TTL policy can delete rooms after a week
    friends: Object.fromEntries(friends.map((f) => [f.id, shareable(f)])),
    filters, result: null, votes: {}, pick: null,
  });
}

export async function watchRoom(code, onData) {
  await init();
  return fs.onSnapshot(fs.doc(db, "rooms", code), (snap) => onData(snap.exists() ? snap.data() : null));
}

export async function saveFriend(code, friend) {
  await init();
  await fs.updateDoc(fs.doc(db, "rooms", code), { [`friends.${friend.id}`]: shareable(friend) });
}

export async function dropFriend(code, id) {
  await init();
  await fs.updateDoc(fs.doc(db, "rooms", code), { [`friends.${id}`]: fs.deleteField() });
}

export async function saveFilters(code, filters) {
  await init();
  await fs.updateDoc(fs.doc(db, "rooms", code), { filters });
}

export async function saveResult(code, result) {
  await init();
  await fs.updateDoc(fs.doc(db, "rooms", code), { result, votes: {}, pick: null });
}

// the place the squad locked in (a venue id, or null to choose again)
export async function savePick(code, pick) {
  await init();
  await fs.updateDoc(fs.doc(db, "rooms", code), { pick });
}

export async function saveExpenses(code, expenses) {
  await init();
  await fs.updateDoc(fs.doc(db, "rooms", code), { expenses });
}

export async function saveVote(code, venueId, friendId, value) {
  await init();
  await fs.updateDoc(fs.doc(db, "rooms", code), { [`votes.${venueId}.${friendId}`]: value });
}

// ---- squad link (no Firebase): the friends list travels inside the link ----
export function encodeSquad(friends) {
  const data = friends.filter((f) => f.lat != null).map((f) => {
    const s = shareable(f);
    return [s.name, s.emoji, s.color, s.lat, s.lon, s.place, s.mode === "foot" ? 1 : 0];
  });
  const json = JSON.stringify(data);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSquad(s) {
  try {
    const json = decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
    return JSON.parse(json).map(([name, emoji, color, lat, lon, place, foot], i) => ({
      id: `f${Date.now().toString(36)}${i}`, name, emoji, color, lat, lon, place, mode: foot ? "foot" : "car",
    }));
  } catch {
    return null;
  }
}
