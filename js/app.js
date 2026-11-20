// Midway: the screen logic. State lives here; fair.js does the maths, finder.js runs the search.
import { MAX_FRIENDS, SERVICES } from "./config.js";
import { findFairSpot, STEPS } from "./finder.js";
import { searchPlaces, reverseGeocode } from "./services.js";
import { makeDeck } from "./swipe.js";
import { DEMO_FRIENDS } from "./demo.js";
import * as room from "./room.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const COLORS = ["#c8ff3d", "#ff4fb8", "#45d4ff", "#ff9a3d", "#a68bff", "#4dffb4", "#ffe24d", "#ff6b6b"];
const STICKERS = ["🦊", "🐸", "🐼", "🦄", "🐙", "🐯", "🐧", "🦖", "🐨", "🦋", "🐵", "🐳"];
const VIBE_EMOJI = { cafe: "☕", quick: "🍔", restaurant: "🍽️", dessert: "🍨" };
const VIBE_NAME = { cafe: "Café", quick: "Quick bites", restaurant: "Sit-down", dessert: "Dessert" };

const state = {
  mode: "local",            // "local" (this device) or "live" (Firebase room)
  code: null,               // live room code
  me: null,                 // this device's friend id in a live room
  friends: [],
  filters: { vibes: [], veg: false, budget: 0 },
  result: null,
  votes: {},                // venueId -> { friendId: 1 | -1 }
  stale: false,
  pinFor: null,             // friend whose spot is being dropped on the map
};
const LOCAL_VOTER = "you";

/* ---------------- storage (a convenience only; the app works without it) ---------------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};
function saveLocal() {
  if (state.mode === "local") store.set("midway.local", { friends: state.friends, filters: state.filters });
}

/* ---------------- friends ---------------- */
function newFriend(extra = {}) {
  const usedC = new Set(state.friends.map((f) => f.color)), usedE = new Set(state.friends.map((f) => f.emoji));
  return {
    id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: "", place: "", lat: null, lon: null, mode: "car",
    color: COLORS.find((c) => !usedC.has(c)) || COLORS[state.friends.length % COLORS.length],
    emoji: STICKERS.find((e) => !usedE.has(e)) || "🙂",
    ...extra,
  };
}
const located = () => state.friends.filter((f) => f.lat != null && f.lon != null);
const friendById = (id) => state.friends.find((f) => f.id === id);
const displayName = (f, i) => f.name?.trim() || `Friend ${i + 1}`;

function persistFriend(f) {
  if (state.mode === "live") room.saveFriend(state.code, f).catch(() => toast("Couldn't save to the room. Check your connection."));
  else saveLocal();
  markStale();
}

function markStale() {
  if (state.result) { state.stale = true; }
  updateFindButton();
  drawMap();
}

/* ---------------- friend list UI ---------------- */
const listEl = $("#friendList");

function renderFriends() {
  listEl.innerHTML = "";
  state.friends.forEach((f, i) => listEl.appendChild(friendCard(f, i)));
  $("#addFriendBtn").hidden = state.friends.length >= MAX_FRIENDS;
  updateFindButton();
}

