/* ==========================================================================
   DEMO DATA — an invented household, shaped exactly like page_data().

   Every name, merchant, meal, claim and house here is made up. Dates are
   built from today, so the page always looks like a morning in use: a
   fortnight of meals, four months of charges, credits part-used in their
   current cycle, a settlement closing soon. The random numbers are seeded,
   so every load and every reset draws the same household.
   ========================================================================== */
window.TEDEMO = function(){
  var seed = 20260928;
  function rnd(){ seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  function pick(a){ return a[Math.floor(rnd() * a.length)]; }
  function between(lo, hi){ return Math.round((lo + rnd() * (hi - lo)) * 100) / 100; }

  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var today = new Date(new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }));
  function ago(n){ return new Date(today.getFullYear(), today.getMonth(), today.getDate() - n); }
  function iso(d){
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function short(d){ return MON[d.getMonth()] + ' ' + ('0' + d.getDate()).slice(-2); }
  function label(d){ return MON[d.getMonth()] + ' ' + d.getDate(); }

  /* ---- accounts and transactions ---- */
  var accounts = { '1': 'Checking', '2': 'Gold', '3': 'Platinum', '4': 'Everyday Visa' };
  var SPEND = {
    dining:   { acct: [2, 2, 3], per: 0.3, lo: 6, hi: 26,
                names: ['Blue Door Cafe', 'Taqueria Sol', 'Pho Garden', 'Corner Bakery',
                        'Luna Pizza', 'Sushi Kaito', 'Harbor Coffee'] },
    grocery:  { acct: [2], per: 0.22, lo: 14, hi: 60,
                names: ["Trader Joe's", 'Safeway', 'Farmers Market', "Trader Joe's", 'Safeway', 'Costco'] },
    shopping: { acct: [4, 4, 3], per: 0.12, lo: 8, hi: 40,
                names: ['Target', 'Amazon', 'REI', 'Home Depot', 'Lululemon'] },
    gas:      { acct: [4], per: 0.14, lo: 36, hi: 64, names: ['Shell', 'Chevron', 'Arco'] },
    travel:   { acct: [3], per: 0.04, lo: 18, hi: 260, names: ['Alaska Airlines', 'Hilton', 'Lyft'] }
  };
  var BILLS = [['PG&E', 88, 3], ['Comcast Xfinity', 70, 8], ['Verizon Wireless', 95, 14],
               ['Spotify', 11.99, 19], ['Netflix', 15.49, 22], ['Equinox', 25, 2]];

  var txns = [], id = 1000;
  function add(d, desc, cat, amt, acct, prov){
    txns.push({ id: id++, date: iso(d), desc: desc, cat: cat, amt: amt, prov: !!prov, acct: acct });
  }
  for(var n = 120; n >= 0; n--){
    var d = ago(n), prov = n <= 1;
    Object.keys(SPEND).forEach(function(cat){
      var s = SPEND[cat];
      if(rnd() < s.per){
        var name = pick(s.names);
        var amt = name === 'Costco' ? between(95, 160) : between(s.lo, s.hi);
        add(d, name, cat, -amt, pick(s.acct), prov);
      }
    });
    BILLS.forEach(function(b){
      if(d.getDate() === b[2]){ add(d, b[0], 'utility', -b[1], b[0] === 'Equinox' ? 3 : 4, prov); }
    });
    if(d.getDay() === 5 && Math.round((today - d) / 86400000) % 14 < 7){
      add(d, 'Payroll Direct Deposit', 'income', 2850, 1, prov);
    }
    if(d.getDate() === 25){
      add(d, 'Card Payment', 'transfer', -between(900, 1600), 1, prov);
      add(d, 'Payment Thank You', 'transfer', between(900, 1600), 2, prov);
    }
  }
  /* two settled charges with no category, for the one-tap filing on Alerts */
  add(ago(3), 'Sq Mountain Muse', null, -23.5, 4, false);
  add(ago(2), 'Tst Harbor Grill', null, -41.75, 2, false);
  /* statement credits, which the Credits card matches by name */
  var credit_postings = [
    { card: 'Gold', d: iso(ago(today.getDate() - 1)), amt: 10, desc: 'Dining Credit' },
    { card: 'Platinum', d: iso(ago(40)), amt: 75, desc: 'Lululemon Credit' },
    { card: 'Platinum', d: iso(ago(5)), amt: 12.95, desc: 'Walmart+ Credit' }
  ].filter(function(p){ return p.d <= iso(today); });
  credit_postings.forEach(function(p){
    add(new Date(p.d + 'T12:00:00'), p.desc, 'transfer', p.amt,
        p.card === 'Gold' ? 2 : 3, false);
  });
  txns.sort(function(a, b){ return a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id; });

  /* ---- credits ---- */
  var y = today.getFullYear(), m = today.getMonth();
  var cyc = {
    monthly: y + '-' + ('0' + (m + 1)).slice(-2),
    quarterly: y + '-Q' + (Math.floor(m / 3) + 1),
    semiannual: y + '-H' + (m < 6 ? 1 : 2),
    annual: String(y)
  };
  function credit(id, card, name, amt, period, match, icon, claimed, extra){
    var c = { id: id, card: card, name: name, amt: amt, amt_dec: null, period: period,
              match: match, claimed: claimed || 0, claimed_cycle: claimed ? cyc[period] : null,
              claimed_as_of: claimed ? iso(ago(4)) : null, icon: icon, remind: true };
    for(var k in (extra || {})){ c[k] = extra[k]; }
    return c;
  }
  var credits = [
    credit(1, 'Gold', 'Resy', 50, 'semiannual', 'resy', 'resy.com', 0),
    credit(2, 'Gold', 'Dining', 10, 'monthly', 'dining', null, 0),
    credit(3, 'Gold', 'Dunkin', 7, 'monthly', 'dunkin', 'dunkindonuts.com', 0),
    credit(4, 'Gold · Platinum', 'Uber Cash', 25, 'monthly', null, 'uber.com', 15,
           { amt_dec: 45 }),
    credit(5, 'Platinum', 'Lululemon', 75, 'quarterly', 'lululemon', 'lululemon.com', 0),
    credit(6, 'Platinum', 'Equinox', 25, 'monthly', 'equinox', 'equinox.com', 0),
    credit(7, 'Platinum', 'Walmart+', 12.95, 'monthly', 'walmart', 'walmart.com', 0),
    credit(8, 'Platinum', 'CLEAR Plus', 209, 'annual', 'clear', 'clearme.com', 209),
    credit(9, 'Platinum', 'Oura Ring', 200, 'annual', 'oura', 'ouraring.com', 0,
           { remind: false })
  ];

  /* ---- food ---- */
  var MEALS = {
    Alex: [['Oatmeal, banana, peanut butter', 480, 16, 68, 17, 22],
           ['Chicken burrito bowl', 720, 44, 78, 24, 6],
           ['Salmon, rice, broccoli', 640, 42, 58, 24, 4],
           ['Greek yogurt and berries', 220, 18, 26, 4, 18],
           ['Two eggs and toast', 390, 19, 30, 21, 3],
           ['Pepperoni pizza, two slices', 620, 26, 68, 26, 8],
           ['Protein shake', 180, 30, 6, 3, 2]],
    Sam:  [['Avocado toast', 360, 11, 34, 21, 3],
           ['Poke bowl', 590, 32, 70, 18, 9],
           ['Turkey sandwich', 450, 28, 44, 15, 6],
           ['Apple and almonds', 260, 7, 26, 16, 19],
           ['Pasta with pesto', 680, 20, 86, 28, 5],
           ['Smoothie', 310, 12, 54, 6, 38],
           ['Tofu stir-fry', 520, 26, 52, 22, 10]]
  };
  var nutrition = [];
  for(var k = 13; k >= 0; k--){
    var day = ago(k);
    ['Alex', 'Sam'].forEach(function(p){
      if(rnd() < 0.18 && k > 0){ return; }
      var count = k === 0 ? 2 : 3 + (rnd() < 0.5 ? 1 : 0);
      for(var i = 0; i < count; i++){
        var f = pick(MEALS[p]);
        nutrition.push({ person: p, d: iso(day), day: short(day), meal: f[0],
                         cal: f[1], p: f[2], c: f[3], f: f[4], sug: f[5] });
      }
    });
  }
  nutrition.sort(function(a, b){ return a.d < b.d ? 1 : a.d > b.d ? -1 : 0; });

  var out = {
    next_id: 9000,
    transactions: txns,
    accounts: accounts,
    synced: label(today) + ' at 8:30 AM',
    people: ['Alex', 'Sam'],
    nutrition: nutrition,
    recs: [
      { person: 'Alex', dt: label(ago(3)),
        body: 'Protein is steady, but dinners run late and heavy. Move the biggest meal to lunch '
            + 'two days a week and add a vegetable to breakfast; sugar is fine as it is.' },
      { person: 'Sam', dt: label(ago(6)),
        body: 'Intake is on the light side on busy days, mostly from skipped lunches. Keep a '
            + 'no-prep option at hand, like yogurt or a sandwich, so a gap does not become a skipped meal.' }
    ],
    jobs: { counts: { application: 38, rejection: 14, interview: 3 } },
    todos: [
      { id: 1, text: 'Renew car registration', done: false, detail: 'Due Oct 15 · online, about $180' },
      { id: 2, text: 'Book the October haircut', done: false, detail: null },
      { id: 3, text: 'Return the hiking boots', done: true, detail: 'REI · label printed' }
    ],
    backlog: [
      { id: 4, text: 'Scan the old tax returns', done: false, detail: null },
      { id: 5, text: 'Compare internet plans', done: false, detail: 'Current plan ends in January' }
    ],
    actions: [
      { id: 10, kind: 'draft', text: 'Reply to Jordan about Saturday',
        detail: 'Draft says: Saturday works, 9am at the trailhead?', done: false, file_to: null },
      { id: 11, kind: 'bill', text: 'Water bill payment failed',
        detail: '$64.20 · retry by ' + label(ago(-5)), done: false, file_to: 'Money/Out' },
      { id: 12, kind: 'event_added', text: 'Dentist cleaning added',
        detail: 'Family · ' + label(ago(-4)) + ', 3:30 PM', done: false, file_to: 'Save' },
      { id: 13, kind: 'invite', text: 'Book club',
        detail: label(ago(-11)) + ', 7:00 PM · waiting on your reply', done: false, file_to: null },
      { id: 14, kind: 'subscription', text: 'Streaming price going up',
        detail: '$15.49 to $17.99 from next month', done: false, file_to: 'Money/Out' }
    ],
    credit_postings: credit_postings,
    credits: credits,
    settlements: [
      { id: 21, title: 'Northwind Telecom data breach', url: 'https://example.com/claims/northwind',
        deadline: iso(ago(-9)), payout: 'up to $2,500', proof: false,
        evidence: 'Northwind Wireless bills on your Visa from 2022 to 2024', claim_id: null,
        status: 'new', asks_about: null, notes: null },
      { id: 22, title: 'Contoso smart speaker defect', url: 'https://example.com/claims/contoso',
        deadline: iso(ago(-40)), payout: '$15 to $40', proof: null,
        evidence: 'A common household device; nothing on record either way', claim_id: null,
        status: 'ask', asks_about: 'a Contoso smart speaker bought 2019 to 2023', notes: null },
      { id: 23, title: 'Fabrikam Bank overdraft fees', url: 'https://example.com/claims/fabrikam',
        deadline: iso(ago(12)), payout: 'pro rata', proof: false,
        evidence: 'Notice emailed to you on ' + label(ago(30)), claim_id: 'FBK-48213-QX',
        status: 'ongoing', asks_about: null, notes: null }
    ],
    settlement_statuses: ['ask', 'new', 'ongoing', 'done', 'skipped'],
    problems: [
      { tag: 'Sweep', txt: 'Email sweep finished with problems',
        detail: 'Save/Jobs search timed out twice; it runs again tonight' },
      { tag: 'Settlement', txt: 'Northwind Telecom data breach — claim closes in 9 days',
        detail: 'up to $2,500 · File it from the Settlements card.' }
    ]
  };
  return window.TEDEMOMORE(out, ago, iso, label);
};

