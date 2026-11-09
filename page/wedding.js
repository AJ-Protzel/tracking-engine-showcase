/* ==========================================================================
   WEDDING: the wedding crew sheet, shown straight from its own public
   site in a frame (in this demo, the invented wedding-tracker page).
   The app's own strip above it adds Costs and Shopping, which
   live here in the app and never inside the frame, because the sheet is
   shared and these are private.

   Costs reads page_wedding_data() when the Wedding page is opened, and again
   whenever the app comes back to the front with it open; page_data() never
   carries it. Nothing here counts toward any badge: that belongs to Requires
   Action alone. Every id is prefixed w- and every style lives in
   wedding-tabs.css, scoped to .xp.
   ========================================================================== */
(function(){
let doc = null;
const $ = (id) => doc && doc.getElementById("w-" + id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
const money = (n) => n == null ? "—" : "$" + Number(n).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2});
const moneySigned = (n) => (Number(n) < 0 ? "−" : "+") + money(Math.abs(Number(n)));
const money0 = (n) => n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-US");

/* the app's one database door, as a promise shaped like supabase-js's answer;
   an ended session is handled there, and never settles here */
const rpc = (name, args) => new Promise(resolve =>
  window.TERPC(name, args || {}, (error, data) => resolve({data, error})));

/* four of the five boxes filter the Money list: tapping one lists its rows, tapping it again
   lists everything. Account change is committed less income, a figure and not a filter */
function renderNumbers(d){
  const m = d.money || {};
  const gifts = Number(m.received || 0);
  /* whole dollars up here; the rows below keep their cents */
  const net = gifts - Number(m.committed || 0);

  const box = (f, k, v, cls) =>
    '<button class="btot ' + (cls || "") + '" type="button" data-f="' + f + '" aria-pressed="' + (filter === f) + '">' +
      '<span>' + k + '</span><b>' + v + '</b></button>';

  $("numbers").innerHTML =
    '<div class="btots">' +
      box("paid", "Paid", money0(m.paid)) +
      box("due", "Due", money0(m.due), "due") +
      box("committed", "Committed", money0(m.committed)) +
      box("received", "Income", money0(gifts), "in") +
      '<div class="btot net"><span>Account change</span><b>' + (net < 0 ? "−" : "+") + money0(Math.abs(net)) + '</b></div>' +
    '</div>';

  $("numbers").querySelectorAll("button.btot").forEach(b =>
    b.addEventListener("click", () => {
      filter = filter === b.dataset.f ? "all" : b.dataset.f;
      $("numbers").querySelectorAll("button.btot").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.f === filter)));
      paintTx();
    }));
}

/* a foreign-currency gift shows its own amount with the dollar value underneath */
function inAmount(t){
  if (!t.currency || t.currency === "USD" || t.amount_original == null) return "+" + money(t.amount);
  const orig = Number(t.amount_original).toLocaleString("en-US", {maximumFractionDigits: 2});
  return "+" + (t.currency === "IDR" ? "Rp " + orig : orig + " " + esc(t.currency)) +
    '<span class="vr" style="display:block;text-align:right">(' + money(t.amount) + ')</span>';
}

/* Promises: what Grandma June has promised (wedding_transactions rows that are pending money in), never bank money.
   Her total promised sits at the bottom with what she has paid, received rows in the Grandma June
   group, taken off it. Covered vendors read their cost from Money instead of repeating it. */
