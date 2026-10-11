'use strict';

// Sample sessions. Every score was computed with _fallback_risk_assessment()
// in backend/services/risk_classifier.py: 0.1 base, +0.3 per high-risk phrase,
// +0.1 per concerning phrase; >= 0.7 high, >= 0.4 medium. Alerts follow
// routes/ws_stream.py: score >= 0.5 sends crisis_detected and locks the session;
// medium below that sends risk_warning.
const THRESHOLD = 0.5;

const SCENARIOS = {
  routine: {
    lines: [
      { who: 'Therapist', text: 'How has the week been since we last met?', score: 0.1 },
      { who: 'Client', text: 'Busy. Work deadlines piled up and I felt overwhelmed by Wednesday.', score: 0.2, hits: ['overwhelmed'] },
      { who: 'Therapist', text: 'What helped you get through it?', score: 0.1 },
      { who: 'Client', text: 'I used the breathing exercise, and I slept better over the weekend.', score: 0.1 }
    ],
    title: 'Low risk throughout',
    body: 'One concerning word lifted a segment to 0.20. Nothing crossed a band, so the therapist received transcripts and assessments only, with no alerts.'
  },
  distress: {
    lines: [
      { who: 'Therapist', text: 'You mentioned things have felt heavier lately.', score: 0.1 },
      { who: 'Client', text: "It's been a lot. I keep telling myself I can manage.", score: 0.1 },
      { who: 'Therapist', text: 'That sounds exhausting. What does a hard day look like?', score: 0.1 },
      { who: 'Client', text: 'I feel hopeless, trapped in this job, and like a burden at home.', score: 0.4, hits: ['hopeless', 'trapped', 'burden'] }
    ],
    title: 'Medium risk warning',
    body: 'Three concerning phrases in one segment reached 0.40, the medium band. That is below the 0.5 alert threshold, so the service sent a risk_warning and kept listening.'
  },
  crisis: {
    lines: [
      { who: 'Therapist', text: 'You said the nights have been the hardest.', score: 0.1 },
      { who: 'Client', text: "Some nights I don't want to live. I've thought about suicide.", score: 0.7, hits: ["don't want to live", 'suicide'] },
      { who: 'Therapist', text: 'Thank you for telling me. Are you safe right now?', score: null }
    ],
    title: 'Crisis detected, session locked',
    body: "Two high-risk phrases scored 0.70. The service sent crisis_detected, locked the session and closed the stream, so the therapist's next question was never transcribed. That is the behavior the engineering notes question."
  },
  missed: {
    lines: [
      { who: 'Therapist', text: 'How have you been feeling about the future?', score: 0.1 },
      { who: 'Client', text: "Honestly, everyone would be better off if I just wasn't around.", score: 0.1, missed: true },
      { who: 'Therapist', text: 'That sounds really painful. Can you tell me more?', score: 0.1 },
      { who: 'Client', text: "I've thought about suicide.", score: 0.4, hits: ['suicide'] }
    ],
    title: 'The gap keyword matching leaves',
    body: 'The paraphrase in segment two matched no keyword and scored 0.10. The explicit mention reached only 0.40 because each segment is scored alone. Understanding meaning is why Gemini is the primary path.'
  }
};

const $ = id => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const levelOf = s => (s >= 0.7 ? 'high' : s >= 0.4 ? 'medium' : 'low');
const label = { low: 'Low', medium: 'Medium', high: 'High' };
let run = 0;
let clock = 0;

const wait = ms => new Promise(r => setTimeout(r, reduceMotion ? 0 : ms));

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, hits = []) {
  let html = escapeHtml(text);
  hits.forEach(h => {
    const safe = escapeHtml(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(safe, 'i'), m => `<mark>${m}</mark>`);
  });
  return html;
}

function stamp() {
  clock += 1.1 + Math.random() * 0.8;
  const s = clock.toFixed(1).padStart(4, '0');
  return `+00:${s}`;
}

