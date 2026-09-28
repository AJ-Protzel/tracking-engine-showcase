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
   The navigator picks a month; the figures, tabs, bars and ledger are all
   rebuilt for whichever is showing. */
(function(){
  var CANON = ['dining','grocery','shopping','utility','gas','travel',
               'income'];
  var MON = ['Jan','Feb','Mar','Apr','May','Jun',
             'Jul','Aug','Sep','Oct','Nov','Dec'];
  var FULL = ['January','February','March','April','May','June','July',
              'August','September','October','November','December'];
  var DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  var card = document.getElementById('moneyCard');
  var tabBar = document.getElementById('tabs');
  var catBox = document.getElementById('cats');
  var ledger = document.getElementById('ledger');
  var toggle = document.getElementById('ledgerToggle');
  var label = document.getElementById('ledgerLabel');
  var figIn = document.getElementById('figIn');
  var figOut = document.getElementById('figOut');
  var figNet = document.getElementById('figNet');
  var gapNote = document.getElementById('gapNote');
  var mPrev = document.getElementById('mPrev');
  var mNext = document.getElementById('mNext');
  var mLabel = document.getElementById('monthLabel');
  var active = 'all';

  var byMonth = {}, months = [], mi = 0;
  var editable = true;       /* a signed-in viewer can rename any row */
  var openKey = '';          /* the row whose editor is open, across rebuilds */

  /* Bucket by calendar month, newest first. mi indexes `months`. */
  function load(){
    var list = TE.rows();
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
  function money(n){
    var s = '$' + Math.abs(n).toLocaleString('en-US',
      {minimumFractionDigits:2, maximumFractionDigits:2});
    return n < 0 ? '−' + s : s;
  }
  function monthName(key){
    var p = key.split('-');
    return FULL[(+p[1]) - 1] + ' ' + p[0];
  }

  function current(){ return months.length ? byMonth[months[mi]] : []; }

  /* --- bar graph: spend only, biggest first, for the month on screen ---
     Uncategorized has no bar: it says nothing about where the money went, and
     its charges are filed from the Alerts page. They still count in Out. */
  function buildCats(list){
    catBox.textContent = '';
    var spend = {}, max = 0;
    list.forEach(function(r){
      if(r.amt < 0 && r.cat !== 'uncategorized'){
        spend[r.cat] = (spend[r.cat] || 0) + (-r.amt);
      }
    });
    var keys = Object.keys(spend).sort(function(a,b){ return spend[b]-spend[a]; });
    keys.forEach(function(c){ if(spend[c] > max){ max = spend[c]; } });

    keys.forEach(function(c){
      var b = document.createElement('button');
      b.className = 'cat';
      b.type = 'button';
      b.setAttribute('data-tab', c);
      var n = document.createElement('span');
      n.className = 'cat-name'; n.textContent = c;
      var bar = document.createElement('span');
      bar.className = 'cat-bar';
      var fill = document.createElement('i');
      fill.style.width = (max ? (spend[c] / max) * 100 : 0) + '%';
      bar.appendChild(fill);
      var amt = document.createElement('span');
      amt.className = 'cat-amt';
      amt.textContent = '$' + spend[c].toLocaleString('en-US',
        {minimumFractionDigits:2, maximumFractionDigits:2});
      b.appendChild(n); b.appendChild(bar); b.appendChild(amt);
      b.addEventListener('click', function(){ pick(c); });
      catBox.appendChild(b);
    });
  }

  /* --- tab strip: All, then only the categories present that month.
     Uncategorized gets no tab: its charges are filed from the Alerts page. --- */
  function buildTabs(list){
    tabBar.textContent = '';
    var present = {};
    list.forEach(function(r){ present[r.cat] = (present[r.cat] || 0) + 1; });
    var order = CANON.filter(function(c){ return present[c]; });

    [{k:'all', l:'All'}].concat(order.map(function(c){ return {k:c, l:c}; }))
      .forEach(function(t){
        var b = document.createElement('button');
        b.className = 'tab';
        b.type = 'button';
        b.setAttribute('data-tab', t.k);
        b.textContent = t.l;
        b.addEventListener('click', function(){ pick(t.k); });
        tabBar.appendChild(b);
      });
    return present;
  }

  /* --- the editor: rename a charge, or every charge from that merchant --- */
  /* Saved through page_rename, then every row is read again, so what shows
     is what the database now holds rather than the page's guess at it. */
  function buildEditor(r, host, btn){
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
       one with no category is filed from the Alerts page */
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
      openKey = '';
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
                      whole: scope === 'merchant' }, function(err){
        save.disabled = false;
        if(err){ note.textContent = 'Could not save: ' + err + '.'; return; }
        openKey = '';
      });
    });

    host.appendChild(box);
    btn.classList.add('open');
    input.focus();
    return box;
  }

  /* --- the ledger, grouped by day, newest first --- */
  function buildLedger(list){
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
      hint.textContent = 'Tap a transaction to rename it or set its category. '
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
        /* a pending row is rewritten by every bank pull, so it waits */
        var canEdit = editable && !r.prov;
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
        mt.textContent = (r.card ? r.card + ' · ' : '') + r.cat;
        if(r.prov){
          mt.appendChild(document.createTextNode(' · '));
          var pv = document.createElement('span');
          pv.className = 'prov'; pv.textContent = 'pending';
          mt.appendChild(pv);
        }
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
            if(openKey === key){
              openKey = '';
              var open = host.querySelector('.txn-edit');
              if(open){ open.remove(); }
              row.classList.remove('open');
              return;
            }
            var live = ledger.querySelector('.txn-edit');
            if(live){ live.remove(); }
            var lit = ledger.querySelector('.txn.open');
            if(lit){ lit.classList.remove('open'); }
            openKey = key;
            buildEditor(r, host, row);
          });
          if(openKey === key){ buildEditor(r, host, row); }
        }
      });
      wrap.appendChild(box);
      ledger.appendChild(wrap);
    });
  }

  /* Rebuild everything for the month on screen, keeping the chosen category
     when that month also has it. */
  function showMonth(){
    var list = current();
    var key = months.length ? months[mi] : '';

    mLabel.textContent = key ? monthName(key) : 'No transactions';
    /* months[] is newest-first, so a HIGHER index is further back */
    mNext.disabled = mi <= 0;
    mPrev.disabled = mi >= months.length - 1;

    var present = buildTabs(list);
    buildCats(list);
    if(active !== 'all' && !present[active]){ active = 'all'; }

    var from = window.__completeFrom || '';
    var thin = from && key && key < from;
    gapNote.hidden = !thin;
    if(thin){
      gapNote.textContent = 'The bank feed only reaches back to '
        + monthName(from) + ', so this month is incomplete — some accounts have '
        + 'no data before then.';
    }
    pick(active);
  }

  function pick(cat){
    active = cat;
    var all = current();
    var list = cat === 'all' ? all
      : all.filter(function(r){ return r.cat === cat; });

    var inSum = 0, outSum = 0;
    list.forEach(function(r){
      if(r.amt > 0){ inSum += r.amt; } else { outSum += -r.amt; }
    });
    figIn.textContent = money(inSum);
    figOut.textContent = money(outSum);
    figNet.textContent = money(inSum - outSum);

    Array.prototype.forEach.call(tabBar.children, function(b){
      b.setAttribute('aria-pressed',
        String(b.getAttribute('data-tab') === cat));
    });
    Array.prototype.forEach.call(catBox.children, function(b){
      b.classList.toggle('on', b.getAttribute('data-tab') === cat);
    });
    card.classList.toggle('picked', cat !== 'all');

    buildLedger(list);
    label.textContent = (ledger.hidden ? 'Show ' : 'Hide ') + list.length
      + (list.length === 1 ? ' transaction' : ' transactions');
  }

  mPrev.addEventListener('click', function(){
    if(mi < months.length - 1){ mi++; showMonth(); }
  });
  mNext.addEventListener('click', function(){
    if(mi > 0){ mi--; showMonth(); }
  });
  mLabel.addEventListener('click', function(){
    if(mi !== 0){ mi = 0; showMonth(); }
  });

  toggle.addEventListener('click', function(){
    ledger.hidden = !ledger.hidden;
    toggle.setAttribute('aria-expanded', String(!ledger.hidden));
    pick(active);
  });

  TE.subscribe(function(){ load(); showMonth(); });
  load();
  showMonth();

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
   about $23 — so a square is green while its day is within that and red once it
   is past, and the same colour means the same money every week. They also
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

  var caps = {dining:25, grocery:110, shopping:25}, span = 4, limit = 0, exempt = [],
      deep = 0;
  try {
    var cfg = JSON.parse(document.getElementById('budget').textContent) || {};
    if(cfg.caps){ caps = cfg.caps; }
    if(cfg.weeks){ span = cfg.weeks; }
    if(cfg.leave_out_over){ limit = Number(cfg.leave_out_over) || 0; }
    if(cfg.always_count){ exempt = cfg.always_count; }
    if(cfg.deep_red_over){ deep = Number(cfg.deep_red_over) || 0; }
  } catch(e){}

  var capTotal = 0;
  ORDER.forEach(function(c){ capTotal += (caps[c] || 0); });
  /* a day's even share of the weekly caps: where green turns red */
  var share = capTotal / 7;

  var grid = document.getElementById('budHeat');
  var legend = document.getElementById('budLegend');
  var detail = document.getElementById('budDetail');
  var picked = '';   /* the day whose breakdown is open, kept across reloads */
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
  function whole(n){ return '$' + Math.round(n).toLocaleString('en-US'); }
  function cents(n){
    return '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  }
  function short(d){ return MON[d.getMonth()] + ' ' + d.getDate(); }
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls){ e.className = cls; }
    if(text !== undefined){ e.textContent = text; }
    return e;
  }

  /* g2 up to a third of the day's share, g1 up to two thirds, n up to the
     share, r1 up to twice it, r2 beyond, r3 past the flat deep_red_over */
  function shade(v){
    if(deep > 0 && v > deep){ return 'r3'; }
    if(v <= share / 3){ return 'g2'; }
    if(v <= share * 2 / 3){ return 'g1'; }
    if(v <= share){ return 'n'; }
    if(v <= share * 2){ return 'r1'; }
    return 'r2';
  }

  function tally(){
    var rows = TE.rows(), i, r, d;
    days = {};
    for(i = 0; i < rows.length; i++){
      r = rows[i];
      if(!(r.amt < 0) || !Object.prototype.hasOwnProperty.call(caps, r.cat)){ continue; }
      d = days[r.date] || (days[r.date] = {total: 0, cat: {}, txns: []});
      /* too large to be a treat: listed in the day's detail, not counted */
      var desc = r.desc.toLowerCase();
      var out = limit > 0 && -r.amt > limit && !exempt.some(function(m){
        return desc.indexOf(m) !== -1;
      });
      d.txns.push({desc: r.desc, amt: -r.amt, cat: r.cat, out: out, pending: r.prov});
      if(out){ continue; }
      d.cat[r.cat] = (d.cat[r.cat] || 0) + (-r.amt);
      d.total += -r.amt;
    }
  }

  function showDetail(){
    detail.textContent = '';
    if(!picked){
      detail.textContent = 'Tap a day to see what was spent.';
      return;
    }
    var when = parse(picked), d = days[picked] || {total: 0, cat: {}, txns: []};
    var today = new Date(); today.setHours(0, 0, 0, 0);
    detail.appendChild(el('b', '', DAYS[when.getDay()] + ', ' + short(when)));
    detail.appendChild(document.createTextNode(' · ' + cents(d.total) + ' spent'));
    detail.appendChild(el('span', 'cats-line',
      ORDER.map(function(c){ return c + ' ' + cents(d.cat[c] || 0); }).join(' · ')));
    if(d.txns.length){
      var list = el('ul', 'day-txns');
      d.txns.slice().sort(function(a, b){ return b.amt - a.amt; }).forEach(function(t){
        var li = el('li', 'day-txn' + (t.out ? ' out' : ''));
        var name = el('span', 'day-txn-name', t.desc);
        name.appendChild(el('span', 'day-txn-meta', t.cat
          + (t.pending ? ' · pending' : '')
          + (t.out ? ' · left out, over ' + whole(limit) : '')));
        li.appendChild(name);
        li.appendChild(el('span', 'day-txn-amt', cents(t.amt)));
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
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var todayIso = iso(today);
    var sunday = new Date(today);
    sunday.setDate(sunday.getDate() - today.getDay());
    var first = new Date(sunday);
    first.setDate(first.getDate() - 7 * (span - 1));

    grid.textContent = '';
    grid.appendChild(el('span', 'heat-h', ''));
    ['S','M','T','W','T','F','S'].forEach(function(h){
      grid.appendChild(el('span', 'heat-h', h));
    });
    grid.appendChild(el('span', 'heat-h', 'week'));

    for(var w = 0; w < span; w++){
      var start = new Date(first);
      start.setDate(start.getDate() + 7 * w);
      grid.appendChild(el('span', 'heat-wk' + (w === span - 1 ? ' now' : ''), short(start)));
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
          b.className += (unposted ? '' : ' ' + shade(spent))
            + (key === todayIso ? ' today' : '');
          b.setAttribute('aria-label', short(day) + ', ' + whole(spent));
          b.setAttribute('aria-pressed', String(key === picked));
          (function(k2){
            b.addEventListener('click', function(){
              picked = picked === k2 ? '' : k2;
              render();
            });
          })(key);
        }
        grid.appendChild(b);
      }
      var last = new Date(start);
      last.setDate(last.getDate() + 6);
      var verdict = total > capTotal ? ' over' : (last < today ? ' under' : '');
      grid.appendChild(el('span', 'heat-tot' + verdict, whole(total)));
    }

    legend.textContent = '';
    legend.appendChild(el('span', '', '$0'));
    ['g2', 'g1', 'n', 'r1', 'r2'].concat(deep > 0 ? ['r3'] : []).forEach(function(c){
      if(c === 'r1'){ legend.appendChild(el('span', '', whole(share) + '/day')); }
      if(c === 'r3'){ legend.appendChild(el('span', '', whole(deep))); }
      legend.appendChild(el('i', 'heat-d ' + c));
    });
    legend.appendChild(el('span', '', 'more'));

    showDetail();
  }

  TE.subscribe(render);
  render();
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
  var body = document.getElementById('credsBody');
  var openEl = document.getElementById('creditsOpen');
  var MON = ['Jan','Feb','Mar','Apr','May','Jun',
             'Jul','Aug','Sep','Oct','Nov','Dec'];
  var items = [];  /* {def, el}, in sort_order, which is also match priority */
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
    return '$' + n.toLocaleString('en-US', {maximumFractionDigits:0});
  }

  /* Cents only where a credit actually has them. */
  function exact(n){
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: (n % 1 === 0) ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

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
    items = [];
    (defs || []).forEach(function(def){
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
      items.push({ def: def, el: b });
    });
  }

  /* Soonest deadline first. Every credit is its own row: folding the ones that
     sit on both cards hid the deadline, which is the only thing that says
     which one to spend this month. Uber Cash is the exception, and one row in
     the table: both cards load it into one Uber balance with one deadline. */
  function render(){
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var list = [], open = 0;
    due = [];

    items.forEach(function(item){
      var def = item.def, row = item.el;
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
      /* remind false keeps a credit he does not chase off To Do */
      if(!isUsed && days <= SOON && def.remind !== false){
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
    body.textContent = '';
    for(var i = 0; i < list.length; i++){ body.appendChild(list[i].row); }
    openEl.textContent = money(open) + ' open';
  }

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
