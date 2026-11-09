/* ==========================================================================
   ALERTS: requires action, to do, settlements and job tracking, each a
   widget (layout.js), and the badge, push and usage line over the first page.

   The first two are both secretary_todos, told apart by list. Writes go
   through TERPC, which data.js owns.
   ========================================================================== */

/* ---- the home-screen badge ----
   The red number on the icon: open Requires Action items only, the same count
   that card shows. To-dos and the Wedding page count toward nothing here
   (2026-09-28). iOS draws it only for the home-screen
   app, and only once notifications are allowed, so the button above the cards
   asks once, from a tap as iOS requires. The number changes when the app is
   open, and with every push from the mail watch while it is closed.

   Push: once the database has a push key, the home-screen app registers
   sw.js and, the first time on each phone, shows one button to subscribe;
   iOS wants that from a tap. An existing subscription is sent again on each
   launch, so one the database dropped comes back by itself. */
var TEBADGE = (function(){
  var parts = {};
  var ask = document.getElementById('badgeAsk');
  var pushAsk = document.getElementById('pushAsk');
  var pushTried = false;
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

  function keyBytes(s){
    var b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    var out = new Uint8Array(b.length);
    for(var i = 0; i < b.length; i++){ out[i] = b.charCodeAt(i); }
    return out;
  }
  function save(sub){
    var j = sub.toJSON();
    window.TERPC('page_push_subscribe', {
      p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth
    }, function(){});
  }
  function push(key){
    if(pushTried || !key || !home || !('serviceWorker' in navigator) || !('PushManager' in window)){
      return;
    }
    pushTried = true;
    navigator.serviceWorker.register('sw.js').catch(function(){});
    navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.getSubscription().then(function(sub){
        if(sub){ save(sub); return; }
        pushAsk.hidden = false;
        pushAsk.addEventListener('click', function(){
          Notification.requestPermission().then(function(p){
            if(p !== 'granted'){ pushAsk.hidden = true; return; }
            return reg.pushManager.subscribe({
              userVisibleOnly: true, applicationServerKey: keyBytes(key)
            }).then(function(s){ save(s); pushAsk.hidden = true; ask.hidden = true; paint(); });
          }).catch(function(){
            pushAsk.textContent = 'Could not turn on alerts. Tap to try again.';
          });
        });
      });
    }).catch(function(){});
  }

  return {
    set: function(part, n){ parts[part] = n; paint(); },
    push: push
  };
})();

/* ---- free-plan headroom ----
   One quiet line over the cards: Cloudflare Pages builds left this month and
   database space left, both against the free plans. The build count comes
   from the newest bank sweep; the size is read live. No history is kept. */
var TEUSAGE = (function(){
  var line = document.getElementById('usageLine');
  return {
    set: function(u){
      if(!u){ line.hidden = true; return; }
      var bits = [], cf = u.cloudflare;
      if(cf && cf.limit != null){
        bits.push('Cloudflare ' + (cf.limit - cf.used) + '/' + cf.limit + ' builds left');
      } else {
        bits.push('Cloudflare builds unknown' + (cf && cf.error ? ' (' + cf.error + ')' : ''));
      }
      if(u.db_bytes != null){
        var mb = function(b){ return Math.round(b / 1048576); };
        bits.push('Supabase ' + mb(u.db_limit - u.db_bytes) + '/' + mb(u.db_limit) + ' MB left');
      }
      line.textContent = bits.join(' · ');
      line.hidden = false;
    }
  };
})();

/* ---- requires action ----
   Claude's list for him, in secretary_todos. The 10am sweep and the mail
   watch raise the items; a tap crosses one off; within about 10 minutes the
   mail watch does what crossing it means (files the email, moves a bill to
   Money) and clears it. Items with a deadline come first. Problems sit above the
   items, then charges with no category. Both are worked out on every load
   and clear themselves once fixed, so they cannot be crossed off. */
