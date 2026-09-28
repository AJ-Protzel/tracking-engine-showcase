/* ==========================================================================
   RENTALS — houses the rental sweep found, each with a photo.

   A temporary page: it goes, with its tables and its sweep, once a place is
   found. Nothing else reads it, so deleting rentals.js, rentals.css, its
   section and tab in index.html and its one line in data.js removes it whole.

   What it expects from page_data() — the rental sweep's session builds these:

     rentals          [{ id, address, city, price, price_was, beds, baths, sqft,
                         days, photo, url, status, gone, agent_name,
                         agent_phone, agent_email, notes, verdict,
                         verdict_reason, building, landlord, income_rule,
                         apply_note }]
                      price_was: the previous price when it changed, else null.
                      days: days on market. photo and url: full https URLs, or
                      null. gone: off the market, so taken; only a saved house
                      (a status past the first) is ever sent once gone.
                      url: the Zillow listing once vetting found it.
                      notes: the vet step's summary of the listing.
                      verdict: pass or unsure; verdict_reason says what an
                      unsure one left unanswered. A failed or dismissed
                      house is never in the list.
                      building: the street address and zip without the unit;
                      the units of one building share a row here.
                      landlord: private, manager, complex or unknown;
                      income_rule: strict, flexible or none_stated;
                      apply_note: what applying takes, in the listing's words.
                      With savings and no income, these decide the order.
     rental_statuses  the status enum in its own order, from enum_range(), so
                      this file never holds a copy of the allowed values.

   And two writes, security definer and revoked from anon like the others:

     page_rental_set(p_id bigint, p_status text)
     page_rental_dismiss(p_id bigint, p_reason text)   reason optional, 200 max;
                      a chat reads the reasons to tighten the search
   ========================================================================== */
