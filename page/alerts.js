/* ==========================================================================
   ALERTS — requires action, to do, job tracking.

   The first two are both secretary_todos, told apart by list. Writes go
   through TERPC, which data.js owns.
   ========================================================================== */

/* ---- the home-screen badge ----
   The red number on the icon: open Requires Action items plus open to-dos,
   the same two counts the cards show. iOS draws it only for the home-screen
   app, and only once notifications are allowed, so the button above the cards
   asks once, from a tap as iOS requires. The number changes when the app is
   open; nothing pushes it while the app is closed. */
var TEBADGE = (function(){
  var parts = {};
  var ask = document.getElementById('badgeAsk');
  var home = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var able = home && 'setAppBadge' in navigator && 'Notification' in window;

  function paint(){
    if(!able){ return; }
    var n = 0;
    for(var k in parts){ n += parts[k]; }
    try {
      (n ? navigator.setAppBadge(n) : navigator.clearAppBadge())
        .catch(function(){});
    } catch(e){}
  }

  if(able && Notification.permission === 'default'){
    ask.hidden = false;
    ask.addEventListener('click', function(){
      Notification.requestPermission().then(function(){
        ask.hidden = true;
        paint();
      }, function(){ ask.hidden = true; });
    });
  }

  return {
    set: function(part, n){ parts[part] = n; paint(); }
  };
})();

/* ---- requires action ----
   Claude's list for him, in secretary_todos. The sweep raises the items; a tap
   crosses one off; the next sweep does what crossing it means — files the
   email, moves a bill to Money/Out — and clears it. Problems sit above the
   items, then charges with no category. Both are worked out on every load
   and clear themselves once fixed, so they cannot be crossed off. */
