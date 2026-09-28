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

  /* ---- rentals ---- */
  var H = [
    // address, price, was, beds, baths, sqft, days, verdict, why, landlord, income, apply, notes
    ['118 Juniper Ct', 1895, null, 3, 2, 1340, 2, 'pass', null, 'private', 'flexible',
     'Open to a co-signer or extra deposit',
     'Single-level house, in-unit washer and dryer, central AC, fenced yard. Owner-managed.'],
    ['2207 Maple Ave', 2150, 2295, 3, 2, 1520, 34, 'pass', null, 'manager', 'none_stated', null,
     'Detached home near the park. Laundry room with hookups, mini-split AC in every room.'],
    ['64 Heron Way', 1750, null, 2, 1, 980, 1, 'pass', null, 'private', 'none_stated', null,
     'Cottage on its own lot. Stacked washer/dryer, window AC units included.'],
    ['915 Birch St', 2050, null, 3, 2.5, 1610, 9, 'pass', null, 'complex', 'strict',
     'Income 3x rent, verified', 'Townhome end unit, attached garage, W/D in unit, central air.'],
    ['412 Alder St Apt 1', 1725, null, 2, 1, 900, 5, 'unsure', 'AC not mentioned', 'complex',
     'strict', 'Income 2.5x rent', 'Fourplex unit with shared yard. In-unit laundry; cooling not listed.'],
    ['412 Alder St Apt 3', 1799, null, 2, 1, 920, 5, 'unsure', 'AC not mentioned', 'complex',
     'strict', 'Income 2.5x rent', 'Fourplex unit with shared yard. In-unit laundry; cooling not listed.'],
    ['412 Alder St Apt 4', 1850, null, 2, 1.5, 960, 12, 'unsure', 'AC not mentioned', 'complex',
     'strict', 'Income 2.5x rent', 'Fourplex unit with shared yard. In-unit laundry; cooling not listed.'],
    ['37 Willow Bend', 1990, null, 3, 2, 1280, 21, 'unsure', 'Hookups only', 'private',
     'flexible', 'Prepaid rent considered', 'Ranch house, washer/dryer hookups in garage, central AC.'],
    ['1502 Cedar Loop', 2275, null, 4, 2, 1890, 45, 'unsure', 'Whole home not confirmed',
     'manager', 'none_stated', null, 'Listing mentions a converted garage suite; may be let separately.'],
    ['780 Poplar Dr', 1650, null, 2, 1, 850, 3, 'unsure', 'Laundry not mentioned', 'unknown',
     'none_stated', null, 'Duplex half with a small yard. AC listed; no mention of laundry.'],
    ['23 Orchard Ln', 2100, null, 3, 2, 1450, 16, 'pass', null, 'private', 'none_stated', null,
     'Updated kitchen, in-unit laundry, central AC, two-car driveway.'],
    ['309 Sparrow Rd', 1925, null, 3, 1.5, 1210, 60, 'pass', null, 'manager', 'strict',
     'Income 3x rent', 'Split-level house, laundry closet with W/D, heat pump with AC.']
  ];
  var rentals = H.map(function(h, i){
    var bld = h[0].replace(/ Apt \d+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '') + '-00000';
    return { id: 500 + i, address: h[0], city: 'Riverbend', price: h[1], price_was: h[2],
             beds: h[3], baths: h[4], sqft: h[5], days: h[6], photo: null,
             url: 'https://example.com/listing/' + (500 + i), status: 'new', gone: false,
             agent_name: i % 3 ? 'Jordan Lee' : 'Casey Moreno',
             agent_phone: '(555) 010-' + (1200 + i), agent_email: 'leasing' + i + '@example.com',
             notes: h[12], verdict: h[7], verdict_reason: h[8], building: bld,
             landlord: h[9], income_rule: h[10], apply_note: h[11] };
  });
  rentals[0].status = 'interested';
  rentals[10].status = 'contacted';
  rentals[10].gone = true;

  return {
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
    rentals: rentals,
    rental_statuses: ['new', 'interested', 'contacted'],
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
        detail: 'up to $2,500 · File it from the Settlements card.' },
      { tag: 'Rentals', txt: '3 new rentals in Filtered today', detail: 'Open the Rentals tab.' }
    ]
  };
};