var TEACT = (function(){
  var I = TEW.list();
  var data = {actions: [], problems: [], credits: [], uncats: []};
  var TAGS = { draft: 'Draft', mail: 'Mail', no_time: 'No time', bill: 'Bill',
               interview: 'Interview', invite: 'Invite', event_added: 'Added',
               double_booking: 'Clash', subscription: 'Subscription' };
  /* A crossed-off email that wanted a reply goes to Save unless he picks
     Trash; everything else already knows where it goes. */
  var CHOOSE = { mail: true, draft: true };

  /* Counted from the data, not from any one card, so the badge is right
     however many copies of the card are on screen, or none. */
  function openCount(){
    return data.problems.length + data.credits.length + data.uncats.length
      + data.actions.filter(function(a){ return !a.done; }).length;
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

  /* One of Claude's items. Its state lives on the row itself, so a tap in
     one copy of the card shows in every copy. */
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
    /* the mail watch's own rows say New until the 10am sweep reads them */
    main.appendChild(tag(a.watch ? 'New' : (TAGS[a.kind] || a.kind)));
    var body = words(a.text, a.detail);
    if(a.due){
      var due = new Date(a.due);
      var when = document.createElement('span');
      when.className = 'act-due' + (due - Date.now() < 864e5 ? ' soon' : '');
      when.textContent = 'Due ' + due.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
      body.insertBefore(when, body.children[1] || null);
    }
    main.appendChild(body);
    b.appendChild(box);
    b.appendChild(main);
    li.appendChild(b);

    b.className = 'todo-item' + (a.done ? ' done' : '');
    b.setAttribute('aria-pressed', String(!!a.done));
    function fileTo(){ return a.file_to === 'Trash' ? 'Trash' : 'Save'; }

    /* back() undoes the change on screen if the write fails */
    function send(back){
      window.TERPC('page_todo_set', {
        p_id: Number(a.id), p_done: !!a.done, p_file_to: CHOOSE[a.kind] ? fileTo() : null
      }, function(err){ if(err){ back(); drawAll(); } });
    }

    if(CHOOSE[a.kind]){
      var pick = document.createElement('div');
      pick.className = 'file-pick';
      pick.hidden = !a.done;
      var lab = document.createElement('span');
      lab.className = 'file-lab';
      lab.textContent = 'Then to';
      pick.appendChild(lab);
      ['Save', 'Trash'].forEach(function(where){
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'file-opt';
        c.textContent = where;
        c.setAttribute('aria-pressed', String(where === fileTo()));
        c.addEventListener('click', function(){
          if(where === fileTo()){ return; }
          var was = a.file_to;
          a.file_to = where;
          drawAll();
          send(function(){ a.file_to = was; });
        });
        pick.appendChild(c);
      });
      li.appendChild(pick);

      /* Teaching the mail sorter: a verdict on the sender (Spam also trashes
         it) and a free note Claude reads, for what it should do with it. */
      var teach = document.createElement('div');
      teach.className = 'file-pick teach';
      teach.hidden = !a.done;
      [['spam', 'Spam'], ['quiet', 'Not urgent'], ['important', 'Important']].forEach(function(o){
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'file-opt';
        c.textContent = o[1];
        c.setAttribute('aria-pressed', String(a.verdict === o[0]));
        c.addEventListener('click', function(){
          var was = a.verdict, wasTo = a.file_to;
          a.verdict = was === o[0] ? null : o[0];
          if(a.verdict === 'spam'){ a.file_to = 'Trash'; }
          else if(a.file_to === 'Trash' && a.verdict){ a.file_to = 'Save'; }
          drawAll();
          window.TERPC('page_todo_feedback', {p_id: Number(a.id), p_verdict: a.verdict || '', p_note: a.note || null},
            function(err){ if(err){ a.verdict = was; a.file_to = wasTo; drawAll(); } });
        });
        teach.appendChild(c);
      });
      li.appendChild(teach);

      var nb = document.createElement('div');
      nb.className = 'teach-note';
      nb.hidden = !a.done;
      var box2 = document.createElement('input');
      box2.type = 'text';
      box2.maxLength = 500;
      box2.autocomplete = 'off';
      box2.placeholder = 'Tell Claude: what it is, how much it matters, what to do';
      box2.value = a.note || '';
      box2.setAttribute('aria-label', 'Note to Claude about ' + a.text);
      var sv = document.createElement('button');
      sv.type = 'button';
      sv.className = 'file-opt';
      sv.textContent = a.note ? 'Saved' : 'Send';
      function saveNote(){
        var txt = box2.value.replace(/^\s+|\s+$/g, '');
        if(txt === (a.note || '')){ return; }
        var was = a.note;
        a.note = txt || null;
        sv.textContent = txt ? 'Saved' : 'Send';
        window.TERPC('page_todo_feedback', {p_id: Number(a.id), p_verdict: a.verdict || '', p_note: txt || null},
          function(err){ if(err){ a.note = was; sv.textContent = 'Failed'; } });
      }
      sv.addEventListener('click', saveNote);
      box2.addEventListener('blur', saveNote);
      box2.addEventListener('input', function(){ sv.textContent = 'Send'; });
      nb.appendChild(box2);
      nb.appendChild(sv);
      li.appendChild(nb);
    }

    b.addEventListener('click', function(){
      a.done = !a.done;
      drawAll();
      send(function(){ a.done = !a.done; });
    });
    return li;
  }

  /* A settled charge with no category. The name field starts as the bank's
     name and can be changed first; a tap picks a category, a second row
     holds the secondary tags (wedding, this charge only), and Save writes
     them all, the name and category for the whole merchant so its future
     charges arrive categorized and never land here again. TESAVE reads every
     row again afterwards, which redraws this list without the row. */
  var SPEND = ['dining','grocery','shopping','utility','gas','travel','transfer'];
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function chip(text, on, click){
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'file-opt';
    b.textContent = text;
    b.setAttribute('aria-pressed', String(!!on));
    b.addEventListener('click', click);
    return b;
  }

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

    var cat = '', wed = !!r.wed, busy = false;
    var save = document.createElement('button');

    var pick = document.createElement('div');
    pick.className = 'file-pick cat-pick';
    var catBtns = SPEND.map(function(c){
      var b = chip(c, false, function(){
        if(busy){ return; }
        cat = c;
        catBtns.forEach(function(x){
          x.setAttribute('aria-pressed', String(x === b));
        });
        save.disabled = false;
      });
      pick.appendChild(b);
      return b;
    });
    li.appendChild(pick);

    var tags = document.createElement('div');
    tags.className = 'file-pick cat-pick tag-pick';
    var tl = document.createElement('span');
    tl.className = 'file-lab';
    tl.textContent = 'Tags';
    tags.appendChild(tl);
    var wb = chip('wedding', wed, function(){
      if(busy){ return; }
      wed = !wed;
      wb.setAttribute('aria-pressed', String(wed));
    });
    tags.appendChild(wb);
    li.appendChild(tags);

    var acts = document.createElement('div');
    acts.className = 'uncat-acts';
    save.type = 'button';
    save.className = 'uncat-save';
    save.textContent = 'Save';
    save.disabled = true;
    var msg = document.createElement('span');
    msg.className = 'file-lab';
    acts.appendChild(save);
    acts.appendChild(msg);
    li.appendChild(acts);

    save.addEventListener('click', function(){
      if(busy || !cat){ return; }
      busy = true;
      save.disabled = true;
      li.setAttribute('aria-busy', 'true');
      msg.textContent = 'Saving…';
      var clean = name.value.replace(/^\s+|\s+$/g, '') || r.desc;
      window.TESAVE({ txn_id: r.id, name: clean, cat: cat, whole: true,
                      wed: wed === !!r.wed ? undefined : wed }, function(err){
        if(!err){ return; }
        busy = false;
        save.disabled = false;
        li.removeAttribute('aria-busy');
        msg.textContent = 'Could not save.';
      });
    });
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

  /* The card never hides itself. An empty card cannot be told from one that
     failed to load, so the all-clear line stands in its place instead. */
  function draw(v){
    v.list.textContent = '';
    data.problems.forEach(function(p){ v.list.appendChild(problem(p)); });
    data.credits.forEach(function(c){ v.list.appendChild(credit(c)); });
    data.uncats.forEach(function(r){ v.list.appendChild(uncat(r)); });
    data.actions.forEach(function(x){ v.list.appendChild(item(x)); });
    var open = openCount(), any = v.list.children.length;
    v.count.textContent = String(open);
    v.count.hidden = open === 0;   /* the all-clear line says it, so no pill reads "clear" */
    v.list.hidden = any === 0;
    v.clear.hidden = any !== 0;
  }
  function drawAll(){
    I.each(draw);
    TEBADGE.set('act', openCount());
  }

  function setItems(actions, problems){
    data.actions = (actions || []).slice();
    data.problems = (problems || []).slice();
    /* called after TECRED.set, so the credits are already worked out */
    data.credits = TECRED.due();
    data.uncats = TE.rows().filter(function(r){
      return r.cat === 'uncategorized' && r.amt < 0;
    });
    drawAll();
  }

  var SAMPLE = {problems: [], uncats: [],
    credits: [{name: 'Dining', card: 'Gold', left: 10, days: 3, ends: 'soon'}],
    actions: [{id: 0, kind: 'bill', text: 'Pay the water bill', detail: '$42'},
              {id: 0, kind: 'mail', text: 'Reply to Sam about Saturday'}]};

  TEW.define('alerts.action', {type: 'Requires Action', version: 'List', title: 'Requires Action',
    mount: function(root, c){
      var v = {list: c.r('list'), count: c.r('count'), clear: c.r('clear')};
      if(c.sample){
        TEW.swap(function(){ return data; }, function(o){ data = o; }, SAMPLE, function(){ draw(v); });
        return;
      }
      draw(v);
      return I.add(v);
    }});
  return { setItems: setItems };
})();

