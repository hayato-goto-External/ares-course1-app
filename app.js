/* ============================================================
   ARES Course1 Study App - Application logic
   ============================================================ */

const DATA = window.EXAM_DATA;
const STORAGE_KEY = 'ares_course1_state';
const DAY_MS = 24 * 60 * 60 * 1000;

// SRS interval schedule (days), rated by user
const SRS_INTERVALS = {
  again: 1,      // Failed - back to 1 day
  hard: 3,       // Difficult - 3 days
  good: 7,       // Normal - 7 days
  easy: 14,      // Easy - 14 days
};
// Growth multipliers after first review
const SRS_MULTIPLIERS = { again: 0, hard: 1.5, good: 2.0, easy: 2.5 };

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
const defaultState = {
  progress: {},     // { qid: { attempts, correct, lastRating, nextDue, ease, reps, note, bookmarked, wrongCount, lastAttempt } }
  filters: {
    years: [2024, 2025],
    sessions: ['午前', '午後'],
    subjects: [],
    formats: [],
    topic: '',
    order: 'order',
  },
  settings: {
    theme: 'auto',
    fontsize: 'md',
  },
  activityLog: {},   // { 'YYYY-MM-DD': { attempts, correct } }
  examResults: [],   // history of past exam runs
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      filters: { ...defaultState.filters, ...(parsed.filters || {}) },
      settings: { ...defaultState.settings, ...(parsed.settings || {}) },
    };
  } catch (e) {
    console.error('Failed to load state:', e);
    return structuredClone(defaultState);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

function getProgress(qid) {
  if (!state.progress[qid]) {
    state.progress[qid] = {
      attempts: 0,
      correct: 0,
      wrongCount: 0,
      lastRating: null,
      nextDue: null,
      ease: 2.5,
      reps: 0,
      note: '',
      bookmarked: false,
      lastAttempt: null,
    };
  }
  return state.progress[qid];
}

// ------------------------------------------------------------
// Utility
// ------------------------------------------------------------
function $(id) { return document.getElementById(id); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / DAY_MS);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toast(msg, dur = 1600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, dur);
}

function isCorrect(question, userAnswer) {
  const ans = question.ans;
  if (Array.isArray(ans)) return ans.includes(userAnswer);
  if (ans === 0) return true; // invalidated
  return ans === userAnswer;
}

function formatAnswer(question) {
  const ans = question.ans;
  if (Array.isArray(ans)) return ans.join(' または ');
  if (ans === 0) return '全て正答';
  return String(ans);
}

// ------------------------------------------------------------
// View routing
// ------------------------------------------------------------
function showView(id) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------
// SRS helpers
// ------------------------------------------------------------
function computeNextDue(p, rating) {
  const now = Date.now();
  if (rating === 'again') {
    return { nextDue: now + DAY_MS, reps: 0, ease: Math.max(1.3, p.ease - 0.2) };
  }
  let interval;
  if (p.reps === 0) {
    interval = SRS_INTERVALS[rating] * DAY_MS;
  } else {
    interval = p.ease * SRS_MULTIPLIERS[rating] * DAY_MS;
  }
  let newEase = p.ease;
  if (rating === 'hard') newEase = Math.max(1.3, p.ease - 0.15);
  if (rating === 'easy') newEase = p.ease + 0.15;
  return {
    nextDue: now + interval,
    reps: p.reps + 1,
    ease: newEase,
  };
}

function previewInterval(p, rating) {
  if (rating === 'again') return '1日';
  if (p.reps === 0) return `${SRS_INTERVALS[rating]}日`;
  const days = Math.round(p.ease * SRS_MULTIPLIERS[rating]);
  return days >= 30 ? `${Math.round(days/30)}ヶ月` : `${days}日`;
}

// ------------------------------------------------------------
// Question filtering
// ------------------------------------------------------------
function filterQuestions(overrides = {}) {
  const f = { ...state.filters, ...overrides };
  return DATA.filter(q => {
    if (f.years.length && !f.years.includes(q.year)) return false;
    if (f.sessions.length && !f.sessions.includes(q.session)) return false;
    if (f.subjects.length) {
      const key = `${q.year >= 2024 ? 'new' : 'old'}-${q.sub}`;
      if (!f.subjects.includes(key)) return false;
    }
    if (f.formats.length && !f.formats.includes(q.fmt)) return false;
    if (f.topic && f.topic.trim()) {
      const kw = f.topic.trim().toLowerCase();
      if (!(q.topic || '').toLowerCase().includes(kw) &&
          !(q.stem || '').toLowerCase().includes(kw)) return false;
    }
    return true;
  });
}

