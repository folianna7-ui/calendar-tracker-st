/**
 * Calendar Tracker v4.0 — SillyTavern Extension
 *
 * Fixes vs v3.0:
 *  [FIX]  Math.max on empty array → NaN id — now uses Math.max(0, ...)
 *  [FIX]  Rescan preserves tags + pinned via fuzzy text matching
 *  [FIX]  syncDraftFromDOM is top-level, called on every input — no data loss on blur
 *  [FIX]  Autoscan threshold: 10 → 3 messages
 *  [FIX]  Dead duplicate reorder handlers (click.mvmth/mvwd/mvph) removed
 *  [FIX]  Moon phase days=0 → Math.max(1,...) prevents infinite loop
 *  [FIX]  refPhaseIndex clamped to valid range
 *  [FIX]  scrollIntoView waits 200ms for slideDown to finish (was 150ms, anim is 160ms)
 *  [FIX]  CHAT_CHANGED syncs modal date + re-renders if modal is open
 *  [FIX]  Import recalculates nextEventId/nextDeadlineId safely
 *  [FIX]  Import resets _cfgDraft so Rules tab shows fresh calendarConfig
 *  [NEW]  SessionStorage draft autosave — survives page refresh, per-chat keyed
 *  [NEW]  Prompt active indicator: colored dot in settings header + modal token counter
 *  [NEW]  "Очистить данные" (🗑) button in modal footer with 8s undo window
 *  [NEW]  Hot events sorted chronologically in prompt
 *  [NEW]  DAY POSITION in prompt: "Day N of M in month · Day X of Y in year"
 *  [NEW]  TIME PASSED block between warm and deadlines layers
 *  [NEW]  Unsaved-draft inline hint in Rules tab footer
 *  [NEW]  Add buttons auto-expand their section on click
 */

