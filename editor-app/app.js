document.addEventListener('DOMContentLoaded', () => {

    const STORAGE_KEY = 'liveEditorState';

    /* ============================================
       0. STATE
    ============================================ */
    function loadState() {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    function saveState(partial) {
        const current = loadState();
        const merged = { ...current, ...partial };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch (err) {
            /* The browser's storage is full, or blocked. It must never take the
               click you just made down with it — the work stays in memory for
               this session either way. */
            console.warn('Infuse — state not stored:', err?.name || err);
        }
    }

    const state = loadState();

    /* ============================================
       1. RAIL — open/close + switches the view
    ============================================ */
    const rail = document.getElementById('rail');
    const railToggle = document.getElementById('rail-toggle');
    const railIcons = document.querySelectorAll('.rail__icon');

    const viewEditor = document.getElementById('view-editor');
    const viewReplacement = document.getElementById('view-replacement');
    const viewXpath = document.getElementById('view-xpath');

    if (state.railExpanded) {
        rail.classList.add('expanded');
    }

    railToggle.addEventListener('click', () => {
        rail.classList.toggle('expanded');
        saveState({ railExpanded: rail.classList.contains('expanded') });
    });

    function showView(role) {
        const isEditor = role === 'editor';
        viewEditor.hidden = !isEditor;
        viewEditor.style.display = isEditor ? '' : 'none';

        const isReplacement = role === 'replacement';
        viewReplacement.hidden = !isReplacement;
        viewReplacement.style.display = isReplacement ? '' : 'none';

        const isXpath = role === 'xpath';
        viewXpath.hidden = !isXpath;
        viewXpath.style.display = isXpath ? '' : 'none';
    }

    const savedRole = state.activeRole === 'replacement' ? 'replacement' : 'editor';
    railIcons.forEach(icon => {
        icon.classList.toggle('active', icon.dataset.role === savedRole);
    });
    showView(savedRole);

    railIcons.forEach(icon => {
        icon.addEventListener('click', () => {
            // while locked, Replacement + XPath cannot be opened
            railIcons.forEach(i => i.classList.remove('active'));
            icon.classList.add('active');
            saveState({ activeRole: icon.dataset.role });
            showView(icon.dataset.role);
        });
    });

    /* ============================================
       1.1 WEBSOCKET — the connection to the relay server
       (ADDED — without this, editor-app never had a
       real connection, only console.log)
    ============================================ */
    /* ---------- The server address — discovered BY ITSELF ----------
       Since the page and the WebSocket are served by THE SAME server,
       we simply use the same address the page itself lives at.
       - on Railway (https)  -> wss://your-domain
       - locally (http)      -> ws://127.0.0.1:8080
       - opened as file://   -> ws://127.0.0.1:8080
       That way you never have to change this line. */
    const RELAY_URL = (location.protocol === 'http:' || location.protocol === 'https:')
        ? ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host)
        : 'ws://127.0.0.1:8080';

    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    let socket = null;
    let currentCode = null;
    let reconnectDelay = 1000;
    const MAX_RECONNECT_DELAY = 15000;
    let reconnectTimer = null;

    function setUiStatus(text, isConnected) {
        statusText.textContent = text;
        statusDot.classList.toggle('connected', !!isConnected);
    }

    function connectToRelay(code) {
        currentCode = code;

        if (socket) {
            socket.close();
            socket = null;
        }
        clearTimeout(reconnectTimer);

        setUiStatus('Connecting…', false);

        socket = new WebSocket(RELAY_URL);

        socket.addEventListener('open', () => {
            reconnectDelay = 1000;
            socket.send(JSON.stringify({ type: 'register', role: 'editor', code: currentCode }));
        });

        socket.addEventListener('message', (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }

            if (msg.type === 'registered') {
                setUiStatus('Waiting for extension…', false);
            }
            if (msg.type === 'peerConnected') {
                setUiStatus('Connected', true);
            }
            if (msg.type === 'peerDisconnected') {
                setUiStatus('Waiting for extension…', false);
            }
            if (msg.type === 'error') {
                setUiStatus('Error: ' + (msg.message || 'unknown'), false);
            }
            if (msg.type === 'xpathRuleResolved') {
                handleXpathRuleResolved(msg.index, msg.xpath);
            }
            // ---- REFERENCE — same return route as 'xpathRuleResolved' ----
            if (msg.type === 'referenceResolved') {
                (activeRefPanel || refPanels[0])?.handleResolved(msg);   // STEP 1 — the path
            }
            if (msg.type === 'referenceItems') {
                (activeRefPanel || refPanels[0])?.handleItems(msg);      // STEP 2 — the inner paths
            }
            if (msg.type === 'referenceError') {
                (activeRefPanel || refPanels[0])?.setStatus(msg.message || 'Not found', 'bad');
            }
            // ---- THE RULES ----
            if (msg.type === 'rulesList') {
                window.__leHandleRulesList?.(msg);
            }
            if (msg.type === 'rulesSaved') {
                console.log('Rules stored in the extension:', msg.count);
            }
            if (msg.type === 'peerConnected') {
                // once we are really connected, fetch the list of stored rules
                setTimeout(() => window.__leRequestRules?.(), 300);
            }
        });

        socket.addEventListener('close', () => {
            setUiStatus('Not connected', false);
            scheduleReconnect();
        });

        socket.addEventListener('error', () => {
            socket?.close();
        });
    }

    function scheduleReconnect() {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            if (currentCode) connectToRelay(currentCode);
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    }

    /* Every 'apply' carries the refresh-mode flag with it. When it is on, the
       extension stores the change and touches the page with nothing — the
       change lands by itself the first time that page is refreshed. The
       read-only requests (reference / referenceRead) are never held back by
       it; they are questions about the page, not changes to it. */
    function sendUpdate(payload) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'apply',
                applyOnRefresh: refreshMode,
                anyPage: anyPageMode,
                ...payload,
            }));
            return true;
        }
        return false;
    }

    /* ============================================
       1.2 REFRESH MODE — the toggle beside "New code"
       --------------------------------------------
       OFF (default) — Apply behaves exactly as it always has: the change
                       lands on the page the moment you press it.
       ON            — Apply only stores the change and leaves the page as
                       it is; it lands by itself, straight away, the first
                       time that page is refreshed.
    ============================================ */
    const refreshModeBtn = document.getElementById('refresh-mode-btn');

    let refreshMode = state.refreshMode === true;

    function renderRefreshMode() {
        refreshModeBtn.classList.toggle('on', refreshMode);
        refreshModeBtn.setAttribute('aria-pressed', refreshMode ? 'true' : 'false');
    }

    renderRefreshMode();

    refreshModeBtn.addEventListener('click', () => {
        refreshMode = !refreshMode;
        saveState({ refreshMode });
        renderRefreshMode();
    });

    /* ============================================
       1.3 ANY PAGE — the toggle beside "Refresh"
       --------------------------------------------
       OFF (default) — the change belongs to the page you are connected to,
                       and to that page only.
       ON            — the URL is dropped altogether. The change is stored
                       once, with no address at all, and every page carries
                       it: the tabs already open and every one opened later.
                       It only ever shows on the pages where the value is
                       really found — a page that does not have it is left
                       exactly as it was.
    ============================================ */
    const anyPageBtn = document.getElementById('any-page-btn');

    let anyPageMode = state.anyPage === true;

    function renderAnyPage() {
        anyPageBtn.classList.toggle('on', anyPageMode);
        anyPageBtn.setAttribute('aria-pressed', anyPageMode ? 'true' : 'false');
    }

    renderAnyPage();

    anyPageBtn.addEventListener('click', () => {
        anyPageMode = !anyPageMode;
        saveState({ anyPage: anyPageMode });
        renderAnyPage();
    });

    // what an Apply/Save button should say once the change has gone out
    function sentLabel(wasSent, doneText) {
        if (!wasSent) return 'Not connected ✗';
        if (refreshMode) return 'On refresh ⟳';
        if (anyPageMode) return 'All pages ✓';
        return doneText;
    }

    /* ============================================
       2. THE PAIRING CODE
    ============================================ */
    const pairingCodeEl = document.getElementById('pairing-code');
    const regenBtn = document.getElementById('regen-btn');

    function generateCode(length = 6) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < length; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
    }

    function setPairingCode(code) {
        pairingCodeEl.textContent = code;
        saveState({ pairingCode: code });
        connectToRelay(code); // ADDED — connect (or reconnect) to the relay with the new code
    }

    setPairingCode(state.pairingCode || generateCode());

    regenBtn.addEventListener('click', () => {
        setPairingCode(generateCode());
    });

    pairingCodeEl.addEventListener('click', () => {
        navigator.clipboard?.writeText(pairingCodeEl.textContent).catch(() => {});
    });

    /* ============================================
       3. JS / CSS EDITORS
    ============================================ */
    const editors = [
        { key: 'js',  textarea: document.getElementById('editor-js'),  lines: document.getElementById('lines-js'),  hl: document.getElementById('hl-js')  },
        { key: 'css', textarea: document.getElementById('editor-css'), lines: document.getElementById('lines-css'), hl: document.getElementById('hl-css') },
    ];

    editors.forEach(({ key, textarea, lines, hl }) => {
        if (state[key]) {
            textarea.value = state[key];
        }
        updateLineNumbers(textarea, lines);
        highlight(textarea, hl, key);

        textarea.addEventListener('input', () => {
            updateLineNumbers(textarea, lines);
            highlight(textarea, hl, key);
            saveState({ [key]: textarea.value });
        });

        textarea.addEventListener('scroll', () => {
            lines.scrollTop = textarea.scrollTop;
            if (hl) {
                hl.scrollTop = textarea.scrollTop;
                hl.scrollLeft = textarea.scrollLeft;
            }
        });
    });

    /* ============================================
       Syntax coloring (variables one color, strings another, etc.)
       --------------------------------------------
       The trick: the textarea holds TRANSPARENT text; beneath it sits a <pre>
       with the same text, but colored. The two line up exactly.
    ============================================ */
    function escHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // put temporary marks on the parts that must not be recolored (strings,
    // comments); color those later, so keywords inside them are left alone
    function highlightJS(code) {
        const tokens = [];
        const stash = (cls, text) => {
            tokens.push('<span class="tok-' + cls + '">' + escHtml(text) + '</span>');
            return '\u0000' + (tokens.length - 1) + '\u0000';
        };

        let s = code;
        // comments
        s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => stash('comment', m));
        s = s.replace(/\/\/[^\n]*/g, (m) => stash('comment', m));
        // strings (', ", `)
        s = s.replace(/`(?:\\.|[^`\\])*`/g, (m) => stash('string', m));
        s = s.replace(/"(?:\\.|[^"\\])*"/g, (m) => stash('string', m));
        s = s.replace(/'(?:\\.|[^'\\])*'/g, (m) => stash('string', m));

        // now color the rest (outside the strings/comments)
        s = escHtml(s);
        // numbers
        s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
        // keywords
        s = s.replace(/\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|try|catch|finally|throw|typeof|instanceof|in|of|await|async|yield|delete|void|this|super|import|export|from|default|null|undefined|true|false)\b/g,
            '<span class="tok-key">$1</span>');
        // function names (the word before a parenthesis)
        s = s.replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, '<span class="tok-fn">$1</span>');

        // swap the temporary marks back for the colored parts
        s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => tokens[+i]);
        return s;
    }

    function highlightCSS(code) {
        const tokens = [];
        const stash = (cls, text) => {
            tokens.push('<span class="tok-' + cls + '">' + escHtml(text) + '</span>');
            return '\u0000' + (tokens.length - 1) + '\u0000';
        };
        let s = code;
        s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => stash('comment', m));
        s = s.replace(/(['"])(?:\\.|(?!\1).)*\1/g, (m) => stash('string', m));

        s = escHtml(s);
        // values (numbers + units + #hex)
        s = s.replace(/#[0-9a-fA-F]{3,8}\b/g, '<span class="tok-num">$&</span>');
        s = s.replace(/\b(\d+(?:\.\d+)?)(px|em|rem|%|vh|vw|deg|s|ms|fr|pt)?\b/g, '<span class="tok-num">$&</span>');
        // properties (the word before a colon)
        s = s.replace(/([a-zA-Z-]+)(\s*:)/g, '<span class="tok-prop">$1</span>$2');
        // selectors (.class, #id)
        s = s.replace(/([.#][A-Za-z_][\w-]*)/g, '<span class="tok-key">$1</span>');

        s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => tokens[+i]);
        return s;
    }

    function highlight(textarea, hl, key) {
        if (!hl) return;
        const code = textarea.value;
        hl.innerHTML = (key === 'css' ? highlightCSS(code) : highlightJS(code)) + '\n';
    }

    function updateLineNumbers(textarea, linesEl) {
        const lineCount = textarea.value.split('\n').length;
        let out = '';
        for (let i = 1; i <= lineCount; i++) out += i + '\n';
        linesEl.textContent = out.trim();
    }

    /* ============================================
       4. SAVE BUTTON — now really sends over WebSocket
    ============================================ */
    const saveBtn = document.getElementById('save-btn');

    saveBtn.addEventListener('click', () => {
        const payload = {
            js:   document.getElementById('editor-js').value,
            css:  document.getElementById('editor-css').value,
        };

        const wasSent = sendUpdate(payload);
        console.log(wasSent ? 'Sent to extension:' : 'NOT sent (no connection yet):', payload);

        saveBtn.textContent = sentLabel(wasSent, 'Saved ✓');
        saveBtn.classList.add('saved');
        setTimeout(() => {
            saveBtn.textContent = 'Save';
            saveBtn.classList.remove('saved');
        }, 1200);
    });

    /* ============================================
       4.1 CTRL+S — automatic save while you are in the Editor
    ============================================ */
    document.addEventListener('keydown', (e) => {
        const isSaveShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
        if (!isSaveShortcut) return;

        // only acts while you are on the first view (editor)
        if (viewEditor.hidden) return;

        e.preventDefault(); // stops the browser's own "Save Page As"
        saveBtn.click();
    });

    /* ============================================
       5. REPLACEMENT — dynamic Find / Value rows
    ============================================ */
    const rowsContainer = document.getElementById('replacement-rows');
    const addBtn = document.getElementById('add-replacement-btn');
    const applyBtn = document.getElementById('apply-replacement-btn');

    // shape: [{ find: '', value: '', occurrence: null }, ...]
    // 'occurrence' — empty/0 = replace ALL; 1 = only the first match; 2 = the second; etc.
    let replacements = state.replacements && state.replacements.length
        ? state.replacements
        : [{ find: '', value: '', occurrence: null }];

    function saveReplacements() {
        saveState({ replacements });
    }

    function renderReplacements() {
        rowsContainer.innerHTML = '';

        replacements.forEach((row, index) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'replace-row';

            rowEl.innerHTML = `
                <div class="replace-row__field">
                    <label>Find</label>
                    <input type="text" class="replace-find" placeholder="Text to find">
                </div>
                <div class="replace-row__field">
                    <label>Replace</label>
                    <input type="text" class="replace-value" placeholder="New value">
                </div>
                <div class="replace-row__field replace-row__field--narrow">
                    <label>Match #</label>
                    <input type="number" class="replace-occurrence" min="0" placeholder="all">
                </div>
                <button class="replace-row__remove" title="Remove this row">×</button>
            `;

            const findInput = rowEl.querySelector('.replace-find');
            const valueInput = rowEl.querySelector('.replace-value');
            const occurrenceInput = rowEl.querySelector('.replace-occurrence');
            const removeBtn = rowEl.querySelector('.replace-row__remove');

            findInput.value = row.find;
            valueInput.value = row.value;
            occurrenceInput.value = row.occurrence ?? '';

            findInput.addEventListener('input', () => {
                replacements[index].find = findInput.value;
                saveReplacements();
            });

            valueInput.addEventListener('input', () => {
                replacements[index].value = valueInput.value;
                saveReplacements();
            });

            occurrenceInput.addEventListener('input', () => {
                const val = parseInt(occurrenceInput.value, 10);
                replacements[index].occurrence = (!val || val <= 0) ? null : val;
                saveReplacements();
            });

            removeBtn.addEventListener('click', () => {
                if (replacements.length === 1) {
                    replacements[0] = { find: '', value: '', occurrence: null };
                } else {
                    replacements.splice(index, 1);
                }
                saveReplacements();
                renderReplacements();
            });

            rowsContainer.appendChild(rowEl);
        });
    }

    renderReplacements();

    addBtn.addEventListener('click', () => {
        replacements.push({ find: '', value: '', occurrence: null });
        saveReplacements();
        renderReplacements();
    });

    applyBtn.addEventListener('click', () => {
        const validRules = replacements.filter(r => r.find.trim() !== '');

        const wasSent = sendUpdate({ replacements: validRules });
        console.log(wasSent ? 'Sent replacements to extension:' : 'NOT sent (no connection yet):', validRules);

        applyBtn.textContent = sentLabel(wasSent, 'Applied ✓');
        applyBtn.classList.add('saved');
        setTimeout(() => {
            applyBtn.textContent = 'Apply';
            applyBtn.classList.remove('saved');
        }, 1200);
    });

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str ?? '';
        return div.innerHTML;
    }

    /* ============================================
       6. XPATH — identical to Replacement in the UI, but it searches
       the text everywhere — it finds 1 specific element (by Match #)
       ONLY THE FIRST TIME, then "locks" onto that fixed xpath —
       it stops moving, even if the backend changes the values later
    ============================================ */
    const xpathRowsContainer = document.getElementById('xpath-rows');
    const addXpathBtn = document.getElementById('add-xpath-btn');
    const applyXpathBtn = document.getElementById('apply-xpath-btn');

    // shape: { find, value, occurrence, xpath }
    // 'xpath' — empty until it is discovered the first time; then it stays FIXED
    let xpathRules = state.xpathRules && state.xpathRules.length
        ? state.xpathRules
        : [{ find: '', value: '', occurrence: null, xpath: null }];

    function saveXpathRules() {
        saveState({ xpathRules });
    }

    const pendingXpathIndexes = new Set(); // rows still waiting for a "searching..." reply

    function handleXpathRuleResolved(index, xpath) {
        if (!xpathRules[index]) return;

        /* In "any page" mode a path found on one page is worthless on the
           next one, so it is never stored: the rule keeps looking by value,
           and every page finds its own element. */
        if (anyPageMode) {
            pendingXpathIndexes.delete(index);
            renderXpathRules();
            return;
        }

        // 1. Update the state with the new XPath
        xpathRules[index].xpath = xpath;
        pendingXpathIndexes.delete(index);
        saveXpathRules();
        renderXpathRules();
        // --- THE NEW ADDITION HERE ---
        // 2. As soon as we have the new XPath, automatically send the replace
        // command (as if the "Apply" button had been clicked a second time).
        const validRules = xpathRules
            .map((r, idx) => ({ ...r, index: idx }))
            .filter(r => r.find.trim() !== '');
        const wasSent = sendUpdate({ xpathReplacements: validRules });

        if (wasSent) {
            console.log('Auto-sent updated xpath rules to extension:', validRules);
            // Optional: you could also make the button pulse green "Applied ✓"
            // for visual feedback without clicking it yourself.
            applyXpathBtn.textContent = sentLabel(true, 'Applied ✓');
            applyXpathBtn.classList.add('saved');
            setTimeout(() => {
                applyXpathBtn.textContent = 'Apply';
                applyXpathBtn.classList.remove('saved');
            }, 1200);
        }
    }

    function renderXpathRules() {
        xpathRowsContainer.innerHTML = '';

        xpathRules.forEach((row, index) => {
            const wrapEl = document.createElement('div');
            wrapEl.className = 'xpath-row-wrap';

            const rowEl = document.createElement('div');
            rowEl.className = 'replace-row';

            /* In refresh mode nothing searches while you press Apply — the page
               itself finds the path when it reloads. Saying "on Apply" there
               only makes you wait for something that is never going to happen
               until you refresh. */
            const pathText = row.xpath
                ? escapeHtml(row.xpath)
                : (pendingXpathIndexes.has(index)
                    ? 'Searching…'
                    : (refreshMode
                        ? 'Not found yet — it will be found when the page is refreshed'
                        : 'Not found yet — it will be found on Apply'));

            rowEl.innerHTML = `
                <div class="replace-row__field">
                    <label>Find</label>
                    <input type="text" class="xpath-find" placeholder="Text to find">
                </div>
                <div class="replace-row__field">
                    <label>Replace</label>
                    <input type="text" class="xpath-value" placeholder="New value">
                </div>
                <div class="replace-row__field replace-row__field--narrow">
                    <label>Match #</label>
                    <input type="number" class="xpath-occurrence" min="0" placeholder="first">
                </div>
                <button class="replace-row__remove" title="Remove this row">×</button>
            `;

            const findInput = rowEl.querySelector('.xpath-find');
            const valueInput = rowEl.querySelector('.xpath-value');
            const occInput = rowEl.querySelector('.xpath-occurrence');
            const removeBtn = rowEl.querySelector('.replace-row__remove');

            findInput.value = row.find;
            valueInput.value = row.value;
            occInput.value = row.occurrence ?? '';

            findInput.addEventListener('input', () => {
                xpathRules[index].find = findInput.value;
                xpathRules[index].xpath = null; // the reference changed — it must be found again
                saveXpathRules();
            });

            valueInput.addEventListener('input', () => {
                xpathRules[index].value = valueInput.value;
                saveXpathRules();
            });

            occInput.addEventListener('input', () => {
                const val = parseInt(occInput.value, 10);
                xpathRules[index].occurrence = (!val || val <= 0) ? null : val;
                xpathRules[index].xpath = null; // the match number changed — it must be found again
                saveXpathRules();
            });

            removeBtn.addEventListener('click', () => {
                if (xpathRules.length === 1) {
                    xpathRules[0] = { find: '', value: '', occurrence: null, xpath: null };
                } else {
                    xpathRules.splice(index, 1);
                }
                saveXpathRules();
                renderXpathRules();
            });

            const pathEl = document.createElement('div');
            pathEl.className = 'xpath-path-display';
            pathEl.innerHTML = pathText;

            wrapEl.appendChild(rowEl);
            wrapEl.appendChild(pathEl);
            xpathRowsContainer.appendChild(wrapEl);
        });
    }

    renderXpathRules();

    addXpathBtn.addEventListener('click', () => {
        xpathRules.push({ find: '', value: '', occurrence: null, xpath: null });
        saveXpathRules();
        renderXpathRules();
    });

    applyXpathBtn.addEventListener('click', () => {
        const validRules = xpathRules
            .map((r, index) => ({ ...r, index }))
            .filter(r => r.find.trim() !== '');

        const wasSent = sendUpdate({ xpathReplacements: validRules });
        console.log(wasSent ? 'Sent xpath rules to extension:' : 'NOT sent (no connection yet):', validRules);

        // mark "searching..." right away on rows that have no xpath yet — this
        // way you see the first click started it, instead of needing 2 clicks
        // in refresh mode nothing searches yet — the page itself resolves the
        // path when it reloads, so there is no reply to wait for
        if (wasSent && !refreshMode) {
            xpathRules.forEach((r, i) => {
                if (!r.xpath && r.find.trim() !== '') {
                    pendingXpathIndexes.add(i);
                }
            });
            renderXpathRules();
        }

        applyXpathBtn.textContent = sentLabel(wasSent, 'Applied ✓');
        applyXpathBtn.classList.add('saved');
        setTimeout(() => {
            applyXpathBtn.textContent = 'Apply';
            applyXpathBtn.classList.remove('saved');
        }, 1200);
    });

    /* ============================================
       7. REFERENCE — part of XPath, using THE SAME method
       --------------------------------------------
       The same route as XPath (this is the one that works 100%):

         editor  --sendUpdate({reference})-->  relay  -->  background
                 --chrome.tabs.sendMessage-->  content-script
         content-script --chrome.runtime.sendMessage--> background
                 --sendToRelay-->  editor   ('referenceResolved')

       A single "Search" button: finds the value, returns the path and reads
       everything inside it. The arrows move the path themselves. Everything
       inside is changed by ITS OWN XPATH (not as an element, as in Replacement).
    ============================================ */
    /* ============================================
       7.0 THE REFERENCE PANEL FACTORY
       --------------------------------------------
       One panel = one independent reference, with its own search, arrows,
       preview, element list and buttons. You can add as many as you like
       with "+ Add reference"; every one except the first also carries
       "Remove reference".

       The edits (refEdits) and the clones (refClones) are SHARED —
       keyed by the full xpath, so two panels never collide with
       each other.
    ============================================ */
    let refEdits  = state.refEdits  || {};   // { "<xpath>|kind|nodeIndex|attr": {...} }
    let refClones = state.refClones || [];   // [{ id, xpath, position, edits }]

    /* Does a COPY already own these edits?

       "Create new" stores a snapshot of the edits inside the clone itself
       (c.edits) and the clone applies them to its own copy. At the same time
       they stayed in refEdits too — and refEdits feeds 'referenceEdits', which
       is applied to the ORIGINAL. That is why the copy appeared on top AND the
       original below it changed along with it.

       The rule is derived STRAIGHT from refClones, not from a list kept aside:
       such a list fell out of sync the moment you pressed "Apply". This way
       there is no second state to break — as long as the copy exists, the
       edits belong to it. Delete the copy and the original is free again. */
    function isClonedAway(xpath) {
        if (!xpath) return false;
        return refClones.some((c) =>
            c.xpath && (xpath === c.xpath || xpath.startsWith(c.xpath + '/'))
        );
    }

    const refPanels = [];                    // every open panel
    let activeRefPanel = null;               // who made the last request

    const refPanelsHost = document.getElementById('ref-panels');
    const refPanelTpl   = document.getElementById('ref-panel-template');
    const refAddBtn     = document.getElementById('ref-add-btn');
    const applyAllBtn   = document.getElementById('apply-all-btn');

    function persistPanels() {
        saveState({
            refPanelsState: refPanels.map((p) => p.getInit()),
        });
    }

    function createRefPanel(root, init) {
        const self = {};   // this panel's identity (for routing the responses)
        const REF_TRANSPARENT_PX =
            'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

        const refFindInput    = root.querySelector('[data-el="ref-find"]');
        const refOccInput     = root.querySelector('[data-el="ref-occurrence"]');
        const refFindBtn      = root.querySelector('[data-el="ref-find-btn"]');

        const refXpathInput   = root.querySelector('[data-el="ref-xpath-input"]');
        const refUpBtn        = root.querySelector('[data-el="ref-up-btn"]');
        const refDownBtn      = root.querySelector('[data-el="ref-down-btn"]');
        const refPrevBtn      = root.querySelector('[data-el="ref-prev-btn"]');
        const refNextBtn      = root.querySelector('[data-el="ref-next-btn"]');
        const refRefreshBtn   = root.querySelector('[data-el="ref-refresh-btn"]');
        const refStatusEl     = root.querySelector('[data-el="ref-status"]');

        const refLiveFrame    = root.querySelector('[data-el="ref-live"]');
        const refBox          = root.querySelector('[data-el="ref-box"]');
        const refStage        = root.querySelector('[data-el="ref-stage"]');
        const refPreviewEmpty = root.querySelector('[data-el="ref-preview-empty"]');

        const refMetaTag      = root.querySelector('[data-el="ref-meta-tag"]');
        const refMetaId       = root.querySelector('[data-el="ref-meta-id"]');
        const refMetaClass    = root.querySelector('[data-el="ref-meta-class"]');
        const refMetaSize     = root.querySelector('[data-el="ref-meta-size"]');
        const refMetaXpath    = root.querySelector('[data-el="ref-meta-xpath"]');

        const refItemsEl      = root.querySelector('[data-el="ref-items"]');
        const refItemsCount   = root.querySelector('[data-el="ref-items-count"]');
        const refApplyBtn     = root.querySelector('[data-el="ref-apply-btn"]');
        const refClearBtn     = root.querySelector('[data-el="ref-clear-btn"]');
        const refFilterInput  = root.querySelector('[data-el="ref-filter"]');
        const refCreateBtn    = root.querySelector('[data-el="ref-create-btn"]');
        const refPositionSel  = root.querySelector('[data-el="ref-position"]');

        let refXpath    = init.xpath || '';
        let refItems    = [];
        let refSnapshot = null; // { html, css, baseHref } — the original, for the local live rebuild
        let refFilter   = '';

        let refSiblingCount = 0;                  // how many siblings the current element has (for the position list)

        refFindInput.value  = init.find || '';
        refOccInput.value   = init.occurrence ?? '';
        refXpathInput.value = refXpath;
        refMetaXpath.textContent = refXpath || '—';

        refBuildPositionOptions(1, 0);   // so the dropdown is never empty

        const REF_KIND_LABEL = {
            text:  'TEXT',
            image: 'IMAGE',
            bg:    'BACKGROUND',
            attr:  'ATTRIBUTE',
            value: 'INPUT',
            html:  'HTML',
        };

        function refSetStatus(text, tone) {
            refStatusEl.textContent = text || '';
            refStatusEl.className = 'refstatus' + (tone ? ' refstatus--' + tone : '');
        }

        /* ---------- 7.1 the requests — always through sendUpdate (the route that works) ---------- */
        function refRequest(ref) {
            activeRefPanel = self;   // the reply belongs to this panel
            const wasSent = sendUpdate({ reference: ref });
            console.log(wasSent ? 'Sent reference request:' : 'NOT sent (no connection yet):', ref);
            if (!wasSent) refSetStatus('No connection to the extension', 'bad');
            return wasSent;
        }

        refFindBtn.addEventListener('click', () => {
            const find = refFindInput.value.trim();
            if (!find) {
                refSetStatus('Type a value to find', 'bad');
                return;
            }
            const occRaw = parseInt(refOccInput.value, 10);
            const occurrence = (!occRaw || occRaw <= 0) ? null : occRaw;

            persistPanels();

            if (refRequest({ find, occurrence })) {
                refSetStatus('Finding the path…', 'wait');
                refFindBtn.textContent = 'Searching…';
                setTimeout(() => { refFindBtn.textContent = 'Search'; }, 1500);
            }
        });

        refFindInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') refFindBtn.click();
        });

        function refMove(direction) {
            if (!refXpath) {
                refSetStatus('Find a reference first', 'bad');
                return;
            }
            if (refRequest({ xpath: refXpath, direction })) {
                refSetStatus('Moving the path…', 'wait');
            }
        }

        refUpBtn.addEventListener('click',   () => refMove('parent'));
        refDownBtn.addEventListener('click', () => refMove('firstChild'));
        refPrevBtn.addEventListener('click', () => refMove('prev'));
        refNextBtn.addEventListener('click', () => refMove('next'));

        refRefreshBtn.addEventListener('click', () => {
            const xpath = refXpathInput.value.trim();
            if (!xpath) {
                refSetStatus('No path to refresh', 'bad');
                return;
            }
            if (refRequest({ xpath })) refSetStatus('Reading the path…', 'wait');
        });

        refXpathInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            refXpath = refXpathInput.value.trim();
            persistPanels();
            if (refRequest({ xpath: refXpath })) refSetStatus('Reading the path…', 'wait');
        });

        refFilterInput.addEventListener('input', () => {
            refFilter = refFilterInput.value.trim().toLowerCase();
            renderRefItems();
        });

        /* ---------- 7.2 the replies — 2 steps (Snapshot was removed) ---------- */

        // STEP 1 — the PATH arrived (a small message, it cannot fail)
        function handleReferenceResolved(msg) {
            refXpath = msg.xpath || '';
            refXpathInput.value = refXpath;
            refMetaXpath.textContent = refXpath || '—';
            persistPanels();

            const meta = msg.meta || {};
            refMetaTag.textContent   = meta.tag || '—';
            refMetaId.textContent    = meta.id || '—';
            refMetaClass.textContent = meta.className || '—';
            refMetaSize.textContent  = meta.width != null
                ? `${Math.round(meta.width)} × ${Math.round(meta.height)} px`
                : '—';

            refSetStatus('Path found ✓ — reading what is inside…', 'ok');

            // build the position list FROM REALITY — how many siblings there
            // really are, so you cannot go further than the last one
            refSiblingCount = meta.siblingCount || 1;
            refBuildPositionOptions(refSiblingCount, meta.siblingIndex ?? 0);

            // STEP 2 — ask for the paths inside
            activeRefPanel = self;
            sendUpdate({ referenceRead: refXpath });
        }

        // the position list: 0 = at the start, n = after the nth sibling (n = end)
        function refBuildPositionOptions(count, currentIndex) {
            refPositionSel.innerHTML = '';
            if (!count || count < 1) count = 1;   // never empty

            const optFirst = document.createElement('option');
            optFirst.value = '0';
            optFirst.textContent = 'At the start (default)';
            refPositionSel.appendChild(optFirst);

            for (let i = 1; i <= count; i++) {
                const opt = document.createElement('option');
                opt.value = String(i);
                if (i === count) {
                    opt.textContent = `At the end (after #${i})`;
                } else if (i === currentIndex + 1) {
                    opt.textContent = `After this one (#${i})`;
                } else {
                    opt.textContent = `After #${i}`;
                }
                refPositionSel.appendChild(opt);
            }

            refPositionSel.value = '0'; // no choice made = the first one
        }

        // STEP 2 — the inner PATHS arrived + the snapshot (the original, no edits yet)
        function handleReferenceItems(msg) {
            if (msg.xpath && msg.xpath !== refXpath) return;

            refItems = Array.isArray(msg.items) ? msg.items : [];
            refSnapshot = msg.snapshot || null;

            renderRefItems();
            refRebuildLivePreview();

            refSetStatus(`Ready — ${refItems.length} paths inside this path`, 'ok');
        }

        /* ---------- 7.3 the LIVE rebuild (local, inside the browser, not on the page) ----------
           Takes the original HTML+CSS (snapshot), applies every ENABLED edit on
           top of it (even before you press Apply), and shows it inside an <iframe>.
           It never touches the target page — only a preview of "how it would look".
           ---------------------------------------------------------------- */
        function refEscapeAttr(str) {
            return String(str ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        }

        // finds the element inside 'contextEl' by its localXpath (relative to the cloned root)
        function refFindLocal(doc, contextEl, localXpath) {
            if (!localXpath || localXpath === '.') return contextEl;
            try {
                const result = doc.evaluate(localXpath, contextEl, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue;
            } catch {
                return null;
            }
        }

        function refApplyEditsToClone(doc, rootEl) {
            refItems.forEach((item) => {
                const edit = refEdits[item.key];
                if (!edit) return;

                const target = refFindLocal(doc, rootEl, item.localXpath);
                if (!target) return;

                // colors ALWAYS apply when they are set — regardless of the toggle
                if (edit.color)   target.style.setProperty('color', edit.color, 'important');
                if (edit.bgColor) target.style.setProperty('background-color', edit.bgColor, 'important');

                if (!edit.enabled) return; // the rest only if it has been enabled

                const val = edit.value ?? '';

                if (item.kind === 'text') {
                    const texts = Array.from(target.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
                    const node =
                        (item.nodeIndex != null && texts[item.nodeIndex]) ||
                        texts.find((n) => n.textContent.trim()) ||
                        texts[0];
                    if (node) {
                        node.textContent = val;
                    } else if (val) {
                        target.appendChild(doc.createTextNode(val));
                    }
                } else if (item.kind === 'image') {
                    if (val.trim()) {
                        target.setAttribute('src', val.trim());
                        target.removeAttribute('srcset');
                        target.style.visibility = '';
                    } else {
                        target.setAttribute('src', REF_TRANSPARENT_PX);
                        target.style.visibility = 'hidden';
                    }
                } else if (item.kind === 'bg') {
                    target.style.setProperty('background-image', val.trim() ? `url("${val.trim()}")` : 'none', 'important');
                } else if (item.kind === 'attr') {
                    if (val === '') target.removeAttribute(item.attr);
                    else target.setAttribute(item.attr, val);
                } else if (item.kind === 'value') {
                    target.setAttribute('value', val); // preview only
                } else if (item.kind === 'html') {
                    target.innerHTML = val;
                }
            });
        }

        // some elements are not valid on their own — they need the right parent,
        // otherwise the HTML parser drops them silently (this is why a table
        // <tr> "vanished" — it means nothing outside <table><tbody>)
        const REF_WRAP_TAGS = {
            tr:       { open: '<table><tbody>',           close: '</tbody></table>' },
            td:       { open: '<table><tbody><tr>',        close: '</tr></tbody></table>' },
            th:       { open: '<table><tbody><tr>',        close: '</tr></tbody></table>' },
            tbody:    { open: '<table>',                   close: '</table>' },
            thead:    { open: '<table>',                   close: '</table>' },
            tfoot:    { open: '<table>',                   close: '</table>' },
            col:      { open: '<table><colgroup>',         close: '</colgroup></table>' },
            colgroup: { open: '<table>',                   close: '</table>' },
            li:       { open: '<ul>',                      close: '</ul>' },
            option:   { open: '<select>',                  close: '</select>' },
            optgroup: { open: '<select>',                  close: '</select>' },
        };

        function refGetRootTag(html) {
            const m = (html || '').match(/^\s*<([a-zA-Z0-9-]+)/);
            return m ? m[1].toLowerCase() : '';
        }

        // builds the wrapper from the REAL parent chain (with classes/ids), so that
        // CSS selectors like ".tx-table tbody tr td" match inside the preview too
        function refBuildWrapFromAncestors(ancestors) {
            if (!Array.isArray(ancestors) || ancestors.length === 0) return null;

            let open = '';
            let close = '';

            ancestors.forEach((a) => {
                const idAttr = a.id ? ` id="${refEscapeAttr(a.id)}"` : '';
                const clsAttr = a.className ? ` class="${refEscapeAttr(a.className)}"` : '';
                open += `<${a.tag}${idAttr}${clsAttr}>`;
                close = `</${a.tag}>` + close;
            });

            return { open, close };
        }

        /* ---------- 7.3b THE WHOLE PAGE — a picture of the page, not of the element ----------
           The extension now sends the entire page along with the element, and the
           element carries a mark. So the preview shows the page exactly as it
           stands — the whole width of it — and draws the lilac outline around
           the ONE object you picked, so you see at a glance where it sits.

           The page is laid out at a real desktop width and the frame is then
           shrunk to fit the box, like a photograph: the proportions stay true,
           nothing reflows into a phone layout.
           ---------------------------------------------------------------- */
        const REF_PAGE_WIDTH  = 1280;    // the width the page is laid out at
        const REF_PAGE_MAX_H  = 12000;   // never build a stage taller than this
        const REF_TARGET_MARK = 'data-le-ref-target';

        let refPageTimer = null;
        let refFitTimer  = null;

        function refSchedulePagePreview() {
            clearTimeout(refPageTimer);
            refPageTimer = setTimeout(refRenderPagePreview, 120);
        }

        // back to the old element-only preview (no page came with the snapshot)
        function refClearPageMode() {
            refBox.classList.remove('ref-preview__box--page');
            refStage.style.width = '';
            refStage.style.height = '';
            refLiveFrame.style.width = '';
            refLiveFrame.style.height = '';
            refLiveFrame.style.transform = '';
        }

        function refRenderPagePreview() {
            if (!refSnapshot || !refSnapshot.page) return;

            refPreviewEmpty.hidden = true;
            refLiveFrame.hidden = false;
            refBox.classList.add('ref-preview__box--page');

            let html = refSnapshot.page;

            try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const head = doc.head || doc.documentElement;
                const target = doc.querySelector('[' + REF_TARGET_MARK + ']');

                // every relative image and stylesheet still has to resolve
                if (refSnapshot.baseHref) {
                    const base = doc.createElement('base');
                    base.setAttribute('href', refSnapshot.baseHref);
                    head.insertBefore(base, head.firstChild);
                }

                // the edits you have switched on, shown before Apply — as ever
                if (target) refApplyEditsToClone(doc, target);

                const style = doc.createElement('style');
                style.textContent =
                    'html{overflow-x:hidden!important;}' +
                    '[' + REF_TARGET_MARK + ']{' +
                        'outline:3px solid #ca9ee6!important;' +
                        'outline-offset:2px!important;' +
                        'box-shadow:0 0 0 3px rgba(202,158,230,.45),0 0 0 9999px rgba(35,38,52,.38)!important;' +
                        'position:relative!important;' +
                        'z-index:2147483646!important;' +
                        'animation:leRefPulse 1.4s ease-in-out 4;' +
                    '}' +
                    '@keyframes leRefPulse{0%,100%{outline-color:#ca9ee6;}50%{outline-color:#f4b8e4;}}';
                head.appendChild(style);

                html = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
            } catch (err) {
                console.error('[LiveEditor REF] whole-page preview failed:', err);
            }

            refLiveFrame.onload = () => refFitPagePreview(true);
            refLiveFrame.srcdoc = html;
        }

        /* Lay it out at REF_PAGE_WIDTH, shrink the frame to the width of the box,
           and give the stage the SCALED size — the box then scrolls over a true
           picture of the page. */
        function refFitPagePreview(scrollToTarget) {
            if (!refBox.classList.contains('ref-preview__box--page')) return;

            const boxWidth = refBox.clientWidth || REF_PAGE_WIDTH;
            const scale = Math.min(1, boxWidth / REF_PAGE_WIDTH);

            // the width goes FIRST: the page has to be measured at the width it
            // will really be shown at, or every vh/% height comes out wrong
            refLiveFrame.style.width = REF_PAGE_WIDTH + 'px';
            refLiveFrame.style.transform = 'scale(' + scale + ')';

            let pageHeight = 0;
            try {
                const d = refLiveFrame.contentDocument;
                pageHeight = d ? Math.max(
                    d.documentElement.scrollHeight,
                    d.body ? d.body.scrollHeight : 0
                ) : 0;
            } catch {}

            const height = Math.min(Math.max(pageHeight, 400), REF_PAGE_MAX_H);

            refLiveFrame.style.height = height + 'px';
            refStage.style.width  = Math.round(REF_PAGE_WIDTH * scale) + 'px';
            refStage.style.height = Math.round(height * scale) + 'px';

            if (scrollToTarget) {
                // open it right where the marked object is
                try {
                    const el = refLiveFrame.contentDocument.querySelector('[' + REF_TARGET_MARK + ']');
                    if (el) {
                        const top = el.getBoundingClientRect().top
                            + (refLiveFrame.contentWindow.scrollY || 0);
                        refBox.scrollTop = Math.max(0, (top * scale) - (refBox.clientHeight / 3));
                    }
                } catch {}

                // images and fonts land late and change the height — measure again
                clearTimeout(refFitTimer);
                refFitTimer = setTimeout(() => refFitPagePreview(false), 400);
            }
        }

        // the box changes width with the window; the stage is sized in pixels
        window.addEventListener('resize', () => {
            clearTimeout(refFitTimer);
            refFitTimer = setTimeout(() => refFitPagePreview(false), 150);
        });

        function refRebuildLivePreview() {
            if (!refSnapshot || !refSnapshot.html) {
                refLiveFrame.removeAttribute('srcdoc');
                refLiveFrame.hidden = true;
                refPreviewEmpty.hidden = false;
                refClearPageMode();
                return;
            }

            /* The whole page, whenever the extension managed to send it — which
               is always, unless the page was far too big to carry. Otherwise the
               old element-only preview below takes over. */
            if (refSnapshot.page) {
                refSchedulePagePreview();
                return;
            }

            refClearPageMode();
            refPreviewEmpty.hidden = true;
            refLiveFrame.hidden = false;

            // prefer the tag that came straight from the page (reliable); if it is
            // missing (older snapshots), guess it from the text itself
            const rootTag = (refSnapshot.tag || refGetRootTag(refSnapshot.html) || '').toLowerCase();

            // 1) the REAL parent chain (the best — it keeps the styling);
            // 2) otherwise the generic wrapper (at least a valid structure)
            const wrap = refBuildWrapFromAncestors(refSnapshot.ancestors) || REF_WRAP_TAGS[rootTag];

            let bodyHtml = null;

            try {
                const parser = new DOMParser();

                // MARK the target element with a unique attribute — without this,
                // when the element is e.g. a <div> and its parents/children hold
                // other divs, a search by tag grabbed the wrong div (the deeper one)
                const MARK = 'data-le-target';
                const markedHtml = refSnapshot.html.replace(
                    /^(\s*<[a-zA-Z0-9-]+)/,
                    `$1 ${MARK}="1"`
                );

                // if a parent is required, wrap it FOR PARSING as well — otherwise
                // DOMParser would drop it exactly as the browser normally does
                const forParsing = wrap ? (wrap.open + markedHtml + wrap.close) : markedHtml;
                const doc = parser.parseFromString(forParsing, 'text/html');

                // find the target element EXACTLY by the mark we placed
                let rootEl = doc.querySelector(`[${MARK}="1"]`);

                // fallback: if the mark did not survive (rare), walk down by the
                // depth of the parent chain
                if (!rootEl) {
                    let node = doc.body;
                    const depth = Array.isArray(refSnapshot.ancestors) ? refSnapshot.ancestors.length : 0;
                    for (let i = 0; i < depth && node; i++) node = node.firstElementChild;
                    rootEl = node ? node.firstElementChild : doc.body.firstElementChild;
                }

                if (!rootEl) {
                    console.error('[LiveEditor REF] rootEl not found for tag:', rootTag, '— forParsing:', forParsing.slice(0, 300));
                } else {
                    rootEl.removeAttribute(MARK); // drop the mark before showing it
                    refApplyEditsToClone(doc, rootEl);

                    // the lilac highlight lives ONLY here, in the preview — never on the real page
                    rootEl.style.outline = '2px solid #ca9ee6';
                    rootEl.style.outlineOffset = '1px';

                    // put it back on screen INSIDE the same "parent", so structure and styling survive
                    bodyHtml = wrap ? (wrap.open + rootEl.outerHTML + wrap.close) : rootEl.outerHTML;
                }
            } catch (err) {
                console.error('[LiveEditor REF] live-preview parsing failed:', err);
            }

            // NEVER show the "bare" original — if parsing failed and the element
            // needs a parent (tr/td/li/etc.), the text would vanish again. In that
            // case, wrap it once more before putting it on screen.
            if (bodyHtml === null) {
                bodyHtml = wrap ? (wrap.open + refSnapshot.html + wrap.close) : refSnapshot.html;
            }

            refLiveFrame.srcdoc = [
                '<!DOCTYPE html><html><head><meta charset="utf-8">',
                refSnapshot.baseHref ? `<base href="${refEscapeAttr(refSnapshot.baseHref)}">` : '',
                '<style>html,body{margin:0;padding:0;background:#fff;}</style>',
                refSnapshot.css ? `<style>${refSnapshot.css}</style>` : '',
                '</head><body>',
                bodyHtml,
                // automatic scale-down — wide elements (e.g. a table row at
                // 1082px) should be seen IN FULL inside the narrow preview box
                `<script>
                    (function () {
                        function fit() {
                            document.body.style.transformOrigin = 'top left';
                            document.body.style.transform = 'none';
                            document.body.style.width = '';

                            // measure the real content width (not just the first child's)
                            var w = 0;
                            Array.prototype.forEach.call(document.body.children, function (c) {
                                w = Math.max(w, c.scrollWidth, c.getBoundingClientRect().width);
                            });

                            var avail = document.documentElement.clientWidth;
                            if (w > avail && w > 0) {
                                var scale = avail / w;
                                document.body.style.width = w + 'px';
                                document.body.style.transform = 'scale(' + scale + ')';
                            }
                        }
                        window.addEventListener('load', fit);
                        setTimeout(fit, 60);
                        setTimeout(fit, 300);
                    })();
                <\/script>`,
                '</body></html>',
            ].join('');
        }

        /* ---------- 7.4 the paths inside the reference ---------- */
        function refShorten(str, max) {
            const s = (str ?? '').replace(/\s+/g, ' ').trim();
            return s.length > max ? s.slice(0, max) + '…' : s;
        }

        function renderRefItems() {
            refItemsEl.innerHTML = '';

            const visible = refItems.filter((item) => {
                if (!refFilter) return true;
                return (
                    (item.label || '').toLowerCase().includes(refFilter) ||
                    (item.value || '').toLowerCase().includes(refFilter) ||
                    (item.xpath || '').toLowerCase().includes(refFilter)
                );
            });

            refItemsCount.textContent = `${visible.length} / ${refItems.length}`;

            if (refItems.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'refitem__empty';
                empty.textContent = 'No reference yet. Type a value above and click "Search".';
                refItemsEl.appendChild(empty);
                return;
            }

            visible.forEach((item) => refItemsEl.appendChild(buildRefItemCard(item)));
        }

        function buildRefItemCard(item) {
            const key = item.key;
            const edit = refEdits[key] || { enabled: false, value: item.value ?? '' };

            const card = document.createElement('div');
            card.className = 'refitem' + (edit.enabled ? ' refitem--on' : '');

            const isImage = item.kind === 'image' || item.kind === 'bg';
            const isLong  = item.kind === 'text' || item.kind === 'html';

            card.innerHTML = `
                <div class="refitem__head">
                    <span class="refitem__kind refitem__kind--${item.kind}">${REF_KIND_LABEL[item.kind] || item.kind}</span>
                    <span class="refitem__label" title="${refEscapeAttr(item.xpath || '')}">${escapeHtml(item.label || '')}</span>
                    <label class="refitem__switch" title="Enable this edit">
                        <input type="checkbox" class="refitem__enable">
                        <span></span>
                    </label>
                </div>
                ${isImage ? `<div class="refitem__thumb"><img alt="" ${item.value ? `src="${refEscapeAttr(item.value)}"` : ''}></div>` : ''}
                <div class="refitem__orig" title="Current value on the page">${escapeHtml(refShorten(item.value, 160)) || '<i>empty</i>'}</div>
                <div class="refitem__editor">
                    ${isLong
                ? `<textarea class="refitem__input" rows="2" placeholder="leave empty -> becomes empty"></textarea>`
                : `<input type="text" class="refitem__input" placeholder="${isImage ? 'Image URL — empty -> hidden' : 'New value — empty -> removed'}">`}
                    <button class="refitem__blank" title="Make it empty">∅</button>
                </div>
                <div class="refitem__colors">
                    <label title="Text color">Text <input type="color" class="refitem__color"></label>
                    <label title="Background color">Background <input type="color" class="refitem__bg"></label>
                    <button class="refitem__color-clear" title="Clear the colors">×</button>
                </div>
                <div class="refitem__path" title="this is the path that gets used">${escapeHtml(item.xpath || '')}${item.attr ? ' @' + escapeHtml(item.attr) : ''}</div>
            `;

            const enableEl = card.querySelector('.refitem__enable');
            const inputEl  = card.querySelector('.refitem__input');
            const blankEl  = card.querySelector('.refitem__blank');
            const thumbEl  = card.querySelector('.refitem__thumb img');
            const colorEl      = card.querySelector('.refitem__color');
            const bgEl         = card.querySelector('.refitem__bg');
            const clearColorEl = card.querySelector('.refitem__color-clear');

            enableEl.checked = !!edit.enabled;
            inputEl.value = edit.value ?? (item.value ?? '');

            // colors saved earlier (if any)
            if (edit.color)   { colorEl.value = edit.color;  colorEl.dataset.set = '1'; }
            if (edit.bgColor) { bgEl.value    = edit.bgColor; bgEl.dataset.set   = '1'; }

            function commit() {
                refEdits[key] = {
                    ...(refEdits[key] || {}),
                    enabled: enableEl.checked,
                    value: inputEl.value,
                };
                card.classList.toggle('refitem--on', enableEl.checked);
                saveState({ refEdits });
                if (thumbEl && enableEl.checked) {
                    const v = inputEl.value.trim();
                    thumbEl.src = v || REF_TRANSPARENT_PX;
                }
                refRebuildLivePreview(); // ADDED — shows at once how it would look, without waiting for Apply
            }

            // colors apply even with the toggle off — they are independent
            function commitColors() {
                refEdits[key] = {
                    ...(refEdits[key] || { enabled: enableEl.checked, value: inputEl.value }),
                    color:   colorEl.dataset.set === '1' ? colorEl.value : '',
                    bgColor: bgEl.dataset.set   === '1' ? bgEl.value    : '',
                };
                saveState({ refEdits });
                refRebuildLivePreview();
            }

            enableEl.addEventListener('change', commit);
            inputEl.addEventListener('input', () => {
                if (!enableEl.checked) enableEl.checked = true; // as soon as you type -> it switches itself on
                commit();
            });
            blankEl.addEventListener('click', () => {
                inputEl.value = '';
                enableEl.checked = true;
                commit();
            });

            colorEl.addEventListener('input', () => { colorEl.dataset.set = '1'; commitColors(); });
            bgEl.addEventListener('input',    () => { bgEl.dataset.set    = '1'; commitColors(); });
            clearColorEl.addEventListener('click', () => {
                colorEl.dataset.set = '0';
                bgEl.dataset.set    = '0';
                commitColors();
            });

            return card;
        }

        renderRefItems();

        /* ---------- 7.6 Apply / Clear — everything by XPATH ---------- */
        refApplyBtn.addEventListener('click', () => {
            const payload = refItems
                .filter((item) => {
                    // this element has a copy — the edits belong to it
                    if (isClonedAway(item.xpath)) return false;
                    const e = refEdits[item.key];
                    return e && (e.enabled || e.color || e.bgColor);
                })
                .map((item) => {
                    const e = refEdits[item.key];
                    return {
                        key: item.key,
                        elId: item.elId || null,   // stable identity of the element
                        kind: item.kind,
                        xpath: item.xpath,
                        localXpath: item.localXpath,
                        nodeIndex: item.nodeIndex ?? null,
                        attr: item.attr || null,
                        // null = do not touch the value, change only the colors
                        value: e.enabled ? (e.value ?? '') : null,
                        color: e.color || '',
                        bgColor: e.bgColor || '',
                    };
                });

            if (payload.length === 0) {
                refSetStatus(
                    isClonedAway(refXpath)
                        ? 'This element has a copy — the edits belong to it. Delete the copy to touch the original.'
                        : 'No path is enabled',
                    'bad'
                );
                return;
            }

            const wasSent = sendUpdate({ referenceEdits: payload });
            console.log(wasSent ? 'Sent reference edits:' : 'NOT sent (no connection yet):', payload);

            refApplyBtn.textContent = sentLabel(wasSent, 'Applied ✓');
            refApplyBtn.classList.add('saved');
            setTimeout(() => {
                refApplyBtn.textContent = 'Apply';
                refApplyBtn.classList.remove('saved');
            }, 1200);

            if (wasSent) {
                refSetStatus(
                    refreshMode
                        ? `Stored ${payload.length} paths — they land on the next refresh`
                        : `Sent ${payload.length} paths`,
                    'ok'
                );
            }
        });

        /* ---------- 7.6 Create new — copies the element (with the selected
           edits) and inserts it at the requested position ---------- */
        refCreateBtn.addEventListener('click', () => {
            if (!refXpath) {
                refSetStatus('Find a reference first', 'bad');
                return;
            }

            // the currently enabled edits — they go to the COPY, not to the original
            const edits = refItems
                .filter((item) => {
                    const e = refEdits[item.key];
                    return e && (e.enabled || e.color || e.bgColor);
                })
                .map((item) => {
                    const e = refEdits[item.key];
                    return {
                        kind: item.kind,
                        localXpath: item.localXpath,
                        nodeIndex: item.nodeIndex ?? null,
                        attr: item.attr || null,
                        value: e.enabled ? (e.value ?? '') : null,
                        color: e.color || '',
                        bgColor: e.bgColor || '',
                    };
                });

            const position = parseInt(refPositionSel.value, 10) || 0;

            refClones.push({
                id: 'le-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                xpath: refXpath,
                position,
                edits,
            });

            saveState({ refClones });

            // the refreshed edits too — so the original reverts at once
            const wasSent = sendUpdate({
                referenceEdits: collectAllReferenceEdits(),
                referenceClones: refClones,
            });
            console.log(wasSent ? 'Sent reference clones:' : 'NOT sent (no connection yet):', refClones);

            refCreateBtn.textContent = sentLabel(wasSent, 'Created ✓');
            refCreateBtn.classList.add('saved');
            setTimeout(() => {
                refCreateBtn.textContent = 'Create new';
                refCreateBtn.classList.remove('saved');
            }, 1200);

            if (wasSent) {
                const posLabel = refPositionSel.options[refPositionSel.selectedIndex]?.textContent || '';
                refSetStatus(`Created a copy — ${posLabel} (${refClones.length} in total)`, 'ok');
            }
        });

        refClearBtn.addEventListener('click', () => {
            // 1. remove ONLY this panel's edits (the others stay)
            refItems.forEach((item) => { delete refEdits[item.key]; });
            refClones = refClones.filter((c) => c.xpath !== refXpath);
            applyEverything();

            // 2. reset the internal state
            refItems    = [];
            refSnapshot = null;
            refXpath    = '';
            refFilter   = '';

            // 3. empty the fields on screen
            refFindInput.value   = '';
            refOccInput.value    = '';
            refXpathInput.value  = '';
            refFilterInput.value = '';

            // 4. reset the meta information
            refMetaTag.textContent   = '—';
            refMetaId.textContent    = '—';
            refMetaClass.textContent = '—';
            refMetaSize.textContent  = '—';
            refMetaXpath.textContent = '—';

            // 5. store the new state
            saveState({ refEdits, refClones });
            persistPanels();

            refPositionSel.innerHTML = '';

            // 6. refresh the view — it looks as if you never opened it
            renderRefItems();
            refRebuildLivePreview();
            refSetStatus('Everything cleared', 'ok');
        });


        /* ---------- what this panel exposes to the outside world ---------- */
        Object.assign(self, {
            root,
            setNumber(n) {
                const el = root.querySelector('[data-el="ref-num"]');
                if (el) el.textContent = n > 1 ? String(n) : '';
                const rm = root.querySelector('[data-el="ref-remove-btn"]');
                if (rm) rm.hidden = (n === 1);   // the first one cannot be removed
            },
            getInit() {
                /* The snapshot now carries the WHOLE page with it — far too much
                   to keep in storage, and it would blow the quota once every
                   rule keeps one. Only the small element snapshot is stored (the
                   fallback preview needs it); the page comes back with the next
                   Search. */
                const light = refSnapshot ? { ...refSnapshot, page: null } : null;
                return {
                    find: refFindInput.value,
                    occurrence: refOccInput.value === '' ? null : parseInt(refOccInput.value, 10),
                    xpath: refXpath,
                    items: refItems,
                    snapshot: light,
                };
            },
            getItems() { return refItems; },
            getXpath() { return refXpath; },
            setStatus: refSetStatus,
            handleResolved: handleReferenceResolved,
            handleItems: handleReferenceItems,
            refresh() { renderRefItems(); refRebuildLivePreview(); },
        });
        return self;
    }


    /* ============================================
       7.9 PANEL MANAGEMENT + APPLY ALL
    ============================================ */

    function renumberPanels() {
        refPanels.forEach((p, i) => p.setNumber(i + 1));
    }

    function addRefPanel(init) {
        const frag = refPanelTpl.content.cloneNode(true);
        const root = frag.querySelector('.ref-panel');
        refPanelsHost.appendChild(frag);

        const panel = createRefPanel(root, init || {});
        refPanels.push(panel);

        // the "Remove reference" button
        const removeBtn = root.querySelector('[data-el="ref-remove-btn"]');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                if (refPanels.length <= 1) return;   // the first one always stays

                // remove the edits of ONLY this panel
                panel.getItems().forEach((item) => { delete refEdits[item.key]; });
                const xp = panel.getXpath();
                refClones = refClones.filter((c) => c.xpath !== xp);

                const idx = refPanels.indexOf(panel);
                if (idx !== -1) refPanels.splice(idx, 1);
                root.remove();
                if (activeRefPanel === panel) activeRefPanel = refPanels[0] || null;

                saveState({ refEdits, refClones });
                persistPanels();
                renumberPanels();
                applyEverything(true);
            });
        }

        // every click inside this panel makes it the "active" one
        root.addEventListener('click', () => { activeRefPanel = panel; }, true);

        renumberPanels();
        persistPanels();
        return panel;
    }

    refAddBtn.addEventListener('click', () => {
        const panel = addRefPanel({});
        panel.root.scrollIntoView({ behavior: 'smooth', block: 'center' });
        refAddBtn.textContent = 'Added ✓';
        setTimeout(() => { refAddBtn.textContent = '+ Add reference'; }, 1000);
    });

    /* ---------- APPLY ALL — XPath + every reference panel ---------- */
    function collectAllReferenceEdits() {
        const seen = new Set();
        const out  = [];

        refPanels.forEach((panel) => {
            panel.getItems().forEach((item) => {
                if (seen.has(item.key)) return;
                seen.add(item.key);

                // this element has a copy — the edits belong to it,
                // the original stays untouched
                if (isClonedAway(item.xpath)) return;

                const e = refEdits[item.key];
                if (!e || (!e.enabled && !e.color && !e.bgColor)) return;

                out.push({
                    key: item.key,
                    elId: item.elId || null,   // stable identity of the element
                    kind: item.kind,
                    xpath: item.xpath,
                    localXpath: item.localXpath,
                    nodeIndex: item.nodeIndex ?? null,
                    attr: item.attr || null,
                    value: e.enabled ? (e.value ?? '') : null,
                    color: e.color || '',
                    bgColor: e.bgColor || '',
                });
            });
        });

        return out;
    }

    function applyEverything(silent) {
        const xpathPayload = xpathRules
            .map((r, index) => ({ ...r, index }))
            .filter((r) => r.find.trim() !== '');

        const refPayload = collectAllReferenceEdits();

        const wasSent = sendUpdate({
            xpathReplacements: xpathPayload,
            referenceEdits: refPayload,
            referenceClones: refClones,
        });

        if (silent) return wasSent;

        applyAllBtn.textContent = wasSent
            ? (refreshMode ? 'ON REFRESH ⟳' : (anyPageMode ? 'ALL PAGES ✓' : 'APPLIED ✓'))
            : 'NO CONNECTION ✗';
        applyAllBtn.classList.add('saved');
        setTimeout(() => {
            applyAllBtn.textContent = 'APPLY ALL';
            applyAllBtn.classList.remove('saved');
        }, 1400);

        console.log('Apply all:', {
            xpath: xpathPayload.length,
            references: refPanels.length,
            edits: refPayload.length,
            clones: refClones.length,
        });

        return wasSent;
    }

    applyAllBtn.addEventListener('click', () => applyEverything(false));

    /* ---------- restore the saved panels (or start with a single one) ---------- */
    const savedPanels = state.refPanelsState;
    if (Array.isArray(savedPanels) && savedPanels.length > 0) {
        savedPanels.forEach((init) => addRefPanel(init));
        refPanels.forEach((p) => p.refresh());
    } else {
        addRefPanel({});
    }

    /* ============================================
       8. RULES — like in "User JavaScript and CSS"
       --------------------------------------------
       Every rule is tied to a domain/pattern, is stored
       PERMANENTLY in the extension, and applies itself whenever that
       page opens — no "Connect", no live link. A single rule holds
       ALL THREE: Editor (JS/CSS), Replacement, XPath + Reference.
    ============================================ */
    const rulesListEl   = document.getElementById('rules-list');
    const rulesCountEl  = document.getElementById('rules-count');
    const rulesFindEl   = document.getElementById('rules-find');
    const activeRuleEl  = document.getElementById('active-rule-name');

    let rules         = [];
    let activeRuleId  = state.activeRuleId || null;
    let rulesFilter   = '';
    let lastTargetUrl = '';

    function ruleById(id) {
        return rules.find((r) => r.id === id) || null;
    }

    function setActiveRuleLabel() {
        const r = ruleById(activeRuleId);
        activeRuleEl.textContent = r ? (r.name || r.pattern) : '— none —';
    }

    /* ============================================
       8.1 WORKSPACES — every rule keeps a bench of its own
       --------------------------------------------
       A rule is not only what has been applied to a page. It is also
       everything you have OPEN while working on it: the JS and CSS in the
       editors, the Replacement rows, the XPath rows, the reference panels
       and every edit switched on inside them.

       All of that used to live in ONE place, shared by every rule. So one
       rule's 100 -> 200 was the same 100 -> 200 you saw under every other
       rule, "Clear" emptied them all at once, and the next Apply wrote those
       borrowed values into whichever page happened to be connected.

       Now each rule has its own bench, kept under its id: leaving a rule
       packs its bench away, opening one unpacks its own — untouched.
    ============================================ */

    function deepCopy(value, fallback) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return fallback;
        }
    }

    // everything that is on screen right now, as it stands
    function captureWorkspace() {
        return {
            js:  document.getElementById('editor-js').value,
            css: document.getElementById('editor-css').value,
            replacements: deepCopy(replacements, []),
            xpathRules:   deepCopy(xpathRules, []),
            refEdits:     deepCopy(refEdits, {}),
            refClones:    deepCopy(refClones, []),
            /* the found paths are worth keeping; the pictures are not — they
               are rebuilt by the next Search, and storing one per rule would
               eat the whole storage quota */
            refPanelsState: refPanels.map((p) => ({ ...p.getInit(), snapshot: null })),
        };
    }

    /* A rule opened for the very first time has no bench yet — it is laid out
       from what the extension has stored for it, so nothing that was already
       applied to that page is lost the moment you touch it. */
    function workspaceFromRule(rule) {
        const edits = {};
        (rule.referenceEdits || []).forEach((e) => {
            if (!e || !e.key) return;
            edits[e.key] = {
                enabled: e.value !== null && e.value !== undefined,
                value: e.value ?? '',
                color: e.color || '',
                bgColor: e.bgColor || '',
            };
        });

        return {
            js:  rule.js  || '',
            css: rule.css || '',
            replacements: (rule.replacements && rule.replacements.length)
                ? deepCopy(rule.replacements, [])
                : [{ find: '', value: '', occurrence: null }],
            xpathRules: (rule.xpathReplacements && rule.xpathReplacements.length)
                ? deepCopy(rule.xpathReplacements, [])
                : [{ find: '', value: '', occurrence: null, xpath: null }],
            refEdits: edits,
            refClones: deepCopy(rule.referenceClones || [], []),
            refPanelsState: [],
        };
    }

    function saveWorkspace(ruleId) {
        if (!ruleId) return;
        const all = { ...(loadState().workspaces || {}) };
        all[ruleId] = captureWorkspace();
        saveState({ workspaces: all });
    }

    function loadWorkspace(ws) {
        // 1) the editors
        document.getElementById('editor-js').value  = ws.js  || '';
        document.getElementById('editor-css').value = ws.css || '';
        editors.forEach(({ textarea, lines, hl, key }) => {
            updateLineNumbers(textarea, lines);
            highlight(textarea, hl, key);
        });

        // 2) Replacement + XPath
        replacements = (ws.replacements && ws.replacements.length)
            ? ws.replacements
            : [{ find: '', value: '', occurrence: null }];
        saveReplacements();
        renderReplacements();

        xpathRules = (ws.xpathRules && ws.xpathRules.length)
            ? ws.xpathRules
            : [{ find: '', value: '', occurrence: null, xpath: null }];
        saveXpathRules();
        renderXpathRules();

        // 3) the references — the edits AND the panels they belong to
        refEdits  = ws.refEdits  || {};
        refClones = ws.refClones || [];
        rebuildRefPanels(ws.refPanelsState);

        // 4) the live keys follow what is now on screen
        saveState({
            js: ws.js || '',
            css: ws.css || '',
            refEdits,
            refClones,
        });
        persistPanels();
    }

    // throw away the panels on screen and lay out this rule's own
    function rebuildRefPanels(panelsState) {
        refPanels.slice().forEach((panel) => {
            try { panel.root.remove(); } catch {}
        });
        refPanels.length = 0;
        activeRefPanel = null;
        refPanelsHost.innerHTML = '';

        const list = (Array.isArray(panelsState) && panelsState.length) ? panelsState : [{}];
        list.forEach((init) => addRefPanel(init));
        refPanels.forEach((p) => p.refresh());
    }

    /* The one door in and out of a rule. Nothing else may set activeRuleId,
       or a bench would be left open under the wrong name. */
    function switchToRule(ruleId) {
        if (!ruleId || ruleId === activeRuleId) return;

        saveWorkspace(activeRuleId);   // pack away what is open now

        activeRuleId = ruleId;
        saveState({ activeRuleId });

        const stored = (loadState().workspaces || {})[ruleId];
        loadWorkspace(stored || workspaceFromRule(ruleById(ruleId) || {}));

        setActiveRuleLabel();
        renderRules();
    }

    function renderRules() {
        rulesListEl.innerHTML = '';
        rulesCountEl.textContent = String(rules.length);

        const visible = rules.filter((r) => {
            if (!rulesFilter) return true;
            return (r.name || '').toLowerCase().includes(rulesFilter)
                || (r.pattern || '').toLowerCase().includes(rulesFilter);
        });

        if (visible.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'rules__empty';
            empty.textContent = rules.length === 0
                ? 'No rules yet. Click "New rule".'
                : 'No matches.';
            rulesListEl.appendChild(empty);
            return;
        }

        visible.forEach((rule) => {
            const row = document.createElement('div');
            row.className = 'rule-row' + (rule.id === activeRuleId ? ' rule-row--active' : '');

            row.innerHTML = `
                <div class="rule-row__main">
                    <div class="rule-row__name">${escapeHtml(rule.name || rule.pattern)}</div>
                    <div class="rule-row__pattern">${escapeHtml(rule.pattern)}</div>
                </div>
                <label class="rule-row__switch" title="Turn this rule on / off">
                    <input type="checkbox" class="rule-row__enable">
                    <span></span>
                </label>
                <button class="rule-row__remove" title="Delete this rule">×</button>
            `;

            const enableEl = row.querySelector('.rule-row__enable');
            const removeEl = row.querySelector('.rule-row__remove');
            const mainEl   = row.querySelector('.rule-row__main');

            enableEl.checked = rule.enabled !== false;

            enableEl.addEventListener('change', (e) => {
                e.stopPropagation();
                rule.enabled = enableEl.checked;
                pushRules();
            });

            removeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                rules = rules.filter((r) => r.id !== rule.id);

                // its bench goes with it — nothing left behind to grow forever
                const benches = { ...(loadState().workspaces || {}) };
                delete benches[rule.id];
                saveState({ workspaces: benches });

                if (activeRuleId === rule.id) {
                    activeRuleId = null;
                    saveState({ activeRuleId: null });
                    setActiveRuleLabel();
                }
                pushRules();
                renderRules();
            });

            mainEl.addEventListener('click', () => {
                switchToRule(rule.id);
            });

            rulesListEl.appendChild(row);
        });
    }

    // sends the full list to the extension (which stores it permanently)
    function pushRules() {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'saveRules', rules, applyOnRefresh: refreshMode }));
            return true;
        }
        return false;
    }

    function requestRules() {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'getRules' }));
        }
    }

    /* Rules are created and stored FULLY AUTOMATICALLY by the extension:
       - as soon as you connect to a page -> that page's rule is created
       - every change you apply -> is stored there by itself, permanently
       That is why there is no "New rule" or "Save rule" button any more. */

    rulesFindEl.addEventListener('input', () => {
        rulesFilter = rulesFindEl.value.trim().toLowerCase();
        renderRules();
    });

    // replies from the extension
    function handleRulesList(msg) {
        const previousUrl = lastTargetUrl;

        rules = Array.isArray(msg.rules) ? msg.rules : [];
        lastTargetUrl = msg.targetUrl || '';

        // AUTOMATIC: pick by itself the rule that belongs to the connected page
        if (lastTargetUrl) {
            const covers = (r) => {
                try {
                    const rx = new RegExp('^' + String(r.pattern || '')
                        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                        .replace(/\*/g, '.*') + '$', 'i');
                    return rx.test(lastTargetUrl);
                } catch {
                    return false;
                }
            };

            /* The URL-free rule ('*') matches every address there is, so on
               its own it would always win. The page's OWN rule comes first;
               the URL-free one only stands in when the page has none. */
            const isAnyPage = (r) => String(r.pattern || '').trim() === '*';
            const match = rules.find((r) => !isAnyPage(r) && covers(r))
                || rules.find((r) => isAnyPage(r) && covers(r));

            /* Follow the connected page ONLY when it has actually changed
               (or when no rule is open yet). This list arrives after every
               single Apply, and re-selecting on each of them would drag you
               off whichever rule you had deliberately opened. */
            if (match && (!activeRuleId || lastTargetUrl !== previousUrl)) {
                switchToRule(match.id);
            }
        }

        renderRules();
        setActiveRuleLabel();
    }

    renderRules();
    setActiveRuleLabel();

    // as soon as we connect, fetch the stored list
    setTimeout(requestRules, 800);

    // make them reachable from the socket handler above
    window.__leHandleRulesList = handleRulesList;
    window.__leRequestRules = requestRules;

});