function applyOrderMode(questions, order) {
  const p = state.progress;
  switch (order) {
    case 'random': return shuffle(questions);
    case 'new-first': return questions.filter(q => !p[q.id] || p[q.id].attempts === 0);
    case 'wrong-only': return questions.filter(q => p[q.id] && p[q.id].wrongCount > 0);
    default: return questions;
  }
}

// ------------------------------------------------------------
// Session runner
// ------------------------------------------------------------
let session = {
  questions: [],
  index: 0,
  answered: false,
  userAnswer: null,
  mode: 'practice',   // 'practice' | 'exam' | 'review'
};

function startSession(questions, mode = 'practice') {
  if (!questions.length) {
    toast('該当する問題がありません');
    return;
  }
  session = { questions, index: 0, answered: false, userAnswer: null, mode };
  if (mode === 'exam') {
    startExam(questions);
  } else {
    showView('view-quiz');
    renderQuiz();
  }
}

function renderQuiz() {
  const q = session.questions[session.index];
  if (!q) return;

  $('quiz-index').textContent = session.index + 1;
  $('quiz-total').textContent = session.questions.length;
  $('progress-bar').style.width = `${((session.index + 1) / session.questions.length) * 100}%`;

  const p = getProgress(q.id);
  updateBookmarkIcon(p.bookmarked);

  // meta
  const era = q.year >= 2024 ? '新カリ' : '旧カリ';
  $('q-meta').innerHTML = `${q.year} · ${q.session} · ${q.sub} ${q.subName} · <span class="topic-tag">${q.topic || q.fmt}</span>`;
  $('q-num').textContent = `問題 ${q.q}`;
  $('q-stem').textContent = q.stem.replace(/^問題[\s　]*[\d０-９]+[\s　]*/, '');  // strip "問題N " prefix

  // choices
  const cw = $('q-choices');
  cw.innerHTML = '';
  q.c.forEach((text, i) => {
    const num = i + 1;
    const el = document.createElement('div');
    el.className = 'choice';
    el.dataset.num = num;
    el.innerHTML = `
      <div class="choice-num">${num}</div>
      <div class="choice-text">${escapeHtml(text)}</div>
    `;
    el.addEventListener('click', () => selectChoice(num));
    cw.appendChild(el);
  });

  session.answered = false;
  session.userAnswer = null;
  $('q-actions').hidden = false;
  $('q-explanation').hidden = true;
  $('quiz-nav').hidden = true;
  $('btn-submit').disabled = true;

  // note
  $('q-note-input').value = p.note || '';
}

function selectChoice(num) {
  if (session.answered) return;
  session.userAnswer = num;
  $$('.choice').forEach(c => c.classList.toggle('selected', +c.dataset.num === num));
  $('btn-submit').disabled = false;
}

function submitAnswer() {
  if (session.userAnswer == null) return;
  const q = session.questions[session.index];
  const correct = isCorrect(q, session.userAnswer);
  session.answered = true;

  // update progress counters
  const p = getProgress(q.id);
  p.attempts += 1;
  if (correct) p.correct += 1;
  else p.wrongCount += 1;
  p.lastAttempt = Date.now();

  // activity log
  const today = todayKey();
  if (!state.activityLog[today]) state.activityLog[today] = { attempts: 0, correct: 0 };
  state.activityLog[today].attempts += 1;
  if (correct) state.activityLog[today].correct += 1;

  saveState();

  // highlight
  $$('.choice').forEach(c => {
    const num = +c.dataset.num;
    const isRightNum = Array.isArray(q.ans) ? q.ans.includes(num) : q.ans === num;
    if (isRightNum) c.classList.add('correct');
    else if (num === session.userAnswer) c.classList.add('wrong');
  });

  // explanation
  $('q-actions').hidden = true;
  const ex = $('q-explanation');
  ex.hidden = false;
  ex.classList.toggle('wrong-answer', !correct);
  $('expl-title').textContent = correct ? '正解' : '不正解';
  $('expl-answer').textContent = `正答: ${formatAnswer(q)}`;
  $('expl-body').textContent = q.expl || '（この問題の解説は本Excelに収録されていません）';

  const noteBox = $('expl-note');
  if (q.ansNote) {
    noteBox.textContent = '⚠️ ' + q.ansNote;
    noteBox.hidden = false;
  } else {
    noteBox.hidden = true;
  }

  // SRS interval previews
  $('srs-again').textContent = previewInterval(p, 'again');
  $('srs-hard').textContent = previewInterval(p, 'hard');
  $('srs-good').textContent = previewInterval(p, 'good');
  $('srs-easy').textContent = previewInterval(p, 'easy');

  $('quiz-nav').hidden = false;
}

