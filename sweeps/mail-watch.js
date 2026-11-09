/* Mail Watch: a Google Apps Script that lives in the hub Gmail and runs every
   5 minutes. Paste this whole file into a script.google.com project, set the
   two Script Properties, and run setup() once (steps in the README).

   Each run:
     1. asks the mail-watch edge function for Gmail work the database has
        queued (the 10am sweep's filing, items crossed off on the page) and
        does it: labels, archive, trash;
     2. trashes mail from blocked senders;
     3. reads mail that arrived since the last run and reports what looks
        urgent, which the edge function raises on Requires Action and pushes
        to the phone;
     4. sends every new message to be sorted (rules, then Claude Haiku for
        unknown senders). In shadow mode that is only recorded; in live mode
        (engine_mail_watch.mode) the script files each one where it was sorted.

   It judges nothing beyond the rules in classify(). Everything else waits for
   the 10am Claude sweep. It never sends, replies or deletes for good. */

var MAX_THREADS = 100;

/* ---- the rules ----
   A message is urgent when it came through a platform's person-to-person
   relay (an agent writing on Zillow), when a watched sender (rentals, job
   portals) asks for something, when a payment went wrong, or when Gmail
   itself files it as personal and important. A person's reply in a thread he
   wrote in (his own sent mail earlier in it) is always urgent: it may undo
   what he sent, like a vendor flagging a problem with his plan. Bulk mail (an
   unsubscribe header) only counts through a relay or a watched sender. */
var ACTION = new RegExp('\\b(' + [
  'sign(?![- ]?(in|up|out|on)\\b)(ed|ature)?', 'e-?sign', 'docusign',
  'action (required|needed)', 'respond', 'rsvp', 'deadline',
  'due (today|tomorrow|by)', 'today', 'tonight', 'tomorrow', 'asap', 'urgent',
  'showing', 'tour', 'appointment', 'reschedul\\w*', 'cancel(l?ed|lation)?',
  'interview', 'lease', 'application', 'new (electronic )?message',
  'sent you a message', 'received a new', 'waiting for you',
  'please (confirm|reply|complete|review|sign)'
].join('|') + ')\\b', 'i');
var MONEY = new RegExp('\\b(' + [
  'payment (was |has been )?(declined|failed|returned|unsuccessful)', 'declined',
  'past due', 'overdue', 'late fee', 'insufficient funds', 'returned payment',
  'autopay (is |has been )?(off|disabled|turned off|not set up)',
  'account (is |has been )?(locked|suspended|frozen|restricted|closed)'
].join('|') + ')\\b', 'i');
var NOREPLY = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?)([._-]|$)/i;
var RELAY = /(^|\.)(convo|relay)\./i;
/* Marketing wording near the top of a body, and institutions whose mail is
   marketing or statements unless it is a payment problem (the MONEY rule
   runs first, so a declined payment from them still counts). */
var BULK_TEXT = /(view (the |this |it )?(online version|in (a |your )?browser|web version)|online version of this email|unsubscribe|manage (your )?(email )?(preferences|subscriptions?))/i;
var BULK_DOMAINS = /(^|\.)(bankofamerica|ealerts\.bankofamerica|fidelity|chase|citi|citibank|wellsfargo|capitalone|discover|americanexpress|schwab|vanguard|experian|transunion|equifax|creditkarma|facebookmail|mail\.instagram|rentcast)\.(com|io)$/i;

function address(from){
  var s = String(from || '');
  var m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if(m){ return { email: m[2].trim().toLowerCase(), name: m[1].trim() }; }
  return { email: s.trim().toLowerCase(), name: '' };
}

function isBlocked(msg, cfg){
  return (cfg.blocked || []).indexOf(address(msg.from).email) >= 0;
}

