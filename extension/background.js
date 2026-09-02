/* ============================================================
   background.js  (THE CONFIRMED WORKING VERSION + REFERENCE)
   - It generates no code itself — the code comes from editor-app, lands in
     popup.js, which sends it here together with the target page's
     tabId (message 'setCode')
   - We store the "target tab" (targetTabId) — not the "active" tab at
     the moment of Save, because when you click Save you are in editor-app
   - The "Connected" status is set ONLY when the server confirms
     'peerConnected' (meaning editor-app really IS connected
     in the same room) — not merely when our own socket opens
   - CSS -> content-script.js (injects a <style> tag)
   - JS  -> chrome.scripting.executeScript (bypasses the CSP)
   - REFERENCE -> travels the SAME route as xpathReplacements
     (inside 'apply'), and comes back as xpathRuleResolved
   ============================================================ */

const RELAY_URL = 'wss://infuse-production-d6d4.up.railway.app'; // TODO: swap for the public Railway URL when you deploy
// NOTE: 127.0.0.1 instead of "localhost" — some browsers (e.g. Firefox) resolve
// "localhost" to ::1 (IPv6) while the server listens on IPv4 only, which breaks the connection

let socket = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 15000;
let reconnectTimer = null;
let pendingOutbound = []; // messages waiting to be sent as soon as the socket opens

/* ---------- 1. The code + the target tab ---------- */

async function getStoredCode() {
    const stored = await chrome.storage.local.get('pairingCode');
    return stored.pairingCode || null;
}

async function getTargetTabId() {
    const stored = await chrome.storage.local.get('targetTabId');
    return stored.targetTabId ?? null;
}

async function setStoredCodeAndTab(code, tabId) {
    await chrome.storage.local.set({ pairingCode: code, targetTabId: tabId });
}

async function setLastPayload(css, js) {
    await chrome.storage.local.set({ lastCss: css ?? '', lastJs: js ?? '' });
}

async function getLastPayload() {
    const stored = await chrome.storage.local.get(['lastCss', 'lastJs']);
    return { css: stored.lastCss || '', js: stored.lastJs || '' };
}

async function setLastReplacements(rules) {
    await chrome.storage.local.set({ lastReplacements: rules || [] });
}

async function getLastReplacements() {
    const stored = await chrome.storage.local.get('lastReplacements');
    return stored.lastReplacements || [];
}

async function setLastXpathReplacements(rules) {
    await chrome.storage.local.set({ lastXpathReplacements: rules || [] });
}

async function getLastXpathReplacements() {
    const stored = await chrome.storage.local.get('lastXpathReplacements');
    return stored.lastXpathReplacements || [];
}

/* ---------- Reference: the edits are stored so they survive a refresh ---------- */

async function setLastReferenceEdits(edits) {
    await chrome.storage.local.set({ lastReferenceEdits: edits || [] });
}

async function getLastReferenceEdits() {
    const stored = await chrome.storage.local.get('lastReferenceEdits');
    return stored.lastReferenceEdits || [];
}

async function setLastReferenceClones(clones) {
    await chrome.storage.local.set({ lastReferenceClones: clones || [] });
}

async function getLastReferenceClones() {
    const stored = await chrome.storage.local.get('lastReferenceClones');
    return stored.lastReferenceClones || [];
}

/* ============================================================
   RULES — the new system, tied to the domain
   ------------------------------------------------------------
   Every rule is stored PERMANENTLY and applies itself whenever a
   page matching its own pattern is opened — with no need for
   "Connect" at all. The shape of a rule:

     {
       id, name, pattern: "https://example.com/*", enabled: true,
       js, css,
       replacements: [], xpathReplacements: [],
       referenceEdits: [], referenceClones: []
     }
   ============================================================ */

async function getRules() {
    const stored = await chrome.storage.local.get('rules');
    return stored.rules || [];
}

async function setRules(rules) {
    await chrome.storage.local.set({ rules: rules || [] });
}

// simple wildcard (*) matching — as in "User JavaScript and CSS"
// e.g. "https://en.wikipedia.org/*" matches every page on that domain
function patternToRegex(pattern) {
    const escaped = String(pattern || '')
        .trim()
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape every regex symbol EXCEPT *
        .replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$', 'i');
}