function applySrsRating(rating) {
  const q = session.questions[session.index];
  const p = getProgress(q.id);
  const update = computeNextDue(p, rating);
  Object.assign(p, update, { lastRating: rating });
  saveState();

  // Visual feedback
  $$('.srs-btn').forEach(b => b.classList.remove('pressed'));
  const btn = document.querySelector(`.srs-btn[data-rating="${rating}"]`);
  if (btn) btn.classList.add('pressed');

  toast(`次回: ${previewInterval(p, rating).replace('日', ' 日後').replace('ヶ月', ' ヶ月後')}`);

  // Auto-advance after 500ms
  setTimeout(() => {
    if (session.index < session.questions.length - 1) {
      nextQuestion();
    } else {
      toast('セッション完了 🎉', 2500);
      setTimeout(() => showView('view-home'), 800);
      refreshHome();
    }
  }, 600);
}

function saveNote() {
  const q = session.questions[session.index];
  const p = getProgress(q.id);
  p.note = $('q-note-input').value;
  saveState();
}

function toggleBookmark() {
  const q = session.questions[session.index];
  const p = getProgress(q.id);
  p.bookmarked = !p.bookmarked;
  saveState();
  updateBookmarkIcon(p.bookmarked);
  toast(p.bookmarked ? 'ブックマークしました' : 'ブックマーク解除');
}

function updateBookmarkIcon(on) {
  const icon = $('bookmark-icon');
  if (!icon) return;
  icon.classList.toggle('active', !!on);
}

function nextQuestion() {
  if (session.index < session.questions.length - 1) {
    session.index += 1;
    renderQuiz();
  } else {
    toast('最後の問題です');
  }
}