/* One to-do row, shared by To Do and Backlog. A tap crosses it off on screen
   at once and writes after; a failed write puts it back. The state is kept
   on the row, and after() redraws every copy of the card. */
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

  b.className = 'todo-item' + (t.done ? ' done' : '');
  b.setAttribute('aria-pressed', String(!!t.done));
  b.addEventListener('click', function(){
    var done = !t.done;
    t.done = done;
    after();
    window.TERPC('page_todo_set', { p_id: Number(t.id), p_done: done, p_file_to: null }, function(err){
      if(err){ t.done = !done; after(); }
    });
  });
  li.appendChild(b);
  return li;
}

/* ---- to do ----
   secretary_todos (list = 'todo'), through page_todo_add and page_todo_set. */
var TETODO = (function(){
  var I = TEW.list();
  var rows = [], parked = [];

  /* The header count is To Do only, and stays off the icon badge; the Backlog
     tab carries its own number and counts toward nothing. Which tab shows is
     each card's own. */
  function draw(v){
    v.list.textContent = '';
    v.back.textContent = '';
    rows.forEach(function(t){ v.list.appendChild(todoRow(t, drawAll)); });
    parked.forEach(function(t){ v.back.appendChild(todoRow(t, drawAll)); });
    var open = rows.filter(function(t){ return !t.done; }).length;
    var later = parked.filter(function(t){ return !t.done; }).length;
    v.count.textContent = String(open);
    v.count.className = open ? 'count act' : 'count';
    v.tabTodo.textContent = 'To Do' + (open ? ' ' + open : '');
    v.tabBack.textContent = 'Backlog' + (later ? ' ' + later : '');
    v.tabs.hidden = parked.length === 0;
    if(v.tabs.hidden){ v.onBack = false; }
    v.pane.hidden = v.onBack;
    v.back.hidden = !v.onBack;
    v.tabTodo.setAttribute('aria-pressed', String(!v.onBack));
    v.tabBack.setAttribute('aria-pressed', String(v.onBack));
  }
  function drawAll(){ I.each(draw); }

  function set(r, p){
    rows = (r || []).slice();
    parked = (p || []).slice();
    drawAll();
  }

  TEW.define('alerts.todo', {type: 'To Do', version: 'List', title: 'To Do',
    mount: function(root, c){
      var v = {list: c.r('list'), back: c.r('back'), pane: c.r('pane'), tabs: c.r('tabs'),
        tabTodo: c.r('tabTodo'), tabBack: c.r('tabBack'), count: c.r('count'),
        form: c.r('form'), input: c.r('input'), onBack: false};
      if(c.sample){
        TEW.swap(function(){ return [rows, parked]; }, function(o){ rows = o[0]; parked = o[1]; },
          [[{id: 0, text: 'Book the movers'}, {id: 0, text: 'Renew passport', done: true}], []],
          function(){ draw(v); });
        return;
      }
      var addBtn = v.form.querySelector('button');
      v.tabTodo.addEventListener('click', function(){ v.onBack = false; draw(v); });
      v.tabBack.addEventListener('click', function(){ v.onBack = true; draw(v); });
      /* The text stays in the field until the write succeeds, so a failed add
         can simply be tried again. */
      v.form.addEventListener('submit', function(ev){
        ev.preventDefault();
        var text = v.input.value.replace(/^\s+|\s+$/g, '');
        if(!text || addBtn.disabled){ return; }
        addBtn.disabled = true;
        window.TERPC('page_todo_add', { p_text: text }, function(err, id){
          addBtn.disabled = false;
          if(err){ return; }
          v.input.value = '';
          rows.push({ id: id, text: text, done: false });
          drawAll();
        });
      });
      draw(v);
      return I.add(v);
    }});
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
  var I = TEW.list();
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

  function draw(v){
    v.list.textContent = '';
    var shown = rows.filter(function(r){ return NEXT[r.status]; });
    shown.forEach(function(r){ v.list.appendChild(row(r)); });
    var open = shown.filter(function(r){ return r.status !== 'ongoing'; }).length;
    v.count.textContent = String(open);
    v.count.className = open ? 'count act' : 'count';
    v.empty.hidden = shown.length !== 0;
  }
  function render(){ I.each(draw); }

  TEW.define('alerts.settlements', {type: 'Settlements', version: 'List', title: 'Settlements',
    mount: function(root, c){
      var v = {list: c.r('list'), count: c.r('count'), empty: c.r('empty')};
      if(c.sample){
        TEW.swap(function(){ return [rows, known]; }, function(o){ rows = o[0]; known = o[1]; },
          [[{id: 0, title: 'Example Co data breach', status: 'new', payout: '$50', proof: false,
             deadline: TEW.ago(-20), evidence: 'You had an account with them.'}], ['new', 'ongoing', 'skipped']],
          function(){ draw(v); });
        return;
      }
      draw(v);
      return I.add(v);
    }});
  return {
    set: function(r, s){ rows = (r || []).slice(); known = (s || []).slice(); render(); }
  };
})();