(() => {
  'use strict';

  const MODULE_KEY   = 'calendar_tracker';
  const DRAFT_SS_KEY = 'calt_cfg_draft_v4';

  // ─── Module state ─────────────────────────────────────────────────────────
  let activeTab          = 'events';
  let _lastAutoLen       = 0;
  let _autoScanTimer     = null;
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
      if (!/^\d+$/.test(parts[i])) return parts[i];
    }
    return parts[parts.length - 1];
  }

  function currentMonth() { return extractMonth(getSettings().currentDate); }

  function buildDateString(d, m, y) { return [d, m, y].filter(Boolean).join(' '); }

  function parseDateString(str) {
    if (!str) return { day:'', month:'', year:'' };
    const parts = str.trim().split(/\s+/);
    let day = '', month = '', year = '';
    for (const p of parts) {
      if (/^\d+$/.test(p)) { if (!day) day = p; else year = p; }
      else month = p;
    }
    return { day, month, year };
  }

  // ─── Storage ──────────────────────────────────────────────────────────────
  function defaultCalendarConfig() {
    return { name:'', era:'', eraFrom:'', months:[], weekDays:[],
             weekRefDate:'', weekRefDayIndex:0, moons:[] };
  }

  function defaultSettings() {
    return {
      enabled: true,
      currentDate:'', currentDay:'', currentMonthName:'', currentYear:'',
      keyEvents:[], deadlines:[],
      calendarRules:'',
      calendarConfig: defaultCalendarConfig(),
      autoScan:false, scanDepth:20, injectionDepth:0,
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
    if (!s.calendarConfig || typeof s.calendarConfig !== 'object') s.calendarConfig = defaultCalendarConfig();
    const cc = s.calendarConfig;
    if (!Array.isArray(cc.months))   cc.months   = [];
    if (!Array.isArray(cc.weekDays)) cc.weekDays = [];
    if (!Array.isArray(cc.moons))    cc.moons    = [];
    cc.moons.forEach(m => { if (!Array.isArray(m.phases)) m.phases = []; });
    s.keyEvents.forEach(e => {
      if (e.pinned === undefined) e.pinned = false;
      if (!Array.isArray(e.tags)) e.tags = [];
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
            moonName:      moon.name,
            nickname:      moon.nickname || '',
            phaseName:     moon.phases[i].name,
            phaseNote:     moon.phases[i].note || '',
            daysRemaining: cum + pd - raw,
            nextPhase:     moon.phases[nextIdx].name,
          });
          break;
        }
        cum += pd;
      }
    });
    return results;
  }

  // ─── Summary tracking ─────────────────────────────────────────────────────
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
  function syncDraftFromDOM() {
    _cfgDirty = true;
    updateDirtyBadge();
    if (!_cfgDraft) _cfgDraft = JSON.parse(JSON.stringify(getSettings().calendarConfig));
    if (!$('#cfg_name').length) return; // Rules tab not rendered — nothing to read

    _cfgDraft.name    = $('#cfg_name').val().trim();
    _cfgDraft.era     = $('#cfg_era').val().trim();
    _cfgDraft.eraFrom = $('#cfg_erafrom').val().trim();

    _cfgDraft.months = [];
    $('#cfg_months_list .calt-month-row').each(function() {
      _cfgDraft.months.push({
        name:          $(this).find('[data-field="name"]').val().trim(),
        days:          parseInt($(this).find('[data-field="days"]').val(), 10) || 30,
        season:        $(this).find('[data-field="season"]').val().trim(),
        recurringNote: $(this).find('[data-field="recurringNote"]').val().trim(),
      });
    });

    _cfgDraft.weekDays = [];
    $('#cfg_wd_list .calt-wd-row').each(function() {
      _cfgDraft.weekDays.push({
        name: $(this).find('[data-field="name"]').val().trim(),
        note: $(this).find('[data-field="note"]').val().trim(),
      });
    });
    _cfgDraft.weekRefDate     = $('#cfg_week_ref_date').val().trim();
    _cfgDraft.weekRefDayIndex = parseInt($('#cfg_week_ref_day').val(), 10) || 0;

    $('#cfg_moons_list .calt-moon-card').each(function() {
      const mi   = +$(this).data('moon');
      const moon = _cfgDraft.moons[mi];
      if (!moon) return;
      moon.name      = $(this).find('.calt-moon-name').val().trim();
      moon.nickname  = $(this).find('.calt-moon-nickname').val().trim();
      moon.cycleDays = parseInt($(this).find('.calt-moon-cycle').val(), 10) || 28;
      moon.refDate   = $(this).find('.calt-moon-ref-date').val().trim();
      moon.refPhaseIndex = parseInt($(this).find('.calt-moon-ref-phase').val(), 10) || 0;
      moon.phases = [];
      $(this).find('.calt-phase-row').each(function() {
        moon.phases.push({
          name: $(this).find('[data-field="name"]').val().trim(),
          days: Math.max(1, parseInt($(this).find('[data-field="days"]').val(), 10) || 1),
          note: $(this).find('[data-field="note"]').val().trim(),
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
    const lines = [];
    if (cc.name) lines.push('[Calendar: ' + cc.name + ']');
    if (cc.era)  lines.push('[Era: ' + cc.era + (cc.eraFrom ? ' — ' + cc.eraFrom : '') + ']');
    if (cc.months.length) {
      const seasons = {}, ord = [];
      cc.months.forEach(m => {
        const sn = m.season || '—';
        if (!seasons[sn]) { seasons[sn] = []; ord.push(sn); }
        seasons[sn].push(m.name + '(' + (m.days||30) + 'd' + (m.recurringNote ? '; ' + m.recurringNote : '') + ')');
      });
      lines.push('[Months: ' + ord.map(sn => sn + ': ' + seasons[sn].join(', ')).join(' | ') + ']');
    }
    if (cc.weekDays.length) {
      lines.push('[Week: ' + cc.weekDays.map(d => d.name + (d.note ? '(' + d.note + ')' : '')).join(' · ') + ']');
    }
    cc.moons.forEach(moon => {
      if (!moon.name) return;
      const phStr = moon.phases
        .map(p => p.name + '~' + Math.max(1, parseInt(p.days,10)||1) + 'd' + (p.note ? ': ' + p.note : ''))
        .join(' · ');
      lines.push('[Moon ' + moon.name + (moon.nickname ? ' "' + moon.nickname + '"' : '') +
        ': ' + (moon.cycleDays||28) + '-day cycle — ' + phStr + ']');
    });
    if (s.calendarRules && s.calendarRules.trim()) lines.push(s.calendarRules.trim());
    return lines.join('\n');
  }

  function buildPromptText() {
    const s = getSettings(), cc = s.calendarConfig, cm = currentMonth();
    const lines = ['[TIMELINE]'];

    // ── Current date block ────────────────────────────────────────────────
    if (s.currentDate) {
      lines.push('CURRENT DATE: ' + s.currentDate);
      const absDay = getCurrentAbsDay();
      if (absDay !== null) {
        // Day position in month and year
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
        // Day of week
        const dow = getDayOfWeek(absDay);
        if (dow) lines.push('DAY OF WEEK: ' + dow.name + (dow.note ? ' (' + dow.note + ')' : ''));
        // Moon phases
        getMoonPhases(absDay).forEach(mp => {
          lines.push('MOON ' + mp.moonName + ': ' + mp.phaseName +
            (mp.phaseNote ? ' — ' + mp.phaseNote : '') +
            ' (~' + mp.daysRemaining + ' дн. до ' + mp.nextPhase + ')');
        });
      }
    }

    // ── Current month recurring note ──────────────────────────────────────
    if (cm) {
      const curMo = cc.months.find(m => m.name.toLowerCase() === cm.toLowerCase());
      if (curMo && curMo.recurringNote) lines.push('THIS PERIOD: ' + curMo.recurringNote);
    }

    // ── HOT layer — sorted chronologically ────────────────────────────────
    const hotEvents = s.keyEvents
      .filter(e => e.pinned || isMonthHot(extractMonth(e.date) || ''))
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
        lines.push('• ' + (e.date ? '[' + e.date + '] ' : '') + e.text + pin);
      });
    }

    // ── WARM layer — summaries for past months ────────────────────────────
    const warmMonths = Object.keys(s.monthSummaries)
      .filter(m => !isMonthHot(m) && s.monthSummaries[m]?.trim());
    if (warmMonths.length) {
      lines.push('PAST PERIODS (summary):');
      warmMonths.forEach(m => lines.push('• [' + m + '] ' + s.monthSummaries[m].trim()));
    }

    // ── TIME PASSED — gap between latest past data and current month ──────
    if (cm && cc.months.length) {
      const currentMonthIdx = cc.months.findIndex(m => m.name.toLowerCase() === cm.toLowerCase());
      if (currentMonthIdx > 0) {
        // All months that have any events or summaries, excluding hot
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

    // ── Deadlines ─────────────────────────────────────────────────────────
    if (s.deadlines.length) {
      lines.push('UPCOMING EVENTS:');
      s.deadlines.forEach(e => {
        const approaching = cm && extractMonth(e.date) === cm;
        lines.push('• ' + (e.date ? '[' + e.date + '] ' : '') + e.text + (approaching ? ' ⚠ APPROACHING' : ''));
      });
    }

    const rules = buildCalendarRulesText();
    if (rules) { lines.push('CALENDAR RULES:'); lines.push(rules); }
    return lines.join('\n');
  }

  async function updatePrompt() {
    const s = getSettings();
    const { setExtensionPrompt, extension_prompt_types } = ctx();
    if (!setExtensionPrompt) { _promptActive = false; _updatePromptUI(); return; }
    const cc = s.calendarConfig || {};
    const hasContent = s.currentDate || s.keyEvents.length || s.deadlines.length ||
      s.calendarRules || cc.name || cc.months.length;
    if (!s.enabled || !hasContent) {
      setExtensionPrompt(MODULE_KEY, '', extension_prompt_types?.IN_PROMPT ?? 0, 0);
      _promptActive = false;
    } else {
      setExtensionPrompt(MODULE_KEY, buildPromptText(), extension_prompt_types?.IN_PROMPT ?? 0, s.injectionDepth||0);
      _promptActive = true;
    }
    _updatePromptUI();
  }

  function _updatePromptUI() {
    const color = _promptActive ? '#34d399' : '#4a5568';
    const title = _promptActive ? 'Промпт активен' : 'Промпт не активен';
    $('#calt_prompt_dot').css('color', color).attr('title', title);
    updateTokenCounter();
  }

  function updateTokenCounter() {
    if (_promptActive) {
      const tc = Math.ceil(buildPromptText().length / 4);
      $('#calt_modal_tokens').text('~' + tc + ' ткн').css('color','#34d399');
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
    return null;
  }

  async function aiGenerate(userPrompt, systemPrompt) {
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
    throw new Error('Нет активного подключения. Выбери Connection Profile в ST.');
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
  function _restoreMetadata(parsed, oldEvents) {
    const byDateText = {}, byText = {};
    oldEvents.forEach(e => {
      const dtKey = ((e.date||'') + '||' + e.text).toLowerCase();
      byDateText[dtKey] = e;
      const tk = e.text.toLowerCase().trim();
      if (!byText[tk]) byText[tk] = e;
    });
    parsed.forEach(e => {
      const dtKey = ((e.date||'') + '||' + e.text).toLowerCase();
      const tKey  = e.text.toLowerCase().trim();
      const old   = byDateText[dtKey] || byText[tKey];
      if (old) {
        e.pinned = old.pinned || false;
        e.tags   = [...(old.tags || [])];
        e.id     = old.id; // keep stable ID if same event
      }
    });
  }

  async function scanKeyEvents(depth) {
    const s = getSettings();
    const existing = s.keyEvents.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
    const lore = getLorebook();
    const result = await aiGenerate(
      'CHAT:\n' + (getChatContext(depth)||'(empty)') +
        (lore ? '\n\nLOREBOOK:\n' + lore.slice(0,3000) : '') +
        '\n\nOutput complete consolidated timeline:',
      'You are a chronicle archivist. Extract PLOT-CRITICAL past events.\n' +
        'OUTPUT: one line per date: [DATE] Event summary\n' +
        'RECORD: relationship/power changes, pacts, deaths, conflicts, rituals, revelations.\n' +
        'SKIP: casual dialogue, minor emotional moments.\n' +
        'CONSOLIDATE: update existing dates, never duplicate.\n\n' +
        (existing ? 'EXISTING:\n' + existing : 'No existing events.')
    );
    const parsed = parseEventList(result, s.nextEventId);
    _restoreMetadata(parsed, s.keyEvents);
    return parsed;
  }

  async function scanDeadlines(depth) {
    const s = getSettings();
    const existing = s.deadlines.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
    const past     = s.keyEvents.map(e => '[' + (e.date||'?') + '] ' + e.text).join('\n');
    const lore = getLorebook();
    const result = await aiGenerate(
      'CHAT:\n' + (getChatContext(depth)||'(empty)') +
        (lore ? '\n\nLOREBOOK:\n' + lore.slice(0,3000) : '') +
        '\n\nList upcoming events:',
      'Extract UPCOMING FUTURE EVENTS only. OUTPUT: [DATE] Brief description\n' +
        'RULES: only future, preserve existing, add new ones only.\n\n' +
        (existing ? 'EXISTING:\n' + existing + '\n\n' : '') +
        (past ? 'ALREADY HAPPENED (exclude):\n' + past : '')
    );
    return parseEventList(result, s.nextDeadlineId);
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
          <label class="calt-check-row"><input type="checkbox" id="calt_autoscan" style="accent-color:#fbbf24"><span>Авто-сканирование (каждые 3 сообщения)</span></label>
          <div class="calt-field-label">Текущая дата</div>
          <div class="calt-date3-row" id="calt_date3_panel"></div>
          <div class="calt-field-row" style="margin-top:6px">
            <span class="calt-flabel">Глубина инжекции</span>
            <input type="range" id="calt_depth_slider" min="0" max="15" step="1" style="flex:1;accent-color:#fbbf24;min-width:0">
            <span id="calt_depth_val" style="font-size:12px;color:#fbbf24;min-width:18px;text-align:right">0</span>
          </div>
          <div style="font-size:10px;color:#3d4a60;margin-top:1px">0 = конец промпта · 5 = за 5 сообщениями</div>
          <button class="menu_button calt-open-btn" id="calt_open_btn">📖 Открыть календарь</button>
          <div class="calt-sec" id="calt_conn_wrap">
            <div class="calt-sec-hdr" id="calt_conn_hdr"><span class="calt-sec-chev" id="calt_conn_chev">▸</span><span>🔌 Подключение</span></div>
            <div class="calt-sec-body" id="calt_conn_body" style="display:none">
              <div class="calt-conn-status">
                <span class="calt-conn-dot" id="calt_conn_dot" style="color:#fbbf24">●</span>
                <span class="calt-conn-label" id="calt_conn_label">Активный профиль ST</span>
              </div>
              <p class="calt-conn-hint">Использует активный Connection Profile из ST.</p>
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
    let _dt = {};
    const deb = (k, fn) => { clearTimeout(_dt[k]); _dt[k] = setTimeout(fn, 400); };
    $('#calt_depth_slider').on('input', function() {
      const v = +this.value; $('#calt_depth_val').text(v);
      deb('dep', async () => { getSettings().injectionDepth = v; save(); await updatePrompt(); });
    });
    $('#calt_test_btn').on('click', async () => {
      const $s = $('#calt_test_status'); $s.css('color','#7a8499').text('Тестирую…');
      try {
        const r = await aiGenerate('Reply: OK', 'Reply: OK');
        $s.css('color','#34d399').text('✅ ' + r.trim().slice(0,50));
      } catch(e) { $s.css('color','#f87171').text('✗ ' + e.message); }
    });
    $('#calt_open_btn').on('click touchend', function(e) { e.preventDefault(); openModal(); });
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
      '<input class="calt-date3-day" id="' + idDay + '" type="number" min="1" max="99" value="' + esc(valDay||'') + '" placeholder="Д">' +
      monthInp +
      '<input class="calt-date3-year" id="' + idYear + '" type="number" min="1" value="' + esc(valYear||'') + '" placeholder="Год">'
    );
  }

  function refreshSettingsUi() {
    const s = getSettings(), depth = s.injectionDepth||0, name = getActiveProfileName();
    $('#calt_enabled').prop('checked', s.enabled !== false);
    $('#calt_autoscan').prop('checked', !!s.autoScan);
    $('#calt_depth_slider').val(depth); $('#calt_depth_val').text(depth);
    $('#calt_conn_label').text(name || 'Активный профиль ST');
    $('#calt_conn_dot').css('color', name ? '#34d399' : '#fbbf24');
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
  function _showModal()  { $('#calt_modal').addClass('calt-mopen').css('display','flex'); }
  function _hideModal()  { $('#calt_modal').removeClass('calt-mopen').css('display','none'); }

  function openModal() {
    if ($('#calt_modal').length) {
      _showModal();
      syncModalDate(); renderTabContent(); return;
    }

    $(document.body).append(`
      <div class="calt-modal" id="calt_modal">
        <div class="calt-modal-inner">
          <div class="calt-drag-handle"></div>
          <div class="calt-modal-hdr">
            <span class="calt-modal-icon">🗓</span>
            <span class="calt-modal-title">Calendar Tracker</span>
            <div class="calt-modal-date-wrap">
              <span class="calt-modal-date-label">Дата:</span>
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
            <button class="menu_button calt-foot-btn" id="calt_export_btn">💾 Экспорт</button>
            <button class="menu_button calt-foot-btn" id="calt_import_btn">📥 Импорт</button>
            <button class="menu_button calt-foot-btn calt-foot-clear" id="calt_clear_btn" title="Очистить все события и даты этого чата">🗑 Очистить</button>
            <button class="menu_button calt-foot-btn calt-foot-close" id="calt_modal_close2">Закрыть</button>
          </div>
        </div>
      </div>`);

    syncModalDate();
    _showModal();

    $('#calt_modal_close,#calt_modal_close2').on('click touchend', function(e) { e.preventDefault(); _hideModal(); });
    $('#calt_modal').on('click', e => {
      if ($(e.target).is('#calt_modal') && window.innerWidth > 600)
        _hideModal();
    });

    $('#calt_tabs').on('click', '.calt-tab', function() {
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

    $('#calt_export_btn').on('click', exportData);
    $('#calt_import_btn').on('click', importData);
    $('#calt_clear_btn').on('click', clearChatData);
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
    const dateBadge = e.date
      ? '<span class="calt-ev-date">' + esc(e.date) + '</span>'
      : '<span class="calt-ev-date calt-ev-date-empty">—</span>';
    const tagsHtml = (e.tags && e.tags.length)
      ? '<div class="calt-ev-tags">' + e.tags.map(k => {
          const t = tagByKey(k);
          return t ? '<span class="calt-tag" data-tagkey="' + k + '" style="border-color:' + t.color + ';color:' + t.color + '">' + t.label + '</span>' : '';
        }).join('') + '</div>'
      : '';
    const pinClass = e.pinned ? ' calt-ev-pin-active' : '';
    return '<div class="calt-ev-row" data-id="' + e.id + '" data-type="' + type + '">'
      + '<div class="calt-ev-left">' + dateBadge
      + '<div class="calt-ev-content">'
      + '<span class="calt-ev-text" data-id="' + e.id + '" data-type="' + type + '">' + esc(e.text) + '</span>'
      + tagsHtml + '</div></div>'
      + '<div class="calt-ev-acts">'
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
      getMoonPhases(absDay).forEach(mp =>
        parts.push('🌙 ' + mp.phaseName + ' (~' + mp.daysRemaining + ' до ' + mp.nextPhase + ')')
      );
      if (parts.length) calInfoHtml = '<div class="calt-cal-info">' + parts.join(' · ') + '</div>';
    }

    // Filter events
    const filtered = s.keyEvents.filter(e => {
      if (_searchQuery && !(e.text + ' ' + e.date).toLowerCase().includes(_searchQuery.toLowerCase())) return false;
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
      + '<input class="calt-add-date" id="calt_add_ev_date" placeholder="Дата">'
      + '<input class="calt-add-txt" id="calt_add_ev_txt" placeholder="Описание события...">'
      + '<button class="calt-add-btn" id="calt_add_ev_btn">+ Добавить</button>'
      + '</div>'
      + '<div class="calt-scan-row">'
      + '<span class="calt-scan-lbl">Сканировать</span>'
      + '<input type="number" class="calt-depth-inp" id="calt_scan_ev_depth" value="' + s.scanDepth + '" min="5" max="200">'
      + '<span class="calt-scan-unit">сообщений</span>'
      + '<button class="menu_button calt-scan-btn" id="calt_scan_ev_btn">✦ Сканировать</button>'
      + '</div>'
      + '<div class="calt-scan-status" id="calt_scan_ev_status"></div>';
  }

  // ─── Deadlines tab ────────────────────────────────────────────────────────
  function buildDeadlinesTab() {
    const s = getSettings(), cm = currentMonth();
    let listHtml = '';
    if (!s.deadlines.length) {
      listHtml = '<div class="calt-empty">Дедлайнов нет.</div>';
    } else {
      s.deadlines.forEach(e => {
        const approaching = cm && extractMonth(e.date) === cm;
        const db = e.date
          ? '<span class="calt-ev-date' + (approaching?' calt-ev-date-urgent':'') + '">' + (approaching?'⚠ ':'') + esc(e.date) + '</span>'
          : '<span class="calt-ev-date calt-ev-date-empty">—</span>';
        listHtml += '<div class="calt-ev-row" data-id="' + e.id + '" data-type="deadline">'
          + '<div class="calt-ev-left">' + db
          + '<div class="calt-ev-content"><span class="calt-ev-text" data-id="' + e.id + '" data-type="deadline">' + esc(e.text) + '</span></div></div>'
          + '<div class="calt-ev-acts">'
          + '<button class="calt-ev-btn calt-ev-edit" data-id="' + e.id + '" data-type="deadline">✎</button>'
          + '<button class="calt-ev-btn calt-ev-del" data-id="' + e.id + '" data-type="deadline">✕</button>'
          + '</div></div>';
      });
    }
    return '<div class="calt-list-wrap"><div class="calt-list">' + listHtml + '</div></div>'
      + '<div class="calt-add-row">'
      + '<input class="calt-add-date" id="calt_add_dl_date" placeholder="Дата">'
      + '<input class="calt-add-txt" id="calt_add_dl_txt" placeholder="Грядущее событие...">'
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
    let monthsRows = '<div class="calt-cfg-row calt-cfg-thead"><span></span><span>Название</span><span>Дней</span><span>Сезон</span><span>Ежегодные события</span><span></span></div>';
    cc.months.forEach((m, i) => {
      monthsRows += '<div class="calt-cfg-row calt-month-row" data-idx="' + i + '">'
        + '<div class="calt-reorder-btns">'
        + '<button class="calt-reorder-btn" data-rules-action="mv-month-up" data-idx="' + i + '">↑</button>'
        + '<button class="calt-reorder-btn" data-rules-action="mv-month-dn" data-idx="' + i + '">↓</button>'
        + '</div>'
        + '<input class="calt-cfg-inp-sm" data-field="name" placeholder="Название" value="' + esc(m.name||'') + '">'
        + '<input class="calt-cfg-inp-xs" type="number" min="1" max="400" data-field="days" placeholder="Дн" value="' + esc(m.days||'') + '">'
        + '<input class="calt-cfg-inp-sm" data-field="season" placeholder="Сезон" value="' + esc(m.season||'') + '">'
        + '<input class="calt-cfg-inp-lg" data-field="recurringNote" placeholder="Ежегодные события..." value="' + esc(m.recurringNote||'') + '">'
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

    // ── Pin ───────────────────────────────────────────────────────────────
    $('.calt-ev-pin').off('click').on('click', function() {
      const id = +$(this).data('id'), s = getSettings();
      const item = s.keyEvents.find(e => e.id === id); if (!item) return;
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
    $('#calt_add_ev_btn').off('click').on('click', () => {
      const date = $('#calt_add_ev_date').val().trim(), text = $('#calt_add_ev_txt').val().trim();
      if (!text) { $('#calt_add_ev_txt').focus(); return; }
      const s = getSettings(); s.keyEvents.push({ id:s.nextEventId++, date, text, pinned:false, tags:[] });
      save(); updatePrompt(); updateMeta();
      $('#calt_add_ev_date').val(''); $('#calt_add_ev_txt').val('');
      renderTabContent();
    });
    $('#calt_add_ev_txt').off('keydown').on('keydown', e => { if (e.key==='Enter') $('#calt_add_ev_btn').click(); });

    // ── Add deadline ──────────────────────────────────────────────────────
    $('#calt_add_dl_btn').off('click').on('click', () => {
      const date = $('#calt_add_dl_date').val().trim(), text = $('#calt_add_dl_txt').val().trim();
      if (!text) { $('#calt_add_dl_txt').focus(); return; }
      const s = getSettings(); s.deadlines.push({ id:s.nextDeadlineId++, date, text });
      save(); updatePrompt(); updateMeta();
      $('#calt_add_dl_date').val(''); $('#calt_add_dl_txt').val('');
      renderTabContent();
    });
    $('#calt_add_dl_txt').off('keydown').on('keydown', e => { if (e.key==='Enter') $('#calt_add_dl_btn').click(); });

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
        const events = await scanKeyEvents(depth);
        if (events.length) {
          s.keyEvents = events;
          s.nextEventId = Math.max(0, ...events.map(e => e.id||0)) + 1;
          save(); updatePrompt(); updateMeta(); renderTabContent();
          $st.css('color','#34d399').text('✅ ' + events.length + ' событий');
          toast('Таймлайн обновлён', '#34d399', () => {
            s.keyEvents = JSON.parse(snap);
            s.nextEventId = Math.max(0, ...s.keyEvents.map(e => e.id||0)) + 1;
            save(); updatePrompt(); updateMeta(); renderTabContent();
          });
        } else { $st.css('color','#f59e0b').text('Новых событий не найдено'); }
      } catch(e) { $st.css('color','#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled',false).text('✦ Сканировать');
    });

    // ── Scan deadlines ────────────────────────────────────────────────────
    $('#calt_scan_dl_btn').off('click').on('click', async function() {
      const $btn=$(this), $st=$('#calt_scan_dl_status'), depth=+$('#calt_scan_dl_depth').val()||20;
      $btn.prop('disabled',true).text('Сканирую…'); $st.css('color','#7a8499').text('Анализирую…');
      try {
        const s=getSettings(), snap=JSON.stringify(s.deadlines);
        const deadlines = await scanDeadlines(depth);
        if (deadlines.length) {
          s.deadlines = deadlines;
          s.nextDeadlineId = Math.max(0, ...deadlines.map(e => e.id||0)) + 1;
          save(); updatePrompt(); updateMeta(); renderTabContent();
          $st.css('color','#34d399').text('✅ ' + deadlines.length);
          toast('Дедлайны обновлены', '#fbbf24', () => {
            s.deadlines = JSON.parse(snap);
            s.nextDeadlineId = Math.max(0, ...s.deadlines.map(e => e.id||0)) + 1;
            save(); updatePrompt(); updateMeta(); renderTabContent();
          });
        } else { $st.css('color','#f59e0b').text('Не найдено'); }
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

  // ─── Summary edit overlay ─────────────────────────────────────────────────
  function openSummaryEdit(month) {
    const curr = getSettings().monthSummaries[month] || '';
    $('.calt-edit-overlay').remove();
    $('body').append(
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
    $('#calt_summ_x,#calt_summ_cancel').on('click', () => $('.calt-edit-overlay').remove());
    $('#calt_summ_save').on('click', async () => {
      getSettings().monthSummaries[month] = $('#calt_summ_text').val().trim();
      saveSummarySnap(month);
      save(); await updatePrompt(); renderTabContent();
      $('.calt-edit-overlay').remove(); toast('Саммери сохранено', '#a78bfa');
    });
  }

  // ─── Edit modal ───────────────────────────────────────────────────────────
  function openEditModal(id, type) {
    const s = getSettings(), arr = type === 'event' ? s.keyEvents : s.deadlines;
    const item = arr.find(e => e.id === id); if (!item) return;
    $('.calt-edit-overlay').remove();
    $('body').append(
      '<div class="calt-edit-overlay calt-eopen"><div class="calt-edit-box">'
      + '<div class="calt-edit-hdr"><span>' + (type==='event'?'⚔ Редактировать событие':'⏳ Редактировать дедлайн') + '</span><button class="calt-edit-x" id="calt_edit_x">✕</button></div>'
      + '<div class="calt-edit-body">'
      + '<div class="calt-elabel">Дата</div>'
      + '<input class="calt-einput" id="calt_edit_date" value="' + esc(item.date||'') + '" placeholder="напр. 23 Naeris 1000">'
      + '<div class="calt-elabel" style="margin-top:8px">Описание</div>'
      + '<textarea class="calt-etextarea" id="calt_edit_text">' + esc(item.text) + '</textarea>'
      + '</div>'
      + '<div class="calt-edit-footer">'
      + '<button class="menu_button" id="calt_edit_cancel">Отмена</button>'
      + '<button class="menu_button calt-save-btn" id="calt_edit_save">💾 Сохранить</button>'
      + '</div></div></div>'
    );
    $('#calt_edit_x,#calt_edit_cancel').on('click', () => $('.calt-edit-overlay').remove());
    $('#calt_edit_save').on('click', () => {
      const d = $('#calt_edit_date').val().trim(), t = $('#calt_edit_text').val().trim();
      if (!t) return; item.date = d; item.text = t;
      save(); updatePrompt(); updateMeta(); renderTabContent();
      $('.calt-edit-overlay').remove(); toast('Сохранено', '#34d399');
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
    const chat = ctx().chat || [];
    // Threshold: 3 new messages (was 10 — too high for short sessions)
    if (chat.length <= _lastAutoLen || (chat.length - _lastAutoLen) < 3) return;
    _lastAutoLen = chat.length;
    clearTimeout(_autoScanTimer);
    _autoScanTimer = setTimeout(async () => {
      try {
        const lastMsg = chat[chat.length - 1];
        const sig = await isMessageSignificant(lastMsg ? (lastMsg.mes||'') : '');
        if (!sig) return;
        const evSnap = JSON.stringify(s.keyEvents), dlSnap = JSON.stringify(s.deadlines);
        const [events, deadlines] = await Promise.all([
          scanKeyEvents(s.scanDepth),
          scanDeadlines(s.scanDepth),
        ]);
        let changed = false;
        if (events.length) {
          s.keyEvents = events;
          s.nextEventId = Math.max(0, ...events.map(e => e.id||0)) + 1;
          changed = true;
        }
        if (deadlines.length) {
          s.deadlines = deadlines;
          s.nextDeadlineId = Math.max(0, ...deadlines.map(e => e.id||0)) + 1;
          changed = true;
        }
        if (changed) {
          save(); updatePrompt(); updateMeta();
          if ($('#calt_modal').is(':visible')) renderTabContent();
          toast('Таймлайн обновлён автоматически', '#34d399', () => {
            s.keyEvents  = JSON.parse(evSnap);
            s.deadlines  = JSON.parse(dlSnap);
            s.nextEventId    = Math.max(0, ...s.keyEvents.map(e => e.id||0)) + 1;
            s.nextDeadlineId = Math.max(0, ...s.deadlines.map(e => e.id||0)) + 1;
            save(); updatePrompt(); updateMeta();
            if ($('#calt_modal').is(':visible')) renderTabContent();
          });
        }
      } catch(e) { console.warn('[CalTracker] autoscan error:', e.message); }
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
      if ($('#calt_modal').is(':visible')) {
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
        if ($('#calt_modal').is(':visible')) _hideModal();
        else openModal();
      }
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  jQuery(() => {
    try { wireEvents(); console.log('[Calendar Tracker v4.0] ✦ loaded'); }
    catch(e) { console.error('[Calendar Tracker] init failed:', e); }
  });

})();
