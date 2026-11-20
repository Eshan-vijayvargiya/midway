// Splitting the bill: who paid what, who owes whom, settled in as few payments as possible.
// An expense: { id, what, amount, paidBy, mode: "equal" | "exact", among: [friendIds], exact: { friendId: rupees } }

const r2 = (x) => Math.round(x * 100) / 100;

// What each person's share of one expense is.
export function shares(ex) {
  if (ex.mode === "exact") return Object.fromEntries(Object.entries(ex.exact || {}).filter(([, v]) => v > 0).map(([id, v]) => [id, r2(v)]));
  const among = ex.among?.length ? ex.among : [ex.paidBy];
  const each = ex.amount / among.length;
  return Object.fromEntries(among.map((id) => [id, r2(each)]));
}

// Net balance per person: positive = gets money back, negative = owes.
export function balances(expenses) {
  const bal = {};
  for (const ex of expenses) {
    bal[ex.paidBy] = (bal[ex.paidBy] || 0) + ex.amount;
    for (const [id, s] of Object.entries(shares(ex))) bal[id] = (bal[id] || 0) - s;
  }
  for (const id of Object.keys(bal)) bal[id] = r2(bal[id]);
  return bal;
}

// Greedy settle-up: the person who owes most pays the person owed most, until everyone is square.
// This never needs more than (people - 1) payments.
export function settle(bal) {
  const owe = Object.entries(bal).filter(([, v]) => v < -0.5).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const get = Object.entries(bal).filter(([, v]) => v > 0.5).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const pays = [];
  let i = 0, j = 0;
  while (i < owe.length && j < get.length) {
    const amt = Math.min(owe[i].v, get[j].v);
    if (amt >= 1) pays.push({ from: owe[i].id, to: get[j].id, amount: Math.round(amt) });
    owe[i].v -= amt; get[j].v -= amt;
    if (owe[i].v < 0.5) i++;
    if (get[j].v < 0.5) j++;
  }
  return pays;
}

export function upiLink(upi, name, amount) {
  const q = { pa: upi, pn: name, am: amount.toFixed(2), cu: "INR", tn: "Midway split" };      // %20 for spaces: some UPI apps show "+"
  return `upi://pay?${Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}