function urlMatchesPattern(url, pattern) {
    if (!url || !pattern) return false;
    try {
        return patternToRegex(pattern).test(url);
    } catch {
        return false;
    }
}

async function getMatchingRules(url) {
    const rules = await getRules();
    return rules.filter((r) => r.enabled !== false && urlMatchesPattern(url, r.pattern));
}

// turn a URL into a pattern like "https://example.com/*"
function urlToPattern(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'file:') return u.href; // file:// — take it exactly as it is
        return `${u.protocol}//${u.host}/*`;
    } catch {
        return url || '';
    }
}

// AUTOMATIC: as soon as you connect to a page, a rule for it is created by itself
// (when no matching one exists yet) — no button, no questions
async function ensureRuleForUrl(url) {
    if (!url || /^(about|chrome|moz-extension|chrome-extension):/i.test(url)) return null;

    const rules = await getRules();
    const existing = rules.find((r) => urlMatchesPattern(url, r.pattern));
    if (existing) return existing;

    let name = '';
    try {
        const u = new URL(url);
        name = u.protocol === 'file:' ? (u.pathname.split('/').pop() || 'file') : u.host;
    } catch {
        name = url;
    }

    const rule = {
        id: 'rule-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        name,
        pattern: urlToPattern(url),
        enabled: true,
        js: '',
        css: '',
        replacements: [],
        xpathReplacements: [],
        referenceEdits: [],
        referenceClones: [],
    };

    rules.push(rule);
    await setRules(rules);
    console.log('Live Editor — rule created automatically:', rule.pattern);
    return rule;
}

// AUTOMATIC: every change applied is stored at once in that page's rule,
// so it stays forever without you having to press anything
async function updateRuleForUrl(url, patch) {
    if (!url) return;

    const rules = await getRules();
    let rule = rules.find((r) => urlMatchesPattern(url, r.pattern));

    if (!rule) {
        rule = await ensureRuleForUrl(url);
        if (!rule) return;
        const fresh = await getRules();
        rule = fresh.find((r) => r.id === rule.id);
        if (!rule) return;
        Object.assign(rule, patch);
        await setRules(fresh);
        return;
    }

    Object.assign(rule, patch);
    await setRules(rules);
}

// applies a single rule to one tab
function applyRuleToTab(tabId, rule, labelPrefix) {
    const label = (x) => `${labelPrefix}${x} [${rule.pattern}]`;

    if (rule.css) {
        withHostPermissionRetry(
            () => sendToTab(tabId, { type: 'applyCSS', css: rule.css }),
            label('applyCSS')
        );
    }

    if (rule.js && rule.js.trim()) {
        withHostPermissionRetry(
            () => chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: (code) => {
                    try {
                        (0, eval)(code);
                    } catch (err) {
                        console.error('Live Editor — error in the injected JS:', err);
                    }
                },
                args: [rule.js],
            }),
            label('executeScript JS')
        );
    }

    if (Array.isArray(rule.replacements) && rule.replacements.length > 0) {
        withHostPermissionRetry(
            () => chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: replaceRulesInjector,
                args: [rule.replacements],
            }),
            label('replacements')
        );
    }

    if (Array.isArray(rule.xpathReplacements) && rule.xpathReplacements.length > 0) {
        withHostPermissionRetry(
            () => sendToTab(tabId, { type: 'xpathReplacements', rules: rule.xpathReplacements }),
            label('xpathReplacements')
        );
    }

    if (Array.isArray(rule.referenceEdits) && rule.referenceEdits.length > 0) {
        withHostPermissionRetry(
            () => sendToTab(tabId, { type: 'referenceEdits', edits: rule.referenceEdits }),
            label('referenceEdits')
        );
    }

    if (Array.isArray(rule.referenceClones) && rule.referenceClones.length > 0) {
        withHostPermissionRetry(
            () => sendToTab(tabId, { type: 'referenceClones', clones: rule.referenceClones }),
            label('referenceClones')
        );
    }
}

// applies ALL the rules that match this page
async function applyMatchingRulesToTab(tabId, url) {
    const matching = await getMatchingRules(url);
    if (matching.length === 0) return;

    console.log(`Live Editor — ${matching.length} rule(s) match ${url}`);
    matching.forEach((rule) => applyRuleToTab(tabId, rule, 'rule: '));
}

