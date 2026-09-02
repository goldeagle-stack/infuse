/* ============================================================
   The whole script lives inside an IIFE.

   The background re-injects this file when a tab no longer has a live
   content script (e.g. after the extension is reloaded).
   Without this wrapper, a second injection would fail with
   "Identifier ... has already been declared", because the top-level
   const/let bindings share the same global scope of the isolated world.
   Inside a function, every injection gets a scope of its own.
   ============================================================ */
(function () {
/* ============================================================
   content-script.js  (THE CONFIRMED WORKING VERSION + REFERENCE)
   - Injected automatically into every page (per manifest.json)
   - Handles the CSS (message 'applyCSS')
   - The JS is executed by background.js (chrome.scripting.executeScript)
   - Element picker (Replacement) — green outline on hover, click selects
   - XPath — Apply finds it (the first time) + sets it, in one go;
     later passes (and every 1.35s) use the already fixed xpath
   - REFERENCE — the very same method: finds by text+match, returns the path,
     reads everything inside it, and edits each one by ITS OWN XPATH
   ============================================================ */

const STYLE_TAG_ID = '__live_editor_style__';

function applyCSS(cssText) {
    let styleTag = document.getElementById(STYLE_TAG_ID);
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = STYLE_TAG_ID;
        document.documentElement.appendChild(styleTag);
    }
    styleTag.textContent = cssText;
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'applyCSS' && typeof message.css === 'string') {
        applyCSS(message.css);
    }
    if (message.type === 'startPicker') {
        startPicker();
    }
    if (message.type === 'stopPicker') {
        stopPicker();
    }
});

/* ---------- Ask for the stored CSS as soon as the page loads (refresh, navigation) ---------- */
chrome.runtime.sendMessage({ type: 'requestPersistedCSS' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.css) {
        applyCSS(response.css);
    }
});

/* ============================================================
   ELEMENT PICKER — when editor-app asks you to pick one specific
   element on the page (green outline on hover, click to select it)
   ============================================================ */

const PICKER_HIGHLIGHT_OUTLINE = '2px solid #a6d189';

let pickerActive = false;
let pickerHoverEl = null;

function getUniqueSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
            const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
            if (sameTagSiblings.length > 1) {
                part += `:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`;
            }
        }
        path.unshift(part);
        node = parent;
    }
    path.unshift('body');
    return path.join(' > ');
}

function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    document.addEventListener('mousemove', onPickerMouseMove, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKeydown, true);
    document.body.style.cursor = 'crosshair';
}

function stopPicker() {
    pickerActive = false;
    document.removeEventListener('mousemove', onPickerMouseMove, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKeydown, true);
    document.body.style.cursor = '';
    if (pickerHoverEl) {
        pickerHoverEl.style.outline = '';
        pickerHoverEl = null;
    }
}

function onPickerMouseMove(e) {
    if (pickerHoverEl) pickerHoverEl.style.outline = '';
    pickerHoverEl = e.target;
    pickerHoverEl.style.outline = PICKER_HIGHLIGHT_OUTLINE;
}

function onPickerClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const selector = getUniqueSelector(e.target);
    stopPicker();

    chrome.runtime.sendMessage({ type: 'elementPicked', selector }).catch(() => {});
}

function onPickerKeydown(e) {
    if (e.key === 'Escape') {
        stopPicker();
    }
}

/* ============================================================
   XPATH — finds the value (the first time) + sets it, in one go.
   The xpath it found stays FIXED from then on (later passes and
   every interval tick use it directly, without searching again).
   ============================================================ */

function getElementXPath(el) {
    if (!el || el.nodeType !== 1) return '';

    /* An element inside a clone has NO valid path: paths count only the real
       elements, so any path produced for a clone would resolve to a different
       element. Better no path at all than a path that silently points at the
       wrong element. */
    if (el.closest && el.closest('[data-le-clone]')) return '';

    const segments = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
        const parent = node.parentElement;
        let segment = node.tagName.toLowerCase();
        if (parent) {
            /* Count siblings the same way getElementByXPath reads them back:
               clones we inserted are skipped. If they were counted here, the
               path we save would describe the page as it looks *with* the
               clones — and would stop matching the moment one is removed. */
            const sameTag = Array.from(parent.children)
                .filter((c) => c.tagName === node.tagName && !c.hasAttribute('data-le-clone'));

            if (sameTag.length > 1) {
                const position = sameTag.indexOf(node);
                // not a real element -> no path describes it correctly
                if (position === -1) return '';
                segment += `[${position + 1}]`;
            }
        }
        segments.unshift(segment);
        node = parent;
    }
    segments.unshift('html');
    return '/' + segments.join('/');
}

// finds the element containing 'reference' — if 'occurrence' is given,
// take that specific match (1 = the first, 2 = the second, etc.); otherwise the first
/* ============================================================
   XPATH & EXPLORER HELPER FUNCTIONS
   ============================================================ */