/* ---- highlights from the mail sorter ----
   One row per sender: the newest note, how many there were, when. Tap the
   note to open the thread in Gmail; the cross dismisses every note from that
   sender. Read from page_highlights, not page_data. */
var TEHIGH = (function(){
  var I = TEW.list(), rows = [];
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls){ e.className = cls; }
    if(text !== undefined && text !== null){ e.textContent = text; }
    return e;
  }
  function when(iso){
    var d = new Date(iso), t = new Date();
    if(d.toDateString() === t.toDateString()){
      return d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    }
    return MON[d.getMonth()] + ' ' + d.getDate();
  }
  function row(r){
    var li = el('li', 'hl');
    var a = el('a', 'hl-note', r.note);
    a.href = 'https://mail.google.com/mail/#all/' + encodeURIComponent(r.thread);
    a.target = '_blank';
    a.rel = 'noopener';
    li.appendChild(a);
    li.appendChild(el('span', 'hl-when', (r.n > 1 ? r.n + ' notes · ' : '') + when(r.at)));
    var x = el('button', 'hl-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', function(){
      var was = rows.slice();
      rows = rows.filter(function(o){ return o.sender !== r.sender; });
      render();
      window.TERPC('page_highlight_dismiss', {p_sender: r.sender}, function(err){
        if(err){ rows = was; render(); }
      });
    });
    li.appendChild(x);
    return li;
  }
  function draw(v){
    v.list.textContent = '';
    rows.forEach(function(r){ v.list.appendChild(row(r)); });
    v.count.textContent = String(rows.length);
    v.empty.hidden = rows.length !== 0;
  }
  function render(){ I.each(draw); }
  TEW.define('alerts.highlights', {type: 'Highlights', version: 'List', title: 'Highlights',
    mount: function(root, c){
      var v = {list: c.r('list'), count: c.r('count'), empty: c.r('empty')};
      if(c.sample){
        TEW.swap(function(){ return rows; }, function(o){ rows = o; },
          [{sender: 'x@example.com', note: 'Zillow: the agent replied about 200 Oak, free Sunday evening',
            thread: '', n: 2, at: new Date().toISOString()}], function(){ draw(v); });
        return;
      }
      draw(v);
      return I.add(v);
    }});
  return {
    load: function(){
      window.TERPC('page_highlights', {}, function(err, r){
        rows = err ? [] : (r || []).slice();
        render();
      });
    }
  };
})();

/* ---- job tracking, all-time ----
   Counted from secretary_job_events, which the 3am sweep fills from job mail.
   All-time on purpose: the tally runs until the search ends. */
var TEJOBS = (function(){
  var I = TEW.list(), n = null;
  function draw(v){
    if(!n){ return; }
    v.apps.textContent = n.application || 0;
    v.rej.textContent = n.rejection || 0;
    v.int.textContent = n.interview || 0;
  }
  TEW.define('alerts.jobs', {type: 'Job Tracking', version: 'Counts', title: 'Job Tracking',
    mount: function(root, c){
      var v = {apps: c.r('apps'), rej: c.r('rej'), int: c.r('int')};
      if(c.sample){
        TEW.swap(function(){ return n; }, function(o){ n = o; },
          {application: 12, rejection: 5, interview: 2}, function(){ draw(v); });
        return;
      }
      draw(v);
      return I.add(v);
    }});
  return {
    set: function(j){
      n = (j && j.counts) || {};
      I.each(draw);
    }
  };
})();
