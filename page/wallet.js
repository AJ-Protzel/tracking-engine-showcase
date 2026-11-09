/* ==========================================================================
   WALLET: when to convert, between any two of US dollars, rupiah and
   Canadian, picked like a translator: From on the left, To on the right, a
   swap between them.

   The chart always reads how much To one From buys, so up is better
   whichever way it points; rupiah counts by the million when it is the From
   side. The card says whether today is a good day by where today sits among
   the days of the pair's window: the past month for rupiah into dollars,
   sent every week or so, so today is weighed against the days a transfer
   could just as well have gone out; six months for every other pair, one
   large conversion with time to wait for a good day, without a year-old
   level it may never see again. It opens on the past month. Each Exchange
   card keeps its own pair in the layout; the first one ever placed starts
   on the last pair picked before layouts. It is a read of the past, not a
   forecast. The line and its fill turn green on a good day and red on a wait.

   Alerts tracks the two real transfers, rupiah into dollars and dollars into
   Canadian, whatever pair any chart is showing.

   Nothing here touches the database. The rates come from Frankfurter
   (api.frankfurter.dev), a free public API over the European Central Bank's
   reference rates, which publishes once each working day around 16:00 CET.
   So nothing schedules it: the page asks when the app opens, when it comes
   back to the front, and on a pull to refresh, and reuses an answer under
   an hour old.
   ========================================================================== */