function resolveElementByReferenceOccurrence(reference, occurrence) {
    const ref = (reference || '').trim().toLowerCase();
    if (!ref) return null;

    const target = occurrence && occurrence > 0 ? occurrence : 1;
    let count = 0;

    // Filter out inner tags so we never pick up JS/CSS code
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                if (!node.parentElement) return NodeFilter.FILTER_REJECT;
                const tag = node.parentElement.tagName.toLowerCase();
                if (['script', 'style', 'noscript', 'template'].includes(tag)) {
                    return NodeFilter.FILTER_REJECT;
                }
                /* CLONES ARE INVISIBLE HERE — exactly as in getElementByXPath.
                   A clone inserted at the top became the text's "1st match", so
                   the search returned the CLONE. Then getElementXPath of that clone
                   produced .../tr[1], and that path — which skips clones — resolved
                   to the ORIGINAL. The clone was read, the original was written:
                   that is why both changed at once. */
                if (node.parentElement.closest('[data-le-clone]')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        },
        false
    );

    let node;
    while ((node = walker.nextNode())) {
        // Case-insensitive search
        if (node.textContent.toLowerCase().includes(ref) && node.parentElement) {
            count++;
            if (count === target) {
                return node.parentElement;
            }
        }
    }
    return null;
}

/* ============================================================
   RESOLVING AN XPATH — CLONES ARE INVISIBLE HERE
   ------------------------------------------------------------
   An xpath like  …/tbody/tr[1]/td[2]  counts elements by position.
   The moment we insert a clone into that same parent, every index
   after it shifts by one, and a path that used to mean "the first
   row" silently starts meaning a different row. Edits then land on
   the wrong element — and removing a rule leaves the page in a
   half-changed state, because the revert also targets the wrong one.

   So we walk the path ourselves and count ONLY real page elements,
   skipping anything we cloned in ([data-le-clone]). A stored path
   therefore always means the same element, no matter how many
   clones exist.

   document.evaluate is still used as a fallback for anything this
   simple walker does not understand (predicates, //, @attr, etc).
   ============================================================ */

const XPATH_STEP = /^([a-zA-Z_][\w.-]*)(?:\[(\d+)\])?$/;

function isCloneElement(el) {
    return el.nodeType === 1 && el.hasAttribute('data-le-clone');
}

function getElementByXPath(xpath) {
    if (!xpath) return null;

    const walked = walkXPathIgnoringClones(xpath);
    if (walked) return walked;

    // fallback: let the browser handle anything more complex
    try {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
    } catch {
        return null;
    }
}

function walkXPathIgnoringClones(xpath) {
    // only plain absolute paths made of tag or tag[n] steps
    if (typeof xpath !== 'string' || !xpath.startsWith('/') || xpath.startsWith('//')) return null;

    const steps = xpath.slice(1).split('/');
    if (steps.length === 0) return null;

    let current = document.documentElement;

    // first step must be the root element itself
    const first = steps[0].match(XPATH_STEP);
    if (!first) return null;
    if (current.tagName.toLowerCase() !== first[1].toLowerCase()) return null;

    for (let i = 1; i < steps.length; i++) {
        const parsed = steps[i].match(XPATH_STEP);
        if (!parsed) return null;   // something we don't handle — use the fallback

        const tag   = parsed[1].toLowerCase();
        const index = parsed[2] ? parseInt(parsed[2], 10) : 1;

        // count matching children, but pretend clones are not there
        let seen = 0;
        let next = null;

        for (const child of current.children) {
            if (isCloneElement(child)) continue;              // <- the whole point
            if (child.tagName.toLowerCase() !== tag) continue;
            seen++;
            if (seen === index) { next = child; break; }
        }

        if (!next) return null;
        current = next;
    }

    return current;
}

// if the rule already has an 'xpath' (found earlier), use THAT directly —
// never search the text again. Only the FIRST time (while there is no xpath)
// do we search by 'find'/'occurrence', and the xpath found is STORED right on
// the 'rule' itself (so later interval passes use it fixed as well),
// and editor-app is told about it so it can store it permanently.
function applyXPathRule(rule, index) {
    /* ============================================================
       Exactly like your own script: when the path is known -> document.evaluate
       and set the value. Nothing else, zero searching.
       The text search runs ONLY ONCE at the start (while there is still no
       path), and if it fails it is never retried — previously the whole page
       was searched again every 1.35 seconds for nothing.
       ============================================================ */

    // the fast route: the path is known
    if (rule.xpath) {
        const target = getElementByXPath(rule.xpath);
        if (!target) return;

        // remember the original text once, so this can be undone later
        const key = 'xpath|' + rule.xpath;
        refRememberOriginal(key, (() => {
            const node = target;
            const was  = target.textContent;
            return function restore() {
                if (node.isConnected) node.textContent = was;
            };
        })());

        const val = rule.value ?? '';
        if (target.textContent !== val) target.textContent = val;
        return;
    }

    // no path yet: try ONCE to find it by text
    if (rule.__resolveFailed) return; // it failed once — do not try again

    const el = resolveElementByReferenceOccurrence(rule.find, rule.occurrence);
    if (!el) {
        rule.__resolveFailed = true;
        return;
    }

    rule.xpath = getElementXPath(el);
    chrome.runtime.sendMessage({ type: 'xpathRuleResolved', index, xpath: rule.xpath }).catch(() => {});

    // CRITICAL: write ONLY if it really changed.
    // Without this check, the text was rewritten every 1.35s even when identical,
    // causing a DOM mutation -> Replacement's MutationObserver
    // fired again -> the page choked. This was the main cause of the slowness.
    const wanted = rule.value ?? '';
    if (el.textContent !== wanted) {
        el.textContent = wanted;
    }
}