function friendCard(f, i) {
  const li = document.createElement("li");
  li.className = "friend" + (f.id === state.me ? " is-me" : "");
  li.style.setProperty("--friend", f.color);
  li.dataset.id = f.id;
  const label = displayName(f, i);
  li.innerHTML = `
    <button class="avatar" type="button" title="Change sticker" aria-label="Change ${esc(label)}'s sticker">${esc(f.emoji)}</button>
    <input class="fname" value="${esc(f.name)}" placeholder="${f.id === state.me ? "Your name" : "Name"}" maxlength="24" aria-label="Name">
    <button class="remove" type="button" aria-label="Remove ${esc(label)}">✕</button>
    <div class="where">
      <input class="place ${f.lat != null ? "is-set" : ""}" value="${esc(f.place)}" placeholder="Coming from… (area, college, metro)"
             autocomplete="off" role="combobox" aria-expanded="false" aria-label="Where ${esc(label)} is coming from">
      <button class="icon-btn gps" type="button" title="Use my current location" aria-label="Use my current location">📍</button>
      <ul class="suggest" role="listbox" hidden></ul>
    </div>
    <div class="mode" role="group" aria-label="How ${esc(label)} travels">
      <button type="button" data-mode="car" aria-pressed="${f.mode !== "foot"}">🛵 Bike, auto or cab</button>
      <button type="button" data-mode="foot" aria-pressed="${f.mode === "foot"}">🚶 Walking</button>
    </div>`;

  $(".avatar", li).addEventListener("click", () => {
    f.emoji = STICKERS[(STICKERS.indexOf(f.emoji) + 1) % STICKERS.length];
    $(".avatar", li).textContent = f.emoji;
    persistFriend(f);
  });
  $(".fname", li).addEventListener("change", (e) => { f.name = e.target.value.trim(); persistFriend(f); renderResultsIfAny(); });
  $(".remove", li).addEventListener("click", () => removeFriend(f));
  $$(".mode button", li).forEach((b) => b.addEventListener("click", () => {
    f.mode = b.dataset.mode;
    $$(".mode button", li).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    persistFriend(f);
  }));
  $(".gps", li).addEventListener("click", () => useMyLocation(f, li));
  wireSearch(f, li);
  return li;
}

function removeFriend(f) {
  state.friends = state.friends.filter((x) => x.id !== f.id);
  if (state.mode === "live") room.dropFriend(state.code, f.id).catch(() => {});
  saveLocal();
  renderFriends();
  markStale();
}

function wireSearch(f, li) {
  const input = $(".place", li), list = $(".suggest", li);
  let timer, seq = 0, items = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const choose = (p) => {
    f.place = p.area ? `${p.name}, ${p.area.split(",")[0]}` : p.name;
    f.lat = p.lat; f.lon = p.lon;
    input.value = f.place; input.classList.add("is-set");
    close();
    persistFriend(f);
    flyTo(f);
  };
  const show = () => {
    list.innerHTML = items.map((p, k) => `<li role="option" aria-selected="${k === active}" data-k="${k}">${esc(p.name)}<small>${esc(p.area)}</small></li>`).join("")
      || `<li aria-disabled="true"><small>No match. Try an area, college or metro station.</small></li>`;
    list.innerHTML += `<li data-pin="1">📌 Drop a pin on the map instead</li>`;
    list.hidden = false; input.setAttribute("aria-expanded", "true");
  };
  input.addEventListener("input", () => {
    input.classList.remove("is-set");
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      const near = located().find((x) => x.id !== f.id) || (f.lat != null ? f : null);
      try {
        const res = await searchPlaces(q, near);
        if (mine !== seq) return;
        items = res; active = -1; show();
      } catch {
        if (mine === seq) { items = []; list.innerHTML = `<li aria-disabled="true"><small>Search is busy right now.</small></li><li data-pin="1">📌 Drop a pin on the map instead</li>`; list.hidden = false; }
      }
    }, 320);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      show();
    } else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === "Escape") close();
  });
  list.addEventListener("pointerdown", (e) => {
    if (e.target.closest("li[data-pin]")) { e.preventDefault(); close(); return startPin(f); }
    const li2 = e.target.closest("li[data-k]");
    if (li2) { e.preventDefault(); choose(items[Number(li2.dataset.k)]); }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

function useMyLocation(f, li) {
  if (!navigator.geolocation) return toast("This browser can't share location. Type the area instead.");
  const btn = $(".gps", li);
  btn.textContent = "…";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const pt = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const where = await reverseGeocode(pt);
    Object.assign(f, pt, { place: where.area ? `${where.name}, ${where.area.split(",")[0]}` : where.name });
    btn.textContent = "📍";
    renderFriends();
    persistFriend(f);
    flyTo(f);
  }, () => { btn.textContent = "📍"; toast("Location is blocked. Type the area instead."); }, { enableHighAccuracy: false, timeout: 10000 });
}

