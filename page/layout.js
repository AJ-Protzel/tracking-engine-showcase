/* ==========================================================================
   LAYOUT: the widget registry, each user's layout, and drawing it.

   Pages are like phone home screens and cards are like widgets. Every card
   type registers itself here (TEW.define) with a template in index.html, and
   can then be mounted any number of times, on any page, alone or in a swipe
   stack. Which cards sit where is one JSON layout per signed-in user, saved
   through page_layout_set and cached on the device. edit.js changes it.

   Layout:
     {v:1, pages:[{id, name, kind?, slots:[{id, w:[{id, t, s?}]}]}]}
   A slot of one widget is a plain card; two or more is a swipe stack. t is a
   widget id (alerts.todo, networth.trend ...), s its own settings. A page of
   kind "wedding" is the wedding frame: no cards, never deleted.
   ========================================================================== */

/* ---- the registry ---- */
var TEW = (function(){
  var defs = {}, order = [];

  /* spec: {type, version, title, tab?, mount(root, ctx) -> unmount?} */
  function define(id, spec){
    spec.id = id;
    if(!defs[id]){ order.push(id); }
    defs[id] = spec;
  }

  /* a fresh copy of a widget's markup, mounted. ctx.r(name) finds a
     [data-r] element inside it; ctx.s is its own settings; ctx.save(s)
     stores new ones in the layout. With sample, the module draws it once
     from small made-up data instead (the gallery and edit mode), and never
     again: a sample is a picture of the card, not a live one. */
  function make(t, s, save, sample){
    var d = defs[t];
    var tpl = document.querySelector('template[data-w="' + t + '"]');
    if(!d || !tpl){ return null; }
    var el = tpl.content.firstElementChild.cloneNode(true);
    el.setAttribute('data-w', t);
    if(sample){ el.classList.add('sample'); }
    var ctx = {
      sample: !!sample,
      s: s || {},
      save: save || function(){},
      r: function(name){ return el.querySelector('[data-r="' + name + '"]'); }
    };
    var un = d.mount(el, ctx);
    return {el: el, t: t, unmount: typeof un === 'function' ? un : function(){}};
  }

  /* the instances a module draws into; add() returns the remover */
  function list(){
    var a = [];
    return {
      add: function(x){
        a.push(x);
        return function(){ var i = a.indexOf(x); if(i >= 0){ a.splice(i, 1); } };
      },
      each: function(fn){ a.slice().forEach(fn); },
      some: function(fn){ return a.some(fn); },
      size: function(){ return a.length; }
    };
  }

  /* shown means on the page on screen; a gallery preview is not */
  function shown(el){
    var p = el.closest('.page');
    return !!p && !p.hidden && !document.getElementById('app').hidden;
  }

  /* For samples: runs fn with a module's own state swapped for made-up
     data, then puts the real state back. get() reads the state as an
     object, set(o) writes one; drawing is synchronous, so nothing real
     ever sees the made-up data. */
  function swap(get, set, fake, fn){
    var real = get();
    set(fake);
    try { fn(); } finally { set(real); }
  }

  /* made-up dates: n days back from today, as YYYY-MM-DD */
  function ago(n){
    var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  return {define: define, defs: defs, order: order, make: make, list: list, shown: shown,
          swap: swap, ago: ago};
})();

/* ---- the layout itself ---- */
var TELAYOUT = (function(){
  var VERSION = 1;
  function $(id){ return document.getElementById(id); }
  function uid(p){ return p + Math.random().toString(36).slice(2, 9); }
  function one(t){ return {id: uid('s'), w: [{id: uid('c'), t: t}]}; }

  /* Exactly the app as it was before layouts, so nothing changes for anyone
     until they edit. */
  function defaults(){
    return {v: VERSION, pages: [
      {id: 'alerts', name: 'Alerts', slots: [one('alerts.action'), one('alerts.highlights'), one('alerts.todo'),
        one('alerts.settlements'), one('alerts.jobs')]},
      {id: 'balance', name: 'Balance', slots: [one('balance.spending'), one('money.full'),
        one('balance.credits')]},
      {id: 'wallet', name: 'Wallet', slots: [one('fx.exchange'),
        {id: uid('s'), w: [{id: uid('c'), t: 'networth.total'}, {id: uid('c'), t: 'networth.trend'}]}]},
      {id: 'wedding', name: 'Wedding', kind: 'wedding'}
    ]};
  }

  /* Whatever comes in, out comes something drawable: unknown cards are
     dropped, a slot left empty goes, one left with a single card is a plain
     card again, and there is always at least one page. Anything broken
     falls back to the defaults. */
  function normalize(L){
    if(!L || typeof L !== 'object' || !Array.isArray(L.pages)){ return defaults(); }
    var seen = {}, wed = false, pages = [];
    function fresh(id, p){
      id = typeof id === 'string' && id && id.length < 40 ? id : uid(p);
      while(seen[id]){ id = uid(p); }
      seen[id] = true;
      return id;
    }
    L.pages.forEach(function(p){
      if(!p || typeof p !== 'object'){ return; }
      var name = String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Page';
      if(p.kind === 'wedding'){
        if(wed){ return; }
        wed = true;
        seen.wedding = true;
        pages.push({id: 'wedding', name: name, kind: 'wedding'});
        return;
      }
      var slots = [];
      (Array.isArray(p.slots) ? p.slots : []).forEach(function(s){
        if(!s || !Array.isArray(s.w)){ return; }
        var w = s.w.filter(function(x){ return x && TEW.defs[x.t]; }).map(function(x){
          var o = {id: fresh(x.id, 'c'), t: x.t};
          if(x.s && typeof x.s === 'object'){ o.s = x.s; }
          return o;
        });
        if(w.length){ slots.push({id: fresh(s.id, 's'), w: w}); }
      });
      pages.push({id: fresh(p.id, 'p'), name: name, slots: slots});
    });
    if(!pages.some(function(p){ return p.kind !== 'wedding'; })){
      pages.unshift({id: uid('p'), name: 'Home', slots: []});
    }
    return {v: VERSION, pages: pages};
  }

  var L = null, user = '', current = '', saveTimer = null;
  var live = {};     /* widget instance id -> {el, t, unmount} */
  var stacks = {};   /* slot id -> stack element */
  var pagesBox, strip, chrome, signout;

  function cacheKey(){ return 'te.layout.' + (user || 'anon'); }
  function cache(){
    try { localStorage.setItem(cacheKey(), JSON.stringify(L)); } catch(e){}
  }
  function cached(){
    try { return JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch(e){ return null; }
  }

  /* ---- the page strip: one tab per page, then "+" ---- */
  function drawStrip(){
    var want = L.pages.map(function(p){ return p.id; });
    var tabs = {};
    Array.prototype.forEach.call(strip.querySelectorAll('.ptab[data-pid]'), function(b){
      tabs[b.getAttribute('data-pid')] = b;
    });
    var plus = strip.querySelector('.ptab-add');
    L.pages.forEach(function(p){
      var b = tabs[p.id];
      if(!b){
        b = document.createElement('button');
        b.type = 'button';
        b.className = 'ptab';
        b.setAttribute('role', 'tab');
        b.setAttribute('data-pid', p.id);
        b.appendChild(document.createElement('span')).className = 'ptab-name';
        var x = document.createElement('span');
        x.className = 'ptab-x';
        x.setAttribute('aria-hidden', 'true');
        x.textContent = '×';
        b.appendChild(x);
        b.addEventListener('click', function(){
          if(window.TEEDIT && TEEDIT.tabClick(b.getAttribute('data-pid'), b)){ return; }
          show(b.getAttribute('data-pid'));
        });
      }
      b.querySelector('.ptab-name').textContent = p.name;
      b.classList.toggle('fixed', p.kind === 'wedding');
      delete tabs[p.id];
      strip.insertBefore(b, plus);
    });
    for(var k in tabs){ tabs[k].remove(); }
    if(want.indexOf(current) === -1){ current = ''; }
  }

  /* ---- cards ---- */
  function mountOne(w, page){
    var m = live[w.id];
    if(m && m.t === w.t){ return m; }
    if(m){ m.unmount(); }
    var cid = w.id;
    m = TEW.make(w.t, w.s, function(s){
      /* found again by id: the layout object may have been replaced since */
      L.pages.forEach(function(p){
        (p.slots || []).forEach(function(sl){
          sl.w.forEach(function(x){ if(x.id === cid){ x.s = s; } });
        });
      });
      changed();
    });
    if(!m){ return null; }
    m.el.setAttribute('data-cid', w.id);
    live[w.id] = m;
    return m;
  }

  /* A stack: the cards' names on top, one card shown, a tap on a name or a
     sideways swipe moves between them. The header shows the shown card's
     own count. Swipes that start on a chart, the chips or a field are
     theirs, not the stack's. */
  function stackEl(slot){
    var el = stacks[slot.id];
    if(!el){
      el = document.createElement('section');
      el.className = 'card plain stack';
      el.setAttribute('data-sid', slot.id);
      var head = document.createElement('div');
      head.className = 'nw-tabs stack-tabs';
      el.appendChild(head);
      el._at = 0;
      var x0 = null, y0 = 0;
      el.addEventListener('touchstart', function(ev){
        x0 = null;
        if(document.body.classList.contains('editing')){ return; }
        if(ev.touches.length !== 1 || ev.target.closest('.fx-plot, .tabs, .heat-scroll, input, select, textarea')){ return; }
        x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY;
      }, {passive: true});
      el.addEventListener('touchend', function(ev){
        if(x0 == null){ return; }
        var dx = ev.changedTouches[0].clientX - x0, dy = ev.changedTouches[0].clientY - y0;
        x0 = null;
        if(Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)){ turn(el, el._at + (dx < 0 ? 1 : -1)); }
      });
      el._mirror = new MutationObserver(function(){ mirror(el); });
      stacks[slot.id] = el;
    }
    return el;
  }

  function members(el){
    return Array.prototype.filter.call(el.children, function(c){ return c.hasAttribute('data-cid'); });
  }

  function turn(el, i){
    var ms = members(el);
    if(i < 0 || i >= ms.length){ return; }
    el._at = i;
    ms.forEach(function(m, k){ m.classList.toggle('stack-off', k !== i); });
    Array.prototype.forEach.call(el.querySelectorAll('.stack-tabs .nw-tab'), function(b, k){
      b.setAttribute('aria-pressed', String(k === i));
    });
    mirror(el);
  }

  /* the shown card's count pill, copied into the stack header */
  function mirror(el){
    var ms = members(el), m = ms[el._at] || ms[0];
    var pill = el.querySelector('.stack-tabs .count');
    var src = m && m.querySelector('.card-head .count');
    if(!pill){ return; }
    pill.textContent = src ? src.textContent : '';
    pill.className = src ? src.className : 'count';
    pill.hidden = !src || src.hidden || !src.textContent.trim();
    el._mirror.disconnect();
    if(src){ el._mirror.observe(src, {childList: true, characterData: true, subtree: true, attributes: true}); }
  }

  function fillStack(el, slot, ms){
    /* edit mode's tile goes first; edit.js puts it back after every draw */
    var tile = el.querySelector(':scope > .tile');
    if(tile){ tile.remove(); }
    var head = el.querySelector(':scope > .stack-tabs');
    head.textContent = '';
    ms.forEach(function(m, i){
      var d = TEW.defs[m.t];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'nw-tab';
      b.textContent = d.tab || d.title;
      b.addEventListener('click', function(){
        if(document.body.classList.contains('editing')){ return; }
        turn(el, i);
      });
      head.appendChild(b);
    });
    var pill = document.createElement('span');
    pill.className = 'count';
    head.appendChild(pill);
    place(el, ms.map(function(m){ return m.el; }), 1);
    if(el._at >= ms.length){ el._at = 0; }
    turn(el, el._at);
  }

  /* put nodes into box in this order from child index `from`, moving only
     what is out of place, and remove anything after them that is not kept */
  function place(box, nodes, from, keep){
    nodes.forEach(function(n, i){
      var at = box.children[from + i];
      if(at !== n){ box.insertBefore(n, at || null); }
    });
    var extra = Array.prototype.slice.call(box.children, from + nodes.length);
    extra.forEach(function(n){ if(!keep || !keep(n)){ n.remove(); } });
  }

  function pageEl(p){
    var el = pagesBox.querySelector('.page[data-pid="' + p.id + '"]');
    if(!el){
      el = document.createElement('div');
      el.className = 'page';
      el.setAttribute('data-pid', p.id);
      el.hidden = true;
      pagesBox.appendChild(el);
    }
    return el;
  }

  function draw(){
    drawStrip();
    var used = {}, usedStacks = {}, firstCards = null;
    var wedPage = pagesBox.querySelector('.page[data-kind="wedding"]');
    L.pages.forEach(function(p){
      if(p.kind === 'wedding'){ return; }
      var el = pageEl(p), nodes = [];
      if(!firstCards){ firstCards = el; nodes.push(chrome); }
      p.slots.forEach(function(s){
        var ms = s.w.map(function(w){ used[w.id] = true; return mountOne(w); })
          .filter(Boolean);
        if(!ms.length){ return; }
        if(ms.length === 1){ nodes.push(ms[0].el); return; }
        var st = stackEl(s);
        usedStacks[s.id] = true;
        fillStack(st, s, ms);
        nodes.push(st);
      });
      if(!p.slots.length){ nodes.push(emptyNote()); }
      if(el === firstCards){ nodes.push(signout); }
      place(el, nodes, 0);
      el.classList.toggle('empty', !p.slots.length);
    });
    /* pages no longer in the layout; the wedding frame is kept (moving or
       dropping an iframe reloads it), only hidden */
    Array.prototype.forEach.call(pagesBox.querySelectorAll('.page[data-pid]'), function(el){
      var id = el.getAttribute('data-pid');
      if(!L.pages.some(function(p){ return p.id === id && p.kind !== 'wedding'; })){ el.remove(); }
    });
    for(var k in live){
      if(!used[k]){ live[k].unmount(); live[k].el.remove(); delete live[k]; }
    }
    for(var s in stacks){
      if(!usedStacks[s]){ stacks[s]._mirror.disconnect(); stacks[s].remove(); delete stacks[s]; }
    }
    if(wedPage && !L.pages.some(function(p){ return p.kind === 'wedding'; })){ wedPage.hidden = true; }
    show(current || L.pages[0].id, true);
    document.dispatchEvent(new Event('telayout'));
  }

  /* An empty page says what to do: hold it to edit, which is also how
     anyone first learns edit mode exists. In edit mode it points at Add card. */
  function emptyNote(){
    var b = document.createElement('div');
    b.className = 'page-hint';
    b.innerHTML = '<span class="hint-off">Hold anywhere on this page to edit it and add cards</span>'
      + '<span class="hint-on">Tap Add card below to put a card here</span>';
    return b;
  }

  /* ---- switching pages ----
     Switching always scrolls back to the top, so a page never opens
     halfway through itself. Modules that read on
     opening listen for 'tepage'. */
  function show(id, quiet){
    if(!L){ return; }
    var p =L.pages.filter(function(x){ return x.id === id; })[0] || L.pages[0];
    var changedPage = p.id !== current;
    current = p.id;
    Array.prototype.forEach.call(pagesBox.querySelectorAll('.page'), function(el){
      var match = p.kind === 'wedding' ? el.getAttribute('data-kind') === 'wedding'
        : el.getAttribute('data-pid') === p.id;
      el.hidden = !match;
    });
    Array.prototype.forEach.call(strip.querySelectorAll('.ptab[data-pid]'), function(b){
      var on = b.getAttribute('data-pid') === p.id;
      b.setAttribute('aria-selected', String(on));
      /* a narrow strip scrolls sideways: keep the open tab in view */
      if(on && (b.offsetLeft < strip.scrollLeft
          || b.offsetLeft + b.offsetWidth > strip.scrollLeft + strip.clientWidth)){
        strip.scrollLeft = b.offsetLeft - 8;
      }
    });
    /* every page opens at its top. (Measuring the strip does not work: it
       is sticky, so its offsetTop follows the scroll.) */
    if(!quiet){ window.scrollTo(0, 0); }
    if(changedPage || !quiet){
      document.dispatchEvent(new CustomEvent('tepage', {detail: {id: p.id, kind: p.kind || ''}}));
    }
  }

  /* ---- saving ---- */
  function save(){
    clearTimeout(saveTimer);
    saveTimer = null;
    if(window.TERPC){ window.TERPC('page_layout_set', {p_layout: L}, function(){}); }
  }
  function changed(){
    cache();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1000);
  }

  /* Drawn from the device's copy at once, then from the database's when it
     answers, if that differs. */
  function start(userId){
    user = userId || '';
    L = normalize(cached());
    draw();
    if(!window.TERPC){ return; }
    window.TERPC('page_layout_get', {}, function(err, d){
      if(err || !d || saveTimer){ return; }
      var next = normalize(d);
      if(JSON.stringify(next) === JSON.stringify(L)){ return; }
      L = next;
      cache();
      draw();
    });
  }

  function init(){
    pagesBox = $('pages');
    strip = $('ptabs');
    chrome = $('chrome');
    signout = $('signout');
    strip.querySelector('.ptab-add').addEventListener('click', function(){
      if(window.TEEDIT){ TEEDIT.newPage(); }
    });
  }
  init();

  return {
    start: start,
    show: show,
    current: function(){ return current; },
    page: function(){
      return L && L.pages.filter(function(p){ return p.id === current; })[0];
    },
    get: function(){ return L; },
    /* edit.js hands back a changed layout; it is cleaned, drawn and saved */
    set: function(next){
      L = normalize(next);
      draw();
      changed();
    },
    flush: function(){ if(saveTimer){ save(); } },
    reset: function(){
      L = defaults();
      current = '';
      draw();
      cache();
      clearTimeout(saveTimer);
      saveTimer = null;
      if(window.TERPC){ window.TERPC('page_layout_set', {p_layout: null}, function(){}); }
    },
    uid: uid,
    live: function(cid){ return live[cid]; },
    stack: function(sid){ return stacks[sid]; },
    turn: turn
  };
})();

/* the old name, kept for the FX nudge and anything else that opens a page */
window.TEPAGE = TELAYOUT.show;