var TEACT = (function(){
  var list = document.getElementById('actList');
  var countEl = document.getElementById('actCount');
  var clearEl = document.getElementById('allClear');
  var TAGS = { draft: 'Draft', mail: 'Mail', no_time: 'No time', bill: 'Bill',
               interview: 'Interview', invite: 'Invite', event_added: 'Added',
               double_booking: 'Clash', subscription: 'Subscription' };
  /* A crossed-off email that wanted a reply goes to Save unless he picks
     Trash; everything else already knows where it goes. */
  var CHOOSE = { mail: true, draft: true };

  /* The card never hides itself. An empty card cannot be told from one that
     failed to load, so the all-clear line stands in its place instead. */
  function render(){
    var open = list.querySelectorAll('.act-problem, .act-uncat, .todo-item:not(.done)').length;
    var any = list.children.length;
    countEl.textContent = open === 0 ? 'clear' : String(open);
    countEl.className = open === 0 ? 'count' : 'count act';
    TEBADGE.set('act', open);
    list.hidden = any === 0;
    clearEl.hidden = any !== 0;
  }

  function tag(text){
    var t = document.createElement('span');
    t.className = 'tag';
    t.textContent = text;
    return t;
  }

  function words(text, detail){
    var body = document.createElement('span');
    body.className = 'act-body';
    var main = document.createElement('span');
    main.className = 'todo-text';
    main.textContent = text;
    body.appendChild(main);
    if(detail){
      var sm = document.createElement('span');
      sm.className = 'txn-meta';
      sm.textContent = detail;
      body.appendChild(sm);
    }
    return body;
  }

  function problem(p){
    var li = document.createElement('li');
    li.className = 'act-problem';
    li.appendChild(tag(p.tag));
    li.appendChild(words(p.txt, p.detail));
    return li;
  }

  function item(a){
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    var box = document.createElement('span');
    box.className = 'todo-box';
    box.setAttribute('aria-hidden', 'true');
    box.textContent = '\u2713';
    var main = document.createElement('span');
    main.className = 'act-main';
    main.appendChild(tag(TAGS[a.kind] || a.kind));
    main.appendChild(words(a.text, a.detail));
    b.appendChild(box);
    b.appendChild(main);
    li.appendChild(b);

    var done = !!a.done;
    var fileTo = a.file_to === 'Trash' ? 'Trash' : 'Save';
    var pick = null;

    function send(d, back){
      window.TERPC('page_todo_set', {
        p_id: Number(a.id), p_done: d, p_file_to: CHOOSE[a.kind] ? fileTo : null
      }, function(err){ if(err){ back(); } });
    }

    function paint(){
      b.className = 'todo-item' + (done ? ' done' : '');
      b.setAttribute('aria-pressed', String(done));
      if(pick){
        pick.hidden = !done;
        for(var i = 0; i < pick.children.length; i++){
          var c = pick.children[i];
          if(c.tagName === 'BUTTON'){
            c.setAttribute('aria-pressed', String(c.textContent === fileTo));
          }
        }
      }
      render();
    }

    if(CHOOSE[a.kind]){
      pick = document.createElement('div');
      pick.className = 'file-pick';
      var lab = document.createElement('span');
      lab.className = 'file-lab';
      lab.textContent = 'Then to';
      pick.appendChild(lab);
      ['Save', 'Trash'].forEach(function(where){
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'file-opt';
        c.textContent = where;
        c.addEventListener('click', function(){
          if(where === fileTo){ return; }
          var was = fileTo;
          fileTo = where;
          paint();
          send(true, function(){ fileTo = was; paint(); });
        });
        pick.appendChild(c);
      });
      li.appendChild(pick);
    }

    b.addEventListener('click', function(){
      done = !done;
      paint();
      send(done, function(){ done = !done; paint(); });
    });
    paint();
    return li;
  }

  /* A settled charge with no category, filed from here with one tap. The
     name field starts as the bank's name and can be changed first; the tap
     saves both, for the whole merchant, so its future charges arrive categorized and
     never land here again. Pending charges wait until they settle: the bank
     feed rewrites a pending row every four hours, and an edit made to one
     does not reliably survive. TESAVE reads every row again afterwards,
     which redraws this list without the row. */
  var SPEND = ['dining','grocery','shopping','utility','gas','travel','transfer'];
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function uncat(r){
    var li = document.createElement('li');
    li.className = 'act-uncat';
    var head = document.createElement('div');
    head.className = 'act-main';
    head.appendChild(tag('No category'));
    var p = r.date.split('-');
    head.appendChild(words(r.desc, '$' + (-r.amt).toFixed(2) + ' · '
      + MON[(+p[1]) - 1] + ' ' + (+p[2]) + (r.card ? ' · ' + r.card : '')));
    li.appendChild(head);

    var name = document.createElement('input');
    name.className = 'uncat-name';
    name.type = 'text';
    name.value = r.desc;
    name.maxLength = 80;
    name.autocomplete = 'off';
    name.setAttribute('aria-label', 'Name for ' + r.desc);
    li.appendChild(name);

    var pick = document.createElement('div');
    pick.className = 'file-pick cat-pick';
    SPEND.forEach(function(c){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'file-opt';
      b.textContent = c;
      b.addEventListener('click', function(){
        if(pick.getAttribute('aria-busy') === 'true'){ return; }
        pick.setAttribute('aria-busy', 'true');
        b.setAttribute('aria-pressed', 'true');
        var clean = name.value.replace(/^\s+|\s+$/g, '') || r.desc;
        window.TESAVE({ txn_id: r.id, name: clean, cat: c, whole: true }, function(err){
          if(!err){ return; }
          pick.removeAttribute('aria-busy');
          b.setAttribute('aria-pressed', 'false');
        });
      });
      pick.appendChild(b);
    });
    li.appendChild(pick);
    return li;
  }

  /* A card credit whose deadline has turned yellow on Balance, with money
     still on it. Worked out on every load from the Credits card, never
     stored, so there is nothing to cross off: it goes once the credit shows
     as claimed there, or its cycle ends. */
  function credit(c){
    var li = document.createElement('li');
    li.className = 'act-problem';
    li.appendChild(tag('Credit'));
    li.appendChild(words('Use the ' + c.name + ' credit',
      '$' + (c.left % 1 ? c.left.toFixed(2) : c.left) + ' left · '
      + c.card + ' · ' + (c.days === 1 ? '1 day' : c.days + ' days')
      + ', ends ' + c.ends));
    return li;
  }

  function setItems(actions, problems){
    list.textContent = '';
    (problems || []).forEach(function(p){ list.appendChild(problem(p)); });
    /* called after TECRED.set, so the credits are already worked out */
    TECRED.due().forEach(function(c){ list.appendChild(credit(c)); });
    TE.rows().filter(function(r){
      return r.cat === 'uncategorized' && !r.prov && r.amt < 0;
    }).forEach(function(r){ list.appendChild(uncat(r)); });
    (actions || []).forEach(function(x){ list.appendChild(item(x)); });
    render();
  }

  render();
  return { setItems: setItems };
})();