/* ---------- Re-apply continuously (as in the original script) ----------
   The backend may change the value again later — without this interval,
   our change would be overwritten. Re-apply every ~1.35s, using the
   FIXED xpath (not a fresh text search every time).
   ---------------------------------------------------------------- */

let currentXpathRules = [];
let xpathIntervalStarted = false;

function reapplyAllXpathRules() {
    currentXpathRules.forEach((rule, i) => applyXPathRule(rule, rule.index ?? i));
}

function startXpathInterval() {
    startSharedInterval(); // a single interval for everything
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'xpathReplacements' && Array.isArray(message.rules)) {
        // put back any xpath rule that is no longer in the list
        refRestoreRemoved([
            ...currentReferenceEdits,
            ...message.rules.filter((r) => r.xpath).map((r) => ({ key: 'xpath|' + r.xpath })),
        ]);

        // new rules -> clear the failure flag, so they get tried again
        currentXpathRules = message.rules.map((r) => ({ ...r, __resolveFailed: false }));
        reapplyAllXpathRules();
        startXpathInterval();
    }
});

/* ============================================================
   =====================  R E F E R E N C E  ==================
   ------------------------------------------------------------
   SPLIT INTO 3 INDEPENDENT STEPS — so that finding the path is never
   blocked by the snapshot or by reading the elements:

     STEP 1  'reference'      -> finds the ELEMENT and returns ONLY the path
                                (algorithm IDENTICAL to the XPath one that works:
                                 resolveElementByReferenceOccurrence +
                                 getElementXPath)
     STEP 2  'referenceRead'  -> reads every path inside + a DOM snapshot

   The reply goes back through chrome.runtime.sendMessage — the same route
   'xpathRuleResolved' uses, and which works 100%.
   ============================================================ */

const REF_TRANSPARENT_PX =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const REF_MAX_ITEMS = 300;
const REF_MAX_CSS_CHARS = 150000;
const REF_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);

function refLog(...args) {
    console.log('[LiveEditor REF]', ...args);
}

function refSend(payload) {
    chrome.runtime.sendMessage(payload).catch(() => {});
}

function refError(message) {
    refLog('ERROR:', message);
    refSend({ type: 'referenceError', message });
}

/* ============================================================
   STEP 1 — FINDING THE PATH
   Exactly the same algorithm as applyXPathRule(), except that it
   replaces nothing — it just returns the path.
   ============================================================ */

function referenceFindPath(ref) {
    refLog('request:', ref);

    let el = null;

    // if a path came in — start from it
    if (ref.xpath) {
        el = getElementByXPath(ref.xpath);
        if (el && el.nodeType !== 1) el = null;
    }

    // otherwise (or if the path no longer holds) — find it by text + match,
    // THIS is the method that always finds it
    if (!el && ref.find) {
        el = resolveElementByReferenceOccurrence(ref.find, ref.occurrence);
    }

    if (!el || el.nodeType !== 1) {
        refError('No element found with that value/path');
        return;
    }

    // the arrows — move the path through the tree
    // (clones are skipped here too: a copy is not an element of the page)
    if (ref.direction) {
        const skip = (n) => !n || REF_SKIP_TAGS.has(n.tagName) || isCloneElement(n);

        let next = null;
        if (ref.direction === 'parent') {
            next = el.parentElement;
        } else if (ref.direction === 'firstChild') {
            next = Array.from(el.children).find((c) => !skip(c)) || null;
        } else if (ref.direction === 'prev') {
            next = el.previousElementSibling;
            while (next && skip(next)) next = next.previousElementSibling;
        } else if (ref.direction === 'next') {
            next = el.nextElementSibling;
            while (next && skip(next)) next = next.nextElementSibling;
        }

        if (!next || next.nodeType !== 1) {
            refError('Nowhere further to move in that direction');
            return;
        }
        el = next;
    }

    const xpath = getElementXPath(el);

    /* No path means: the element sits inside a copy you created yourself.
       Never send an empty path — it would resolve to the wrong element. */
    if (!xpath) {
        refError('This element is a copy you created — pick the original');
        return;
    }

    refLog('path found:', xpath);

    const rect = el.getBoundingClientRect();

    // a SMALL message — there is no way for it to fail
    refSend({
        type: 'referenceResolved',
        xpath,
        meta: {
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            className: el.getAttribute('class') || '',
            width: rect.width,
            height: rect.height,
            childCount: el.children.length,
            // how many siblings at that level — so the position list cannot go
            // past the last one, and is not filled with arbitrary numbers
            siblingCount: el.parentElement ? el.parentElement.children.length : 1,
            siblingIndex: el.parentElement
                ? Array.from(el.parentElement.children).indexOf(el)
                : 0,
        },
    });
}