function renderPromises(d){
  const g = (d.tx_groups || []).find(x => x.name === "Contributions");
  const items = g ? (d.money_promised || []).filter(r => r.group_id === g.id) : [];
  /* the group also holds gifts from other people, so Grandma June's own payments are told apart by name */
  const paidRows = g ? (d.transactions || []).filter(t => t.status === "received" && t.group_id === g.id && /mami/i.test(t.label || "")) : [];
  const sum = (list) => list.reduce((s, r) => s + Number(r.amount || 0), 0);
  const promised = sum(items.filter(r => !r.is_estimate));
  const paid = sum(paidRows);
  const left = Math.max(0, promised - paid);
  const row = (label, sub, amt, tag) =>
    '<div class="vrow"><div><span class="vn">' + esc(label) + '</span>' +
    (sub ? '<span class="vr" style="display:block">' + sub + '</span>' : "") + '</div>' +
    '<span class="lamt" style="text-align:right">' + amt + (tag ? '<span class="vr" style="display:block">' + tag + '</span>' : "") + '</span></div>';
  const total = (label, amt, cls) =>
    '<div class="vrow"><span class="vn">' + label + '</span><span class="gamt ' + (cls || "") + '">' + amt + '</span></div>';

  $("promises").innerHTML = items.length
    ? '<div class="vendorlist" style="margin-top:0">' + items.map(r =>
        row(r.label,
            [r.vendor, r.date_label, r.covers_group_id ? "from Money" : "", r.details].filter(Boolean).map(esc).join(" · "),
            money(r.amount), r.is_estimate ? "estimate · not counted" : "")
      ).join("") + '</div>' +
      '<div class="vendorlist totals">' +
        total("Grandma June promised", money(promised)) +
        total("Grandma June paid", "−" + money(paid), "good") +
        total("Still to come", money(left), left > 0 ? "warn" : "good") +
      '</div>'
    : '<div class="skel">Nothing promised</div>';
}

let allTx = [];
let txGroups = [];
let filter = "all";
/* committed is everything going out, paid or due */
const inFilter = (t, f) => f === "all" || t.status === f || (f === "committed" && (t.status === "paid" || t.status === "due"));

/* Money: every wedding row, out and in. Paid and received rows are the bank's
   (accountant_transactions flagged wedding); due rows are bills not yet paid.
   Anything else from wedding_transactions is flagged "not in the bank" to be checked. */
function renderMoney(d){
  allTx = d.transactions || [];
  txGroups = d.tx_groups || [];
  promCount = (d.money_promised || []).length;
  paintTx();
}

/* every row under the chosen figure as one flat list, narrowed by the group dropdown and
   ordered by the sort beside it. Date sorts break the list by month, the group and status
   sorts by their own headings, and each heading carries its subtotal. Promises show under
   Income and Account change while there are any. */