function logEvent(type, data, tone = '') {
  const li = document.createElement('li');
  li.className = tone;
  li.innerHTML = `<time>${stamp()}</time><b>${type}</b><code>${escapeHtml(JSON.stringify(data))}</code>`;
  const log = $('log');
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function setGauge(score) {
  const fill = $('g-fill');
  const lvl = levelOf(score);
  fill.style.strokeDasharray = `${score * 100} 100`;
  fill.dataset.level = lvl;
  $('score').textContent = score.toFixed(2);
  $('level').textContent = label[lvl];
  $('level').dataset.level = lvl;
}

function addBar(score) {
  const bar = document.createElement('span');
  bar.className = 'bar';
  bar.dataset.level = levelOf(score);
  bar.style.height = '0%';
  $('timeline').appendChild(bar);
  requestAnimationFrame(() => { bar.style.height = `${Math.max(score, 0.04) * 100}%`; });
}

function reset() {
  $('transcript').innerHTML = '';
  $('log').innerHTML = '';
  $('timeline').querySelectorAll('.bar').forEach(b => b.remove());
  $('outcome').classList.remove('show', 'low', 'medium', 'high');
  $('live-dot').className = 'dot on';
  $('live-label').textContent = 'LIVE TRANSCRIPT';
  $('mini-wave').classList.add('on');
  $('peak').textContent = '0.00';
  setGauge(0);
  $('level').textContent = 'Listening';
  $('level').dataset.level = '';
  clock = 0;
}

async function play(key) {
  const id = ++run;
  const scenario = SCENARIOS[key];
  const alive = () => id === run;
  reset();
  document.querySelectorAll('[data-scenario]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scenario === key)));
  logEvent('session_started', { stt: 'deepgram', realtime: true, risk_threshold: THRESHOLD });
  let peak = 0;

  for (const line of scenario.lines) {
    if (!alive()) return;
    const li = document.createElement('li');
    li.className = `seg ${line.who === 'Client' ? 'client' : 'therapist'}`;
    li.innerHTML = `<span class="who">${line.who}</span><p class="text interim"></p><span class="badge pending">assessing…</span>`;

    // Locked sessions stop transcribing: show the speech that never arrives.
    if (line.score === null) {
      li.classList.add('lost');
      li.querySelector('.text').textContent = 'Stream closed. This turn was not transcribed.';
      li.querySelector('.badge').remove();
      $('transcript').appendChild(li);
      break;
    }

    $('transcript').appendChild(li);
    const textEl = li.querySelector('.text');
    const words = line.text.split(' ');

    // Interim results stream word by word, then the segment is finalized.
    for (let i = 1; i <= words.length; i++) {
      if (!alive()) return;
      textEl.textContent = words.slice(0, i).join(' ');
      await wait(55 + Math.random() * 45);
    }
    textEl.classList.remove('interim');
    textEl.innerHTML = highlight(line.text, line.hits);
    logEvent('transcription', { is_final: true, word_count: words.length, speaker: line.who === 'Client' ? 1 : 0 });

    await wait(520);
    if (!alive()) return;
    const lvl = levelOf(line.score);
    const badge = li.querySelector('.badge');
    badge.className = `badge ${lvl}${line.missed ? ' missed' : ''}`;
    badge.textContent = line.missed ? `${line.score.toFixed(2)} · missed` : line.score.toFixed(2);
    setGauge(line.score);
    addBar(line.score);
    peak = Math.max(peak, line.score);
    $('peak').textContent = peak.toFixed(2);
    logEvent('risk_assessment', { risk_score: line.score, risk_level: lvl }, lvl);

    if (line.score >= THRESHOLD) {
      await wait(300);
      logEvent('crisis_detected', { immediate_action_required: true, session_locked: true }, 'high');
      li.classList.add('flagged');
      await wait(400);
      logEvent('session_locked', { reason: 'Crisis intervention required' }, 'high');
      $('live-dot').className = 'dot locked';
      $('live-label').textContent = 'SESSION LOCKED';
      $('mini-wave').classList.remove('on');
      await wait(700);
    } else if (lvl === 'medium') {
      await wait(300);
      logEvent('risk_warning', { risk_score: line.score, risk_level: lvl }, 'medium');
      li.classList.add('warned');
    }
    await wait(650);
  }

  if (!alive()) return;
  if ($('live-label').textContent !== 'SESSION LOCKED') {
    $('live-dot').className = 'dot';
    $('live-label').textContent = 'REPLAY COMPLETE';
    $('mini-wave').classList.remove('on');
  }
  const out = $('outcome');
  out.classList.add('show', levelOf(peak));
  $('outcome-label').textContent = `OUTCOME · PEAK ${peak.toFixed(2)}`;
  $('outcome-title').textContent = scenario.title;
  $('outcome-body').textContent = scenario.body;
}

// Decorative waveforms: one in the hero, a smaller one in the console.
function buildWave(el, count) {
  for (let i = 0; i < count; i++) {
    const b = document.createElement('i');
    const h = 18 + Math.abs(Math.sin(i * 0.37) * 62) + Math.random() * 20;
    b.style.setProperty('--h', `${h}%`);
    b.style.animationDelay = `${(i % 17) * -0.11}s`;
    el.appendChild(b);
  }
}
buildWave(document.querySelector('.wave'), 140);
buildWave($('mini-wave'), 96);

document.querySelectorAll('[data-scenario]').forEach(b => b.addEventListener('click', () => play(b.dataset.scenario)));
$('replay').addEventListener('click', () => {
  const current = document.querySelector('[data-scenario][aria-pressed="true"]');
  play(current ? current.dataset.scenario : 'routine');
});

// Start the first replay when the demo scrolls into view.
const demo = $('demo');
let started = false;
const startOnce = () => { if (!started) { started = true; play('routine'); } };
if ('IntersectionObserver' in window) {
  new IntersectionObserver((entries, obs) => {
    if (entries.some(e => e.isIntersecting)) { startOnce(); obs.disconnect(); }
  }, { threshold: 0.25 }).observe(demo);
} else {
  startOnce();
}