function prevQuestion() {
  if (session.index > 0) {
    session.index -= 1;
    renderQuiz();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ------------------------------------------------------------
// Home refresh
// ------------------------------------------------------------
function refreshHome() {
  // Due count
  const now = Date.now();
  const due = Object.entries(state.progress).filter(([qid, p]) => p.nextDue && p.nextDue <= now);
  $('due-count').textContent = due.length;
  $('due-subtitle').textContent = due.length > 0
    ? `${due.length}問の復習が予定されています`
    : '復習期限の問題はありません';
  $('btn-start-review').disabled = due.length === 0;

  // Bookmark count
  const bookmarked = Object.values(state.progress).filter(p => p.bookmarked).length;
  $('bookmark-count').textContent = bookmarked;

  // Stats
  const allProgress = Object.values(state.progress);
  const attempted = allProgress.filter(p => p.attempts > 0);
  $('stat-attempted').textContent = attempted.length;
  if (attempted.length > 0) {
    const totalAtt = attempted.reduce((s, p) => s + p.attempts, 0);
    const totalCorrect = attempted.reduce((s, p) => s + p.correct, 0);
    $('stat-accuracy').textContent = `${Math.round(totalCorrect / totalAtt * 100)}%`;
  } else {
    $('stat-accuracy').textContent = '-';
  }
  $('stat-streak').textContent = computeStreak();
}

function computeStreak() {
  const dates = Object.keys(state.activityLog).sort().reverse();
  if (dates.length === 0) return 0;
  const today = todayKey();
  let streak = 0;
  let d = new Date();
  while (true) {
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (state.activityLog[k]) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    } else if (streak === 0 && k === today) {
      d.setDate(d.getDate() - 1); // no activity today yet, check yesterday
    } else {
      break;
    }
    if (streak > 365) break;
  }
  return streak;
}

// ------------------------------------------------------------
// Mode handlers
// ------------------------------------------------------------
function handleMode(mode) {
  switch (mode) {
    case 'practice':
      showFilterView();
      break;
    case 'daily': {
      const pool = DATA.filter(q => q.year >= 2024); // prioritize new curriculum
      startSession(shuffle(pool).slice(0, 10));
      break;
    }
    case 'weak': {
      // Get topics with attempts>=3 and accuracy<60%, then get their questions
      const topicStats = computeTopicStats();
      const weakTopics = topicStats.filter(t => t.attempts >= 3 && t.acc < 0.6).map(t => t.topic);
      let pool = DATA.filter(q => weakTopics.includes(q.topic || q.fmt));
      // Also add all wrong questions
      const wrong = DATA.filter(q => state.progress[q.id]?.wrongCount > 0);
      const seen = new Set();
      pool = [...pool, ...wrong].filter(q => {
        if (seen.has(q.id)) return false;
        seen.add(q.id);
        return true;
      });
      if (pool.length === 0) {
        toast('苦手項目はまだ検出されていません');
        return;
      }
      startSession(shuffle(pool).slice(0, 20));
      break;
    }
    case 'exam': {
      // Real exam: 50 random questions from newest curriculum
      const pool = DATA.filter(q => q.year >= 2024);
      // Actually let's do it more realistically - 50 questions from one year and session mix
      // Draw from any one year (2024 or 2025 randomly)
      const targetYear = Math.random() < 0.5 ? 2024 : 2025;
      const pool2 = DATA.filter(q => q.year === targetYear);
      startSession(shuffle(pool2).slice(0, 50), 'exam');
      break;
    }
    case 'bookmark': {
      const bookmarked = DATA.filter(q => state.progress[q.id]?.bookmarked);
      if (bookmarked.length === 0) {
        toast('ブックマークした問題がありません');
        return;
      }
      startSession(bookmarked);
      break;
    }
    case 'stats':
      showStatsView();
      break;
  }
}

// ------------------------------------------------------------
// Filter view
// ------------------------------------------------------------
function showFilterView() {
  renderFilterChips();
  updateFilterSummary();
  showView('view-filter');
}

function renderFilterChips() {
  // Years
  const yearWrap = $('filter-year');
  yearWrap.innerHTML = '';
  [2021, 2022, 2023, 2024, 2025].forEach(y => {
    const chip = mkChip(String(y), state.filters.years.includes(y));
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      const set = new Set(state.filters.years);
      if (chip.classList.contains('selected')) set.add(y);
      else set.delete(y);
      state.filters.years = [...set];
      updateFilterSummary();
    });
    yearWrap.appendChild(chip);
  });

  // Sessions
  const sessWrap = $('filter-session');
  sessWrap.innerHTML = '';
  ['午前', '午後'].forEach(s => {
    const chip = mkChip(s, state.filters.sessions.includes(s));
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      const set = new Set(state.filters.sessions);
      if (chip.classList.contains('selected')) set.add(s);
      else set.delete(s);
      state.filters.sessions = [...set];
      updateFilterSummary();
    });
    sessWrap.appendChild(chip);
  });

  // New subjects
  const newSubs = [
    ['new-101', '101 企業と不動産'],
    ['new-102', '102 不動産証券化の概要'],
    ['new-103', '103 不動産投資の基礎'],
    ['new-104', '104 法務／会計・税務'],
    ['new-105', '105 不動産ファイナンスの基礎'],
    ['new-106', '106 倫理行動'],
  ];
  const newWrap = $('filter-sub-new');
  newWrap.innerHTML = '';
  newSubs.forEach(([key, label]) => {
    const chip = mkChip(label, state.filters.subjects.includes(key));
    chip.addEventListener('click', () => toggleSubject(chip, key));
    newWrap.appendChild(chip);
  });

  // Old subjects
  const oldSubs = [
    ['old-101', '101 不動産証券化の概論'],
    ['old-102', '102 不動産投資の実務'],
    ['old-103', '103 商品の組成と管理'],
    ['old-104', '104 ファイナンス理論'],
    ['old-105', '105 倫理行動'],
  ];
  const oldWrap = $('filter-sub-old');
  oldWrap.innerHTML = '';
  oldSubs.forEach(([key, label]) => {
    const chip = mkChip(label, state.filters.subjects.includes(key));
    chip.addEventListener('click', () => toggleSubject(chip, key));
    oldWrap.appendChild(chip);
  });

  // Formats
  const fmts = ['正誤', '計算', '穴埋め', '組合せ', '個数選択', 'その他'];
  const fmtWrap = $('filter-fmt');
  fmtWrap.innerHTML = '';
  fmts.forEach(f => {
    const chip = mkChip(f, state.filters.formats.includes(f));
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      const set = new Set(state.filters.formats);
      if (chip.classList.contains('selected')) set.add(f);
      else set.delete(f);
      state.filters.formats = [...set];
      updateFilterSummary();
    });
    fmtWrap.appendChild(chip);
  });

  // Topic
  $('filter-topic').value = state.filters.topic;
  $('filter-topic').oninput = e => {
    state.filters.topic = e.target.value;
    updateFilterSummary();
  };

  // Order
  const orderWrap = $('filter-order');
  orderWrap.querySelectorAll('.chip').forEach(chip => {
    chip.classList.toggle('selected', chip.dataset.value === state.filters.order);
    chip.onclick = () => {
      orderWrap.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      state.filters.order = chip.dataset.value;
      updateFilterSummary();
    };
  });
}