/* Returns why the message is urgent, or null. */
function classify(msg, cfg){
  var a = address(msg.from);
  if((cfg.self || []).indexOf(a.email) >= 0 || isBlocked(msg, cfg)){ return null; }
  var at = a.email.lastIndexOf('@');
  var local = a.email.slice(0, at), domain = a.email.slice(at + 1);
  var bulk = !!msg.listUnsub || /bulk|list|junk/i.test(msg.precedence || '')
    || BULK_TEXT.test(msg.text || '') || BULK_DOMAINS.test(domain);
  var watched = (cfg.alert_domains || []).some(function(d){
    return domain === d || domain.slice(-(d.length + 1)) === '.' + d;
  });
  var text = (msg.subject || '') + ' ' + (msg.text || '');

  if(RELAY.test(domain)){ return 'Message through ' + domain.replace(RELAY, ''); }
  if(watched && ACTION.test(text)){ return 'Asks for something'; }
  if(MONEY.test(text) && (msg.important || !bulk)){ return 'Payment or account problem'; }
  if(bulk || NOREPLY.test(local)){ return null; }
  if(msg.repliedToMine){ return 'Reply to your email'; }
  if(msg.primary && msg.important){ return 'Personal mail'; }
  if(msg.primary && ACTION.test(text)){ return 'Asks for something (unconfirmed)'; }
  return null;
}

/* ---- Apps Script from here on ---- */

function setup(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction() === 'watch'){ ScriptApp.deleteTrigger(t); }
  });
  ScriptApp.newTrigger('watch').timeBased().everyMinutes(5).create();
  watch();
  Logger.log('Mail Watch installed');
}