var TERENT = (function(){
  var list = document.getElementById('rentList');
  var countEl = document.getElementById('rentCount');
  var strip = document.getElementById('rentFilter');
  var empty = document.getElementById('rentEmpty');
  var rows = [], statuses = [], show = 'pass', openId = '';

  function money(n){
    return '$' + Number(n).toLocaleString('en-US', {maximumFractionDigits: 0});
  }

  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls){ e.className = cls; }
    if(text !== undefined && text !== null){ e.textContent = text; }
    return e;
  }

  /* Only https URLs reach an src or href: the rows come from a feed, and a
     javascript: link in one would run on tap. */
  function safe(u){ return /^https:\/\//i.test(String(u || '')) ? String(u) : ''; }

  function facts(r){
    var f = [];
    if(r.beds != null){ f.push(r.beds + ' bd'); }
    if(r.baths != null){ f.push(r.baths + ' ba'); }
    if(r.sqft){ f.push(Number(r.sqft).toLocaleString('en-US') + ' sqft'); }
    if(r.days != null){ f.push(r.days + (r.days === 1 ? ' day' : ' days') + ' listed'); }
    return f.join(' · ');
  }

  function detail(r, host){
    var box = el('div', 'rent-open');
    if(r.notes){ box.appendChild(el('p', 'rent-notes', r.notes)); }
    var who = [];
    if(r.agent_name){ who.push(el('span', '', r.agent_name)); }
    if(r.agent_phone){
      var tel = el('a', '', r.agent_phone);
      tel.href = 'tel:' + String(r.agent_phone).replace(/[^0-9+]/g, '');
      who.push(tel);
    }
    if(r.agent_email){
      var mail = el('a', '', r.agent_email);
      mail.href = 'mailto:' + r.agent_email;
      who.push(mail);
    }
    if(who.length){
      var line = el('p', 'rent-agent');
      who.forEach(function(w, i){
        if(i){ line.appendChild(document.createTextNode(' · ')); }
        line.appendChild(w);
      });
      box.appendChild(line);
    }
    if(safe(r.url)){
      var go = el('a', 'rent-link', 'Open the listing');
      go.href = safe(r.url);
      go.target = '_blank';
      go.rel = 'noopener';
      box.appendChild(go);
    }

    /* The status chips, straight from the enum. A tap writes at once and a
       failed write puts the old status back. */
    if(statuses.length){
      var chips = el('div', 'rent-chips');
      statuses.forEach(function(s){
        var c = el('button', 'file-opt', s);
        c.type = 'button';
        c.setAttribute('aria-pressed', String(r.status === s));
        c.addEventListener('click', function(){
          if(r.status === s){ return; }
          var was = r.status;
          r.status = s;
          render();
          window.TERPC('page_rental_set', { p_id: Number(r.id), p_status: s }, function(err){
            if(err){ r.status = was; render(); }
          });
        });
        chips.appendChild(c);
      });
      box.appendChild(chips);
    }
    dismiss(r, box);
    host.appendChild(box);
  }

  /* Not for us: a reason chip or a typed one, then it goes for good. The
     reasons are suggestions only; the column takes any text. */
  var REASONS = ['Too small', 'Too far', 'Price', 'ADU or shared', 'No washer/dryer',
                 'No AC', 'Looks rough'];
  function dismiss(r, box){
    var open = el('button', 'rent-no', 'Not for us');
    open.type = 'button';
    box.appendChild(open);
    open.addEventListener('click', function(){
      open.remove();
      var form = el('div', 'rent-why');
      var picked = '';
      var chips = el('div', 'rent-chips');
      var other = document.createElement('input');
      other.type = 'text';
      other.maxLength = 200;
      other.placeholder = 'Or say why';
      REASONS.forEach(function(t){
        var c = el('button', 'file-opt', t);
        c.type = 'button';
        c.setAttribute('aria-pressed', 'false');
        c.addEventListener('click', function(){
          picked = picked === t ? '' : t;
          Array.prototype.forEach.call(chips.children, function(x){
            x.setAttribute('aria-pressed', String(x.textContent === picked));
          });
        });
        chips.appendChild(c);
      });
      var go = el('button', 'rent-no', 'Dismiss');
      go.type = 'button';
      go.addEventListener('click', function(){
        var why = [picked, other.value.trim()].filter(Boolean).join(': ');
        var at = rows.indexOf(r);
        rows.splice(at, 1);
        openId = '';
        render();
        window.TERPC('page_rental_dismiss', { p_id: Number(r.id), p_reason: why }, function(err){
          if(err){ rows.splice(at, 0, r); render(); }
        });
      });
      form.appendChild(chips);
      form.appendChild(other);
      form.appendChild(go);
      box.appendChild(form);
    });
  }

  function row(r, units){
    var li = el('li', 'rent' + (r.gone ? ' gone' : ''));
    var b = el('button', 'rent-row');
    b.type = 'button';

    var pic = el('span', 'rent-pic');
    if(safe(r.photo)){
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = safe(r.photo);
      img.addEventListener('error', function(){ img.remove(); });
      pic.appendChild(img);
    }
    b.appendChild(pic);

    var main = el('span', 'rent-main');
    var top = el('span', 'rent-top');
    top.appendChild(el('span', 'rent-price', money(r.price)));
    if(r.price_was != null && Number(r.price_was) > Number(r.price)){
      top.appendChild(el('span', 'rent-drop', 'was ' + money(r.price_was)));
    }
    if(r.gone){ top.appendChild(el('span', 'tag', 'Off market')); }
    else if(r.status && r.status !== statuses[0]){ top.appendChild(el('span', 'tag', r.status)); }
    if(LANDLORD[r.landlord]){ top.appendChild(el('span', 'tag', LANDLORD[r.landlord])); }
    main.appendChild(top);
    main.appendChild(el('span', 'rent-addr', r.address + (r.city ? ', ' + r.city : '')));
    main.appendChild(el('span', 'txn-meta', facts(r)));
    if(units && units.length > 1){
      var ps = units.map(function(u){ return Number(u.price); });
      var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
      main.appendChild(el('span', 'txn-meta', units.length + ' units · ' + money(lo)
        + (hi > lo ? '–' + money(hi) : '')));
    }
    if(r.apply_note){ main.appendChild(el('span', 'rent-apply' + (r.income_rule === 'strict' ? ' strict' : ''),
      'Apply: ' + r.apply_note)); }
    else if(r.income_rule === 'flexible'){ main.appendChild(el('span', 'rent-apply', 'Apply: flexible on income')); }
    /* a month on the market leaves room to ask for less */
    if(!r.gone && r.days >= 30){ main.appendChild(el('span', 'rent-deal', r.days + ' days listed · room to negotiate')); }
    if(r.verdict === 'unsure' && r.verdict_reason){
      main.appendChild(el('span', 'rent-check', 'Check: ' + r.verdict_reason));
    }
    b.appendChild(main);
    li.appendChild(b);

    var key = String(r.id);
    b.addEventListener('click', function(){
      openId = openId === key ? '' : key;
      render();
    });
    if(openId === key){ detail(r, li); }
    return li;
  }

  /* Furthest along first — the enum's last value leads — then everything
     still at its first value, best odds first: a listing flexible on income
     before one that says nothing before a strict one, and a private owner
     before a manager before a complex. Newest listing first within each. */
  var LANDLORD = { private: 'Private owner', manager: 'Manager', complex: 'Complex' };
  var INCOME_ODDS = { flexible: 0, none_stated: 1, strict: 3 };
  var LANDLORD_ODDS = { private: 0, manager: 1, unknown: 1, complex: 2 };
  function rank(r){
    var i = statuses.indexOf(r.status);
    return i > 0 ? -100 * i : 0;
  }
  function odds(r){
    return (INCOME_ODDS[r.income_rule] != null ? INCOME_ODDS[r.income_rule] : 2)
      + (LANDLORD_ODDS[r.landlord] != null ? LANDLORD_ODDS[r.landlord] : 1);
  }

  /* All is every house still listed, the unsure ones saying what their
     listing left out. Filtered, the one it opens on, is those with every
     must-have confirmed. Saved is any house given a status past the first,
     and the only place a house off the market still shows. */
  var TABS = [['all', 'All'], ['pass', 'Filtered'], ['saved', 'Saved']];
  function keep(r, key){
    if(key === 'saved'){ return r.status !== statuses[0]; }
    if(r.gone){ return false; }
    return key === 'all' || r.verdict === key;
  }

  /* One row per building: its units share the listing, laundry and cooling,
     so the cheapest stands for the rest. Saved keeps each unit apart. */
  function buildings(list){
    var by = {}, out = [];
    list.forEach(function(r){
      var k = r.building || ('#' + r.id), g = by[k];
      if(!g){ g = by[k] = { head: r, units: [] }; out.push(g); }
      g.units.push(r);
      if(Number(r.price) < Number(g.head.price)){ g.head = r; }
    });
    return out;
  }

  function render(){
    strip.textContent = '';
    TABS.forEach(function(k){
      var hits = rows.filter(function(r){ return keep(r, k[0]); });
      var n = k[0] === 'saved' ? hits.length : buildings(hits).length;
      var c = el('button', 'tab', k[1] + ' ' + n);
      c.type = 'button';
      c.setAttribute('aria-pressed', String(show === k[0]));
      c.addEventListener('click', function(){ show = k[0]; openId = ''; render(); });
      strip.appendChild(c);
    });
    strip.hidden = !rows.length;

    var shown = rows.filter(function(r){ return keep(r, show); })
      .sort(function(a, b){ return (rank(a) - rank(b)) || (odds(a) - odds(b))
        || ((a.days || 0) - (b.days || 0)); });
    list.textContent = '';
    if(show === 'saved'){
      shown.forEach(function(r){ list.appendChild(row(r)); });
    } else {
      buildings(shown).forEach(function(g){ list.appendChild(row(g.head, g.units)); });
    }

    var fresh = statuses.length ? rows.filter(function(r){
      return r.verdict === 'pass' && r.status === statuses[0] && !r.gone;
    }).length : 0;
    countEl.textContent = fresh ? fresh + ' new' : String(rows.length);
    countEl.className = fresh ? 'count act' : 'count';
    empty.hidden = rows.length !== 0;
  }

  render();
  return {
    set: function(r, s){
      rows = (r || []).slice();
      statuses = (s || []).slice();
      render();
    }
  };
})();