function mkChip(label, selected) {
  const c = document.createElement('div');
  c.className = 'chip' + (selected ? ' selected' : '');
  c.textContent = label;
  return c;
}

function toggleSubject(chip, key) {
  chip.classList.toggle('selected');
  const set = new Set(state.filters.subjects);
  if (chip.classList.contains('selected')) set.add(key);
  else set.delete(key);
  state.filters.subjects = [...set];
  updateFilterSummary();
}

function updateFilterSummary() {
  const filtered = applyOrderMode(filterQuestions(), state.filters.order);
  $('filter-count').textContent = filtered.length;
}

function resetFilters() {
  state.filters = structuredClone(defaultState.filters);
  renderFilterChips();
  updateFilterSummary();
}

// ------------------------------------------------------------
// Stats
// ------------------------------------------------------------
function computeSubjectStats() {
  const groups = {};
  DATA.forEach(q => {
    const p = state.progress[q.id];
    if (!p || p.attempts === 0) return;
    const era = q.year >= 2024 ? '新' : '旧';
    const key = `${era} ${q.sub} ${q.subName}`;
    if (!groups[key]) groups[key] = { attempts: 0, correct: 0, count: 0 };
    groups[key].attempts += p.attempts;
    groups[key].correct += p.correct;
    groups[key].count += 1;
  });
  return Object.entries(groups).map(([name, s]) => ({
    name,
    attempts: s.attempts,
    correct: s.correct,
    count: s.count,
    acc: s.correct / s.attempts,
  })).sort((a, b) => a.acc - b.acc);
}

function computeTopicStats() {
  const groups = {};
  DATA.forEach(q => {
    const p = state.progress[q.id];
    if (!p || p.attempts === 0) return;
    const topic = q.topic || q.fmt || 'その他';
    if (!groups[topic]) groups[topic] = { attempts: 0, correct: 0 };
    groups[topic].attempts += p.attempts;
    groups[topic].correct += p.correct;
  });
  return Object.entries(groups).map(([topic, s]) => ({
    topic,
    attempts: s.attempts,
    correct: s.correct,
    acc: s.correct / s.attempts,
  }));
}

