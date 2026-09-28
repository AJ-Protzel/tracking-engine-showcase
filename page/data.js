/* ==========================================================================
   DATA — page switching, the transaction store, and the one call.

   This file is shared by every page, so it is the one to leave alone when
   working on a single card. It loads first: TE has to exist before the
   page modules subscribe to it, and draw() runs only after page_data()
   answers, by which time they are all defined.
   ========================================================================== */
/* ---- the three pages ----
   Alerts opens first: it is the only page that can be empty, and an empty
   Alerts page is the answer to "is anything waiting on me". Switching pages
   scrolls back to the strip if the last one was scrolled down, so a page
   never opens halfway through itself. */
(function(){
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.ptab'));
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  var bar = document.querySelector('.pagetabs');

  function show(name){
    pages.forEach(function(p){ p.hidden = p.getAttribute('data-page') !== name; });
    tabs.forEach(function(b){
      b.setAttribute('aria-selected',
        String(b.getAttribute('data-page') === name));
    });
    if(bar && window.scrollY > bar.offsetTop){
      window.scrollTo({top: bar.offsetTop});
    }
  }
  tabs.forEach(function(b){
    b.addEventListener('click', function(){ show(b.getAttribute('data-page')); });
  });
  window.TEPAGE = show;
})();

/* ---- the transaction rows ----
   TE holds the rows page_data() returned and hands them to everything that
   draws money: the money card and the Budget card. Transfers are dropped
   outright: a card payment is money already counted when the charges it
   settles posted. */
