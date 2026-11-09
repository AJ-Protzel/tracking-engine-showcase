/* ==========================================================================
   DATA: the transaction store, sign-in, and the one call. Pages and
   cards are drawn by layout.js.

   This file is shared by every page, so it is the one to leave alone when
   working on a single card. It loads first: TE has to exist before the
   page modules subscribe to it, and draw() runs only after page_data()
   answers, by which time they are all defined.
   ========================================================================== */
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
        wed:  r.wed === true,
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
   DEMO DATA: this copy has no sign-in and no database.

   The live site is static too, but signs in and calls page_data(): a
   security-definer Postgres function that returns every card's rows as one
   JSON object, with every write going through its own function
   (database/functions.sql). Here TEDEMO() in demo-data.js builds an object
   of the same shape from an invented household, and TERPC below answers the
   same calls against it, so every page runs unchanged. Nothing is saved: a
   reload or "Reset the demo" starts over.
   ========================================================================== */
(function(){
  function $(id){ return document.getElementById(id); }

  var state = window.TEDEMO();
  var layout = null;

  function problem(text){
    $('err').textContent = text || '';
    $('err').hidden = !text;
  }
  function byId(list, id){
    for(var i = 0; i < (list || []).length; i++){
      if(String(list[i].id) === String(id)){ return list[i]; }
    }
    return null;
  }
  function copy(o){ return JSON.parse(JSON.stringify(o)); }

  /* every call the page makes, checked the way the database checks it */
  var RPC = {
    page_data: function(){ return copy(state); },
    page_layout_get: function(){ return layout; },
    page_layout_set: function(a){ layout = a.p_layout; return null; },
    page_monarch_data: function(){ return copy(state.monarch); },
    page_highlights: function(){ return copy(state.highlights); },
    page_highlight_dismiss: function(a){
      state.highlights = state.highlights.filter(function(r){ return r.sender !== a.p_sender; });
      return null;
    },
    page_wedding_data: function(){ return copy(state.wedding); },
    page_shop_get: function(){ return copy(state.shop); },
    page_shop_set: function(a){ state.shop[a.p_key] = !!a.p_got; return null; },
    page_push_subscribe: function(){ return null; },
    page_setting_set: function(a){ state.settings[a.p_key] = a.p_value; return null; },
    page_todo_add: function(a){
      var text = String(a.p_text || '').trim();
      if(!text || text.length > 200){ throw 'a to-do is 1 to 200 characters'; }
      var id = state.next_id++;
      state.todos.push({id: id, text: text, done: false, detail: null});
      return id;
    },
    page_todo_set: function(a){
      var t = byId(state.actions, a.p_id) || byId(state.todos, a.p_id) || byId(state.backlog, a.p_id);
      if(t){ t.done = !!a.p_done; if(a.p_file_to){ t.file_to = a.p_file_to; } }
      return null;
    },
    page_todo_feedback: function(a){
      var t = byId(state.actions, a.p_id);
      if(t){ t.verdict = a.p_verdict || null; t.note = a.p_note || null; }
      return null;
    },
    page_settlement_set: function(a){
      if(state.settlement_statuses.indexOf(a.p_status) === -1){ throw 'invalid status'; }
      var r = byId(state.settlements, a.p_id);
      if(r){ r.status = a.p_status; }
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
    },
    page_wedding: function(a){
      var t = byId(state.transactions, a.p_txn_id);
      if(t){ t.wed = !!a.p_wedding; }
      return null;
    }
  };

  window.TERPC = function(name, args, done){
    setTimeout(function(){
      if(!RPC[name]){ done('the demo has no ' + name); return; }
      try { done(null, RPC[name](args || {})); }
      catch(e){ done(String(e)); }
    }, 120);
  };

  window.TESAVE = function(d, done){
    window.TERPC('page_rename', {
      p_txn_id: Number(d.txn_id), p_name: d.name,
      p_category: d.cat, p_whole_merchant: d.whole
    }, function(err){
      if(err || d.wed === undefined){ done(err); if(!err){ draw(copy(state)); } return; }
      window.TERPC('page_wedding', {p_txn_id: Number(d.txn_id), p_wedding: d.wed}, function(err2){
        done(err2);
        draw(copy(state));
      });
    });
  };

  function draw(d){
    problem('');
    var txns = d.transactions || [], accounts = d.accounts || {};
    txns.forEach(function(t){ t.card = accounts[String(t.acct)] || ''; });
    TE.setRows(txns);

    if(window.TEBUDGET){ TEBUDGET.set(d.settings); }
    if(window.TEFOOD){ TEFOOD.set(d.people, d.nutrition, d.recs); }
    TEJOBS.set(d.jobs);
    TEHIGH.load();
    TESETTLE.set(d.settlements, d.settlement_statuses);
    TECRED.set(d.credits, d.credit_postings);
    TETODO.set(d.todos, d.backlog);

    TEACT.setItems(d.actions, d.problems);
    TEUSAGE.set(d.usage);
    TEBADGE.push(d.push_key);
  }

  $('signout').addEventListener('click', function(){
    state = window.TEDEMO();
    layout = null;
    draw(copy(state));
    window.scrollTo({top: 0});
  });

  document.addEventListener('gesturestart', function(ev){ ev.preventDefault(); });

  /* after every script has run, so the layout and the cards exist first */
  window.addEventListener('DOMContentLoaded', function(){
    $('signin').hidden = true;
    $('app').hidden = false;
    TELAYOUT.start('demo');
    draw(copy(state));
  });
})();
