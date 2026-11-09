/* ==========================================================================
   BALANCE — the money card, the spending heatmap and card credits.

   Everything here reads the rows TE holds and redraws when they change, so
   nothing on this page calls the database itself. Writes go out through
   TESAVE, which data.js owns.
   ========================================================================== */


/* ---- complete_from, derived rather than declared ----
   The first month whose data can be trusted. The money card says so on any
   month before it, because a month holding spending without the income beside
   it is a half-import, not a quiet month.

   This used to be a literal in #meta, and it went stale the moment a CSV import
   filled the 2025-03 - 2026-03 gap: the page went on treating three years of
   complete history as partial because nobody remembered to lower a constant.
   A month with outgoings but no income at all is a half-import; the history
   becomes real in the first month after the last of those.

   Recomputed whenever the rows change, because the rows arrive after the page has
   already drawn once with none — a value derived from that first empty pass
   would be wrong the moment the data lands. */
(function(){
  function compute(){
    var rows = TE.rows(), seen = {}, i, r, m;
    for(i = 0; i < rows.length; i++){
      r = rows[i];
      if(r.cat === 'transfer'){ continue; }
      m = r.date.slice(0, 7);
      if(!seen[m]){ seen[m] = { out: 0, inn: 0 }; }
      if(r.amt < 0){ seen[m].out++; } else { seen[m].inn++; }
    }
    var keys = Object.keys(seen).sort(), lastBad = '', i2;
    for(i2 = 0; i2 < keys.length; i2++){
      if(seen[keys[i2]].out > 0 && seen[keys[i2]].inn === 0){ lastBad = keys[i2]; }
    }
    for(i2 = 0; i2 < keys.length; i2++){
      if(keys[i2] > lastBad){ window.__completeFrom = keys[i2]; return; }
    }
  }
  compute();
  TE.subscribe(compute);
})();

/* ---- money: one array in, everything else derived ----
   One month and one category filter, shared by every money card on screen:
   the whole card (money.full) and its pieces (figures, categories,
   transactions). Moving the month in any of them moves all of them. Each
   card draws only the parts its template has. */