/* ==========================================================================
   The rest of the invented household: what the newer pages read.
   Net worth (page_monarch_data), mail highlights (page_highlights), the
   wedding's costs (page_wedding_data) and its shopping ticks (page_shop_get),
   plus the settings, usage and push key page_data() now carries.
   ========================================================================== */
window.TEDEMOMORE = function(out, ago, iso, label){
  out.settings = out.settings || {};
  out.usage = { cloudflare: { limit: 500, used: 64 }, db_bytes: 31e6, db_limit: 500e6 };
  out.push_key = null;
  out.next_id = out.next_id || 900;

  /* net worth: five accounts, a year of daily balances that drift upward */
  var ACCTS = [
    ['a1', 'Checking', 'Northwind Bank', 6400, 3200],
    ['a2', 'Savings', 'Northwind Bank', 18200, 9000],
    ['a3', 'Brokerage', 'Contoso Invest', 24500, 15000],
    ['a4', 'Gold', 'Card', -1350, -900],
    ['a5', 'Everyday Visa', 'Card', -420, -300]
  ];
  var balances = [];
  for (var k = 365; k >= 0; k--) {
    var d = iso(ago(k));
    ACCTS.forEach(function(a, n){
      var drift = a[3] - (a[3] - a[4]) * (k / 365);
      var wobble = Math.sin((k + n * 11) / 9) * Math.abs(a[3]) * 0.03;
      balances.push({ acct: a[0], d: d, bal: Math.round((drift + wobble) * 100) / 100 });
    });
  }
  out.monarch = {
    accounts: ACCTS.map(function(a){
      return { id: a[0], name: a[1], kind: a[3] < 0 ? 'credit' : 'bank', owner: 'household',
               bank: a[2], last4: null, balance: a[3], as_of: new Date().toISOString() };
    }),
    balances: balances
  };

  out.highlights = [
    { sender: 'school@example.com', n: 2, note: 'Field trip form due Friday',
      at: ago(0).toISOString(), thread: 'demo-1' },
    { sender: 'pharmacy@example.com', n: 1, note: 'Prescription ready for pickup',
      at: ago(1).toISOString(), thread: 'demo-2' }
  ];

  /* the wedding: Maya and Sam, the same invented couple as the wedding-tracker demo */
  var groups = [
    { id: 1, name: 'Fernbrook Lodge venue' }, { id: 2, name: 'Photography' },
    { id: 3, name: 'Catering' }, { id: 4, name: 'Florist' }, { id: 5, name: 'Attire' },
    { id: 20, name: 'Gifts' }
  ];
  function row(id, g, label_, amt, status, daysAgo, extra){
    var r = { id: id, group_id: g, label: label_, amount: amt, status: status,
              date_label: label(ago(daysAgo)), due_date: status === 'due' ? iso(ago(daysAgo)) : null,
              details: null, in_bank: status !== 'due', part_num: null, part_total: null,
              refundable: false, currency: 'USD', gift_via: null, gift_side: null };
    for (var x in (extra || {})) { r[x] = extra[x]; }
    return r;
  }
  var tx = [
    row(1, 1, 'Venue deposit', 2500, 'paid', 120, { part_num: 1, part_total: 2 }),
    row(2, 1, 'Venue balance', 2500, 'due', -20, { part_num: 2, part_total: 2 }),
    row(3, 1, 'Damage deposit', 800, 'paid', 60, { refundable: true }),
    row(4, 2, 'Photographer retainer', 900, 'paid', 95),
    row(5, 2, 'Photographer balance', 1800, 'due', -6),
    row(6, 3, 'Catering deposit', 1200, 'paid', 70),
    row(7, 3, 'Catering final count', 2650, 'due', 3),
    row(8, 4, 'Florist', 640, 'paid', 30),
    row(9, 5, 'Dress alterations', 280, 'paid', 14),
    row(10, 20, 'Gift from Grandma June', 1500, 'received', 40, { gift_via: 'check', gift_side: 'bride' }),
    row(11, 20, 'Gift from the Parks', 300, 'received', 9, { gift_via: 'Zelle', gift_side: 'groom' })
  ];
  function sum(f){ return tx.filter(f).reduce(function(a, t){ return a + t.amount; }, 0); }
  var paid = sum(function(t){ return t.status === 'paid'; });
  var due = sum(function(t){ return t.status === 'due'; });
  out.wedding = {
    money: { paid: paid, due: due, committed: paid + due,
             received: sum(function(t){ return t.status === 'received'; }) },
    transactions: tx,
    tx_groups: groups,
    money_promised: [
      { id: 31, amount: 1000, label: 'Grandma June promised toward catering', date_label: 'before the day',
        details: null, group_id: 20, covers_group_id: 3, is_estimate: false, vendor: null }
    ]
  };
  out.shop = {};
  return out;
};
