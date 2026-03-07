/**
 * Calendar Tracker v2.0 — SillyTavern Extension
 *
 * v2.0 improvements:
 *  1. Per-chat storage (chat_metadata) — каждый чат имеет свой таймлайн
 *  2. Layered prompt: hot (текущий месяц + pinned) / warm (саммери) / cold (скрыто)
 *  3. Month summaries + pin events
 *  4. Deadline urgency markers (APPROACHING)
 *  5. Configurable injection depth
 *  6. Smart autoscan — проверка значимости перед полным сканом
 */

(() => {
  'use strict';

  const MODULE_KEY = 'calendar_tracker';

  // ─── State ────────────────────────────────────────────────────────────────

  let activeTab        = 'events';
  let _lastAutoLen     = 0;
  let _autoScanTimer   = null;
  let _collapsedMonths = {};

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function extractMonth(dateStr) {
    if (!dateStr || !dateStr.trim()) return null;
    const parts = dateStr.trim().split(/\s+/);
    // Find the rightmost non-numeric word (skip year numbers like "1000", "301")
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!/^\d+$/.test(parts[i])) return parts[i];
    }
    return parts[parts.length - 1];
  }

  function currentMonth() {
    return extractMonth(getSettings().currentDate);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Per-chat storage ─────────────────────────────────────────────────────

  function defaultSettings() {
    return {
      enabled:        true,
      currentDate:    '',
      keyEvents:      [],
      deadlines:      [],
      calendarRules:  '',
      autoScan:       false,
      scanDepth:      20,
      injectionDepth: 0,
      monthSummaries: {},
      manualHotMonths: [],   // months manually forced into hot layer
      manualColdMonths: [],  // months manually forced out of hot layer
      nextEventId:    1,
      nextDeadlineId: 1,
    };
  }

  /**
   * Storage: tries chat_metadata (per-chat) first, falls back to extensionSettings (global).
   * Falls back when saveMetadata is unavailable — common in some ST builds.
   */
  function _usePerChat() {
    try {
      const c = ctx();
      return !!(c.chat_metadata && typeof c.saveMetadata === 'function');
    } catch(e) { return false; }
  }

  function getSettings() {
    const c = ctx();
    let store;

    if (_usePerChat()) {
      if (!c.chat_metadata[MODULE_KEY]) c.chat_metadata[MODULE_KEY] = defaultSettings();
      store = c.chat_metadata[MODULE_KEY];
    } else {
      if (!c.extensionSettings[MODULE_KEY])
        c.extensionSettings[MODULE_KEY] = defaultSettings();
      store = c.extensionSettings[MODULE_KEY];
    }

    if (!Array.isArray(store.keyEvents))  store.keyEvents  = [];
    if (!Array.isArray(store.deadlines))  store.deadlines  = [];
    if (!store.monthSummaries || typeof store.monthSummaries !== 'object') store.monthSummaries = {};
    if (!Array.isArray(store.manualHotMonths))  store.manualHotMonths  = [];
    if (!Array.isArray(store.manualColdMonths)) store.manualColdMonths = [];
    if (!store.nextEventId)    store.nextEventId    = store.keyEvents.length  + 1;
    if (!store.nextDeadlineId) store.nextDeadlineId = store.deadlines.length + 1;
    if (store.injectionDepth === undefined) store.injectionDepth = 0;
    store.keyEvents.forEach(function(e) { if (e.pinned === undefined) e.pinned = false; });
    return store;
  }

  function save() {
    const c = ctx();
    try {
      if (_usePerChat()) {
        c.saveMetadata();
      } else if (typeof c.saveSettingsDebounced === 'function') {
        c.saveSettingsDebounced();
      }
    } catch(e) { console.warn('[CalTracker] save failed:', e.message); }
  }

  // ─── Layered prompt ───────────────────────────────────────────────────────

  function buildPromptText() {
    const s  = getSettings();
    const cm = currentMonth();
    const lines = ['[TIMELINE]'];

    if (s.currentDate) lines.push('CURRENT DATE: ' + s.currentDate);

    // HOT — current month + pinned from any month
    const hotEvents = s.keyEvents.filter(function(e) {
      if (e.pinned) return true;
      if (!cm) return true;
      return extractMonth(e.date) === cm;
    });

    if (hotEvents.length) {
      lines.push('KEY EVENTS (current period):');
      hotEvents.forEach(function(e) {
        const pinMark = (e.pinned && extractMonth(e.date) !== cm) ? ' [📌]' : '';
        lines.push('• ' + (e.date ? '[' + e.date + '] ' : '') + e.text + pinMark);
      });
    }

    // WARM — past month summaries
    const summaryMonths = Object.keys(s.monthSummaries).filter(function(m) {
      return m !== cm && s.monthSummaries[m] && s.monthSummaries[m].trim();
    });

    if (summaryMonths.length) {
      lines.push('PAST PERIODS (summary):');
      summaryMonths.forEach(function(m) {
        lines.push('• [' + m + '] ' + s.monthSummaries[m].trim());
      });
    }

    // Deadlines with urgency
    if (s.deadlines.length) {
      lines.push('UPCOMING EVENTS:');
      s.deadlines.forEach(function(e) {
        const dlMonth     = extractMonth(e.date);
        const approaching = cm && dlMonth && dlMonth === cm;
        const marker      = approaching ? ' ⚠ APPROACHING' : '';
        lines.push('• ' + (e.date ? '[' + e.date + '] ' : '') + e.text + marker);
      });
    }

    if (s.calendarRules) {
      lines.push('CALENDAR RULES:');
      lines.push(s.calendarRules);
    }

    return lines.join('\n');
  }

  async function updatePrompt() {
    const s = getSettings();
    const { setExtensionPrompt, extension_prompt_types } = ctx();
    if (!setExtensionPrompt) return;
    const hasContent = s.currentDate || s.keyEvents.length || s.deadlines.length || s.calendarRules;
    if (!s.enabled || !hasContent) {
      setExtensionPrompt(MODULE_KEY, '', extension_prompt_types?.IN_PROMPT ?? 0, 0);
      return;
    }
    setExtensionPrompt(
      MODULE_KEY,
      buildPromptText(),
      extension_prompt_types?.IN_PROMPT ?? 0,
      s.injectionDepth || 0
    );
  }

  // ─── AI generation ────────────────────────────────────────────────────────

  function extractText(data) {
    if (data?.choices?.[0]?.message?.content !== undefined) return data.choices[0].message.content;
    if (data?.choices?.[0]?.text             !== undefined) return data.choices[0].text;
    if (typeof data?.response === 'string')  return data.response;
    if (Array.isArray(data?.content)) {
      const t = data.content.find(function(b) { return b.type === 'text'; });
      return t?.text ?? null;
    }
    if (typeof data?.content === 'string') return data.content;
    return null;
  }

  async function aiGenerate(userPrompt, systemPrompt) {
    const c = ctx();
    const fullPrompt = systemPrompt + '\n\n---\n\n' + userPrompt;

    if (typeof c.generateRaw === 'function') {
      try {
        const r = await c.generateRaw(fullPrompt, '', false, false, '', 'normal');
        if (r?.trim()) return r;
      } catch (e) { console.warn('[CalTracker] generateRaw failed:', e.message); }
    }

    const endpoints = [
      { url: '/api/backends/chat-completions/generate',
        body: function() { return { messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], stream: false }; } },
      { url: '/api/generate',
        body: function() { return { prompt: fullPrompt, max_new_tokens: 1500, stream: false }; } },
      { url: '/generate',
        body: function() { return { prompt: fullPrompt, max_new_tokens: 1500, stream: false }; } },
    ];

    for (const ep of endpoints) {
      try {
        const resp = await fetch(ep.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body()),
        });
        if (!resp.ok) continue;
        const text = extractText(await resp.json());
        if (text?.trim()) return text;
      } catch (err) { /* try next */ }
    }

    throw new Error('Нет активного подключения. Выбери Connection Profile в ST.');
  }

  // ─── Context ──────────────────────────────────────────────────────────────

  function getChatContext(depth) {
    const chat = ctx().chat || [];
    return chat.slice(-depth)
      .map(function(m) { return '[' + (m.is_user ? 'USER' : 'CHAR') + ']: ' + (m.mes || '').slice(0, 600); })
      .join('\n\n');
  }

  function getLorebook() {
    try {
      const c = ctx();
      const wi = c.worldInfoData || c.worldInfo || {};
      const entries = [];
      Object.values(wi).forEach(function(book) {
        const src = book?.entries || book;
        if (src && typeof src === 'object')
          Object.values(src).forEach(function(e) { if (e?.content) entries.push(String(e.content)); });
      });
      return entries.join('\n\n');
    } catch (err) { return ''; }
  }

  // ─── Parse AI output ──────────────────────────────────────────────────────

  function parseEventList(text, startId) {
    if (!text) return [];
    let id = startId || Date.now();
    const events = [];
    const lines = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^(EXISTING|ALREADY|KEY EVENTS|UPCOMING|OUTPUT|FORMAT|RULES|STRICT|NOTE|PAST|CURRENT)/i.test(line)) continue;
      const clean = line.replace(/^[-•*\d.]\s*/, '');
      const m = clean.match(/^\[([^\]]+)\]\s+(.+)$/);
      if (m) {
        events.push({ id: id++, date: m[1].trim(), text: m[2].trim(), pinned: false });
      } else if (clean.length > 4 && !clean.startsWith('#') && !clean.startsWith('[')) {
        events.push({ id: id++, date: '', text: clean, pinned: false });
      }
    }
    return events;
  }

  // ─── Scan: Key Events ─────────────────────────────────────────────────────

  async function scanKeyEvents(depth) {
    const s = getSettings();
    const chatCtx  = getChatContext(depth);
    const loreCtx  = getLorebook();
    const existing = s.keyEvents.map(function(e) { return '[' + (e.date || '?') + '] ' + e.text; }).join('\n');

    const sys = 'You are a strict chronicle archivist for a roleplay story. Extract PLOT-CRITICAL past events.\n\n'
      + 'OUTPUT FORMAT — one line per DATE. Merge all events of the same date into ONE entry:\n'
      + '[DATE] Event1; Event2\n\n'
      + 'RECORD only:\n'
      + 'YES: Events that permanently change power, relationships, or status (pacts, betrayals, deaths, promotions)\n'
      + 'YES: Physical conflict, injury, life-threatening situations, rescues\n'
      + 'YES: Major decisions, arrivals, escapes, rituals, forbidden magic\n'
      + 'YES: Revelations of secrets, hidden lore, character origins\n\n'
      + 'SKIP:\n'
      + 'NO: Casual conversation without plot consequence\n'
      + 'NO: Emotional expressions without permanent story impact\n'
      + 'NO: Duplicate descriptions of already-captured events\n\n'
      + 'CONSOLIDATION RULE: If a date from EXISTING list appears below → UPDATE that line, never create a duplicate.\n\n'
      + (existing ? 'EXISTING ENTRIES (update or preserve — do NOT duplicate):\n' + existing : 'No existing events yet.');

    const usr = 'RECENT CHAT (last ' + depth + ' messages):\n' + (chatCtx || '(empty)')
      + (loreCtx ? '\n\nLOREBOOK:\n' + loreCtx.slice(0, 3000) : '')
      + '\n\nOutput the complete consolidated timeline:';

    const result = await aiGenerate(usr, sys);
    const parsed = parseEventList(result, s.nextEventId);

    // Preserve pinned status from existing events by matching date+text
    const pinnedKeys = {};
    s.keyEvents.forEach(function(e) { if (e.pinned) pinnedKeys[e.date + '||' + e.text] = true; });
    parsed.forEach(function(e) {
      if (pinnedKeys[e.date + '||' + e.text]) e.pinned = true;
    });

    return parsed;
  }

  // ─── Scan: Deadlines ─────────────────────────────────────────────────────

  async function scanDeadlines(depth) {
    const s = getSettings();
    const chatCtx  = getChatContext(depth);
    const loreCtx  = getLorebook();
    const existing = s.deadlines.map(function(e) { return '[' + (e.date || '?') + '] ' + e.text; }).join('\n');
    const past     = s.keyEvents.map(function(e) { return '[' + (e.date || '?') + '] ' + e.text; }).join('\n');

    const sys = 'You are a timeline analyst for a roleplay story. Extract UPCOMING FUTURE EVENTS only.\n\n'
      + 'OUTPUT — one event per line:\n[DATE] Brief description\n\n'
      + 'RULES:\n'
      + '- Only future/planned events not yet happened\n'
      + '- Do NOT include anything from the past events list below\n'
      + '- Preserve all existing deadlines, only ADD truly new ones\n'
      + '- No headers, no markdown, only event lines\n\n'
      + (existing ? 'EXISTING DEADLINES (preserve):\n' + existing + '\n\n' : '')
      + (past     ? 'ALREADY HAPPENED (exclude):\n' + past         : '');

    const usr = 'RECENT CHAT (last ' + depth + ' messages):\n' + (chatCtx || '(empty)')
      + (loreCtx ? '\n\nLOREBOOK:\n' + loreCtx.slice(0, 3000) : '')
      + '\n\nList all upcoming/planned events:';

    const result = await aiGenerate(usr, sys);
    return parseEventList(result, s.nextDeadlineId);
  }

  // ─── Month summary generation ─────────────────────────────────────────────

  async function generateMonthSummary(month) {
    const s = getSettings();
    const monthEvents = s.keyEvents
      .filter(function(e) { return extractMonth(e.date) === month; })
      .map(function(e) { return (e.date ? '[' + e.date + '] ' : '') + e.text; })
      .join('\n');

    if (!monthEvents) throw new Error('Нет событий для ' + month);

    const sys = 'You are a story chronicler. Write a 1-2 sentence summary of the most plot-consequential events of this period. '
      + 'Focus only on permanent changes: relationships formed/broken, power shifts, major decisions, discoveries. '
      + 'Be extremely concise — this text will be injected into every AI prompt. Past tense, no headers, no lists.';

    return await aiGenerate('Events of ' + month + ':\n' + monthEvents + '\n\nWrite a 1-2 sentence summary:', sys);
  }

  // ─── Smart autoscan: significance check ──────────────────────────────────

  async function isMessageSignificant(message) {
    if (!message || message.trim().length < 20) return false;
    const sys = 'You are a story event filter. Reply with ONLY "YES" or "NO". '
      + 'Determine if this roleplay message contains a PLOT-SIGNIFICANT event: '
      + 'a permanent change, revelation, conflict, ritual, pact, or major decision. '
      + 'Casual dialogue = NO. Action with plot consequences = YES.';
    try {
      const result = await aiGenerate('Message: ' + message.slice(0, 600) + '\n\nPlot-significant? (YES/NO)', sys);
      return result.trim().toUpperCase().startsWith('Y');
    } catch (err) {
      return true; // on error, assume significant — better to scan unnecessarily than miss events
    }
  }

  // ─── Toast ────────────────────────────────────────────────────────────────

  let _toastTimer = null;

  function toast(msg, color, undoFn) {
    color = color || '#34d399';
    clearTimeout(_toastTimer);
    $('.calt-toast').remove();
    const undoBtn = undoFn ? '<button class="calt-toast-undo">↩ Отменить</button>' : '';
    $('body').append(
      '<div class="calt-toast"><div class="calt-toast-row">'
      + '<span class="calt-toast-dot" style="background:' + color + '"></span>'
      + '<span class="calt-toast-msg">' + msg + '</span>'
      + undoBtn + '</div></div>'
    );
    const $t = $('.calt-toast');
    setTimeout(function() { $t.addClass('calt-in'); }, 10);
    if (undoFn) $t.find('.calt-toast-undo').on('click', function() { undoFn(); $t.remove(); });
    _toastTimer = setTimeout(function() {
      $t.addClass('calt-out');
      setTimeout(function() { $t.remove(); }, 300);
    }, 4500);
  }

  // ─── Settings panel ───────────────────────────────────────────────────────

  function getActiveProfileName() {
    try {
      const c = ctx();
      return c.connectionManager?.selectedProfile?.name
          || c.currentConnectionProfile?.name
          || c.activeProfile?.name
          || c.mainApi || c.apiType || null;
    } catch (err) { return null; }
  }

  function mountSettingsUi() {
    if ($('#calt_block').length) return;
    const $ext = $('#extensions_settings2, #extensions_settings').first();
    if (!$ext.length) return;

    $ext.append(
      '<div class="calt-block" id="calt_block">'
      + '<div class="calt-hdr" id="calt_hdr">'
      + '<span class="calt-gem">🗓</span>'
      + '<span class="calt-title">Calendar Tracker</span>'
      + '<span class="calt-badge" id="calt_badge" style="display:none">0</span>'
      + '<span class="calt-chev" id="calt_chev">▾</span>'
      + '</div>'
      + '<div class="calt-body" id="calt_body">'
      + '<div class="calt-meta" id="calt_meta">нет данных</div>'

      + '<label style="margin-top:8px;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#94a3b8">'
      + '<input type="checkbox" id="calt_enabled" style="accent-color:#fbbf24"><span>Включено (инжект в промпт)</span></label>'

      + '<label style="margin-top:5px;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#94a3b8">'
      + '<input type="checkbox" id="calt_autoscan" style="accent-color:#fbbf24"><span>Авто-сканирование</span></label>'

      + '<div class="calt-field-row" style="margin-top:8px">'
      + '<span class="calt-flabel">Текущая дата</span>'
      + '<input class="calt-text-input" id="calt_current_date" placeholder="напр. 23 Naeris">'
      + '</div>'

      + '<div class="calt-field-row" style="margin-top:6px">'
      + '<span class="calt-flabel">Глубина инжекции</span>'
      + '<div style="display:flex;align-items:center;gap:7px;flex:1;min-width:0">'
      + '<input type="range" id="calt_depth_slider" min="0" max="15" step="1" style="flex:1;accent-color:#fbbf24;min-width:0">'
      + '<span id="calt_depth_val" style="font-size:12px;color:#fbbf24;min-width:18px;text-align:right;flex-shrink:0">0</span>'
      + '</div></div>'
      + '<div style="font-size:10px;color:#3d4a60;padding-left:2px;margin-top:1px">0 = конец промпта · 5 = за 5 сообщениями до конца</div>'

      + '<button class="menu_button calt-open-btn" id="calt_open_btn">📖 Открыть календарь</button>'

      + '<div class="calt-sec">'
      + '<div class="calt-sec-hdr" id="calt_conn_hdr"><span class="calt-sec-chev" id="calt_conn_chev">▸</span><span>🔌 Подключение</span></div>'
      + '<div class="calt-sec-body" id="calt_conn_body" style="display:none">'
      + '<div class="calt-conn-status"><span class="calt-conn-dot" id="calt_conn_dot" style="color:#fbbf24">●</span><span class="calt-conn-label" id="calt_conn_label">Активный профиль ST</span></div>'
      + '<p class="calt-conn-hint">Расширение использует активный Connection Profile из ST. Ничего настраивать не нужно.</p>'
      + '<button class="menu_button calt-test-btn" id="calt_test_btn">⚡ Тест подключения</button>'
      + '<div class="calt-api-status" id="calt_test_status"></div>'
      + '</div></div>'

      + '</div></div>'
    );

    refreshSettingsUi();

    $('#calt_hdr').on('click', function() {
      const $b = $('#calt_body');
      $b.slideToggle(180);
      $('#calt_chev').text($b.is(':visible') ? '▾' : '▸');
    });

    $('#calt_conn_hdr').on('click', function() {
      const $b = $('#calt_conn_body');
      $b.slideToggle(150);
      $('#calt_conn_chev').text($b.is(':visible') ? '▾' : '▸');
      const name = getActiveProfileName();
      $('#calt_conn_label').text(name || 'Активный профиль ST');
      $('#calt_conn_dot').css('color', name ? '#34d399' : '#fbbf24');
    });

    $('#calt_enabled').on('change', function() { getSettings().enabled = this.checked; save(); updatePrompt(); });
    $('#calt_autoscan').on('change', function() { getSettings().autoScan = this.checked; save(); });

    let _db = {};
    const deb = function(k, fn) { clearTimeout(_db[k]); _db[k] = setTimeout(fn, 420); };

    $('#calt_current_date').on('input', function() {
      const val = this.value;
      deb('cd', async function() {
        getSettings().currentDate = val.trim();
        $('#calt_modal_date').val(val.trim());
        save(); updateMeta(); await updatePrompt();
      });
    });

    $('#calt_depth_slider').on('input', function() {
      const v = +this.value;
      $('#calt_depth_val').text(v);
      deb('dep', async function() { getSettings().injectionDepth = v; save(); await updatePrompt(); });
    });

    $('#calt_test_btn').on('click', async function() {
      const $s = $('#calt_test_status');
      $s.css('color', '#7a8499').text('Тестирую…');
      try {
        const res = await aiGenerate('Reply with exactly one word: OK', 'Reply with exactly one word: OK');
        $s.css('color', '#34d399').text('✅ ' + res.trim().slice(0, 50));
      } catch (e) { $s.css('color', '#f87171').text('✗ ' + e.message); }
    });

    $('#calt_open_btn').on('click', openModal);
  }

  function refreshSettingsUi() {
    const s     = getSettings();
    const depth = s.injectionDepth || 0;
    const name  = getActiveProfileName();
    $('#calt_enabled').prop('checked', s.enabled !== false);
    $('#calt_autoscan').prop('checked', !!s.autoScan);
    $('#calt_current_date').val(s.currentDate || '');
    $('#calt_depth_slider').val(depth);
    $('#calt_depth_val').text(depth);
    $('#calt_conn_label').text(name || 'Активный профиль ST');
    $('#calt_conn_dot').css('color', name ? '#34d399' : '#fbbf24');
    updateBadge();
    updateMeta();
  }

  function updateBadge() {
    const s = getSettings();
    const n = s.keyEvents.length + s.deadlines.length;
    $('#calt_badge').text(n);
    if (n > 0) $('#calt_badge').show(); else $('#calt_badge').hide();
  }

  function updateMeta() {
    const s = getSettings();
    const parts = [];
    if (s.keyEvents.length)  parts.push(s.keyEvents.length + ' событий');
    if (s.deadlines.length)  parts.push(s.deadlines.length + ' дедлайнов');
    if (s.currentDate)       parts.push(s.currentDate);
    $('#calt_meta').text(parts.join(' · ') || 'нет данных');
    updateBadge();
  }

  // ─── Modal ────────────────────────────────────────────────────────────────

  function openModal() {
    if ($('#calt_modal').length) {
      $('#calt_modal').addClass('calt-mopen');
      renderTabContent();
      return;
    }

    $('body').append(
      '<div class="calt-modal" id="calt_modal">'
      + '<div class="calt-modal-inner">'
      + '<div class="calt-drag-handle"></div>'
      + '<div class="calt-modal-hdr">'
      + '<span class="calt-modal-icon">🗓</span>'
      + '<span class="calt-modal-title">Calendar Tracker</span>'
      + '<div class="calt-modal-date-wrap">'
      + '<span class="calt-modal-date-label">Текущая дата:</span>'
      + '<input class="calt-modal-date-inp" id="calt_modal_date" placeholder="напр. 23 Naeris">'
      + '</div>'
      + '<button class="calt-modal-x" id="calt_modal_close">✕</button>'
      + '</div>'
      + '<div class="calt-tabs" id="calt_tabs">'
      + '<button class="calt-tab active" data-tab="events">⚔ Key Events</button>'
      + '<button class="calt-tab" data-tab="deadlines">⏳ Deadlines</button>'
      + '<button class="calt-tab" data-tab="rules">📜 Правила</button>'
      + '</div>'
      + '<div class="calt-tab-body" id="calt_tab_body"></div>'
      + '<div class="calt-modal-footer">'
      + '<button class="menu_button calt-foot-btn" id="calt_export_btn">💾 Экспорт</button>'
      + '<button class="menu_button calt-foot-btn" id="calt_import_btn">📥 Импорт</button>'
      + '<button class="menu_button calt-foot-btn calt-foot-close" id="calt_modal_close2">Закрыть</button>'
      + '</div>'
      + '</div></div>'
    );

    $('#calt_modal_date').val(getSettings().currentDate || '');
    $('#calt_modal').addClass('calt-mopen');

    $('#calt_modal_close, #calt_modal_close2').on('click', function() { $('#calt_modal').removeClass('calt-mopen'); });
    $('#calt_modal').on('click', function(e) {
      if ($(e.target).is('#calt_modal') && window.innerWidth > 600) $('#calt_modal').removeClass('calt-mopen');
    });

    let _ddb = null;
    $('#calt_modal_date').on('input', function() {
      const val = this.value;
      clearTimeout(_ddb);
      _ddb = setTimeout(async function() {
        getSettings().currentDate = val.trim();
        $('#calt_current_date').val(val.trim());
        save(); updateMeta(); await updatePrompt();
      }, 400);
    });

    $('#calt_tabs').on('click', '.calt-tab', function() {
      $('#calt_tabs .calt-tab').removeClass('active');
      $(this).addClass('active');
      activeTab = $(this).data('tab');
      renderTabContent();
    });

    $('#calt_export_btn').on('click', exportData);
    $('#calt_import_btn').on('click', importData);
    renderTabContent();
  }

  // ─── Tab rendering ────────────────────────────────────────────────────────

  function renderTabContent() {
    const $b = $('#calt_tab_body');
    if (!$b.length) return;
    if      (activeTab === 'events')    $b.html(buildEventsTab());
    else if (activeTab === 'deadlines') $b.html(buildDeadlinesTab());
    else if (activeTab === 'rules')     $b.html(buildRulesTab());
    bindTabEvents();
  }

  function eventRow(e, type) {
    const dateBadge = e.date
      ? '<span class="calt-ev-date">' + esc(e.date) + '</span>'
      : '<span class="calt-ev-date calt-ev-date-empty">—</span>';
    const pinActive = e.pinned ? ' calt-ev-pin-active' : '';
    return '<div class="calt-ev-row" data-id="' + e.id + '" data-type="' + type + '">'
      + '<div class="calt-ev-left">'
      + dateBadge
      + '<span class="calt-ev-text">' + esc(e.text) + '</span>'
      + '</div>'
      + '<div class="calt-ev-acts">'
      + '<button class="calt-ev-btn calt-ev-pin' + pinActive + '" data-id="' + e.id + '" data-type="' + type + '" title="' + (e.pinned ? 'Открепить' : 'Закрепить — всегда в промпте') + '">📌</button>'
      + '<button class="calt-ev-btn calt-ev-edit" data-id="' + e.id + '" data-type="' + type + '" title="Редактировать">✎</button>'
      + '<button class="calt-ev-btn calt-ev-del"  data-id="' + e.id + '" data-type="' + type + '" title="Удалить">✕</button>'
      + '</div></div>';
  }

  function isMonthHot(month) {
    const s  = getSettings();
    const cm = currentMonth();
    if (!Array.isArray(s.manualHotMonths))  s.manualHotMonths  = [];
    if (!Array.isArray(s.manualColdMonths)) s.manualColdMonths = [];
    // Explicit hot override
    if (s.manualHotMonths.includes(month)) return true;
    // Explicit cold override
    if (s.manualColdMonths.includes(month)) return false;
    // Auto: current date month
    if (cm && month === cm) return true;
    return false;
  }

  function buildEventsTab() {
    const s  = getSettings();
    const cm = currentMonth();

    let listHtml = '';
    if (!s.keyEvents.length) {
      listHtml = '<div class="calt-empty">Событий нет.<br><small>Нажмите ✦ Сканировать — AI проанализирует чат и лорбук</small></div>';
    } else {
      const groups = {}, order = [];
      s.keyEvents.forEach(function(e) {
        const m = extractMonth(e.date) || '— Без даты';
        if (!groups[m]) { groups[m] = []; order.push(m); }
        groups[m].push(e);
      });

      order.forEach(function(month) {
        const isHot   = isMonthHot(month);
        const coll    = !!_collapsedMonths[month];
        const summ    = s.monthSummaries[month] || '';
        listHtml += '<div class="calt-month-group">'
          + '<div class="calt-month-hdr" data-month="' + esc(month) + '">'
          + '<span class="calt-month-chev">' + (coll ? '▸' : '▾') + '</span>'
          + '<span class="calt-month-name">' + esc(month) + '</span>'
          + (isHot
            ? '<span class="calt-layer-badge calt-layer-hot calt-layer-toggle" data-month="' + esc(month) + '" title="Нажмите чтобы пометить как прошлый">● текущий</span>'
            : '<span class="calt-layer-badge calt-layer-warm calt-layer-toggle" data-month="' + esc(month) + '" title="Нажмите чтобы пометить как текущий">● прошлый</span>')
          + '<span class="calt-month-count">' + groups[month].length + '</span>'
          + (isHot ? '' : '<button class="calt-summ-gen-btn" data-month="' + esc(month) + '" title="Сгенерировать AI саммери">✦</button>')
          + '</div>';

        if (!isHot) {
          listHtml += '<div class="calt-month-summ-row" data-month="' + esc(month) + '">'
            + (summ
              ? '<span class="calt-summ-text" data-month="' + esc(month) + '">' + esc(summ) + '</span>'
              : '<span class="calt-summ-empty" data-month="' + esc(month) + '">нет саммери — нажмите ✦ или кликните для ввода</span>')
            + '</div>';
        }

        listHtml += '<div class="calt-month-body"' + (coll ? ' style="display:none"' : '') + '>';
        groups[month].forEach(function(e) { listHtml += eventRow(e, 'event'); });
        listHtml += '</div></div>';
      });
    }

    const legendHtml = cm
      ? '<div class="calt-legend">'
        + '<span class="calt-layer-hot">● текущий</span> — в промпте полностью + закреплённые'
        + ' &nbsp;·&nbsp; <span class="calt-layer-warm">● прошлый</span> — только саммери'
        + '</div>'
      : '';

    return legendHtml
      + '<div class="calt-list-wrap"><div class="calt-list" id="calt_ev_list">' + listHtml + '</div></div>'
      + '<div class="calt-add-row">'
      + '<input class="calt-add-date" id="calt_add_ev_date" placeholder="Дата">'
      + '<input class="calt-add-txt"  id="calt_add_ev_txt"  placeholder="Описание события...">'
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

  function buildDeadlinesTab() {
    const s  = getSettings();
    const cm = currentMonth();

    let listHtml = '';
    if (!s.deadlines.length) {
      listHtml = '<div class="calt-empty">Дедлайнов нет.<br><small>Нажмите ✦ Сканировать — AI найдёт грядущие события</small></div>';
    } else {
      s.deadlines.forEach(function(e) {
        const dlMonth     = extractMonth(e.date);
        const approaching = cm && dlMonth && dlMonth === cm;
        const dateBadge   = e.date
          ? '<span class="calt-ev-date' + (approaching ? ' calt-ev-date-urgent' : '') + '">'
            + (approaching ? '⚠ ' : '') + esc(e.date) + '</span>'
          : '<span class="calt-ev-date calt-ev-date-empty">—</span>';
        listHtml += '<div class="calt-ev-row" data-id="' + e.id + '" data-type="deadline">'
          + '<div class="calt-ev-left">' + dateBadge + '<span class="calt-ev-text">' + esc(e.text) + '</span></div>'
          + '<div class="calt-ev-acts">'
          + '<button class="calt-ev-btn calt-ev-edit" data-id="' + e.id + '" data-type="deadline" title="Редактировать">✎</button>'
          + '<button class="calt-ev-btn calt-ev-del"  data-id="' + e.id + '" data-type="deadline" title="Удалить">✕</button>'
          + '</div></div>';
      });
    }

    return '<div class="calt-list-wrap"><div class="calt-list" id="calt_dl_list">' + listHtml + '</div></div>'
      + '<div class="calt-add-row">'
      + '<input class="calt-add-date" id="calt_add_dl_date" placeholder="Дата">'
      + '<input class="calt-add-txt"  id="calt_add_dl_txt"  placeholder="Грядущее событие...">'
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

  function buildRulesTab() {
    const s = getSettings();
    return '<div class="calt-rules-wrap">'
      + '<p class="calt-rules-hint">Система летоисчисления: месяцы, дни, лунные циклы, эпохи. Инжектируется в каждый промпт.</p>'
      + '<textarea class="calt-rules-edit" id="calt_rules_edit" rows="12">'
      + esc(s.calendarRules || '') + '</textarea>'
      + '<div class="calt-rules-actions">'
      + '<button class="menu_button calt-scan-btn" id="calt_rules_extract_btn">✦ Извлечь из лорбука</button>'
      + '<button class="menu_button calt-rules-save-btn" id="calt_rules_save_btn">💾 Сохранить</button>'
      + '</div>'
      + '<div class="calt-scan-status" id="calt_scan_rules_status"></div>'
      + '</div>';
  }

  // ─── Tab event bindings ───────────────────────────────────────────────────

  function bindTabEvents() {

    // Month group toggle
    $('.calt-month-hdr').off('click').on('click', function(e) {
      if ($(e.target).hasClass('calt-summ-gen-btn') || $(e.target).closest('.calt-summ-gen-btn').length) return;
      const month = $(this).data('month');
      _collapsedMonths[month] = !_collapsedMonths[month];
      const $group = $(this).closest('.calt-month-group');
      const $body  = $group.find('.calt-month-body');
      const action = _collapsedMonths[month] ? 'slideUp' : 'slideDown';
      $body[action](160);
      $(this).find('.calt-month-chev').text(_collapsedMonths[month] ? '▸' : '▾');
    });

    // Layer badge toggle (hot/warm manual override)
    $('.calt-layer-toggle').off('click').on('click', function(e) {
      e.stopPropagation();
      const month = $(this).data('month');
      const s     = getSettings();
      const idx   = s.manualHotMonths.indexOf(month);
      if (isMonthHot(month)) {
        // Currently hot → mark as past (add to a "forced cold" list by removing from hot
        // and ensuring auto-match is blocked via a sentinel)
        if (idx !== -1) s.manualHotMonths.splice(idx, 1);
        // If it was auto-hot (current month), add explicit cold sentinel
        if (!s.manualColdMonths) s.manualColdMonths = [];
        if (!s.manualColdMonths.includes(month)) s.manualColdMonths.push(month);
        toast(month + ' → прошлый', '#60a5fa');
      } else {
        // Currently warm/cold → force hot
        if (idx === -1) s.manualHotMonths.push(month);
        if (s.manualColdMonths) {
          const ci = s.manualColdMonths.indexOf(month);
          if (ci !== -1) s.manualColdMonths.splice(ci, 1);
        }
        toast(month + ' → текущий 🔥', '#fbbf24');
      }
      save(); updatePrompt(); renderTabContent();
    });

    // Summary: click text/empty to open edit
    $('.calt-summ-text, .calt-summ-empty').off('click').on('click', function() {
      openSummaryEdit($(this).data('month'));
    });

    // Summary: generate button
    $('.calt-summ-gen-btn').off('click').on('click', async function(e) {
      e.stopPropagation();
      const month = $(this).data('month');
      const $btn  = $(this);
      $btn.prop('disabled', true).text('…');
      try {
        const text = await generateMonthSummary(month);
        getSettings().monthSummaries[month] = text.trim();
        save(); renderTabContent();
        toast('Саммери для ' + month + ' готово', '#a78bfa');
      } catch (err) {
        toast('Ошибка: ' + err.message, '#f87171');
        $btn.prop('disabled', false).text('✦');
      }
    });

    // Pin toggle
    $('.calt-ev-pin').off('click').on('click', function() {
      const id   = +$(this).data('id');
      const s    = getSettings();
      const item = s.keyEvents.find(function(e) { return e.id === id; });
      if (!item) return;
      item.pinned = !item.pinned;
      save(); updatePrompt(); renderTabContent();
      toast(item.pinned ? '📌 Закреплено — всегда в промпте' : 'Откреплено', item.pinned ? '#fbbf24' : '#94a3b8');
    });

    // Delete
    $('.calt-ev-del').off('click').on('click', function() {
      const id   = +$(this).data('id'), type = $(this).data('type');
      const s    = getSettings();
      const arr  = type === 'event' ? 'keyEvents' : 'deadlines';
      const removed = s[arr].find(function(e) { return e.id === id; });
      s[arr] = s[arr].filter(function(e) { return e.id !== id; });
      save(); updatePrompt(); updateMeta(); renderTabContent();
      toast(type === 'event' ? 'Событие удалено' : 'Дедлайн удалён', '#f87171', function() {
        s[arr].push(removed);
        s[arr].sort(function(a, b) { return a.id - b.id; });
        save(); updatePrompt(); updateMeta(); renderTabContent();
      });
    });

    // Edit
    $('.calt-ev-edit').off('click').on('click', function() {
      openEditModal(+$(this).data('id'), $(this).data('type'));
    });

    // Add event
    $('#calt_add_ev_btn').off('click').on('click', function() {
      const date = $('#calt_add_ev_date').val().trim();
      const text = $('#calt_add_ev_txt').val().trim();
      if (!text) { $('#calt_add_ev_txt').focus(); return; }
      const s = getSettings();
      s.keyEvents.push({ id: s.nextEventId++, date: date, text: text, pinned: false });
      save(); updatePrompt(); updateMeta();
      $('#calt_add_ev_date').val(''); $('#calt_add_ev_txt').val('');
      renderTabContent();
    });
    $('#calt_add_ev_txt').off('keydown').on('keydown', function(e) { if (e.key === 'Enter') $('#calt_add_ev_btn').click(); });

    // Add deadline
    $('#calt_add_dl_btn').off('click').on('click', function() {
      const date = $('#calt_add_dl_date').val().trim();
      const text = $('#calt_add_dl_txt').val().trim();
      if (!text) { $('#calt_add_dl_txt').focus(); return; }
      const s = getSettings();
      s.deadlines.push({ id: s.nextDeadlineId++, date: date, text: text });
      save(); updatePrompt(); updateMeta();
      $('#calt_add_dl_date').val(''); $('#calt_add_dl_txt').val('');
      renderTabContent();
    });
    $('#calt_add_dl_txt').off('keydown').on('keydown', function(e) { if (e.key === 'Enter') $('#calt_add_dl_btn').click(); });

    $('#calt_scan_ev_depth, #calt_scan_dl_depth').off('change').on('change', function() {
      getSettings().scanDepth = +this.value || 20; save();
    });

    // Scan Key Events
    $('#calt_scan_ev_btn').off('click').on('click', async function() {
      const $btn = $(this), $st = $('#calt_scan_ev_status');
      const depth = +$('#calt_scan_ev_depth').val() || 20;
      $btn.prop('disabled', true).text('Сканирую…');
      $st.css('color', '#7a8499').text('Анализирую чат и лорбук…');
      try {
        const s      = getSettings();
        const snap   = JSON.stringify(s.keyEvents);
        const events = await scanKeyEvents(depth);
        if (events.length) {
          s.keyEvents   = events;
          s.nextEventId = Math.max.apply(null, events.map(function(e){return e.id;}).concat([s.nextEventId-1]))+1;
          save(); updatePrompt(); updateMeta(); renderTabContent();
          $st.css('color', '#34d399').text('✅ Найдено ' + events.length + ' событий');
          toast('Таймлайн обновлён', '#34d399', function() {
            s.keyEvents = JSON.parse(snap);
            save(); updatePrompt(); updateMeta(); renderTabContent();
          });
        } else {
          $st.css('color', '#f59e0b').text('Новых событий не обнаружено');
        }
      } catch (e) { $st.css('color', '#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled', false).text('✦ Сканировать');
    });

    // Scan Deadlines
    $('#calt_scan_dl_btn').off('click').on('click', async function() {
      const $btn = $(this), $st = $('#calt_scan_dl_status');
      const depth = +$('#calt_scan_dl_depth').val() || 20;
      $btn.prop('disabled', true).text('Сканирую…');
      $st.css('color', '#7a8499').text('Анализирую чат и лорбук…');
      try {
        const s        = getSettings();
        const snap     = JSON.stringify(s.deadlines);
        const deadlines = await scanDeadlines(depth);
        if (deadlines.length) {
          s.deadlines      = deadlines;
          s.nextDeadlineId = Math.max.apply(null, deadlines.map(function(e){return e.id;}).concat([s.nextDeadlineId-1]))+1;
          save(); updatePrompt(); updateMeta(); renderTabContent();
          $st.css('color', '#34d399').text('✅ Найдено ' + deadlines.length + ' событий');
          toast('Дедлайны обновлены', '#fbbf24', function() {
            s.deadlines = JSON.parse(snap);
            save(); updatePrompt(); updateMeta(); renderTabContent();
          });
        } else {
          $st.css('color', '#f59e0b').text('Грядущих событий не обнаружено');
        }
      } catch (e) { $st.css('color', '#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled', false).text('✦ Сканировать');
    });

    // Rules save
    $('#calt_rules_save_btn').off('click').on('click', async function() {
      getSettings().calendarRules = $('#calt_rules_edit').val();
      save(); await updatePrompt();
      toast('Правила сохранены', '#a78bfa');
      $('#calt_scan_rules_status').css('color', '#34d399').text('✅ Сохранено');
    });

    // Rules extract
    $('#calt_rules_extract_btn').off('click').on('click', async function() {
      const $btn = $(this), $st = $('#calt_scan_rules_status');
      $btn.prop('disabled', true).text('Извлекаю…');
      $st.css('color', '#7a8499').text('Анализирую лорбук…');
      try {
        const lore = getLorebook();
        if (!lore) { $st.css('color', '#f59e0b').text('Лорбук пуст или недоступен'); $btn.prop('disabled', false).text('✦ Извлечь из лорбука'); return; }
        const sys = 'Extract ONLY timekeeping info: calendar name, year system, month names, day/week names, seasons, lunar cycles, time units. '
          + 'Format as concise lines: [Key: value]. No markdown, no commentary. Max 25 lines. Preserve original terminology.';
        const result = await aiGenerate('LOREBOOK:\n' + lore.slice(0, 5000) + '\n\nExtract all calendar rules:', sys);
        $('#calt_rules_edit').val(result.trim());
        $st.css('color', '#34d399').text('✅ Извлечено — нажмите Сохранить');
        toast('Правила извлечены из лорбука', '#a78bfa');
      } catch (e) { $st.css('color', '#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled', false).text('✦ Извлечь из лорбука');
    });
  }

  // ─── Summary edit overlay ─────────────────────────────────────────────────

  function openSummaryEdit(month) {
    const s    = getSettings();
    const curr = s.monthSummaries[month] || '';
    $('.calt-edit-overlay').remove();
    $('body').append(
      '<div class="calt-edit-overlay calt-eopen">'
      + '<div class="calt-edit-box">'
      + '<div class="calt-edit-hdr"><span>📝 Саммери — ' + esc(month) + '</span>'
      + '<button class="calt-edit-x" id="calt_summ_x">✕</button></div>'
      + '<div class="calt-edit-body">'
      + '<div class="calt-elabel">Краткое описание периода</div>'
      + '<textarea class="calt-etextarea" id="calt_summ_text" rows="4">' + esc(curr) + '</textarea>'
      + '<div style="font-size:10px;color:#3d4a60;margin-top:5px">Инжектируется вместо детальных событий (экономия токенов). 1-2 предложения.</div>'
      + '</div>'
      + '<div class="calt-edit-footer">'
      + '<button class="menu_button" id="calt_summ_cancel">Отмена</button>'
      + '<button class="menu_button calt-save-btn" id="calt_summ_save">💾 Сохранить</button>'
      + '</div></div></div>'
    );
    $('#calt_summ_x, #calt_summ_cancel').on('click', function() { $('.calt-edit-overlay').remove(); });
    $('#calt_summ_save').on('click', async function() {
      getSettings().monthSummaries[month] = $('#calt_summ_text').val().trim();
      save(); await updatePrompt(); renderTabContent();
      $('.calt-edit-overlay').remove();
      toast('Саммери сохранено', '#a78bfa');
    });
  }

  // ─── Edit event/deadline modal ────────────────────────────────────────────

  function openEditModal(id, type) {
    const s    = getSettings();
    const arr  = type === 'event' ? s.keyEvents : s.deadlines;
    const item = arr.find(function(e) { return e.id === id; });
    if (!item) return;

    $('.calt-edit-overlay').remove();
    $('body').append(
      '<div class="calt-edit-overlay calt-eopen">'
      + '<div class="calt-edit-box">'
      + '<div class="calt-edit-hdr"><span>' + (type === 'event' ? '⚔ Редактировать событие' : '⏳ Редактировать дедлайн') + '</span>'
      + '<button class="calt-edit-x" id="calt_edit_x">✕</button></div>'
      + '<div class="calt-edit-body">'
      + '<div class="calt-elabel">Дата</div>'
      + '<input class="calt-einput" id="calt_edit_date" value="' + esc(item.date || '') + '" placeholder="напр. 23 Naeris">'
      + '<div class="calt-elabel" style="margin-top:8px">Описание</div>'
      + '<textarea class="calt-etextarea" id="calt_edit_text">' + esc(item.text) + '</textarea>'
      + '</div>'
      + '<div class="calt-edit-footer">'
      + '<button class="menu_button" id="calt_edit_cancel">Отмена</button>'
      + '<button class="menu_button calt-save-btn" id="calt_edit_save">💾 Сохранить</button>'
      + '</div></div></div>'
    );
    $('#calt_edit_x, #calt_edit_cancel').on('click', function() { $('.calt-edit-overlay').remove(); });
    $('#calt_edit_save').on('click', function() {
      const d = $('#calt_edit_date').val().trim();
      const t = $('#calt_edit_text').val().trim();
      if (!t) return;
      item.date = d; item.text = t;
      save(); updatePrompt(); updateMeta(); renderTabContent();
      $('.calt-edit-overlay').remove();
      toast('Сохранено', '#34d399');
    });
    $('#calt_edit_text').on('keydown', function(e) { if (e.key === 'Enter' && e.ctrlKey) $('#calt_edit_save').click(); });
  }

  // ─── Export / Import ──────────────────────────────────────────────────────

  function exportData() {
    const s = getSettings();
    const blob = new Blob([JSON.stringify({
      currentDate: s.currentDate, keyEvents: s.keyEvents,
      deadlines: s.deadlines, calendarRules: s.calendarRules,
      monthSummaries: s.monthSummaries,
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'calendar_tracker_' + Date.now() + '.json';
    a.click();
    toast('Данные экспортированы', '#34d399');
  }

  function importData() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = function(e) {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const data = JSON.parse(ev.target.result);
          const s = getSettings();
          if (data.currentDate)              { s.currentDate = data.currentDate; $('#calt_current_date,#calt_modal_date').val(s.currentDate); }
          if (Array.isArray(data.keyEvents)) s.keyEvents   = data.keyEvents;
          if (Array.isArray(data.deadlines)) s.deadlines   = data.deadlines;
          if (data.calendarRules)            s.calendarRules = data.calendarRules;
          if (data.monthSummaries && typeof data.monthSummaries === 'object') s.monthSummaries = data.monthSummaries;
          save(); updatePrompt(); updateMeta(); renderTabContent();
          toast('Данные импортированы', '#34d399');
        } catch (err) { toast('Ошибка импорта — неверный формат', '#f87171'); }
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
    if (chat.length <= _lastAutoLen || (chat.length - _lastAutoLen) < 10) return;
    _lastAutoLen = chat.length;

    clearTimeout(_autoScanTimer);
    _autoScanTimer = setTimeout(async function() {
      try {
        const lastMsg = chat[chat.length - 1];
        const msgText = lastMsg ? (lastMsg.mes || '') : '';

        const significant = await isMessageSignificant(msgText);
        if (!significant) {
          console.log('[CalTracker] autoscan skipped — not significant');
          return;
        }

        const evSnap = JSON.stringify(s.keyEvents);
        const dlSnap = JSON.stringify(s.deadlines);
        const results = await Promise.all([scanKeyEvents(s.scanDepth), scanDeadlines(s.scanDepth)]);
        const events = results[0], deadlines = results[1];
        let changed = false;
        if (events.length)    { s.keyEvents  = events;    s.nextEventId    = Math.max.apply(null, events.map(function(e){return e.id;}).concat([s.nextEventId-1]))+1;    changed = true; }
        if (deadlines.length) { s.deadlines  = deadlines; s.nextDeadlineId = Math.max.apply(null, deadlines.map(function(e){return e.id;}).concat([s.nextDeadlineId-1]))+1; changed = true; }
        if (changed) {
          save(); updatePrompt(); updateMeta();
          if ($('#calt_modal').hasClass('calt-mopen')) renderTabContent();
          toast('Таймлайн обновлён автоматически', '#34d399', function() {
            s.keyEvents  = JSON.parse(evSnap);
            s.deadlines  = JSON.parse(dlSnap);
            save(); updatePrompt(); updateMeta();
            if ($('#calt_modal').hasClass('calt-mopen')) renderTabContent();
          });
        }
      } catch (e) { console.warn('[CalTracker] autoscan error:', e.message); }
    }, 2000);
  }

  // ─── Wire ST events ───────────────────────────────────────────────────────

  function wireEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async function() {
      mountSettingsUi();
      await updatePrompt();
    });

    eventSource.on(event_types.CHAT_CHANGED, async function() {
      _lastAutoLen     = 0;
      _collapsedMonths = {};
      refreshSettingsUi();
      await updatePrompt();
      if ($('#calt_modal').hasClass('calt-mopen')) renderTabContent();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async function() {
      await updatePrompt();
      await tryAutoScan();
    });

    if (event_types.GENERATION_ENDED) {
      eventSource.on(event_types.GENERATION_ENDED, async function() {
        await updatePrompt();
      });
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  jQuery(function() {
    try {
      wireEvents();
      console.log('[Calendar Tracker v2.0] ✦ loaded');
    } catch (e) {
      console.error('[Calendar Tracker] init failed:', e);
    }
  });

})();