function call_(payload){
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('WATCH_URL'), key = p.getProperty('WATCH_KEY');
  if(!url || !key){ throw new Error('Set WATCH_URL and WATCH_KEY in Script Properties'); }
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-watch-key': key }, payload: JSON.stringify(payload)
  });
  if(res.getResponseCode() !== 200){
    throw new Error('mail-watch answered ' + res.getResponseCode() + ': '
      + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

function label_(name){
  var l = GmailApp.getUserLabelByName(name);
  if(!l){ throw new Error('no Gmail label named ' + name); }
  return l;
}

/* Queued work: add labels, then remove, then trash. INBOX is not a label
   here: adding it moves the thread to the inbox, removing it archives. A
   thread that no longer exists counts as done. */
function apply_(actions){
  return (actions || []).map(function(a){
    try {
      var t = GmailApp.getThreadById(a.thread);
      if(!t){ return { id: a.id, ok: true, note: 'thread gone' }; }
      (a.add || []).forEach(function(n){
        if(n === 'INBOX'){ t.moveToInbox(); } else { t.addLabel(label_(n)); }
      });
      (a.remove || []).forEach(function(n){
        if(n === 'INBOX'){ t.moveToArchive(); }
        else { var l = GmailApp.getUserLabelByName(n); if(l){ t.removeLabel(l); } }
      });
      if(a.trash){ t.moveToTrash(); }
      return { id: a.id, ok: true };
    } catch(e){
      return { id: a.id, ok: false, error: String(e && e.message || e).slice(0, 300) };
    }
  });
}

function ids_(threads){
  var o = {};
  threads.forEach(function(t){ o[t.getId()] = true; });
  return o;
}

/* Everything in the inbox since an hour before the last run. The overlap
   costs nothing: the database keys each item on the message id, so a message
   seen twice is raised and pushed once. */
function scan_(cfg){
  var now = Math.floor(Date.now() / 1000);
  var since = cfg.after ? cfg.after - 3600 : now - 7200;
  var q = 'in:inbox after:' + since;
  var threads = GmailApp.search(q, 0, MAX_THREADS);
  var primary = ids_(GmailApp.search(q + ' category:primary', 0, MAX_THREADS));
  var important = ids_(GmailApp.search(q + ' is:important', 0, MAX_THREADS));
  var items = [], messages = [], blocked = 0, scanned = 0;

  threads.forEach(function(t){
    var id = t.getId();
    var msgs = t.getMessages();
    var wrote = false;
    for(var i = 0; i < msgs.length; i++){
      var g = msgs[i];
      var mine = (cfg.self || []).indexOf(address(g.getFrom()).email) >= 0;
      if(g.getDate().getTime() / 1000 < since){ wrote = wrote || mine; continue; }
      if(mine){ wrote = true; }
      scanned++;
      var full = '';
      try { full = g.getPlainBody().replace(/\s+/g, ' ').slice(0, 1000); } catch(e){}
      var body = full.slice(0, 500);
      var msg = {
        from: g.getFrom(), subject: g.getSubject(), text: body,
        listUnsub: !!g.getHeader('List-Unsubscribe'),
        precedence: g.getHeader('Precedence'),
        primary: !!primary[id], important: !!important[id],
        repliedToMine: wrote && !mine
      };
      if(isBlocked(msg, cfg)){ t.moveToTrash(); blocked++; return; }
      var who = address(msg.from);
      if((cfg.self || []).indexOf(who.email) < 0){
        messages.push({ msg_id: g.getId(), thread_id: id, from: who.email, name: who.name,
                        subject: String(msg.subject || '').slice(0, 300), snippet: full,
                        list_unsub: msg.listUnsub, primary: msg.primary, important: msg.important });
      }
      var why = classify(msg, cfg);
      if(why){
        var a = address(msg.from);
        items.push({ msg_id: g.getId(), thread_id: id, from: a.email, name: a.name,
                     subject: String(msg.subject || '').slice(0, 200),
                     snippet: body.slice(0, 200), reason: why,
                     quiet: /unconfirmed/.test(why) });
      }
    }
  });
  return { after: now, scanned: scanned, items: items, messages: messages, blocked: blocked };
}

/* Live mode only: file each message where the sorter decided. Trash goes to
   Trash; every other label is added and the thread leaves the inbox. */
function file_(decided){
  return (decided || []).map(function(d){
    var trash = d.label === 'Trash';
    return { id: null, thread: d.thread_id, add: trash ? [] : [d.label], remove: trash ? [] : ['INBOX'], trash: trash };
  });
}

/* Once a day, the first run after 7am Pacific: Reading is kept 14 days. */
function cleanup_(){
  var p = PropertiesService.getScriptProperties();
  var now = new Date();
  var day = Utilities.formatDate(now, 'America/Los_Angeles', 'yyyy-MM-dd');
  var hour = Number(Utilities.formatDate(now, 'America/Los_Angeles', 'H'));
  if(hour < 7 || p.getProperty('CLEANED') === day){ return; }
  var old = GmailApp.search('label:Reading older_than:14d', 0, 100);
  if(old.length){ GmailApp.moveThreadsToTrash(old); }
  p.setProperty('CLEANED', day);
}

/* Run once by hand when going live: Money/In and Money/Out become Money, and
   Save/Jobs becomes Jobs. Every thread keeps its mail and gains the new label;
   then the old labels go. Safe to run twice. */
function mergeLabels(){
  [['Money/In', 'Money'], ['Money/Out', 'Money'], ['Save/Jobs', 'Jobs']].forEach(function(pair){
    var old = GmailApp.getUserLabelByName(pair[0]);
    if(!old){ return; }
    var to = label_(pair[1]);
    for(var t = old.getThreads(0, 100); t.length; t = old.getThreads(0, 100)){
      to.addToThreads(t);
      old.removeFromThreads(t);
    }
    old.deleteLabel();
    Logger.log(pair[0] + ' merged into ' + pair[1]);
  });
}

function watch(){
  var lock = LockService.getScriptLock();
  if(!lock.tryLock(1000)){ return; }
  var applied = [];
  try {
    var cfg = call_({ op: 'pull' });
    cfg.self = (cfg.self || []).concat([Session.getEffectiveUser().getEmail().toLowerCase()]);
    applied = apply_(cfg.actions);
    var s = scan_(cfg);
    var res = call_({ op: 'push', after: s.after, scanned: s.scanned, blocked: s.blocked,
                      items: s.items, messages: s.messages, applied: applied });
    if(cfg.mode === 'live' && res.sort && res.sort.mode === 'live'){
      var bad = apply_(file_(res.sort.decided)).filter(function(r){ return !r.ok; });
      cleanup_();
      if(bad.length){ throw new Error('Filing failed for ' + bad.length + ': ' + bad[0].error); }
    }
  } catch(e){
    /* tell the database so the page raises it, then fail so Google emails too */
    try { call_({ op: 'push', applied: applied, error: String(e && e.message || e) }); } catch(e2){}
    throw e;
  } finally {
    lock.releaseLock();
  }
}

if(typeof module !== 'undefined'){
  module.exports = { classify: classify, isBlocked: isBlocked, address: address, file_: file_ };
}
