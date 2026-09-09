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

/* Where the relay lives.

   The editor page works this out on its own — it is served by the
   very server it talks to. The extension has no such page to look at, so
   rather than one hard-coded address it tries both, LOCAL FIRST, and
   remembers whichever answered. Running "npm start" in relay-server/ is
   then enough to test locally: nothing to edit here, nothing to switch back.

   Both addresses must also be listed in manifest.json under connect-src,
   or the CSP blocks the socket before it is ever opened. */
const RELAY_URLS = [
    'ws://127.0.0.1:8080',                          // relay-server on this machine
    'wss://infuse-production-d6d4.up.railway.app',  // the deployed one
];

// which address the next attempt uses; a failed attempt moves to the next
let relayIndex = 0;
let relayPreferenceLoaded = false;

function currentRelayUrl() {
    return RELAY_URLS[relayIndex % RELAY_URLS.length];
}

function nextRelayUrl() {
    relayIndex = (relayIndex + 1) % RELAY_URLS.length;
}

/* Start where we left off, so the usual case connects on the first try
   instead of always failing over one address before it gets there. */
async function loadRelayPreference() {
    if (relayPreferenceLoaded) return;
    relayPreferenceLoaded = true;
    try {
        const { lastRelayUrl } = await chrome.storage.local.get('lastRelayUrl');
        const i = RELAY_URLS.indexOf(lastRelayUrl);
        if (i !== -1) relayIndex = i;
    } catch {}
}
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

/* ============================================================
   ANY PAGE — the rule that belongs to no URL at all
   ------------------------------------------------------------
   The editor's header has a second toggle. While it is on, a change is
   not tied to the page you are connected to: it goes into ONE rule whose
   pattern is '*', which matches every page there is.

   content-script.js reads the rules itself at 'document_start', so from
   then on EVERY page you open carries it — and it only ever shows on the
   pages where the value is really found; the rest are left untouched.
   Nothing about it needs a connected page, so all the tabs you already
   have open are covered too.

   Every place that looks up "this page's rule" skips it on purpose
   (isAnyPageRule) — otherwise the URL-free rule, which matches everything,
   would swallow the changes meant for one single page.
   ============================================================ */
const ANY_PAGE_PATTERN = '*';
const ANY_PAGE_RULE_ID = 'rule-any-page';

function isAnyPageRule(rule) {
    return !!rule && (rule.id === ANY_PAGE_RULE_ID
        || String(rule.pattern || '').trim() === ANY_PAGE_PATTERN);
}

async function updateAnyPageRule(patch) {
    const rules = await getRules();
    let rule = rules.find(isAnyPageRule);

    if (!rule) {
        rule = {
            id: ANY_PAGE_RULE_ID,
            name: 'Any page',
            pattern: ANY_PAGE_PATTERN,
            enabled: true,
            js: '',
            css: '',
            replacements: [],
            xpathReplacements: [],
            referenceEdits: [],
            referenceClones: [],
        };
        rules.push(rule);
        console.log('Infuse — any-page rule created (no URL at all)');
    }

    Object.assign(rule, patch);
    await setRules(rules);
    return rule;
}

