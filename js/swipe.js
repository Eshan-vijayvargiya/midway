// A Tinder-style stack: drag right (or press →) for "I'm in", left (or ←) for "Nah".
export function makeDeck(el, { onVote, render }) {
  let items = [];

  function draw() {
    el.innerHTML = "";
    if (!items.length) {
      el.innerHTML = `<div class="deck-empty"><p>That's every place. The squad's top picks are below.</p></div>`;
      return;
    }
    items.slice(0, 3).forEach((item, i) => {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = render(item) + `<span class="stamp in">in 🔥</span><span class="stamp nah">nah</span>`;
      card.style.zIndex = String(10 - i);
      card.style.transform = `translateY(${i * 10}px) scale(${1 - i * 0.04})`;
      card.style.opacity = i > 1 ? "0.5" : "1";
      el.appendChild(card);
      if (i === 0) drag(card, item);
    });
  }

  function fling(card, item, dir) {
    card.style.transition = "transform .35s cubic-bezier(.2,.8,.2,1), opacity .35s";
    card.style.transform = `translateX(${dir * 140}%) rotate(${dir * 24}deg)`;
    card.style.opacity = "0";
    setTimeout(() => { items = items.slice(1); draw(); }, 280);
    onVote(item, dir > 0 ? 1 : -1);
  }

  function drag(card, item) {
    let x0 = 0, dx = 0, active = false;
    const stampIn = card.querySelector(".stamp.in"), stampNah = card.querySelector(".stamp.nah");
    card.addEventListener("pointerdown", (e) => { active = true; x0 = e.clientX; dx = 0; card.classList.add("dragging"); card.setPointerCapture(e.pointerId); });
    card.addEventListener("pointermove", (e) => {
      if (!active) return;
      dx = e.clientX - x0;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
      stampIn.style.opacity = String(Math.max(0, Math.min(1, dx / 90)));
      stampNah.style.opacity = String(Math.max(0, Math.min(1, -dx / 90)));
    });
    const end = () => {
      if (!active) return;
      active = false;
      card.classList.remove("dragging");
      if (Math.abs(dx) > 90) return fling(card, item, Math.sign(dx));
      card.style.transition = "transform .25s";
      card.style.transform = "";
      stampIn.style.opacity = stampNah.style.opacity = "0";
      setTimeout(() => (card.style.transition = ""), 260);
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    vote(e.key === "ArrowRight" ? 1 : -1);
  });

  function vote(dir) {
    const card = el.querySelector(".card");
    if (card && items.length) fling(card, items[0], dir);
  }

  return {
    set(list) { items = [...list]; draw(); },
    vote,
    left: () => items.length,
  };
}