let group = "";
let promCount = 0;
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function paintTx(){
  $("promwrap").hidden = (filter !== "received" && filter !== "all") || !promCount;
  const today = new Date(); today.setHours(0,0,0,0);
  const dayDiff = (iso) => iso ? Math.round((new Date(iso + "T00:00:00") - today) / 86400000) : null;
  const isLate = (t) => { const dd = dayDiff(t.due_date); return t.status === "due" && dd !== null && dd < 0; };
  const offBank = (t) => !t.in_bank && t.status !== "due";
  const stateOf = (t) => t.status === "paid" || t.status === "received" ? t.status : isLate(t) ? "late" : "due";
  const whenText = (t) => {
    const dd = dayDiff(t.due_date);
    let s = t.date_label && t.date_label !== "—" ? esc(t.date_label) : "";
    if (t.status === "due" && dd !== null) s += (s ? " · " : "") + (dd < 0 ? Math.abs(dd) + "d overdue" : "in " + dd + "d");
    return s;
  };
  const gname = (id) => (txGroups.find(g => g.id === id) || {}).name || "No group";
  /* money in counts up, money out counts down; a refund is a paid row with a negative amount */
  const signed = (t) => t.status === "received" ? Number(t.amount || 0) : -Number(t.amount || 0);

  /* the dropdown lists only groups that hold rows, with how many */
  const counts = {};
  allTx.forEach(t => { counts[t.group_id] = (counts[t.group_id] || 0) + 1; });
  if (group && !counts[group]) group = "";
  $("gsel").innerHTML = '<option value="">All groups (' + allTx.length + ')</option>' +
    txGroups.filter(g => counts[g.id]).slice().sort((a, b) => a.name.localeCompare(b.name))
      .map(g => '<option value="' + g.id + '">' + esc(g.name) + ' (' + counts[g.id] + ')</option>').join("");
  $("gsel").value = group;

  const by = $("sort").value;
  const dDesc = (a, b) => (b.due_date || "9999").localeCompare(a.due_date || "9999") || b.id - a.id;
  const dAsc = (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999") || a.id - b.id;
  const size = (t) => Math.abs(Number(t.amount || 0));
  const rank = {late: 0, due: 1, paid: 2, received: 3};
  const cmp = {
    "date-asc": dAsc,
    "amt": (a, b) => size(b) - size(a) || dDesc(a, b),
    "amt-asc": (a, b) => size(a) - size(b) || dDesc(a, b),
    "status": (a, b) => rank[stateOf(a)] - rank[stateOf(b)] || dAsc(a, b),
    "grp": (a, b) => gname(a.group_id).localeCompare(gname(b.group_id)) || dDesc(a, b),
    "name": (a, b) => String(a.label).localeCompare(String(b.label)) || dDesc(a, b)
  }[by] || dDesc;
  const find = $("q").value.trim().toLowerCase();
  const hay = (t) => [t.label, gname(t.group_id), t.date_label, t.due_date, t.details, Math.abs(Number(t.amount || 0)).toFixed(2)].join(" ").toLowerCase();
  const rows = allTx.filter(t => inFilter(t, filter) && (!group || String(t.group_id) === group) && (!find || hay(t).includes(find))).sort(cmp);

  const heading = (t) =>
    by === "grp" ? gname(t.group_id)
    : by === "status" ? {late: "Overdue", due: "Due", paid: "Paid", received: "Income"}[stateOf(t)]
    : by === "amt" || by === "amt-asc" || by === "name" ? ""
    : !t.due_date ? "No date" : MONTHS[Number(t.due_date.slice(5, 7)) - 1] + " " + t.due_date.slice(0, 4);
  const secs = [];
  rows.forEach(t => {
    const h = heading(t);
    let last = secs[secs.length - 1];
    if (!last || last.name !== h) secs.push(last = {name: h, rows: [], sum: 0});
    last.rows.push(t); last.sum += signed(t);
  });

  /* a row: name over its date and group, a tag when it still needs something, the amount at the right */
  const line = (t) => {
    const a = Number(t.amount || 0), st = stateOf(t), isIn = t.status === "received" || a < 0;
    const amt = t.amount == null ? "—" : t.status === "received" ? inAmount(t) : (a < 0 ? "+" : "−") + money(Math.abs(a));
    const when = [whenText(t), by === "grp" ? "" : esc(gname(t.group_id)), esc(t.gift_via), esc(t.gift_side),
                  t.refundable ? "refundable · not in total" : "", esc(t.details)].filter(Boolean).join(" · ");
    const tag = st === "late" ? '<span class="btag late">Overdue</span>'
              : st === "due" ? '<span class="btag">Due</span>'
              : offBank(t) ? '<span class="btag quiet">Not in bank</span>' : "";
    return '<div class="brow"><div class="bmain">' +
        '<div class="bnm">' + esc(t.label) + (t.part_total ? " (" + t.part_num + "/" + t.part_total + ")" : "") + '</div>' +
        '<div class="bsub"><span class="bwhen">' + when + '</span>' + tag + '</div>' +
      '</div><div class="bamt' + (isIn ? " in" : "") + '">' + amt + '</div></div>';
  };

  $("txlist").innerHTML = secs.map(s =>
    '<div class="bmonth"><span>' + esc(s.name) + '</span>' + (s.name ? '<b>' + moneySigned(s.sum) + '</b>' : "") + '</div>' +
    '<div class="bgroup">' + s.rows.map(line).join("") + '</div>'
  ).join("") || '<p class="bnone">' + (find ? "Nothing matches that search." : "Nothing here.") + '</p>';
}


function showError(text){
  const bar = $("err");
  bar.textContent = text;
  bar.hidden = false;
  for (const id of ["numbers","promises"]) {
    const el = $(id);
    if (el.querySelector(".skel")) el.innerHTML = '<div class="skel">No data</div>';
  }
}

let loading = false;
async function load(){
  if (loading || !doc) return;
  loading = true;
  loadShop();
  try {
    const {data: d, error} = await rpc("page_wedding_data");
    if (error) throw new Error(error);
    if (!d || !d.transactions) throw new Error("empty");
    $("err").hidden = true;
    renderNumbers(d);
    renderMoney(d);
    renderPromises(d);
  } catch (e) {
    showError("Could not read the wedding data. Close and reopen the page.");
  } finally {
    loading = false;
  }
}

/* Shopping: the warehouse-store run, from the couple's list.
   Row: [name, quantity, note, key]. An item listed in two drop-downs shares one key, so ticking it
   ticks it in both. pre marks a drop-down shown as fully done. A group with no name draws no
   heading. Ticks are shared through the database, read whenever the page loads or refreshes. */
const SHOP = [
  {group: "", stores: [
    {store: "Costco", items: [
      ["Mac n cheese tray"], ["Charcuterie tray"], ["Soda, large pack", 2],
      ["LaCroix, large pack"], ["Wine pack", 2], ["Pam cooking spray"],
      ["Cornbread mix box", 2], ["Just Bare spicy chicken pack", 2]]}]}
];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
/* flatten once: every item gets its key (shared when given), quantity, note and starting state */
SHOP.forEach(g => g.stores.forEach(s => { s.items = s.items.map(r => ({
  name: r[0], qty: r[1] || 0, note: r[2] || "", key: r[3] || slug(s.store + " " + r[0]), pre: !!s.pre})); }));
const SHOP_KEY = "te-wedding-shopping";
/* ticks live in the database (wedding_shopping), so both phones agree; the browser
   copy only paints the list before the answer is back, and is sent up once if the database lacks it */
let shopState = (() => { try { return JSON.parse(localStorage.getItem(SHOP_KEY)) || {}; } catch (e) { return {}; } })();
function shopDone(){ return shopState; }
function shopCache(){ try { localStorage.setItem(SHOP_KEY, JSON.stringify(shopState)); } catch (x) {} }
async function loadShop(){
  const {data, error} = await rpc("page_shop_get");
  if (error || !data) return;
  Object.keys(shopState).forEach(k => { if (data[k] === undefined) { data[k] = shopState[k]; rpc("page_shop_set", {p_key: k, p_got: !!shopState[k]}); } });
  shopState = data; shopCache();
  paintShop();
}
/* the stores that are open stay open through a repaint; Costco, the only one, starts open */
const shopOpen = new Set(["Costco"]);
function paintShop(){
  const done = shopDone();
  const isOn = (i) => done[i.key] === undefined ? i.pre : !!done[i.key];
  const items = SHOP.flatMap(g => g.stores.flatMap(s => s.items));
  const uniq = new Map(items.map(i => [i.key, i]));
  const got = [...uniq.values()].filter(isOn).length;
  $("shopcount").textContent = got + " of " + uniq.size + " got";
  $("shoplist").innerHTML = SHOP.map(g =>
    (g.group ? '<p class="eyebrow" style="margin-top:30px;margin-bottom:0">' + esc(g.group) + '</p>' : "") +
    g.stores.map(s =>
      '<details class="shopstore" data-s="' + esc(s.store) + '"' + (shopOpen.has(s.store) ? " open" : "") + '>' +
      '<summary class="bmonth"><span>' + esc(s.store) + '</span><b>' + s.items.filter(isOn).length + ' of ' + s.items.length + '</b></summary>' +
      '<div class="bgroup">' + s.items.map(i =>
        '<label class="brow shopitem"><input type="checkbox" data-k="' + esc(i.key) + '"' + (isOn(i) ? " checked" : "") + '>' +
        '<div class="bmain"><div class="bnm">' + esc(i.name) + '</div>' +
        (i.note ? '<div class="bsub"><span class="bwhen">' + esc(i.note) + '</span></div>' : "") + '</div>' +
        (i.qty ? '<div class="bamt">&times;' + i.qty + '</div>' : "") + '</label>'
      ).join("") + '</div></details>').join("")).join("");
}

/* ---------- the private tabs, drawn in the app beside the sheet's frame ---------- */
const COSTS_HTML =
  '<h2>Costs</h2>' +
  '<div id="w-err" hidden class="errbar"></div>' +
  '<div id="w-numbers"><div class="skel">Loading</div></div>' +
  '<div class="bbar">' +
    '<input type="search" id="w-q" placeholder="Search name, amount or group" aria-label="Search" autocomplete="off">' +
    '<div class="picks">' +
      '<select id="w-gsel" aria-label="Group"><option value="">All groups</option></select>' +
      '<select id="w-sort" aria-label="Sort">' +
        '<option value="date">Newest first</option><option value="date-asc">Oldest first</option>' +
        '<option value="amt">Largest first</option><option value="amt-asc">Smallest first</option>' +
        '<option value="status">Due first</option><option value="grp">By group</option>' +
        '<option value="name">Name A to Z</option>' +
      '</select>' +
    '</div>' +
  '</div>' +
  '<div id="w-txlist"></div>' +
  '<div id="w-promwrap" hidden>' +
    '<p class="eyebrow" style="margin-top:26px;margin-bottom:8px">Promises</p>' +
    '<div id="w-promises"><div class="skel">Loading</div></div>' +
  '</div>';
const SHOP_HTML =
  '<h2>Shopping</h2><div class="shophead"><p class="lede" id="w-shopcount">&nbsp;</p>' +
  '<div class="shopbtns"><button type="button" id="w-shopopen">Expand all</button><button type="button" id="w-shopshut">Collapse all</button></div></div>' +
  '<div id="w-shoplist"></div>';

const wed = document.getElementById("wed");
const frame = wed.querySelector("iframe.sheet");
const wpage = document.querySelector('.page[data-page="wedding"]');
const TAB_KEY = "te-wedding-tab";

function mount(){
  if (doc) return;
  doc = document;

  /* the app's own strip: the shared sheet first, then the private tabs, which live here in the
     app and never inside the frame (the sheet is its own public site, a public site) */
  const tabs = [["sheet", "Crew sheet", null], ["costs", "Costs", COSTS_HTML], ["shop", "Shopping", SHOP_HTML]];
  const bar = document.createElement("nav");
  bar.className = "pagetabs subnav"; bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "Wedding pages");
  const panels = {sheet: frame};
  tabs.forEach(([id, name, html]) => {
    if (html) {
      const sec = document.createElement("section");
      sec.className = "xp"; sec.id = "w-tab-" + id; sec.hidden = true; sec.setAttribute("role", "tabpanel");
      sec.innerHTML = html;
      wed.appendChild(sec);
      panels[id] = sec;
    }
    const b = document.createElement("button");
    b.type = "button"; b.className = "ptab"; b.textContent = name; b.dataset.tab = id;
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", "false");
    b.addEventListener("click", () => pick(id, true));
    bar.appendChild(b);
  });
  frame.before(bar);

  const tabh = () => document.querySelector(".pagetabs").offsetHeight;
  /* the sheet scrolls inside its frame, so the frame fills the window below the two strips */
  const fit = () => {
    bar.style.top = (tabh() - 1) + "px";
    frame.style.height = Math.max(320, window.innerHeight - tabh() - bar.offsetHeight) + "px";
  };
  function pick(id, scroll){
    if (!panels[id]) id = "sheet";
    bar.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === id ? "true" : "false"));
    Object.keys(panels).forEach(k => { panels[k].hidden = k !== id; });
    try { localStorage.setItem(TAB_KEY, id); } catch (e) {}
    fit();
    if (scroll) {
      const t = window.scrollY + bar.getBoundingClientRect().top - tabh() + 1;
      if (window.scrollY > t) window.scrollTo({top: t});
    }
  }
  let start = "sheet";
  try { start = localStorage.getItem(TAB_KEY) || "sheet"; } catch (e) {}
  pick(start, false);
  window.addEventListener("resize", fit);
  /* the strips have no height while the page is hidden, so size again when it opens */
  document.addEventListener("tepage", (e) => { if (e.detail && e.detail.kind === "wedding") setTimeout(fit, 0); });

  $("gsel").addEventListener("change", (e) => { group = e.target.value; paintTx(); });
  $("sort").addEventListener("change", paintTx);
  $("q").addEventListener("input", paintTx);
  const setAll = (open) => {
    shopOpen.clear();
    if (open) SHOP.forEach(g => g.stores.forEach(st => shopOpen.add(st.store)));
    paintShop();
  };
  $("shopopen").addEventListener("click", () => setAll(true));
  $("shopshut").addEventListener("click", () => setAll(false));
  /* toggle does not bubble, so catch it on the way down */
  $("shoplist").addEventListener("toggle", (e) => {
    const st = e.target.dataset && e.target.dataset.s;
    if (st === undefined) return;
    if (e.target.open) shopOpen.add(st); else shopOpen.delete(st);
  }, true);
  $("shoplist").addEventListener("change", (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    shopState[k] = e.target.checked;
    shopCache();
    paintShop();
    rpc("page_shop_set", {p_key: k, p_got: e.target.checked}).then(({error}) => { if (error) loadShop(); });
  });
  paintShop();
  if (!wpage.hidden) load();
}

mount();

/* the Wedding page itself: read on opening it, and on coming back to the front while it is open */
document.addEventListener("tepage", (e) => { if (e.detail && e.detail.kind === "wedding") load(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !wpage.hidden && !document.getElementById("app").hidden) load();
});
document.addEventListener("terefresh", () => { if (!wpage.hidden) load(); });
})();