function showStatsView() {
  const allProgress = Object.values(state.progress);
  const attempted = allProgress.filter(p => p.attempts > 0);
  const totalAtt = attempted.reduce((s, p) => s + p.attempts, 0);
  const totalCorrect = attempted.reduce((s, p) => s + p.correct, 0);

  $('stats-attempted').textContent = attempted.length;
  $('stats-correct').textContent = totalCorrect;
  $('stats-accuracy').textContent = totalAtt > 0 ? `${Math.round(totalCorrect / totalAtt * 100)}%` : '-';

  // Subject stats
  const subStats = computeSubjectStats();
  const subWrap = $('subject-stats');
  subWrap.innerHTML = '';
  if (subStats.length === 0) {
    subWrap.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">まだ挑戦した問題がありません</div>';
  }
  subStats.forEach(s => {
    const pct = Math.round(s.acc * 100);
    const cls = pct >= 70 ? 'good' : pct >= 50 ? 'mid' : 'bad';
    const row = document.createElement('div');
    row.className = 'subject-row';
    row.innerHTML = `
      <div class="subject-row-header">
        <div class="subject-name">${escapeHtml(s.name)}</div>
        <div class="subject-acc ${cls}">${pct}%</div>
      </div>
      <div class="subject-detail">${s.correct} / ${s.attempts} 正解 · ${s.count}問挑戦</div>
      <div class="subject-bar"><div class="subject-bar-fill ${cls}" style="width:${pct}%"></div></div>
    `;
    subWrap.appendChild(row);
  });

  // Weak topics
  const topicStats = computeTopicStats();
  const weak = topicStats.filter(t => t.attempts >= 3 && t.acc < 0.6).sort((a, b) => a.acc - b.acc).slice(0, 10);
  const weakWrap = $('weak-topics');
  weakWrap.innerHTML = '';
  if (weak.length === 0) {
    weakWrap.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">現時点で明確な苦手項目はありません</div>';
  }
  weak.forEach(t => {
    const el = document.createElement('div');
    el.className = 'weak-topic';
    el.innerHTML = `
      <span class="weak-topic-name">${escapeHtml(t.topic)}</span>
      <span class="weak-topic-acc">${Math.round(t.acc * 100)}%</span>
    `;
    el.addEventListener('click', () => {
      const pool = DATA.filter(q => (q.topic || q.fmt) === t.topic);
      startSession(shuffle(pool));
    });
    weakWrap.appendChild(el);
  });

  // Daily history (last 7 days)
  const historyWrap = $('daily-history');
  historyWrap.innerHTML = '';
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const log = state.activityLog[key];
    const cell = document.createElement('div');
    cell.className = 'day-cell' + (log ? ' has-activity' : '');
    const wd = ['日','月','火','水','木','金','土'][d.getDay()];
    cell.innerHTML = `<div class="day-date">${d.getMonth()+1}/${d.getDate()}(${wd})</div><div class="day-count">${log ? log.attempts : '-'}</div>`;
    historyWrap.appendChild(cell);
  }

  showView('view-stats');
}

// ------------------------------------------------------------
// Exam mode
// ------------------------------------------------------------
let exam = null;

function startExam(questions) {
  exam = {
    questions,
    answers: new Array(questions.length).fill(null),
    index: 0,
    startTime: Date.now(),
    duration: 120 * 60 * 1000,   // 120 min
    timer: null,
  };
  $('exam-total').textContent = questions.length;
  renderExamQuestion();
  showView('view-exam');
  exam.timer = setInterval(updateExamTimer, 1000);
  updateExamTimer();
}

function updateExamTimer() {
  if (!exam) return;
  const elapsed = Date.now() - exam.startTime;
  const remaining = exam.duration - elapsed;
  if (remaining <= 0) {
    finishExam();
    return;
  }
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  const el = $('exam-timer');
  el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  el.classList.toggle('warning', remaining < 20 * 60 * 1000);
  el.classList.toggle('danger', remaining < 5 * 60 * 1000);
}

function renderExamQuestion() {
  const q = exam.questions[exam.index];
  $('exam-index').textContent = exam.index + 1;
  $('exam-meta').innerHTML = `${q.year} · ${q.session} · ${q.sub} ${q.subName}`;
  $('exam-num').textContent = `問題 ${exam.index + 1} (元: ${q.year}${q.session}問${q.q})`;
  $('exam-stem').textContent = q.stem.replace(/^問題[\s　]*[\d０-９]+[\s　]*/, '');
  const cw = $('exam-choices');
  cw.innerHTML = '';
  q.c.forEach((text, i) => {
    const num = i + 1;
    const el = document.createElement('div');
    el.className = 'choice' + (exam.answers[exam.index] === num ? ' selected' : '');
    el.innerHTML = `<div class="choice-num">${num}</div><div class="choice-text">${escapeHtml(text)}</div>`;
    el.addEventListener('click', () => {
      exam.answers[exam.index] = num;
      renderExamQuestion();
    });
    cw.appendChild(el);
  });

  // Show submit button on last question
  $('btn-exam-submit').hidden = exam.index !== exam.questions.length - 1;
}

