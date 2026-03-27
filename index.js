/**
 * Calendar Tracker v5.1 — SillyTavern Extension
 *
 * Changes vs v4.0:
 *  [NEW]  Three separate injection depths: Rules(0), Deadlines(1), Timeline(4)
 *  [NEW]  Deadline types: Event/Threat/Plot with distinct prompt prefixes
 *  [NEW]  Hot/cold deadlines: only within N-day horizon appear in context
 *  [NEW]  Deadline pinning: force any deadline into context regardless of date
 *  [NEW]  Deadline title field (optional) for short naming
 *  [NEW]  Deadlines grouped by month (like Events tab)
 *  [NEW]  Date3 picker (day/month/year) for deadlines (add + edit)
 *  [NEW]  Token counter per section in modal: Rules · Timeline · Deadlines
 *  [NEW]  Deadline horizon setting (default 7 days)
 *  [FIX]  Mobile modal date fields sizing improved
 *  [FIX]  Scan prompt hardened: max 15 words per event, examples, post-processing
 *  [UPD]  "Ежегодные события" → "Атмосфера месяца" in Rules
 *  [UPD]  Calendar rules prompt: only current+next month detailed, rest names only
 *  [UPD]  Moon phases in prompt: phase names only (detailed notes removed)
 */

(() => {
  'use strict';

  const MODULE_KEY   = 'calendar_tracker';
  const DRAFT_SS_KEY = 'calt_cfg_draft_v5';

  // ─── Module state ─────────────────────────────────────────────────────────
  let activeTab          = 'events';
  let _lastAutoLen       = 0;
  let _autoScanTimer     = null;
  let _autoScanRunning   = false;  // prevents parallel scan runs
  let _draftSaveTimer    = null;
  let _collapsedMonths   = {};
  let _collapsedSections = {};
  let _searchQuery       = '';
  let _tagFilter         = null;
  let _cfgDraft          = null;   // in-memory calendarConfig draft (Rules tab)
  let _cfgDirty          = false;  // unsaved changes flag
  let _promptActive      = false;  // whether prompt is currently injected

  // ─── Tags ─────────────────────────────────────────────────────────────────
  const TAGS = [
    { key: 'combat',  label: '⚔ Бой',        color: '#ef4444' },
    { key: 'death',   label: '💀 Смерть',     color: '#8b5cf6' },
    { key: 'pact',    label: '🤝 Пакт',       color: '#fbbf24' },
    { key: 'reveal',  label: '🔍 Откровение', color: '#60a5fa' },
    { key: 'ritual',  label: '✨ Ритуал',     color: '#a78bfa' },
    { key: 'escape',  label: '🏃 Побег',      color: '#34d399' },
    { key: 'injury',  label: '🩸 Ранение',    color: '#f87171' },
    { key: 'key',     label: '🗝 Ключевое',   color: '#f59e0b' },
  ];
  function tagByKey(k) { return TAGS.find(t => t.key === k); }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function ctx() { return SillyTavern.getContext(); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function extractMonth(dateStr) {
    if (!dateStr || !dateStr.trim()) return null;
    const parts = dateStr.trim().split(/\s+/);
    for (let i = parts.length - 1; i >= 0; i--) {
      // Skip pure digits AND digit ranges like "5-11"
      if (/^\d+$/.test(parts[i]) || /^\d+-\d+$/.test(parts[i])) continue;
      // Skip "Days", "Day", "Night" — these are prefixes, not months
      if (/^(days?|nights?|week|weeks)$/i.test(parts[i])) continue;
      return parts[i];
    }
    return null;
  }

  function currentMonth() { return extractMonth(getSettings().currentDate); }

  function buildDateString(d, m, y) { return [d, m, y].filter(Boolean).join(' '); }

  function parseDateString(str) {
    if (!str) return { day:'', month:'', year:'' };
    const parts = str.trim().split(/\s+/);
    let day = '', month = '', year = '';
    for (const p of parts) {
      if (/^\d+$/.test(p)) { if (!day) day = p; else year = p; }
      // Handle day ranges like "9-13" — preserve the full range string; parseInt("9-13") = 9 for math
      else if (/^\d+-\d+$/.test(p)) { if (!day) day = p; else year = p; }
      else month = p;
    }
    return { day, month, year };
  }

  // ─── Storage ──────────────────────────────────────────────────────────────
  function defaultCalendarConfig() {
    return { name:'', era:'', eraFrom:'', months:[], weekDays:[],
             weekRefDate:'', weekRefDayIndex:0, moons:[] };
  }

  // ─── Deadline type tags ────────────────────────────────────────────────
  const DEADLINE_TYPES = [
    { key: 'event',  label: '🎭 Ивент',  color: '#a78bfa', promptPrefix: '🎭 EVENT' },
    { key: 'threat', label: '🔴 Угроза', color: '#ef4444', promptPrefix: '⚠ THREAT' },
    { key: 'plot',   label: '📋 Сюжет',  color: '#60a5fa', promptPrefix: '📋 PLOT' },
  ];
  function dlTypeByKey(k) { return DEADLINE_TYPES.find(t => t.key === k) || DEADLINE_TYPES[0]; }

  function defaultSettings() {
    return {
      enabled: true,
      currentDate:'', currentDay:'', currentMonthName:'', currentYear:'',
      keyEvents:[], deadlines:[],
      calendarRules:'',
      calendarConfig: defaultCalendarConfig(),
      autoScan:false, scanDepth:20, autoScanThreshold:3,
      depthRules:0, depthDeadlines:1, depthTimeline:4,
      deadlineHorizon:7,
      customApiEndpoint:'', customApiKey:'', customApiModel:'',
      monthSummaries:{}, monthSummarySnaps:{},
      manualHotMonths:[], manualColdMonths:[],
      nextEventId:1, nextDeadlineId:1,
    };
  }

  function _usePerChat() {
    try { const c = ctx(); return !!(c.chat_metadata && typeof c.saveMetadata === 'function'); }
    catch(e) { return false; }
  }

  function getSettings() {
    const c = ctx();
    let s;
    if (_usePerChat()) {
      if (!c.chat_metadata[MODULE_KEY]) c.chat_metadata[MODULE_KEY] = defaultSettings();
      s = c.chat_metadata[MODULE_KEY];
    } else {
      if (!c.extensionSettings[MODULE_KEY]) c.extensionSettings[MODULE_KEY] = defaultSettings();
      s = c.extensionSettings[MODULE_KEY];
    }
    // Normalise
    if (!Array.isArray(s.keyEvents))  s.keyEvents  = [];
    if (!Array.isArray(s.deadlines))  s.deadlines  = [];
    if (!s.monthSummaries  || typeof s.monthSummaries  !== 'object') s.monthSummaries  = {};
    if (!s.monthSummarySnaps || typeof s.monthSummarySnaps !== 'object') s.monthSummarySnaps = {};
    if (!Array.isArray(s.manualHotMonths))  s.manualHotMonths  = [];
    if (!Array.isArray(s.manualColdMonths)) s.manualColdMonths = [];
    // nextId — always safe: at least max(existing ids)+1, never NaN
    const evIds = s.keyEvents.map(e => e.id || 0);
    const dlIds = s.deadlines.map(e => e.id || 0);
    s.nextEventId    = Math.max(0, s.nextEventId || 0, ...evIds) + (evIds.length ? 0 : 1);
    s.nextDeadlineId = Math.max(0, s.nextDeadlineId || 0, ...dlIds) + (dlIds.length ? 0 : 1);
    if (s.injectionDepth === undefined) s.injectionDepth = 0;
    // Migrate old single injectionDepth to three-depth system
    if (s.depthRules === undefined) s.depthRules = 0;
    if (s.depthDeadlines === undefined) s.depthDeadlines = 1;
    if (s.depthTimeline === undefined) s.depthTimeline = 4;
    if (s.deadlineHorizon === undefined) s.deadlineHorizon = 7;
    if (s.autoScanThreshold === undefined) s.autoScanThreshold = 3;
    if (s.customApiEndpoint === undefined) s.customApiEndpoint = '';
    if (s.customApiKey === undefined) s.customApiKey = '';
    if (s.customApiModel === undefined) s.customApiModel = '';
    if (!s.calendarConfig || typeof s.calendarConfig !== 'object') s.calendarConfig = defaultCalendarConfig();
    const cc = s.calendarConfig;
    if (!Array.isArray(cc.months))   cc.months   = [];
    if (!Array.isArray(cc.weekDays)) cc.weekDays = [];
    if (!Array.isArray(cc.moons))    cc.moons    = [];
    cc.moons.forEach(m => { if (!Array.isArray(m.phases)) m.phases = []; });
    s.keyEvents.forEach(e => {
      if (e.pinned === undefined) e.pinned = false;
      if (!Array.isArray(e.tags)) e.tags = [];
      if (e.hidden === undefined) e.hidden = false;
    });
    s.deadlines.forEach(e => {
      if (e.pinned === undefined) e.pinned = false;
      if (e.title === undefined) e.title = '';
      if (e.dtype === undefined) e.dtype = 'event';
    });
    // Migrate: split currentDate into three fields if needed
    if (s.currentDate && !s.currentDay && !s.currentMonthName) {
      const p = parseDateString(s.currentDate);
      s.currentDay = p.day; s.currentMonthName = p.month; s.currentYear = p.year;
    }
    return s;
  }

  function save() {
    const c = ctx();
    try {
      if (_usePerChat()) c.saveMetadata();
      else if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
    } catch(e) { console.warn('[CalTracker] save failed:', e); }
  }

  // ─── Calendar math ────────────────────────────────────────────────────────
  function dateToAbsDay(day, monthName, year) {
    const cfg = getSettings().calendarConfig;
    if (!cfg.months.length) return null;
    const d = parseInt(day, 10), y = parseInt(year, 10);
    if (isNaN(d) || isNaN(y)) return null;
    const mi = cfg.months.findIndex(m => m.name.toLowerCase() === String(monthName||'').toLowerCase());
    if (mi < 0) return null;
    const dpy = cfg.months.reduce((s, m) => s + (parseInt(m.days,10)||30), 0);
    const dbm = cfg.months.slice(0,mi).reduce((s, m) => s + (parseInt(m.days,10)||30), 0);
    return (y-1)*dpy + dbm + (d-1);
  }

  // For deadline horizon math: use the END of a day range ("5-11" → 11)
  // so the deadline isn't considered "passed" until the whole range is over.
  function dateToAbsDayEnd(day, monthName, year) {
    const cfg = getSettings().calendarConfig;
    if (!cfg.months.length) return null;
    // Extract end of range: "5-11" → 11, "5" → 5
    const dayStr = String(day || '');
    const rangeMatch = dayStr.match(/^(\d+)-(\d+)$/);
    const d = rangeMatch ? parseInt(rangeMatch[2], 10) : parseInt(dayStr, 10);
    const y = parseInt(year, 10);
    if (isNaN(d) || isNaN(y)) return null;
    const mi = cfg.months.findIndex(m => m.name.toLowerCase() === String(monthName||'').toLowerCase());
    if (mi < 0) return null;
    const dpy = cfg.months.reduce((s, m) => s + (parseInt(m.days,10)||30), 0);
    const dbm = cfg.months.slice(0,mi).reduce((s, m) => s + (parseInt(m.days,10)||30), 0);
    return (y-1)*dpy + dbm + (d-1);
  }

  function getCurrentAbsDay() {
    const s = getSettings();
    return dateToAbsDay(s.currentDay, s.currentMonthName, s.currentYear);
  }

  function getDayOfWeek(absDay) {
    const cfg = getSettings().calendarConfig;
    if (!cfg.weekDays.length || absDay === null) return null;
    const n = cfg.weekDays.length;
    let refAbs = 0;
    if (cfg.weekRefDate) {
      const p = parseDateString(cfg.weekRefDate);
      const a = dateToAbsDay(p.day, p.month, p.year);
      if (a !== null) refAbs = a;
    }
    const offset = ((absDay - refAbs) % n + n) % n;
    const idx = ((cfg.weekRefDayIndex||0) + offset) % n;
    return cfg.weekDays[idx] || null;
  }

  function getMoonPhases(absDay) {
    const cfg = getSettings().calendarConfig;
    if (!cfg.moons.length || absDay === null) return [];
    const results = [];
    cfg.moons.forEach(moon => {
      if (!moon.phases || !moon.phases.length) return;
      const cycLen = Math.max(1, parseInt(moon.cycleDays,10) || 28);
      let refAbs = 0;
      if (moon.refDate) {
        const p = parseDateString(moon.refDate);
        const a = dateToAbsDay(p.day, p.month, p.year);
        if (a !== null) refAbs = a;
      }
      // Clamp refPhaseIndex to valid range (guard against out-of-bounds)
      const refPhaseIdx = Math.min(
        Math.max(parseInt(moon.refPhaseIndex,10) || 0, 0),
        moon.phases.length - 1
      );
      // Use Math.max(1,...) so days=0 phases never cause infinite loop
      const daysBeforeRef = moon.phases.slice(0, refPhaseIdx)
        .reduce((s, p) => s + Math.max(1, parseInt(p.days,10) || 1), 0);
      const raw = ((absDay - refAbs + daysBeforeRef) % cycLen + cycLen) % cycLen;
      let cum = 0;
      for (let i = 0; i < moon.phases.length; i++) {
        const pd = Math.max(1, parseInt(moon.phases[i].days,10) || 1);
        if (raw < cum + pd) {
          const nextIdx = (i + 1) % moon.phases.length;
          results.push({
            moonName:       moon.name,
            nickname:       moon.nickname || '',
            phaseName:      moon.phases[i].name,
            phaseNote:      moon.phases[i].note || '',
            phaseDays:      pd,
            dayInPhase:     raw - cum + 1,
            daysRemaining:  cum + pd - raw,
            nextPhase:      moon.phases[nextIdx].name,
            nextPhaseNote:  moon.phases[nextIdx].note || '',
            nextPhaseDays:  Math.max(1, parseInt(moon.phases[nextIdx].days,10) || 1),
          });
          break;
        }
        cum += pd;
      }
    });
    return results;
  }

  // Returns how many in-world days ago the event/period ended.
  // Uses dateToAbsDayEnd so "18-29 Эрвэн" returns days since day 29.
  // Returns null if can't calculate (no calendar config, missing date fields).
  // Returns negative number if event is in the future.
  function getEventDaysAgo(dateStr) {
    if (!dateStr) return null;
    const curAbs = getCurrentAbsDay();
    if (curAbs === null) return null;
    const p = parseDateString(dateStr);
    if (!p.month) return null;
    // Need a year — use currentYear as fallback only for events (not deadlines)
    const year = p.year || getSettings().currentYear;
    if (!year) return null;
    const evAbs = dateToAbsDayEnd(p.day || '1', p.month, year);
    if (evAbs === null) return null;
    return curAbs - evAbs; // positive = past, 0 = today, negative = future
  }

  // Human-readable "days ago" label for UI
  function daysAgoLabel(daysAgo) {
    if (daysAgo === null) return '';
    if (daysAgo < 0)  return '';           // future events — no label
    if (daysAgo === 0) return 'сегодня';
    if (daysAgo === 1) return 'вчера';
    if (daysAgo <= 60) return '~' + daysAgo + ' дн назад';
    return '';  // too far back — covered by month grouping / summaries
  }

  // Compact label for prompt injection — English, concise
  function daysAgoPromptTag(daysAgo) {
    if (daysAgo === null) return '';
    if (daysAgo < 0)   return ' (in ' + Math.abs(daysAgo) + 'd)';
    if (daysAgo === 0) return ' (TODAY)';
    if (daysAgo === 1) return ' (yesterday)';
    return ' (' + daysAgo + 'd ago)';
  }
  function isSummaryOutdated(month) {
    const s = getSettings();
    if (!s.monthSummaries[month]) return false;
    const snap    = (s.monthSummarySnaps || {})[month] || 0;
    const current = s.keyEvents.filter(e => extractMonth(e.date) === month).length;
    return current > snap;
  }

  function saveSummarySnap(month) {
    const s = getSettings();
    if (!s.monthSummarySnaps) s.monthSummarySnaps = {};
    s.monthSummarySnaps[month] = s.keyEvents.filter(e => extractMonth(e.date) === month).length;
  }

  // ─── Hot month ────────────────────────────────────────────────────────────
  function isMonthHot(month) {
    const s = getSettings(), cm = currentMonth();
    if (s.manualHotMonths.includes(month))  return true;
    if (s.manualColdMonths.includes(month)) return false;
    return !!(cm && month === cm);
  }

  function isDeadlineHot(deadline) {
    if (deadline.pinned) return true;
    const s = getSettings();
    const horizon = s.deadlineHorizon || 7;
    const curAbs = getCurrentAbsDay();
    if (curAbs === null) return true; // no current date set — show everything
    const p = parseDateString(deadline.date);
    // If deadline has no day or no month, we can't calculate — treat as hot
    if (!p.day || !p.month) return true;
    // No year: can't calculate reliable distance — always treat as hot.
    // The UI will show a "год не указан" warning badge on the deadline row.
    if (!p.year) return true;
    const dlAbs = dateToAbsDayEnd(p.day, p.month, p.year);
    if (dlAbs === null) return true; // month name not in config — treat as hot
    const diff = dlAbs - curAbs;
    return diff <= horizon; // includes past deadlines and those within horizon
  }

  // Returns true if the deadline date is missing a year component
  function _deadlineMissingYear(deadline) {
    if (!deadline.date) return false;
    const p = parseDateString(deadline.date);
    // Has day+month but no year — ambiguous
    return !!(p.day && p.month && !p.year);
  }

  // ─── Draft autosave (sessionStorage) ─────────────────────────────────────
  function _chatKey() {
    try {
      const c = ctx();
      return c.chatId || c.characters?.[c.characterId]?.name || 'default';
    } catch(e) { return 'default'; }
  }

  function saveDraftToSession() {
    try {
      if (!_cfgDraft) return;
      sessionStorage.setItem(DRAFT_SS_KEY, JSON.stringify({ chatKey: _chatKey(), draft: _cfgDraft }));
    } catch(e) { /* storage may be unavailable */ }
  }

  function loadDraftFromSession() {
    try {
      const raw = sessionStorage.getItem(DRAFT_SS_KEY);
      if (!raw) return null;
      const { chatKey, draft } = JSON.parse(raw);
      return chatKey === _chatKey() ? draft : null;
    } catch(e) { return null; }
  }

  function clearDraftFromSession() {
    try { sessionStorage.removeItem(DRAFT_SS_KEY); } catch(e) {}
  }

  // ─── syncDraftFromDOM ─────────────────────────────────────────────────────
  // Top-level: reads the Rules tab form into _cfgDraft + schedules sessionStorage write.
  // Safe to call when Rules tab is not in DOM (returns early after marking dirty).
  // Safe .val() helper — never throws when element is absent
  function _v($el) { return ($el.val() || '').trim(); }

  function syncDraftFromDOM() {
    _cfgDirty = true;
    updateDirtyBadge();
    if (!_cfgDraft) _cfgDraft = JSON.parse(JSON.stringify(getSettings().calendarConfig));
    if (!$('#cfg_name').length) return; // Rules tab not rendered — nothing to read

    _cfgDraft.name    = _v($('#cfg_name'));
    _cfgDraft.era     = _v($('#cfg_era'));
    _cfgDraft.eraFrom = _v($('#cfg_erafrom'));

    _cfgDraft.months = [];
    $('#cfg_months_list .calt-month-row').each(function() {
      _cfgDraft.months.push({
        name:          _v($(this).find('[data-field="name"]')),
        days:          parseInt($(this).find('[data-field="days"]').val(), 10) || 30,
        season:        _v($(this).find('[data-field="season"]')),
        recurringNote: _v($(this).find('[data-field="recurringNote"]')),
      });
    });

    _cfgDraft.weekDays = [];
    $('#cfg_wd_list .calt-wd-row').each(function() {
      _cfgDraft.weekDays.push({
        name: _v($(this).find('[data-field="name"]')),
        note: _v($(this).find('[data-field="note"]')),
      });
    });
    _cfgDraft.weekRefDate     = _v($('#cfg_week_ref_date'));
    _cfgDraft.weekRefDayIndex = parseInt($('#cfg_week_ref_day').val(), 10) || 0;

    $('#cfg_moons_list .calt-moon-card').each(function() {
      const mi   = +$(this).data('moon');
      const moon = _cfgDraft.moons[mi];
      if (!moon) return;
      moon.name      = _v($(this).find('.calt-moon-name'));
      moon.nickname  = _v($(this).find('.calt-moon-nickname'));
      moon.cycleDays = parseInt($(this).find('.calt-moon-cycle').val(), 10) || 28;
      moon.refDate   = _v($(this).find('.calt-moon-ref-date'));
      moon.refPhaseIndex = parseInt($(this).find('.calt-moon-ref-phase').val(), 10) || 0;
      moon.phases = [];
      $(this).find('.calt-phase-row').each(function() {
        moon.phases.push({
          name: _v($(this).find('[data-field="name"]')),
          days: Math.max(1, parseInt($(this).find('[data-field="days"]').val(), 10) || 1),
          note: _v($(this).find('[data-field="note"]')),
        });
      });
    });

    // Debounced sessionStorage write (avoid thrashing on every keypress)
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(saveDraftToSession, 500);
  }

  function updateDirtyBadge() {
    const $tab = $('#calt_tabs .calt-tab[data-tab="rules"]');
    if (_cfgDirty) $tab.addClass('calt-tab-dirty');
    else           $tab.removeClass('calt-tab-dirty');
    // Also update inline dirty hint inside Rules tab if rendered
    if (_cfgDirty) {
      if (!$('.calt-draft-hint').length && $('#calt_rules_save_btn').length) {
        $('#calt_rules_save_btn').before('<span class="calt-draft-hint">● несохранённые изменения</span>');
      }
    } else {
      $('.calt-draft-hint').remove();
    }
  }

  // ─── Prompt building ──────────────────────────────────────────────────────
  function buildCalendarRulesText() {
    const s = getSettings(), cc = s.calendarConfig;
    const cm = (s.currentMonthName || '').toLowerCase();
    const lines = [];
    if (cc.name) lines.push('[Calendar: ' + cc.name + ']');
    if (cc.era)  lines.push('[Era: ' + cc.era + (cc.eraFrom ? ' — ' + cc.eraFrom : '') + ']');
    if (cc.months.length) {
      // Find current month index
      const cmIdx = cc.months.findIndex(m => m.name.toLowerCase() === cm);
      const nextIdx = cmIdx >= 0 ? (cmIdx + 1) % cc.months.length : -1;
      // Detailed info: current + next month
      const detailedSet = new Set();
      if (cmIdx >= 0) detailedSet.add(cmIdx);
      if (nextIdx >= 0) detailedSet.add(nextIdx);
      // Full list of month names for ordering context
      const allNames = cc.months.map(m => m.name).join(', ');
      lines.push('[Month order: ' + allNames + ']');
      // Detailed months
      detailedSet.forEach(i => {
        const m = cc.months[i];
        const tag = i === cmIdx ? 'CURRENT' : 'NEXT';
        let detail = '[' + tag + ' MONTH: ' + m.name + ' — ' + (m.days||30) + ' days, ' + (m.season||'—');
        if (m.recurringNote) detail += ' | Atmosphere: ' + m.recurringNote;
        detail += ']';
        lines.push(detail);
      });
    }
    if (cc.weekDays.length) {
      const weekNames = cc.weekDays.map(d => d.name).join(' · ');
      lines.push('[Week: ' + weekNames + ']');
      // Current day's note only
      const absDay2 = getCurrentAbsDay();
      if (absDay2 !== null) {
        const dow = getDayOfWeek(absDay2);
        if (dow && dow.note) lines.push('[TODAY ' + dow.name + ': ' + dow.note + ']');
      }
    }
    // Moon phases: current+next detailed, rest names in cycle order
    const absDay = getCurrentAbsDay();
    const currentMoonPhases = absDay !== null ? getMoonPhases(absDay) : [];
    cc.moons.forEach(moon => {
      if (!moon.name || !moon.phases.length) return;
      const mp = currentMoonPhases.find(m => m.moonName === moon.name);
      const cycleNames = moon.phases.map(p => p.name).join(' → ');
      lines.push('[Moon ' + moon.name + (moon.nickname ? ' "' + moon.nickname + '"' : '') +
        ': ' + (moon.cycleDays||28) + '-day cycle: ' + cycleNames + ']');
      if (mp) {
        // Current phase with note
        let curDetail = '[CURRENT PHASE: ' + mp.phaseName + ' — ' + mp.phaseDays + 'd';
        if (mp.phaseNote) curDetail += ' | ' + mp.phaseNote;
        curDetail += ']';
        lines.push(curDetail);
        // Next phase with note
        let nextDetail = '[NEXT PHASE: ' + mp.nextPhase + ' — ' + mp.nextPhaseDays + 'd';
        if (mp.nextPhaseNote) nextDetail += ' | ' + mp.nextPhaseNote;
        nextDetail += ' (in ' + mp.daysRemaining + 'd)]';
        lines.push(nextDetail);
      }
    });
    if (s.calendarRules && s.calendarRules.trim()) lines.push(s.calendarRules.trim());
    return lines.join('\n');
  }

  // ── Three prompt section builders (for separate injection depths) ──────

  function buildRulesPromptText() {
    const s = getSettings(), cc = s.calendarConfig;
    const lines = ['[CALENDAR_RULES_START]'];
    // Current date + position + day of week + moon
    if (s.currentDate) {
      lines.push('CURRENT DATE: ' + s.currentDate);
      const absDay = getCurrentAbsDay();
      if (absDay !== null) {
        if (cc.months.length) {
          const mi = cc.months.findIndex(m => m.name.toLowerCase() === (s.currentMonthName||'').toLowerCase());
          if (mi >= 0) {
            const mDays = parseInt(cc.months[mi].days, 10) || 30;
            const dpy   = cc.months.reduce((sum, m) => sum + (parseInt(m.days,10)||30), 0);
            const dbm   = cc.months.slice(0, mi).reduce((sum, m) => sum + (parseInt(m.days,10)||30), 0);
            const d     = parseInt(s.currentDay, 10) || 1;
            lines.push('DAY POSITION: ' + d + ' of ' + mDays + ' in ' + (s.currentMonthName||'month') +
              ' · ' + (dbm + d) + ' of ' + dpy + ' in year');
          }
        }
        const dow = getDayOfWeek(absDay);
        if (dow) lines.push('DAY OF WEEK: ' + dow.name);
        getMoonPhases(absDay).forEach(mp => {
          let moonLine = 'MOON ' + mp.moonName + (mp.nickname ? ' "' + mp.nickname + '"' : '') +
            ': ' + mp.phaseName + ' (day ' + mp.dayInPhase + '/' + mp.phaseDays + ')';
          if (mp.phaseNote) moonLine += ' — ' + mp.phaseNote;
          moonLine += ' → ' + mp.daysRemaining + 'd to ' + mp.nextPhase;
          if (mp.nextPhaseNote) moonLine += ' (' + mp.nextPhaseNote + ')';
          lines.push(moonLine);
        });
      }
    }
    const rules = buildCalendarRulesText();
    if (rules) lines.push(rules);
    lines.push('[CALENDAR_RULES_END]');
    return lines.join('\n');
  }

  function buildTimelinePromptText() {
    const s = getSettings(), cc = s.calendarConfig, cm = currentMonth();
    const lines = ['[TIMELINE_START]'];

    // HOT layer — sorted chronologically, skip hidden events
    const hotEvents = s.keyEvents
      .filter(e => !e.hidden && (e.pinned || isMonthHot(extractMonth(e.date) || '')))
      .sort((a, b) => {
        const pa = parseDateString(a.date), pb = parseDateString(b.date);
        const aa = dateToAbsDay(pa.day, pa.month, pa.year);
        const ab = dateToAbsDay(pb.day, pb.month, pb.year);
        if (aa !== null && ab !== null) return aa - ab;
        if (aa !== null) return -1;
        if (ab !== null) return  1;
        return (a.date||'').localeCompare(b.date||'');
      });
    if (hotEvents.length) {
      lines.push('KEY EVENTS (current period):');
      hotEvents.forEach(e => {
        const pin = (e.pinned && extractMonth(e.date) !== cm) ? ' [📌]' : '';
        const tagStr = (e.tags && e.tags.length)
          ? ' [' + e.tags.map(k => { const t = tagByKey(k); return t ? t.key.toUpperCase() : ''; }).filter(Boolean).join('/') + ']'
          : '';
        const daysAgo  = getEventDaysAgo(e.date);
        const agoTag   = daysAgoPromptTag(daysAgo);
        lines.push('• ' + (e.date ? '[' + e.date + ']' : '') + tagStr + agoTag + ' ' + e.text + pin);
      });
    }

    // WARM layer — summaries for past months (sorted chronologically)
    const warmMonths = Object.keys(s.monthSummaries)
      .filter(m => !isMonthHot(m) && s.monthSummaries[m]?.trim());
    // Sort by month order in calendar config
    warmMonths.sort((a, b) => {
      const ai = cc.months.findIndex(m => m.name.toLowerCase() === a.toLowerCase());
      const bi = cc.months.findIndex(m => m.name.toLowerCase() === b.toLowerCase());
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
    if (warmMonths.length) {
      lines.push('PAST PERIODS (summary):');
      warmMonths.forEach(m => lines.push('• [' + m + '] ' + s.monthSummaries[m].trim()));
    }

    // TIME PASSED
    if (cm && cc.months.length) {
      const currentMonthIdx = cc.months.findIndex(m => m.name.toLowerCase() === cm.toLowerCase());
      if (currentMonthIdx > 0) {
        const pastMonthSet = new Set([
          ...Object.keys(s.monthSummaries).filter(m => s.monthSummaries[m]?.trim()),
          ...s.keyEvents.map(e => extractMonth(e.date)).filter(Boolean),
        ]);
        const pastWithIdx = [...pastMonthSet]
          .map(name => ({
            name,
            idx: cc.months.findIndex(m => m.name.toLowerCase() === name.toLowerCase()),
          }))
          .filter(m => m.idx >= 0 && m.idx < currentMonthIdx && !isMonthHot(m.name));
        if (pastWithIdx.length) {
          const latestPast = pastWithIdx.reduce((a, b) => a.idx > b.idx ? a : b);
          const gap = currentMonthIdx - latestPast.idx - 1;
          if (gap > 0) {
            lines.push('TIME PASSED: ~' + gap + ' month' + (gap > 1 ? 's' : '') +
              ' elapsed since ' + latestPast.name + ' with no recorded events');
          }
        }
      }
    }
    lines.push('[TIMELINE_END]');
    return lines.join('\n');
  }

  function buildDeadlinesPromptText() {
    const s = getSettings();
    const hotDls = s.deadlines.filter(e => isDeadlineHot(e));
    if (!hotDls.length) return '';
    const curAbs = getCurrentAbsDay();
    hotDls.sort((a, b) => {
      const pa = parseDateString(a.date), pb = parseDateString(b.date);
      // No year → sort to end (unknown timing)
      const aa = pa.year ? dateToAbsDay(pa.day, pa.month, pa.year) : null;
      const ab = pb.year ? dateToAbsDay(pb.day, pb.month, pb.year) : null;
      if (aa !== null && ab !== null) return aa - ab;
      if (aa !== null) return -1;
      if (ab !== null) return  1;
      return 0;
    });
    const lines = ['[UPCOMING_START]'];
    hotDls.forEach(e => {
      const dt = dlTypeByKey(e.dtype);
      const titlePart = e.title ? e.title + ': ' : '';
      const pinTag = e.pinned ? ' [📌]' : '';
      // Calculate days-until for urgency (use end of range: "5-11" → day 11)
      // Skip if no year — distance is unknown, don't emit misleading urgency
      let urgency = '';
      if (curAbs !== null) {
        const p = parseDateString(e.date);
        if (p.year) {
          const dlAbs = dateToAbsDayEnd(p.day, p.month, p.year);
          if (dlAbs !== null) {
            const diff = dlAbs - curAbs;
            if (diff < 0)      urgency = ' (OVERDUE ' + Math.abs(diff) + 'd)';
            else if (diff === 0) urgency = ' (TODAY!)';
            else if (diff <= 3)  urgency = ' (IN ' + diff + ' DAY' + (diff > 1 ? 'S' : '') + '!)';
            else                 urgency = ' (in ' + diff + ' days)';
          }
        } else {
          urgency = ' (year unknown)';
        }
      }
      lines.push('• ' + dt.promptPrefix + ' ' + (e.date ? '[' + e.date + '] ' : '') + titlePart + e.text + urgency + pinTag);
    });
    lines.push('[UPCOMING_END]');
    return lines.join('\n');
  }

  // Legacy combined builder (used for token counting)
  function buildPromptText() {
    return [buildRulesPromptText(), buildTimelinePromptText(), buildDeadlinesPromptText()].filter(Boolean).join('\n\n');
  }

  async function updatePrompt() {
    const s = getSettings();
    const { setExtensionPrompt, extension_prompt_types } = ctx();
    if (!setExtensionPrompt) { _promptActive = false; _updatePromptUI(); return; }
    const cc = s.calendarConfig || {};
    const hasContent = s.currentDate || s.keyEvents.length || s.deadlines.length ||
      s.calendarRules || cc.name || cc.months.length;
    const pt = extension_prompt_types?.IN_PROMPT ?? 0;
    if (!s.enabled || !hasContent) {
      setExtensionPrompt(MODULE_KEY + '_rules', '', pt, 0);
      setExtensionPrompt(MODULE_KEY + '_timeline', '', pt, 0);
      setExtensionPrompt(MODULE_KEY + '_deadlines', '', pt, 0);
      // Clear legacy single key if it exists
      setExtensionPrompt(MODULE_KEY, '', pt, 0);
      _promptActive = false;
    } else {
      const rulesText    = buildRulesPromptText();
      const timelineText = buildTimelinePromptText();
      const deadlineText = buildDeadlinesPromptText();
      setExtensionPrompt(MODULE_KEY + '_rules',     rulesText,    pt, s.depthRules    || 0);
      setExtensionPrompt(MODULE_KEY + '_timeline',  timelineText, pt, s.depthTimeline  || 4);
      setExtensionPrompt(MODULE_KEY + '_deadlines', deadlineText, pt, s.depthDeadlines || 1);
      setExtensionPrompt(MODULE_KEY, '', pt, 0); // clear legacy
      _promptActive = !!(rulesText || timelineText || deadlineText);
    }
    _updatePromptUI();
  }

  function _updatePromptUI() {
    const color = _promptActive ? '#34d399' : '#4a5568';
    const title = _promptActive ? 'Промпт активен' : 'Промпт не активен';
    $('#calt_prompt_dot').css('color', color).attr('title', title);
    updateTokenCounter();
  }

  // Token estimation: ~4 chars/token for Latin, ~2 chars/token for Cyrillic
  function estimateTokens(text) {
    if (!text) return 0;
    const cyrCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
    const total = text.length;
    const latCount = total - cyrCount;
    return Math.ceil(latCount / 4 + cyrCount / 2);
  }

  function updateTokenCounter() {
    if (_promptActive) {
      const rT = estimateTokens(buildRulesPromptText());
      const tT = estimateTokens(buildTimelinePromptText());
      const dT = estimateTokens(buildDeadlinesPromptText());
      const total = rT + tT + dT;
      $('#calt_modal_tokens').html(
        '<span style="color:#a78bfa">📜' + rT + '</span> · ' +
        '<span style="color:#fbbf24">⚔' + tT + '</span> · ' +
        '<span style="color:#60a5fa">⏳' + dT + '</span> · ' +
        'Σ' + total
      ).css('color','#34d399');
    } else {
      $('#calt_modal_tokens').text('○ выкл').css('color','#4a5568');
    }
  }

  // ─── AI ───────────────────────────────────────────────────────────────────
  function extractAiText(data) {
    if (data?.choices?.[0]?.message?.content !== undefined) return data.choices[0].message.content;
    if (data?.choices?.[0]?.text             !== undefined) return data.choices[0].text;
    if (typeof data?.response === 'string')  return data.response;
    if (Array.isArray(data?.content)) { const t = data.content.find(b => b.type==='text'); return t?.text ?? null; }
    if (typeof data?.content === 'string') return data.content;
    // Gemini format
    if (data?.candidates?.[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text;
    return null;
  }

  // Normalize endpoint: strip trailing slashes and /chat/completions
  function _normalizeEndpoint(url) {
    if (!url) return '';
    url = url.trim().replace(/\/+$/, '');
    url = url.replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
    return url;
  }

  // Detect API type from endpoint URL
  function _apiType(ep) {
    if (!ep) return 'openai';
    // Gemini with /openai/ path = OpenAI-compatible mode (Bearer auth)
    if (ep.includes('generativelanguage.googleapis.com') && ep.includes('/openai')) return 'openai';
    // Bare Gemini URL without /openai/ = native Gemini format (key in URL)
    if (ep.includes('generativelanguage.googleapis.com')) return 'gemini-native';
    // Everything else = OpenAI-compatible
    return 'openai';
  }

  async function _callCustomApi(systemPrompt, userPrompt) {
    const s = getSettings();
    const ep = _normalizeEndpoint(s.customApiEndpoint);
    if (!ep || !s.customApiKey) return null;
    const headers = { 'Content-Type': 'application/json' };
    const type = _apiType(ep);

    if (type === 'gemini-native') {
      // Native Gemini REST API: key in URL, specific body format
      const model = s.customApiModel || 'models/gemini-flash-lite-latest';
      const modelPath = model.startsWith('models/') ? model : 'models/' + model;
      const gemUrl = ep + '/' + modelPath + ':generateContent?key=' + s.customApiKey;
      const body = {
        contents: [{ parts: [{ text: systemPrompt + '\n\n---\n\n' + userPrompt }] }],
        generationConfig: { maxOutputTokens: 2000 }
      };
      const r = await fetch(gemUrl, { method:'POST', headers, body:JSON.stringify(body) });
      if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + (await r.text()).slice(0,200));
      return extractAiText(await r.json());
    } else {
      // OpenAI-compatible (works for OpenAI, Gemini /openai/, OpenRouter, etc.)
      headers['Authorization'] = 'Bearer ' + s.customApiKey;
      const model = s.customApiModel || 'gpt-3.5-turbo';
      // For Gemini OpenAI-compatible, model should be just the name without models/ prefix
      const modelName = model.replace(/^models\//, '');
      const body = {
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2000,
        stream: false,
      };
      const chatUrl = ep + '/chat/completions';
      const r = await fetch(chatUrl, { method:'POST', headers, body:JSON.stringify(body) });
      if (!r.ok) throw new Error('API ' + r.status + ': ' + (await r.text()).slice(0,200));
      return extractAiText(await r.json());
    }
  }

  async function _fetchModels() {
    const s = getSettings();
    const ep = _normalizeEndpoint(s.customApiEndpoint);
    if (!ep || !s.customApiKey) throw new Error('Введите endpoint и API key');
    const type = _apiType(ep);

    if (type === 'gemini-native') {
      // Native Gemini: models endpoint with key in URL
      const r = await fetch(ep + '/models?key=' + s.customApiKey);
      if (!r.ok) throw new Error('Gemini ' + r.status);
      const data = await r.json();
      return (data.models || []).map(m => m.name || m.id).filter(Boolean);
    } else {
      // OpenAI-compatible: /models with Bearer auth
      const r = await fetch(ep + '/models', {
        headers: { 'Authorization': 'Bearer ' + s.customApiKey }
      });
      if (!r.ok) throw new Error('API ' + r.status);
      const data = await r.json();
      return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
    }
  }

  async function aiGenerate(userPrompt, systemPrompt) {
    // Try custom API first if configured
    const s = getSettings();
    if (s.customApiEndpoint && s.customApiKey) {
      try {
        const r = await _callCustomApi(systemPrompt, userPrompt);
        if (r?.trim()) return r;
      } catch(e) { console.warn('[CalTracker] custom API failed:', e.message); }
    }
    // Fallback: ST built-in
    const c = ctx(), full = systemPrompt + '\n\n---\n\n' + userPrompt;
    if (typeof c.generateRaw === 'function') {
      try { const r = await c.generateRaw(full,'',false,false,'','normal'); if (r?.trim()) return r; }
      catch(e) { console.warn('[CalTracker] generateRaw failed:', e.message); }
    }
    for (const ep of [
      { url:'/api/backends/chat-completions/generate',
        body:()=>({messages:[{role:'system',content:systemPrompt},{role:'user',content:userPrompt}],stream:false}) },
      { url:'/api/generate',  body:()=>({prompt:full,max_new_tokens:1500,stream:false}) },
      { url:'/generate',      body:()=>({prompt:full,max_new_tokens:1500,stream:false}) },
    ]) {
      try {
        const r = await fetch(ep.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ep.body())});
        if (!r.ok) continue;
        const t = extractAiText(await r.json());
        if (t?.trim()) return t;
      } catch(e) { /* try next endpoint */ }
    }
    throw new Error('Нет подключения. Настройте API или Connection Profile.');
  }

  function getChatContext(depth) {
    return (ctx().chat||[]).slice(-depth)
      .map(m => '[' + (m.is_user?'USER':'CHAR') + ']: ' + (m.mes||'').slice(0,600))
      .join('\n\n');
  }

  function getLorebook() {
    try {
      const wi = ctx().worldInfoData || ctx().worldInfo || {};
      const entries = [];
      Object.values(wi).forEach(book => {
        const src = book?.entries || book;
        if (src && typeof src==='object') Object.values(src).forEach(e=>{ if(e?.content) entries.push(String(e.content)); });
      });
      return entries.join('\n\n');
    } catch(e) { return ''; }
  }

  // ─── Scan ─────────────────────────────────────────────────────────────────
  function parseEventList(text, startId) {
    const events = [], id = { v: startId || Date.now() };
    (text||'').split('\n').map(l=>l.trim()).filter(Boolean).forEach(line => {
      if (/^(EXISTING|ALREADY|KEY EVENTS|UPCOMING|OUTPUT|FORMAT|RULES|STRICT|NOTE|PAST|CURRENT)/i.test(line)) return;
      const clean = line.replace(/^[-•*\d.]\s*/, '');
      const m = clean.match(/^\[([^\]]+)\]\s+(.+)$/);
      if (m) events.push({ id:id.v++, date:m[1].trim(), text:m[2].trim(), pinned:false, tags:[] });
      else if (clean.length > 4 && !clean.startsWith('#') && !clean.startsWith('['))
        events.push({ id:id.v++, date:'', text:clean, pinned:false, tags:[] });
    });
    return events;
  }

  // Restore pinned + tags from old events by matching text (with date as tiebreaker)
  // Also uses word-overlap similarity to catch AI rephrases
  function _wordSet(text) {
    return new Set((text||'').toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w => w.length > 2));
  }
  function _similarity(a, b) {
    const sa = _wordSet(a), sb = _wordSet(b);
    if (!sa.size || !sb.size) return 0;
    let overlap = 0;
    sa.forEach(w => { if (sb.has(w)) overlap++; });
    return overlap / Math.max(sa.size, sb.size);
  }

  function _restoreMetadata(parsed, oldEvents) {
    // Index old events for fast lookup
    const byDateText = {}, byText = {};
    // Group all old events by exact date string (for union-merge)
    const byDate = {};
    oldEvents.forEach(e => {
      const dtKey = ((e.date||'') + '||' + e.text).toLowerCase();
      byDateText[dtKey] = e;
      const tk = e.text.toLowerCase().trim();
      if (!byText[tk]) byText[tk] = e;
      const dk = (e.date||'').toLowerCase().trim();
      if (dk) { if (!byDate[dk]) byDate[dk] = []; byDate[dk].push(e); }
    });

    // Track which old events have been claimed (prevent double-matching)
    const claimed = new Set();

    parsed.forEach(e => {
      const dtKey = ((e.date||'') + '||' + e.text).toLowerCase();
      const tKey  = e.text.toLowerCase().trim();
      const dk    = (e.date||'').toLowerCase().trim();

      // 1. Exact date+text match
      let exactOld = byDateText[dtKey] || byText[tKey];

      if (exactOld && !claimed.has(exactOld.id)) {
        e.pinned = exactOld.pinned || false;
        e.tags   = [...(exactOld.tags || [])];
        e.id     = exactOld.id;
        claimed.add(exactOld.id);
        return;
      }

      // 2. Condensed entry covering same date: union pinned+tags from ALL originals of that date
      //    (handles "event1 → event2 → event3" merged lines)
      const sameDateOriginals = dk ? (byDate[dk] || []).filter(oe => !claimed.has(oe.id)) : [];
      if (sameDateOriginals.length) {
        // Check if the condensed text overlaps significantly with ANY original on that date
        const anyMatch = sameDateOriginals.some(oe => _similarity(e.text, oe.text) >= 0.25);
        // Also match if the condensed text CONTAINS fragments of originals (→ separator style)
        const fragMatch = sameDateOriginals.some(oe => {
          const words = (oe.text||'').toLowerCase().split(/\s+/).filter(w => w.length > 3);
          return words.length && words.filter(w => e.text.toLowerCase().includes(w)).length >= Math.ceil(words.length * 0.4);
        });
        if (anyMatch || fragMatch || sameDateOriginals.length > 0) {
          // Union: pick pinned=true if ANY original was pinned; merge all tags
          e.pinned = sameDateOriginals.some(oe => oe.pinned);
          const tagSet = new Set();
          sameDateOriginals.forEach(oe => (oe.tags||[]).forEach(t => tagSet.add(t)));
          e.tags = [...tagSet];
          // Use the ID of the first original so the entry stays "stable"
          e.id = sameDateOriginals[0].id;
          sameDateOriginals.forEach(oe => claimed.add(oe.id));
          return;
        }
      }

      // 3. Fuzzy match: same month, similarity ≥ 0.45
      {
        let bestSim = 0, bestMatch = null;
        oldEvents.forEach(oe => {
          if (claimed.has(oe.id)) return;
          if (extractMonth(e.date) !== extractMonth(oe.date)) return;
          const sim = _similarity(e.text, oe.text);
          if (sim > bestSim && sim >= 0.45) { bestSim = sim; bestMatch = oe; }
        });
        if (bestMatch) {
          e.pinned = bestMatch.pinned || false;
          e.tags   = [...(bestMatch.tags || [])];
          e.id     = bestMatch.id;
          claimed.add(bestMatch.id);
        }
      }
    });
  }

  async function scanKeyEvents(depth) {
    const s = getSettings();
    const existing = s.keyEvents.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
    const lore = getLorebook();
    const currentDateInfo = s.currentDate ? 'CURRENT IN-WORLD DATE: ' + s.currentDate + '\n\n' : '';
    const result = await aiGenerate(
      currentDateInfo +
        'CHAT:\n' + (getChatContext(depth)||'(empty)') +
        (lore ? '\n\nLOREBOOK:\n' + lore.slice(0,3000) : '') +
        '\n\nOutput ONLY NEW events not in EXISTING:',
      'You are a chronicle archivist. Read the chat and output ONLY NEW plot-critical events.\n\n' +
        'CRITICAL: Output ONLY events that are NOT already in the EXISTING list below.\n' +
        'If everything is already covered, output NOTHING (empty response).\n\n' +
        'FORMAT RULES:\n' +
        '- ONE LINE PER DAY: [DATE] event1 → event2 → event3\n' +
        '- Merge all events of the same day with → separator\n' +
        '- If multiple days are uneventful, merge: [Days 5-8] quiet period\n' +
        '- MAX 20 words per line. Telegraphic: nouns and verbs only\n' +
        '- ONLY facts: arrivals, departures, fights, pacts, injuries, deaths, discoveries\n' +
        '- NEVER: emotions, descriptions, atmosphere, dialogue\n\n' +
        'GOOD: [3 Ossian] Great Hall → verbal attack on Daron student → etheric burns → infirmary\n' +
        'BAD: [3 Ossian] Selena felt nervous ← emotion, not a fact\n\n' +
        (existing ? 'EXISTING (already recorded — do NOT repeat any of these):\n' + existing : 'No existing events.')
    );
    // Parse only the new events AI returned
    let newEvents = parseEventList(result, s.nextEventId);
    if (!newEvents.length) return s.keyEvents; // nothing new — return unchanged
    // Filter out anything that's too similar to existing
    newEvents = newEvents.filter(ne => {
      for (const oe of s.keyEvents) {
        if (_similarity(ne.text, oe.text) >= 0.45) return false;
        // Same date + high overlap = duplicate
        if (ne.date && ne.date === oe.date && _similarity(ne.text, oe.text) >= 0.3) return false;
      }
      return true;
    });
    if (!newEvents.length) return s.keyEvents; // all filtered as dupes
    // Merge same-date new events
    newEvents = _mergeSameDate(newEvents);
    // Also try to merge new events into existing same-date entries
    const merged = [...s.keyEvents];
    newEvents.forEach(ne => {
      const existingIdx = merged.findIndex(oe => 
        ne.date && oe.date && ne.date.toLowerCase() === oe.date.toLowerCase()
      );
      if (existingIdx >= 0) {
        // Append to existing same-date entry
        merged[existingIdx].text += ' → ' + ne.text;
      } else {
        // New date — add as separate entry
        ne.id = s.nextEventId++;
        merged.push(ne);
      }
    });
    return merged;
  }

  // Merge parsed events that share the same date into one line
  function _mergeSameDate(events) {
    const byDate = new Map();
    const order = [];
    events.forEach(e => {
      const key = (e.date || '').toLowerCase().trim();
      if (!key) { order.push(e); return; } // dateless events stay separate
      if (byDate.has(key)) {
        byDate.get(key).text += ' → ' + e.text;
        // Inherit tags and pinned from merged
        if (e.pinned) byDate.get(key).pinned = true;
        (e.tags||[]).forEach(t => {
          if (!byDate.get(key).tags.includes(t)) byDate.get(key).tags.push(t);
        });
      } else {
        byDate.set(key, e);
        order.push(e);
      }
    });
    return order;
  }

  // ─── Per-month AI condensation with date picker ───────────────────────────
  function openCondenseDatePicker(month, $btn) {
    const s = getSettings();
    const monthEvents = s.keyEvents.filter(e => extractMonth(e.date) === month);
    if (monthEvents.length < 2) {
      toast('Нужно минимум 2 записи для конденсации', '#f59e0b'); return;
    }

    // Build unique dates list (preserving day-sort order)
    const dateGroups = new Map(); // date → [events]
    monthEvents.forEach(e => {
      const dk = (e.date || '').trim();
      if (!dateGroups.has(dk)) dateGroups.set(dk, []);
      dateGroups.get(dk).push(e);
    });
    // Sort dates by start-day numerically
    const sortedDates = [...dateGroups.keys()].sort((a, b) => {
      const pa = parseDateString(a), pb = parseDateString(b);
      return (parseInt(pa.day, 10) || 0) - (parseInt(pb.day, 10) || 0);
    });

    const dateRows = sortedDates.map((dk, i) => {
      const evs = dateGroups.get(dk);
      const preview = evs.map(e => e.text).join(' → ');
      const short = preview.length > 80 ? preview.slice(0, 77) + '…' : preview;
      return '<label class="calt-condpick-row">'
        + '<input type="checkbox" class="calt-condpick-chk" data-date="' + esc(dk) + '" checked>'
        + '<div class="calt-condpick-info">'
        + '<span class="calt-condpick-date">' + esc(dk || '—') + '</span>'
        + '<span class="calt-condpick-preview">' + esc(short) + '</span>'
        + '</div>'
        + '</label>';
    }).join('');

    _openOverlay(
      '<div class="calt-edit-overlay calt-eopen"><div class="calt-edit-box calt-condpick-box">'
      + '<div class="calt-edit-hdr">'
      + '<span>⚡ Конденсация — ' + esc(month) + '</span>'
      + '<button class="calt-edit-x" id="calt_cpick_x">✕</button>'
      + '</div>'
      + '<div class="calt-edit-body">'
      + '<div class="calt-elabel" style="margin-bottom:8px">Выберите даты для конденсации. Снятые — останутся без изменений.</div>'
      + '<div class="calt-condpick-actions">'
      + '<button class="calt-condpick-selall" id="calt_cpick_all">✓ Все</button>'
      + '<button class="calt-condpick-selall" id="calt_cpick_none">✗ Сбросить</button>'
      + '</div>'
      + '<div class="calt-condpick-list">' + dateRows + '</div>'
      + '</div>'
      + '<div class="calt-edit-footer">'
      + '<button class="menu_button" id="calt_cpick_cancel">Отмена</button>'
      + '<button class="menu_button calt-save-btn" id="calt_cpick_run">⚡ Конденсировать</button>'
      + '</div>'
      + '</div></div>'
    );

    $('#calt_cpick_x,#calt_cpick_cancel').on('click', () => { _closeOverlay(); $btn.prop('disabled',false).text('⚡'); });
    $('#calt_cpick_all').on('click',  () => $('.calt-condpick-chk').prop('checked', true));
    $('#calt_cpick_none').on('click', () => $('.calt-condpick-chk').prop('checked', false));

    $('#calt_cpick_run').on('click', async () => {
      const selectedDates = new Set(
        $('.calt-condpick-chk:checked').toArray().map(el => $(el).data('date'))
      );
      if (!selectedDates.size) { toast('Выберите хотя бы одну дату', '#f59e0b'); return; }

      const toCondense  = monthEvents.filter(e => selectedDates.has((e.date||'').trim()));
      const toKeep      = monthEvents.filter(e => !selectedDates.has((e.date||'').trim()));

      if (toCondense.length < 2) { toast('Нужно минимум 2 события для конденсации', '#f59e0b'); return; }

      _closeOverlay();
      $btn.prop('disabled', true).text('…');
      await condenseSelectedEvents(month, toCondense, toKeep, $btn);
    });
  }

  async function condenseSelectedEvents(month, toCondense, toKeep, $btn) {
    const s = getSettings();
    const snap = JSON.stringify(s.keyEvents);
    try {
      const input = toCondense.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
      const condensed = await aiGenerate(
        'TIMELINE (' + toCondense.length + ' entries from ' + month + '):\n' + input + '\n\nCondense this timeline:',
        'You condense a roleplay timeline into fewer entries.\n\n' +
          'RULES:\n' +
          '- MERGE events on the same date into ONE line using → separator\n' +
          '- MERGE consecutive quiet periods: "[Days 5-8 ' + month + '] quiet period"\n' +
          '- KEEP all plot-critical facts: deaths, pacts, injuries, arrivals, departures\n' +
          '- DROP trivial details: casual dialogue, minor movements\n' +
          '- MAX 20 words per line. Telegraphic style.\n' +
          '- Output ONLY the condensed lines, one [DATE] per entry.\n' +
          '- ALL dates must include the month name "' + month + '".\n\n' +
          'EXAMPLE INPUT:\n' +
          '[3 ' + month + '] Goes to hall\n[3 ' + month + '] Burns on hands\n\n' +
          'EXAMPLE OUTPUT:\n' +
          '[3 ' + month + '] Goes to hall → burns on hands'
      );
      let parsed = parseEventList(condensed, s.nextEventId);
      parsed = _mergeSameDate(parsed);
      if (!parsed.length || parsed.length >= toCondense.length) {
        toast('Конденсация не дала результата', '#f59e0b');
        $btn.prop('disabled', false).text('⚡'); return;
      }
      _restoreMetadata(parsed, toCondense);
      parsed.forEach(e => { if (!e.id) e.id = s.nextEventId++; });

      const oldTotal = s.keyEvents.length;
      // Rebuild: other months + kept dates in this month + condensed
      s.keyEvents = [
        ...s.keyEvents.filter(e => extractMonth(e.date) !== month),
        ...toKeep,
        ...parsed,
      ];
      s.nextEventId = Math.max(0, ...s.keyEvents.map(e => e.id||0)) + 1;
      saveSummarySnap(month);
      save(); updatePrompt(); updateMeta(); renderTabContent();

      const newTotal = s.keyEvents.length;
      toast('⚡ ' + month + ': ' + oldTotal + ' → ' + newTotal, '#a78bfa', () => {
        s.keyEvents = JSON.parse(snap);
        s.nextEventId = Math.max(0, ...s.keyEvents.map(e => e.id||0)) + 1;
        save(); updatePrompt(); updateMeta(); renderTabContent();
      });
    } catch(err) {
      toast('Ошибка конденсации: ' + err.message, '#f87171');
    } finally {
      $btn.prop('disabled', false).text('⚡');
    }
  }

  async function scanDeadlines(depth) {
    const s = getSettings();
    const existing = s.deadlines.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
    const past     = s.keyEvents.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
    const lore = getLorebook();

    // Build rich date context so AI can calculate dates
    let dateContext = '';
    if (s.currentDate) {
      dateContext = 'CURRENT IN-WORLD DATE: ' + s.currentDate + '\n';
      const cc = s.calendarConfig;
      if (cc.months.length) {
        const mi = cc.months.findIndex(m => m.name.toLowerCase() === (s.currentMonthName||'').toLowerCase());
        if (mi >= 0) {
          const curMonth = cc.months[mi];
          const nextMonth = cc.months[(mi + 1) % cc.months.length];
          dateContext += 'Current month ' + curMonth.name + ' has ' + (curMonth.days||30) + ' days. ';
          dateContext += 'Next month: ' + nextMonth.name + '.\n';
          dateContext += 'CALCULATE specific dates from time phrases: "in 3 days" = add 3 to current day.\n';
        }
      }
      dateContext += '\n';
    }

    const result = await aiGenerate(
      dateContext +
        'CHAT:\n' + (getChatContext(depth)||'(empty)') +
        (lore ? '\n\nLOREBOOK:\n' + lore.slice(0,3000) : '') +
        '\n\nExtract CONCRETE upcoming events with specific dates:',
      'You scan roleplay chat for CONCRETE UPCOMING EVENTS with TIME PRESSURE.\n\n' +
        'YOUR JOB: Find where characters mention future arrivals, deadlines, scheduled events,\n' +
        'approaching dangers WITH a time reference. CALCULATE the specific in-world date.\n\n' +
        'RULES:\n' +
        '- Output ONLY items NOT in EXISTING list. If nothing new, output NOTHING.\n' +
        '- ALWAYS calculate a specific date when time is mentioned:\n' +
        '  "in 3 days" + current date 14 Naeris \u2192 [17 Naeris]\n' +
        '  "next week" + current date 14 Naeris \u2192 [~21 Naeris]\n' +
        '  "before month end" + month has 30 days \u2192 [30 Naeris]\n' +
        '- Use [ongoing] ONLY for active persistent dangers with NO time reference at all\n' +
        '- Format: [DATE] Who/what arrives/happens/threatens (MAX 15 words)\n\n' +
        'EXTRACT THESE:\n' +
        '\u2713 Arrivals: "House X arrives in 3 days" \u2192 [17 Naeris] House X delegation arrives; potential conflict\n' +
        '\u2713 Deadlines: "ritual must complete by full moon" \u2192 [DATE] Ritual deadline at full moon\n' +
        '\u2713 Threats: "inquisitor returns before month end" \u2192 [~30 Naeris] Inquisitor returns for inspection\n' +
        '\u2713 Ongoing: [ongoing] Active investigation by Inquisitor; discovery = exposure\n\n' +
        'REJECT THESE (NOT deadlines):\n' +
        '\u2717 Character traits or secrets: "Gasil\'s secret" \u2190 not an event, no date\n' +
        '\u2717 Prophecies without timeline: "Selena is chosen" \u2190 not actionable\n' +
        '\u2717 Vague states: "danger exists", "anomaly detected" \u2190 no specifics\n' +
        '\u2717 Past events: anything that already happened\n' +
        '\u2717 Entries shorter than 10 words\n\n' +
        'LITMUS TEST: Does this answer "WHAT happens WHEN and WHY is it dangerous?" If not \u2192 reject.\n\n' +
        (existing ? 'EXISTING (do NOT repeat):\n' + existing + '\n\n' : '') +
        (past ? 'PAST EVENTS (EXCLUDE):\n' + past : '')
    );
    let newDls = parseEventList(result, s.nextDeadlineId);
    // Filter: reject short garbage entries
    newDls = newDls.filter(e => e.text.length >= 15);
    // Truncate oversized
    newDls.forEach(e => {
      if (e.text.length > 100) {
        const dot = e.text.indexOf('. ');
        if (dot > 0 && dot < 90) e.text = e.text.slice(0, dot + 1);
        else e.text = e.text.slice(0, 97) + '...';
      }
    });
    // Filter out duplicates of existing deadlines
    newDls = newDls.filter(ne => {
      for (const oe of s.deadlines) {
        if (_similarity(ne.text, oe.text) >= 0.45) return false;
      }
      // Also filter out past events
      for (const oe of s.keyEvents) {
        if (_similarity(ne.text, oe.text) >= 0.5) return false;
      }
      return true;
    });
    if (!newDls.length) return s.deadlines; // nothing new
    // Assign IDs and add defaults
    newDls.forEach(e => {
      e.id = s.nextDeadlineId++;
      e.pinned = false;
      e.title = '';
      e.dtype = 'event';
    });
    return [...s.deadlines, ...newDls];
  }

  // Restore deadline metadata (pinned, title, dtype) after rescan
  function _restoreDeadlineMetadata(parsed, oldDeadlines) {
    const byDateText = {}, byText = {};
    oldDeadlines.forEach(e => {
      const dtKey = ((e.date||'') + '||' + e.text).toLowerCase();
      byDateText[dtKey] = e;
      const tk = e.text.toLowerCase().trim();
      if (!byText[tk]) byText[tk] = e;
    });
    const claimed = new Set();
    parsed.forEach(e => {
      const dtKey = ((e.date||'') + '||' + e.text).toLowerCase();
      const tKey  = e.text.toLowerCase().trim();
      let old = byDateText[dtKey] || byText[tKey];
      if (!old) {
        let bestSim = 0, bestMatch = null;
        oldDeadlines.forEach(oe => {
          if (claimed.has(oe.id)) return;
          const sim = _similarity(e.text, oe.text);
          if (sim > bestSim && sim >= 0.5) { bestSim = sim; bestMatch = oe; }
        });
        if (bestMatch) old = bestMatch;
      }
      if (old) {
        e.pinned = old.pinned || false;
        e.title  = old.title || '';
        e.dtype  = old.dtype || 'event';
        e.id     = old.id;
        claimed.add(old.id);
      }
    });
  }

  async function generateMonthSummary(month) {
    const s = getSettings();
    const evs = s.keyEvents
      .filter(e => extractMonth(e.date) === month)
      .sort((a, b) => {
        const pa = parseDateString(a.date), pb = parseDateString(b.date);
        const aa = dateToAbsDay(pa.day, pa.month, pa.year);
        const ab = dateToAbsDay(pb.day, pb.month, pb.year);
        if (aa !== null && ab !== null) return aa - ab;
        return 0;
      })
      .map(e => (e.date ? '[' + e.date + '] ' : '') + e.text)
      .join('\n');
    if (!evs) throw new Error('Нет событий для ' + month);
    return await aiGenerate(
      'Events of ' + month + ':\n' + evs + '\n\nWrite a 1-2 sentence summary:',
      'Write a 1-2 sentence summary of the most plot-consequential events. Extremely concise, past tense, no headers, no lists.'
    );
  }

  async function isMessageSignificant(msg) {
    if (!msg || msg.trim().length < 20) return false;
    try {
      const r = await aiGenerate(
        'Message: ' + msg.slice(0,600) + '\n\nPlot-significant? (YES/NO)',
        'Reply ONLY "YES" or "NO". Permanent change/conflict/pact/revelation = YES. Casual dialogue = NO.'
      );
      return r.trim().toUpperCase().startsWith('Y');
    } catch(e) { return true; }
  }

  // ─── Overlay helpers (lock body scroll on mobile while open) ────────────
  function _openOverlay(html) {
    _closeOverlay();
    $('body').append(html);
    // Lock scroll: on mobile the page scrolls underneath fixed overlays without this
    $('body').addClass('calt-body-locked');
  }

  function _closeOverlay() {
    $('.calt-edit-overlay').remove();
    $('body').removeClass('calt-body-locked');
  }

  // ─── Toast ────────────────────────────────────────────────────────────────
  let _toastTimer = null;
  function toast(msg, color, undoFn, duration) {
    color    = color    || '#34d399';
    duration = duration || 4500;
    clearTimeout(_toastTimer); $('.calt-toast').remove();
    const undoHtml = undoFn ? '<button class="calt-toast-undo">↩ Отменить</button>' : '';
    $('body').append(
      '<div class="calt-toast"><div class="calt-toast-row">' +
        '<span class="calt-toast-dot" style="background:' + color + '"></span>' +
        '<span class="calt-toast-msg">' + esc(msg) + '</span>' + undoHtml +
      '</div></div>'
    );
    setTimeout(() => $('.calt-toast').addClass('calt-in'), 10);
    if (undoFn) $('.calt-toast-undo').on('click', () => { undoFn(); $('.calt-toast').remove(); });
    _toastTimer = setTimeout(() => {
      $('.calt-toast').addClass('calt-out');
      setTimeout(() => $('.calt-toast').remove(), 300);
    }, duration);
  }

  // ─── Settings panel ───────────────────────────────────────────────────────
  function getActiveProfileName() {
    try {
      const c = ctx();
      return c.connectionManager?.selectedProfile?.name ||
             c.currentConnectionProfile?.name ||
             c.mainApi || null;
    } catch(e) { return null; }
  }

  function mountSettingsUi() {
    if ($('#calt_block').length) return;
    const $ext = $('#extensions_settings2,#extensions_settings').first();
    if (!$ext.length) return;

    $ext.append(`
      <div class="calt-block" id="calt_block">
        <div class="calt-hdr" id="calt_hdr">
          <span class="calt-gem">🗓</span>
          <span class="calt-title">Calendar Tracker</span>
          <span class="calt-badge" id="calt_badge" style="display:none">0</span>
          <span class="calt-prompt-dot" id="calt_prompt_dot" title="Промпт не активен" style="color:#4a5568;font-size:10px;margin-left:4px">●</span>
          <span class="calt-chev" id="calt_chev">▾</span>
        </div>
        <div class="calt-body" id="calt_body">
          <div class="calt-meta" id="calt_meta">нет данных</div>
          <label class="calt-check-row"><input type="checkbox" id="calt_enabled" style="accent-color:#fbbf24"><span>Включено (инжект в промпт)</span></label>
          <label class="calt-check-row"><input type="checkbox" id="calt_autoscan" style="accent-color:#fbbf24"><span>Авто-сканирование</span></label>
          <div class="calt-field-row" style="margin-top:2px">
            <span class="calt-flabel">Каждые</span>
            <input type="number" class="calt-depth-inp" id="calt_autoscan_threshold" min="1" max="50" style="width:42px" value="3">
            <span style="font-size:10px;color:#3d4a60">сообщений</span>
          </div>
          <div class="calt-field-label">Текущая дата</div>
          <div class="calt-date3-row" id="calt_date3_panel"></div>
          <div class="calt-field-label">Глубина инжекции</div>
          <div class="calt-field-row" style="margin-top:3px">
            <span class="calt-flabel">📜 Правила</span>
            <input type="range" id="calt_depth_rules" min="0" max="15" step="1" style="flex:1;accent-color:#a78bfa;min-width:0">
            <span id="calt_depth_rules_val" style="font-size:12px;color:#a78bfa;min-width:18px;text-align:right">0</span>
          </div>
          <div class="calt-field-row" style="margin-top:3px">
            <span class="calt-flabel">⏳ Дедлайны</span>
            <input type="range" id="calt_depth_deadlines" min="0" max="15" step="1" style="flex:1;accent-color:#60a5fa;min-width:0">
            <span id="calt_depth_deadlines_val" style="font-size:12px;color:#60a5fa;min-width:18px;text-align:right">1</span>
          </div>
          <div class="calt-field-row" style="margin-top:3px">
            <span class="calt-flabel">⚔ Таймлайн</span>
            <input type="range" id="calt_depth_timeline" min="0" max="15" step="1" style="flex:1;accent-color:#fbbf24;min-width:0">
            <span id="calt_depth_timeline_val" style="font-size:12px;color:#fbbf24;min-width:18px;text-align:right">4</span>
          </div>
          <div style="font-size:10px;color:#3d4a60;margin-top:1px">0 = конец промпта · 5 = за 5 сообщениями</div>
          <div style="border-top:1px solid rgba(255,255,255,0.05);margin-top:6px;padding-top:6px">
            <div class="calt-field-row">
              <span class="calt-flabel">⏳ Горизонт дедлайна</span>
              <input type="number" class="calt-depth-inp" id="calt_dl_horizon" min="1" max="365" style="width:52px" value="7">
              <span style="font-size:10px;color:#3d4a60">дней</span>
            </div>
            <div style="font-size:10px;color:#3d4a60;margin-top:1px">Дедлайны дальше этого срока скрыты из контекста</div>
          </div>
          <button class="menu_button calt-open-btn" id="calt_open_btn">📖 Открыть календарь</button>
          <div class="calt-sec" id="calt_conn_wrap">
            <div class="calt-sec-hdr" id="calt_conn_hdr"><span class="calt-sec-chev" id="calt_conn_chev">▸</span><span>⚙ API для сканирования</span></div>
            <div class="calt-sec-body" id="calt_conn_body" style="display:none">
              <p class="calt-conn-hint">Вставь endpoint (с /v1 или без — не важно), введи ключ, загрузи список моделей кнопкой 📋 и нажми «Сканировать». Если оставить пустым — используется встроенный ST.</p>
              <div class="calt-field-label">ENDPOINT</div>
              <input class="calt-einput" id="calt_api_endpoint" placeholder="https://generativelanguage.googleapis.com/v1beta/openai/" style="width:100%;box-sizing:border-box;margin-bottom:4px">
              <div class="calt-field-label">API KEY</div>
              <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
                <input class="calt-einput" id="calt_api_key" type="password" placeholder="••••••••••••" style="flex:1;min-width:0">
                <button class="calt-ev-btn" id="calt_api_key_toggle" title="Показать/скрыть" style="width:30px;height:30px">👁</button>
              </div>
              <div class="calt-field-label">МОДЕЛЬ</div>
              <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px">
                <input class="calt-einput" id="calt_api_model" placeholder="models/gemini-flash-lite-latest" style="flex:1;min-width:0">
                <button class="calt-ev-btn" id="calt_api_fetch_models" title="Загрузить модели" style="width:30px;height:30px">📋</button>
              </div>
              <div class="calt-api-status" id="calt_api_models_status" style="font-size:10px;min-height:14px;margin-bottom:4px"></div>
              <button class="menu_button calt-test-btn" id="calt_test_btn">⚡ Тест</button>
              <div class="calt-api-status" id="calt_test_status"></div>
            </div>
          </div>
        </div>
      </div>`);

    refreshSettingsUi();

    $('#calt_hdr').on('click', () => {
      const $b = $('#calt_body'); $b.slideToggle(180);
      $('#calt_chev').text($b.is(':visible') ? '▾' : '▸');
    });
    $('#calt_conn_hdr').on('click', () => {
      const $b = $('#calt_conn_body'); $b.slideToggle(150);
      $('#calt_conn_chev').text($b.is(':visible') ? '▾' : '▸');
    });
    $('#calt_enabled').on('change', function() { getSettings().enabled = this.checked; save(); updatePrompt(); });
    $('#calt_autoscan').on('change', function() { getSettings().autoScan = this.checked; save(); });
    $('#calt_autoscan_threshold').on('change', function() {
      const v = Math.max(1, +this.value || 3);
      this.value = v; getSettings().autoScanThreshold = v; save();
    });
    // Custom API fields
    const _saveApi = () => {
      const s = getSettings();
      s.customApiEndpoint = $('#calt_api_endpoint').val().trim();
      s.customApiKey = $('#calt_api_key').val().trim();
      s.customApiModel = $('#calt_api_model').val().trim();
      save();
    };
    $('#calt_api_endpoint,#calt_api_key,#calt_api_model').on('change', _saveApi);
    $('#calt_api_key_toggle').on('click', () => {
      const $k = $('#calt_api_key');
      $k.attr('type', $k.attr('type') === 'password' ? 'text' : 'password');
    });
    $('#calt_api_fetch_models').on('click', async () => {
      _saveApi();
      const $st = $('#calt_api_models_status');
      $st.css('color','#7a8499').text('Загружаю модели…');
      try {
        const models = await _fetchModels();
        if (!models.length) { $st.css('color','#f59e0b').text('Моделей не найдено'); return; }
        // Show as select replacing the input
        const $inp = $('#calt_api_model');
        const curVal = $inp.val().trim();
        const sel = $('<select class="calt-einput" id="calt_api_model" style="flex:1;min-width:0">' +
          models.map(m => '<option value="' + esc(m) + '"' + (m === curVal ? ' selected' : '') + '>' + esc(m) + '</option>').join('') +
          '</select>');
        $inp.replaceWith(sel);
        sel.on('change', _saveApi);
        if (!curVal && models.length) { sel.val(models[0]); _saveApi(); }
        $st.css('color','#34d399').text('✅ ' + models.length + ' моделей');
      } catch(e) { $st.css('color','#f87171').text('✗ ' + e.message); }
    });
    let _dt = {};
    const deb = (k, fn) => { clearTimeout(_dt[k]); _dt[k] = setTimeout(fn, 400); };
    $('#calt_depth_rules').on('input', function() {
      const v = +this.value; $('#calt_depth_rules_val').text(v);
      deb('dr', async () => { getSettings().depthRules = v; save(); await updatePrompt(); });
    });
    $('#calt_depth_deadlines').on('input', function() {
      const v = +this.value; $('#calt_depth_deadlines_val').text(v);
      deb('dd', async () => { getSettings().depthDeadlines = v; save(); await updatePrompt(); });
    });
    $('#calt_depth_timeline').on('input', function() {
      const v = +this.value; $('#calt_depth_timeline_val').text(v);
      deb('dt', async () => { getSettings().depthTimeline = v; save(); await updatePrompt(); });
    });
    $('#calt_dl_horizon').on('change', function() {
      const v = Math.max(1, +this.value || 7);
      this.value = v;
      getSettings().deadlineHorizon = v; save(); updatePrompt();
    });
    $('#calt_test_btn').on('click', async () => {
      const $s = $('#calt_test_status'); $s.css('color','#7a8499').text('Тестирую…');
      try {
        const r = await aiGenerate('Reply: OK', 'Reply: OK');
        $s.css('color','#34d399').text('✅ ' + r.trim().slice(0,50));
      } catch(e) { $s.css('color','#f87171').text('✗ ' + e.message); }
    });
    // Bulletproof open button — works on Android Chrome where jQuery click can be swallowed
    // by ST's own touch/swipe handlers on the extensions panel.
    const _openBtnEl = document.getElementById('calt_open_btn');
    if (_openBtnEl) {
      let _touchMoved = false;
      _openBtnEl.addEventListener('touchstart', function(e) {
        _touchMoved = false;
        e.stopPropagation();
      }, { passive: true });
      _openBtnEl.addEventListener('touchmove', function() { _touchMoved = true; }, { passive: true });
      _openBtnEl.addEventListener('touchend', function(e) {
        if (!_touchMoved) { e.preventDefault(); e.stopPropagation(); openModal(); }
      }, { passive: false });
      _openBtnEl.addEventListener('click', openModal);
    }
    bindPanelDate3();
  }

  function bindPanelDate3() {
    const s = getSettings();
    renderDate3('#calt_date3_panel','calt_p_day','calt_p_month','calt_p_year',
      s.currentDay, s.currentMonthName, s.currentYear);
    $('#calt_p_day,#calt_p_month,#calt_p_year').off('input change').on('input change', function() {
      const d=$('#calt_p_day').val().trim(), m=$('#calt_p_month').val().trim(), y=$('#calt_p_year').val().trim();
      const s = getSettings();
      s.currentDay = d; s.currentMonthName = m; s.currentYear = y;
      s.currentDate = buildDateString(d, m, y);
      save(); updateMeta(); updatePrompt();
      syncModalDate();
    });
  }

  function syncModalDate() {
    if (!$('#calt_date3_modal').length) return;
    const s = getSettings();
    renderDate3('#calt_date3_modal','calt_m_day','calt_m_month','calt_m_year',
      s.currentDay, s.currentMonthName, s.currentYear);
    bindModalDate3();
    updateTokenCounter();
  }

  function bindModalDate3() {
    $('#calt_m_day,#calt_m_month,#calt_m_year').off('input change').on('input change', function() {
      const d=$('#calt_m_day').val().trim(), m=$('#calt_m_month').val().trim(), y=$('#calt_m_year').val().trim();
      const s = getSettings();
      s.currentDay = d; s.currentMonthName = m; s.currentYear = y;
      s.currentDate = buildDateString(d, m, y);
      save(); updateMeta(); updatePrompt();
      renderDate3('#calt_date3_panel','calt_p_day','calt_p_month','calt_p_year', d, m, y);
      bindPanelDate3();
      updateTokenCounter();
      if (activeTab === 'events') renderTabContent();
    });
  }

  function renderDate3(container, idDay, idMonth, idYear, valDay, valMonth, valYear) {
    const cfg = getSettings().calendarConfig;
    const monthOpts = cfg.months.length
      ? cfg.months.map(m =>
          '<option value="' + esc(m.name) + '"' + (m.name===valMonth ? ' selected' : '') + '>' + esc(m.name) + '</option>'
        ).join('')
      : '';
    const monthInp = monthOpts
      ? '<select class="calt-date3-month" id="' + idMonth + '">' + monthOpts + '</select>'
      : '<input class="calt-date3-month" id="' + idMonth + '" value="' + esc(valMonth||'') + '" placeholder="Месяц">';
    $(container).html(
      '<input class="calt-date3-day" id="' + idDay + '" type="text" inputmode="numeric"' +
      ' pattern="[0-9]+(\\-[0-9]+)?" autocomplete="off"' +
      ' value="' + esc(valDay||'') + '" placeholder="Д">' +
      monthInp +
      '<input class="calt-date3-year" id="' + idYear + '" type="number" min="1" value="' + esc(valYear||'') + '" placeholder="Год">'
    );
  }

  function refreshSettingsUi() {
    const s = getSettings(), name = getActiveProfileName();
    $('#calt_enabled').prop('checked', s.enabled !== false);
    $('#calt_autoscan').prop('checked', !!s.autoScan);
    $('#calt_autoscan_threshold').val(s.autoScanThreshold || 3);
    $('#calt_depth_rules').val(s.depthRules||0); $('#calt_depth_rules_val').text(s.depthRules||0);
    $('#calt_depth_deadlines').val(s.depthDeadlines||1); $('#calt_depth_deadlines_val').text(s.depthDeadlines||1);
    $('#calt_depth_timeline').val(s.depthTimeline||4); $('#calt_depth_timeline_val').text(s.depthTimeline||4);
    $('#calt_dl_horizon').val(s.deadlineHorizon||7);
    $('#calt_api_endpoint').val(s.customApiEndpoint || '');
    $('#calt_api_key').val(s.customApiKey || '');
    $('#calt_api_model').val(s.customApiModel || '');
    renderDate3('#calt_date3_panel','calt_p_day','calt_p_month','calt_p_year',
      s.currentDay, s.currentMonthName, s.currentYear);
    bindPanelDate3();
    updateBadge(); updateMeta(); _updatePromptUI();
  }

  function updateBadge() {
    const n = getSettings().keyEvents.length + getSettings().deadlines.length;
    $('#calt_badge').text(n).toggle(n > 0);
  }

  function updateMeta() {
    const s = getSettings(), parts = [];
    if (s.keyEvents.length) parts.push(s.keyEvents.length + ' событий');
    if (s.deadlines.length) parts.push(s.deadlines.length + ' дедлайнов');
    if (s.currentDate) parts.push(s.currentDate);
    $('#calt_meta').text(parts.join(' · ') || 'нет данных');
    updateBadge();
  }

  // ─── Modal ────────────────────────────────────────────────────────────────
  // Pattern copied from v1.1 (the last known-working version on mobile).
  // Dynamic creation on first click, show/hide via calt-mopen class, z-index 99999.
  function _showModal() { $('#calt_modal').addClass('calt-mopen'); }
  function _hideModal()  { $('#calt_modal').removeClass('calt-mopen'); }
  function _isModalOpen(){ return $('#calt_modal').hasClass('calt-mopen'); }

  function openModal() {
    if ($('#calt_modal').length) {
      _showModal();
      syncModalDate(); renderTabContent();
      return;
    }

    $('body').append(`
      <div class="calt-modal" id="calt_modal">
        <div class="calt-modal-inner">
          <div class="calt-drag-handle"></div>
          <div class="calt-modal-hdr">
            <span class="calt-modal-icon">🗓</span>
            <span class="calt-modal-title">Calendar Tracker</span>
            <div class="calt-modal-date-wrap">
              <span class="calt-modal-date-label">Текущая дата:</span>
              <div class="calt-date3-row" id="calt_date3_modal"></div>
            </div>
            <span class="calt-modal-tokens" id="calt_modal_tokens"></span>
            <button class="calt-modal-x" id="calt_modal_close">✕</button>
          </div>
          <div class="calt-tabs" id="calt_tabs">
            <button class="calt-tab active" data-tab="events">⚔ Key Events</button>
            <button class="calt-tab" data-tab="deadlines">⏳ Deadlines</button>
            <button class="calt-tab" data-tab="rules">📜 Правила</button>
          </div>
          <div class="calt-tab-body" id="calt_tab_body"></div>
          <div class="calt-modal-footer">
            <button class="calt-foot-btn" id="calt_export_btn">💾 Экспорт</button>
            <button class="calt-foot-btn" id="calt_import_btn">📥 Импорт</button>
            <button class="calt-foot-btn calt-foot-clear" id="calt_clear_btn">🗑 Очистить</button>
            <button class="calt-foot-btn calt-foot-close" id="calt_modal_close2">Закрыть</button>
          </div>
        </div>
      </div>`);

    syncModalDate();
    _showModal();

    // Close buttons — FM pattern
    $(document).on('click touchend', '#calt_modal_close, #calt_modal_close2', function(e) {
      e.preventDefault();
      e.stopPropagation();
      _hideModal();
    });
    // Backdrop click (desktop only)
    $(document).on('click touchend', '#calt_modal', function(e) {
      if ($(e.target).is('#calt_modal') && window.innerWidth > 600) {
        e.preventDefault();
        _hideModal();
      }
    });
    // Tabs — FM pattern
    $(document).on('click touchend', '#calt_tabs .calt-tab', function(e) {
      e.preventDefault();
      const newTab = $(this).data('tab');
      if (_cfgDirty && activeTab === 'rules' && newTab !== 'rules') {
        if (!confirm('Есть несохранённые изменения в Правилах. Покинуть вкладку?')) return;
        _cfgDraft = null; _cfgDirty = false; clearDraftFromSession();
      }
      $('#calt_tabs .calt-tab').removeClass('active');
      $(this).addClass('active');
      activeTab = newTab; _tagFilter = null;
      if (newTab !== 'rules') { _cfgDirty = false; updateDirtyBadge(); }
      renderTabContent();
    });
    // Footer buttons — FM pattern
    $(document).on('click touchend', '#calt_export_btn', function(e) { e.preventDefault(); e.stopPropagation(); exportData(); });
    $(document).on('click touchend', '#calt_import_btn', function(e) { e.preventDefault(); e.stopPropagation(); importData(); });
    $(document).on('click touchend', '#calt_clear_btn', function(e) { e.preventDefault(); e.stopPropagation(); clearChatData(); });
    renderTabContent();
  }


  function clearChatData() {
    if (!confirm('Очистить все события, дедлайны, саммери и текущую дату?\n\nСтруктура календаря (месяца, луны) останется нетронутой.')) return;
    const s = getSettings();
    // Full snapshot for undo
    const snap = JSON.stringify({
      currentDate:s.currentDate, currentDay:s.currentDay,
      currentMonthName:s.currentMonthName, currentYear:s.currentYear,
      keyEvents:s.keyEvents, deadlines:s.deadlines,
      monthSummaries:s.monthSummaries, monthSummarySnaps:s.monthSummarySnaps,
      manualHotMonths:s.manualHotMonths, manualColdMonths:s.manualColdMonths,
      nextEventId:s.nextEventId, nextDeadlineId:s.nextDeadlineId,
    });
    s.currentDate=''; s.currentDay=''; s.currentMonthName=''; s.currentYear='';
    s.keyEvents=[]; s.deadlines=[];
    s.monthSummaries={}; s.monthSummarySnaps={};
    s.manualHotMonths=[]; s.manualColdMonths=[];
    s.nextEventId=1; s.nextDeadlineId=1;
    save(); updatePrompt(); updateMeta(); refreshSettingsUi(); syncModalDate(); renderTabContent();
    toast('Данные очищены', '#f87171', () => {
      const d = JSON.parse(snap); Object.assign(s, d);
      save(); updatePrompt(); updateMeta(); refreshSettingsUi(); syncModalDate(); renderTabContent();
    }, 8000);
  }

  // ─── Tab rendering ────────────────────────────────────────────────────────
  function renderTabContent() {
    const $b = $('#calt_tab_body'); if (!$b.length) return;
    updateTokenCounter(); updateDirtyBadge();
    if      (activeTab === 'events')    $b.html(buildEventsTab());
    else if (activeTab === 'deadlines') $b.html(buildDeadlinesTab());
    else if (activeTab === 'rules')     $b.html(buildRulesTab());
    bindTabEvents();
  }

  // ─── Events tab ───────────────────────────────────────────────────────────
  function buildTagFilterBar() {
    const s = getSettings(), usedTags = {};
    s.keyEvents.forEach(e => (e.tags||[]).forEach(k => { usedTags[k] = true; }));
    const keys = Object.keys(usedTags);
    if (!keys.length) return '';
    const pills = keys.map(k => {
      const t = tagByKey(k); if (!t) return '';
      const active = _tagFilter === k;
      return '<button class="calt-tag-filter-pill' + (active?' active':'') + '" data-key="' + k + '" style="border-color:' +
        t.color + ';color:' + t.color + (active ? ';background:' + t.color + '22' : '') + '">' + t.label + '</button>';
    }).join('');
    return '<div class="calt-tag-filter-bar">' + pills +
      (_tagFilter ? '<button class="calt-tag-filter-clear" id="calt_tag_filter_clear">✕ сбросить</button>' : '') +
      '</div>';
  }

  function eventRow(e, type) {
    const daysAgo = getEventDaysAgo(e.date);
    const agoLbl  = daysAgoLabel(daysAgo);
    const agoClass = daysAgo === 0 ? ' calt-ev-ago-today'
                   : daysAgo === 1 ? ' calt-ev-ago-yesterday'
                   : '';
    const dateBadge = e.date
      ? '<span class="calt-ev-date">' + esc(e.date) + '</span>'
        + (agoLbl ? '<span class="calt-ev-ago' + agoClass + '">' + esc(agoLbl) + '</span>' : '')
      : '<span class="calt-ev-date calt-ev-date-empty">—</span>';
    const hiddenBadge = e.hidden
      ? '<span class="calt-ev-hidden-badge">скрыто</span>'
      : '';
    const tagsHtml = (e.tags && e.tags.length)
      ? '<div class="calt-ev-tags">' + e.tags.map(k => {
          const t = tagByKey(k);
          return t ? '<span class="calt-tag" data-tagkey="' + k + '" style="border-color:' + t.color + ';color:' + t.color + '">' + t.label + '</span>' : '';
        }).join('') + '</div>'
      : '';
    const pinClass  = e.pinned ? ' calt-ev-pin-active' : '';
    const hidClass  = e.hidden ? ' calt-ev-hidden-row' : '';
    const eyeActive = e.hidden ? ' calt-ev-eye-off' : '';
    const eyeTitle  = e.hidden ? 'Включить в промпт' : 'Скрыть из промпта';
    return '<div class="calt-ev-row' + hidClass + '" data-id="' + e.id + '" data-type="' + type + '">'
      + '<div class="calt-ev-left">'
      + '<div class="calt-ev-date-col">' + dateBadge + hiddenBadge + '</div>'
      + '<div class="calt-ev-content">'
      + '<span class="calt-ev-text" data-id="' + e.id + '" data-type="' + type + '">' + esc(e.text) + '</span>'
      + tagsHtml + '</div></div>'
      + '<div class="calt-ev-acts">'
      + '<button class="calt-ev-btn calt-ev-eye' + eyeActive + '" data-id="' + e.id + '" data-type="' + type + '" title="' + eyeTitle + '">👁</button>'
      + '<button class="calt-ev-btn calt-ev-tag-btn" data-id="' + e.id + '" data-type="' + type + '" title="Теги">🏷</button>'
      + '<button class="calt-ev-btn calt-ev-pin' + pinClass + '" data-id="' + e.id + '" data-type="' + type + '" title="' + (e.pinned?'Открепить':'Закрепить') + '">📌</button>'
      + '<button class="calt-ev-btn calt-ev-edit" data-id="' + e.id + '" data-type="' + type + '" title="Редактировать">✎</button>'
      + '<button class="calt-ev-btn calt-ev-del" data-id="' + e.id + '" data-type="' + type + '" title="Удалить">✕</button>'
      + '</div></div>';
  }

  function buildEventsTab() {
    const s = getSettings(), cm = currentMonth();

    // Calendar info bar (day of week + moon)
    let calInfoHtml = '';
    const absDay = getCurrentAbsDay();
    if (absDay !== null) {
      const parts = [];
      const dow = getDayOfWeek(absDay);
      if (dow) parts.push(dow.name + (dow.note ? ' (' + dow.note + ')' : ''));
      getMoonPhases(absDay).forEach(mp => {
        let moonStr = '🌙 ' + mp.phaseName + ' (' + mp.dayInPhase + '/' + mp.phaseDays + ')';
        if (mp.phaseNote) moonStr += ' — ' + mp.phaseNote;
        moonStr += ' · ~' + mp.daysRemaining + 'д → ' + mp.nextPhase;
        parts.push(moonStr);
      });
      if (parts.length) calInfoHtml = '<div class="calt-cal-info">' + parts.join(' · ') + '</div>';
    }

    // Filter events
    const filtered = s.keyEvents.filter(e => {
      if (_searchQuery) {
        const tagLabels = (e.tags||[]).map(k => { const t = tagByKey(k); return t ? t.label : ''; }).join(' ');
        if (!(e.text + ' ' + e.date + ' ' + tagLabels).toLowerCase().includes(_searchQuery.toLowerCase())) return false;
      }
      if (_tagFilter && !(e.tags||[]).includes(_tagFilter)) return false;
      return true;
    });

    // Build grouped list
    let listHtml = '';
    if (!filtered.length) {
      listHtml = (_searchQuery || _tagFilter)
        ? '<div class="calt-empty">Ничего не найдено</div>'
        : '<div class="calt-empty">Событий нет.<br><small>Нажмите ✦ Сканировать</small></div>';
    } else {
      const groups = {}, order = [];
      filtered.forEach(e => {
        const m = extractMonth(e.date) || '— Без даты';
        if (!groups[m]) { groups[m] = []; order.push(m); }
        groups[m].push(e);
      });
      // Sort within each group by day (chronological)
      Object.values(groups).forEach(arr => {
        arr.sort((a, b) => {
          const pa = parseDateString(a.date), pb = parseDateString(b.date);
          const da = parseInt(pa.day, 10) || 0, db = parseInt(pb.day, 10) || 0;
          return da - db;
        });
      });
      // Move "— Без даты" to end
      const ndi = order.indexOf('— Без даты');
      if (ndi > -1 && ndi < order.length - 1) {
        order.splice(ndi, 1);
        order.push('— Без даты');
      }
      order.forEach(month => {
        const hot = isMonthHot(month), coll = !!_collapsedMonths[month];
        const summ = s.monthSummaries[month] || '';
        const outdated = isSummaryOutdated(month);
        const outdatedBadge = (outdated && summ)
          ? '<span class="calt-summ-outdated" title="Добавлены новые события">⚠ устарело</span>' : '';
        listHtml += '<div class="calt-month-group">'
          + '<div class="calt-month-hdr" data-month="' + esc(month) + '">'
          + '<span class="calt-month-chev">' + (coll?'▸':'▾') + '</span>'
          + '<span class="calt-month-name">' + esc(month) + '</span>'
          + (hot
            ? '<span class="calt-layer-badge calt-layer-hot calt-layer-toggle" data-month="' + esc(month) + '" title="Нажмите — пометить как прошлый">● текущий</span>'
            : '<span class="calt-layer-badge calt-layer-warm calt-layer-toggle" data-month="' + esc(month) + '" title="Нажмите — пометить как текущий">● прошлый</span>')
          + '<span class="calt-month-count">' + groups[month].length + '</span>'
          + (groups[month].length >= 2 ? '<button class="calt-summ-gen-btn calt-month-cond-btn" data-month="' + esc(month) + '" title="⚡ Конденсировать этот месяц">⚡</button>' : '')
          + (!hot ? '<button class="calt-summ-gen-btn" data-month="' + esc(month) + '" title="AI саммери">✦</button>' : '')
          + '</div>';
        if (!hot) {
          listHtml += '<div class="calt-month-summ-row" data-month="' + esc(month) + '">'
            + (summ
              ? '<span class="calt-summ-text" data-month="' + esc(month) + '">' + esc(summ) + '</span>' + outdatedBadge
              : '<span class="calt-summ-empty" data-month="' + esc(month) + '">нет саммери — кликните или нажмите ✦</span>')
            + '</div>';
        }
        listHtml += '<div class="calt-month-body"' + (coll?' style="display:none"':'') + '>'
          + groups[month].map(e => eventRow(e,'event')).join('')
          + '</div></div>';
      });
    }

    const legendHtml = '<div class="calt-legend">'
      + (cm
        ? '<div class="calt-legend-left"><span class="calt-layer-hot">● текущий</span> полностью · <span class="calt-layer-warm">● прошлый</span> саммери</div>'
        : '<div class="calt-legend-left"></div>')
      + '<div class="calt-legend-right">'
      + '<button class="calt-collapse-btn" id="calt_goto_current" title="К текущему месяцу">◎</button>'
      + '<button class="calt-collapse-btn" id="calt_collapse_all" title="Свернуть все">⊟</button>'
      + '<button class="calt-collapse-btn" id="calt_expand_all" title="Развернуть все">⊞</button>'
      + '</div></div>';

    return calInfoHtml + legendHtml
      + '<div class="calt-search-row">'
      + '<input class="calt-search-inp" id="calt_search" value="' + esc(_searchQuery) + '" placeholder="🔍 Поиск событий…">'
      + (_searchQuery ? '<button class="calt-search-clear" id="calt_search_clear">✕</button>' : '')
      + '</div>'
      + buildTagFilterBar()
      + '<div class="calt-list-wrap"><div class="calt-list" id="calt_ev_list">' + listHtml + '</div></div>'
      + '<div class="calt-add-row">'
      + '<div class="calt-date3-row calt-add-date3" id="calt_add_ev_date3"></div>'
      + '<input class="calt-add-txt" id="calt_add_ev_txt" placeholder="Описание события...">'
      + '<button class="calt-add-btn" id="calt_add_ev_btn">+ Добавить</button>'
      + '</div>'
      + '<div class="calt-scan-row">'
      + '<span class="calt-scan-lbl">Сканировать</span>'
      + '<input type="number" class="calt-depth-inp" id="calt_scan_ev_depth" value="' + s.scanDepth + '" min="5" max="200">'
      + '<span class="calt-scan-unit">сообщений</span>'
      + '<button class="menu_button calt-scan-btn" id="calt_scan_ev_btn">✦ Сканировать</button>'
      + '</div>'
      + '<div class="calt-scan-row">'
      + '<button class="menu_button calt-scan-btn" id="calt_condense_btn" title="AI конденсация ВСЕГО таймлайна: объединяет дубли и сжимает все записи">⚡ Конденсировать всё</button>'
      + '</div>'
      + '<div class="calt-scan-status" id="calt_scan_ev_status"></div>';
  }

  // ─── Deadlines tab ────────────────────────────────────────────────────────
  function buildDeadlinesTab() {
    const s = getSettings(), cm = currentMonth();
    const horizon = s.deadlineHorizon || 7;

    // Type filter pills
    let typeFilterHtml = '';
    const usedTypes = {};
    s.deadlines.forEach(e => { usedTypes[e.dtype || 'event'] = true; });
    if (Object.keys(usedTypes).length > 1) {
      typeFilterHtml = '<div class="calt-tag-filter-bar">' +
        DEADLINE_TYPES.filter(t => usedTypes[t.key]).map(t =>
          '<button class="calt-dl-type-filter" data-dtype="' + t.key + '" style="border-color:' + t.color + ';color:' + t.color + '">' + t.label + '</button>'
        ).join('') + '</div>';
    }

    let listHtml = '';
    if (!s.deadlines.length) {
      listHtml = '<div class="calt-empty">Дедлайнов нет.</div>';
    } else {
      // Helper: compute days-until for a deadline
      const curAbs = getCurrentAbsDay();
      function dlDaysUntil(e) {
        if (curAbs === null) return null;
        const p = parseDateString(e.date);
        if (!p.day || !p.month) return null;
        // No year → can't compute reliable distance; return null so UI shows the warning badge
        if (!p.year) return null;
        // Use end of day range ("5-11" → 11) so deadline stays active through the whole range
        const dlAbs = dateToAbsDayEnd(p.day, p.month, p.year);
        return dlAbs !== null ? dlAbs - curAbs : null;
      }
      // Group by month
      const groups = {}, order = [];
      s.deadlines.forEach(e => {
        const m = extractMonth(e.date) || '— Без даты';
        if (!groups[m]) { groups[m] = []; order.push(m); }
        groups[m].push(e);
      });
      // Sort within each group by day (closest first)
      Object.values(groups).forEach(arr => {
        arr.sort((a, b) => {
          const da = dlDaysUntil(a), db = dlDaysUntil(b);
          if (da !== null && db !== null) return da - db;
          if (da !== null) return -1;
          if (db !== null) return  1;
          return 0;
        });
      });
      order.forEach(month => {
        listHtml += '<div class="calt-month-group">'
          + '<div class="calt-month-hdr calt-dl-month-hdr" data-month="' + esc(month) + '">'
          + '<span class="calt-month-chev">▾</span>'
          + '<span class="calt-month-name">' + esc(month) + '</span>'
          + '<span class="calt-month-count">' + groups[month].length + '</span>'
          + '</div>'
          + '<div class="calt-month-body">';
        groups[month].forEach(e => {
          const hot = isDeadlineHot(e);
          const dt = dlTypeByKey(e.dtype);
          const daysUntil = dlDaysUntil(e);
          const noYear = _deadlineMissingYear(e);
          const approaching = daysUntil !== null && daysUntil >= 0 && daysUntil <= 3;
          const dateBadge = e.date
            ? '<span class="calt-ev-date' + (approaching ? ' calt-ev-date-urgent' : (noYear ? ' calt-ev-date-noyear' : '')) + '">'
              + (approaching ? '⚠ ' : '') + esc(e.date) + '</span>'
            : '<span class="calt-ev-date calt-ev-date-empty">—</span>';
          const typeBadge = '<span class="calt-dl-type-badge" style="border-color:' + dt.color + ';color:' + dt.color + '">' + dt.label + '</span>';
          // "Год не указан" warning — shown when date has day+month but no year
          const noYearBadge = noYear
            ? '<span class="calt-dl-noyear-badge" title="Год не указан — дедлайн всегда в контексте. Откройте редактирование и добавьте год.">⚠ год не указан</span>'
            : '';
          // Compute reason for hot/cold status
          let hotBadge;
          if (e.pinned) {
            hotBadge = '<span class="calt-dl-hot-badge">📌 в контексте</span>';
          } else if (noYear) {
            // Year unknown — always hot, but we show the warning instead of a distance
            hotBadge = '<span class="calt-dl-hot-badge" style="color:#f59e0b">● в контексте (год?)</span>';
          } else if (hot) {
            if (daysUntil !== null) {
              if (daysUntil < 0) hotBadge = '<span class="calt-dl-hot-badge" style="color:#f87171">● просрочен (' + Math.abs(daysUntil) + 'дн)</span>';
              else if (daysUntil === 0) hotBadge = '<span class="calt-dl-hot-badge" style="color:#f87171">● СЕГОДНЯ</span>';
              else hotBadge = '<span class="calt-dl-hot-badge">● через ' + daysUntil + 'дн</span>';
            } else {
              hotBadge = '<span class="calt-dl-hot-badge">● нет даты</span>';
            }
          } else {
            if (daysUntil !== null) {
              hotBadge = '<span class="calt-dl-cold-badge">○ через ' + daysUntil + 'дн</span>';
            } else {
              hotBadge = '<span class="calt-dl-cold-badge">○ скрыт</span>';
            }
          }
          const titleHtml = e.title ? '<span class="calt-dl-title">' + esc(e.title) + '</span>' : '';
          const pinClass = e.pinned ? ' calt-ev-pin-active' : '';
          listHtml += '<div class="calt-ev-row' + (hot ? '' : ' calt-dl-row-cold') + '" data-id="' + e.id + '" data-type="deadline">'
            + '<div class="calt-ev-left">' + dateBadge
            + '<div class="calt-ev-content">'
            + (titleHtml ? titleHtml : '')
            + '<span class="calt-ev-text" data-id="' + e.id + '" data-type="deadline">' + esc(e.text) + '</span>'
            + '<div class="calt-dl-meta">' + typeBadge + hotBadge + noYearBadge + '</div>'
            + '</div></div>'
            + '<div class="calt-ev-acts">'
            + '<button class="calt-ev-btn calt-dl-type-btn" data-id="' + e.id + '" title="Тип">🏷</button>'
            + '<button class="calt-ev-btn calt-ev-pin' + pinClass + '" data-id="' + e.id + '" data-type="deadline" title="' + (e.pinned?'Открепить':'Закрепить в контексте') + '">📌</button>'
            + '<button class="calt-ev-btn calt-ev-edit" data-id="' + e.id + '" data-type="deadline">✎</button>'
            + '<button class="calt-ev-btn calt-ev-del" data-id="' + e.id + '" data-type="deadline">✕</button>'
            + '</div></div>';
        });
        listHtml += '</div></div>';
      });
    }

    // Legend
    const legendHtml = '<div class="calt-legend">'
      + '<div class="calt-legend-left"><span class="calt-dl-hot-badge">● в контексте</span> ≤' + horizon + 'дн · <span class="calt-dl-cold-badge">○ скрыт</span> · 📌 фиксация</div>'
      + '</div>';

    return legendHtml + typeFilterHtml
      + '<div class="calt-list-wrap"><div class="calt-list">' + listHtml + '</div></div>'
      + '<div class="calt-add-row" style="flex-wrap:wrap;gap:6px">'
      + '<div class="calt-date3-row calt-add-date3" id="calt_add_dl_date3"></div>'
      + '<input class="calt-add-txt" id="calt_add_dl_title" placeholder="Название (опционально)..." style="flex:0 1 160px;min-width:100px">'
      + '<input class="calt-add-txt" id="calt_add_dl_txt" placeholder="Описание...">'
      + '<select class="calt-cfg-sel" id="calt_add_dl_type" style="flex-shrink:0;width:auto">'
      + DEADLINE_TYPES.map(t => '<option value="' + t.key + '">' + t.label + '</option>').join('')
      + '</select>'
      + '<button class="calt-add-btn" id="calt_add_dl_btn">+ Добавить</button>'
      + '</div>'
      + '<div class="calt-scan-row">'
      + '<span class="calt-scan-lbl">Сканировать</span>'
      + '<input type="number" class="calt-depth-inp" id="calt_scan_dl_depth" value="' + s.scanDepth + '" min="5" max="200">'
      + '<span class="calt-scan-unit">сообщений</span>'
      + '<button class="menu_button calt-scan-btn" id="calt_scan_dl_btn">✦ Сканировать</button>'
      + '</div>'
      + '<div class="calt-scan-status" id="calt_scan_dl_status"></div>';
  }

  // ─── Rules tab ────────────────────────────────────────────────────────────
  function buildRulesTab() {
    // Priority: in-memory draft → sessionStorage draft → fresh copy from settings
    if (!_cfgDraft) {
      const saved     = getSettings().calendarConfig;
      const restored  = loadDraftFromSession();
      // Only use restored draft if it has at least as much data as saved settings.
      // A draft with fewer months/weekdays is stale and would overwrite good data.
      const draftOk = restored &&
        (restored.months||[]).length  >= (saved.months||[]).length &&
        (restored.weekDays||[]).length >= (saved.weekDays||[]).length;
      if (draftOk) {
        _cfgDraft = restored;
        _cfgDirty = true;
        updateDirtyBadge();
        setTimeout(() => toast('Черновик правил восстановлен после перезагрузки', '#a78bfa'), 300);
      } else {
        if (restored) clearDraftFromSession(); // discard stale draft
        _cfgDraft = JSON.parse(JSON.stringify(saved));
      }
    }
    const cc = _cfgDraft;

    function secWrap(key, icon, title, extraBtn, bodyHtml) {
      const coll = !!_collapsedSections[key];
      // NOTE: extraBtn is placed BETWEEN header and collapsible body — always visible,
      // never hidden when section collapses, never confused with the toggle header.
      return '<div class="calt-cfg-section">'
        + '<div class="calt-cfg-hdr calt-sec-toggle" data-sec="' + key + '">'
        + '<span class="calt-sec-chev2">' + (coll?'▸':'▾') + '</span>' + icon + ' ' + title
        + '</div>'
        + (extraBtn ? '<div class="calt-sec-add-row">' + extraBtn + '</div>' : '')
        + '<div class="calt-cfg-sec-body"' + (coll ? ' style="display:none"' : '') + '>'
        + bodyHtml
        + '</div></div>';
    }

    // Basics
    const basicsHtml =
      '<div class="calt-cfg-row"><label class="calt-cfg-label">Название</label>' +
        '<input class="calt-cfg-inp-lg" id="cfg_name" value="' + esc(cc.name||'') + '" placeholder="Standard Vaelorian Calendar"></div>' +
      '<div class="calt-cfg-row"><label class="calt-cfg-label">Эра</label>' +
        '<input class="calt-cfg-inp-lg" id="cfg_era" value="' + esc(cc.era||'') + '" placeholder="Anno Purationis (A.P.)"></div>' +
      '<div class="calt-cfg-row"><label class="calt-cfg-label">От чего</label>' +
        '<input class="calt-cfg-inp-lg" id="cfg_erafrom" value="' + esc(cc.eraFrom||'') + '" placeholder="Year of the Purification"></div>';

    // Months
    let monthsRows = '<div class="calt-cfg-row calt-cfg-thead"><span></span><span>Название</span><span>Дней</span><span>Сезон</span><span>Атмосфера месяца</span><span></span></div>';
    cc.months.forEach((m, i) => {
      monthsRows += '<div class="calt-cfg-row calt-month-row" data-idx="' + i + '">'
        + '<div class="calt-reorder-btns">'
        + '<button class="calt-reorder-btn" data-rules-action="mv-month-up" data-idx="' + i + '">↑</button>'
        + '<button class="calt-reorder-btn" data-rules-action="mv-month-dn" data-idx="' + i + '">↓</button>'
        + '</div>'
        + '<input class="calt-cfg-inp-sm" data-field="name" placeholder="Название" value="' + esc(m.name||'') + '">'
        + '<input class="calt-cfg-inp-xs" type="number" min="1" max="400" data-field="days" placeholder="Дн" value="' + esc(m.days||'') + '">'
        + '<input class="calt-cfg-inp-sm" data-field="season" placeholder="Сезон" value="' + esc(m.season||'') + '">'
        + '<input class="calt-cfg-inp-lg" data-field="recurringNote" placeholder="Атмосфера месяца..." value="' + esc(m.recurringNote||'') + '">'
        + '<button class="calt-cfg-del-btn" data-rules-action="del-month" data-idx="' + i + '">✕</button>'
        + '</div>';
    });

    // Weekdays
    let wdRows = '';
    cc.weekDays.forEach((d, i) => {
      wdRows += '<div class="calt-cfg-row calt-wd-row" data-idx="' + i + '">'
        + '<div class="calt-reorder-btns">'
        + '<button class="calt-reorder-btn" data-rules-action="mv-wd-up" data-idx="' + i + '">↑</button>'
        + '<button class="calt-reorder-btn" data-rules-action="mv-wd-dn" data-idx="' + i + '">↓</button>'
        + '</div>'
        + '<span class="calt-wd-num">' + (i+1) + '.</span>'
        + '<input class="calt-cfg-inp-sm" data-field="name" placeholder="Название" value="' + esc(d.name||'') + '">'
        + '<input class="calt-cfg-inp-lg" data-field="note" placeholder="Описание дня..." value="' + esc(d.note||'') + '">'
        + '<button class="calt-cfg-del-btn" data-rules-action="del-wd" data-idx="' + i + '">✕</button>'
        + '</div>';
    });
    let wdRefHtml = '';
    if (cc.weekDays.length) {
      const wdOpts = cc.weekDays.map((d, i) =>
        '<option value="' + i + '"' + (i===(cc.weekRefDayIndex||0) ? ' selected' : '') + '>' + esc(d.name||'День '+(i+1)) + '</option>'
      ).join('');
      wdRefHtml = '<div class="calt-cfg-ref-row">'
        + '<span class="calt-cfg-ref-label">Точка: на дату</span>'
        + '<input class="calt-cfg-inp-sm" id="cfg_week_ref_date" value="' + esc(cc.weekRefDate||'') + '" placeholder="1 Vael 1000">'
        + '<span class="calt-cfg-ref-label">был</span>'
        + '<select class="calt-cfg-sel" id="cfg_week_ref_day">' + wdOpts + '</select>'
        + '</div>';
    }

    // Moons
    let moonsHtml = '<div id="cfg_moons_list">';
    cc.moons.forEach((moon, mi) => {
      let phasesHtml = '';
      (moon.phases||[]).forEach((ph, pi) => {
        phasesHtml += '<div class="calt-phase-row" data-moon="' + mi + '" data-idx="' + pi + '">'
          + '<div class="calt-reorder-btns">'
          + '<button class="calt-reorder-btn" data-rules-action="mv-ph-up" data-moon="' + mi + '" data-idx="' + pi + '">↑</button>'
          + '<button class="calt-reorder-btn" data-rules-action="mv-ph-dn" data-moon="' + mi + '" data-idx="' + pi + '">↓</button>'
          + '</div>'
          + '<input class="calt-cfg-inp-sm" data-field="name" placeholder="Фаза" value="' + esc(ph.name||'') + '">'
          + '<input class="calt-cfg-inp-xs" type="number" min="1" data-field="days" placeholder="Дн" value="' + esc(ph.days||'') + '">'
          + '<input class="calt-cfg-inp-lg" data-field="note" placeholder="Описание фазы..." value="' + esc(ph.note||'') + '">'
          + '<button class="calt-cfg-del-btn" data-rules-action="del-phase" data-moon="' + mi + '" data-idx="' + pi + '">✕</button>'
          + '</div>';
      });
      const totalDays = (moon.phases||[]).reduce((s,p) => s + Math.max(1,parseInt(p.days,10)||1), 0);
      const cycLen    = parseInt(moon.cycleDays,10) || 0;
      const warn      = (cycLen > 0 && totalDays !== cycLen)
        ? '<span class="calt-phase-warn">⚠ ' + totalDays + '≠' + cycLen + '</span>' : '';
      const phOpts = (moon.phases||[]).map((ph, pi) =>
        '<option value="' + pi + '"' + ((moon.refPhaseIndex||0)===pi ? ' selected' : '') + '>' + esc(ph.name||'Фаза '+(pi+1)) + '</option>'
      ).join('');
      moonsHtml += '<div class="calt-moon-card" data-moon="' + mi + '">'
        + '<div class="calt-moon-card-hdr">'
        + '<input class="calt-cfg-inp-sm calt-moon-name" data-moon="' + mi + '" placeholder="Луна" value="' + esc(moon.name||'') + '">'
        + '<input class="calt-cfg-inp-sm calt-moon-nickname" data-moon="' + mi + '" placeholder="Прозвище" value="' + esc(moon.nickname||'') + '">'
        + '<input class="calt-cfg-inp-xs calt-moon-cycle" data-moon="' + mi + '" type="number" min="1" placeholder="Цикл" value="' + esc(moon.cycleDays||'') + '">'
        + warn
        + '<button class="calt-cfg-del-btn" data-rules-action="del-moon" data-moon="' + mi + '">✕ луну</button>'
        + '</div>'
        + '<div class="calt-phases-list" data-moon="' + mi + '">' + phasesHtml + '</div>'
        + '<button class="calt-cfg-add-sm" data-rules-action="add-phase" data-moon="' + mi + '">+ Фаза</button>'
        + (moon.phases.length ? '<div class="calt-cfg-ref-row">'
          + '<span class="calt-cfg-ref-label">Точка: дата</span>'
          + '<input class="calt-cfg-inp-sm calt-moon-ref-date" data-moon="' + mi + '" value="' + esc(moon.refDate||'') + '" placeholder="1 Vael 1000">'
          + '<span class="calt-cfg-ref-label">фаза</span>'
          + '<select class="calt-cfg-sel calt-moon-ref-phase" data-moon="' + mi + '">' + phOpts + '</select>'
          + '</div>' : '')
        + '</div>';
    });
    moonsHtml += '</div>';

    const notesHtml = '<textarea class="calt-rules-edit" id="calt_rules_edit" rows="5" placeholder="Дополнительные правила мира...">'
      + esc(getSettings().calendarRules||'') + '</textarea>';

    return '<div class="calt-rules-wrap">'
      + secWrap('basics','📅','Основы','',basicsHtml)
      + secWrap('months','📆','Месяца','<button class="calt-cfg-add-btn" data-rules-action="add-month">+ Добавить месяц</button>',
          '<div id="cfg_months_list">' + monthsRows + '</div>')
      + secWrap('week','📅','Дни недели','<button class="calt-cfg-add-btn" data-rules-action="add-wd">+ Добавить день</button>',
          '<div id="cfg_wd_list">' + wdRows + '</div>' + wdRefHtml)
      + secWrap('moons','🌙','Луны','<button class="calt-cfg-add-btn" data-rules-action="add-moon">+ Добавить луну</button>', moonsHtml)
      + secWrap('notes','📝','Заметки','', notesHtml)
      + '<div class="calt-rules-actions">'
      + '<button class="menu_button calt-scan-btn" id="calt_rules_extract_btn">✦ Извлечь из лорбука</button>'
      + '<button class="menu_button calt-rules-save-btn" id="calt_rules_save_btn">💾 Сохранить</button>'
      + '</div>'
      + '<div class="calt-scan-status" id="calt_scan_rules_status"></div>'
      + '</div>';
  }

  // ─── Tab event bindings ───────────────────────────────────────────────────
  function bindTabEvents() {

    // ── Navigate / collapse ───────────────────────────────────────────────
    $('#calt_goto_current').off('click').on('click', () => {
      const cm = currentMonth(); if (!cm) return;
      _collapsedMonths = {}; renderTabContent();
      // Wait for slideDown animation (160ms) to fully complete before scrolling
      setTimeout(() => {
        const $h = $('.calt-month-hdr[data-month="' + cm + '"]');
        if ($h.length) $h[0].scrollIntoView({ behavior:'smooth', block:'start' });
      }, 200);
    });
    $('#calt_collapse_all').off('click').on('click', () => {
      const months = [...new Set(getSettings().keyEvents.map(e => extractMonth(e.date) || '— Без даты'))];
      months.forEach(m => { _collapsedMonths[m] = true; });
      renderTabContent();
    });
    $('#calt_expand_all').off('click').on('click', () => { _collapsedMonths = {}; renderTabContent(); });

    // ── Search ────────────────────────────────────────────────────────────
    $('#calt_search').off('input').on('input', function() { _searchQuery = this.value; renderTabContent(); });
    $('#calt_search_clear').off('click').on('click', () => { _searchQuery = ''; renderTabContent(); });

    // ── Tag filter ────────────────────────────────────────────────────────
    $('.calt-tag-filter-pill').off('click').on('click', function() {
      const k = $(this).data('key'); _tagFilter = (_tagFilter === k) ? null : k; renderTabContent();
    });
    $('#calt_tag_filter_clear').off('click').on('click', () => { _tagFilter = null; renderTabContent(); });
    $(document).off('click.tagchip').on('click.tagchip', '.calt-tag', function(e) {
      e.stopPropagation();
      const k = $(this).data('tagkey');
      if (k) { _tagFilter = (_tagFilter === k) ? null : k; renderTabContent(); }
    });

    // ── Month group toggle ────────────────────────────────────────────────
    $('.calt-month-hdr').off('click').on('click', function(e) {
      if ($(e.target).closest('.calt-summ-gen-btn,.calt-layer-toggle').length) return;
      const month = $(this).data('month');
      _collapsedMonths[month] = !_collapsedMonths[month];
      $(this).closest('.calt-month-group').find('.calt-month-body')
        [_collapsedMonths[month] ? 'slideUp' : 'slideDown'](160);
      $(this).find('.calt-month-chev').text(_collapsedMonths[month] ? '▸' : '▾');
    });

    // ── Layer badge toggle ────────────────────────────────────────────────
    $('.calt-layer-toggle').off('click').on('click', function(e) {
      e.stopPropagation();
      const month = $(this).data('month'), s = getSettings();
      if (isMonthHot(month)) {
        const idx = s.manualHotMonths.indexOf(month); if (idx !== -1) s.manualHotMonths.splice(idx,1);
        if (!s.manualColdMonths.includes(month)) s.manualColdMonths.push(month);
        toast(month + ' → прошлый', '#60a5fa');
      } else {
        if (!s.manualHotMonths.includes(month)) s.manualHotMonths.push(month);
        const ci = s.manualColdMonths.indexOf(month); if (ci !== -1) s.manualColdMonths.splice(ci,1);
        toast(month + ' → текущий 🔥', '#fbbf24');
      }
      save(); updatePrompt(); renderTabContent();
    });

    // ── Summary ───────────────────────────────────────────────────────────
    $('.calt-summ-text,.calt-summ-empty').off('click').on('click', function() {
      openSummaryEdit($(this).data('month'));
    });
    $('.calt-summ-gen-btn').off('click').on('click', async function(e) {
      e.stopPropagation();
      const month = $(this).data('month'), $btn = $(this);
      $btn.prop('disabled',true).text('…');
      try {
        const text = await generateMonthSummary(month);
        getSettings().monthSummaries[month] = text.trim();
        saveSummarySnap(month);
        save(); renderTabContent(); toast('Саммери для ' + month + ' готово', '#a78bfa');
      } catch(err) { toast('Ошибка: ' + err.message, '#f87171'); $btn.prop('disabled',false).text('✦'); }
    });

    // ── Inline edit ───────────────────────────────────────────────────────
    $('.calt-ev-text').off('click').on('click', function() {
      startInlineEdit($(this), +$(this).data('id'), $(this).data('type'));
    });

    // ── Tags button ───────────────────────────────────────────────────────
    $('.calt-ev-tag-btn').off('click').on('click', function(e) {
      e.stopPropagation(); openTagPicker(+$(this).data('id'), $(this).data('type'), $(this));
    });

    // ── Hide / show (eye toggle) ──────────────────────────────────────────
    $('.calt-ev-eye').off('click').on('click', function() {
      const id = +$(this).data('id'), type = $(this).data('type'), s = getSettings();
      const arr = type === 'event' ? s.keyEvents : s.deadlines;
      const item = arr.find(e => e.id === id); if (!item) return;
      item.hidden = !item.hidden;
      save(); updatePrompt(); renderTabContent();
      toast(item.hidden ? '👁 Скрыто из промпта' : '👁 Включено в промпт',
            item.hidden ? '#4a5568' : '#34d399');
    });

    // ── Pin (unified: works for both events and deadlines) ─────────────
    $('.calt-ev-pin').off('click').on('click', function() {
      const id = +$(this).data('id'), type = $(this).data('type'), s = getSettings();
      const arr = type === 'event' ? s.keyEvents : s.deadlines;
      const item = arr.find(e => e.id === id); if (!item) return;
      item.pinned = !item.pinned;
      save(); updatePrompt(); renderTabContent();
      toast(item.pinned ? '📌 Закреплено' : 'Откреплено', item.pinned ? '#fbbf24' : '#94a3b8');
    });

    // ── Delete ────────────────────────────────────────────────────────────
    $('.calt-ev-del').off('click').on('click', function() {
      const id = +$(this).data('id'), type = $(this).data('type'), s = getSettings();
      const arr = type === 'event' ? 'keyEvents' : 'deadlines';
      const removed = s[arr].find(e => e.id === id);
      s[arr] = s[arr].filter(e => e.id !== id);
      save(); updatePrompt(); updateMeta(); renderTabContent();
      toast(type === 'event' ? 'Событие удалено' : 'Дедлайн удалён', '#f87171', () => {
        s[arr].push(removed); s[arr].sort((a,b) => a.id - b.id);
        save(); updatePrompt(); updateMeta(); renderTabContent();
      });
    });

    // ── Edit button ───────────────────────────────────────────────────────
    $('.calt-ev-edit').off('click').on('click', function() {
      openEditModal(+$(this).data('id'), $(this).data('type'));
    });

    // ── Add event ─────────────────────────────────────────────────────────
    // Render day/month/year picker into the add row
    renderDate3('#calt_add_ev_date3', 'calt_add_ev_day', 'calt_add_ev_month', 'calt_add_ev_year', '', '', '');
    $('#calt_add_ev_btn').off('click').on('click', () => {
      const d = $('#calt_add_ev_day').val().trim();
      const m = $('#calt_add_ev_month').val().trim();
      const y = $('#calt_add_ev_year').val().trim();
      const date = buildDateString(d, m, y);
      const text = $('#calt_add_ev_txt').val().trim();
      if (!text) { $('#calt_add_ev_txt').focus(); return; }
      const s = getSettings(); s.keyEvents.push({ id:s.nextEventId++, date, text, pinned:false, tags:[] });
      save(); updatePrompt(); updateMeta();
      $('#calt_add_ev_txt').val('');
      renderTabContent();
    });
    $('#calt_add_ev_txt').off('keydown').on('keydown', e => { if (e.key==='Enter') $('#calt_add_ev_btn').click(); });

    // ── Add deadline ──────────────────────────────────────────────────────
    renderDate3('#calt_add_dl_date3', 'calt_add_dl_day', 'calt_add_dl_month', 'calt_add_dl_year', '', '', '');
    $('#calt_add_dl_btn').off('click').on('click', () => {
      const d = $('#calt_add_dl_day').val().trim();
      const m = $('#calt_add_dl_month').val().trim();
      const y = $('#calt_add_dl_year').val().trim();
      const date = buildDateString(d, m, y);
      const title = ($('#calt_add_dl_title').val() || '').trim();
      const text = $('#calt_add_dl_txt').val().trim();
      const dtype = $('#calt_add_dl_type').val() || 'event';
      if (!text) { $('#calt_add_dl_txt').focus(); return; }
      const s = getSettings(); s.deadlines.push({ id:s.nextDeadlineId++, date, title, text, pinned:false, dtype });
      save(); updatePrompt(); updateMeta();
      $('#calt_add_dl_title').val(''); $('#calt_add_dl_txt').val('');
      renderTabContent();
    });
    $('#calt_add_dl_txt').off('keydown').on('keydown', e => { if (e.key==='Enter') $('#calt_add_dl_btn').click(); });

    // ── Deadline type picker ──────────────────────────────────────────
    if (activeTab === 'deadlines') {
      $('.calt-dl-type-btn').off('click').on('click', function(e) {
        e.stopPropagation();
        openDeadlineTypePicker(+$(this).data('id'), $(this));
      });
    }

    // ── Scan depth ────────────────────────────────────────────────────────
    $('#calt_scan_ev_depth,#calt_scan_dl_depth').off('change').on('change', function() {
      getSettings().scanDepth = +this.value || 20; save();
    });

    // ── Scan events ───────────────────────────────────────────────────────
    $('#calt_scan_ev_btn').off('click').on('click', async function() {
      const $btn=$(this), $st=$('#calt_scan_ev_status'), depth=+$('#calt_scan_ev_depth').val()||20;
      $btn.prop('disabled',true).text('Сканирую…'); $st.css('color','#7a8499').text('Анализирую…');
      try {
        const s=getSettings(), snap=JSON.stringify(s.keyEvents);
        const oldCount = s.keyEvents.length;
        const events = await scanKeyEvents(depth);
        s.keyEvents = events;
        s.nextEventId = Math.max(0, ...events.map(e => e.id||0)) + 1;
        const newCount = events.length - oldCount;
        if (newCount > 0) {
          save(); updatePrompt(); updateMeta(); renderTabContent();
          $st.css('color','#34d399').text('✅ +' + newCount + ' новых (всего ' + events.length + ')');
          toast('Добавлено ' + newCount + ' событий', '#34d399', () => {
            s.keyEvents = JSON.parse(snap);
            s.nextEventId = Math.max(0, ...s.keyEvents.map(e => e.id||0)) + 1;
            save(); updatePrompt(); updateMeta(); renderTabContent();
          });
        } else {
          $st.css('color','#f59e0b').text('Новых событий не найдено');
        }
      } catch(e) { $st.css('color','#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled',false).text('✦ Сканировать');
    });

    // ── Condense events (AI) ──────────────────────────────────────────
    $('#calt_condense_btn').off('click').on('click', async function() {
      const $btn = $(this), $st = $('#calt_scan_ev_status');
      const s = getSettings();
      if (!s.keyEvents.length) { $st.css('color','#f59e0b').text('Нет событий для конденсации'); return; }

      // Safety gate: >80 events risks overflowing model context in a single call.
      // Redirect user to per-month buttons which send smaller chunks.
      const CHUNK_LIMIT = 80;
      if (s.keyEvents.length > CHUNK_LIMIT) {
        const months = [...new Set(s.keyEvents.map(e => extractMonth(e.date)).filter(Boolean))];
        $st.css('color','#f59e0b').html(
          '⚠ ' + s.keyEvents.length + ' событий — слишком много для одного запроса.<br>' +
          'Используйте кнопки <b>⚡</b> рядом с каждым месяцем — по одному за раз.'
        );
        // Expand all month groups so the ⚡ buttons are visible
        _collapsedMonths = {};
        renderTabContent();
        return;
      }

      const snap = JSON.stringify(s.keyEvents);
      $btn.prop('disabled',true).text('⚡ Конденсирую…');
      $st.css('color','#7a8499').text('AI сжимает таймлайн…');
      try {
        const input = s.keyEvents.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
        const condensed = await aiGenerate(
          'TIMELINE (' + s.keyEvents.length + ' entries):\n' + input + '\n\nCondense this timeline:',
          'You condense a roleplay timeline into fewer entries.\n\n' +
            'RULES:\n' +
            '- MERGE events on the same date into ONE line using → separator\n' +
            '- MERGE consecutive quiet days: [Days 5-8] quiet period, training\n' +
            '- KEEP all plot-critical facts: deaths, pacts, injuries, arrivals, departures\n' +
            '- DROP trivial details: outfit changes, casual dialogue, minor movements\n' +
            '- MAX 20 words per line. Telegraphic style.\n' +
            '- Output ONLY the condensed timeline, one [DATE] line per entry\n\n' +
            'EXAMPLE INPUT:\n' +
            '[3 Ossian] Selena goes to Great Hall\n' +
            '[3 Ossian] Verbal attack on Daron student\n' +
            '[3 Ossian] Etheric burns on hands\n' +
            '[3 Ossian] Moved to infirmary\n\n' +
            'EXAMPLE OUTPUT:\n' +
            '[3 Ossian] Great Hall → verbal attack on Daron student → etheric burns → infirmary'
        );
        let parsed = parseEventList(condensed, s.nextEventId);
        parsed = _mergeSameDate(parsed);
        if (parsed.length && parsed.length < s.keyEvents.length * 1.5) {
          _restoreMetadata(parsed, s.keyEvents);
          // Show preview in overlay before applying
          _showCondensePreview(parsed, snap, $st);
        } else {
          $st.css('color','#f59e0b').text('Конденсация не уменьшила список (' + parsed.length + ' → было ' + s.keyEvents.length + ')');
        }
      } catch(e) { $st.css('color','#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled',false).text('⚡ Конденсировать всё');
    });

    // ── Per-month condense (date picker) ─────────────────────────────────
    $('.calt-month-cond-btn').off('click').on('click', function(e) {
      e.stopPropagation();
      const month = $(this).data('month'), $btn = $(this);
      $btn.prop('disabled', true);
      openCondenseDatePicker(month, $btn);
    });

    function _showCondensePreview(parsed, snap, $st) {
      const s = getSettings();
      const oldCount = s.keyEvents.length, newCount = parsed.length;
      const previewText = parsed.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
      _closeOverlay();
      _openOverlay(
        '<div class="calt-edit-overlay calt-eopen"><div class="calt-edit-box">'
        + '<div class="calt-edit-hdr"><span>⚡ Конденсация: ' + oldCount + ' → ' + newCount + '</span><button class="calt-edit-x" id="calt_cond_x">✕</button></div>'
        + '<div class="calt-edit-body">'
        + '<textarea class="calt-etextarea" id="calt_cond_preview" rows="12" style="font-size:11px;line-height:1.4" readonly>' + esc(previewText) + '</textarea>'
        + '</div>'
        + '<div class="calt-edit-footer">'
        + '<button class="menu_button" id="calt_cond_cancel">Отмена</button>'
        + '<button class="menu_button calt-save-btn" id="calt_cond_apply">✅ Применить</button>'
        + '</div></div></div>'
      );
      $('#calt_cond_x,#calt_cond_cancel').on('click', () => {
        _closeOverlay();
        $st.css('color','#4a5568').text('Отменено');
      });
      $('#calt_cond_apply').on('click', () => {
        s.keyEvents = parsed;
        s.nextEventId = Math.max(0, ...parsed.map(e => e.id||0)) + 1;
        // Refresh summary snaps for all months that appear in the condensed result
        // so "устарело" badges don't show up immediately after applying
        const affectedMonths = new Set(parsed.map(e => extractMonth(e.date)).filter(Boolean));
        affectedMonths.forEach(m => saveSummarySnap(m));
        save(); updatePrompt(); updateMeta(); renderTabContent();
        _closeOverlay();
        $st.css('color','#34d399').text('✅ Сжато: ' + oldCount + ' → ' + newCount);
        toast('Таймлайн сжат: ' + oldCount + ' → ' + newCount, '#a78bfa', () => {
          s.keyEvents = JSON.parse(snap);
          s.nextEventId = Math.max(0, ...s.keyEvents.map(e => e.id||0)) + 1;
          save(); updatePrompt(); updateMeta(); renderTabContent();
        });
      });
    }

    // ── Scan deadlines ────────────────────────────────────────────────
    $('#calt_scan_dl_btn').off('click').on('click', async function() {
      const $btn=$(this), $st=$('#calt_scan_dl_status'), depth=+$('#calt_scan_dl_depth').val()||20;
      $btn.prop('disabled',true).text('Сканирую…'); $st.css('color','#7a8499').text('Анализирую…');
      try {
        const s=getSettings(), snap=JSON.stringify(s.deadlines);
        const oldCount = s.deadlines.length;
        const deadlines = await scanDeadlines(depth);
        s.deadlines = deadlines;
        s.nextDeadlineId = Math.max(0, ...deadlines.map(e => e.id||0)) + 1;
        const newCount = deadlines.length - oldCount;
        if (newCount > 0) {
          save(); updatePrompt(); updateMeta(); renderTabContent();
          $st.css('color','#34d399').text('✅ +' + newCount + ' новых');
          toast('Добавлено ' + newCount + ' дедлайнов', '#fbbf24', () => {
            s.deadlines = JSON.parse(snap);
            s.nextDeadlineId = Math.max(0, ...s.deadlines.map(e => e.id||0)) + 1;
            save(); updatePrompt(); updateMeta(); renderTabContent();
          });
        } else { $st.css('color','#f59e0b').text('Новых не найдено'); }
      } catch(e) { $st.css('color','#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled',false).text('✦ Сканировать');
    });

    // ── Rules tab bindings ────────────────────────────────────────────────
    if (activeTab === 'rules') bindRulesEvents();
  }

  // ─── Rules bindings ───────────────────────────────────────────────────────
  function bindRulesEvents() {

    // Section collapse — direct binding on each header (not document delegation).
    $(document).off('click.cfgsec');
    $('#calt_tab_body').find('.calt-sec-toggle').off('click.cfgsec').on('click.cfgsec', function(e) {
      // Ignore clicks on action buttons inside/adjacent to header
      if ($(e.target).closest('[data-rules-action]').length) return;
      const sec = $(this).data('sec');
      _collapsedSections[sec] = !_collapsedSections[sec];
      // Use closest+find — works regardless of whether add-row sits between header and body
      $(this).closest('.calt-cfg-section').find('.calt-cfg-sec-body').slideToggle(160);
      $(this).find('.calt-sec-chev2').text(_collapsedSections[sec] ? '▸' : '▾');
    });

    // Rules action handler — bound DIRECTLY to each element (no document delegation).
    // Document delegation was unreliable on mobile ST because ST intercepts events.
    function _applyRulesAction(el) {
      // Do NOT call syncDraftFromDOM() here — input handlers already keep
      // _cfgDraft current. Calling it here would overwrite _cfgDraft with whatever
      // empty values are currently in DOM if the section was stale.
      if (!_cfgDraft) _cfgDraft = JSON.parse(JSON.stringify(getSettings().calendarConfig));

      const action = el.getAttribute('data-rules-action') || '';
      const idx    = parseInt(el.getAttribute('data-idx'))  || 0;
      const mi     = parseInt(el.getAttribute('data-moon')) || 0;

      // Auto-expand target section on add
      const sectionAutoExpand = {
        'add-month':'months', 'add-wd':'week', 'add-moon':'moons', 'add-phase':'moons',
      };
      if (sectionAutoExpand[action]) _collapsedSections[sectionAutoExpand[action]] = false;

      if      (action==='add-month')                                        { _cfgDraft.months.push({name:'',days:30,season:'',recurringNote:''}); }
      else if (action==='del-month')                                        { _cfgDraft.months.splice(idx,1); }
      else if (action==='mv-month-up' && idx>0)                            { const a=_cfgDraft.months; [a[idx],a[idx-1]]=[a[idx-1],a[idx]]; }
      else if (action==='mv-month-dn' && idx<_cfgDraft.months.length-1)   { const a=_cfgDraft.months; [a[idx],a[idx+1]]=[a[idx+1],a[idx]]; }
      else if (action==='add-wd')                                           { _cfgDraft.weekDays.push({name:'',note:''}); }
      else if (action==='del-wd')                                           { _cfgDraft.weekDays.splice(idx,1); }
      else if (action==='mv-wd-up' && idx>0)                               { const a=_cfgDraft.weekDays; [a[idx],a[idx-1]]=[a[idx-1],a[idx]]; }
      else if (action==='mv-wd-dn' && idx<_cfgDraft.weekDays.length-1)    { const a=_cfgDraft.weekDays; [a[idx],a[idx+1]]=[a[idx+1],a[idx]]; }
      else if (action==='add-moon')                                         { _cfgDraft.moons.push({name:'',nickname:'',cycleDays:28,refDate:'',refPhaseIndex:0,phases:[]}); }
      else if (action==='del-moon')                                         { _cfgDraft.moons.splice(mi,1); }
      else if (action==='add-phase' && _cfgDraft.moons[mi])                { _cfgDraft.moons[mi].phases.push({name:'',days:7,note:''}); }
      else if (action==='del-phase' && _cfgDraft.moons[mi])                { const pi=parseInt(el.getAttribute('data-idx'))||0; _cfgDraft.moons[mi].phases.splice(pi,1); }
      else if (action==='mv-ph-up'  && _cfgDraft.moons[mi])               { const pi=parseInt(el.getAttribute('data-idx'))||0, a=_cfgDraft.moons[mi].phases; if(pi>0) [a[pi],a[pi-1]]=[a[pi-1],a[pi]]; }
      else if (action==='mv-ph-dn'  && _cfgDraft.moons[mi])               { const pi=parseInt(el.getAttribute('data-idx'))||0, a=_cfgDraft.moons[mi].phases; if(pi<a.length-1) [a[pi],a[pi+1]]=[a[pi+1],a[pi]]; }
      else return;

      saveDraftToSession();
      renderTabContent();
    }

    // Delegate on #calt_tab_body — our own container.
    // More reliable than document delegation (ST can intercept at document level)
    // and more reliable than direct binding (no stopPropagation issues).
    $(document).off('click.calt_rules');
    $('#calt_tab_body')
      .off('click.calt_rules')
      .on('click.calt_rules', '[data-rules-action]', function(e) {
        e.stopPropagation();
        _applyRulesAction(this);
      });

    // Input → sync draft (delegate on same container)
    $(document).off('input.cfgdirty');
    $('#calt_tab_body')
      .off('input.cfgdirty')
      .on('input.cfgdirty',
        '.calt-cfg-inp-sm,.calt-cfg-inp-lg,.calt-cfg-inp-xs,.calt-cfg-sel,' +
        '.calt-moon-name,.calt-moon-nickname,.calt-moon-cycle,.calt-moon-ref-date,.calt-moon-ref-phase,' +
        '#calt_rules_edit',
        () => { syncDraftFromDOM(); }
      );

    // Save rules
    $('#calt_rules_save_btn').off('click').on('click', async () => {
      syncDraftFromDOM();
      const s = getSettings();
      s.calendarConfig = JSON.parse(JSON.stringify(_cfgDraft));
      s.calendarRules  = $('#calt_rules_edit').val();
      _cfgDirty = false; updateDirtyBadge();
      clearDraftFromSession();
      save(); await updatePrompt();
      // Refresh month dropdowns everywhere now that config changed
      syncModalDate();
      renderDate3('#calt_date3_panel','calt_p_day','calt_p_month','calt_p_year',
        s.currentDay, s.currentMonthName, s.currentYear);
      bindPanelDate3();
      toast('Правила сохранены', '#a78bfa');
      $('#calt_scan_rules_status').css('color','#34d399').text('✅ Сохранено');
    });

    // Extract calendar rules from lorebook
    $('#calt_rules_extract_btn').off('click').on('click', async function() {
      const $btn = $(this), $st = $('#calt_scan_rules_status');
      $btn.prop('disabled',true).text('Извлекаю…'); $st.css('color','#7a8499').text('Анализирую…');
      try {
        const lore = getLorebook();
        if (!lore) {
          $st.css('color','#f59e0b').text('Лорбук пуст');
          $btn.prop('disabled',false).text('✦ Извлечь из лорбука'); return;
        }
        const r = await aiGenerate(
          'LOREBOOK:\n' + lore.slice(0,5000) + '\n\nExtract calendar rules:',
          'Extract ONLY timekeeping info: calendar name, era, months with days/seasons, weekday names, moon phases. ' +
            'Format: [Key: value]. Max 30 lines. Preserve original names. No markdown.'
        );
        $('#calt_rules_edit').val(r.trim()); syncDraftFromDOM();
        $st.css('color','#34d399').text('✅ Извлечено — нажмите Сохранить');
        toast('Правила извлечены', '#a78bfa');
      } catch(e) { $st.css('color','#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled',false).text('✦ Извлечь из лорбука');
    });
  }

  // ─── Inline edit ──────────────────────────────────────────────────────────
  function startInlineEdit($span, id, type) {
    if ($span.find('input').length) return;
    const original = $span.text();
    $span.html('<input class="calt-inline-inp" value="' + esc(original) + '" style="width:100%">');
    const $inp = $span.find('input').focus().select();
    const commit = () => {
      const val = $inp.val().trim();
      if (!val || val === original) { $span.text(original); return; }
      const s = getSettings(), arr = type === 'event' ? s.keyEvents : s.deadlines;
      const item = arr.find(e => e.id === id);
      if (item) { item.text = val; save(); updatePrompt(); }
      $span.text(val);
    };
    $inp.on('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') $span.text(original);
    });
    $inp.on('blur', commit);
  }

  // ─── Tag picker ───────────────────────────────────────────────────────────
  function openTagPicker(id, type, $btn) {
    $('.calt-tag-picker').remove();
    const s = getSettings(), arr = type === 'event' ? s.keyEvents : s.deadlines;
    const item = arr.find(e => e.id === id); if (!item) return;
    if (!Array.isArray(item.tags)) item.tags = [];

    const html = TAGS.map(t => {
      const active = item.tags.includes(t.key);
      return '<button class="calt-tag-opt' + (active?' calt-tag-opt-active':'') + '" data-key="' + t.key + '" style="border-color:' + t.color + ';color:' + t.color + '">' + t.label + '</button>';
    }).join('');

    const $p = $('<div class="calt-tag-picker">' + html + '</div>');
    $('body').append($p);
    const off = $btn.offset();
    $p.css({ top:(off.top + $btn.outerHeight() + 4) + 'px', left:Math.max(8, off.left - 80) + 'px' });

    $p.on('click', '.calt-tag-opt', function() {
      const k = $(this).data('key'), idx = item.tags.indexOf(k);
      if (idx === -1) item.tags.push(k); else item.tags.splice(idx,1);
      save(); renderTabContent(); $p.remove();
    });
    setTimeout(() => { $(document).one('click', () => $p.remove()); }, 50);
  }

  // ─── Deadline type picker ─────────────────────────────────────────────────
  function openDeadlineTypePicker(id, $btn) {
    $('.calt-tag-picker').remove();
    const s = getSettings();
    const item = s.deadlines.find(e => e.id === id); if (!item) return;
    const html = DEADLINE_TYPES.map(t => {
      const active = (item.dtype || 'event') === t.key;
      return '<button class="calt-tag-opt' + (active?' calt-tag-opt-active':'') + '" data-key="' + t.key + '" style="border-color:' + t.color + ';color:' + t.color + '">' + t.label + '</button>';
    }).join('');
    const $p = $('<div class="calt-tag-picker">' + html + '</div>');
    $('body').append($p);
    const off = $btn.offset();
    $p.css({ top:(off.top + $btn.outerHeight() + 4) + 'px', left:Math.max(8, off.left - 80) + 'px' });
    $p.on('click', '.calt-tag-opt', function() {
      item.dtype = $(this).data('key');
      save(); updatePrompt(); renderTabContent(); $p.remove();
    });
    setTimeout(() => { $(document).one('click', () => $p.remove()); }, 50);
  }

  // ─── Summary edit overlay ─────────────────────────────────────────────────
  function openSummaryEdit(month) {
    const curr = getSettings().monthSummaries[month] || '';
    _closeOverlay();
    _openOverlay(
      '<div class="calt-edit-overlay calt-eopen"><div class="calt-edit-box">'
      + '<div class="calt-edit-hdr"><span>📝 Саммери — ' + esc(month) + '</span><button class="calt-edit-x" id="calt_summ_x">✕</button></div>'
      + '<div class="calt-edit-body">'
      + '<div class="calt-elabel">Краткое описание периода</div>'
      + '<textarea class="calt-etextarea" id="calt_summ_text" rows="4">' + esc(curr) + '</textarea>'
      + '<div style="font-size:10px;color:#3d4a60;margin-top:5px">1-2 предложения. Инжектируется вместо детальных событий.</div>'
      + '</div>'
      + '<div class="calt-edit-footer">'
      + '<button class="menu_button" id="calt_summ_cancel">Отмена</button>'
      + '<button class="menu_button calt-save-btn" id="calt_summ_save">💾 Сохранить</button>'
      + '</div></div></div>'
    );
    $('#calt_summ_x,#calt_summ_cancel').on('click', () => _closeOverlay());
    $('#calt_summ_save').on('click', async () => {
      getSettings().monthSummaries[month] = $('#calt_summ_text').val().trim();
      saveSummarySnap(month);
      save(); await updatePrompt(); renderTabContent();
      _closeOverlay(); toast('Саммери сохранено', '#a78bfa');
    });
  }

  // ─── Edit modal ───────────────────────────────────────────────────────────
  function openEditModal(id, type) {
    const s = getSettings(), arr = type === 'event' ? s.keyEvents : s.deadlines;
    const item = arr.find(e => e.id === id); if (!item) return;
    const isDl = type === 'deadline';
    const titleField = isDl
      ? '<div class="calt-elabel" style="margin-top:8px">Название (опционально)</div>'
        + '<input class="calt-einput" id="calt_edit_title" value="' + esc(item.title||'') + '" placeholder="Краткое название">'
      : '';
    _closeOverlay();
    _openOverlay(
      '<div class="calt-edit-overlay calt-eopen"><div class="calt-edit-box">'
      + '<div class="calt-edit-hdr"><span>' + (type==='event'?'⚔ Редактировать событие':'⏳ Редактировать дедлайн') + '</span><button class="calt-edit-x" id="calt_edit_x">✕</button></div>'
      + '<div class="calt-edit-body">'
      + '<div class="calt-elabel">Дата</div>'
      + '<div class="calt-date3-row" id="calt_edit_date3"></div>'
      + titleField
      + '<div class="calt-elabel" style="margin-top:8px">Описание</div>'
      + '<textarea class="calt-etextarea" id="calt_edit_text">' + esc(item.text) + '</textarea>'
      + '</div>'
      + '<div class="calt-edit-footer">'
      + '<button class="menu_button" id="calt_edit_cancel">Отмена</button>'
      + '<button class="menu_button calt-save-btn" id="calt_edit_save">💾 Сохранить</button>'
      + '</div></div></div>'
    );
    // Render date3 inside edit modal
    const dp = parseDateString(item.date || '');
    renderDate3('#calt_edit_date3', 'calt_edit_day', 'calt_edit_month', 'calt_edit_year', dp.day, dp.month, dp.year);

    $('#calt_edit_x,#calt_edit_cancel').on('click', () => _closeOverlay());
    $('#calt_edit_save').on('click', () => {
      const ed = $('#calt_edit_day').val().trim();
      const em = $('#calt_edit_month').val().trim();
      const ey = $('#calt_edit_year').val().trim();
      const d = buildDateString(ed, em, ey);
      const t = $('#calt_edit_text').val().trim();
      if (!t) return;
      item.date = d; item.text = t;
      if (isDl) item.title = ($('#calt_edit_title').val() || '').trim();
      save(); updatePrompt(); updateMeta(); renderTabContent();
      _closeOverlay(); toast('Сохранено', '#34d399');
    });
    $('#calt_edit_text').on('keydown', e => { if (e.key==='Enter' && e.ctrlKey) $('#calt_edit_save').click(); });
  }

  // ─── Export / Import ──────────────────────────────────────────────────────
  function exportData() {
    const s = getSettings();
    const blob = new Blob([JSON.stringify({
      currentDate:s.currentDate, currentDay:s.currentDay,
      currentMonthName:s.currentMonthName, currentYear:s.currentYear,
      keyEvents:s.keyEvents, deadlines:s.deadlines,
      calendarRules:s.calendarRules, calendarConfig:s.calendarConfig,
      monthSummaries:s.monthSummaries, monthSummarySnaps:s.monthSummarySnaps,
      manualHotMonths:s.manualHotMonths, manualColdMonths:s.manualColdMonths,
      depthRules:s.depthRules, depthDeadlines:s.depthDeadlines, depthTimeline:s.depthTimeline,
      deadlineHorizon:s.deadlineHorizon,
      autoScanThreshold:s.autoScanThreshold,
      customApiEndpoint:s.customApiEndpoint, customApiModel:s.customApiModel,
    }, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'calendar_tracker_' + Date.now() + '.json';
    a.click();
    toast('Данные экспортированы', '#34d399');
  }

  function importData() {
    const inp = document.createElement('input'); inp.type='file'; inp.accept='.json';
    inp.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const data = JSON.parse(ev.target.result), s = getSettings();
          if (data.currentDate)        s.currentDate        = data.currentDate;
          if (data.currentDay)         s.currentDay         = data.currentDay;
          if (data.currentMonthName)   s.currentMonthName   = data.currentMonthName;
          if (data.currentYear)        s.currentYear        = data.currentYear;
          // Migrate old exports that only had currentDate
          if (s.currentDate && !s.currentDay) {
            const p = parseDateString(s.currentDate);
            s.currentDay = p.day; s.currentMonthName = p.month; s.currentYear = p.year;
          }
          if (Array.isArray(data.keyEvents))       s.keyEvents       = data.keyEvents;
          if (Array.isArray(data.deadlines))        s.deadlines       = data.deadlines;
          if (data.calendarRules)                   s.calendarRules   = data.calendarRules;
          if (data.calendarConfig && typeof data.calendarConfig==='object') s.calendarConfig = data.calendarConfig;
          if (data.monthSummaries  && typeof data.monthSummaries==='object') s.monthSummaries  = data.monthSummaries;
          if (data.monthSummarySnaps)               s.monthSummarySnaps = data.monthSummarySnaps;
          if (Array.isArray(data.manualHotMonths))  s.manualHotMonths = data.manualHotMonths;
          if (Array.isArray(data.manualColdMonths)) s.manualColdMonths = data.manualColdMonths;
          if (data.depthRules !== undefined)    s.depthRules    = data.depthRules;
          if (data.depthDeadlines !== undefined) s.depthDeadlines = data.depthDeadlines;
          if (data.depthTimeline !== undefined)  s.depthTimeline  = data.depthTimeline;
          if (data.deadlineHorizon !== undefined) s.deadlineHorizon = data.deadlineHorizon;
          if (data.autoScanThreshold !== undefined) s.autoScanThreshold = data.autoScanThreshold;
          if (data.customApiEndpoint !== undefined) s.customApiEndpoint = data.customApiEndpoint;
          if (data.customApiModel !== undefined) s.customApiModel = data.customApiModel;
          // Recalculate safe nextIds (prevents NaN and duplicate IDs)
          s.nextEventId    = Math.max(0, ...s.keyEvents.map(e => e.id||0)) + 1;
          s.nextDeadlineId = Math.max(0, ...s.deadlines.map(e => e.id||0)) + 1;
          // Reset draft — calendarConfig may have changed
          _cfgDraft = null; clearDraftFromSession();
          save(); updatePrompt(); updateMeta(); refreshSettingsUi(); syncModalDate(); renderTabContent();
          toast('Данные импортированы', '#34d399');
        } catch(err) { toast('Ошибка импорта — неверный формат', '#f87171'); }
      };
      reader.readAsText(file);
    };
    inp.click();
  }

  // ─── Smart autoscan ───────────────────────────────────────────────────────
  async function tryAutoScan() {
    const s = getSettings();
    if (!s.autoScan || !s.enabled) return;
    if (_autoScanRunning) return; // already in progress — skip, don't queue another
    const chat = ctx().chat || [];
    const threshold = s.autoScanThreshold || 3;
    if (chat.length <= _lastAutoLen || (chat.length - _lastAutoLen) < threshold) return;
    // Snapshot the length now — if more messages arrive while we're scanning, we'll
    // see them on the next call after this one finishes.
    const lenSnapshot = chat.length;
    clearTimeout(_autoScanTimer);
    _autoScanTimer = setTimeout(async () => {
      if (_autoScanRunning) return; // double-check inside the timeout
      _autoScanRunning = true;
      _lastAutoLen = lenSnapshot;
      try {
        const lastMsg = chat[chat.length - 1];
        const sig = await isMessageSignificant(lastMsg ? (lastMsg.mes||'') : '');
        if (!sig) return;
        const evSnap = JSON.stringify(s.keyEvents), dlSnap = JSON.stringify(s.deadlines);
        const oldEvCount = s.keyEvents.length, oldDlCount = s.deadlines.length;
        const [events, deadlines] = await Promise.all([
          scanKeyEvents(s.scanDepth),
          scanDeadlines(s.scanDepth),
        ]);
        const newEvCount = events.length - oldEvCount;
        const newDlCount = deadlines.length - oldDlCount;
        if (newEvCount > 0 || newDlCount > 0) {
          s.keyEvents = events;
          s.deadlines = deadlines;
          s.nextEventId = Math.max(0, ...events.map(e => e.id||0)) + 1;
          s.nextDeadlineId = Math.max(0, ...deadlines.map(e => e.id||0)) + 1;
          save(); updatePrompt(); updateMeta();
          if (_isModalOpen()) renderTabContent();
          const parts = [];
          if (newEvCount > 0) parts.push('+' + newEvCount + ' событий');
          if (newDlCount > 0) parts.push('+' + newDlCount + ' дедлайнов');
          toast('Автоскан: ' + parts.join(', '), '#34d399', () => {
            s.keyEvents  = JSON.parse(evSnap);
            s.deadlines  = JSON.parse(dlSnap);
            s.nextEventId    = Math.max(0, ...s.keyEvents.map(e => e.id||0)) + 1;
            s.nextDeadlineId = Math.max(0, ...s.deadlines.map(e => e.id||0)) + 1;
            save(); updatePrompt(); updateMeta();
            if (_isModalOpen()) renderTabContent();
          });
        }
      } catch(e) { console.warn('[CalTracker] autoscan error:', e.message); }
      finally    { _autoScanRunning = false; }
    }, 2000);
  }

  // ─── ST events + keyboard shortcut ───────────────────────────────────────
  function wireEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      mountSettingsUi(); await updatePrompt();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      _lastAutoLen = 0; _collapsedMonths = {}; _searchQuery = ''; _tagFilter = null;
      _cfgDraft = null; _cfgDirty = false; clearDraftFromSession();
      refreshSettingsUi(); await updatePrompt();
      if (_isModalOpen()) {
        syncModalDate(); // rebuild dropdown for new chat's calendarConfig
        renderTabContent();
      }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
      await updatePrompt(); await tryAutoScan();
    });

    if (event_types.GENERATION_ENDED) {
      eventSource.on(event_types.GENERATION_ENDED, async () => { await updatePrompt(); });
    }

    // Alt+T — open/close modal
    $(document).on('keydown.calt', e => {
      if (e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        if (_isModalOpen()) _hideModal();
        else openModal();
      }
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  jQuery(() => {
    try {
      wireEvents();
      // Sanitize day inputs: allow digits and a single dash (for ranges like "5-11")
      $(document).on('input.calt_day', '.calt-date3-day', function() {
        const raw = this.value;
        // Remove anything that isn't a digit or hyphen; collapse multiple hyphens
        let clean = raw.replace(/[^\d-]/g, '').replace(/-{2,}/g, '-');
        // Don't allow leading hyphen
        if (clean.startsWith('-')) clean = clean.slice(1);
        if (clean !== raw) {
          const pos = this.selectionStart - (raw.length - clean.length);
          this.value = clean;
          try { this.setSelectionRange(pos, pos); } catch(e) {}
        }
      });
      console.log('[Calendar Tracker v5.1] ✦ loaded');
    } catch(e) { console.error('[Calendar Tracker] init failed:', e); }
  });

})();