/* ---------- Firefox: permission for a page that has JUST loaded is not always
   ready at the exact moment we try to act on it — retry once, after a short
   pause, but only when the error really is about permissions ---------- */
/* ---------- Send a message to a tab's content script ----------

   "Could not establish connection. Receiving end does not exist." means:
   that tab has no live content script. It happens routinely when the
   extension is reloaded (or updated) while the page stays open — the old
   script is orphaned and no message has anywhere to land. Until now this
   needed a manual page refresh, otherwise "Search" returned nothing.

   Now we re-inject the script and retry once. content-script.js is wrapped
   in an IIFE, so re-injection never gives "already declared", and its own
   boot is guarded by window.__liveEditorBooted. */
async function sendToTab(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
        const text = err?.message || String(err);
        if (!/Receiving end does not exist|Could not establish connection/i.test(text)) {
            throw err;
        }

        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content-script.js'],
        });
        console.log('Live Editor — content-script re-injected into tab', tabId);
        return await chrome.tabs.sendMessage(tabId, message);
    }
}

function withHostPermissionRetry(actionFn, label) {
    return actionFn().catch((err) => {
        console.error(`Live Editor — "${label}" failed:`, err?.message || err);
        if (/host permission|permission/i.test(err?.message || '')) {
            setTimeout(() => {
                actionFn().catch((err2) => {
                    console.error(`Live Editor — "${label}" failed again (retry):`, err2?.message || err2);
                });
            }, 700);
        }
    });
}

/* ---------- The function injected into the page for Replacement ----------
   BASED directly on the code provided: a TreeWalker over the text +
   a regex with \b (word boundary) + a MutationObserver to catch dynamic
   DOM changes. It must be self-contained (it cannot reference variables
   from background.js — only whatever arrives in 'rules').
   ---------------------------------------------------------------- */
function replaceRulesInjector(rules) {
    // If an older observer exists, remove it (so they never stack up)
    if (window.__liveEditorReplaceObserver) {
        window.__liveEditorReplaceObserver.disconnect();
    }

    /* ============================================================
       THE SIMPLE ALGORITHM (exactly like your Tampermonkey script)
       ------------------------------------------------------------
       A TreeWalker over the text -> regex replace -> MutationObserver.
       Nothing more. No counters, no queues, no batching — those were
       exactly the things that made it slow.
       ============================================================ */

    function escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // \b is placed ONLY on the side where the text starts/ends with a letter or digit,
    // so that it works for "+100" or "100 L" as well
    function buildRuleRegex(str) {
        const escaped = escapeRegExp(str);
        const prefix = /^\w/.test(str) ? '\\b' : '';
        const suffix = /\w$/.test(str) ? '\\b' : '';
        return new RegExp(prefix + escaped + suffix, 'g');
    }

    // prepare the rules ONCE (not for every single text node)
    const prepared = rules
        .filter((r) => r && r.find)
        .map((r) => ({
            regex: buildRuleRegex(r.find),
            value: r.value ?? '',
            occurrence: r.occurrence || 0,
        }));

    if (prepared.length === 0) return;

    const hasOccurrence = prepared.some((r) => r.occurrence > 0);
    const doneOccurrence = new Set();

    function replaceInPage() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const counters = hasOccurrence ? new Map() : null;

        let node;
        while ((node = walker.nextNode())) {
            const parentTag = node.parentElement && node.parentElement.tagName;
            if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'NOSCRIPT') continue;

            const original = node.textContent;
            let text = original;

            for (let i = 0; i < prepared.length; i++) {
                const rule = prepared[i];
                rule.regex.lastIndex = 0;

                if (!rule.occurrence) {
                    // the common case: replace them all — fast, like your own script
                    text = text.replace(rule.regex, rule.value);
                } else {
                    if (doneOccurrence.has(i)) continue;
                    text = text.replace(rule.regex, (match) => {
                        const n = (counters.get(i) || 0) + 1;
                        counters.set(i, n);
                        if (n === rule.occurrence) {
                            doneOccurrence.add(i);
                            return rule.value;
                        }
                        return match;
                    });
                }
            }

            // write ONLY if it really changed (never disturb the DOM for nothing)
            if (text !== original) {
                node.textContent = text;
            }
        }
    }

    replaceInPage();

    // Watch only NEW nodes (not characterData — that reacted to our own
    // writes too and set off a chain reaction)
    const observer = new MutationObserver(replaceInPage);
    observer.observe(document.body, { childList: true, subtree: true });
    window.__liveEditorReplaceObserver = observer;
}

