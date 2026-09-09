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

/* Every text node the local Replacement overwrote, and what it said before.
   Without this, Disconnect could stop new replacements but never take back
   the ones already written. */
const replacementOriginals = new Map();

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
        /* The path is evaluated ONCE and the element itself is kept. Every
           pass after that is a pointer check and a string compare — no
           document.evaluate at all. That matters now that a pass runs on
           every batch of mutations instead of once every 1.35s: measured on
           a page being built, keeping the element costs ~1ms where looking
           it up again cost ~70ms.

           When the page throws that element away (a re-render), isConnected
           turns false by itself and the path is looked up again. */
        let target = (rule.__el && rule.__el.isConnected) ? rule.__el : null;
        if (!target) {
            target = getElementByXPath(rule.xpath);
            rule.__el = (target && target.nodeType === 1) ? target : null;
        }
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

    /* ---------- no path yet: find it by text ----------

       Two things have to be right here, and they are the reason a rule that
       came from STORAGE (refresh mode, or simply opening the page again)
       used to end up with no path at all while the very same rule found it
       instantly when it was pushed to a page that had already loaded:

       1. DO NOT SEARCH A PAGE THAT IS NOT THERE YET.
          This engine starts at 'document_start'. <body> exists, but it is
          empty — the page has not been parsed. Searching it finds nothing,
          of course.

       2. ONE MISS IS NOT A FAILURE.
          A single miss used to mark the rule dead for good, so the 1.35s
          pass below never looked again — not even once the page was fully
          there. Now a miss only counts once the document has been parsed,
          and the rule is given a few passes before it is given up on: long
          enough for text the page renders with its own JavaScript, short
          enough that a value which really is not there stops costing a
          full-page search every 1.35 seconds. */
    if (rule.__resolveFailed) return;      // given up on — do not search again
    if (document.readyState === 'loading') return;   // the page is still arriving

    const el = resolveElementByReferenceOccurrence(rule.find, rule.occurrence);
    if (!el) {
        rule.__resolveTries = (rule.__resolveTries || 0) + 1;
        if (rule.__resolveTries >= XPATH_MAX_RESOLVE_TRIES) {
            rule.__resolveFailed = true;
        }
        return;
    }

    rule.xpath = getElementXPath(el);
    chrome.runtime.sendMessage({ type: 'xpathRuleResolved', index, xpath: rule.xpath }).catch(() => {});

    /* Remember the original text BEFORE the first write, under the same key the
       fast route above uses. Without this, the very first write went unrecorded:
       the next interval tick would then record the ALREADY CHANGED text as the
       original, and Disconnect would "restore" the page to the wrong value. */
    refRememberOriginal('xpath|' + rule.xpath, (() => {
        const node = el;
        const was  = el.textContent;
        return function restore() {
            if (node.isConnected) node.textContent = was;
        };
    })());

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

/* How many passes a rule gets to find its value before it is given up on.
   The pass runs every 1.35s, so this is roughly 11 seconds after the page has
   been parsed — enough for content the page renders itself. */
const XPATH_MAX_RESOLVE_TRIES = 8;