function finishExam() {
  if (exam.timer) clearInterval(exam.timer);

  const results = exam.questions.map((q, i) => ({
    q,
    userAnswer: exam.answers[i],
    correct: exam.answers[i] != null && isCorrect(q, exam.answers[i]),
  }));

  const correctCount = results.filter(r => r.correct).length;
  const total = results.length;

  // Save exam result
  state.examResults.push({
    date: Date.now(),
    total,
    correct: correctCount,
    year: exam.questions[0]?.year,
    duration: Date.now() - exam.startTime,
  });
  // Also update progress
  const today = todayKey();
  if (!state.activityLog[today]) state.activityLog[today] = { attempts: 0, correct: 0 };
  results.forEach(r => {
    const p = getProgress(r.q.id);
    p.attempts += 1;
    if (r.correct) { p.correct += 1; }
    else { p.wrongCount += 1; }
    p.lastAttempt = Date.now();
    state.activityLog[today].attempts += 1;
    if (r.correct) state.activityLog[today].correct += 1;
  });
  saveState();

  // Show result
  $('score-correct').textContent = correctCount;
  $('score-total').textContent = total;
  const pct = Math.round(correctCount / total * 100);
  $('score-pct').textContent = `${pct}%`;
  const passEl = $('score-pass');
  // ARES passing is around 70% typically
  if (pct >= 70) {
    passEl.textContent = '合格ライン突破 🎉';
    passEl.className = 'score-pass pass';
  } else {
    passEl.textContent = `合格ラインまで あと ${Math.ceil(0.7 * total) - correctCount} 問`;
    passEl.className = 'score-pass fail';
  }

  // Subject breakdown
  const subScores = {};
  results.forEach(r => {
    const key = `${r.q.sub} ${r.q.subName}`;
    if (!subScores[key]) subScores[key] = { correct: 0, total: 0 };
    subScores[key].total += 1;
    if (r.correct) subScores[key].correct += 1;
  });
  const scoreWrap = $('exam-subject-scores');
  scoreWrap.innerHTML = '';
  Object.entries(subScores).forEach(([name, s]) => {
    const pct = Math.round(s.correct / s.total * 100);
    const cls = pct >= 70 ? 'good' : pct >= 50 ? 'mid' : 'bad';
    scoreWrap.innerHTML += `
      <div class="subject-row">
        <div class="subject-row-header">
          <div class="subject-name">${escapeHtml(name)}</div>
          <div class="subject-acc ${cls}">${s.correct}/${s.total} (${pct}%)</div>
        </div>
        <div class="subject-bar"><div class="subject-bar-fill ${cls}" style="width:${pct}%"></div></div>
      </div>
    `;
  });

  // Wrong list
  const wrongWrap = $('exam-wrong-list');
  wrongWrap.innerHTML = '';
  const wrongResults = results.filter(r => !r.correct);
  if (wrongResults.length === 0) {
    wrongWrap.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:16px;">全問正解！</div>';
  }
  wrongResults.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'wrong-item';
    const stem = r.q.stem.replace(/^問題\S*\s*/, '').slice(0, 60);
    item.innerHTML = `
      <div class="wrong-item-meta">${r.q.year} · ${r.q.session} · ${r.q.sub} · ${escapeHtml(r.q.topic || r.q.fmt)}</div>
      <div>${escapeHtml(stem)}...</div>
    `;
    item.addEventListener('click', () => {
      startSession([r.q]);
    });
    wrongWrap.appendChild(item);
  });

  // Attach review handler
  $('btn-exam-review').onclick = () => {
    startSession(wrongResults.map(r => r.q));
  };

  showView('view-exam-result');
}

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------
function applyTheme() {
  const theme = state.settings.theme;
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function applyFontSize() {
  document.documentElement.setAttribute('data-fontsize', state.settings.fontsize);
}

function exportData() {
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ares-course1-progress-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (confirm('現在のデータを上書きします。よろしいですか？')) {
        state = { ...structuredClone(defaultState), ...imported };
        saveState();
        toast('データをインポートしました');
        refreshHome();
        applyTheme();
        applyFontSize();
      }
    } catch (err) {
      toast('ファイルの読み込みに失敗しました');
    }
  };
  reader.readAsText(file);
}