/* ---------- 2. WebSocket with the relay server ---------- */

/* How long we allow a socket to sit in CONNECTING before giving up on it.
   This matters more than it looks: when the machine sleeps or the network
   drops, a socket can stay stuck in CONNECTING forever. The old guard below
   treated that as "already connecting" and returned early every time, so the
   extension never reconnected and stayed offline until it was reloaded. */
const CONNECT_TIMEOUT_MS = 8000;
let connectWatchdog = null;

function clearConnectWatchdog() {
    if (connectWatchdog !== null) {
        clearTimeout(connectWatchdog);
        connectWatchdog = null;
    }
}

/* Is the socket genuinely usable right now? */
function isSocketLive() {
    return !!socket && socket.readyState === WebSocket.OPEN;
}

async function connectWebSocket() {
    const code = await getStoredCode();
    if (!code) return;

    // already connected — nothing to do
    if (socket && socket.readyState === WebSocket.OPEN) return;

    // still dialling: allow it, but only while the watchdog is running.
    // If there is no watchdog, this socket is stale and must be replaced.
    if (socket && socket.readyState === WebSocket.CONNECTING && connectWatchdog !== null) return;

    // drop anything left over before opening a fresh socket
    if (socket) {
        try {
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
            socket.close();
        } catch {}
        socket = null;
    }

    clearConnectWatchdog();

    const thisSocket = new WebSocket(RELAY_URL);
    socket = thisSocket;

    // if it has not opened in time, abandon it and try again
    connectWatchdog = setTimeout(() => {
        connectWatchdog = null;
        if (thisSocket.readyState !== WebSocket.OPEN) {
            console.warn('Infuse \u2014 connection timed out, retrying');
            try { thisSocket.close(); } catch {}
            if (socket === thisSocket) socket = null;
            setConnectionStatus(false);
            scheduleReconnect();
        }
    }, CONNECT_TIMEOUT_MS);

    thisSocket.addEventListener('open', () => {
        clearConnectWatchdog();
        reconnectDelay = 1000;
        thisSocket.send(JSON.stringify({ type: 'register', role: 'extension', code }));
        pendingOutbound.forEach((payload) => thisSocket.send(JSON.stringify(payload)));
        pendingOutbound = [];
    });

    thisSocket.addEventListener('message', (event) => {
        handleRelayMessage(event.data);
    });

    thisSocket.addEventListener('close', () => {
        clearConnectWatchdog();
        if (socket === thisSocket) socket = null;   // let the next attempt build a new one
        setConnectionStatus(false);
        scheduleReconnect();
    });

    thisSocket.addEventListener('error', () => {
        clearConnectWatchdog();
        try { thisSocket.close(); } catch {}
    });
}

function forceReconnect() {
    clearTimeout(reconnectTimer);
    reconnectDelay = 1000;
    setConnectionStatus(false);

    if (socket) {
        socket.close();
        socket = null;
    }
    connectWebSocket();
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        connectWebSocket();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
}

function setConnectionStatus(isConnected) {
    chrome.storage.local.set({ connectionStatus: isConnected });
    chrome.runtime.sendMessage({ type: 'connectionStatusChanged', isConnected }).catch(() => {});
}

function sendToRelay(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    } else {
        pendingOutbound.push(payload);
        connectWebSocket();
    }
}

/* ---------- 3. Handle the messages from the relay server ---------- */