function reapplyAllXpathRules(pinnedOnly) {
    currentXpathRules.forEach((rule, i) => {
        /* Finding a path by TEXT walks the whole document. That is fine once,
           on a schedule — never on every mutation while the page is being
           parsed. A path already pinned costs one document.evaluate. */
        if (pinnedOnly && !rule.xpath) return;
        applyXPathRule(rule, rule.index ?? i);
    });
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
        currentXpathRules = message.rules.map((r) => ({ ...r, __resolveFailed: false, __resolveTries: 0 }));
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

/* ============================================================
   THE WHOLE PAGE — the snapshot the preview really shows
   ------------------------------------------------------------
   Until now only the chosen element travelled back, and the preview
   rebuilt a tiny fake page around it. You saw the element, but never
   WHERE it sits.

   Now the entire page goes with it, exactly as it stands, with the chosen
   element carrying a mark (REF_TARGET_MARK) so the editor can find it
   again and draw the lilac outline around it — and around nothing else.

   What is stripped out: everything that would run, load or navigate on
   its own inside the preview (scripts, frames, plugins, meta-refresh).
   The look stays; the behaviour does not.
   ============================================================ */
const REF_TARGET_MARK = 'data-le-ref-target';
const REF_MAX_PAGE_CHARS = 2500000;
const REF_MAX_PAGE_CSS_CHARS = 800000;

function refAbsoluteUrl(url, base) {
    try {
        return new URL(url, base).href;
    } catch {
        return url;
    }
}

/* A rule taken out of its stylesheet loses the address it was written
   against: "url(../img/x.png)" inside /assets/app.css points somewhere else
   entirely once it sits inside the page itself. So every url() is pinned to
   the sheet it came from before it is inlined. */
function refRewriteCssUrls(cssText, base) {
    if (!base) return String(cssText);
    return String(cssText).replace(
        /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (whole, quote, raw) => {
            const url = raw.trim();
            if (!url || /^(data:|blob:|about:|https?:|\/\/|#)/i.test(url)) return whole;
            return 'url("' + refAbsoluteUrl(url, base) + '")';
        }
    );
}

function refSerializeSheet(sheet, budget) {
    let rules;
    try {
        rules = sheet.cssRules;      // throws on a genuinely cross-origin sheet
    } catch {
        return null;
    }
    if (!rules) return null;

    const base = sheet.href || document.baseURI;
    let out = '';

    for (const rule of Array.from(rules)) {
        out += refRewriteCssUrls(rule.cssText, base) + '\n';
        if (out.length > budget) break;
    }

    // a </style> inside a CSS string would end the tag early and take the rest
    // of the page with it; "\/" means the same thing to a CSS parser
    return out.replace(/<\/(style)/gi, '<\\/$1');
}

/* these two turn a plain stylesheet fetch into a CORS one — and a CORS fetch
   the other site never agreed to means no stylesheet at all */
function refStripLinkGuards(node) {
    if (!node || node.tagName !== 'LINK') return;
    try {
        node.removeAttribute('crossorigin');
        node.removeAttribute('integrity');
    } catch {}
}

/* ============================================================
   THE CSS — why some pages used to come back as bare HTML
   ------------------------------------------------------------
   The clone carries <link> tags, and inside the preview each one has to be
   fetched all over again. Three things routinely stop that:

     - the link carries crossorigin/integrity, so the fetch becomes a CORS
       request the other site never agreed to, and the sheet is dropped
     - the editor runs on https while the page's CSS sits on http
       (mixed content — blocked outright, no way around it)
     - the styles were never in the HTML to begin with: styled-components
       and friends push their rules straight into an EMPTY <style> tag, and
       adoptedStyleSheets live in no markup at all

   So rather than hoping the links load, every stylesheet the browser has
   ALREADY parsed is read out and written into the clone IN PLACE, exactly
   where its own <link>/<style> stood — the cascade order is untouched.
   Whatever cannot be read (a real cross-origin sheet) keeps its link,
   stripped of the attributes that would have made the fetch fail.
   ============================================================ */
function refInlineStylesheets(clone) {
    const SEL = 'link[rel~="stylesheet" i], style';

    let liveNodes, cloneNodes;
    try {
        liveNodes  = Array.from(document.querySelectorAll(SEL));
        cloneNodes = Array.from(clone.querySelectorAll(SEL));
    } catch {
        return;
    }

    let budget = REF_MAX_PAGE_CSS_CHARS;

    /* The clone was taken a moment ago and nothing has touched the page
       since, so node N here is node N there. If that ever stops holding,
       leave every link alone rather than put the wrong CSS in the wrong
       place. */
    if (liveNodes.length !== cloneNodes.length) {
        cloneNodes.forEach(refStripLinkGuards);
    } else {
        liveNodes.forEach((liveNode, i) => {
            const cloneNode = cloneNodes[i];
            if (!cloneNode) return;

            // a <style> that still holds its own text is already in the clone
            if (liveNode.tagName === 'STYLE' && liveNode.textContent.trim()) return;

            const sheet = liveNode.sheet;
            if (!sheet || sheet.disabled || budget <= 0) {
                refStripLinkGuards(cloneNode);
                return;
            }

            const css = refSerializeSheet(sheet, budget);
            if (!css) {
                refStripLinkGuards(cloneNode);
                return;
            }

            budget -= css.length;

            const styleTag = document.createElement('style');
            const media = liveNode.getAttribute('media')
                || (sheet.media && sheet.media.mediaText)
                || '';
            if (media) styleTag.setAttribute('media', media);
            styleTag.textContent = css;

            try {
                cloneNode.replaceWith(styleTag);
            } catch {
                refStripLinkGuards(cloneNode);
            }
        });
    }

    // ADOPTED sheets — attached from JavaScript, present in no markup at all
    try {
        let extra = '';
        for (const sheet of Array.from(document.adoptedStyleSheets || [])) {
            if (budget <= 0) break;
            const css = refSerializeSheet(sheet, budget);
            if (!css) continue;
            budget -= css.length;
            extra += css + '\n';
        }

        if (extra) {
            const head = clone.querySelector('head') || clone;
            const styleTag = document.createElement('style');
            styleTag.setAttribute('data-le-adopted', '1');
            styleTag.textContent = extra;
            head.appendChild(styleTag);
        }
    } catch {}
}

/* The clone copies the ATTRIBUTES, and a field's attribute still holds
   whatever it started with — not what is in it now. Anything typed (or
   filled in by the site) would be missing from the picture, so it is
   carried over by hand. */
function refSyncFieldValues(clone) {
    let live, copy;
    try {
        live = document.querySelectorAll('input,textarea,select');
        copy = clone.querySelectorAll('input,textarea,select');
    } catch {
        return;
    }
    if (live.length !== copy.length) return; // shapes drifted apart — leave it alone

    live.forEach((el, i) => {
        const c = copy[i];
        if (!c) return;
        try {
            if (el.tagName === 'TEXTAREA') {
                c.textContent = el.value;
            } else if (el.tagName === 'SELECT') {
                Array.from(c.options).forEach((opt, j) => {
                    if (el.options[j] && el.options[j].selected) opt.setAttribute('selected', '');
                    else opt.removeAttribute('selected');
                });
            } else if (el.type === 'checkbox' || el.type === 'radio') {
                if (el.checked) c.setAttribute('checked', '');
                else c.removeAttribute('checked');
            } else {
                c.setAttribute('value', el.value ?? '');
            }
        } catch {}
    });
}

function refBuildPageSnapshot(el) {
    let clone = null;

    // the mark goes on the real element for the length of one clone, no longer
    try {
        el.setAttribute(REF_TARGET_MARK, '1');
        clone = document.documentElement.cloneNode(true);
    } catch {
        return null;
    } finally {
        try { el.removeAttribute(REF_TARGET_MARK); } catch {}
    }

    if (!clone) return null;

    try {
        refSyncFieldValues(clone);
        refInlineStylesheets(clone);

        clone.querySelectorAll(
            'script,noscript,template,iframe,frame,object,embed,meta[http-equiv],base,#' + PANEL_HOST_ID
        ).forEach((n) => n.remove());

        // nothing in the preview may be marked except the one element
        clone.querySelectorAll('[' + REF_TARGET_MARK + ']').forEach((n, i) => {
            if (i > 0) n.removeAttribute(REF_TARGET_MARK);
        });

        const html = '<!DOCTYPE html>' + clone.outerHTML;

        // a page too big to send is no page at all — the editor then falls
        // back to the old element-only preview by itself
        if (html.length > REF_MAX_PAGE_CHARS) {
            refLog('page snapshot skipped — too big:', html.length, 'chars');
            return null;
        }

        return html;
    } catch (err) {
        refLog('page snapshot failed:', err);
        return null;
    }
}

function refBuildSnapshot(el) {
    try {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('script,noscript').forEach((n) => n.remove());

        const page = refBuildPageSnapshot(el);   // ADDED — the whole page around it

        return {
            html: clone.outerHTML,
            /* The page brings its own <style> and <link> tags with it, so the
               gathered CSS is dead weight there — it is only worth collecting
               (and sending) for the element-only fallback. */
            css: page ? '' : refCollectCss(),
            baseHref: document.baseURI,
            tag: el.tagName.toLowerCase(),
            ancestors: refBuildAncestorChain(el), // ADDED — the real parent chain
            page,
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
    // the element is kept once found — see the note in applyXPathRule
    let el = (e.__el && e.__el.isConnected) ? e.__el : null;
    if (!el) {
        el = refResolveTarget(e);   // by its own id, not by position
        e.__el = (el && el.nodeType === 1) ? el : null;
    }
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
    if (clone.__el && clone.__el.isConnected) return;   // kept, as above

    const existing = document.querySelector(`[data-le-clone="${clone.id}"]`);
    if (existing) {
        clone.__el = existing;
        return;
    }

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

    clone.__el = copy;

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

/* ============================================================
   INSTANT — what makes Replacement feel immediate, given to the rest
   ------------------------------------------------------------
   Everything here used to be driven by ONE pass every 1.35 seconds. On a
   page that is still loading that is an age: the page draws the old value,
   you see it sitting there, and only then does it flip. That was the
   slowness — not the work itself, which takes microseconds.

   A MutationObserver changes WHEN the work happens: the page reports a new
   node the instant it is parsed, and the rules land with it. A pinned path
   is therefore written as early as the parser reaches the element — exactly
   as early as Replacement, which has always been driven this way.

   The 1.35s pass stays behind it as a safety net, for values a page changes
   in ways no observer reports.

   Only CHEAP work runs on a mutation: pinned paths, the reference edits,
   the clones. Searching by text keeps to the slow lane (and to
   DOMContentLoaded, where the document is whole for the first time).
   ============================================================ */
let sharedObserver = null;
let sharedPassQueued = false;

function runFastPass() {
    if (!hasWorkToDo()) return;
    reapplyAllXpathRules(true);                 // pinned paths only
    reapplyAllReferenceEdits();
    currentReferenceClones.forEach((c) => applyReferenceClone(c));
}

function queueSharedPass() {
    if (sharedPassQueued) return;   // one pass per batch of mutations, not per node
    sharedPassQueued = true;
    Promise.resolve().then(() => {
        sharedPassQueued = false;
        runFastPass();
    });
}

function startSharedObserver() {
    if (sharedObserver) return;

    const root = document.documentElement;
    if (!root) return;

    sharedObserver = new MutationObserver(queueSharedPass);
    sharedObserver.observe(root, { childList: true, subtree: true, characterData: true });

    /* Every write below is guarded by "only if it differs", so our own writes
       settle on the next pass instead of setting off a loop. */

    /* The first search by text needs the WHOLE document (Match # counts from
       the top of it), so it runs the moment the document is parsed — not on
       the next 1.35s tick, which is where the rest of the wait came from. */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (!hasWorkToDo()) return;
            reapplyAllXpathRules();
            reapplyAllReferenceEdits();
            reapplyAllReferenceClones();
        }, { once: true });
    }
}

function stopSharedObserver() {
    if (!sharedObserver) return;
    try { sharedObserver.disconnect(); } catch {}
    sharedObserver = null;
}

function startSharedInterval() {
    if (!hasWorkToDo()) return;

    startSharedObserver();   // the fast lane; the interval below is the safety net

    if (sharedIntervalId !== null) return;

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

/* ============================================================
   REVERT — put the page back exactly as it was
   ------------------------------------------------------------
   Sent by background.js when you press Disconnect. Undoes, in one
   pass, every kind of change this script can make:

     - Replacement text        -> replacementOriginals
     - XPath + Reference edits -> refOriginals (refRestoreRemoved)
     - the copies              -> [data-le-clone]
     - the injected CSS        -> the <style> tag

   Emptying the three lists also stops the shared interval on its own,
   so nothing re-applies a moment later.

   The injected JS is the one thing that cannot be taken back: code
   that has already run stays run. It is simply never injected again.
   ============================================================ */
function revertEverything() {
    // 1) the text Replacement overwrote
    replacementOriginals.forEach((was, node) => {
        try {
            if (node.isConnected) node.textContent = was;
        } catch {}
    });
    replacementOriginals.clear();

    if (window.__liveEditorReplaceObserver) {
        try {
            window.__liveEditorReplaceObserver.disconnect();
        } catch {}
        window.__liveEditorReplaceObserver = null;
    }

    // 2) XPath rules and Reference edits both keep their originals in refOriginals
    refRestoreRemoved([]);
    currentReferenceEdits = [];
    currentXpathRules = [];

    // 3) the copies made with "Create new"
    document.querySelectorAll('[data-le-clone]').forEach((el) => el.remove());
    currentReferenceClones = [];

    // 4) the fast lane stops with the rules it was serving
    stopSharedObserver();

    // 5) the injected CSS
    const styleTag = document.getElementById(STYLE_TAG_ID);
    if (styleTag) styleTag.remove();

    refLog('everything reverted — the page is back to its original state');
}

chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;

    try {
        if (message.type === 'revertAll') {
            revertEverything();
        }

        if (message.type === 'reference' && message.ref) {
            referenceFindPath(message.ref);
        }

        if (message.type === 'referenceRead' && message.xpath) {
            referenceRead(message.xpath);
        }

        if (message.type === 'referenceEdits' && Array.isArray(message.edits)) {
            /* Put back anything that dropped out of the list before applying the
               new set — otherwise old edits linger on the page forever.

               The XPath rules keep their originals in the SAME map, so their keys
               have to be listed here as well. Without them, every 'referenceEdits'
               message silently reverted the XPath rules too. */
            refRestoreRemoved([
                ...message.edits,
                ...currentXpathRules.filter((r) => r.xpath).map((r) => ({ key: 'xpath|' + r.xpath })),
            ]);

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
   THE IN-PAGE PANEL — for Android, where there is no popup
   ------------------------------------------------------------
   Firefox for Android does not have an anchored popup: tapping the
   toolbar icon opens the extension's popup as a WHOLE SEPARATE SCREEN.
   It can be made to look right (it is), but it is still the wrong shape
   for this tool — you leave the page you are working on, type a code,
   and come back.

   So on Android background.js switches that popup off, and the tap
   arrives here instead: the same panel is built INSIDE the page and
   slides down from the top, over the page you are already on, the way a
   message does.

   It lives in a CLOSED shadow root, so the page's CSS cannot reach into
   it and its own CSS cannot leak out onto the page. And it hangs off
   <html>, not <body>, so none of the engines above (which all walk
   document.body) ever see it.
   ============================================================ */

const PANEL_HOST_ID = '__infuse_panel_host__';

let panelHost = null;
let panelRoot = null;
let panelEl = null;      // { sheet, code, connect, disconnect, dot, text }

const PANEL_DOT = {
    connected: '#a6d189',      // green
    disconnected: '#e78284',   // red
    pending: '#e5c890',        // yellow, while dialling
};

function panelIsOpen() {
    return !!panelHost && panelHost.isConnected;
}

function closePanel() {
    if (!panelHost) return;
    try { panelHost.remove(); } catch {}
    panelHost = null;
    panelRoot = null;
    panelEl = null;
}

function panelSetStatus(isConnected, customText) {
    if (!panelEl) return;

    panelEl.text.textContent = customText || (isConnected ? 'Connected' : 'Not connected');

    const pending = customText === 'Connecting…';
    const color = pending
        ? PANEL_DOT.pending
        : (isConnected ? PANEL_DOT.connected : PANEL_DOT.disconnected);

    panelEl.dot.style.backgroundColor = color;
    panelEl.dot.style.boxShadow = '0 0 6px ' + color;

    panelEl.disconnect.hidden = !isConnected || pending;
}

function openPanel() {
    if (panelIsOpen()) return;

    panelHost = document.createElement('div');
    panelHost.id = PANEL_HOST_ID;

    /* The host itself carries no look at all — everything is inside the
       shadow root. 'all: initial' stops the page's own rules (a global
       "div { display: flex }" and the like) from reaching it. */
    panelHost.style.cssText = [
        'all: initial',
        'position: fixed',
        'inset: 0 0 auto 0',
        'z-index: 2147483647',
    ].join(';');

    panelRoot = panelHost.attachShadow({ mode: 'closed' });

    panelRoot.innerHTML = `
        <style>
            :host, * { box-sizing: border-box; }

            .backdrop {
                position: fixed;
                inset: 0;
                background: rgba(35, 38, 52, 0.45);
                opacity: 0;
                transition: opacity .18s ease;
            }

            .sheet {
                position: relative;
                font-family: "CaskaydiaCove Nerd Font", "Cascadia Code", "JetBrains Mono", ui-monospace, monospace;
                background: #303446;
                color: #c6d0f5;
                padding: 15px 17px 18px;
                border-radius: 0 0 14px 14px;
                border-bottom: 1px solid #414559;
                box-shadow: 0 12px 32px rgba(0, 0, 0, .38);
                transform: translateY(-100%);
                transition: transform .22s cubic-bezier(.2, .8, .3, 1);
            }

            :host(.open) .backdrop { opacity: 1; }
            :host(.open) .sheet { transform: translateY(0); }

            h1 {
                font-size: 1.2rem;
                font-weight: 600;
                margin: 0 0 13px;
                letter-spacing: .01em;
                color: #ca9ee6;
            }

            label {
                display: block;
                font-size: 0.66rem;
                letter-spacing: .06em;
                text-transform: uppercase;
                color: #a5adce;
                margin-bottom: .35rem;
            }

            input {
                width: 100%;
                font-family: inherit;
                font-size: 1.02rem;
                font-weight: 600;
                letter-spacing: .13em;
                text-align: center;
                text-transform: uppercase;
                padding: 12px 14px;
                border: 1px solid #626880;
                border-radius: 9px;
                background: #292c3c;
                color: #c6d0f5;
                outline: none;
            }

            input:focus { border-color: #babbf1; }

            input::placeholder {
                color: #737994;
                font-weight: 400;
                letter-spacing: normal;
                text-transform: none;
            }

            button.act {
                width: 100%;
                margin-top: 9px;
                padding: 12px 14px;
                font-family: inherit;
                font-size: .85rem;
                border: 1px solid #51576d;
                border-radius: 9px;
                background: transparent;
                color: #a5adce;
                cursor: pointer;
            }

            button.act:active { background: #414559; color: #c6d0f5; }
            button.act[hidden] { display: none; }

            .status {
                display: flex;
                align-items: center;
                gap: 7px;
                margin-top: 13px;
                font-size: .78rem;
                color: #a5adce;
            }

            .dot {
                width: 9px;
                height: 9px;
                border-radius: 50%;
                background: #e78284;
                flex-shrink: 0;
            }

            .x {
                position: absolute;
                top: 9px;
                right: 9px;
                width: 34px;
                height: 34px;
                font-family: inherit;
                font-size: 1.15rem;
                line-height: 1;
                border: none;
                border-radius: 8px;
                background: transparent;
                color: #737994;
                cursor: pointer;
            }

            .x:active { background: #414559; color: #c6d0f5; }
        </style>

        <div class="backdrop"></div>
        <div class="sheet">
            <button class="x" aria-label="Close">×</button>
            <h1>Infuse</h1>
            <label>Code (from editor-app)</label>
            <input class="code" type="text" placeholder="e.g. X7K2M9" maxlength="8"
                   autocomplete="off" autocapitalize="characters" spellcheck="false">
            <button class="act connect">Connect</button>
            <button class="act disconnect" hidden>Disconnect</button>
            <div class="status"><span class="dot"></span><span class="text">Not connected</span></div>
        </div>
    `;

    document.documentElement.appendChild(panelHost);

    panelEl = {
        sheet: panelRoot.querySelector('.sheet'),
        code: panelRoot.querySelector('.code'),
        connect: panelRoot.querySelector('.connect'),
        disconnect: panelRoot.querySelector('.disconnect'),
        dot: panelRoot.querySelector('.dot'),
        text: panelRoot.querySelector('.text'),
    };

    /* Slide it in on the next frame, so the transition actually runs.
       The timer behind it is not decoration: a page that is not being
       painted (a background tab, a window behind another) never fires
       requestAnimationFrame at all, and the panel would sit forever just
       above the top of the screen — built, but invisible. Adding the class
       twice costs nothing. */
    const revealPanel = () => panelHost && panelHost.classList.add('open');
    requestAnimationFrame(revealPanel);
    setTimeout(revealPanel, 60);

    /* ---------- what the popup does, done here ---------- */

    panelRoot.querySelector('.x').addEventListener('click', closePanel);
    panelRoot.querySelector('.backdrop').addEventListener('click', closePanel);

    panelEl.code.addEventListener('input', () => {
        const cleaned = panelEl.code.value.toUpperCase().replace(/\s+/g, '');
        if (cleaned !== panelEl.code.value) panelEl.code.value = cleaned;
    });

    panelEl.code.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); panelConnect(); }
        if (e.key === 'Escape') closePanel();
    });

    panelEl.connect.addEventListener('click', panelConnect);
    panelEl.disconnect.addEventListener('click', panelDisconnect);

    // fill in whatever background.js already knows
    try {
        chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
            if (chrome.runtime.lastError || !response || !panelEl) return;
            if (response.pairingCode) panelEl.code.value = response.pairingCode;
            panelSetStatus(response.isConnected);
        });
    } catch {}

    /* No auto-focus, deliberately. On a phone it throws the keyboard up the
       instant the panel appears, and the browser scrolls to reveal the field
       — which drags the panel's own head off the top of the screen. The code
       is already filled in anyway; tapping the field selects it. */
    panelEl.code.addEventListener('focus', () => panelEl && panelEl.code.select());
}