(function(){
  var API = 'https://api.frankfurter.dev/v1/';
  var KEEP = 60 * 60 * 1000;
  var RANGES = [['1M', 31], ['3M', 92], ['6M', 183], ['1Y', 366]];
  /* how one unit of each reads, as From and as To; rupiah goes by the
     million as From, or its numbers would be all zeros */
  var CUR = {
    USD: {name: 'US dollar', per: 1, one: '$1', amt: function(v, d){ return '$' + fmt(v, d); }},
    IDR: {name: 'Indonesian rupiah', per: 1e6, one: 'Rp 1,000,000', amt: function(v, d){ return 'Rp ' + fmt(v, d); }},
    CAD: {name: 'Canadian dollar', per: 1, one: 'C$1', amt: function(v, d){ return fmt(v, d) + ' CAD'; }}
  };
  var CODES = ['USD', 'IDR', 'CAD'];
  /* the two transfers Alerts watches */
  var TRACK = [
    {from: 'USD', to: 'CAD', nudge: 'change dollars into Canadian'},
    {from: 'IDR', to: 'USD', nudge: 'change rupiah into dollars'}
  ];
  /* the share of the window's days today has to beat to be a good day,
     and to be the best time */
  var GOOD = 0.75, BEST = 0.9;
  /* the pair picked before layouts kept one per card */
  var OLD = {from: 'USD', to: 'CAD'};
  try {
    var saved = JSON.parse(localStorage.getItem('te.wallet.fxPair') || 'null');
    if(saved && CUR[saved.from] && CUR[saved.to] && saved.from !== saved.to){ OLD = saved; }
  } catch(e){}
  var I = TEW.list();
  var series = null, fetchedAt = 0, busy = false, failed = '';

  function $(id){ return document.getElementById(id); }

  function iso(d){ return d.toISOString().slice(0, 10); }

  function short(day){
    var d = new Date(day + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  }

  function long(day){
    var d = new Date(day + 'T12:00:00Z');
    return d.toLocaleDateString('en-US',
      {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
  }

  function fmt(v, digits){
    return v.toLocaleString('en-US',
      {minimumFractionDigits: digits, maximumFractionDigits: digits});
  }

  /* one year of days, both currencies in one call; the ranges are slices of it.
     Read whenever the app is open, not only with a chart on screen, so the
     first page can say when either transfer is at its best. */
  function load(force){
    if(busy || $('app').hidden){ return; }
    if(!force && series && Date.now() - fetchedAt < KEEP){ return; }
    busy = true;
    var start = new Date(Date.now() - 366 * 864e5);
    fetch(API + iso(start) + '..?base=USD&symbols=CAD,IDR')
      .then(function(r){
        if(!r.ok){ throw new Error('HTTP ' + r.status); }
        return r.json();
      })
      .then(function(d){
        var days = Object.keys(d.rates || {}).sort();
        if(!days.length){ throw new Error('no rates'); }
        series = days.map(function(k){
          return {day: k, USD: 1, CAD: Number(d.rates[k].CAD), IDR: Number(d.rates[k].IDR)};
        });
        fetchedAt = Date.now();
        failed = '';
        I.each(draw);
        nudge();
      })
      .catch(function(){
        failed = series
          ? 'Could not refresh the rates. Showing the last ones read.'
          : 'Could not reach the exchange rate service. Pull down to try again.';
        I.each(showErr);
      })
      .then(function(){ busy = false; });
  }

  function showErr(v){
    v.err.hidden = !failed;
    v.err.textContent = failed;
  }

  /* ---- one pair: how much To one From buys on a day, its window, and how
     its numbers read ---- */
  function pair(from, to){
    var f = CUR[from], t = CUR[to];
    var digits = to === 'IDR' ? 0 : from === 'IDR' ? 2 : 4;
    var days = from === 'IDR' && to === 'USD' ? 31 : 183;
    return {
      from: from, to: to, digits: digits, window: days,
      span: days === 31 ? 'past month' : 'past 6 months',
      unit: to + ' per ' + f.one,
      val: function(s){ return s[to] / s[from] * f.per; },
      say: function(v){ return f.one + ' = ' + t.amt(v, digits); }
    };
  }

  /* where today sits among the pair's window, whatever range is showing */
  function verdict(p){
    var since = iso(new Date(Date.now() - p.window * 864e5));
    var vals = series.filter(function(s){ return s.day >= since; }).map(p.val)
      .filter(function(v){ return isFinite(v); }).sort(function(a, b){ return a - b; });
    if(!vals.length){ return null; }
    var now = p.val(series[series.length - 1]);
    var beats = vals.filter(function(v){ return v < now; }).length / vals.length;
    return {beats: beats, goodAt: vals[Math.floor(GOOD * (vals.length - 1))]};
  }

  /* ---- one card: From and To pickers with a swap between, the latest
     rate, its change over the range, and a line a finger can run along to
     read any day ---- */
  /* a made-up year of rates for samples, a gentle wave */
  function fakeSeries(){
    var out = [];
    for(var i = 365; i >= 0; i--){
      out.push({day: TEW.ago(i), USD: 1, CAD: 1.36 + 0.02 * Math.sin(i / 23),
                IDR: 16000 + 300 * Math.sin(i / 31)});
    }
    return out;
  }

  function mount(card, c){
    if(c.sample){
      var keep = c;
      TEW.swap(function(){ return series; }, function(o){ series = o; }, fakeSeries(), function(){
        mount(card, {s: {from: 'USD', to: 'CAD'}, save: function(){}, r: keep.r, sample: false})();
      });
      return;
    }
    var s = c.s.from && CUR[c.s.from] && CUR[c.s.to] && c.s.from !== c.s.to ? c.s : OLD;
    var v = {card: card, err: c.r('err'), title: c.r('title'), asof: c.r('asof'),
             view: {from: s.from, to: s.to, range: 31}, p: null};
    var pickFrom = c.r('from'), pickTo = c.r('to');
    [pickFrom, pickTo].forEach(function(sel){
      CODES.forEach(function(code){
        var o = document.createElement('option');
        o.value = code; o.textContent = code; o.title = CUR[code].name;
        sel.appendChild(o);
      });
    });
    function choose(from, to, keep){
      v.view.from = from; v.view.to = to;
      pickFrom.value = from; pickTo.value = to;
      if(!keep){
        c.save({from: from, to: to});
        try { localStorage.setItem('te.wallet.fxPair', JSON.stringify({from: from, to: to})); } catch(e){}
      }
      v.p = pair(from, to);
      v.title.textContent = from + ' to ' + to;
      card.querySelector('.fx-unit').textContent = v.p.unit;
      draw(v);
    }
    /* picking the currency already on the other side swaps them */
    pickFrom.addEventListener('change', function(){
      var f = pickFrom.value;
      choose(f, f === v.view.to ? v.view.from : v.view.to);
    });
    pickTo.addEventListener('change', function(){
      var t = pickTo.value;
      choose(t === v.view.from ? v.view.to : v.view.from, t);
    });
    c.r('swap').addEventListener('click', function(){ choose(v.view.to, v.view.from); });

    var bar = card.querySelector('.fx-ranges');
    RANGES.forEach(function(r){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.textContent = r[0];
      b.setAttribute('aria-pressed', String(r[1] === v.view.range));
      b.addEventListener('click', function(){
        v.view.range = r[1];
        bar.querySelectorAll('.tab').forEach(function(x){
          x.setAttribute('aria-pressed', String(x === b));
        });
        draw(v);
      });
      bar.appendChild(b);
    });

    var plot = card.querySelector('.fx-plot');
    function read(ev){
      if(!v.p.pts || !v.p.pts.length){ return; }
      var box = plot.getBoundingClientRect();
      var x = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
      point(v, Math.round(x * (v.p.pts.length - 1)));
    }
    plot.addEventListener('pointerdown', function(ev){
      plot.setPointerCapture(ev.pointerId);
      read(ev);
    });
    plot.addEventListener('pointermove', function(ev){
      if(ev.pointerType === 'mouse' || plot.hasPointerCapture(ev.pointerId)){ read(ev); }
    });
    function leave(){ point(v, -1); }
    plot.addEventListener('pointerup', leave);
    plot.addEventListener('pointercancel', leave);
    plot.addEventListener('pointerleave', leave);

    choose(v.view.from, v.view.to, true);
    showErr(v);
    load(false);
    return I.add(v);
  }

  function draw(v){
    if(!series || !v.p){ return; }
    var card = v.card, p = v.p;
    var from = iso(new Date(Date.now() - v.view.range * 864e5));
    var pts = series.filter(function(s){ return s.day >= from; })
      .map(function(s){ return {day: s.day, v: p.val(s)}; })
      .filter(function(s){ return isFinite(s.v); });
    p.pts = pts;
    if(pts.length < 2){ return; }

    var vd = verdict(p), goodAt = vd.goodAt;
    var pct = Math.round(vd.beats * 100);
    var tag = card.querySelector('.fx-tag'), why = card.querySelector('.fx-why');
    if(vd.beats >= BEST){
      tag.textContent = 'Best time is now'; tag.className = 'fx-tag best';
      card.setAttribute('data-fx', 'good');
      why.textContent = 'Better than ' + pct + '% of days in the ' + p.span + '.';
    } else if(vd.beats >= GOOD){
      tag.textContent = 'Good day to transfer'; tag.className = 'fx-tag good';
      card.setAttribute('data-fx', 'good');
      why.textContent = 'Better than ' + pct + '% of days in the ' + p.span + '.';
    } else {
      tag.textContent = 'Wait for now'; tag.className = 'fx-tag wait';
      card.setAttribute('data-fx', 'wait');
      why.textContent = 'Better than ' + pct + '% of days in the ' + p.span + '; good is '
        + p.say(goodAt) + ' or better.';
    }

    var lo = Infinity, hi = -Infinity;
    pts.forEach(function(s){ lo = Math.min(lo, s.v); hi = Math.max(hi, s.v); });
    var pad = (Math.max(hi, goodAt) - Math.min(lo, goodAt)) * 0.08 || hi * 0.001;
    p.lo = Math.min(lo, goodAt) - pad; p.hi = Math.max(hi, goodAt) + pad;
    var line0 = card.querySelector('.fx-good');
    line0.style.top = ((p.hi - goodAt) / (p.hi - p.lo) * 100) + '%';
    line0.hidden = false;

    var W = 600, H = 200, n = pts.length - 1;
    var line = pts.map(function(s, i){
      return (i ? 'L' : 'M') + (i / n * W).toFixed(1) + ' '
        + ((p.hi - s.v) / (p.hi - p.lo) * H).toFixed(1);
    }).join('');
    card.querySelector('.fx-line').setAttribute('d', line);
    card.querySelector('.fx-area').setAttribute('d', line + 'L' + W + ' ' + H + 'L0 ' + H + 'Z');

    var first = pts[0].v, last = pts[n].v, ch = (last - first) / first * 100;
    card.querySelector('.fx-now').textContent = fmt(last, p.digits);
    var chg = card.querySelector('.fx-chg');
    chg.textContent = (ch >= 0 ? '+' : '−') + Math.abs(ch).toFixed(2) + '%';
    card.querySelector('.fx-hi').textContent = fmt(hi, p.digits);
    card.querySelector('.fx-lo').textContent = fmt(lo, p.digits);
    var label = v.view.range > 200 ? long : short;
    card.querySelector('.fx-from').textContent = label(pts[0].day);
    card.querySelector('.fx-to').textContent = label(pts[n].day);
    v.asof.textContent = 'as of ' + short(pts[n].day);
    v.asof.hidden = false;
    point(v, -1);
  }

  /* i < 0 puts the readout back on the latest day */
  function point(v, i){
    var card = v.card, p = v.p;
    var dot = card.querySelector('.fx-dot'),
        rule = card.querySelector('.fx-rule'), out = card.querySelector('.fx-read');
    if(i < 0 || !p.pts){
      dot.hidden = rule.hidden = true;
      out.textContent = 'Touch the line to read a day.';
      return;
    }
    var s = p.pts[i], n = p.pts.length - 1;
    var x = (i / n * 100) + '%', y = ((p.hi - s.v) / (p.hi - p.lo) * 100) + '%';
    dot.style.left = x; dot.style.top = y; rule.style.left = x;
    dot.hidden = rule.hidden = false;
    out.textContent = long(s.day) + ' · ' + p.say(s.v);
  }

  TEW.define('fx.exchange', {type: 'Exchange', version: 'Chart', title: 'Exchange', mount: mount});

  /* the line over the first page: only "best time is now" on one of the two
     real transfers earns it, so it is rare enough to be worth reading. A tap
     opens the first page holding an Exchange card. */
  function nudge(){
    var box = $('fxAlert');
    if(!box || !series){ return; }
    var best = TRACK.filter(function(t){
      var v = verdict(pair(t.from, t.to));
      return v && v.beats >= BEST;
    });
    box.hidden = !best.length;
    box.textContent = best.length ? 'Best time is now to '
      + best.map(function(t){ return t.nudge; }).join(', and to ') + '.' : '';
  }
  $('fxAlert').addEventListener('click', function(){
    var L = TELAYOUT.get();
    var p = L && L.pages.filter(function(pg){
      return (pg.slots || []).some(function(s){
        return s.w.some(function(w){ return w.t === 'fx.exchange'; });
      });
    })[0];
    if(p){ TELAYOUT.show(p.id); }
  });

  document.addEventListener('tepage', function(){ load(false); });
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden){ load(false); }
  });
  document.addEventListener('terefresh', function(){ load(true); });
  /* the first read, once sign-in shows the app */
  new MutationObserver(function(){ load(false); })
    .observe($('app'), {attributes: true, attributeFilter: ['hidden']});
  load(false);
})();


