/**
 * Calendar Tracker v1.1 — SillyTavern Extension
 * Timeline injection · Key Events · Deadlines · Calendar Rules · AI Scan
 * Uses the active ST Connection Profile for AI generation
 */

(() => {
  'use strict';

  const MODULE_KEY = 'calendar_tracker';

  const defaultSettings = Object.freeze({
    enabled:       true,
    currentDate:   '',
    keyEvents:     null,
    deadlines:     null,
    calendarRules: '',
    autoScan:      false,
    scanDepth:     20,
    nextEventId:   1,
    nextDeadlineId:1,
  });

  let activeTab      = 'events';
  let _lastAutoLen   = 0;
  let _autoScanTimer = null;

  // ─── Context helpers ──────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = { ...structuredClone(defaultSettings), keyEvents: [], deadlines: [] };
    const s = extensionSettings[MODULE_KEY];
    if (!Array.isArray(s.keyEvents))  s.keyEvents  = [];
    if (!Array.isArray(s.deadlines))  s.deadlines  = [];
    if (!s.nextEventId)    s.nextEventId    = (s.keyEvents.length  || 0) + 1;
    if (!s.nextDeadlineId) s.nextDeadlineId = (s.deadlines.length  || 0) + 1;
    return s;
  }

  function save() { ctx().saveSettingsDebounced(); }

  // ─── Prompt injection ─────────────────────────────────────────────────────

  function buildPromptText() {
    const s = getSettings();
    const lines = ['[TIMELINE: KEY EVENTS]'];
    if (s.currentDate) lines.push(`CURRENT DATE: ${s.currentDate}`);
    if (s.keyEvents.length) {
      lines.push('KEY EVENTS:');
      s.keyEvents.forEach(e => lines.push(`• ${e.date ? '[' + e.date + '] ' : ''}${e.text}`));
    }
    if (s.deadlines.length) {
      lines.push('UPCOMING EVENTS:');
      s.deadlines.forEach(e => lines.push(`• ${e.date ? '[' + e.date + '] ' : ''}${e.text}`));
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
    setExtensionPrompt(MODULE_KEY, buildPromptText(), extension_prompt_types?.IN_PROMPT ?? 0, 0);
  }

  // ─── AI generation — uses active ST Connection Profile ────────────────────

  function extractText(data) {
    if (data?.choices?.[0]?.message?.content !== undefined) return data.choices[0].message.content;
    if (data?.choices?.[0]?.text             !== undefined) return data.choices[0].text;
    if (typeof data?.response === 'string')  return data.response;
    if (Array.isArray(data?.content)) {
      const t = data.content.find(b => b.type === 'text');
      return t?.text ?? null;
    }
    if (typeof data?.content === 'string') return data.content;
    return null;
  }

  async function aiGenerate(userPrompt, systemPrompt) {
    const c = ctx();
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    // 1. generateRaw — uses whatever profile is active in ST
    if (typeof c.generateRaw === 'function') {
      try {
        const r = await c.generateRaw(fullPrompt, '', false, false, '', 'normal');
        if (r?.trim()) return r;
      } catch (e) { console.warn('[CalTracker] generateRaw failed:', e.message); }
    }

    // 2. ST proxy endpoints as fallback
    const stEndpoints = [
      { url: '/api/backends/chat-completions/generate',
        body: () => ({ messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], stream: false }) },
      { url: '/api/generate',
        body: () => ({ prompt: fullPrompt, max_new_tokens: 1500, stream: false }) },
      { url: '/generate',
        body: () => ({ prompt: fullPrompt, max_new_tokens: 1500, stream: false }) },
    ];

    for (const ep of stEndpoints) {
      try {
        const resp = await fetch(ep.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body()),
        });
        if (!resp.ok) continue;
        const text = extractText(await resp.json());
        if (text?.trim()) return text;
      } catch { /**/ }
    }

    throw new Error('Нет активного подключения. Выбери Connection Profile в ST и попробуй снова.');
  }

  // ─── Chat / Lorebook context ──────────────────────────────────────────────

  function getChatContext(depth) {
    const chat = ctx().chat || [];
    return chat.slice(-depth)
      .map(m => `[${m.is_user ? 'USER' : 'CHAR'}]: ${(m.mes || '').slice(0, 600)}`)
      .join('\n\n');
  }

  function getLorebook() {
    try {
      const c = ctx();
      const wi = c.worldInfoData || c.worldInfo || {};
      const entries = [];
      Object.values(wi).forEach(book => {
        const src = book?.entries || book;
        if (src && typeof src === 'object')
          Object.values(src).forEach(e => { if (e?.content) entries.push(String(e.content)); });
      });
      return entries.join('\n\n');
    } catch { return ''; }
  }

  // ─── Scan functions ───────────────────────────────────────────────────────

  function parseEventList(text, startId) {
    if (!text) return [];
    let id = startId || Date.now();
    const events = [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^(EXISTING|ALREADY|KEY EVENTS|UPCOMING|OUTPUT|FORMAT|RULES|STRICT|NOTE)/i.test(line)) continue;
      const clean = line.replace(/^[-•*]\s*/, '');
      const m = clean.match(/^\[([^\]]+)\]\s+(.+)$/);
      if (m) {
        events.push({ id: id++, date: m[1].trim(), text: m[2].trim() });
      } else if (clean.length > 3 && !clean.startsWith('#')) {
        events.push({ id: id++, date: '', text: clean });
      }
    }
    return events;
  }

  async function scanKeyEvents(depth) {
    const s = getSettings();
    const chatCtx  = getChatContext(depth);
    const loreCtx  = getLorebook();
    const existing = s.keyEvents.map(e => `[${e.date || '?'}] ${e.text}`).join('\n');

    const sys = `You are a precise chronicle archivist for a roleplay story. Extract KEY EVENTS that have ALREADY HAPPENED.

OUTPUT FORMAT — one event per line, exactly like this:
[DATE] Very brief description (max 8 words)

STRICT RULES:
- Only past/completed events
- Use the story world's own calendar dates (not real dates)
- Be extremely concise — this is a timeline reminder only
- Preserve ALL existing events listed below, only ADD new ones or correct wrong dates
- No headers, no markdown, no commentary — ONLY the event lines

${existing ? `EXISTING EVENTS TO PRESERVE:\n${existing}` : 'No existing events yet.'}`;

    const usr = `RECENT CHAT (last ${depth} messages):\n${chatCtx || '(empty)'}${loreCtx ? `\n\nLOREBOOK:\n${loreCtx.slice(0, 3000)}` : ''}\n\nList all key past events:`;
    const result = await aiGenerate(usr, sys);
    return parseEventList(result, s.nextEventId);
  }

  async function scanDeadlines(depth) {
    const s = getSettings();
    const chatCtx  = getChatContext(depth);
    const loreCtx  = getLorebook();
    const existing = s.deadlines.map(e => `[${e.date || '?'}] ${e.text}`).join('\n');
    const past     = s.keyEvents.map(e => `[${e.date || '?'}] ${e.text}`).join('\n');

    const sys = `You are a precise timeline analyst for a roleplay story. Extract UPCOMING/FUTURE EVENTS — things planned, expected, or mentioned as yet-to-happen.

OUTPUT FORMAT — one event per line, exactly like this:
[DATE] Very brief description (max 8 words)

STRICT RULES:
- Only FUTURE events that haven't happened yet
- Use the story world's own calendar dates
- Be extremely concise
- Preserve ALL existing deadlines below, only ADD new ones
- Do NOT repeat events that already happened (see past events list)
- No headers, no markdown — ONLY the event lines

${existing ? `EXISTING DEADLINES TO PRESERVE:\n${existing}` : 'No existing deadlines yet.'}
${past ? `ALREADY HAPPENED (do NOT include these):\n${past}` : ''}`;

    const usr = `RECENT CHAT (last ${depth} messages):\n${chatCtx || '(empty)'}${loreCtx ? `\n\nLOREBOOK:\n${loreCtx.slice(0, 3000)}` : ''}\n\nList all upcoming/planned events:`;
    const result = await aiGenerate(usr, sys);
    return parseEventList(result, s.nextDeadlineId);
  }

  // ─── Toast ────────────────────────────────────────────────────────────────

  let _toastTimer = null;
  function toast(msg, color, undoFn) {
    color = color || '#34d399';
    clearTimeout(_toastTimer);
    $('.calt-toast').remove();
    const undoBtn = undoFn ? `<button class="calt-toast-undo">↩ Отменить</button>` : '';
    $('body').append(`
      <div class="calt-toast">
        <div class="calt-toast-row">
          <span class="calt-toast-dot" style="background:${color}"></span>
          <span class="calt-toast-msg">${msg}</span>
          ${undoBtn}
        </div>
      </div>`);
    const $t = $('.calt-toast');
    setTimeout(() => $t.addClass('calt-in'), 10);
    if (undoFn) $t.find('.calt-toast-undo').on('click', () => { undoFn(); $t.remove(); });
    _toastTimer = setTimeout(() => { $t.addClass('calt-out'); setTimeout(() => $t.remove(), 300); }, 4500);
  }

  // ─── Settings panel ───────────────────────────────────────────────────────

  function getActiveProfileName() {
    try {
      const c = ctx();
      return c.connectionManager?.selectedProfile?.name
          || c.currentConnectionProfile?.name
          || c.activeProfile?.name
          || c.mainApi
          || c.apiType
          || null;
    } catch { return null; }
  }

  function mountSettingsUi() {
    if ($('#calt_block').length) return;

    const profileName = getActiveProfileName();
    const connLabel   = profileName || 'Активный профиль ST';
    const connColor   = profileName ? '#34d399' : '#fbbf24';

    const $ext = $('#extensions_settings2, #extensions_settings').first();
    if (!$ext.length) return;

    $ext.append(`
      <div class="calt-block" id="calt_block">
        <div class="calt-hdr" id="calt_hdr">
          <span class="calt-gem">🗓</span>
          <span class="calt-title">Calendar Tracker</span>
          <span class="calt-badge" id="calt_badge" style="display:none">0</span>
          <span class="calt-chev" id="calt_chev">▾</span>
        </div>
        <div class="calt-body" id="calt_body">
          <div class="calt-meta" id="calt_meta">нет данных</div>

          <label class="calt-ck" style="margin-top:8px;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#94a3b8">
            <input type="checkbox" id="calt_enabled" style="accent-color:#fbbf24">
            <span>Включено (инжект в промпт)</span>
          </label>

          <label class="calt-ck" style="margin-top:5px;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#94a3b8">
            <input type="checkbox" id="calt_autoscan" style="accent-color:#fbbf24">
            <span>Авто-сканирование</span>
          </label>

          <div class="calt-field-row">
            <span class="calt-flabel">Текущая дата</span>
            <input class="calt-text-input" id="calt_current_date" placeholder="напр. 5 Jan 301 O.F.">
          </div>

          <button class="menu_button calt-open-btn" id="calt_open_btn">📖 Открыть календарь</button>

          <div class="calt-sec">
            <div class="calt-sec-hdr" id="calt_conn_hdr">
              <span class="calt-sec-chev" id="calt_conn_chev">▸</span>
              <span>🔌 Подключение</span>
            </div>
            <div class="calt-sec-body" id="calt_conn_body" style="display:none">
              <div class="calt-conn-status">
                <span class="calt-conn-dot" id="calt_conn_dot" style="color:${connColor}">●</span>
                <span class="calt-conn-label" id="calt_conn_label">${connLabel}</span>
              </div>
              <p class="calt-conn-hint">Расширение использует активный Connection Profile из ST. Ничего настраивать не нужно.</p>
              <button class="menu_button calt-test-btn" id="calt_test_btn">⚡ Тест подключения</button>
              <div class="calt-api-status" id="calt_test_status"></div>
            </div>
          </div>
        </div>
      </div>`);

    const s = getSettings();
    $('#calt_enabled').prop('checked', s.enabled !== false);
    $('#calt_autoscan').prop('checked', !!s.autoScan);
    $('#calt_current_date').val(s.currentDate || '');
    updateBadge();
    updateMeta();

    // Header toggle
    $('#calt_hdr').on('click', () => {
      const $b = $('#calt_body');
      $b.slideToggle(180);
      $('#calt_chev').text($b.is(':visible') ? '▾' : '▸');
    });

    // Connection section toggle
    $('#calt_conn_hdr').on('click', () => {
      const $b = $('#calt_conn_body');
      $b.slideToggle(150);
      $('#calt_conn_chev').text($b.is(':visible') ? '▾' : '▸');
      const name = getActiveProfileName();
      $('#calt_conn_label').text(name || 'Активный профиль ST');
      $('#calt_conn_dot').css('color', name ? '#34d399' : '#fbbf24');
    });

    // Controls
    $('#calt_enabled').on('change', function () {
      getSettings().enabled = this.checked; save(); updatePrompt();
    });
    $('#calt_autoscan').on('change', function () {
      getSettings().autoScan = this.checked; save();
    });

    let _db = {};
    const deb = (k, fn) => { clearTimeout(_db[k]); _db[k] = setTimeout(fn, 420); };

    $('#calt_current_date').on('input', function () {
      const val = this.value;
      deb('cd', async () => {
        getSettings().currentDate = val.trim();
        $('#calt_modal_date').val(val.trim());
        save(); updateMeta(); await updatePrompt();
      });
    });

    $('#calt_test_btn').on('click', async () => {
      const $s = $('#calt_test_status');
      $s.css('color', '#7a8499').text('Тестирую…');
      try {
        const res = await aiGenerate('Reply with exactly one word: OK', 'You are a test. Reply with exactly one word: OK');
        $s.css('color', '#34d399').text('✅ ' + res.trim().slice(0, 50));
      } catch (e) {
        $s.css('color', '#f87171').text('✗ ' + e.message);
      }
    });

    $('#calt_open_btn').on('click', openModal);
  }

  function updateBadge() {
    const s = getSettings();
    const n = s.keyEvents.length + s.deadlines.length;
    const $b = $('#calt_badge');
    $b.text(n);
    if (n > 0) $b.show(); else $b.hide();
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

    $('body').append(`
      <div class="calt-modal" id="calt_modal">
        <div class="calt-modal-inner">
          <div class="calt-drag-handle"></div>
          <div class="calt-modal-hdr">
            <span class="calt-modal-icon">🗓</span>
            <span class="calt-modal-title">Calendar Tracker</span>
            <div class="calt-modal-date-wrap">
              <span class="calt-modal-date-label">Текущая дата:</span>
              <input class="calt-modal-date-inp" id="calt_modal_date" placeholder="напр. 5 Jan 301 O.F.">
            </div>
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
            <button class="menu_button calt-foot-btn calt-foot-close" id="calt_modal_close2">Закрыть</button>
          </div>
        </div>
      </div>`);

    $('#calt_modal_date').val(getSettings().currentDate || '');
    $('#calt_modal').addClass('calt-mopen');

    $('#calt_modal_close, #calt_modal_close2').on('click', () => $('#calt_modal').removeClass('calt-mopen'));
    $('#calt_modal').on('click', function (e) {
      if ($(e.target).is('#calt_modal') && window.innerWidth > 600) $('#calt_modal').removeClass('calt-mopen');
    });

    let _ddb = null;
    $('#calt_modal_date').on('input', function () {
      const val = this.value;
      clearTimeout(_ddb);
      _ddb = setTimeout(async () => {
        getSettings().currentDate = val.trim();
        $('#calt_current_date').val(val.trim());
        save(); updateMeta(); await updatePrompt();
      }, 400);
    });

    $('#calt_tabs').on('click', '.calt-tab', function () {
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
    return '<div class="calt-ev-row" data-id="' + e.id + '" data-type="' + type + '">'
      + '<div class="calt-ev-left">' + dateBadge + '<span class="calt-ev-text">' + esc(e.text) + '</span></div>'
      + '<div class="calt-ev-acts">'
      + '<button class="calt-ev-btn calt-ev-edit" data-id="' + e.id + '" data-type="' + type + '" title="Редактировать">✎</button>'
      + '<button class="calt-ev-btn calt-ev-del"  data-id="' + e.id + '" data-type="' + type + '" title="Удалить">✕</button>'
      + '</div></div>';
  }

  function buildEventsTab() {
    const s = getSettings();
    const listHtml = s.keyEvents.length
      ? s.keyEvents.map(function(e) { return eventRow(e, 'event'); }).join('')
      : '<div class="calt-empty">Событий нет.<br><small>Нажмите ✦ Сканировать — AI проанализирует чат и лорбук</small></div>';
    return '<div class="calt-list-wrap"><div class="calt-list" id="calt_ev_list">' + listHtml + '</div></div>'
      + '<div class="calt-add-row">'
      + '<input class="calt-add-date" id="calt_add_ev_date" placeholder="Дата">'
      + '<input class="calt-add-txt" id="calt_add_ev_txt" placeholder="Описание события...">'
      + '<button class="calt-add-btn" id="calt_add_ev_btn">+ Добавить</button>'
      + '</div>'
      + '<div class="calt-scan-row">'
      + '<span class="calt-scan-lbl">Сканировать</span>'
      + '<input type="number" class="calt-depth-inp" id="calt_scan_ev_depth" value="' + getSettings().scanDepth + '" min="5" max="200">'
      + '<span class="calt-scan-unit">сообщений</span>'
      + '<button class="menu_button calt-scan-btn" id="calt_scan_ev_btn">✦ Сканировать</button>'
      + '</div>'
      + '<div class="calt-scan-status" id="calt_scan_ev_status"></div>';
  }

  function buildDeadlinesTab() {
    const s = getSettings();
    const listHtml = s.deadlines.length
      ? s.deadlines.map(function(e) { return eventRow(e, 'deadline'); }).join('')
      : '<div class="calt-empty">Дедлайнов нет.<br><small>Нажмите ✦ Сканировать — AI найдёт грядущие события</small></div>';
    return '<div class="calt-list-wrap"><div class="calt-list" id="calt_dl_list">' + listHtml + '</div></div>'
      + '<div class="calt-add-row">'
      + '<input class="calt-add-date" id="calt_add_dl_date" placeholder="Дата">'
      + '<input class="calt-add-txt" id="calt_add_dl_txt" placeholder="Грядущее событие...">'
      + '<button class="calt-add-btn" id="calt_add_dl_btn">+ Добавить</button>'
      + '</div>'
      + '<div class="calt-scan-row">'
      + '<span class="calt-scan-lbl">Сканировать</span>'
      + '<input type="number" class="calt-depth-inp" id="calt_scan_dl_depth" value="' + getSettings().scanDepth + '" min="5" max="200">'
      + '<span class="calt-scan-unit">сообщений</span>'
      + '<button class="menu_button calt-scan-btn" id="calt_scan_dl_btn">✦ Сканировать</button>'
      + '</div>'
      + '<div class="calt-scan-status" id="calt_scan_dl_status"></div>';
  }

  function buildRulesTab() {
    const s = getSettings();
    return '<div class="calt-rules-wrap">'
      + '<p class="calt-rules-hint">Опишите систему летоисчисления: названия месяцев, дней, лунные циклы, сезоны, эпохи. Инжектируется в каждый промпт.</p>'
      + '<textarea class="calt-rules-edit" id="calt_rules_edit" rows="12" placeholder="Например:&#10;[Calendar: Standard Vaelorian, Year: 1000 A.P.]&#10;[Months: Vael, Eorel, Vorath...]&#10;[Week: 7 days — Aed, Fed, Bled, Sted, Med, Waed, Raed]&#10;[Moon Lyrath: 28-day cycle — YMNIR/AENOR/LYRATH VEL/OSSITH]">'
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
    // Delete
    $('.calt-ev-del').off('click').on('click', function () {
      const id = +$(this).data('id'), type = $(this).data('type');
      const s = getSettings();
      const arr = type === 'event' ? 'keyEvents' : 'deadlines';
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
    $('.calt-ev-edit').off('click').on('click', function () {
      openEditModal(+$(this).data('id'), $(this).data('type'));
    });

    // Add event
    $('#calt_add_ev_btn').off('click').on('click', function() {
      const date = $('#calt_add_ev_date').val().trim();
      const text = $('#calt_add_ev_txt').val().trim();
      if (!text) { $('#calt_add_ev_txt').focus(); return; }
      const s = getSettings();
      s.keyEvents.push({ id: s.nextEventId++, date: date, text: text });
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

    // Depth persist
    $('#calt_scan_ev_depth, #calt_scan_dl_depth').off('change').on('change', function() {
      getSettings().scanDepth = +this.value || 20; save();
    });

    // Scan Key Events
    $('#calt_scan_ev_btn').off('click').on('click', async function () {
      const $btn = $(this), $st = $('#calt_scan_ev_status');
      const depth = +$('#calt_scan_ev_depth').val() || 20;
      $btn.prop('disabled', true).text('Сканирую…');
      $st.css('color', '#7a8499').text('Анализирую чат и лорбук…');
      try {
        const s = getSettings();
        const snapshot = JSON.stringify(s.keyEvents);
        const events = await scanKeyEvents(depth);
        if (events.length) {
          s.keyEvents = events;
          s.nextEventId = Math.max.apply(null, events.map(function(e){return e.id;}).concat([s.nextEventId - 1])) + 1;
          save(); updatePrompt(); updateMeta(); renderTabContent();
          $st.css('color', '#34d399').text('✅ Найдено ' + events.length + ' событий');
          toast('Таймлайн обновлён', '#34d399', function() {
            s.keyEvents = JSON.parse(snapshot);
            save(); updatePrompt(); updateMeta(); renderTabContent();
          });
        } else {
          $st.css('color', '#f59e0b').text('Новых событий не обнаружено');
        }
      } catch (e) { $st.css('color', '#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled', false).text('✦ Сканировать');
    });

    // Scan Deadlines
    $('#calt_scan_dl_btn').off('click').on('click', async function () {
      const $btn = $(this), $st = $('#calt_scan_dl_status');
      const depth = +$('#calt_scan_dl_depth').val() || 20;
      $btn.prop('disabled', true).text('Сканирую…');
      $st.css('color', '#7a8499').text('Анализирую чат и лорбук…');
      try {
        const s = getSettings();
        const snapshot = JSON.stringify(s.deadlines);
        const deadlines = await scanDeadlines(depth);
        if (deadlines.length) {
          s.deadlines = deadlines;
          s.nextDeadlineId = Math.max.apply(null, deadlines.map(function(e){return e.id;}).concat([s.nextDeadlineId - 1])) + 1;
          save(); updatePrompt(); updateMeta(); renderTabContent();
          $st.css('color', '#34d399').text('✅ Найдено ' + deadlines.length + ' событий');
          toast('Дедлайны обновлены', '#fbbf24', function() {
            s.deadlines = JSON.parse(snapshot);
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
    $('#calt_rules_extract_btn').off('click').on('click', async function () {
      const $btn = $(this), $st = $('#calt_scan_rules_status');
      $btn.prop('disabled', true).text('Извлекаю…');
      $st.css('color', '#7a8499').text('Анализирую лорбук…');
      try {
        const lore = getLorebook();
        if (!lore) {
          $st.css('color', '#f59e0b').text('Лорбук пуст или недоступен');
          $btn.prop('disabled', false).text('✦ Извлечь из лорбука');
          return;
        }
        const sys = 'You are a calendar system extractor. From the provided lorebook text, extract ONLY timekeeping-related information: calendar name, year system, month names, day/week names, seasons, lunar cycles, time units, special dates.\nFormat as clean concise lines like: [Key: value]. No markdown, no headers, no commentary. Max 25 lines. Preserve original terminology exactly.';
        const result = await aiGenerate('LOREBOOK TEXT:\n' + lore.slice(0, 5000) + '\n\nExtract all calendar and timekeeping rules:', sys);
        $('#calt_rules_edit').val(result.trim());
        $st.css('color', '#34d399').text('✅ Извлечено — нажмите Сохранить');
        toast('Правила извлечены из лорбука', '#a78bfa');
      } catch (e) { $st.css('color', '#f87171').text('✗ ' + e.message); }
      $btn.prop('disabled', false).text('✦ Извлечь из лорбука');
    });
  }

  // ─── Edit modal ───────────────────────────────────────────────────────────

  function openEditModal(id, type) {
    const s = getSettings();
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
      + '<input class="calt-einput" id="calt_edit_date" value="' + esc(item.date || '') + '" placeholder="напр. 5 Jan 301 O.F.">'
      + '<div class="calt-elabel" style="margin-top:8px">Описание</div>'
      + '<textarea class="calt-etextarea" id="calt_edit_text">' + esc(item.text) + '</textarea>'
      + '</div>'
      + '<div class="calt-edit-footer">'
      + '<button class="menu_button" id="calt_edit_cancel">Отмена</button>'
      + '<button class="menu_button calt-save-btn" id="calt_edit_save">💾 Сохранить</button>'
      + '</div></div></div>');

    $('#calt_edit_x, #calt_edit_cancel').on('click', function() { $('.calt-edit-overlay').remove(); });
    $('#calt_edit_save').on('click', function() {
      const newDate = $('#calt_edit_date').val().trim();
      const newText = $('#calt_edit_text').val().trim();
      if (!newText) return;
      item.date = newDate; item.text = newText;
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
          if (data.currentDate)              { s.currentDate = data.currentDate; $('#calt_current_date, #calt_modal_date').val(s.currentDate); }
          if (Array.isArray(data.keyEvents)) s.keyEvents  = data.keyEvents;
          if (Array.isArray(data.deadlines)) s.deadlines  = data.deadlines;
          if (data.calendarRules)            s.calendarRules = data.calendarRules;
          save(); updatePrompt(); updateMeta(); renderTabContent();
          toast('Данные импортированы', '#34d399');
        } catch (err) { toast('Ошибка импорта — неверный формат файла', '#f87171'); }
      };
      reader.readAsText(file);
    };
    inp.click();
  }

  // ─── Auto-scan ────────────────────────────────────────────────────────────

  async function tryAutoScan() {
    const s = getSettings();
    if (!s.autoScan || !s.enabled) return;
    const chat = ctx().chat || [];
    if (chat.length <= _lastAutoLen || (chat.length - _lastAutoLen) < 10) return;
    _lastAutoLen = chat.length;

    clearTimeout(_autoScanTimer);
    _autoScanTimer = setTimeout(async function() {
      try {
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
      } catch (e) { console.warn('[CalTracker] auto-scan failed:', e.message); }
    }, 2000);
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Wire ST events ───────────────────────────────────────────────────────

  function wireEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async function() {
      mountSettingsUi();
      await updatePrompt();
    });

    eventSource.on(event_types.CHAT_CHANGED, async function() {
      _lastAutoLen = 0;
      await updatePrompt(); updateMeta();
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
      console.log('[Calendar Tracker v1.1] ✦ loaded');
    } catch (e) {
      console.error('[Calendar Tracker] init failed', e);
    }
  });

})();