/* No tabId is sent: the panel IS the page, so background.js takes the tab
   the message came from. That is also what makes it right — the page you
   are looking at is the page that gets connected. */
function panelConnect() {
    if (!panelEl) return;

    const code = panelEl.code.value.trim().toUpperCase();
    if (!code) {
        panelSetStatus(false, 'Enter a code first');
        panelEl.code.focus();
        return;
    }

    panelEl.connect.disabled = true;
    panelEl.connect.textContent = 'Connecting…';

    chrome.runtime.sendMessage({ type: 'setCode', code }, () => {
        if (!panelEl) return;

        panelEl.connect.disabled = false;
        panelEl.connect.textContent = 'Connect';

        if (chrome.runtime.lastError) {
            panelSetStatus(false, 'Could not connect');
            return;
        }

        panelSetStatus(true, 'Connecting…');
        setTimeout(closePanel, 700);   // long enough to read it, short enough not to be in the way
    });
}

function panelDisconnect() {
    if (!panelEl) return;

    panelEl.disconnect.disabled = true;
    panelEl.disconnect.textContent = 'Clearing…';

    chrome.runtime.sendMessage({ type: 'disconnectAndWipe' }, (res) => {
        if (!panelEl) return;
        panelEl.disconnect.disabled = false;
        panelEl.disconnect.textContent = 'Disconnect';
        panelEl.code.value = '';
        panelSetStatus(false, res && res.rulesDeleted ? 'Disconnected — page cleared' : 'Disconnected');
    });
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'togglePanel') {
        if (panelIsOpen()) closePanel();
        else openPanel();
    }

    if (message.type === 'connectionStatusChanged' && panelIsOpen()) {
        panelSetStatus(message.isConnected);
    }
});

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

                if (text !== original) {
                    if (!replacementOriginals.has(node)) {
                        replacementOriginals.set(node, original);
                    }
                    node.textContent = text;
                }
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
                currentXpathRules = rule.xpathReplacements.map((r) => ({ ...r, __resolveFailed: false, __resolveTries: 0 }));
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