(function(){
  var CANON = ['dining','grocery','shopping','utility','gas','travel',
               'income'];
  var MON = ['Jan','Feb','Mar','Apr','May','Jun',
             'Jul','Aug','Sep','Oct','Nov','Dec'];
  var FULL = ['January','February','March','April','May','June','July',
              'August','September','October','November','December'];
  var DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  var I = TEW.list();
  var active = 'all';
  var byMonth = {}, months = [], mi = 0;
  var editable = true;       /* a signed-in viewer can rename any row */

  /* Bucket by calendar month, newest first. mi indexes `months`. */
  function load(rows){
    var list = rows || TE.rows();
    byMonth = {}; months = [];
    list.forEach(function(r){
      var k = r.date.slice(0, 7);
      if(!byMonth[k]){ byMonth[k] = []; months.push(k); }
      byMonth[k].push(r);
    });
    months.sort().reverse();
    if(mi > months.length - 1){ mi = Math.max(0, months.length - 1); }
  }

  /* "2026-09-04" as a LOCAL date; new Date(str) parses it as UTC and shifts
     the day backwards for anyone west of Greenwich. */
  function parse(str){
    var p = str.split('-');
    return new Date(+p[0], (+p[1]) - 1, +p[2]);
  }
  /* whole dollars everywhere, cents cut off rather than rounded (2026-10-19) */
  function money(n){
    var s = '$' + Math.trunc(Math.abs(n)).toLocaleString('en-US');
    return n < 0 ? '−' + s : s;
  }
  function monthName(key){
    var p = key.split('-');
    return FULL[(+p[1]) - 1] + ' ' + p[0];
  }

  function current(){ return months.length ? byMonth[months[mi]] : []; }

  /* the rows the category filter lets through */
  function picked(){
    var all = current();
    return active === 'all' ? all
      : active === 'wedding' ? all.filter(function(r){ return r.wed; })
      : all.filter(function(r){ return r.cat === active && !r.wed; });
  }

  /* --- bar graph: wedding, then everyday spend biggest first, then income ---
     Uncategorized has no bar: it says nothing about where the money went, and
     its charges are filed from Requires Action. They still count in Out.
     A wedding charge leaves its category for one Wedding bar on top, set off
     by a rule with the month's Out without it under that. Every bar is scaled
     to the longest everyday bar or the income bar, whichever is longer, so a
     venue deposit never shrinks the everyday bars to slivers.
     Wedding money in (a guest's room reservation, a gift by Zelle) is income
     like any other; a refund on a wedding purchase comes off the Wedding bar. */
  function buildCats(catBox, list){
    catBox.textContent = '';
    var spend = {}, max = 0, wed = 0, inc = 0, every = 0;
    list.forEach(function(r){
      if(r.amt < 0 && !r.wed){ every += -r.amt; }
      if(r.wed){
        if(r.amt < 0){ wed += -r.amt; }
        else if(r.cat === 'income' || r.cat === 'uncategorized'){ inc += r.amt; }
        else { wed -= r.amt; }
        return;
      }
      if(r.cat === 'income'){ if(r.amt > 0){ inc += r.amt; } return; }
      if(r.amt < 0 && r.cat !== 'uncategorized'){
        spend[r.cat] = (spend[r.cat] || 0) + (-r.amt);
      }
    });
    var bars = Object.keys(spend).sort(function(a,b){ return spend[b]-spend[a]; })
      .map(function(c){ return {tab: c, amt: spend[c], cls: 'cat'}; });
    bars.forEach(function(x){ if(x.amt > max){ max = x.amt; } });
    if(inc > max){ max = inc; }
    if(wed > 0){ bars.unshift({tab: 'wedding', amt: wed, cls: 'cat wed', every: every}); }
    if(inc > 0){ bars.push({tab: 'income', amt: inc, cls: 'cat inc'}); }

    bars.forEach(function(x){
      var c = x.tab;
      var b = document.createElement('button');
      b.className = x.cls + (c === active ? ' on' : '');
      b.type = 'button';
      b.setAttribute('data-tab', c);
      var n = document.createElement('span');
      n.className = 'cat-name'; n.textContent = c;
      var bar = document.createElement('span');
      bar.className = 'cat-bar';
      var fill = document.createElement('i');
      fill.style.width = (max ? Math.min(100, (x.amt / max) * 100) : 100) + '%';
      bar.appendChild(fill);
      var amt = document.createElement('span');
      amt.className = 'cat-amt';
      amt.textContent = '$' + Math.trunc(x.amt).toLocaleString('en-US');
      b.appendChild(n); b.appendChild(bar); b.appendChild(amt);
      b.addEventListener('click', function(){ pick(c); });
      catBox.appendChild(b);
      /* the number the Wedding bar exists for: Out without it, heading the rest */
      if(x.every !== undefined){
        var p = document.createElement('p');
        p.className = 'cat-every';
        p.textContent = 'Without wedding: ' + money(x.every);
        catBox.appendChild(p);
      }
    });
  }

  /* --- tab strip: All, then only the categories present that month.
     Uncategorized gets no tab: its charges are filed from Requires Action.
     Wedding comes last, and a wedding charge counts under it alone. --- */
  function present(list){
    var seen = {};
    list.forEach(function(r){
      var k = r.wed ? 'wedding' : r.cat;
      seen[k] = (seen[k] || 0) + 1;
    });
    return seen;
  }
  function buildTabs(tabBar, seen){
    tabBar.textContent = '';
    var order = CANON.concat('wedding').filter(function(c){ return seen[c]; });
    [{k:'all', l:'All'}].concat(order.map(function(c){ return {k:c, l:c}; }))
      .forEach(function(t){
        var b = document.createElement('button');
        b.className = 'tab';
        b.type = 'button';
        b.setAttribute('data-tab', t.k);
        b.setAttribute('aria-pressed', String(t.k === active));
        b.textContent = t.l;
        b.addEventListener('click', function(){ pick(t.k); });
        tabBar.appendChild(b);
      });
  }

  /* --- the editor: rename a charge, or every charge from that merchant --- */
  /* Saved through page_rename, then every row is read again, so what shows
     is what the database now holds rather than the page's guess at it. */
  function buildEditor(v, r, host, btn){
    var same = TE.countByName(r.desc);
    var name = r.desc;
    var cat = r.cat;
    var scope = same > 1 ? 'merchant' : 'txn';

    var box = document.createElement('div');
    box.className = 'txn-edit';

    var l1 = document.createElement('label');
    l1.className = 'ed-lab'; l1.textContent = 'Name';
    var input = document.createElement('input');
    input.className = 'ed-name'; input.type = 'text'; input.value = name;
    input.setAttribute('aria-label', 'Transaction name');
    box.appendChild(l1); box.appendChild(input);

    var b2 = document.createElement('div');
    b2.className = 'ed-block';
    var l2 = document.createElement('label');
    l2.className = 'ed-lab'; l2.textContent = 'Category';
    var chips = document.createElement('div');
    chips.className = 'ed-chips';
    b2.appendChild(l2); b2.appendChild(chips);
    box.appendChild(b2);

    /* no "uncategorized" chip: a charge is filed here, never unfiled, and
       one with no category is filed from Requires Action */
    var catBtns = [];
    TE.CATS.forEach(function(c){
      var b = document.createElement('button');
      b.className = 'ed-chip'; b.type = 'button';
      b.textContent = c;
      b.setAttribute('data-cat', c);
      b.setAttribute('aria-pressed', String(c === cat));
      b.addEventListener('click', function(){
        cat = c;
        catBtns.forEach(function(x){
          x.setAttribute('aria-pressed',
            String(x.getAttribute('data-cat') === cat));
        });
      });
      catBtns.push(b);
      chips.appendChild(b);
    });

    var b3 = document.createElement('div');
    b3.className = 'ed-block';
    var l3 = document.createElement('label');
    l3.className = 'ed-lab'; l3.textContent = 'Applies to';
    var scopes = document.createElement('div');
    scopes.className = 'ed-chips';
    b3.appendChild(l3); b3.appendChild(scopes);
    box.appendChild(b3);

    var scopeBtns = [];
    [{k:'txn', l:'This charge'},
     {k:'merchant', l:'All'}]
      .forEach(function(s){
        var b = document.createElement('button');
        b.className = 'ed-chip'; b.type = 'button';
        b.textContent = s.l;
        b.setAttribute('data-scope', s.k);
        b.setAttribute('aria-pressed', String(s.k === scope));
        b.addEventListener('click', function(){
          scope = s.k;
          scopeBtns.forEach(function(x){
            x.setAttribute('aria-pressed',
              String(x.getAttribute('data-scope') === scope));
          });
        });
        scopeBtns.push(b);
        scopes.appendChild(b);
      });

    /* per charge whatever "Applies to" says: a merchant is never all wedding */
    var wed = !!r.wed;
    var b4 = document.createElement('div');
    b4.className = 'ed-block';
    var l4 = document.createElement('label');
    l4.className = 'ed-lab'; l4.textContent = 'Wedding (this charge only)';
    var wedBox = document.createElement('div');
    wedBox.className = 'ed-chips';
    var wedBtn = document.createElement('button');
    wedBtn.className = 'ed-chip'; wedBtn.type = 'button';
    wedBtn.textContent = 'wedding';
    wedBtn.setAttribute('aria-pressed', String(wed));
    wedBtn.addEventListener('click', function(){
      wed = !wed;
      wedBtn.setAttribute('aria-pressed', String(wed));
    });
    wedBox.appendChild(wedBtn);
    b4.appendChild(l4); b4.appendChild(wedBox);
    box.appendChild(b4);

    var acts = document.createElement('div');
    acts.className = 'ed-acts';
    var save = document.createElement('button');
    save.className = 'ed-btn go'; save.type = 'button'; save.textContent = 'Save';
    var cancel = document.createElement('button');
    cancel.className = 'ed-btn'; cancel.type = 'button'; cancel.textContent = 'Cancel';
    acts.appendChild(save); acts.appendChild(cancel);
    box.appendChild(acts);

    var note = document.createElement('p');
    note.className = 'ed-note';
    note.textContent = 'Written straight to the database. Naming a merchant '
      + 'also names its future charges.';
    box.appendChild(note);

    function shut(){
      v.openKey = '';
      box.remove();
      btn.classList.remove('open');
    }
    cancel.addEventListener('click', shut);

    save.addEventListener('click', function(){
      var clean = input.value.trim() || r.desc;
      save.disabled = true;
      note.textContent = 'Saving…';
      window.TESAVE({ txn_id: r.id, name: clean,
                      cat: cat === 'uncategorized' ? null : cat,
                      whole: scope === 'merchant',
                      wed: wed === !!r.wed ? undefined : wed }, function(err){
        save.disabled = false;
        if(err){ note.textContent = 'Could not save: ' + err + '.'; return; }
        v.openKey = '';
      });
    });

    host.appendChild(box);
    btn.classList.add('open');
    input.focus();
    return box;
  }

  /* --- the ledger, grouped by day, newest first. Which row's editor is
     open is each card's own, kept across rebuilds. --- */
  function buildLedger(v, list){
    var ledger = v.ledger;
    ledger.textContent = '';
    ledger.classList.toggle('editable', !!editable);
    if(!list.length){
      var p0 = document.createElement('p');
      p0.className = 'caveat';
      p0.style.marginTop = '0';
      p0.textContent = 'Nothing in this category this month.';
      ledger.appendChild(p0);
      return;
    }
    if(editable){
      var hint = document.createElement('p');
      hint.className = 'ed-hint';
      hint.textContent = 'Tap a transaction to rename it, set its category '
        + 'or mark it wedding. '
        + 'Pending ones open once they settle.';
      ledger.appendChild(hint);
    }
    var days = [], byDay = {};
    list.slice().sort(function(a, b){
      if(a.date !== b.date){ return a.date < b.date ? 1 : -1; }
      return Math.abs(b.amt) - Math.abs(a.amt);
    }).forEach(function(r){
      if(!byDay[r.date]){ byDay[r.date] = []; days.push(r.date); }
      byDay[r.date].push(r);
    });

    days.forEach(function(d, i){
      var when = parse(d);
      var wrap = document.createElement('div');
      wrap.className = 'day' + (i === 0 ? ' lead' : '');
      var head = document.createElement('p');
      head.className = 'day-label';
      head.textContent = DAY[when.getDay()] + ' ' + MON[when.getMonth()]
        + ' ' + when.getDate();
      wrap.appendChild(head);

      var box = document.createElement('div');
      box.className = 'txns';
      byDay[d].forEach(function(r){
        var host = document.createElement('div');
        host.className = 'txn-row';
        var canEdit = editable;
        var row = document.createElement(canEdit ? 'button' : 'div');
        row.className = 'txn';
        if(canEdit){ row.type = 'button'; }
        var main = document.createElement('div');
        main.className = 'txn-main';
        var nm = document.createElement('div');
        nm.className = 'txn-name'; nm.textContent = r.desc;
        var mt = document.createElement('div');
        /* the card it went on, then its category */
        mt.className = 'txn-meta';
        mt.textContent = (r.card ? r.card + ' · ' : '') + r.cat
          + (r.wed ? ' · wedding' : '');
        main.appendChild(nm); main.appendChild(mt);
        var amt = document.createElement('div');
        amt.className = 'txn-amt' + (r.amt > 0 ? ' pos' : '');
        amt.textContent = (r.amt > 0 ? '+' : '') + money(r.amt);
        row.appendChild(main); row.appendChild(amt);
        host.appendChild(row);
        box.appendChild(host);

        if(canEdit){
          var key = TE.keyOf(r);
          row.addEventListener('click', function(){
            if(v.openKey === key){
              v.openKey = '';
              var open = host.querySelector('.txn-edit');
              if(open){ open.remove(); }
              row.classList.remove('open');
              return;
            }
            var live = ledger.querySelector('.txn-edit');
            if(live){ live.remove(); }
            var lit = ledger.querySelector('.txn.open');
            if(lit){ lit.classList.remove('open'); }
            v.openKey = key;
            buildEditor(v, r, host, row);
          });
          if(v.openKey === key){ buildEditor(v, r, host, row); }
        }
      });
      wrap.appendChild(box);
      ledger.appendChild(wrap);
    });
  }

  /* One card, whichever parts it has. */
  function draw(v){
    var all = current(), key = months.length ? months[mi] : '';
    var seen = present(all);
    if(active !== 'all' && !seen[active]){ active = 'all'; }
    var list = picked();

    if(v.label){
      v.label.textContent = key ? monthName(key) : 'No transactions';
      /* months[] is newest-first, so a HIGHER index is further back */
      v.next.disabled = mi <= 0;
      v.prev.disabled = mi >= months.length - 1;
    }
    if(v.tabs){ buildTabs(v.tabs, seen); }
    if(v.cats){ buildCats(v.cats, all); }
    v.root.classList.toggle('picked', active !== 'all');

    if(v.in){
      var inSum = 0, outSum = 0;
      list.forEach(function(r){
        if(r.amt > 0){ inSum += r.amt; } else { outSum += -r.amt; }
      });
      v.in.textContent = money(inSum);
      v.out.textContent = money(outSum);
      v.net.textContent = money(inSum - outSum);
    }

    if(v.gap){
      var from = window.__completeFrom || '';
      var thin = from && key && key < from;
      v.gap.hidden = !thin;
      if(thin){
        v.gap.textContent = 'The bank feed only reaches back to '
          + monthName(from) + ', so this month is incomplete: some accounts have '
          + 'no data before then.';
      }
    }

    if(v.ledger && !v.ledger.hidden){ buildLedger(v, list); }
    if(v.ledgerLabel){
      v.ledgerLabel.textContent = (v.ledger.hidden ? 'Show ' : 'Hide ') + list.length
        + (list.length === 1 ? ' transaction' : ' transactions');
    }
    if(v.n){ v.n.textContent = String(list.length); }
  }
  function drawAll(){ I.each(draw); }

  function pick(cat){ active = cat; drawAll(); }

  /* a made-up month: a few charges and a paycheck */
  function sampleRows(){
    return [['Taco Spot', 'dining', -38, 2], ['Noodle Bar', 'dining', -24, 6],
            ['Grocer', 'grocery', -96, 1], ['Grocer', 'grocery', -71, 8],
            ['Hardware', 'shopping', -45, 4], ['Fuel', 'gas', -40, 3],
            ['Payroll', 'income', 3000, 5]].map(function(x, i){
      return {id: 's' + i, date: TEW.ago(x[3]), desc: x[0], cat: x[1], amt: x[2], wed: false, card: 'Card'};
    });
  }

  function mount(root, c){
    var v = {root: root, openKey: ''};
    ['prev', 'next', 'label', 'in', 'out', 'net', 'tabs', 'cats', 'toggle',
     'ledgerLabel', 'ledger', 'gap', 'n'].forEach(function(k){ v[k] = c.r(k); });
    if(c.sample){
      editable = false;
      TEW.swap(function(){ return [byMonth, months, mi, active]; },
        function(o){ byMonth = o[0]; months = o[1]; mi = o[2]; active = o[3]; },
        [{}, [], 0, 'all'], function(){ load(sampleRows()); draw(v); });
      editable = true;
      return;
    }
    if(v.prev){
      v.prev.addEventListener('click', function(){
        if(mi < months.length - 1){ mi++; drawAll(); }
      });
      v.next.addEventListener('click', function(){
        if(mi > 0){ mi--; drawAll(); }
      });
      v.label.addEventListener('click', function(){
        if(mi !== 0){ mi = 0; drawAll(); }
      });
    }
    if(v.toggle){
      v.toggle.addEventListener('click', function(){
        v.ledger.hidden = !v.ledger.hidden;
        v.toggle.setAttribute('aria-expanded', String(!v.ledger.hidden));
        draw(v);
      });
    }
    draw(v);
    return I.add(v);
  }

  TEW.define('money.full', {type: 'Money', version: 'Whole card', title: 'Money', mount: mount});
  TEW.define('money.figures', {type: 'Money', version: 'In, out and net', title: 'Month', mount: mount});
  TEW.define('money.categories', {type: 'Money', version: 'Spend by category', title: 'Spend by Category', tab: 'Categories', mount: mount});
  TEW.define('money.transactions', {type: 'Money', version: 'Transactions', title: 'Transactions', mount: mount});

  TE.subscribe(function(){ load(); drawAll(); });
  load();
})();

