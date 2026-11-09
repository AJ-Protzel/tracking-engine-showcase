/* ==========================================================================
   EDIT MODE: arranging pages and cards like a phone's home screen.

   There is no edit button. Holding a finger still on blank space (or on a
   card's title) for half a second opens edit mode; Done, at the left of the
   page strip, closes it. In edit mode:
   - each card shrinks to a tile with an x on its corner; the x removes it
   - a tile is dragged by its grip, or by holding it a moment: dropped on the
     top or bottom of another tile it moves there; held over the middle of one
     it joins it as a swipe stack; dropped on a page tab it moves to that page
   - a stack shows one x (the whole stack) until tapped open; then each card
     in it has its own x and can be dragged out
   - tabs are dragged the same way to reorder them, the open tab is tapped to
     rename it, and the x on a tab deletes the page after a confirm
   - Add card opens the gallery: each card type, then its versions, live. A
     version is dragged onto the page, or tapped to go at the bottom
   Every change is a new layout handed to TELAYOUT.set, which cleans it (a
   stack left with one card is a plain card again), draws it and saves it.
   ========================================================================== */
var TEEDIT = (function(){
  var HOLD = 500, LIFT = 250, MOVE = 8, MERGE_AFTER = 300, PAGE_AFTER = 600;
  var body = document.body, strip = document.getElementById('ptabs');
  var editing = false, swallowUntil = 0;

  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls){ e.className = cls; }
    if(text != null){ e.textContent = text; }
    return e;
  }
  function L(){ return JSON.parse(JSON.stringify(TELAYOUT.get())); }
  function uid(p){ return TELAYOUT.uid(p); }

  /* ---- the controls edit mode adds: Add card and Done float over the
     bottom corners, so they are in reach wherever the page is scrolled ---- */
  var bar = el('div', 'edit-float');
  var addBtn = el('button', 'edit-btn', 'Add card');
  var done = el('button', 'edit-btn edit-done', 'Done');
  addBtn.type = done.type = 'button';
  bar.appendChild(addBtn);
  bar.appendChild(done);
  body.appendChild(bar);
  addBtn.addEventListener('click', function(){ gallery(); });
  done.addEventListener('click', function(){ leave(); });

  var foot = el('div', 'edit-foot');
  var resetBtn = el('button', 'edit-btn quiet', 'Reset layout');
  var outBtn = el('button', 'edit-btn quiet', 'Sign out');
  resetBtn.type = outBtn.type = 'button';
  foot.appendChild(resetBtn);
  foot.appendChild(outBtn);
  document.getElementById('pages').after(foot);
  resetBtn.addEventListener('click', function(){
    if(!window.confirm('Put every page and card back the way they started?')){ return; }
    TELAYOUT.reset();
  });
  outBtn.addEventListener('click', function(){ document.getElementById('signout').click(); });

  function enter(){
    if(editing){ return; }
    editing = true;
    body.classList.add('editing');
    decorate();
    /* one short wiggle of the cards, to say a mode has started; it does not repeat */
    body.classList.remove('wiggle');
    void body.offsetWidth;
    body.classList.add('wiggle');
    setTimeout(function(){ body.classList.remove('wiggle'); }, 700);
    if(navigator.vibrate){ try { navigator.vibrate(10); } catch(e){} }
  }
  function leave(){
    if(!editing){ return; }
    editing = false;
    closeSheet();
    body.classList.remove('editing');
    Array.prototype.forEach.call(document.querySelectorAll('.stack.open'), function(s){ s.classList.remove('open'); });
    TELAYOUT.flush();
  }

  /* Add card has nowhere to go on the Wedding page */
  function pageKind(){
    var p = TELAYOUT.page();
    addBtn.style.visibility = p && p.kind === 'wedding' ? 'hidden' : '';
  }
  document.addEventListener('tepage', pageKind);

  /* ---- long press on blank space opens edit mode ----
     Blank is anything that is not a control or a card's content; a card's
     title bar counts as blank, as holding a widget does on a phone. Moving
     the finger cancels it, so scrolling never opens edit mode. */
  function blank(t){
    if(document.getElementById('app').hidden){ return false; }
    if(t.closest('#signin, .gal-sheet, .gal-back, .chrome, iframe, .subnav')){ return false; }
    if(t.closest('button, a, input, select, textarea, label, summary')){ return false; }
    if(t.closest('.card-head')){ return true; }
    if(t.closest('section.card')){ return false; }
    return !!t.closest('#app');
  }
  var press = null, pressed = false;
  document.addEventListener('pointerdown', function(ev){
    if(editing || ev.button > 0 || !blank(ev.target)){ return; }
    press = {x: ev.clientX, y: ev.clientY, t: setTimeout(function(){
      press = null;
      pressed = true;
      enter();
    }, HOLD)};
  }, true);
  function cancelPress(){ if(press){ clearTimeout(press.t); press = null; } }
  document.addEventListener('pointermove', function(ev){
    if(press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > MOVE){ cancelPress(); }
  }, true);
  /* the finger that opened edit mode lifts: its click does nothing */
  document.addEventListener('pointerup', function(){
    if(pressed){ pressed = false; swallowUntil = Date.now() + 400; }
    cancelPress();
  }, true);
  document.addEventListener('pointercancel', cancelPress, true);
  window.addEventListener('scroll', cancelPress, {passive: true});
  /* the click that ends a long press, or a drag, does nothing else */
  document.addEventListener('click', function(ev){
    if(Date.now() < swallowUntil){ swallowUntil = 0; ev.stopPropagation(); ev.preventDefault(); }
  }, true);
  document.addEventListener('contextmenu', function(ev){
    if(editing || press){ ev.preventDefault(); }
  });

  /* ---- what each card shows in edit mode ----
     The card itself, drawn small from made-up data (its sample), so the
     whole page fits on screen while it is arranged. Over it lies a handle
     (.tile) with an x on the corner and a grip; the handle takes the
     touches, so nothing on the card is pressed by accident. */
  function tile(card, sub){
    var old = card.querySelector(':scope > .tile');
    if(old){ old.remove(); }
    var t = el('div', 'tile' + (sub ? ' sub' : ''));
    var x = el('button', 'tile-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove');
    var grip = el('span', 'tile-grip', '≡');
    grip.setAttribute('aria-hidden', 'true');
    t.appendChild(x);
    t.appendChild(grip);
    card.insertBefore(t, card.firstChild);
    x.addEventListener('click', function(ev){
      ev.stopPropagation();
      remove(card);
    });
    if(card.hasAttribute('data-w') && !card.querySelector(':scope > .edit-sample')){
      var m = TEW.make(card.getAttribute('data-w'), null, null, true);
      if(m){
        m.el.classList.add('edit-sample');
        m.el.removeAttribute('data-w');
        card.appendChild(m.el);
      }
    }
  }
  /* what a dragged card looks like under the finger */
  function face(card){
    if(!card.classList.contains('stack')){
      return card.querySelector(':scope > .edit-sample') || card;
    }
    var f = el('div', 'stack-face');
    var head = card.querySelector(':scope > .stack-tabs');
    var on = card.querySelector(':scope > section.card:not(.stack-off) > .edit-sample');
    if(head){ f.appendChild(head.cloneNode(true)); }
    if(on){ f.appendChild(on.cloneNode(true)); }
    return f;
  }
  function decorate(){
    if(!editing){ return; }
    Array.prototype.forEach.call(document.querySelectorAll('#pages > .page > section.card'), function(c){
      tile(c, false);
      if(c.classList.contains('stack')){
        Array.prototype.forEach.call(c.querySelectorAll(':scope > [data-cid]'), function(m){ tile(m, true); });
      }
    });
  }
  document.addEventListener('telayout', function(){ decorate(); pageKind(); });

  /* ---- the layout, as edits see it ---- */
  function where(M, card){
    var cid = card.getAttribute('data-cid'), sid = card.getAttribute('data-sid');
    for(var i = 0; i < M.pages.length; i++){
      var slots = M.pages[i].slots || [];
      for(var j = 0; j < slots.length; j++){
        if(sid && slots[j].id === sid){ return {page: M.pages[i], si: j, slot: slots[j]}; }
        for(var k = 0; cid && k < slots[j].w.length; k++){
          if(slots[j].w[k].id === cid){ return {page: M.pages[i], si: j, slot: slots[j], wi: k}; }
        }
      }
    }
    return null;
  }
  /* a card on the page itself, or one card inside a stack */
  function isMember(card){ return card.parentElement && card.parentElement.classList.contains('stack'); }

  /* takes the dragged thing out of M and returns its cards */
  function take(M, src){
    if(src.fresh){ return src.fresh; }
    var at = where(M, src.card);
    if(!at){ return []; }
    if(src.member){ return at.slot.w.splice(at.wi, 1); }
    at.page.slots.splice(at.si, 1);
    return at.slot.w;
  }

  function remove(card){
    var M = L(), member = isMember(card);
    take(M, {card: card, member: member});
    TELAYOUT.set(M);
  }

  /* ---- dragging cards ---- */
  var drag = null, line = el('div', 'drop-line');
  line.hidden = true;
  body.appendChild(line);
  /* while a drag is on, the page must not scroll under the finger */
  document.addEventListener('touchmove', function(ev){ if(drag){ ev.preventDefault(); } }, {passive: false});

  function lift(src, ev, look){
    var g = el('div', 'ghost');
    g.appendChild(look.cloneNode(true));
    body.appendChild(g);
    drag = {src: src, ghost: g, dy: 24, target: null, mergeAt: 0, mergeT: null, pageT: null, tabFor: ''};
    if(src.card){ src.card.classList.add('lifted'); }
    body.classList.add('dragging');
    follow(ev);
  }

  function follow(ev){
    var d = drag;
    d.ghost.style.top = (ev.clientY - d.dy) + 'px';
    /* near the top or bottom edge the page scrolls itself */
    var H = window.innerHeight;
    if(ev.clientY < 90){ window.scrollBy(0, -12); }
    else if(ev.clientY > H - 70){ window.scrollBy(0, 12); }
    var under = document.elementFromPoint(ev.clientX, ev.clientY);
    line.hidden = true;
    var was = d.target;
    d.target = null;
    if(!under){ return; }

    var tab = under.closest('#ptabs .ptab[data-pid]');
    if(tab && !tab.classList.contains('fixed')){
      d.target = {tab: tab.getAttribute('data-pid')};
      if(d.tabFor !== d.target.tab){
        clearTimeout(d.pageT);
        d.tabFor = d.target.tab;
        /* resting on a tab opens that page, to drop somewhere on it */
        d.pageT = setTimeout(function(){ TELAYOUT.show(d.tabFor, true); decorate(); }, PAGE_AFTER);
      }
      mergeOff();
      return;
    }
    clearTimeout(d.pageT);
    d.tabFor = '';

    var card = under.closest('#pages > .page:not([hidden]) > section.card');
    if(card && card === d.src.card){ mergeOff(); return; }
    if(card){
      var r = card.getBoundingClientRect(), y = (ev.clientY - r.top) / r.height;
      if(y > 0.3 && y < 0.7){
        d.target = {card: card, how: 'merge'};
        if(!was || was.card !== card || was.how !== 'merge'){
          mergeOff();
          d.mergeT = setTimeout(function(){ card.classList.add('merge-target'); d.mergeAt = 1; }, MERGE_AFTER);
        }
        return;
      }
      mergeOff();
      d.target = {card: card, how: y <= 0.3 ? 'before' : 'after'};
      showLine(r, d.target.how === 'before' ? r.top - 8 : r.bottom + 6);
      return;
    }
    mergeOff();
    var page = document.querySelector('#pages > .page:not([hidden])');
    if(page && !page.hasAttribute('data-kind') && under.closest('#app')){
      var cards = page.querySelectorAll(':scope > section.card');
      var last = cards[cards.length - 1];
      d.target = {end: page.getAttribute('data-pid')};
      if(last){ var lr = last.getBoundingClientRect(); if(ev.clientY > lr.bottom){ showLine(lr, lr.bottom + 6); } }
    }
  }
  function mergeOff(){
    if(!drag){ return; }
    clearTimeout(drag.mergeT);
    drag.mergeAt = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.merge-target'), function(c){ c.classList.remove('merge-target'); });
  }
  function showLine(r, y){
    line.hidden = false;
    line.style.left = (r.left + window.scrollX) + 'px';
    line.style.width = r.width + 'px';
    line.style.top = (y + window.scrollY - 1) + 'px';
  }

  function drop(){
    var d = drag;
    drag = null;
    clearTimeout(d.pageT);
    clearTimeout(d.mergeT);
    d.ghost.remove();
    line.hidden = true;
    body.classList.remove('dragging');
    if(d.src.card){ d.src.card.classList.remove('lifted'); }
    var merge = d.mergeAt && d.target && d.target.how === 'merge';
    Array.prototype.forEach.call(document.querySelectorAll('.merge-target'), function(c){ c.classList.remove('merge-target'); });
    var t = d.target;
    if(!t || (t.how === 'merge' && !merge)){
      if(d.src.fresh){ reopen(); }
      return;
    }
    var M = L(), tslot = null, tpage = null;
    if(t.card){
      var at = where(M, t.card);
      if(!at){ return; }
      tslot = at.slot.id;
      tpage = at.page.id;
    }
    var moved = take(M, d.src);
    if(!moved.length){ return; }
    var fresh = {id: uid('s'), w: moved};
    if(t.tab || t.end){
      var pg = M.pages.filter(function(p){ return p.id === (t.tab || t.end); })[0];
      if(!pg || pg.kind === 'wedding'){ return; }
      pg.slots.push(fresh);
    } else {
      var page = M.pages.filter(function(p){ return p.id === tpage; })[0];
      var i = page.slots.map(function(s){ return s.id; }).indexOf(tslot);
      if(i < 0){ page.slots.push(fresh); }
      else if(merge){ page.slots[i].w = page.slots[i].w.concat(moved); }
      else { page.slots.splice(t.how === 'before' ? i : i + 1, 0, fresh); }
    }
    TELAYOUT.set(M);
  }

  /* A grip starts a drag at once (now); the rest of a tile after a short
     hold, so a swipe on it still scrolls. A tap without a hold calls onTap. */
  function holdToDrag(ev, start, onTap, now){
    var id = ev.pointerId, x0 = ev.clientX, y0 = ev.clientY, last = ev;
    var moved = false, lifted = false, t = null;
    function fire(){
      t = null;
      if(moved){ return; }
      lifted = true;
      start(last);
    }
    function move(e){
      if(e.pointerId !== id){ return; }
      last = e;
      if(lifted){ if(drag){ follow(e); } return; }
      if(Math.hypot(e.clientX - x0, e.clientY - y0) > MOVE){ moved = true; clearTimeout(t); stop(); }
    }
    function up(e){
      if(e.pointerId !== id){ return; }
      clearTimeout(t);
      stop();
      if(lifted){ if(drag){ swallowUntil = Date.now() + 400; drop(); } return; }
      if(!moved && onTap){ onTap(); }
    }
    function cancel(e){
      if(e.pointerId !== id){ return; }
      clearTimeout(t);
      stop();
      if(lifted && drag){ drop(); }
    }
    function stop(){
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    if(now){ fire(); } else { t = setTimeout(fire, LIFT); }
  }

  document.addEventListener('pointerdown', function(ev){
    if(!editing || drag || ev.button > 0){ return; }
    var tileEl = ev.target.closest('.tile');
    if(!tileEl || ev.target.closest('.tile-x')){ return; }
    var card = tileEl.parentElement, member = tileEl.classList.contains('sub');
    var src = {card: card, member: member};
    var tap = card.classList.contains('stack') && !member
      ? function(){ card.classList.toggle('open'); } : null;
    var grip = !!ev.target.closest('.tile-grip');
    if(grip){ ev.preventDefault(); }
    holdToDrag(ev, function(e){ lift(src, e, face(card)); }, tap, grip);
  });

  /* ---- tabs ---- */
  /* the x deletes a page, after asking; caught before the tab's own click */
  strip.addEventListener('click', function(ev){
    if(!editing){ return; }
    var x = ev.target.closest('.ptab-x');
    if(!x){ return; }
    ev.stopPropagation();
    var pid = x.closest('.ptab').getAttribute('data-pid');
    var M = L(), p = M.pages.filter(function(q){ return q.id === pid; })[0];
    if(!p || p.kind === 'wedding'){ return; }
    var n = (p.slots || []).length;
    if(!window.confirm('Delete the page "' + p.name + '"' + (n ? ' and its ' + n + (n === 1 ? ' card?' : ' cards?') : '?'))){ return; }
    M.pages = M.pages.filter(function(q){ return q.id !== pid; });
    TELAYOUT.set(M);
  }, true);

  /* layout.js asks first on a tab tap: in edit mode the open tab is renamed */
  function tabClick(pid, btn){
    if(!editing){ return false; }
    if(pid !== TELAYOUT.current()){ return false; }
    rename(pid, btn);
    return true;
  }
  function rename(pid, btn){
    var r = btn.getBoundingClientRect();
    var input = el('input', 'tab-rename');
    input.type = 'text';
    input.maxLength = 24;
    input.value = btn.querySelector('.ptab-name').textContent;
    input.style.left = r.left + 'px';
    input.style.top = r.top + 'px';
    input.style.width = Math.max(r.width, 120) + 'px';
    input.style.height = r.height + 'px';
    body.appendChild(input);
    input.focus();
    input.select();
    var gone = false;
    function finish(save){
      if(gone){ return; }
      gone = true;
      var name = input.value.replace(/\s+/g, ' ').trim();
      input.remove();
      if(!save || !name){ return; }
      var M = L();
      M.pages.forEach(function(p){ if(p.id === pid){ p.name = name; } });
      TELAYOUT.set(M);
    }
    input.addEventListener('keydown', function(e){
      if(e.key === 'Enter'){ finish(true); }
      if(e.key === 'Escape'){ finish(false); }
    });
    input.addEventListener('blur', function(){ finish(true); });
  }

  /* a tab is dragged sideways to a new place after a short hold */
  var tdrag = null;
  strip.addEventListener('pointerdown', function(ev){
    if(!editing || drag || ev.button > 0){ return; }
    var tab = ev.target.closest('.ptab[data-pid]');
    if(!tab || ev.target.closest('.ptab-x')){ return; }
    var x0 = ev.clientX, y0 = ev.clientY, id = ev.pointerId;
    var t = setTimeout(function(){
      tdrag = {tab: tab, to: -1};
      tab.classList.add('lifted');
      body.classList.add('dragging');
      drag = {tabbing: true};
    }, LIFT);
    function move(e){
      if(e.pointerId !== id){ return; }
      if(!tdrag){
        if(Math.hypot(e.clientX - x0, e.clientY - y0) > MOVE){ clearTimeout(t); stop(); }
        return;
      }
      var tabs = Array.prototype.slice.call(strip.querySelectorAll('.ptab[data-pid]'));
      var to = tabs.length;
      for(var i = 0; i < tabs.length; i++){
        var r = tabs[i].getBoundingClientRect();
        if(e.clientX < r.left + r.width / 2){ to = i; break; }
      }
      tdrag.to = to;
      var ref = tabs[Math.min(to, tabs.length - 1)].getBoundingClientRect();
      var x = to < tabs.length ? ref.left - 2 : ref.right + 1;
      line.hidden = false;
      line.style.left = (x + window.scrollX) + 'px';
      line.style.width = '3px';
      line.style.top = (ref.top + window.scrollY) + 'px';
      line.style.height = ref.height + 'px';
      var sr = strip.getBoundingClientRect();
      if(e.clientX < sr.left + 30){ strip.scrollLeft -= 8; }
      if(e.clientX > sr.right - 30){ strip.scrollLeft += 8; }
    }
    function up(e){
      if(e.pointerId !== id){ return; }
      clearTimeout(t);
      stop();
      if(!tdrag){ return; }
      var d = tdrag;
      tdrag = null;
      drag = null;
      swallowUntil = Date.now() + 400;
      d.tab.classList.remove('lifted');
      body.classList.remove('dragging');
      line.hidden = true;
      line.style.height = '';
      if(d.to < 0){ return; }
      var M = L(), pid = d.tab.getAttribute('data-pid');
      var from = M.pages.map(function(p){ return p.id; }).indexOf(pid);
      var page = M.pages.splice(from, 1)[0];
      M.pages.splice(d.to > from ? d.to - 1 : d.to, 0, page);
      TELAYOUT.set(M);
    }
    function stop(){
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });

  /* "+" adds an empty page and opens it. It does not start editing: the
     empty page says to hold it, which is how edit mode is found. */
  function newPage(){
    var M = L(), id = uid('p');
    M.pages.push({id: id, name: 'New page', slots: []});
    TELAYOUT.set(M);
    TELAYOUT.show(id);
  }

  /* ---- the gallery ---- */
  var back = el('div', 'gal-back');
  var sheet = el('div', 'gal-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Add card');
  back.hidden = sheet.hidden = true;
  body.appendChild(back);
  body.appendChild(sheet);
  back.addEventListener('click', closeSheet);
  var previews = [];

  function clearPreviews(){
    previews.forEach(function(m){ m.unmount(); });
    previews = [];
  }
  function closeSheet(){
    clearPreviews();
    sheet.hidden = back.hidden = true;
    sheet.classList.remove('away');
  }
  function reopen(){
    sheet.hidden = back.hidden = false;
    sheet.classList.remove('away');
  }

  function sheetHead(text, onBack){
    var h = el('div', 'gal-head');
    if(onBack){
      var b = el('button', 'gal-back-btn', '‹');
      b.type = 'button';
      b.setAttribute('aria-label', 'Back');
      b.addEventListener('click', onBack);
      h.appendChild(b);
    }
    h.appendChild(el('h2', '', text));
    var x = el('button', 'gal-close', 'Close');
    x.type = 'button';
    x.addEventListener('click', closeSheet);
    h.appendChild(x);
    return h;
  }

  /* the card types, each with how many versions it has */
  function gallery(){
    if(!editing){ enter(); }
    var p = TELAYOUT.page();
    if(p && p.kind === 'wedding'){ return; }
    clearPreviews();
    sheet.textContent = '';
    sheet.appendChild(sheetHead('Add card'));
    var types = [];
    TEW.order.forEach(function(id){
      var t = TEW.defs[id].type;
      if(types.indexOf(t) === -1){ types.push(t); }
    });
    var list = el('div', 'gal-types');
    types.forEach(function(t){
      var ids = TEW.order.filter(function(id){ return TEW.defs[id].type === t; });
      var b = el('button', 'gal-type');
      b.type = 'button';
      b.appendChild(el('span', 'gal-type-name', t));
      b.appendChild(el('span', 'gal-type-n', ids.length === 1 ? '1 version' : ids.length + ' versions'));
      b.addEventListener('click', function(){ versions(t, ids); });
      list.appendChild(b);
    });
    sheet.appendChild(list);
    reopen();
    sheet.scrollTop = 0;
  }

  /* one type's versions, drawn live with the data already on the page */
  function versions(type, ids){
    clearPreviews();
    sheet.textContent = '';
    sheet.appendChild(sheetHead(type, gallery));
    if(ids.length > 1){
      var all = el('button', 'edit-btn gal-all', 'Add all ' + ids.length + ' as one swipe card');
      all.type = 'button';
      all.addEventListener('click', function(){
        addFresh(ids.map(function(t){ return {id: uid('c'), t: t}; }));
      });
      sheet.appendChild(all);
    }
    ids.forEach(function(t){
      var d = TEW.defs[t];
      var item = el('div', 'gal-item');
      var head = el('div', 'gal-label');
      head.appendChild(el('span', '', d.version));
      head.appendChild(el('span', 'gal-hint', 'Drag onto the page, or tap to add'));
      item.appendChild(head);
      var m = TEW.make(t, null, null, true);
      if(m){
        var prev = el('div', 'gal-prev');
        prev.appendChild(m.el);
        item.appendChild(prev);
      }
      sheet.appendChild(item);
      item.addEventListener('pointerdown', function(ev){
        if(ev.button > 0){ return; }
        holdToDrag(ev, function(e){
          var look = item.querySelector('.gal-prev > section.card') || item;
          sheet.classList.add('away');
          back.hidden = true;
          lift({fresh: [{id: uid('c'), t: t}]}, e, look);
        }, function(){ addFresh([{id: uid('c'), t: t}]); });
      });
    });
    sheet.scrollTop = 0;
  }

  function addFresh(ws){
    var M = L(), pid = TELAYOUT.current();
    var pg = M.pages.filter(function(p){ return p.id === pid; })[0];
    if(!pg || pg.kind === 'wedding'){ return; }
    pg.slots.push({id: uid('s'), w: ws});
    closeSheet();
    TELAYOUT.set(M);
    var last = document.querySelector('#pages > .page:not([hidden]) > section.card:last-of-type');
    if(last){ last.scrollIntoView({block: 'nearest'}); }
  }

  /* after a drop from the gallery the sheet's work is done */
  document.addEventListener('telayout', function(){
    if(!drag && sheet.classList.contains('away')){ closeSheet(); }
  });

  return {
    tabClick: tabClick,
    gallery: gallery,
    newPage: newPage,
    enter: enter,
    leave: leave,
    editing: function(){ return editing; }
  };
})();