/* One to-do row, shared by To Do and Backlog. A tap crosses it off on screen
   at once and writes after; a failed write puts it back. after() recounts
   the list the row sits in. */
function todoRow(t, after){
  var li = document.createElement('li');
  var b = document.createElement('button');
  b.type = 'button';
  var box = document.createElement('span');
  box.className = 'todo-box';
  box.setAttribute('aria-hidden', 'true');
  box.textContent = '\u2713';
  var text = document.createElement('span');
  text.className = 'todo-text';
  text.textContent = t.text;
  b.appendChild(box);
  if(t.detail){
    /* the line under it: where he left off, numbers, steps */
    var body = document.createElement('span');
    body.className = 'act-body';
    var sm = document.createElement('span');
    sm.className = 'txn-meta';
    sm.textContent = t.detail;
    body.appendChild(text);
    body.appendChild(sm);
    b.appendChild(body);
  } else {
    b.appendChild(text);
  }

  function mark(done){
    b.className = 'todo-item' + (done ? ' done' : '');
    b.setAttribute('aria-pressed', String(done));
    after();
  }

  b.className = 'todo-item' + (t.done ? ' done' : '');
  b.setAttribute('aria-pressed', String(!!t.done));
  b.addEventListener('click', function(){
    var done = b.className.indexOf(' done') === -1;
    mark(done);
    window.TERPC('page_todo_set', { p_id: Number(t.id), p_done: done, p_file_to: null }, function(err){
      if(err){ mark(!done); }
    });
  });
  li.appendChild(b);
  return li;
}

/* ---- to do ----
   secretary_todos (list = 'todo'), through page_todo_add and page_todo_set. */
var TETODO = (function(){
  var list = document.getElementById('todoList');
  var back = document.getElementById('backList');
  var pane = document.getElementById('todoPane');
  var tabs = document.getElementById('todoTabs');
  var tabTodo = document.getElementById('tabTodo');
  var tabBack = document.getElementById('tabBack');
  var countEl = document.getElementById('todoCount');
  var note = document.getElementById('todoNote');
  var form = document.getElementById('todoForm');
  var input = document.getElementById('todoInput');
  var addBtn = form.querySelector('button');
  var onBack = false;

  /* The header count and the badge are To Do only; the Backlog tab carries
     its own number and counts toward nothing. */
  function render(){
    var open = list.querySelectorAll('.todo-item:not(.done)').length;
    var parked = back.querySelectorAll('.todo-item:not(.done)').length;
    countEl.textContent = String(open);
    countEl.className = open ? 'count act' : 'count';
    TEBADGE.set('todo', open);
    tabTodo.textContent = 'To Do' + (open ? ' ' + open : '');
    tabBack.textContent = 'Backlog' + (parked ? ' ' + parked : '');
    tabs.hidden = back.children.length === 0;
    if(tabs.hidden){ onBack = false; }
    pane.hidden = onBack;
    back.hidden = !onBack;
    tabTodo.setAttribute('aria-pressed', String(!onBack));
    tabBack.setAttribute('aria-pressed', String(onBack));
    note.hidden = !(onBack ? back : list).querySelector('.todo-item.done');
  }

  tabTodo.addEventListener('click', function(){ onBack = false; render(); });
  tabBack.addEventListener('click', function(){ onBack = true; render(); });

  function item(t){ return todoRow(t, render); }

  /* The text stays in the field until the write succeeds, so a failed add can
     simply be tried again. */
  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    var text = input.value.replace(/^\s+|\s+$/g, '');
    if(!text || addBtn.disabled){ return; }
    addBtn.disabled = true;
    window.TERPC('page_todo_add', { p_text: text }, function(err, id){
      addBtn.disabled = false;
      if(err){ return; }
      input.value = '';
      list.appendChild(item({ id: id, text: text, done: false }));
      render();
    });
  });

  function set(rows, parked){
    list.textContent = '';
    back.textContent = '';
    (rows || []).forEach(function(t){ list.appendChild(item(t)); });
    (parked || []).forEach(function(t){ back.appendChild(item(t)); });
    render();
  }

  render();
  return { set: set };
})();

/* ---- settlements ----
   accountant_settlements, through page_settlement_set. page_data() sends only
   the rows still his to act on. Each status gets its own buttons, and the
   status a button writes is checked against settlement_statuses — the enum,
   as page_data() read it — so a renamed value drops the button rather than
   sending a value the database would reject. A tap moves the row on at once;
   a failed write puts it back. */