/* ---- spending: four calendar weeks of days ----
   Sunday to Saturday, four weeks, this week at the bottom. On Sunday a new row
   starts and the oldest drops off. Nothing is stored: every square is a
   reading of the rows dated that day.

   Charges reach the feed two to three days after they happen and keep the date
   the bank posted them. A single week's figure was never final on the day the
   week ended, which is why the finished weeks stay on screen: their squares
   and totals keep filling in as the late charges land.

   The caps in #budget set the day budget — their weekly total over seven days,
   about $23 — so a square fades from green to grey as its day nears that, then
   runs smoothly from yellow the moment it passes to deep red at deep_red_at,
   $100: anything past that is a real problem or a big purchase. The same
   colour means the same money every week. Both numbers are typed under the
   squares, saved in engine_settings. They also
   colour the week totals: red once a week passes their total, green once a week
   has ended at or under it. A week still running that is under stays
   uncoloured — it has days left to go over in. */
(function(){
  var ORDER = ['dining','grocery','shopping'];
  var MON = ['Jan','Feb','Mar','Apr','May','Jun',
             'Jul','Aug','Sep','Oct','Nov','Dec'];
  var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  /* how many days back a square may still be missing charges */
  var POSTING_LAG = 3;

  var caps = {dining:25, grocery:110, shopping:25}, span = 4, since = '2026-08-01',
      limit = 0, exempt = [],
      top0 = 100;
  try {
    var cfg = JSON.parse(document.getElementById('budget').textContent) || {};
    if(cfg.caps){ caps = cfg.caps; }
    if(cfg.weeks){ span = cfg.weeks; }
    if(cfg.since){ since = cfg.since; }
    if(cfg.leave_out_over){ limit = Number(cfg.leave_out_over) || 0; }
    if(cfg.always_count){ exempt = cfg.always_count; }
    if(cfg.deep_red_at){ top0 = Number(cfg.deep_red_at) || top0; }
  } catch(e){}

  var capTotal = 0;
  ORDER.forEach(function(c){ capTotal += (caps[c] || 0); });
  /* a day's even share of the weekly caps: where grey turns to yellow. The
     page can set its own instead, and a week's line is then seven of that day. */
  var share0 = capTotal / 7, share = share0, topv = top0;

  /* each card has its own grid, scroller, open day and boxes */
  var I = TEW.list();
  var days = {};     /* 'YYYY-MM-DD' -> {total, cat, txns: [{desc, amt, cat, out}]} */

  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function iso(d){
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /* "2026-09-04" as a LOCAL date; new Date(str) reads it as UTC and shifts the
     day backwards for anyone west of Greenwich. */
  function parse(str){
    var p = str.split('-');
    return new Date(+p[0], (+p[1]) - 1, +p[2]);
  }
  function whole(n){ return '$' + Math.trunc(n).toLocaleString('en-US'); }
  var cents = whole;
  function money2(n){
    return '$' + n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  }
  function short(d){ return MON[d.getMonth()] + ' ' + d.getDate(); }
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls){ e.className = cls; }
    if(text !== undefined){ e.textContent = text; }
    return e;
  }

  /* The colour at a day total: green at $0 fading to grey at the budget, then
     yellow the moment it is past, through orange and red, to deep red at the
     top number and beyond. Both numbers are typed under the squares. Mixed in oklab between the theme's stops. */
  function stops(){
    var s = topv - share;
    return [[0, '--heat-g'], [share * 0.6, '--heat-g2'], [share, '--heat-n'],
            [share + 0.01, '--heat-y'], [share + s * 0.35, '--heat-o'],
            [share + s * 0.7, '--heat-r'], [topv, '--heat-r3']];
  }
  function colour(v){
    var st = stops();
    if(v <= 0){ return 'var(' + st[0][1] + ')'; }
    for(var i = 1; i < st.length; i++){
      if(v <= st[i][0]){
        var a = st[i - 1], b = st[i];
        var p = Math.round((v - a[0]) / ((b[0] - a[0]) || 1) * 100);
        return 'color-mix(in oklab, var(' + b[1] + ') ' + p + '%, var(' + a[1] + '))';
      }
    }
    return 'var(' + st[st.length - 1][1] + ')';
  }
  /* dark numbers on the pale greens and yellows, white past halfway to the top */
  function paint(b, v){
    b.style.background = colour(v);
    if(v <= share){ b.className += v <= share * 0.3 ? ' lite' : ''; return; }
    b.className += (v - share) / (topv - share) > 0.5 ? ' hot' : ' lite';
  }

  /* ---- money back, carried to the day it was spent ----
     A refund ("Costco: [refund]" +$23) or a card credit naming the merchant
     ("Platinum Lululemon Credit" +$75) comes off one charge it pays for, on
     that charge's day, so a square shows what the day really cost. The
     merchant is the name before any colon, brackets dropped. A refund wants
     the same merchant; a credit wants its merchant's words inside the
     charge's. The charge is on or before the money back, within BACK_DAYS:
     the exact amount first, then the same card, then the latest. A credit
     naming no merchant ("Amex Dining Credit") finds nothing and changes
     nothing. Returns charge id -> [{amt, desc, date}]. */
  var BACK_DAYS = 60;
  function merchant(desc){
    return String(desc).split(':')[0].replace(/\[[^\]]*\]/g, ' ')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function matchBacks(rows){
    var charges = rows.filter(function(r){ return r.amt < 0; })
      .map(function(r){ return {r: r, key: merchant(r.desc), left: -r.amt}; });
    var backs = {};
    rows.filter(function(r){ return r.amt > 0; })
      .sort(function(a, b){ return a.date < b.date ? -1 : 1; })
      .forEach(function(c){
        var key = merchant(c.desc), credit = / credit$/.test(key);
        if(credit){
          key = key.replace(/ credit$/, '')
            .replace(/^((amex|american express|platinum|gold|green) )+/, '').trim();
        }
        if(key.length < 3){ return; }
        var cut = iso(new Date(parse(c.date).getTime() - BACK_DAYS * 86400000));
        var fits = charges.filter(function(x){
          return x.left > 0.005 && x.r.date <= c.date && x.r.date >= cut
            && (credit ? (' ' + x.key + ' ').indexOf(' ' + key + ' ') !== -1
                       : x.key === key);
        });
        if(!fits.length){ return; }
        function exact(x){ return Math.abs(x.left - c.amt) < 0.005 ? 1 : 0; }
        fits.sort(function(a, b){
          return (exact(b) - exact(a))
            || ((b.r.card === c.card) - (a.r.card === c.card))
            || (a.r.date < b.r.date ? 1 : a.r.date > b.r.date ? -1 : 0);
        });
        var x = fits[0], take = Math.min(c.amt, x.left);
        x.left -= take;
        (backs[x.r.id] || (backs[x.r.id] = []))
          .push({amt: take, desc: c.desc, date: c.date});
      });
    return backs;
  }

  function tally(list){
    var rows = list || TE.rows(), i, r, d;
    var backs = matchBacks(rows);
    days = {};
    for(i = 0; i < rows.length; i++){
      r = rows[i];
      if(!(r.amt < 0) || !Object.prototype.hasOwnProperty.call(caps, r.cat)){ continue; }
      d = days[r.date] || (days[r.date] = {total: 0, cat: {}, txns: []});
      var back = (backs[r.id] || []).reduce(function(n, b){ return n + b.amt; }, 0);
      var net = Math.max(0, -r.amt - back);
      /* too large to be a treat: listed in the day's detail, not counted */
      var desc = r.desc.toLowerCase();
      var out = limit > 0 && net > limit && !exempt.some(function(m){
        return desc.indexOf(m) !== -1;
      });
      d.txns.push({desc: r.desc, amt: net, was: -r.amt, backs: backs[r.id] || [],
                   cat: r.cat, out: out, wed: !!r.wed});
      /* wedding charges are listed but never count toward the day */
      if(out || r.wed){ continue; }
      d.cat[r.cat] = (d.cat[r.cat] || 0) + net;
      d.total += net;
    }
  }

  function showDetail(v){
    var detail = v.detail;
    detail.textContent = '';
    if(!v.picked){
      detail.textContent = 'Tap a day to see what was spent.';
      return;
    }
    var when = parse(v.picked), d = days[v.picked] || {total: 0, cat: {}, txns: []};
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var head = el('div', 'day-head');
    head.appendChild(el('b', '', DAYS[when.getDay()] + ', ' + short(when)));
    head.appendChild(el('span', 'day-total', cents(d.total)));
    detail.appendChild(head);
    if(d.txns.length){
      var list = el('ul', 'day-txns');
      d.txns.slice().sort(function(a, b){ return b.amt - a.amt; }).forEach(function(t){
        var li = el('li', 'day-txn' + (t.out || t.wed ? ' out' : ''));
        var name = el('span', 'day-txn-name', t.desc);
        name.appendChild(el('span', 'day-txn-meta', t.cat
          + (t.wed ? ' · wedding, not counted'
             : t.out ? ' · left out, over ' + whole(limit) : '')));
        t.backs.forEach(function(bk){
          name.appendChild(el('span', 'day-txn-meta day-txn-back',
            '\u2212' + money2(bk.amt) + ' ' + bk.desc + ', ' + short(parse(bk.date))));
        });
        li.appendChild(name);
        var amtEl = el('span', 'day-txn-amt');
        if(t.backs.length){
          amtEl.appendChild(el('s', 'day-txn-was', money2(t.was)));
          amtEl.appendChild(document.createTextNode(' '));
        }
        amtEl.appendChild(document.createTextNode(t.backs.length ? money2(t.amt) : cents(t.amt)));
        li.appendChild(amtEl);
        list.appendChild(li);
      });
      detail.appendChild(list);
    }
    if((today - when) / 86400000 < POSTING_LAG){
      detail.appendChild(el('span', 'late',
        'Charges from the last few days may still be posting.'));
    }
  }

  function render(){
    tally();
    I.each(draw);
  }

  function draw(v){
    var grid = v.heat;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var todayIso = iso(today);
    var sunday = new Date(today);
    sunday.setDate(sunday.getDate() - today.getDay());
    /* every week from the one holding `since` down to this week at the
       bottom; the box shows four weeks (balance.css), opens at the bottom
       and scrolls up to the older ones */
    var oldest = parse(since);
    oldest.setDate(oldest.getDate() - oldest.getDay());
    var weeks = Math.max(span, Math.round((sunday - oldest) / (7 * 86400000)) + 1);

    var keep = v.scroller ? v.scroller.scrollTop : 0;
    grid.textContent = '';
    var headRow = el('div', 'heat');
    headRow.appendChild(el('span', 'heat-h', ''));
    ['S','M','T','W','T','F','S'].forEach(function(h){
      headRow.appendChild(el('span', 'heat-h', h));
    });
    headRow.appendChild(el('span', 'heat-h', 'week'));
    grid.appendChild(headRow);
    /* a column-reverse box starts at its bottom, and its scrollTop counts
       up from there, so keeping it keeps the place across a reload */
    var scroller = v.scroller = el('div', 'heat-scroll');
    grid.appendChild(scroller);
    grid = el('div', 'heat');
    scroller.appendChild(grid);

    for(var w = weeks - 1; w >= 0; w--){
      var start = new Date(sunday);
      start.setDate(start.getDate() - 7 * w);
      grid.appendChild(el('span', 'heat-wk' + (w === 0 ? ' now' : ''), short(start)));
      var total = 0;
      for(var k = 0; k < 7; k++){
        var day = new Date(start);
        day.setDate(day.getDate() + k);
        var key = iso(day);
        var b = el('button', 'heat-d', String(day.getDate()));
        b.type = 'button';
        if(day > today){
          b.className += ' future';
          b.disabled = true;
          b.setAttribute('aria-label', short(day) + ', still to come');
        } else {
          var spent = (days[key] || {total: 0}).total;
          total += spent;
          var unposted = spent <= 0 && (today - day) / 86400000 < POSTING_LAG;
          if(!unposted){ paint(b, spent); }
          b.className += key === todayIso ? ' today' : '';
          b.setAttribute('aria-label', short(day) + ', ' + whole(spent));
          b.setAttribute('aria-pressed', String(key === v.picked));
          (function(k2){
            b.addEventListener('click', function(){
              v.picked = v.picked === k2 ? '' : k2;
              draw(v);
            });
          })(key);
        }
        grid.appendChild(b);
      }
      var last = new Date(start);
      last.setDate(last.getDate() + 6);
      var verdict = total > share * 7 ? ' over' : (last < today ? ' under' : '');
      grid.appendChild(el('span', 'heat-tot' + verdict, whole(total)));
    }
    scroller.scrollTop = keep;

    drawBar(v);

    showDetail(v);
  }

  /* ---- the two numbers under the squares ----
     Typed boxes: the day budget (grey) and where the colour reaches deep red.
     Built once, so a render never wipes a box mid-typing; a value saves a
     moment after the last keystroke, and only once it makes sense (the top at
     least $10 over the budget). */
  var saveTimer = {};
  function save(v, key, val){
    clearTimeout(saveTimer[key]);
    saveTimer[key] = setTimeout(function(){
      window.TERPC('page_setting_set', {p_key: key, p_value: val}, function(err){
        if(err){ v.detail.textContent = 'Could not save: ' + err + '.'; }
      });
    }, 700);
  }
  function box(v, label, unit, key){
    var w = el('label', 'hs-num');
    w.appendChild(el('span', 'hs-lab', label));
    var f = el('span', 'hs-field');
    f.appendChild(el('span', '', '$'));
    var inp = el('input', 'hs-in');
    inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = '1'; inp.step = '1';
    f.appendChild(inp);
    if(unit){ f.appendChild(el('span', '', unit)); }
    w.appendChild(f);
    inp.addEventListener('input', function(){
      var n = Math.round(Number(inp.value));
      if(!(n >= 1 && n <= 99999)){ return; }
      var d = key === 'heat_day' ? n : share, t = key === 'heat_top' ? n : topv;
      if(t < d + 10){ return; }
      if(key === 'heat_day'){ share = n; } else { topv = n; }
      save(v, key, n);
      render();
    });
    /* leaving a box with nonsense in it puts back the number in use */
    inp.addEventListener('blur', function(){ drawBar(v); });
    return {w: w, inp: inp};
  }
  function drawBar(v){
    var boxes = v.boxes;
    if(!boxes){
      v.legend.textContent = '';
      boxes = v.boxes = {day: box(v, 'Budget', '/day', 'heat_day'),
                         top: box(v, 'Red at', '', 'heat_top')};
      v.legend.appendChild(boxes.day.w);
      v.legend.appendChild(boxes.top.w);
    }
    [[boxes.day.inp, share], [boxes.top.inp, topv]].forEach(function(x){
      if(document.activeElement !== x[0]){ x[0].value = String(Math.round(x[1])); }
    });
  }

  /* the saved settings, handed over by data.js on every load */
  window.TEBUDGET = {
    set: function(st){
      st = st || {};
      share = Number(st.heat_day) || share0;
      topv = Number(st.heat_top) || top0;
      if(topv < share + 10){ topv = Math.round(share) + 10; }
      render();
    }
  };

  TEW.define('balance.spending', {type: 'Spending', version: 'Heatmap', title: 'Spending',
    mount: function(root, c){
      var v = {heat: c.r('heat'), legend: c.r('legend'), detail: c.r('detail'),
               scroller: null, picked: '', boxes: null};
      if(c.sample){
        /* three weeks of made-up days, a few of them over the budget */
        var rows = [];
        for(var k = 0; k < 18; k++){
          rows.push({id: 's' + k, date: TEW.ago(k), desc: 'Shop', cat: ORDER[k % 3],
                     amt: -[8, 22, 14, 41, 5, 30, 64][k % 7], wed: false});
        }
        TEW.swap(function(){ return [days, since, span]; },
          function(o){ days = o[0]; since = o[1]; span = o[2]; },
          [{}, TEW.ago(20), 3], function(){ tally(rows); draw(v); });
        return;
      }
      draw(v);
      return I.add(v);
    }});

  TE.subscribe(render);
  tally();
})();