async function handleRelayMessage(raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        return;
    }

    if (msg.type === 'peerConnected') {
        setConnectionStatus(true);
        return;
    }

    if (msg.type === 'peerDisconnected') {
        setConnectionStatus(false);
        return;
    }

    if (msg.type === 'error') {
        setConnectionStatus(false);
        return;
    }

    if (msg.type === 'startPicker') {
        const targetTabId = await getTargetTabId();
        if (targetTabId) {
            sendToTab(targetTabId, { type: 'startPicker' }).catch(() => {});
        }
        return;
    }

    if (msg.type === 'stopPicker') {
        const targetTabId = await getTargetTabId();
        if (targetTabId) {
            sendToTab(targetTabId, { type: 'stopPicker' }).catch(() => {});
        }
        return;
    }

    // ---------- THE RULES — store / request the list ----------
    if (msg.type === 'saveRules' && Array.isArray(msg.rules)) {
        await setRules(msg.rules);
        console.log('Live Editor — stored', msg.rules.length, 'rule(s)');

        // apply them at once to the target tab (when it matches), so you see it without a refresh
        const targetTabId = await getTargetTabId();
        if (targetTabId) {
            try {
                const tab = await chrome.tabs.get(targetTabId);
                if (tab?.url) applyMatchingRulesToTab(targetTabId, tab.url);
            } catch {}
        }

        sendToRelay({ type: 'rulesSaved', count: msg.rules.length });
        return;
    }

    if (msg.type === 'getRules') {
        const rules = await getRules();

        // send the target page's URL too, so "New rule" can fill in the pattern by itself
        let targetUrl = '';
        const targetTabId = await getTargetTabId();
        if (targetTabId) {
            try {
                const tab = await chrome.tabs.get(targetTabId);
                targetUrl = tab?.url || '';
            } catch {}
        }

        sendToRelay({ type: 'rulesList', rules, targetUrl });
        return;
    }

    if (msg.type !== 'apply') return;

    // store css/js ONLY when they really arrived (Save) — otherwise a request
    // from Reference/Replacement would wipe them by accident
    if (typeof msg.css === 'string' || typeof msg.js === 'string') {
        await setLastPayload(msg.css, msg.js);
    }

    const targetTabId = await getTargetTabId();
    if (!targetTabId) return;

    let tabExists = true;
    try {
        await chrome.tabs.get(targetTabId);
    } catch {
        tabExists = false;
    }
    if (!tabExists) return;

    /* ---------- AUTOMATIC: store every change in this page's rule ----------
       This is what makes everything stay PERMANENTLY — no "Connect" next
       time, no "save" button to press. --------------------------------- */
    try {
        const tab = await chrome.tabs.get(targetTabId);
        if (tab?.url) {
            const patch = {};
            if (typeof msg.css === 'string') patch.css = msg.css;
            if (typeof msg.js === 'string') patch.js = msg.js;
            if (Array.isArray(msg.replacements)) patch.replacements = msg.replacements;
            if (Array.isArray(msg.xpathReplacements)) patch.xpathReplacements = msg.xpathReplacements;
            if (Array.isArray(msg.referenceEdits)) patch.referenceEdits = msg.referenceEdits;
            if (Array.isArray(msg.referenceClones)) patch.referenceClones = msg.referenceClones;

            if (Object.keys(patch).length > 0) {
                await updateRuleForUrl(tab.url, patch);
                const rules = await getRules();
                sendToRelay({ type: 'rulesList', rules, targetUrl: tab.url });
            }
        }
    } catch {}

    if (typeof msg.css === 'string') {
        withHostPermissionRetry(
            () => sendToTab(targetTabId, { type: 'applyCSS', css: msg.css }),
            'applyCSS'
        );
    }

    if (typeof msg.js === 'string' && msg.js.trim()) {
        withHostPermissionRetry(
            () => chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: 'MAIN',
                func: (code) => {
                    try {
                        (0, eval)(code);
                    } catch (err) {
                        console.error('Live Editor — error in the injected JS:', err);
                    }
                },
                args: [msg.js],
            }),
            'executeScript (JS)'
        );
    }

    if (Array.isArray(msg.replacements)) {
        await setLastReplacements(msg.replacements);

        if (msg.replacements.length > 0) {
            withHostPermissionRetry(
                () => chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: 'MAIN',
                    func: replaceRulesInjector,
                    args: [msg.replacements],
                }),
                'replacements'
            );
        }
    }

    // ---------- XPATH — Apply finds it (the first time) + sets it, in one go ----------
    if (Array.isArray(msg.xpathReplacements)) {
        await setLastXpathReplacements(msg.xpathReplacements);

        if (msg.xpathReplacements.length > 0) {
            withHostPermissionRetry(
                () => sendToTab(targetTabId, { type: 'xpathReplacements', rules: msg.xpathReplacements }),
                'xpathReplacements'
            );
        }
    }

    // ---------- REFERENCE — STEP 1: find the path (or move it with the arrows) ----------
    if (msg.reference) {
        withHostPermissionRetry(
            () => sendToTab(targetTabId, { type: 'reference', ref: msg.reference }),
            'reference'
        );
    }

    // ---------- REFERENCE — STEP 2: read the paths inside ----------
    if (msg.referenceRead) {
        withHostPermissionRetry(
            () => sendToTab(targetTabId, { type: 'referenceRead', xpath: msg.referenceRead }),
            'referenceRead'
        );
    }

    // ---------- REFERENCE — the edits, by xpath ----------
    if (Array.isArray(msg.referenceEdits)) {
        await setLastReferenceEdits(msg.referenceEdits);
        withHostPermissionRetry(
            () => sendToTab(targetTabId, { type: 'referenceEdits', edits: msg.referenceEdits }),
            'referenceEdits'
        );
    }

    // ---------- REFERENCE — the clones ("Create new") ----------
    if (Array.isArray(msg.referenceClones)) {
        await setLastReferenceClones(msg.referenceClones);
        withHostPermissionRetry(
            () => sendToTab(targetTabId, { type: 'referenceClones', clones: msg.referenceClones }),
            'referenceClones'
        );
    }
}