function updateFindButton() {
  const n = located().length;
  const btn = $("#findBtn");
  btn.disabled = n < 2;
  btn.textContent = state.result && state.stale ? "Find again with the new spots" : "Find our fair spot";
  $("#squadHint").textContent = n < 2 ? `Add at least 2 spots (${n} so far)` : `${n} spots added`;
}

/* ---------------- filters ---------------- */
function wireFilters() {
  $$(".chip[data-vibe]").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.vibe, on = !state.filters.vibes.includes(v);
    state.filters.vibes = on ? [...state.filters.vibes, v] : state.filters.vibes.filter((x) => x !== v);
    b.setAttribute("aria-pressed", String(on));
    filtersChanged();
  }));
  $("#vegToggle").addEventListener("click", (e) => {
    state.filters.veg = !state.filters.veg;
    e.currentTarget.setAttribute("aria-pressed", String(state.filters.veg));
    filtersChanged();
  });
  $$(".seg button").forEach((b) => b.addEventListener("click", () => {
    state.filters.budget = Number(b.dataset.budget);
    $$(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    filtersChanged();
  }));
}
function paintFilters() {
  $$(".chip[data-vibe]").forEach((b) => b.setAttribute("aria-pressed", String(state.filters.vibes.includes(b.dataset.vibe))));
  $("#vegToggle").setAttribute("aria-pressed", String(state.filters.veg));
  $$(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.budget) === state.filters.budget)));
}
function filtersChanged() {
  if (state.mode === "live") room.saveFilters(state.code, state.filters).catch(() => {});
  saveLocal();
  if (state.result) { state.stale = true; updateFindButton(); }
}