/* ---- card credits: cycle maths, sorting, and what has been claimed ----
   The credits themselves are rows in accountant_credits, so this public file
   names no card and no benefit. Nothing here is tappable: a tap used to mark a
   credit used, which was a claim the page had no way to check.

   Claimed is the larger of two figures, both of them the accountant's: the
   statement credits the issuer posted, matched to a row by the name the issuer
   gives each one, and whatever the accountant last recorded off the issuer's
   own site for this cycle. The larger, not the sum, because the site's figure
   already counts the postings. Uber Cash never reaches the statement, so the
   recorded figure is its only one, and a credit whose cycle has rolled starts
   empty again on its own — no cron, no reset. */
var TECRED = (function(){
  var I = TEW.list();
  var MON = ['Jan','Feb','Mar','Apr','May','Jun',
             'Jul','Aug','Sep','Oct','Nov','Dec'];
  var items = [];  /* {def}, in sort_order, which is also match priority */
  var due = [];    /* credits inside SOON days with money left, for To Do */
  /* A deadline this close turns the days yellow, and puts the credit on the
     To Do card on Alerts. One number for both, so they cannot disagree. */
  var SOON = 14;
  var fed = {};    /* id -> dollars the issuer has posted against it this cycle */

  function pad(n){ return (n < 10 ? '0' : '') + n; }

  /* The window a credit is sitting in today. */
  function cycleOf(period, d){
    var y = d.getFullYear(), m = d.getMonth();
    if(period === 'monthly'){ return y + '-' + pad(m + 1); }
    if(period === 'quarterly'){ return y + '-Q' + (Math.floor(m / 3) + 1); }
    if(period === 'semiannual'){ return y + '-H' + (m < 6 ? 1 : 2); }
    return String(y);
  }

  /* Last day the credit can still be spent in that window. */
  function endOf(period, d){
    var y = d.getFullYear(), m = d.getMonth();
    if(period === 'monthly'){ return new Date(y, m + 1, 0); }
    if(period === 'quarterly'){ return new Date(y, Math.floor(m / 3) * 3 + 3, 0); }
    if(period === 'semiannual'){ return new Date(y, m < 6 ? 6 : 12, 0); }
    return new Date(y, 12, 0);
  }

  function money(n){
    return '$' + Math.trunc(n).toLocaleString('en-US');
  }

  var exact = money;

  /* A credit worth more in December than the rest of the year. */
  function amtOf(def, d){
    return Number(def.amt_dec && d.getMonth() === 11 ? def.amt_dec : def.amt);
  }

  /* "2026-09-04" as a LOCAL date, so a posting on the 1st lands in the month
     it says rather than the day before. */
  function parse(str){
    var p = String(str).split('-');
    return new Date(+p[0], (+p[1]) - 1, +p[2]);
  }

  function span(cls, text){
    var el = document.createElement('span');
    el.className = cls;
    if(text !== undefined){ el.textContent = text; }
    return el;
  }

  function build(defs){
    items = (defs || []).map(function(def){ return {def: def}; });
  }

  /* a fresh row for one card; every copy of the card gets its own */
  function rowEl(def){
      var b = document.createElement('div');
      b.className = 'cred';
      var top = span('cred-top');
      var title = span('cred-title');
      if(def.icon){
        var img = document.createElement('img');
        img.className = 'cred-icon';
        img.alt = '';
        img.loading = 'lazy';
        img.src = 'icons/' + encodeURIComponent(def.icon) + '.png';
        img.addEventListener('error', function(){ img.remove(); });
        title.appendChild(img);
      }
      title.appendChild(span('cred-name', def.name));
      top.appendChild(title);
      top.appendChild(span('cred-amt'));
      var track = span('cred-track');
      track.appendChild(document.createElement('i'));
      var legend = span('cred-legend');
      legend.appendChild(span('cl-l'));
      legend.appendChild(span('cl-r'));
      b.appendChild(top);
      b.appendChild(span('cred-meta'));
      b.appendChild(track);
      b.appendChild(legend);
      return b;
  }

  /* Soonest deadline first. Every credit is its own row: folding the ones that
     sit on both cards hid the deadline, which is the only thing that says
     which one to spend this month. Uber Cash is the exception, and one row in
     the table: both cards load it into one Uber balance with one deadline. */
  function render(){
    due = [];
    var first = true;
    I.each(function(v){ draw(v, first); first = false; });
    if(first){ draw(null, true); }
  }

  /* record: work out the credits due for To Do on this pass */
  function draw(v, record){
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var list = [], open = 0;

    items.forEach(function(item){
      var def = item.def, row = rowEl(def);
      var end = endOf(def.period, today);
      var amt = amtOf(def, today);
      var cyc = cycleOf(def.period, today);
      /* The cycle the accountant wrote, or failing that the cycle the date it
         was read falls in — a figure filed under the wrong cycle string should
         not silently read as nothing claimed. */
      var inCycle = def.claimed_cycle === cyc || (def.claimed_as_of &&
        cycleOf(def.period, parse(def.claimed_as_of)) === cyc);
      var reported = inCycle ? Number(def.claimed) || 0 : 0;
      var claimed = Math.min(amt, Math.round(
        Math.max(reported, fed[def.id] || 0) * 100) / 100);
      /* within a cent counts as full, so a rounding penny never leaves a
         credit reading "$0.01 to go" */
      var isUsed = claimed >= amt - 0.005;
      var left = Math.max(0, amt - claimed);
      var days = Math.max(0, Math.round((end - today) / 86400000));

      row.className = 'cred' + (isUsed ? ' used' : '');
      row.querySelector('.cred-amt').textContent = exact(amt);
      row.querySelector('.cred-track i').style.width =
        (amt > 0 ? (claimed / amt) * 100 : 0) + '%';
      row.querySelector('.cl-l').textContent = exact(claimed) + ' claimed';
      var right = row.querySelector('.cl-r');
      right.textContent = isUsed ? 'Claimed' : exact(left) + ' to go';
      right.className = 'cl-r' + (!isUsed && days <= SOON ? ' soon' : '');

      var meta = row.querySelector('.cred-meta');
      meta.textContent = def.card + ' · ';
      var when = document.createElement('span');
      when.textContent = days + (days === 1 ? ' day left' : ' days left');
      if(days <= SOON){ when.className = 'soon'; }
      /* remind false keeps a credit he does not chase off To Do. A credit with
         expected_day pays itself (a subscription on the card): it is nudged
         only once that day of the month has passed with nothing posted. */
      var late = !def.expected_day ||
        (claimed <= 0 && today.getDate() > def.expected_day);
      if(record && !isUsed && days <= SOON && def.remind !== false && late){
        due.push({ name: def.name, card: def.card, left: left, days: days,
                   end: end, ends: MON[end.getMonth()] + ' ' + end.getDate() });
      }
      meta.appendChild(when);
      var tail = ' · ends ' + MON[end.getMonth()] + ' ' + end.getDate();
      /* Where the claimed figure came from, so a number nobody recognises can
         be traced: a date means the accountant read it off the issuer's site. */
      if(reported > 0 && reported >= (fed[def.id] || 0) && def.claimed_as_of){
        var on = parse(def.claimed_as_of);
        tail += ' · read ' + MON[on.getMonth()] + ' ' + on.getDate();
      } else if(!def.match){
        tail += ' · not on the statement';
      }
      meta.appendChild(document.createTextNode(tail));

      open += left;
      list.push({ row: row, end: end, amt: amt });
    });

    /* soonest first, and the bigger credit first where two end together */
    list.sort(function(a, b){ return (a.end - b.end) || (b.amt - a.amt); });
    if(!v){ return; }
    v.body.textContent = '';
    for(var i = 0; i < list.length; i++){ v.body.appendChild(list[i].row); }
    v.open.textContent = money(open) + ' open';
  }

  TEW.define('balance.credits', {type: 'Credits', version: 'List', title: 'Credits',
    mount: function(root, c){
      var v = {body: c.r('body'), open: c.r('open')};
      if(c.sample){
        TEW.swap(function(){ return [items, fed]; }, function(o){ items = o[0]; fed = o[1]; },
          [[{def: {id: 's1', name: 'Dining', card: 'Card', period: 'monthly', amt: 10,
                   claimed: 4, claimed_as_of: TEW.ago(0), match: 'x'}},
            {def: {id: 's2', name: 'Streaming', card: 'Card', period: 'monthly', amt: 20,
                   claimed: 20, claimed_as_of: TEW.ago(0), match: 'x'}}], {}],
          function(){ draw(v, false); });
        return;
      }
      draw(v, false);
      return I.add(v);
    }});

  /* A posting counts toward the first credit on the same card whose match is
     in its description, and only inside the cycle in force today — last
     quarter's credit is history. */
  function feed(postings){
    var today = new Date();
    fed = {};
    (postings || []).forEach(function(t){
      var desc = String(t.desc || '').toLowerCase();
      var amt = Number(t.amt);
      if(!(amt > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(t.d || ''))){ return; }
      for(var j = 0; j < items.length; j++){
        var def = items[j].def;
        if(!def.match || def.card !== t.card){ continue; }
        if(desc.indexOf(def.match) === -1){ continue; }
        if(cycleOf(def.period, parse(t.d)) === cycleOf(def.period, today)){
          fed[def.id] = (fed[def.id] || 0) + amt;
        }
        break;
      }
    });
  }

  return {
    set: function(defs, postings){ build(defs); feed(postings); render(); },
    /* soonest first; the bigger credit first where two end together */
    due: function(){
      return due.slice().sort(function(a, b){
        return (a.end - b.end) || (b.left - a.left);
      });
    }
  };
})();