/* ---------- 4. Messages from popup.js ---------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    connectWebSocket();

    if (message.type === 'getState') {
        Promise.all([
            getStoredCode(),
            chrome.storage.local.get('connectionStatus'),
        ]).then(([code, statusData]) => {
            /* Report what is actually true right now.
               The stored flag can go stale \u2014 for instance the socket dies
               while the machine is asleep and nothing gets a chance to write
               false, or it reconnects and nothing writes true. If the socket
               is not live, we are not connected, whatever the flag says. */
            const stored = !!statusData.connectionStatus;
            const isConnected = stored && isSocketLive();

            if (stored && !isConnected) {
                setConnectionStatus(false);   // correct the stale flag
                connectWebSocket();           // and start recovering
            }

            sendResponse({ pairingCode: code, isConnected });
        });
        return true;
    }

    if (message.type === 'setCode') {
        setStoredCodeAndTab(message.code, message.tabId).then(async () => {
            // AUTOMATIC: create (or find) this page's rule as soon as you connect
            try {
                const tab = await chrome.tabs.get(message.tabId);
                if (tab?.url) await ensureRuleForUrl(tab.url);
            } catch {}

            forceReconnect();
            sendResponse({ ok: true });
        });
        return true;
    }
});

/* ---------- 5. AUTOMATIC RE-APPLY — when the target tab reloads ---------- */

async function reapplyEverythingToTab(tabId) {
    const { css, js } = await getLastPayload();
    const replacements = await getLastReplacements();
    const xpathReplacements = await getLastXpathReplacements();
    const referenceEdits = await getLastReferenceEdits();
    const referenceClones = await getLastReferenceClones();
    if (!css && !js && replacements.length === 0 && xpathReplacements.length === 0
        && referenceEdits.length === 0 && referenceClones.length === 0) return;

    // if the tab no longer exists (closed meanwhile), do not go on at all
    try {
        await chrome.tabs.get(tabId);
    } catch {
        return;
    }

    if (css) {
        withHostPermissionRetry(() => sendToTab(tabId, { type: 'applyCSS', css }), 'applyCSS (reload)');
    }
    if (js) {
        withHostPermissionRetry(() => chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (code) => {
                try {
                    (0, eval)(code);
                } catch (err) {
                    console.error('Live Editor — error in the injected JS:', err);
                }
            },
            args: [js],
        }), 'executeScript JS (reload)');
    }
    if (replacements.length > 0) {
        withHostPermissionRetry(() => chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: replaceRulesInjector,
            args: [replacements],
        }), 'replacements (reload)');
    }
    if (xpathReplacements.length > 0) {
        withHostPermissionRetry(() => sendToTab(tabId, { type: 'xpathReplacements', rules: xpathReplacements }), 'xpathReplacements (reload)');
    }
    if (referenceEdits.length > 0) {
        withHostPermissionRetry(() => sendToTab(tabId, { type: 'referenceEdits', edits: referenceEdits }), 'referenceEdits (reload)');
    }
    if (referenceClones.length > 0) {
        withHostPermissionRetry(() => sendToTab(tabId, { type: 'referenceClones', clones: referenceClones }), 'referenceClones (reload)');
    }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;

    const url = tab?.url || changeInfo.url;

    setTimeout(async () => {
        /* CRITICAL: this used to run TWICE on every refresh — once from the
           rules, once from the live session. That doubled everything (two
           replacement injections, two xpath writes...) and made the refresh
           painfully slow.
           Now: if a rule covers this page, ONLY the rule is used. */

        /* THE RULES are no longer applied from here — content-script.js reads
           them itself at 'document_start', far earlier. What is left here is
           only the live session (changes that are not a rule yet). */

        const url2 = url;
        let ruleApplied = false;
        if (url2) {
            const matching = await getMatchingRules(url2);
            ruleApplied = matching.length > 0;
        }

        if (ruleApplied) return; // never do the same work twice

        const targetTabId = await getTargetTabId();
        if (tabId !== targetTabId) return;

        reapplyEverythingToTab(tabId);
    }, 250);
});