/* ---------------- map ---------------- */
let map, layer;
function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([22.6, 78.9], 5);
  L.tileLayer(SERVICES.tiles, {
    maxZoom: 19, subdomains: "abcd",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on("click", async (e) => {
    const f = friendById(state.pinFor);
    if (!f) return;
    state.pinFor = null;
    $("#map").classList.remove("pinning");
    Object.assign(f, { lat: e.latlng.lat, lon: e.latlng.lng, place: "Pinned spot" });
    renderFriends(); persistFriend(f); drawMap();
    const where = await reverseGeocode({ lat: f.lat, lon: f.lon });
    if (where.name !== "My location") { f.place = where.area ? `${where.name}, ${where.area.split(",")[0]}` : where.name; renderFriends(); persistFriend(f); }
  });
}

// no search result or search is down: let the person tap the map instead
function startPin(f) {
  state.pinFor = f.id;
  $("#map").classList.add("pinning");
  if (matchMedia("(max-width: 900px)").matches) $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
  toast(`Tap the map where ${displayName(f, state.friends.indexOf(f))} is coming from`);
}

function flyTo(f) {
  drawMap();
  if (located().length === 1) map.flyTo([f.lat, f.lon], 13, { duration: 0.8 });
  else fitAll();
}

function fitAll() {
  const pts = located().map((f) => [f.lat, f.lon]);
  if (state.result && !state.stale) pts.push([state.result.spot.lat, state.result.spot.lon]);
  if (pts.length >= 2) map.fitBounds(pts, { padding: [50, 50], maxZoom: 14 });
}

function drawMap(pickId) {
  if (!map) return;
  layer.clearLayers();
  const r = state.result && !state.stale ? state.result : null;
  if (r) {
    located().forEach((f) => {
      L.polyline([[f.lat, f.lon], [r.spot.lat, r.spot.lon]], { color: f.color, weight: 3, opacity: 0.85, dashArray: "2 9", lineCap: "round" }).addTo(layer);
    });
    r.venues.forEach((v) => {
      const icon = L.divIcon({ className: "", html: `<div class="m-place${v.id === pickId ? " pick" : ""}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
      L.marker([v.lat, v.lon], { icon, keyboard: false }).addTo(layer)
        .bindTooltip(`${esc(v.name)}<br>longest ride ${v.max} min`, { className: "tip", direction: "top" });
    });
    const spotIcon = L.divIcon({ className: "", html: `<div class="m-spot"></div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    L.marker([r.spot.lat, r.spot.lon], { icon: spotIcon, title: "The fair spot" }).addTo(layer)
      .bindTooltip(`The fair spot: ${esc(r.spot.name)}`, { className: "tip", direction: "top" });
  }
  located().forEach((f, i) => {
    const icon = L.divIcon({ className: "", html: `<div class="m-friend" style="--friend:${f.color}">${esc(f.emoji)}</div>`, iconSize: [44, 44], iconAnchor: [22, 22] });
    L.marker([f.lat, f.lon], { icon, title: displayName(f, i) }).addTo(layer)
      .bindTooltip(`${esc(displayName(f, i))}: ${esc(f.place)}`, { className: "tip", direction: "top" });
  });
}

/* ---------------- the search ---------------- */
async function runSearch() {
  const friends = located();
  if (friends.length < 2) return;
  const box = $("#stepResults"), prog = $("#progress");
  box.hidden = false; $("#resultBody").hidden = true; prog.hidden = false;
  prog.innerHTML = STEPS.map((s) => `<p>${esc(s)}</p>`).join("");
  $("#findBtn").disabled = true;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  const step = (k) => $$("p", prog).forEach((p, i) => { p.className = i < k ? "done" : i === k ? "now" : ""; });
  try {
    const result = await findFairSpot(friends, state.filters, step);
    result.friendIds = friends.map((f) => f.id);
    state.result = result; state.stale = false; state.votes = {};
    if (state.mode === "live") await room.saveResult(state.code, result);
    else store.set("midway.result", result);
    showResults();
  } catch (e) {
    prog.innerHTML = `<p class="now">${e.message === "NO_ROUTES"
      ? "No road route connects these spots. Check that everyone is in the same city."
      : "The free map servers didn't answer in time. Wait a few seconds and press the button again."}</p>`;
  } finally {
    updateFindButton();
  }
}

/* ---------------- results ---------------- */
let deck;
function showResults() {
  $("#progress").hidden = true;
  $("#resultBody").hidden = false;
  $("#stepResults").hidden = false;
  renderSpot();
  deck.set(unvotedVenues());
  renderBoard();
  drawMap();
  fitAll();
  requestAnimationFrame(() => $("#stepResults").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
}
function renderResultsIfAny() { if (state.result && !$("#resultBody").hidden) { renderSpot(); renderBoard(); } }

function resultFriends() {
  // the friends the result was computed for, in the same order as the times
  return (state.result.friendIds || []).map((id) => friendById(id) || { id, name: "Someone who left", emoji: "👻", color: "#555" });
}

function renderSpot() {
  const r = state.result, fr = resultFriends();
  $("#spotName").textContent = r.spot.name;
  $("#spotArea").textContent = r.spot.area;
  $("#balanceNum").textContent = r.spot.balance;
  const maxT = Math.max(...r.spot.times, 1);
  const longest = fr[r.spot.times.indexOf(Math.max(...r.spot.times))];
  const mid = r.midpoint.times.filter((t) => t != null);
  const midMax = mid.length === r.midpoint.times.length ? Math.max(...mid) : null;
  const midWho = midMax != null ? fr[r.midpoint.times.indexOf(midMax)] : null;
  $("#balanceText").innerHTML = midMax != null && midMax > r.spot.max + 1
    ? `Nobody rides more than <b>${r.spot.max} min</b>. The plain map midpoint would give ${esc(displayName(midWho, fr.indexOf(midWho)))} a <b>${midMax} min</b> ride.`
    : `Nobody rides more than <b>${r.spot.max} min</b>. Here the plain map midpoint is already fair, so Midway stayed close to it.`;
  const barMax = Math.max(maxT, ...(midMax ? [midMax] : []));
  $("#rideBars").innerHTML = fr.map((f, i) => `
    <li style="--friend:${f.color}"><span>${esc(f.emoji)}</span><span class="who">${esc(displayName(f, i))}</span>
      <span class="bar"><span style="width:${(100 * r.spot.times[i]) / barMax}%"></span></span><span class="min">${r.spot.times[i]} min</span></li>`).join("");
  $("#routeNote").textContent = (r.estimated
    ? "The free routing servers were busy, so these are estimates from distance. "
    : "Road travel times from OpenStreetMap, without traffic. Add 30–50% at rush hour. ")
    + (r.relaxed ? "Few places matched every filter here, so some filters were relaxed." : "");
  $("#deckHint").textContent = r.venues.length ? `${r.venues.length} places near the spot` : "";
}

function voterId() { return state.mode === "live" ? state.me : LOCAL_VOTER; }

function unvotedVenues() {
  const me = voterId();
  return (state.result?.venues || []).filter((v) => !(state.votes[v.id] && me in state.votes[v.id]));
}

function cardHtml(v) {
  const fr = resultFriends();
  const tags = [`<span class="tag">${"₹".repeat(v.budget)} approx.</span>`, `<span class="tag">${v.balance}% balanced</span>`];
  if (v.veg) tags.push(`<span class="tag veg">🌱 Veg-friendly</span>`);
  const what = [VIBE_NAME[v.vibe], ...v.cuisine].filter(Boolean).join(", ");
  return `
    <div class="vibe">${VIBE_EMOJI[v.vibe] || "🍽️"}</div>
    <h3>${esc(v.name)}</h3>
    <p class="meta">${esc(what)}. ${v.fromSpot < 1000 ? `${v.fromSpot} m` : `${(v.fromSpot / 1000).toFixed(1)} km`} from the fair spot</p>
    <div class="tags">${tags.join("")}</div>
    <div class="mini">${fr.map((f, i) => `<span style="--friend:${f.color}">${esc(f.emoji)} ${v.times[i]} min</span>`).join("")}</div>`;
}

function onVote(v, value) {
  const me = voterId();
  if (!me) return toast("Add yourself to the squad first, then vote.");
  state.votes[v.id] = { ...(state.votes[v.id] || {}), [me]: value };
  if (state.mode === "live") room.saveVote(state.code, v.id, me, value).catch(() => toast("Vote not saved. Check your connection."));
  else store.set("midway.votes", state.votes);
  renderBoard(v.id);
}

function renderBoard(lastId) {
  const venues = state.result?.venues || [];
  const rows = venues.map((v) => {
    const vs = state.votes[v.id] || {};
    const yes = Object.entries(vs).filter(([, x]) => x === 1).map(([id]) => id);
    return { v, yes, score: yes.length - Object.values(vs).filter((x) => x === -1).length * 0.01 };
  }).filter((r) => r.yes.length).sort((a, b) => b.score - a.score || a.v.max - b.v.max);
  const voters = new Set(Object.values(state.votes).flatMap((o) => Object.keys(o)));
  $("#boardHint").textContent = voters.size ? `${voters.size} ${voters.size === 1 ? "person has" : "people have"} voted` : "";
  const fr = resultFriends();
  $("#board").innerHTML = rows.length ? rows.slice(0, 6).map((r, k) => `
    <li class="${k === 0 ? "top" : ""}" data-id="${r.v.id}">
      <span class="rank">${k + 1}</span>
      <span class="nm">${esc(r.v.name)}<small>longest ride ${r.v.max} min, ${r.v.balance}% balanced</small></span>
      <span class="votes" aria-label="${r.yes.length} yes votes">${r.yes.map((id) => esc(friendById(id)?.emoji || (id === LOCAL_VOTER ? "💖" : "🙂"))).join("")}</span>
      <div class="go">${fr.map((f, i) => f.lat == null ? "" : `<a style="--friend:${f.color}" target="_blank" rel="noopener"
          href="https://www.google.com/maps/dir/?api=1&origin=${f.lat},${f.lon}&destination=${r.v.lat},${r.v.lon}&travelmode=${f.mode === "foot" ? "walking" : "driving"}">${esc(f.emoji)} Route for ${esc(displayName(f, i))}</a>`).join("")}</div>
    </li>`).join("")
    : `<li class="empty" aria-disabled="true"><span></span><span class="nm"><small>Swipe right on places you like. The squad's favourites show up here.</small></span></li>`;
  $$("#board li[data-id]").forEach((li) => li.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    li.classList.toggle("open");
    drawMap(li.dataset.id);
  }));
  if (lastId) drawMap(rows[0]?.v.id);
}

/* ---------------- squads: start, join, share ---------------- */
function openPlanner() {
  $("#landing").hidden = true;
  $("#planner").hidden = false;
  if (!map) initMap();
  setTimeout(() => map.invalidateSize(), 50);
}

async function startSquad() {
  openPlanner();
  if (room.liveRooms) {
    const me = newFriend();
    state.friends = [me];
    state.mode = "live"; state.code = room.newCode(); state.me = me.id;
    store.set(`midway.me.${state.code}`, me.id);
    try {
      await room.createRoom(state.code, state.friends, state.filters);
      history.replaceState(null, "", `?room=${state.code}`);
      listenToRoom();
      showRoomChrome();
    } catch {
      state.mode = "local"; state.code = null;
      toast("Live rooms are not available right now, so this squad stays on this phone.");
    }
  } else {
    state.friends = [];
    state.friends.push(newFriend());
    state.friends.push(newFriend());
  }
  renderFriends(); paintFilters(); drawMap();
  $("#shareBtn").hidden = false;
  $(".fname", listEl)?.focus();
}

function startDemo() {
  openPlanner();
  state.mode = "local";
  state.friends = [];
  DEMO_FRIENDS.forEach((d) => state.friends.push(newFriend({ name: d.name, emoji: d.emoji, place: `${d.place}, ${d.area}`, lat: d.lat, lon: d.lon })));
  state.result = null; state.votes = {};
  renderFriends(); paintFilters(); drawMap(); fitAll();
  $("#shareBtn").hidden = false;
  toast("Four sample friends across Ahmedabad. Press “Find our fair spot”.");
}

async function joinRoom(code) {
  openPlanner();
  state.mode = "live"; state.code = code;
  state.me = store.get(`midway.me.${code}`);
  showRoomChrome();
  await listenToRoom(true);
}

let unsub, pendingRender = false;
listEl.addEventListener("focusout", () => setTimeout(() => {
  if (pendingRender && !listEl.contains(document.activeElement)) { pendingRender = false; renderFriends(); }
}, 250));
async function listenToRoom(joining = false) {
  let first = true;
  unsub?.();
  unsub = await room.watchRoom(state.code, (data) => {
    if (!data) { toast("This squad link has expired. Start a new squad."); return; }
    const remote = Object.values(data.friends || {});
    const typing = listEl.contains(document.activeElement);
    // keep any friend card this device is still filling in (not saved yet)
    const unsaved = state.friends.filter((f) => !data.friends?.[f.id] && f.id === state.me);
    state.friends = [...remote.sort((a, b) => (a.id > b.id ? 1 : -1)), ...unsaved];
    state.filters = data.filters || state.filters;
    const newResult = data.result && (!state.result || data.result.foundAt !== state.result.foundAt);
    if (data.result) state.result = data.result;
    state.votes = data.votes || {};
    if (first && joining && (!state.me || !friendById(state.me))) {
      const me = newFriend();
      state.me = me.id; store.set(`midway.me.${state.code}`, me.id);
      state.friends.push(me);
      room.saveFriend(state.code, me).catch(() => {});
      toast("You're in the squad. Add your name and where you're coming from.");
    }
    if (!typing || first) renderFriends();
    else { pendingRender = true; updateFindButton(); }        // don't redraw the card someone is typing in
    paintFilters();
    if (state.result) {
      state.stale = false;
      if (newResult || first) showResults(); else { renderBoard(); renderSpot(); }
    }
    drawMap();
    if (first) fitAll();
    first = false;
  });
}

function showRoomChrome() {
  $("#roomChip").hidden = false;
  $("#roomChip").textContent = `Squad ${state.code}`;
  $("#shareBtn").hidden = false;
}

function shareSquad() {
  let url, text;
  if (state.mode === "live") {
    url = `${location.origin}${location.pathname}?room=${state.code}`;
    text = "Join our squad on Midway: add where you're coming from, and we'll find the fair spot to meet.";
    $("#shareText").textContent = "Everyone who opens this link adds their own spot from their own phone. Votes update live.";
  } else {
    if (located().length < 1) return toast("Add at least one spot first.");
    url = `${location.origin}${location.pathname}#s=${room.encodeSquad(state.friends)}`;
    text = "Here's our squad on Midway. Open it, add your spot, then send the new link back to the group.";
    $("#shareText").textContent = "This link carries everyone's spot (rounded to about 100 m). Whoever opens it can add their own spot and send the updated link back.";
  }
  $("#shareUrl").value = url;
  $("#waBtn").href = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
  $("#shareDialog").showModal();
}

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3800);
}

/* ---------------- boot ---------------- */
function boot() {
  deck = makeDeck($("#deck"), { onVote, render: cardHtml });
  wireFilters();
  $("#startBtn").addEventListener("click", startSquad);
  $("#demoBtn").addEventListener("click", startDemo);
  $("#addFriendBtn").addEventListener("click", () => {
    const f = newFriend();
    state.friends.push(f);
    if (state.mode === "live") persistFriend(f); else saveLocal();
    renderFriends();
    $$(".fname", listEl).at(-1)?.focus();
  });
  $("#findBtn").addEventListener("click", runSearch);
  $("#inBtn").addEventListener("click", () => deck.vote(1));
  $("#nahBtn").addEventListener("click", () => deck.vote(-1));
  $("#shareBtn").addEventListener("click", shareSquad);
  $("#copyBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#shareUrl").value); toast("Link copied"); }
    catch { $("#shareUrl").select(); toast("Select the link and copy it"); }
  });

  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  if (params.get("room") && room.liveRooms) {
    joinRoom(params.get("room").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8));
  } else if (hash.get("s")) {
    const friends = room.decodeSquad(hash.get("s"));
    if (friends?.length) {
      openPlanner();
      state.friends = friends.map((f) => newFriend(f));
      state.friends.push(newFriend());
      renderFriends(); paintFilters(); drawMap(); fitAll();
      $("#shareBtn").hidden = false;
      toast(`${friends.length} spot${friends.length > 1 ? "s" : ""} from the squad link. Add yours at the bottom.`);
    }
  } else if (params.get("demo") !== null) {
    startDemo();
  } else {
    const saved = store.get("midway.local");
    if (saved?.friends?.some((f) => f.lat != null)) {
      $("#joinNote").hidden = false;
      $("#joinNote").innerHTML = `Your last squad is saved on this phone. <a href="#" id="resumeLink">Open it</a>`;
      $("#resumeLink").addEventListener("click", (e) => {
        e.preventDefault();
        openPlanner();
        state.friends = saved.friends; state.filters = saved.filters || state.filters;
        state.result = store.get("midway.result"); state.votes = store.get("midway.votes") || {};
        renderFriends(); paintFilters();
        if (state.result) showResults(); else { drawMap(); fitAll(); }
        $("#shareBtn").hidden = false;
      });
    }
  }
}

boot();
