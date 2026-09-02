/* ============================================================
   extension/popup.js — Infuse
   ------------------------------------------------------------
   What this popup does:
     1. Reads the current state from background.js (the stored
        pairing code and whether we are connected).
     2. Lets the user paste the pairing code shown by the Infuse
        editor page.
     3. On "Connect" — or on Enter — it stores that code together
        with the tab that is active right now. That tab becomes
        the target page every edit gets applied to.
     4. Closes itself, so the user lands straight back on the page.

   Why the tab is captured here rather than later:
     when the user hits Save inside the editor page, the active tab
     is the editor itself. Capturing the tab at connect time is what
     makes edits land on the intended page instead.

   Note on the Disconnect button:
     it is created here in JavaScript rather than in popup.html, so
     the existing markup stays untouched.
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {

    const codeInput  = document.getElementById('code-input');
    const connectBtn = document.getElementById('connect-btn');
    const statusDot  = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    /* ---------- how long to wait before closing the popup ----------
       Clicking Connect sends a message to background.js. Closing the
       popup in that same instant can cut the message off before it
       arrives, and the connection would silently never happen.
       This pause is short enough to go unnoticed, long enough to be
       safe. */
    const CLOSE_DELAY_MS = 150;

    /* ---------- Disconnect button, built in JS ----------
       Sits right under Connect and only appears while connected. */
    const disconnectBtn = document.createElement('button');
    disconnectBtn.id = 'disconnect-btn';
    disconnectBtn.className = 'copy-btn';
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.hidden = true;
    disconnectBtn.style.marginTop = '8px';
    disconnectBtn.style.opacity = '0.75';
    connectBtn.insertAdjacentElement('afterend', disconnectBtn);

    /* ---------- status display ----------
       The dot is coloured inline on purpose. Class names would have to match
       whatever popup's stylesheet happens to use, and a mismatch leaves the
       dot showing the wrong colour while the text says the opposite. Setting
       the colour directly is always right. */
    const DOT_CONNECTED    = '#a6d189';   // green
    const DOT_DISCONNECTED = '#e78284';   // red
    const DOT_PENDING      = '#e5c890';   // yellow, while dialling

    function paintDot(color) {
        statusDot.style.backgroundColor = color;
        statusDot.style.boxShadow = `0 0 6px ${color}`;
    }

    function setStatus(isConnected, customText) {
        statusText.textContent = customText || (isConnected ? 'Connected' : 'Not connected');

        const pending = customText === 'Connecting…';
        paintDot(pending ? DOT_PENDING : (isConnected ? DOT_CONNECTED : DOT_DISCONNECTED));

        // keep these in sync too, in case the stylesheet uses them
        statusDot.classList.toggle('connected', !!isConnected && !pending);
        statusDot.classList.toggle('disconnected', !isConnected && !pending);

        disconnectBtn.hidden = !isConnected;
    }

    /* ---------- load whatever background.js already knows ---------- */
    function loadState() {
        chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
            if (chrome.runtime.lastError || !response) {
                setStatus(false);
                return;
            }

            if (response.pairingCode) {
                codeInput.value = response.pairingCode;
            }
            setStatus(response.isConnected);
        });
    }

    /* ---------- connect ---------- */
    async function connect(closeAfter) {
        const code = codeInput.value.trim().toUpperCase();

        if (!code) {
            setStatus(false, 'Enter a code first');
            codeInput.focus();
            return;
        }

        // whichever tab is active right now becomes the target page
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            setStatus(false, 'No page found');
            return;
        }

        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting…';

        chrome.runtime.sendMessage(
            { type: 'setCode', code, tabId: tab.id },
            () => {
                connectBtn.disabled = false;
                connectBtn.textContent = 'Connect';

                if (chrome.runtime.lastError) {
                    setStatus(false, 'Could not connect');
                    return;
                }

                setStatus(true, 'Connecting…');

                if (closeAfter) {
                    setTimeout(() => window.close(), CLOSE_DELAY_MS);
                }
            }
        );
    }

    /* ---------- disconnect ----------
       Clears the stored code, which stops the extension from talking
       to the relay. Saved rules are untouched and keep working. */
    function disconnect() {
        chrome.runtime.sendMessage({ type: 'setCode', code: '', tabId: null }, () => {
            codeInput.value = '';
            setStatus(false, 'Disconnected');
            codeInput.focus();
        });
    }

    /* ---------- events ---------- */
    connectBtn.addEventListener('click', () => connect(true));
    disconnectBtn.addEventListener('click', disconnect);

    // Enter inside the code field: connect, then close the popup
    codeInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        connect(true);
    });

    // Escape closes the popup without changing anything
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') window.close();
    });

    // keep the field tidy: uppercase, no spaces
    codeInput.addEventListener('input', () => {
        const cleaned = codeInput.value.toUpperCase().replace(/\s+/g, '');
        if (cleaned !== codeInput.value) codeInput.value = cleaned;
    });

    /* ---------- live updates pushed by background.js ---------- */
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'connectionStatusChanged') {
            setStatus(message.isConnected);
        }

        // the relay refused this code because another device holds it
        if (message.type === 'codeTaken') {
            setStatus(false, 'Code already in use');
        }
    });

    /* ---------- start ---------- */
    loadState();
    codeInput.focus();
    codeInput.select();
});