/* ---------- 6. Messages from content-script.js ---------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'requestPersistedCSS' && sender.tab?.id) {
        getTargetTabId().then((targetTabId) => {
            if (sender.tab.id !== targetTabId) {
                sendResponse({ css: '' });
                return;
            }
            getLastPayload().then(({ css }) => sendResponse({ css }));
        });
        return true;
    }

    if (message.type === 'elementPicked' && sender.tab?.id) {
        getTargetTabId().then((targetTabId) => {
            if (sender.tab.id !== targetTabId) return;
            sendToRelay({ type: 'elementPicked', selector: message.selector });
        });
        return;
    }

    if (message.type === 'xpathRuleResolved' && sender.tab?.id) {
        getTargetTabId().then((targetTabId) => {
            if (sender.tab.id !== targetTabId) return;
            sendToRelay({ type: 'xpathRuleResolved', index: message.index, xpath: message.xpath });
        });
        return;
    }

    /* ---------- REFERENCE ---------- */

    // STEP 1 — the path that was found -> relay -> editor-app
    if (message.type === 'referenceResolved' && sender.tab?.id) {
        getTargetTabId().then((targetTabId) => {
            if (sender.tab.id !== targetTabId) return;
            sendToRelay({ type: 'referenceResolved', xpath: message.xpath, meta: message.meta });
        });
        return;
    }

    // STEP 2 — the inner paths + the snapshot
    if (message.type === 'referenceItems' && sender.tab?.id) {
        getTargetTabId().then((targetTabId) => {
            if (sender.tab.id !== targetTabId) return;
            sendToRelay({
                type: 'referenceItems',
                xpath: message.xpath,
                items: message.items,
                snapshot: message.snapshot,
            });
        });
        return;
    }

    // errors coming from the page
    if (message.type === 'referenceError' && sender.tab?.id) {
        getTargetTabId().then((targetTabId) => {
            if (sender.tab.id !== targetTabId) return;
            sendToRelay({ type: 'referenceError', message: message.message });
        });
        return;
    }

    // after a refresh: the content script asks for the stored edits
    if (message.type === 'referenceRequestPersisted' && sender.tab?.id) {
        Promise.all([getTargetTabId(), getLastReferenceEdits(), getLastReferenceClones()])
            .then(([targetTabId, edits, clones]) => {
                if (sender.tab.id !== targetTabId) return;
                if (edits.length > 0) {
                    sendToTab(sender.tab.id, { type: 'referenceEdits', edits }).catch(() => {});
                }
                if (clones.length > 0) {
                    sendToTab(sender.tab.id, { type: 'referenceClones', clones }).catch(() => {});
                }
            });
        return;
    }
});

/* ---------- KEEP-ALIVE ---------- */

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'keepAlive') return;

    // Do not even try to connect when there is no stored code at all (e.g. you
    // are only using the rules). Previously it retried every 24 seconds and
    // filled the console with connection errors for no reason whatsoever.
    const code = await getStoredCode();
    if (!code) return;

    /* A socket that is stuck part-way (very common after the machine wakes
       from sleep) never fires 'close', so nothing would ever notice. Drop it
       here so connectWebSocket() can build a fresh one. */
    if (socket && socket.readyState === WebSocket.CLOSING) {
        socket = null;
        setConnectionStatus(false);
    }

    connectWebSocket();
});

/* ---------- Start ---------- */
chrome.runtime.onInstalled.addListener(() => connectWebSocket());
chrome.runtime.onStartup.addListener(() => connectWebSocket());
connectWebSocket();