function resetAll() {
  if (!confirm('すべての学習履歴を削除します。この操作は取り消せません。')) return;
  if (!confirm('本当によろしいですか？（この確認が最後です）')) return;
  state = structuredClone(defaultState);
  saveState();
  toast('データをリセットしました');
  refreshHome();
}

// ------------------------------------------------------------
// Startup / event bindings
// ------------------------------------------------------------
function init() {
  applyTheme();
  applyFontSize();
  $('setting-theme').value = state.settings.theme;
  $('setting-fontsize').value = state.settings.fontsize;
  refreshHome();

  // Home mode buttons
  $$('.mode-card').forEach(btn => {
    btn.addEventListener('click', () => handleMode(btn.dataset.mode));
  });

  // Start review
  $('btn-start-review').addEventListener('click', () => {
    const now = Date.now();
    const dueIds = Object.entries(state.progress)
      .filter(([qid, p]) => p.nextDue && p.nextDue <= now)
      .map(([qid]) => qid);
    const pool = DATA.filter(q => dueIds.includes(q.id));
    startSession(pool);
  });

  // Settings icon
  $('btn-settings').addEventListener('click', () => showView('view-settings'));
  $('btn-settings-back').addEventListener('click', () => { showView('view-home'); refreshHome(); });

  // Quiz nav
  $('btn-quiz-back').addEventListener('click', () => { showView('view-home'); refreshHome(); });
  $('btn-submit').addEventListener('click', submitAnswer);
  $('btn-next').addEventListener('click', nextQuestion);
  $('btn-prev').addEventListener('click', prevQuestion);
  $('btn-bookmark').addEventListener('click', toggleBookmark);
  $('btn-filter').addEventListener('click', showFilterView);
  $('q-note-input').addEventListener('blur', saveNote);

  // SRS buttons
  $$('.srs-btn').forEach(btn => {
    btn.addEventListener('click', () => applySrsRating(btn.dataset.rating));
  });

  // Filter view
  $('btn-filter-back').addEventListener('click', () => showView('view-home'));
  $('btn-filter-reset').addEventListener('click', resetFilters);
  $('btn-filter-start').addEventListener('click', () => {
    const questions = applyOrderMode(filterQuestions(), state.filters.order);
    saveState();
    startSession(questions);
  });

  // Stats view
  $('btn-stats-back').addEventListener('click', () => { showView('view-home'); refreshHome(); });

  // Exam
  $('btn-exam-back').addEventListener('click', () => {
    if (exam && exam.timer) clearInterval(exam.timer);
    if (confirm('本試験を中断しますか？（進捗は保存されません）')) {
      exam = null;
      showView('view-home');
      refreshHome();
    }
  });
  $('btn-exam-next').addEventListener('click', () => {
    if (exam.index < exam.questions.length - 1) {
      exam.index += 1;
      renderExamQuestion();
    }
  });
  $('btn-exam-prev').addEventListener('click', () => {
    if (exam.index > 0) {
      exam.index -= 1;
      renderExamQuestion();
    }
  });
  $('btn-exam-list').addEventListener('click', () => {
    const unanswered = exam.answers.filter(a => a == null).length;
    const msg = unanswered > 0
      ? `未回答: ${unanswered}問\n途中採点しますか？`
      : `全問回答済み\n採点しますか？`;
    if (confirm(msg)) finishExam();
  });
  $('btn-exam-submit').addEventListener('click', () => {
    const unanswered = exam.answers.filter(a => a == null).length;
    const msg = unanswered > 0
      ? `未回答が${unanswered}問あります。採点しますか？`
      : '採点しますか？';
    if (confirm(msg)) finishExam();
  });
  $('btn-exam-home').addEventListener('click', () => { showView('view-home'); refreshHome(); });

  // Settings
  $('setting-theme').addEventListener('change', e => {
    state.settings.theme = e.target.value;
    saveState();
    applyTheme();
  });
  $('setting-fontsize').addEventListener('change', e => {
    state.settings.fontsize = e.target.value;
    saveState();
    applyFontSize();
  });
  $('btn-export').addEventListener('click', exportData);
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
  });
  $('btn-reset').addEventListener('click', resetAll);
}

document.addEventListener('DOMContentLoaded', init);