var TE = (function(){
  var base = [], subs = [];

  function normalize(list){
    return (list || []).map(function(r){
      return {
        id:   (r.id === undefined || r.id === null) ? '' : String(r.id),
        date: String(r.date || ''),
        desc: String(r.desc || ''),
        cat:  r.cat || 'uncategorized',
        amt:  Number(r.amt) || 0,
        prov: r.prov === true,
        card: String(r.card || '')
      };
    }).filter(function(r){ return r.date.length >= 7; });
  }

  function slug(s){
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /* Which row's editor is open, kept across the rebuild a reload causes. */
  function keyOf(r){ return 't:' + r.id; }

  /* How many charges carry this name, so the editor can say what "all of
     them" means before it is picked. */
  function countByName(desc){
    var k = slug(desc), n = 0;
    for(var i = 0; i < base.length; i++){
      if(slug(base[i].desc) === k){ n++; }
    }
    return n;
  }

  function rows(){
    return base.filter(function(r){ return r.cat !== 'transfer'; });
  }

  return {
    CATS: ['dining','grocery','shopping','utility','gas','travel','transfer',
           'income'],
    rows: rows,
    keyOf: keyOf,
    countByName: countByName,
    /* An empty result is ignored on purpose: the page keeps what it has
       rather than blanking. */
    setRows: function(list){
      if(!list || !list.length){ return false; }
      base = normalize(list);
      for(var i = 0; i < subs.length; i++){ subs[i](); }
      return true;
    },
    subscribe: function(fn){ subs.push(fn); }
  };
})();

/* ==========================================================================
   DEMO DATA — the same one call, answered in the browser.

   The live site is static too, but signs in and calls page_data(): a
   security-definer Postgres function that returns every card's rows as one
   JSON object, with writes going through page_rename, page_todo_add,
   page_todo_set, page_settlement_set, page_rental_set and page_rental_dismiss
   (database/functions.sql). This copy has no sign-in and no database.
   TEDEMO() in demo-data.js builds an object of the same shape from invented
   rows, and TERPC below answers the same six writes against it, so every
   card runs unchanged. Nothing is saved: a reload starts over.
   ========================================================================== */
(function(){
  function $(id){ return document.getElementById(id); }

  var state = window.TEDEMO();

  /* The masthead date, in Pacific whatever the phone's clock says. */
  function stampDate(){
    try {
      $('briefDate').textContent = new Date().toLocaleDateString('en-US', {
        timeZone: 'America/Los_Angeles', weekday: 'long',
        month: 'long', day: 'numeric', year: 'numeric'
      }).replace(/,(\s+\d{4})$/, '$1');
    } catch(e){}
  }

  function problem(text){
    $('err').textContent = text || '';
    $('err').hidden = !text;
  }

  function byId(list, id){
    for(var i = 0; i < list.length; i++){
      if(String(list[i].id) === String(id)){ return list[i]; }
    }
    return null;
  }

  /* The six writes, checked the way the database checks them. */
  var RPC = {
    page_todo_add: function(a){
      var text = String(a.p_text || '').trim();
      if(!text || text.length > 200){ throw 'a to-do is 1 to 200 characters'; }
      var id = state.next_id++;
      state.todos.push({ id: id, text: text, done: false, detail: null });
      return id;
    },
    page_todo_set: function(a){
      var t = byId(state.actions, a.p_id) || byId(state.todos, a.p_id)
        || byId(state.backlog, a.p_id);
      if(!t){ return null; }
      t.done = !!a.p_done;
      if((t.kind === 'mail' || t.kind === 'draft') && /^(Save|Trash)$/.test(a.p_file_to || '')){
        t.file_to = a.p_file_to;
      }
      return null;
    },
    page_settlement_set: function(a){
      if(state.settlement_statuses.indexOf(a.p_status) === -1){ throw 'invalid status'; }
      var r = byId(state.settlements, a.p_id);
      if(r){ r.status = a.p_status; }
      return null;
    },
    page_rental_set: function(a){
      if(state.rental_statuses.indexOf(a.p_status) === -1){ throw 'invalid status'; }
      var r = byId(state.rentals, a.p_id);
      if(r){ r.status = a.p_status; }
      return null;
    },
    /* a building is one row on the page, so every unit in it goes */
    page_rental_dismiss: function(a){
      var r = byId(state.rentals, a.p_id);
      if(r){
        state.rentals = state.rentals.filter(function(x){ return x.building !== r.building; });
      }
      return null;
    },
    page_rename: function(a){
      var name = String(a.p_name || '').trim();
      if(!name || name.length > 80){ throw 'a name is 1 to 80 characters'; }
      var t = byId(state.transactions, a.p_txn_id);
      if(!t){ throw 'no transaction ' + a.p_txn_id; }
      var from = t.desc, n = 0;
      state.transactions.forEach(function(x){
        if(x === t || (a.p_whole_merchant && x.desc === from)){
          x.desc = name; x.cat = a.p_category; n++;
        }
      });
      return n;
    }
  };

  window.TERPC = function(name, args, done){
    setTimeout(function(){
      try { done(null, RPC[name](args || {})); }
      catch(e){ done(String(e)); }
    }, 120);
  };

  window.TESAVE = function(d, done){
    window.TERPC('page_rename', {
      p_txn_id: Number(d.txn_id), p_name: d.name,
      p_category: d.cat, p_whole_merchant: d.whole
    }, function(err){
      done(err);
      if(!err){ draw(state); }
    });
  };

  function draw(d){
    problem('');
    stampDate();

    /* the page decorates rows with their card name, so hand it copies */
    var accounts = d.accounts || {};
    var txns = (d.transactions || []).map(function(t){
      var c = {};
      for(var k in t){ c[k] = t[k]; }
      c.card = accounts[String(t.acct)] || '';
      return c;
    });
    TE.setRows(txns);
    $('syncedLine').textContent = (d.synced ? 'Synced ' + d.synced : 'Never synced')
      + (txns.length ? ' · ' + txns.length + ' rows' : '');

    TEFOOD.set(d.people, d.nutrition, d.recs);
    TEJOBS.set(d.jobs);
    TESETTLE.set(d.settlements, d.settlement_statuses);
    /* credits first: Requires Action lists the ones about to expire */
    TECRED.set(d.credits, d.credit_postings);
    TETODO.set(d.todos, d.backlog);

    TEACT.setItems(d.actions, d.problems);
    TERENT.set(d.rentals, d.rental_statuses);
  }

  $('signout').addEventListener('click', function(){
    state = window.TEDEMO();
    draw(state);
    window.scrollTo({top: 0});
  });

  document.addEventListener('gesturestart', function(ev){ ev.preventDefault(); });

  /* The page modules load after this file; live, draw() waits on the
     network, so here it waits for them instead. */
  window.addEventListener('DOMContentLoaded', function(){ draw(state); });
})();