var TESETTLE = (function(){
  var list = document.getElementById('setList');
  var countEl = document.getElementById('setCount');
  var empty = document.getElementById('setEmpty');
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var rows = [], known = [];

  /* status -> the buttons it offers: [label, status it writes] */
  var NEXT = {
    ask:     [['I have it', 'new'], ['No', 'skipped']],
    'new':   [['Filed', 'ongoing'], ['Skip', 'skipped']],
    ongoing: [['Paid', 'done']]
  };

  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls){ e.className = cls; }
    if(text !== undefined && text !== null){ e.textContent = text; }
    return e;
  }
  function safe(u){ return /^https:\/\//i.test(String(u || '')) ? String(u) : ''; }

  function daysTo(iso){
    var p = String(iso).split('-'), d = new Date(+p[0], (+p[1]) - 1, +p[2]);
    var t = new Date(); t.setHours(0, 0, 0, 0);
    return { n: Math.round((d - t) / 86400000), label: MON[d.getMonth()] + ' ' + d.getDate() };
  }

  function row(r){
    var li = el('li', 'set');
    var head = el('div', 'set-head');
    head.appendChild(el('span', 'set-title', r.title));
    if(r.status === 'ongoing'){ head.appendChild(el('span', 'tag', 'Filed')); }
    li.appendChild(head);

    var meta = el('p', 'txn-meta set-meta');
    var bits = [];
    if(r.payout){ bits.push(r.payout); }
    if(r.proof === true){ bits.push('proof needed'); }
    if(r.proof === false){ bits.push('no proof needed'); }
    meta.textContent = bits.join(' · ');
    if(r.deadline && r.status !== 'ongoing'){
      var d = daysTo(r.deadline);
      var when = el('span', d.n <= 14 ? 'soon' : '',
        (bits.length ? ' · ' : '') + 'closes ' + d.label
        + (d.n <= 14 ? ' (' + (d.n === 0 ? 'today' : d.n === 1 ? '1 day' : d.n + ' days') + ')' : ''));
      meta.appendChild(when);
    }
    if(meta.textContent){ li.appendChild(meta); }

    if(r.status === 'ask' && r.asks_about){
      li.appendChild(el('p', 'set-ask', 'Do you have, or did you ever have, ' + r.asks_about + '?'));
    }
    li.appendChild(el('p', 'set-why', r.evidence));
    if(r.claim_id){ li.appendChild(el('p', 'set-why', 'Claim ID ' + r.claim_id)); }
    if(r.notes){ li.appendChild(el('p', 'set-why', r.notes)); }

    var acts = el('div', 'set-acts');
    if(r.status === 'new' && safe(r.url)){
      var go = el('a', 'set-go', 'File the claim');
      go.href = safe(r.url);
      go.target = '_blank';
      go.rel = 'noopener';
      acts.appendChild(go);
    }
    (NEXT[r.status] || []).forEach(function(n){
      if(known.indexOf(n[1]) === -1){ return; }
      var b = el('button', 'file-opt', n[0]);
      b.type = 'button';
      b.addEventListener('click', function(){
        var was = r.status;
        r.status = n[1];
        render();
        window.TERPC('page_settlement_set', { p_id: Number(r.id), p_status: n[1] }, function(err){
          if(err){ r.status = was; render(); }
        });
      });
      acts.appendChild(b);
    });
    li.appendChild(acts);
    return li;
  }

  function render(){
    list.textContent = '';
    var shown = rows.filter(function(r){ return NEXT[r.status]; });
    shown.forEach(function(r){ list.appendChild(row(r)); });
    var open = shown.filter(function(r){ return r.status !== 'ongoing'; }).length;
    countEl.textContent = String(open);
    countEl.className = open ? 'count act' : 'count';
    empty.hidden = shown.length !== 0;
  }

  render();
  return {
    set: function(r, s){ rows = (r || []).slice(); known = (s || []).slice(); render(); }
  };
})();

/* ---- job tracking, all-time ----
   Counted from secretary_job_events, which the 1am sweep fills from job mail.
   All-time on purpose: the tally runs until the search ends. */
var TEJOBS = (function(){
  function put(id, n){ document.getElementById(id).textContent = n; }

  return {
    set: function(j){
      var n = (j && j.counts) || {};
      put('jobApps', n.application || 0);
      put('jobRej', n.rejection || 0);
      put('jobInt', n.interview || 0);
    }
  };
})();