// AUTOMATIC: as soon as you connect to a page, a rule for it is created by itself
// (when no matching one exists yet) — no button, no questions
async function ensureRuleForUrl(url) {
    if (!url || /^(about|chrome|moz-extension|chrome-extension):/i.test(url)) return null;

    const rules = await getRules();
    const existing = rules.find((r) => !isAnyPageRule(r) && urlMatchesPattern(url, r.pattern));
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
    let rule = rules.find((r) => !isAnyPageRule(r) && urlMatchesPattern(url, r.pattern));

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

/* A path the page has just worked out is written straight into its rule, so
   the NEXT visit never searches for it again: it takes the fast route and the
   value lands as the element is parsed. Until now this only happened when the
   editor was open to relay it back, which meant every plain visit paid for a
   full-document search all over again.

   The URL-free rule is left alone on purpose — a path found on one page means
   nothing on the next one. */
async function pinXpathInRule(url, index, xpath) {
    if (!url || !xpath) return;

    const rules = await getRules();
    let changed = false;

    rules.forEach((rule) => {
        if (isAnyPageRule(rule)) return;
        if (!urlMatchesPattern(url, rule.pattern)) return;

        const list = rule.xpathReplacements;
        if (!Array.isArray(list) || list.length === 0) return;

        const entry = list.find((r) => r && r.index === index) || list[index];
        if (!entry || entry.xpath === xpath) return;

        entry.xpath = xpath;
        changed = true;
    });

    if (changed) await setRules(rules);
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

/* The pages the browser never lets us touch — its own screens, the
   extension's own pages, the devtools. Trying anyway only fills the
   console with errors. */
const UNTOUCHABLE_URL = /^(about|chrome|edge|opera|vivaldi|brave|moz-extension|chrome-extension|devtools|view-source|resource|data):/i;

// ANY PAGE: push one rule into every tab that is open right now
async function applyRuleToEveryTab(rule) {
    let tabs = [];
    try {
        tabs = await chrome.tabs.query({});
    } catch {
        return 0;
    }

    let count = 0;
    tabs.forEach((tab) => {
        if (!tab.id || !tab.url || UNTOUCHABLE_URL.test(tab.url)) return;
        count++;
        applyRuleToTab(tab.id, rule, 'any page: ');
    });

    console.log('Infuse — any-page rule pushed into', count, 'open tab(s)');
    return count;
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
                // remember what it said, so Disconnect can put it back
                if (!window.__liveEditorReplaceOriginals) {
                    window.__liveEditorReplaceOriginals = new Map();
                }
                if (!window.__liveEditorReplaceOriginals.has(node)) {
                    window.__liveEditorReplaceOriginals.set(node, original);
                }
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

/* ---------- Undo everything replaceRulesInjector() did ----------
   Runs in the page's MAIN world, exactly like the injector itself, so it
   can reach the same window and the same observer. Must be self-contained.
   ---------------------------------------------------------------- */
function replaceRevertInjector() {
    if (window.__liveEditorReplaceObserver) {
        try {
            window.__liveEditorReplaceObserver.disconnect();
        } catch (e) {}
        window.__liveEditorReplaceObserver = null;
    }

    const originals = window.__liveEditorReplaceOriginals;
    if (originals) {
        originals.forEach((was, node) => {
            try {
                if (node.isConnected) node.textContent = was;
            } catch (e) {}
        });
        originals.clear();
        window.__liveEditorReplaceOriginals = null;
    }
}

/* ---------- Disconnect — leave the page exactly as it was ----------
   Reverts every change on the target page, forgets the live session, and
   deletes that page's stored rule — so a refresh brings nothing back.

   The injected JS is the only thing that cannot be taken back: code that
   has already run stays run. Everything it wrote to the DOM is undone,
   and it is never injected again.
   ---------------------------------------------------------------- */
async function disconnectAndWipe() {
    const tabId = await getTargetTabId();
    let url = '';

    if (tabId !== null && tabId !== undefined) {
        try {
            const tab = await chrome.tabs.get(tabId);
            url = tab?.url || '';
        } catch {}

        // 1) put the page back
        try {
            await sendToTab(tabId, { type: 'revertAll' });
        } catch {}

        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: replaceRevertInjector,
            });
        } catch {}
    }

    // 2) forget the live session
    await setLastPayload('', '');
    await setLastReplacements([]);
    await setLastXpathReplacements([]);
    await setLastReferenceEdits([]);
    await setLastReferenceClones([]);

    // 3) delete this page's rule, so nothing returns after a refresh
    let rulesDeleted = 0;
    if (url) {
        const rules = await getRules();
        const kept = rules.filter((r) => !urlMatchesPattern(url, r.pattern));
        rulesDeleted = rules.length - kept.length;
        if (rulesDeleted > 0) await setRules(kept);
    }

    // 4) drop the code and the target tab, then close the socket
    await setStoredCodeAndTab('', null);
    forceReconnect();

    console.log('Live Editor — disconnected: page reverted,', rulesDeleted, 'rule(s) deleted');
    return { ok: true, rulesDeleted };
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

    await loadRelayPreference();

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

    const url = currentRelayUrl();
    const thisSocket = new WebSocket(url);
    socket = thisSocket;

    // a socket that never opened means this address is the wrong one
    let everOpened = false;

    // if it has not opened in time, abandon it and try again
    connectWatchdog = setTimeout(() => {
        connectWatchdog = null;
        if (thisSocket.readyState !== WebSocket.OPEN) {
            console.warn('Infuse — ' + url + ' timed out, trying the other address');
            try { thisSocket.close(); } catch {}
            if (socket === thisSocket) socket = null;
            nextRelayUrl();
            setConnectionStatus(false);
            scheduleReconnect();
        }
    }, CONNECT_TIMEOUT_MS);

    thisSocket.addEventListener('open', () => {
        clearConnectWatchdog();
        everOpened = true;
        reconnectDelay = 1000;
        console.log('Infuse — relay connected:', url);
        chrome.storage.local.set({ lastRelayUrl: url });
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

        /* Never opened -> this address does not answer (nothing listening
           locally, or a 404 from the deployed one). Move to the other one.
           A socket that DID open and then dropped keeps the same address. */
        if (!everOpened) nextRelayUrl();

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

    // the popup and the other extension pages
    chrome.runtime.sendMessage({ type: 'connectionStatusChanged', isConnected }).catch(() => {});

    /* The in-page panel is not an extension page — a runtime message never
       reaches it. It has to be told through its own tab. */
    getTargetTabId()
        .then((tabId) => {
            if (!tabId) return;
            chrome.tabs.sendMessage(tabId, { type: 'connectionStatusChanged', isConnected }).catch(() => {});
        })
        .catch(() => {});
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

        /* Apply them at once to the target tab (when it matches), so you see it
           without a refresh. In refresh mode we skip exactly this: the rules
           are stored and nothing else, and content-script.js picks them up by
           itself at 'document_start' the first time the page is refreshed. */
        if (!msg.applyOnRefresh) {
            const targetTabId = await getTargetTabId();
            if (targetTabId) {
                try {
                    const tab = await chrome.tabs.get(targetTabId);
                    if (tab?.url) applyMatchingRulesToTab(targetTabId, tab.url);
                } catch {}
            }
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

    /* ---------- REFRESH MODE ----------
       The editor's header has a toggle. While it is on, every change that
       arrives here is STORED (in the page's rule and in the live session)
       but nothing is written to the page. content-script.js reads the rules
       itself at 'document_start', so the whole lot lands at once the first
       time that page is refreshed.

       Only the two READ requests below ('reference' and 'referenceRead')
       ignore this — they change nothing, they only answer the editor's
       questions about the page, and Search would be dead without them. */
    const applyOnRefreshOnly = msg.applyOnRefresh === true;

    const targetTabId = await getTargetTabId();

    /* ---------- ANY PAGE ----------
       Takes its own route entirely, because nothing about it belongs to one
       page: no target tab is needed, and none of the per-page storage below
       is touched. Everything lands in the single URL-free rule. */
    if (msg.anyPage === true) {
        await applyToEveryPage(msg, applyOnRefreshOnly, targetTabId);
        return;
    }

    // store css/js ONLY when they really arrived (Save) — otherwise a request
    // from Reference/Replacement would wipe them by accident
    if (typeof msg.css === 'string' || typeof msg.js === 'string') {
        await setLastPayload(msg.css, msg.js);
    }

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

    if (typeof msg.css === 'string' && !applyOnRefreshOnly) {
        withHostPermissionRetry(
            () => sendToTab(targetTabId, { type: 'applyCSS', css: msg.css }),
            'applyCSS'
        );
    }

    if (typeof msg.js === 'string' && msg.js.trim() && !applyOnRefreshOnly) {
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

        if (msg.replacements.length > 0 && !applyOnRefreshOnly) {
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

        if (msg.xpathReplacements.length > 0 && !applyOnRefreshOnly) {
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

        if (!applyOnRefreshOnly) {
            withHostPermissionRetry(
                () => sendToTab(targetTabId, { type: 'referenceEdits', edits: msg.referenceEdits }),
                'referenceEdits'
            );
        }
    }

    // ---------- REFERENCE — the clones ("Create new") ----------
    if (Array.isArray(msg.referenceClones)) {
        await setLastReferenceClones(msg.referenceClones);

        if (!applyOnRefreshOnly) {
            withHostPermissionRetry(
                () => sendToTab(targetTabId, { type: 'referenceClones', clones: msg.referenceClones }),
                'referenceClones'
            );
        }
    }
}

/* ============================================================
   ANY PAGE — store it once, with no URL, and let it find its own pages
   ------------------------------------------------------------
   1) everything goes into the single '*' rule
   2) unless refresh mode is on, that rule is pushed straight into every
      tab that is open right now — all 50 of them if that is what there is
   3) every page opened later picks it up by itself, at 'document_start'

   The change only ever appears where the value is really found: a page
   that does not contain it is left exactly as it was.
   ============================================================ */
async function applyToEveryPage(msg, applyOnRefreshOnly, targetTabId) {
    const patch = {};

    if (typeof msg.css === 'string') patch.css = msg.css;
    if (typeof msg.js === 'string') patch.js = msg.js;
    if (Array.isArray(msg.replacements)) patch.replacements = msg.replacements;

    /* A path found on one page means nothing on the next one. Stored without
       it, the rule keeps looking by VALUE, so every page finds its own
       element — which is the whole point of having no URL. */
    if (Array.isArray(msg.xpathReplacements)) {
        patch.xpathReplacements = msg.xpathReplacements.map((r) => ({ ...r, xpath: null }));
    }

    if (Array.isArray(msg.referenceEdits)) patch.referenceEdits = msg.referenceEdits;
    if (Array.isArray(msg.referenceClones)) patch.referenceClones = msg.referenceClones;

    if (Object.keys(patch).length > 0) {
        const rule = await updateAnyPageRule(patch);

        let targetUrl = '';
        if (targetTabId) {
            try {
                const tab = await chrome.tabs.get(targetTabId);
                targetUrl = tab?.url || '';
            } catch {}
        }

        const rules = await getRules();
        sendToRelay({ type: 'rulesList', rules, targetUrl });

        if (!applyOnRefreshOnly) await applyRuleToEveryTab(rule);
    }

    /* The two READ requests still need one page to look at — they answer the
       editor's questions (Search, the arrows) and change nothing at all. With
       no page connected there is simply nothing to read. */
    if (!targetTabId) return;

    if (msg.reference) {
        withHostPermissionRetry(
            () => sendToTab(targetTabId, { type: 'reference', ref: msg.reference }),
            'reference (any page)'
        );
    }

    if (msg.referenceRead) {
        withHostPermissionRetry(
            () => sendToTab(targetTabId, { type: 'referenceRead', xpath: msg.referenceRead }),
            'referenceRead (any page)'
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
               The stored flag can go stale — for instance the socket dies
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

    if (message.type === 'disconnectAndWipe') {
        disconnectAndWipe()
            .then(sendResponse)
            .catch((err) => {
                console.error('Live Editor — disconnect failed:', err?.message || err);
                sendResponse({ ok: false });
            });
        return true;
    }

    if (message.type === 'setCode') {
        /* The popup sends the active tab's id. The in-page panel sends none —
           it IS the page, so the tab the message came from is the target. */
        const targetTab = message.tabId ?? sender.tab?.id;
        if (!targetTab) {
            sendResponse({ ok: false });
            return true;
        }

        setStoredCodeAndTab(message.code, targetTab).then(async () => {
            // AUTOMATIC: create (or find) this page's rule as soon as you connect
            try {
                const tab = await chrome.tabs.get(targetTab);
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
        // keep it for good, whether or not the editor is open to hear about it
        pinXpathInRule(sender.tab.url, message.index, message.xpath);

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

/* ============================================================
   ANDROID — the toolbar tap opens a panel INSIDE the page
   ------------------------------------------------------------
   Firefox for Android has no anchored popup: it opens popup.html as a
   whole separate screen, which means leaving the page you are working on
   just to type a code.

   So on Android the popup is switched off. A browser only fires
   action.onClicked when there is no popup to open, so the tap arrives
   here, and we hand it to the content script, which builds the same
   panel inside the page itself.

   Desktop is untouched: the check below is what keeps its popup. */
async function useInPagePanelOnAndroid() {
    try {
        const info = await chrome.runtime.getPlatformInfo();
        if (info?.os !== 'android') return;
        await chrome.action.setPopup({ popup: '' });
        console.log('Infuse — Android: the panel opens inside the page');
    } catch {}
}

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab?.id) return;
    try {
        await sendToTab(tab.id, { type: 'togglePanel' });
    } catch {
        /* Pages a content script may never touch (about:, addons.mozilla.org,
           the store). Nothing can be shown there — and nothing can be edited
           there either, so there is nothing to say. */
        console.log('Infuse — no panel on this page:', tab.url);
    }
});

/* ---------- Start ---------- */
chrome.runtime.onInstalled.addListener(() => { useInPagePanelOnAndroid(); connectWebSocket(); });
chrome.runtime.onStartup.addListener(() => { useInPagePanelOnAndroid(); connectWebSocket(); });
useInPagePanelOnAndroid();
connectWebSocket();