/* ============================================================
   STEP 2 — READING THE INNER PATHS + DOM SNAPSHOT
   ============================================================ */

function refShort(str, max) {
    const s = (str ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function refDescribe(el) {
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (cls.length) d += '.' + cls.slice(0, 2).join('.');
    return d;
}

// a path RELATIVE to 'root' (not absolute like getElementXPath) — used by
// editor-app to rebuild the "Live" preview LOCALLY, with no round-trip to the page
function getLocalXPath(root, el) {
    if (el === root) return '.';
    const segments = [];
    let node = el;
    while (node && node !== root && node.nodeType === 1) {
        const parent = node.parentElement;
        let segment = node.tagName.toLowerCase();
        if (parent) {
            const sameTag = Array.from(parent.children).filter(c => c.tagName === node.tagName);
            if (sameTag.length > 1) {
                segment += `[${sameTag.indexOf(node) + 1}]`;
            }
        }
        segments.unshift(segment);
        node = parent;
    }
    if (node !== root) return null;
    return segments.join('/');
}

/* ============================================================
   STABLE ELEMENT IDENTITY
   ------------------------------------------------------------
   Positional paths break the moment the DOM shifts. So the first
   time we look at an element we give it a private id and keep
   using that. Clones never inherit it — refStripStamps() removes
   it from every copy — so a clone can never be mistaken for the
   element it was copied from.
   ============================================================ */

const LE_ID_ATTR = 'data-le-el';
let leIdCounter = 0;

function refStampElement(el) {
    if (!el || el.nodeType !== 1) return null;

    let id = el.getAttribute(LE_ID_ATTR);
    if (!id) {
        id = 'e' + (++leIdCounter) + '-' + Math.random().toString(36).slice(2, 8);
        el.setAttribute(LE_ID_ATTR, id);
    }
    return id;
}

function refFindByStamp(id) {
    if (!id) return null;
    return document.querySelector(`[${LE_ID_ATTR}="${id}"]`);
}

/* A copy must never carry the original's identity. */
function refStripStamps(el) {
    if (!el || el.nodeType !== 1) return;
    el.removeAttribute(LE_ID_ATTR);
    el.querySelectorAll(`[${LE_ID_ATTR}]`).forEach((n) => n.removeAttribute(LE_ID_ATTR));
}

/* Find the element an edit refers to: by its own id first, and only
   fall back to the path on a fresh page where no stamps exist yet. */
function refResolveTarget(e) {
    const byStamp = refFindByStamp(e.elId);
    if (byStamp) return byStamp;

    const byPath = getElementByXPath(e.xpath);
    if (byPath && e.elId) {
        // re-stamp it so every later pass is exact
        byPath.setAttribute(LE_ID_ATTR, e.elId);
    }
    return byPath;
}

function refCollectItems(root) {
    const items = [];

    /* Each item carries the element's OWN stable id, not just its path.

       A path like …/tbody/tr[1] identifies an element by position, so the
       moment anything is inserted before it — a clone, or a row the page
       itself adds — that path starts pointing at a different element and
       edits land on the wrong one. Stamping the element once and looking it
       up by that stamp afterwards makes the target exact and permanent.
       The path is still stored as a fallback for a fresh page load, where
       no stamps exist yet. */
    let currentElId = null;   // set by visit() before it adds anything

    function add(obj) {
        if (items.length >= REF_MAX_ITEMS) return;
        obj.elId = currentElId;
        obj.key = `${obj.kind}|${obj.xpath}|${obj.nodeIndex ?? ''}|${obj.attr ?? ''}`;
        items.push(obj);
    }

    function visit(el) {
        if (items.length >= REF_MAX_ITEMS) return;
        if (REF_SKIP_TAGS.has(el.tagName)) return;

        const xpath = getElementXPath(el);
        if (!xpath) return;

        currentElId = refStampElement(el);   // stable identity, survives index shifts
        const localXpath = getLocalXPath(root, el);
        const desc = refDescribe(el);

        // the direct text nodes (not those of the children)
        let textIndex = -1;
        Array.from(el.childNodes).forEach((n) => {
            if (n.nodeType !== Node.TEXT_NODE) return;
            textIndex++;
            if (!n.textContent.trim()) return;
            add({
                kind: 'text',
                xpath,
                localXpath,
                nodeIndex: textIndex,
                value: n.textContent,
                label: `${desc} — "${refShort(n.textContent, 40)}"`,
            });
        });

        // the images
        if (el.tagName === 'IMG') {
            add({
                kind: 'image',
                xpath,
                localXpath,
                attr: 'src',
                value: el.currentSrc || el.getAttribute('src') || '',
                label: `${desc} — image`,
            });
        }

        if (el.tagName === 'SOURCE' && el.getAttribute('srcset')) {
            add({
                kind: 'attr',
                xpath,
                localXpath,
                attr: 'srcset',
                value: el.getAttribute('srcset'),
                label: `${desc} — srcset`,
            });
        }

        // the background used as an image
        let bg = '';
        try {
            bg = getComputedStyle(el).backgroundImage;
        } catch {
            bg = '';
        }
        if (bg && bg !== 'none' && bg.includes('url(')) {
            const m = bg.match(/url\(["']?(.*?)["']?\)/);
            add({
                kind: 'bg',
                xpath,
                localXpath,
                value: m ? m[1] : '',
                label: `${desc} — background`,
            });
        }

        // the links
        if (el.tagName === 'A' && el.getAttribute('href')) {
            add({
                kind: 'attr',
                xpath,
                localXpath,
                attr: 'href',
                value: el.getAttribute('href'),
                label: `${desc} — link`,
            });
        }

        // input / textarea / select
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
            add({
                kind: 'value',
                xpath,
                localXpath,
                value: el.value ?? '',
                label: `${desc} — field value`,
            });
            if (el.getAttribute('placeholder')) {
                add({
                    kind: 'attr',
                    xpath,
                    localXpath,
                    attr: 'placeholder',
                    value: el.getAttribute('placeholder'),
                    label: `${desc} — placeholder`,
                });
            }
        }

        Array.from(el.children).forEach(visit);
    }

    visit(root);

    // always offer the reference's own inner HTML as well
    add({
        kind: 'html',
        xpath: getElementXPath(root),
        localXpath: '.',
        value: refShort(root.innerHTML, 400),
        label: `${refDescribe(root)} — inner HTML`,
    });

    return items;
}

function refCollectCss() {
    let out = '';
    for (const sheet of Array.from(document.styleSheets)) {
        if (out.length > REF_MAX_CSS_CHARS) break;
        try {
            for (const rule of Array.from(sheet.cssRules)) {
                out += rule.cssText + '\n';
                if (out.length > REF_MAX_CSS_CHARS) break;
            }
        } catch {
            if (sheet.href) out += `@import url("${sheet.href}");\n`;
        }
    }
    return out.slice(0, REF_MAX_CSS_CHARS);
}

// builds the REAL parent chain (with their classes/ids) — without this,
// CSS selectors that depend on the parent (e.g. ".tx-table tbody tr td") cannot
// match in the preview and the element shows up with no styling at all
function refBuildAncestorChain(el) {
    const chain = [];
    let node = el.parentElement;
    while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
        chain.unshift({
            tag: node.tagName.toLowerCase(),
            id: node.id || '',
            className: node.getAttribute('class') || '',
        });
        node = node.parentElement;
    }
    return chain;
}

function refBuildSnapshot(el) {
    try {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('script,noscript').forEach((n) => n.remove());
        return {
            html: clone.outerHTML,
            css: refCollectCss(),
            baseHref: document.baseURI,
            tag: el.tagName.toLowerCase(),
            ancestors: refBuildAncestorChain(el), // ADDED — the real parent chain
        };
    } catch {
        return null;
    }
}

function referenceRead(xpath) {
    const el = getElementByXPath(xpath);
    if (!el || el.nodeType !== 1) {
        refError('Could not read this path');
        return;
    }

    let items = [];
    let snapshot = null;

    try {
        items = refCollectItems(el);
    } catch (err) {
        refLog('collecting the paths failed:', err);
    }

    try {
        snapshot = refBuildSnapshot(el);
    } catch (err) {
        refLog('snapshot failed:', err);
    }

    refLog('read', items.length, 'paths inside', xpath);
    refSend({ type: 'referenceItems', xpath, items, snapshot });
}

/* ============================================================
   THE EDITS — by XPATH, and re-applied every 1.35s (like XPath)
   ============================================================ */

let currentReferenceEdits = [];

/* ============================================================
   REMEMBERING WHAT WE OVERWROTE
   ------------------------------------------------------------
   Every edit used to be one-way: we wrote the new value and the
   old one was gone. So if an edit was later removed, or the user
   pointed the reference at a different element, whatever we had
   already changed kept the new value forever — which is how two
   different rows ended up showing the same edited text, and why
   deleting a rule left the page half-changed until a reload.

   Now the first time we touch something we record what was there,
   and when an edit stops being in the list we put it back.
   ============================================================ */
const refOriginals = new Map();   // key -> { restore() }

function refRememberOriginal(key, restore) {
    if (!refOriginals.has(key)) refOriginals.set(key, { restore });
}

/* Put back everything that is no longer in the incoming list. */
function refRestoreRemoved(nextEdits) {
    const keep = new Set((nextEdits || []).map((e) => e.key));

    refOriginals.forEach((entry, key) => {
        if (keep.has(key)) return;
        try {
            entry.restore();
        } catch {}
        refOriginals.delete(key);
    });
}
let referenceIntervalStarted = false;

function applyReferenceEdit(e) {
    const el = refResolveTarget(e);   // by its own id, not by position
    if (!el || el.nodeType !== 1) return;

    // Record what this element looked like before we touch it, once.
    // Everything we might overwrite below is captured here.
    refRememberOriginal(e.key, (() => {
        const node   = el;
        const kind   = e.kind;
        const attr   = e.attr || null;
        const color  = node.style.getPropertyValue('color');
        const bg     = node.style.getPropertyValue('background-color');
        const bgImg  = node.style.getPropertyValue('background-image');
        const vis    = node.style.visibility;
        const src    = node.getAttribute ? node.getAttribute('src') : null;
        const srcset = node.getAttribute ? node.getAttribute('srcset') : null;
        const attrVal = attr && node.getAttribute ? node.getAttribute(attr) : null;
        const inputVal = 'value' in node ? node.value : null;
        const html   = kind === 'html' ? node.innerHTML : null;

        const texts = Array.from(node.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
        const textNode =
            (e.nodeIndex != null && texts[e.nodeIndex]) ||
            texts.find((n) => n.textContent.trim()) ||
            texts[0];
        const textVal = textNode ? textNode.textContent : null;

        return function restore() {
            if (!node.isConnected) return;

            color ? node.style.setProperty('color', color) : node.style.removeProperty('color');
            bg    ? node.style.setProperty('background-color', bg) : node.style.removeProperty('background-color');

            if (kind === 'text' && textNode && textVal !== null) {
                textNode.textContent = textVal;
            } else if (kind === 'image') {
                if (src !== null) node.setAttribute('src', src); else node.removeAttribute('src');
                if (srcset !== null) node.setAttribute('srcset', srcset);
                node.style.visibility = vis;
            } else if (kind === 'bg') {
                bgImg ? node.style.setProperty('background-image', bgImg)
                    : node.style.removeProperty('background-image');
            } else if (kind === 'attr' && attr) {
                if (attrVal !== null) node.setAttribute(attr, attrVal); else node.removeAttribute(attr);
            } else if (kind === 'value' && inputVal !== null) {
                node.value = inputVal;
            } else if (kind === 'html' && html !== null) {
                node.innerHTML = html;
            }
        };
    })());

    // the colors — they apply on their own, with no value change
    if (e.color)   el.style.setProperty('color', e.color, 'important');
    if (e.bgColor) el.style.setProperty('background-color', e.bgColor, 'important');

    // value === null means: change ONLY the colors, do not touch the text
    if (e.value === null) return;

    if (e.kind === 'text') {
        const texts = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
        const node =
            (e.nodeIndex != null && texts[e.nodeIndex]) ||
            texts.find((n) => n.textContent.trim()) ||
            texts[0];

        if (node) {
            if (node.textContent !== (e.value ?? '')) node.textContent = e.value ?? '';
        } else if (e.value) {
            el.appendChild(document.createTextNode(e.value));
        }
        return;
    }

    if (e.kind === 'image') {
        const v = (e.value ?? '').trim();
        if (v) {
            if (el.getAttribute('src') !== v) {
                el.setAttribute('src', v);
                el.removeAttribute('srcset');
            }
            el.style.visibility = '';
        } else {
            if (el.getAttribute('src') !== REF_TRANSPARENT_PX) {
                el.setAttribute('src', REF_TRANSPARENT_PX);
                el.removeAttribute('srcset');
            }
            el.style.visibility = 'hidden';
        }
        return;
    }

    if (e.kind === 'bg') {
        const v = (e.value ?? '').trim();
        const want = v ? `url("${v}")` : 'none';
        if (el.style.backgroundImage !== want) {
            el.style.setProperty('background-image', want, 'important');
        }
        return;
    }

    if (e.kind === 'attr') {
        const v = e.value ?? '';
        if (v === '') {
            if (el.hasAttribute(e.attr)) el.removeAttribute(e.attr);
        } else if (el.getAttribute(e.attr) !== v) {
            el.setAttribute(e.attr, v);
        }
        return;
    }

    if (e.kind === 'value') {
        if (el.value !== (e.value ?? '')) el.value = e.value ?? '';
        return;
    }

    if (e.kind === 'html') {
        if (el.innerHTML !== (e.value ?? '')) el.innerHTML = e.value ?? '';
    }
}

function reapplyAllReferenceEdits() {
    currentReferenceEdits.forEach((e) => applyReferenceEdit(e));
}

/* ============================================================
   THE CLONES — "Create new": copies the element (with the selected
   edits) and inserts it at the requested position. Every clone carries a
   unique id, so it is never created twice (neither by the interval, nor
   refresh-it).
   ============================================================ */

let currentReferenceClones = [];

// finds the element inside the clone by its localXpath (relative to the root)
function refFindInClone(rootEl, localXpath) {
    if (!localXpath || localXpath === '.') return rootEl;
    try {
        const result = document.evaluate(localXpath, rootEl, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
    } catch {
        return null;
    }
}

function refApplyEditsToElement(rootEl, edits) {
    (edits || []).forEach((e) => {
        const target = refFindInClone(rootEl, e.localXpath);
        if (!target) return;

        // the colors — on the copy as well
        if (e.color)   target.style.setProperty('color', e.color, 'important');
        if (e.bgColor) target.style.setProperty('background-color', e.bgColor, 'important');

        if (e.value === null) return; // colors only

        const val = e.value ?? '';

        if (e.kind === 'text') {
            const texts = Array.from(target.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
            const node =
                (e.nodeIndex != null && texts[e.nodeIndex]) ||
                texts.find((n) => n.textContent.trim()) ||
                texts[0];
            if (node) node.textContent = val;
            else if (val) target.appendChild(document.createTextNode(val));
        } else if (e.kind === 'image') {
            if (val.trim()) {
                target.setAttribute('src', val.trim());
                target.removeAttribute('srcset');
                target.style.visibility = '';
            } else {
                target.setAttribute('src', REF_TRANSPARENT_PX);
                target.style.visibility = 'hidden';
            }
        } else if (e.kind === 'bg') {
            target.style.setProperty('background-image', val.trim() ? `url("${val.trim()}")` : 'none', 'important');
        } else if (e.kind === 'attr') {
            if (val === '') target.removeAttribute(e.attr);
            else target.setAttribute(e.attr, val);
        } else if (e.kind === 'value') {
            target.value = val;
        } else if (e.kind === 'html') {
            target.innerHTML = val;
        }
    });
}

function applyReferenceClone(clone) {
    // if this clone already exists on the page, do not create it again
    if (document.querySelector(`[data-le-clone="${clone.id}"]`)) return;

    const source = getElementByXPath(clone.xpath);
    if (!source || source.nodeType !== 1) return;

    // never copy a copy — that is how one clone turns into three
    if (source.hasAttribute('data-le-clone')) return;

    const parent = source.parentElement;
    if (!parent) return;

    const copy = source.cloneNode(true);
    refStripStamps(copy);                       // a copy is never the original
    copy.setAttribute('data-le-clone', clone.id);

    // apply the selected edits to the copy (never to the original)
    refApplyEditsToElement(copy, clone.edits);

    // the position: 0 = at the start; n = after the nth sibling (n = end)
    const siblings = Array.from(parent.children).filter((c) => !c.hasAttribute('data-le-clone'));
    const pos = Math.max(0, Math.min(clone.position ?? 0, siblings.length));

    /* Anchor to the first REAL sibling that comes AFTER the position — not to
       parent.firstChild / after.nextSibling, because both of those point at
       clones created earlier. That made every new clone land BEFORE the
       previous one at the same position, so the order came out reversed.
       With a real sibling as the anchor, clones keep their creation order. */
    const anchor = siblings[pos] || null;
    if (anchor) parent.insertBefore(copy, anchor);
    else parent.appendChild(copy);

    refLog('clone created at position', pos, '—', clone.id);
}

function reapplyAllReferenceClones() {
    /* Remove clones that are no longer in the list.
       Without this, deleting a clone (or a whole rule) left the copy sitting
       on the page until a manual reload — which is what made the page look
       half-reverted, with some values updated and others stale. */
    const wanted = new Set(currentReferenceClones.map((c) => c.id));
    document.querySelectorAll('[data-le-clone]').forEach((el) => {
        if (!wanted.has(el.getAttribute('data-le-clone'))) el.remove();
    });

    currentReferenceClones.forEach((c) => applyReferenceClone(c));
}

function removeMissingClones() {
    const keep = new Set(currentReferenceClones.map((c) => c.id));
    document.querySelectorAll('[data-le-clone]').forEach((el) => {
        if (!keep.has(el.getAttribute('data-le-clone'))) el.remove();
    });
}

function startReferenceInterval() {
    startSharedInterval(); // a single interval for everything
}

/* ============================================================
   A SINGLE INTERVAL for all three (xpath, reference, clones).
   Previously there were TWO separate intervals running forever,
   even when there was nothing to do. Now:
     - there is only one
     - it STOPS by itself when there is no work left
     - it restarts by itself as soon as something new arrives
   ============================================================ */

let sharedIntervalId = null;

function hasWorkToDo() {
    return (currentXpathRules && currentXpathRules.length > 0)
        || (currentReferenceEdits && currentReferenceEdits.length > 0)
        || (currentReferenceClones && currentReferenceClones.length > 0);
}

function startSharedInterval() {
    if (sharedIntervalId !== null) return;
    if (!hasWorkToDo()) return;

    sharedIntervalId = setInterval(() => {
        if (!hasWorkToDo()) {
            clearInterval(sharedIntervalId);
            sharedIntervalId = null;
            return;
        }
        reapplyAllXpathRules();
        reapplyAllReferenceEdits();
        reapplyAllReferenceClones();
    }, 1350);
}

/* ============================================================
   MESSAGES FROM background.js
   ============================================================ */

chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;

    try {
        if (message.type === 'reference' && message.ref) {
            referenceFindPath(message.ref);
        }

        if (message.type === 'referenceRead' && message.xpath) {
            referenceRead(message.xpath);
        }

        if (message.type === 'referenceEdits' && Array.isArray(message.edits)) {
            // put back anything that dropped out of the list before applying
            // the new set — otherwise old edits linger on the page forever
            refRestoreRemoved(message.edits);

            currentReferenceEdits = message.edits;
            reapplyAllReferenceEdits();
            startReferenceInterval();
        }

        if (message.type === 'referenceClones' && Array.isArray(message.clones)) {
            /* Run the sweep immediately, not on the next interval tick.
               When the list arrives empty the shared interval stops (there is
               nothing left to do), so the cleanup inside it would never run. */
            currentReferenceClones = message.clones;
            reapplyAllReferenceClones();
            startReferenceInterval();
        }
    } catch (err) {
        refError('Error on the page: ' + (err && err.message ? err.message : err));
    }
});

refLog('new content-script loaded ✓');

/* ---------- after a refresh: the background re-sends the edits to us ---------- */
chrome.runtime.sendMessage({ type: 'referenceRequestPersisted' }).catch(() => {});
/* ============================================================
   ============  N I S J E   E   M E N J E H E R S H M E  ============
   ------------------------------------------------------------
   This is the part that makes it instant, like Tampermonkey scripts.

   BEFORE (slow):
     the page finishes loading -> background.js notices -> waits 250ms
     -> sends a message -> the content script acts.  Far too late.

   NOW (instant):
     the content script starts at 'document_start' and reads the rules
     ITSELF, straight from storage — waiting for no one, with no message.
     The CSS lands before the page paints at all (zero flicker).
   ============================================================ */

(function bootInstantly() {
    // do not boot twice (e.g. if the script gets injected again)
    if (window.__liveEditorBooted) return;
    window.__liveEditorBooted = true;

    function matchesPattern(url, pattern) {
        try {
            const rx = new RegExp('^' + String(pattern || '')
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*') + '$', 'i');
            return rx.test(url);
        } catch {
            return false;
        }
    }

    /* ---------- LOCAL Replacement (your algorithm, no background) ----------
       Before, it went through background.js + chrome.scripting.executeScript.
       Now it runs right here — one step fewer, noticeably faster. */
    function runReplacements(rules) {
        const prepared = (rules || [])
            .filter((r) => r && r.find)
            .map((r) => {
                const esc = r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pre = /^\w/.test(r.find) ? '\\b' : '';
                const suf = /\w$/.test(r.find) ? '\\b' : '';
                return {
                    regex: new RegExp(pre + esc + suf, 'g'),
                    value: r.value ?? '',
                    occurrence: r.occurrence || 0,
                };
            });

        if (prepared.length === 0) return;

        const hasOcc = prepared.some((r) => r.occurrence > 0);
        const done = new Set();

        function pass() {
            if (!document.body) return;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            const counters = hasOcc ? new Map() : null;

            let node;
            while ((node = walker.nextNode())) {
                const tag = node.parentElement && node.parentElement.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;

                const original = node.textContent;
                let text = original;

                for (let i = 0; i < prepared.length; i++) {
                    const rule = prepared[i];
                    rule.regex.lastIndex = 0;

                    if (!rule.occurrence) {
                        text = text.replace(rule.regex, rule.value);
                    } else {
                        if (done.has(i)) continue;
                        text = text.replace(rule.regex, (m) => {
                            const n = (counters.get(i) || 0) + 1;
                            counters.set(i, n);
                            if (n === rule.occurrence) {
                                done.add(i);
                                return rule.value;
                            }
                            return m;
                        });
                    }
                }

                if (text !== original) node.textContent = text;
            }
        }

        pass();

        if (window.__liveEditorReplaceObserver) {
            window.__liveEditorReplaceObserver.disconnect();
        }
        const observer = new MutationObserver(pass);
        observer.observe(document.body, { childList: true, subtree: true });
        window.__liveEditorReplaceObserver = observer;
    }

    function whenBodyReady(fn) {
        if (document.body) {
            fn();
            return;
        }
        // 'document_start' -> <body> does not exist yet; wait for it as fast as possible
        const obs = new MutationObserver(() => {
            if (document.body) {
                obs.disconnect();
                fn();
            }
        });
        obs.observe(document.documentElement, { childList: true });
    }

    function applyRuleNow(rule) {
        // 1) CSS — immediately, before the page paints (zero flicker)
        if (rule.css) {
            applyCSS(rule.css);
        }

        // 2) the part that touches the content — as soon as <body> exists
        whenBodyReady(() => {
            if (Array.isArray(rule.replacements) && rule.replacements.length > 0) {
                runReplacements(rule.replacements);
            }

            if (Array.isArray(rule.xpathReplacements) && rule.xpathReplacements.length > 0) {
                currentXpathRules = rule.xpathReplacements.map((r) => ({ ...r, __resolveFailed: false }));
                reapplyAllXpathRules();
                startXpathInterval();
            }

            if (Array.isArray(rule.referenceEdits) && rule.referenceEdits.length > 0) {
                refRestoreRemoved(rule.referenceEdits);
                currentReferenceEdits = rule.referenceEdits;
                reapplyAllReferenceEdits();
                startReferenceInterval();
            }

            if (Array.isArray(rule.referenceClones) && rule.referenceClones.length > 0) {
                currentReferenceClones = rule.referenceClones;
                reapplyAllReferenceClones();
                startReferenceInterval();
            }
        });
    }

    // read the rules OURSELVES — without waiting for background.js
    try {
        chrome.storage.local.get('rules', (data) => {
            if (chrome.runtime.lastError) return;

            const url = location.href;
            const matching = (data.rules || []).filter(
                (r) => r.enabled !== false && matchesPattern(url, r.pattern)
            );

            if (matching.length === 0) return;
            matching.forEach(applyRuleNow);
        });
    } catch {
        // if storage is not reachable, background.js covers it as a fallback
    }
})();
})();
