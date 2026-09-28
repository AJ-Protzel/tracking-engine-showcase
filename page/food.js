/* ==========================================================================
   FOOD — fourteen days of intake, and the doctor's recommendation.

   Read-only: the doctor skill writes both of these in a chat, and the page
   only draws what page_data() returned.
   ========================================================================== */
var TEFOOD = (function(){
  function $(id){ return document.getElementById(id); }

  /* ---------------- the doctor's recommendations ----------------
     Written into doctor_recommendations by the doctor skill when Alex asks
     it for one — a row each for Alex and Sam. page_data() returns the
     newest per person, however old, stamped with its date. */
  function drawRecs(recs){
    var host = $('recBody');
    host.textContent = '';
    if(!recs || !recs.length){
      var none = document.createElement('p');
      none.className = 'blank';
      none.textContent = 'Nothing yet. Ask the doctor skill in a chat for a '
        + 'recommendation and it writes it here.';
      host.appendChild(none);
      return;
    }
    recs.forEach(function(r){
      var box = document.createElement('div');
      box.className = 'rec';
      var head = document.createElement('div');
      head.className = 'rec-head';
      var who = document.createElement('span');
      who.className = 'who';
      who.style.margin = '0';
      who.textContent = r.person;
      var when = document.createElement('span');
      when.className = 'meal-num';
      when.textContent = r.dt || '';
      head.appendChild(who);
      head.appendChild(when);
      var body = document.createElement('p');
      body.className = 'rec-body';
      body.textContent = r.body;
      box.appendChild(head);
      box.appendChild(body);
      host.appendChild(box);
    });
  }

  /* ---------------- intake: 14 days of calories by macro ----------------
     One bar a day. Its height is the day's calories and the split is where
     they came from, at 4 calories a gram of protein and carbohydrate and 9 a
     gram of fat. Both people share one scale so the rows compare, and each
     gets a dashed line at their own average over the days they logged. */
  function drawIntake(people, rows){
    var host = $('intakeBody'), count = $('intakeCount');
    host.textContent = '';
    if(!people.length){
      count.textContent = '14 days';
      var none = document.createElement('p');
      none.className = 'blank';
      none.textContent = 'No entries yet. Log meals in a chat with the doctor skill.';
      host.appendChild(none);
      return;
    }

    /* the 14 days ending today, in Pacific, so an unlogged day is a gap */
    var today = new Date(new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }));
    var days = [];
    for(var i = 13; i >= 0; i--){
      var d = new Date(today.getTime() - i * 86400000);
      days.push({
        iso: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2),
        num: String(d.getDate()),
        label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      });
    }

    var totals = {}, top = 0;
    people.forEach(function(person){
      var mine = totals[person] = {};
      days.forEach(function(day){ mine[day.iso] = null; });
      rows.forEach(function(r){
        if(r.person !== person || !(r.d in mine)){ return; }
        var t = mine[r.d] || (mine[r.d] = { cal: 0, p: 0, c: 0, f: 0, sug: 0, items: 0, foods: [] });
        t.cal += Number(r.cal) || 0;
        t.p += Number(r.p) || 0;
        t.c += Number(r.c) || 0;
        t.f += Number(r.f) || 0;
        t.sug += Number(r.sug) || 0;
        t.items += 1;
        t.foods.push(r);
      });
      days.forEach(function(day){
        var t = mine[day.iso];
        if(t && t.cal > top){ top = t.cal; }
      });
    });
    if(top <= 0){ top = 1; }

    var detail = document.createElement('div');
    detail.className = 'intake-detail';
    var picked = null;

    function say(person, day, t){
      detail.textContent = '';
      if(!t){
        detail.textContent = day.label + ' — nothing logged for ' + person + '.';
        return;
      }
      /* the day opens onto the foods behind it; there is no second table */
      var head = document.createElement('p');
      head.className = 'who';
      head.textContent = person + ' · ' + day.label;
      var sum = document.createElement('p');
      sum.className = 'meal-num';
      sum.style.margin = '0 0 8px';
      sum.textContent = Math.round(t.cal) + ' cal · ' + Math.round(t.p) + 'g P · '
        + Math.round(t.c) + 'g C · ' + Math.round(t.f) + 'g F'
        + (t.sug ? ' · ' + Math.round(t.sug) + 'g sugar' : '');
      detail.appendChild(head);
      detail.appendChild(sum);
      t.foods.slice().sort(function(a, b){ return (b.cal || 0) - (a.cal || 0); })
        .forEach(function(m){
          var row = document.createElement('div');
          row.className = 'meal';
          var nm = document.createElement('span');
          nm.className = 'meal-name';
          nm.textContent = m.meal || '—';
          var fig = document.createElement('span');
          fig.className = 'meal-num';
          fig.textContent = (Math.round(m.cal) || 0) + ' cal · ' + (Math.round(m.p) || 0) + 'g P';
          row.appendChild(nm);
          row.appendChild(fig);
          detail.appendChild(row);
        });
      if(t.items <= 3){
        var note = document.createElement('p');
        note.className = 'caveat';
        note.textContent = 'Only ' + t.items + (t.items === 1 ? ' food is' : ' foods are')
          + ' logged here, so part of the day is probably missing.';
        detail.appendChild(note);
      }
    }

    people.forEach(function(person){
      var mine = totals[person];
      var logged = days.map(function(day){ return mine[day.iso]; })
                       .filter(function(t){ return t && t.items > 3; });
      var avg = logged.length
        ? logged.reduce(function(a, t){ return a + t.cal; }, 0) / logged.length : 0;

      var head = document.createElement('div');
      head.className = 'intake-who';
      var who = document.createElement('p');
      who.className = 'who';
      who.style.margin = '0';
      who.textContent = person;
      var avgLab = document.createElement('span');
      avgLab.className = 'chart-avg-lab';
      avgLab.textContent = avg ? Math.round(avg) + ' cal/day' : 'nothing logged';
      head.appendChild(who);
      head.appendChild(avgLab);
      host.appendChild(head);

      var chart = document.createElement('div');
      chart.className = 'chart';
      var bars = document.createElement('div');
      bars.className = 'chart-bars';

      days.forEach(function(day){
        var t = mine[day.iso];
        var col = document.createElement('button');
        col.type = 'button';
        col.className = 'chart-col' + (t && t.items <= 3 ? ' thin' : '');
        col.setAttribute('aria-label', person + ', ' + day.label
          + (t ? ', ' + Math.round(t.cal) + ' calories' : ', nothing logged'));
        var stack = document.createElement('div');
        stack.className = 'chart-stack';
        stack.style.height = (t ? Math.max(2, (t.cal / top) * 100) : 0) + '%';
        if(t){
          var fromP = t.p * 4, fromC = t.c * 4, fromF = t.f * 9;
          var sum = fromP + fromC + fromF;
          [['seg-f', fromF], ['seg-c', fromC], ['seg-p', fromP]].forEach(function(part){
            var seg = document.createElement('div');
            seg.className = 'chart-seg ' + part[0];
            seg.style.height = (sum > 0 ? (part[1] / sum) * 100 : 0) + '%';
            stack.appendChild(seg);
          });
        }
        col.appendChild(stack);
        col.addEventListener('click', function(){
          if(picked){ picked.className = picked.className.replace(' on', ''); }
          col.className += ' on';
          picked = col;
          say(person, day, t);
        });
        bars.appendChild(col);
      });

      var line = document.createElement('div');
      line.className = 'chart-avg';
      line.style.bottom = ((avg / top) * 100) + '%';
      chart.appendChild(bars);
      if(avg){ chart.appendChild(line); }
      host.appendChild(chart);

      var axis = document.createElement('div');
      axis.className = 'chart-days';
      days.forEach(function(day, i){
        var lab = document.createElement('span');
        lab.textContent = i % 2 === 1 ? day.num : '';
        axis.appendChild(lab);
      });
      host.appendChild(axis);
    });

    var key = document.createElement('p');
    key.className = 'chart-key';
    [['seg-p', 'protein'], ['seg-c', 'carbs'], ['seg-f', 'fat'],
     ['', 'dashes: their average']].forEach(function(part){
      var span = document.createElement('span');
      if(part[0]){
        var sw = document.createElement('i');
        sw.className = 'chart-seg ' + part[0];
        span.appendChild(sw);
      }
      span.appendChild(document.createTextNode(part[1]));
      key.appendChild(span);
    });
    host.appendChild(key);

    detail.textContent = 'Tap a day to see what was eaten.';
    host.appendChild(detail);

    var span14 = days[0].label.replace(/^\w+, /, '');
    count.textContent = span14 + ' \u2013 ' + days[13].label.replace(/^\w+, /, '');
  }

  return {
    set: function(people, rows, recs){
      drawIntake(people || [], rows || []);
      drawRecs(recs);
    }
  };
})();