/* ==========================================================================
   NET WORTH: the total of every linked account, with what is owned against
   what is owed, and the trend of that total over time. Two widgets, which
   the default layout stacks. They read page_monarch_data() when a page
   holding one is opened, when the app comes back to the front on it, and on
   a pull to refresh. Accounts without a balance are left out; credit cards
   arrive negative and count against the total. The history is
   accountant_balance_history, one balance per account per day, written by
   the bank sweep every four hours. It reaches back to the trial's three days
   (Sep 26-28) and runs daily from 2026-10-16; a day with no row for an
   account carries its last known balance forward.
   ========================================================================== */
(function(){
  var RANGES = [['1M', 31], ['3M', 92], ['6M', 183], ['1Y', 366], ['All', 0]];
  /* The line starts on the first day every main account was linked. Sep 26
     had only two cards, so the jump from them to everything read as a
     large gain (2026-10-19). Earlier rows still seed the carry. */
  var START = '2026-09-27';
  var Tot = TEW.list(), Tr = TEW.list();
  var busy = false, data = null, failed = false;

  function $(id){ return document.getElementById(id); }
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls){ e.className = cls; }
    if(text != null){ e.textContent = text; }
    return e;
  }
  function money(v){
    var s = Math.trunc(Math.abs(v)).toLocaleString('en-US', {style: 'currency', currency: 'USD',
      minimumFractionDigits: 0, maximumFractionDigits: 0});
    return (v < 0 ? '−' : '') + s;
  }
  function iso(d){ return d.toISOString().slice(0, 10); }
  function addDays(day, n){
    var d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d);
  }
  function label(day){
    return new Date(day + 'T12:00:00Z').toLocaleDateString('en-US',
      {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
  }
  function today(){
    return new Date().toLocaleDateString('en-CA', {timeZone: 'America/Los_Angeles'});
  }

  /* one row per day from the first history row to today, each account's
     latest known balance carried forward */
  function series(){
    var rows = data.balances, ids = {}, byDay = {}, out = [], last = {};
    if(!rows.length){ return out; }
    data.accounts.forEach(function(a){ ids[a.id] = a; });
    rows.forEach(function(r){
      if(!ids[r.acct]){ return; }
      (byDay[r.d] = byDay[r.d] || []).push(r);
    });
    var end = today();
    for(var d = rows[0].d; d <= end; d = addDays(d, 1)){
      (byDay[d] || []).forEach(function(r){ last[r.acct] = Number(r.bal) || 0; });
      var t = 0;
      for(var k in last){ t += last[k]; }
      if(d >= START){ out.push({day: d, v: t}); }
    }
    return out;
  }

  /* "as of" in each card's head, and the error line, on both versions */
  function head(v){
    v.err.hidden = !failed;
    v.err.textContent = failed ? 'Could not read the balances. Pull down to try again.' : '';
    if(!data){ return; }
    var newest = '';
    data.accounts.forEach(function(a){
      if(a.balance != null && a.as_of && a.as_of > newest){ newest = a.as_of; }
    });
    v.asof.textContent = newest ? 'as of ' + new Date(newest)
      .toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : '';
  }

  function drawTotal(v){
    head(v);
    if(!data){ return; }
    var assets = 0, debts = 0;
    data.accounts.filter(function(a){ return a.balance != null; }).forEach(function(a){
      var b = Number(a.balance) || 0;
      if(b >= 0){ assets += b; } else { debts -= b; }
    });
    v.total.textContent = money(assets - debts);
    v.total.classList.toggle('neg', assets - debts < 0);
    v.assets.textContent = money(assets);
    v.debts.textContent = money(-debts);
    v.barA.style.width = (assets + debts ? assets / (assets + debts) * 100 : 100) + '%';
  }

  function drawChart(v){
    head(v);
    if(!data){ return; }
    var card = v.card, all = series();
    var from = v.range ? addDays(today(), -v.range) : '';
    var pts = v.pts = all.filter(function(p){ return p.day >= from; });
    if(pts.length < 2){
      card.querySelector('.fx-line').setAttribute('d', '');
      card.querySelector('.fx-area').setAttribute('d', '');
      v.read.textContent = 'The history fills in one day at a time.';
      return;
    }
    var lo = Infinity, hi = -Infinity;
    pts.forEach(function(p){ lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
    var pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    var top = hi + pad, bot = lo - pad, W = 600, H = 200, n = pts.length - 1;
    var line = pts.map(function(p, i){
      return (i ? 'L' : 'M') + (i / n * W).toFixed(1) + ' ' + ((top - p.v) / (top - bot) * H).toFixed(1);
    }).join('');
    card.querySelector('.fx-line').setAttribute('d', line);
    card.querySelector('.fx-area').setAttribute('d', line + 'L' + W + ' ' + H + 'L0 ' + H + 'Z');
    card.setAttribute('data-fx', pts[n].v >= pts[0].v ? 'good' : 'wait');
    card.querySelector('.fx-hi').textContent = money(hi);
    card.querySelector('.fx-lo').textContent = money(lo);
    card.querySelector('.fx-from').textContent = label(pts[0].day);
    card.querySelector('.fx-to').textContent = label(pts[n].day);
    v.scale = {top: top, bot: bot};
    point(v, -1);
  }

  function point(v, i){
    var card = v.card, pts = v.pts || [];
    var dot = card.querySelector('.fx-dot'), rule = card.querySelector('.fx-rule');
    if(i < 0 || !pts.length){
      dot.hidden = rule.hidden = true;
      if(pts.length > 1){ v.read.textContent = 'Touch the line to read a day.'; }
      return;
    }
    var p = pts[i], s = v.scale, n = pts.length - 1;
    var x = (n ? i / n * 100 : 0) + '%';
    dot.style.left = x; rule.style.left = x;
    dot.style.top = ((s.top - p.v) / (s.top - s.bot) * 100) + '%';
    dot.hidden = rule.hidden = false;
    v.read.textContent = label(p.day) + ' · ' + money(p.v);
  }

  function drawAll(){ Tot.each(drawTotal); Tr.each(drawChart); }

  /* samples: two made-up accounts and a rising line */
  function sampled(fn){
    var bal = [];
    for(var k = 90; k >= 0; k--){
      bal.push({acct: 'a', d: TEW.ago(k), bal: 18000 + (90 - k) * 70 + 400 * Math.sin(k / 6)});
      bal.push({acct: 'b', d: TEW.ago(k), bal: -1200});
    }
    TEW.swap(function(){ return [data, failed, START]; },
      function(o){ data = o[0]; failed = o[1]; START = o[2]; },
      [{accounts: [{id: 'a', balance: 24300, as_of: new Date().toISOString()},
                   {id: 'b', balance: -1200, as_of: new Date().toISOString()}], balances: bal},
       false, ''], fn);
  }

  /* read only when one of the cards is on the page on screen */
  function load(){
    if(busy || $('app').hidden || !window.TERPC){ return; }
    function on(v){ return TEW.shown(v.card); }
    if(!Tot.some(on) && !Tr.some(on)){ return; }
    busy = true;
    window.TERPC('page_monarch_data', {}, function(err, d){
      busy = false;
      failed = !!(err || !d);
      if(!failed){ data = {accounts: d.accounts || [], balances: d.balances || []}; }
      drawAll();
    });
  }

  TEW.define('networth.total', {type: 'Net Worth', version: 'Total', title: 'Net Worth', tab: 'Net worth',
    mount: function(card, c){
      var v = {card: card, err: c.r('err'), asof: c.r('asof'), total: c.r('total'),
               assets: c.r('assets'), debts: c.r('debts'), barA: c.r('barA')};
      if(c.sample){ sampled(function(){ drawTotal(v); }); return; }
      drawTotal(v);
      return Tot.add(v);
    }});

  TEW.define('networth.trend', {type: 'Net Worth', version: 'Trend', title: 'Net Worth Trend', tab: 'Trend',
    mount: function(card, c){
      var v = {card: card, err: c.r('err'), asof: c.r('asof'), read: c.r('read'),
               range: 92, pts: []};
      /* the range chips and the finger along the line */
      var bar = c.r('ranges');
      RANGES.forEach(function(r){
        var b = el('button', 'tab', r[0]);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(r[1] === v.range));
        b.addEventListener('click', function(){
          v.range = r[1];
          bar.querySelectorAll('.tab').forEach(function(x){ x.setAttribute('aria-pressed', String(x === b)); });
          drawChart(v);
        });
        bar.appendChild(b);
      });
      var plot = card.querySelector('.fx-plot');
      function read(ev){
        if(v.pts.length < 2){ return; }
        var r = plot.getBoundingClientRect();
        point(v, Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * (v.pts.length - 1)));
      }
      plot.addEventListener('pointerdown', function(ev){ plot.setPointerCapture(ev.pointerId); read(ev); });
      plot.addEventListener('pointermove', function(ev){
        if(ev.pointerType === 'mouse' || plot.hasPointerCapture(ev.pointerId)){ read(ev); }
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(t){
        plot.addEventListener(t, function(){ point(v, -1); });
      });
      if(c.sample){ sampled(function(){ drawChart(v); }); return; }
      drawChart(v);
      return Tr.add(v);
    }});

  document.addEventListener('tepage', load);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden){ load(); } });
  document.addEventListener('terefresh', load);
})();
