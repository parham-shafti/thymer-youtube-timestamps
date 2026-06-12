/**
 * YouTube Timestamps for Thymer
 *
 * While watching a YouTube clip embedded on a page, press the hotkey
 * (default Cmd+Shift+T): a new row "1:13 - " appears at the caret and the
 * caret is placed right after it — just keep typing. Press the hotkey
 * again whenever the next thought comes; each press starts the next
 * timestamped row. Clicking a timestamp seeks the embedded player there;
 * Cmd+click opens the link in the browser as a normal YouTube deep link.
 *
 * Implementation notes (hard-won):
 * - The editor only accepts trusted input, so the timestamp is written via
 *   the SDK as a FRESH row (never into the row being edited — row identity
 *   shifts on Enter-splits and the editor clobbers writes to active rows).
 * - The caret is moved with synthetic PointerEvents (the one untrusted
 *   input the editor honors) once the new row has rendered.
 * - Characters typed before the row is ready are swallowed by a capture
 *   keydown listener into a buffer and written into the row when it
 *   renders, so nothing ever lands on the wrong line.
 */
class Plugin extends AppPlugin {

    // hotkey: Cmd+Shift+T (Mac) / Ctrl+Shift+T elsewhere
    static HOTKEY_CODE = 'KeyT';

    players = new Map();   // iframe element -> { videoId, lastTime }
    observer = null;
    msgHandler = null;
    keyHandler = null;
    clickHandler = null;
    pointerHandler = null;
    mouseHandler = null;
    patchTimer = null;
    pending = null;        // { item, url, label, written, ghostEl } being placed
    buffering = false;     // swallowing keystrokes while the new row renders
    buffer = '';
    bufferChangedAt = 0;
    stampCounter = 0;
    lastItemGuid = null;   // last stamped row, fallback anchor for ordering
    lastRecordGuid = null;

    onLoad() {
        this.msgHandler = (e) => this.onPlayerMessage(e);
        window.addEventListener('message', this.msgHandler);

        this.keyHandler = (e) => this.onKeyDown(e);
        window.addEventListener('keydown', this.keyHandler, true);

        this.clickHandler = (e) => this.onClick(e);
        window.addEventListener('click', this.clickHandler, true);

        // a real click while the stamp is settling means the user moved on:
        // flush the buffer into the row and stop intercepting keys
        this.pointerHandler = (e) => {
            if (e.isTrusted && this.pending) this.finalizePending('clicked-away');
        };
        window.addEventListener('pointerdown', this.pointerHandler, true);

        // After clicking the video, keyboard focus is stuck inside the
        // YouTube iframe and hotkeys never reach the page. When the mouse
        // moves back out of the embed, give focus back to the app.
        this.mouseHandler = (e) => {
            const ae = document.activeElement;
            if (!ae || ae.tagName !== 'IFRAME' || !this.players.has(ae)) return;
            const r = ae.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
                ae.blur();
            }
        };
        window.addEventListener('mousemove', this.mouseHandler);

        // Patch embeds as soon as they appear (re-renders revert the src)
        this.observer = new MutationObserver(() => this.schedulePatch());
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.patchAllEmbeds();
    }

    onUnload() {
        if (this.msgHandler) window.removeEventListener('message', this.msgHandler);
        if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler, true);
        if (this.clickHandler) window.removeEventListener('click', this.clickHandler, true);
        if (this.pointerHandler) window.removeEventListener('pointerdown', this.pointerHandler, true);
        if (this.mouseHandler) window.removeEventListener('mousemove', this.mouseHandler);
        if (this.observer) this.observer.disconnect();
        if (this.patchTimer) clearTimeout(this.patchTimer);
        if (this.pending && this.pending.ghostEl) this.pending.ghostEl.remove();
        this.pending = null;
        this.buffering = false;
        this.players.clear();
    }

    // ---- player bridge -------------------------------------------------

    schedulePatch() {
        if (this.patchTimer) return;
        this.patchTimer = setTimeout(() => {
            this.patchTimer = null;
            this.patchAllEmbeds();
        }, 100);
    }

    patchAllEmbeds() {
        // drop players whose iframe left the DOM
        for (const iframe of [...this.players.keys()]) {
            if (!iframe.isConnected) this.players.delete(iframe);
        }
        for (const iframe of document.querySelectorAll('iframe.media-widget-youtube')) {
            if (this.players.has(iframe)) continue;
            const m = iframe.src.match(/\/embed\/([\w-]+)/);
            if (!m) continue;
            if (!iframe.src.includes('enablejsapi')) {
                iframe.src = iframe.src + (iframe.src.includes('?') ? '&' : '?')
                    + 'enablejsapi=1&origin=' + location.origin;
            }
            this.players.set(iframe, { videoId: m[1], lastTime: 0 });
            // handshake (retry a few times while the player boots)
            let tries = 0;
            const hello = () => {
                if (!iframe.isConnected || tries++ > 5) return;
                try {
                    iframe.contentWindow.postMessage(
                        JSON.stringify({ event: 'listening', id: 'yt-ts', channel: 'widget' }), '*');
                } catch (e) {}
                setTimeout(hello, 1500);
            };
            iframe.addEventListener('load', () => setTimeout(hello, 300));
            setTimeout(hello, 300);
        }
    }

    onPlayerMessage(e) {
        if (typeof e.data !== 'string' || !/youtube/.test(e.origin)) return;
        let d;
        try { d = JSON.parse(e.data); } catch (err) { return; }
        if (!d || !d.info || d.info.currentTime === undefined) return;
        for (const [iframe, state] of this.players) {
            if (iframe.contentWindow === e.source) {
                state.lastTime = d.info.currentTime;
                break;
            }
        }
    }

    sendCommand(iframe, func, args) {
        try {
            iframe.contentWindow.postMessage(
                JSON.stringify({ event: 'command', func, args: args || [], id: 'yt-ts', channel: 'widget' }), '*');
        } catch (e) {}
    }

    // ---- keyboard ---------------------------------------------------------

    onKeyDown(e) {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.shiftKey && e.code === Plugin.HOTKEY_CODE) {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.trace('hotkey');
            if (this.pending) this.finalizePending('next-stamp');
            // start swallowing immediately so nothing lands on the old row
            this.buffering = true;
            this.buffer = '';
            this.insertTimestamp().catch(err => {
                this.buffering = false;
                this.trace('error', { msg: String(err) });
            });
            return;
        }
        // while the new row settles, capture the keystrokes that belong on it
        if (this.buffering && !mod && !e.altKey) {
            if (e.key === 'Backspace') {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.buffer = this.buffer.slice(0, -1);
                this.bufferChangedAt = Date.now();
                this.renderGhost();
            } else if (e.key === 'Enter') {
                // swallow: an Enter this early would split the old row
                e.preventDefault();
                e.stopImmediatePropagation();
            } else if (e.key.length === 1) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.buffer += e.key;
                this.bufferChangedAt = Date.now();
                this.renderGhost();
            }
        }
    }

    // ---- timestamp insertion ----------------------------------------------

    // last-20 event trace for debugging: window.__yttsLog
    trace(reason, extra) {
        const log = (window.__yttsLog = window.__yttsLog || []);
        log.push({ at: new Date().toISOString().slice(11, 23), reason, ...(extra || {}) });
        if (log.length > 20) log.shift();
    }

    // The caret element's Y position is the reliable signal; the
    // .listitem-with-caret class lags behind Enter/typing navigation.
    findCaretLine() {
        const caretEl = document.querySelector('.editor-panel.focused-component .listview-caret-self')
            || document.querySelector('.listview-caret-self');
        if (caretEl) {
            const cy = caretEl.getBoundingClientRect().y;
            const scope = caretEl.closest('.editor-panel') || document;
            for (const el of scope.querySelectorAll('.listitem[data-guid]')) {
                const r = el.getBoundingClientRect();
                if (cy >= r.y - 2 && cy <= r.y + r.height + 2) return el;
            }
        }
        // the logical caret survives even when its element isn't rendered
        // (e.g. keyboard focus parked inside the video iframe) — read it
        // from the editor component
        try {
            const fc = window.g_focusedComponent;
            const lv = fc && fc.getLastActiveListView && fc.getLastActiveListView();
            const node = lv && lv.selection && lv.selection._caret && lv.selection._caret.pos
                && lv.selection._caret.pos.list_item && lv.selection._caret.pos.list_item.$node;
            if (node && node.isConnected && node.dataset && node.dataset.guid) return node;
        } catch (e) {}
        return document.querySelector('.editor-panel.focused-component .listitem-with-caret')
            || document.querySelector('.listitem-with-caret');
    }

    recGuid(record) {
        try { return record.guid || (record._getRow && record._getRow().guid) || null; } catch (e) { return null; }
    }

    lineText(el) {
        const d = el && el.querySelector('.line-div');
        return d ? d.textContent.replace(/\u00a0/g, ' ').trim() : '';
    }

    async insertTimestamp() {
        const caretLine = this.findCaretLine();
        const panelEl = (caretLine && caretLine.closest('.editor-panel')) || document;
        const caretY = caretLine ? caretLine.getBoundingClientRect().y : Infinity;

        // pick the player: nearest embed above the caret, else first on screen
        let best = null, bestY = -Infinity, first = null;
        for (const iframe of this.players.keys()) {
            if (!iframe.isConnected || !panelEl.contains(iframe)) continue;
            if (!first) first = iframe;
            const y = iframe.getBoundingClientRect().y;
            if (y < caretY && y > bestY) { bestY = y; best = iframe; }
        }
        const iframe = best || first;
        if (!iframe) { this.buffering = false; this.trace('no-player'); return; }

        // the record that owns the caret row (matters in the Journal, where
        // several day-records are stacked in one panel)
        let record = null;
        const lvEl = caretLine && caretLine.closest('.listview-items');
        if (lvEl && lvEl.dataset.guid && typeof data !== 'undefined') {
            record = data.getRecord(lvEl.dataset.guid);
        }
        if (!record) {
            const panel = this.ui.getActivePanel();
            record = panel && panel.getActiveRecord();
        }
        if (!record) { this.buffering = false; this.trace('no-record'); return; }

        const state = this.players.get(iframe);
        const secs = Math.floor(state.lastTime || 0);
        const label = this.formatTime(secs);
        const url = 'https://www.youtube.com/watch?v=' + state.videoId + '&t=' + secs + 's'
            + '&yt-ts=' + (++this.stampCounter); // unique: finds the rendered row

        // resolve the caret row in the data layer (its data-guid can lag
        // while a recent edit commits) — fall back to the last stamped row
        let items = await record.getLineItems();
        let anchor = null;
        if (caretLine) {
            for (let tries = 0; tries < 4 && !anchor; tries++) {
                anchor = items.find(i => i.guid === caretLine.dataset.guid) || null;
                if (!anchor) {
                    await new Promise(r => setTimeout(r, 120));
                    items = await record.getLineItems();
                }
            }
        }
        if (!anchor && this.lastItemGuid && this.lastRecordGuid === this.recGuid(record)) {
            anchor = items.find(i => i.guid === this.lastItemGuid) || null;
        }
        // caret on an empty row: insert ABOVE it (after its previous sibling)
        // so no stray empty line is left between the notes
        if (anchor && caretLine && this.lineText(caretLine) === '') {
            const idx = items.indexOf(anchor);
            for (let i = idx - 1; i >= 0; i--) {
                if (items[i].parent_guid === anchor.parent_guid) {
                    anchor = items[i];
                    break;
                }
            }
        }
        const parent = anchor && anchor.parent_guid
            ? (items.find(i => i.guid === anchor.parent_guid) || null)
            : null;
        const item = await record.createLineItem(parent, anchor, 'text');
        if (!item) { this.buffering = false; this.trace('create-row-failed'); return; }
        item.setSegments([
            { type: 'linkobj', text: { link: url, title: label } },
            { type: 'text', text: ' - ' },
        ]);
        this.lastItemGuid = item.guid;
        this.lastRecordGuid = this.recGuid(record);
        this.pending = { item, url, label, written: '', ghostEl: null };
        this.trace('inserted', { label });
        this.settlePending(this.pending, 0);
    }

    // Poll until the new row is on screen and shows the buffered text, then
    // hand the caret over (synthetic pointer click at end of line) and stop
    // intercepting keystrokes. Buffer writes happen only after a short
    // typing pause and only once the row has rendered — writing earlier or
    // on every keystroke gets writes lost or causes render storms.
    settlePending(p, attempt) {
        if (this.pending !== p) return;        // superseded or finalized
        const anchor = document.querySelector('a.lineitem-linkobj[href="' + p.url + '"]');
        const line = anchor && anchor.closest('.listitem');
        if (attempt > 150) {                   // ~15s: bail out, keep the text
            this.trace('settle-timeout', { buffered: this.buffer });
            this.finalizePending('timeout');
            if (line) this.clickLineEnd(line);
            return;
        }
        // write the buffered text after a short typing pause — durable even
        // before the row has rendered
        if (this.buffer !== p.written && Date.now() - this.bufferChangedAt > 200) {
            p.written = this.buffer;
            p.item.setSegments([
                { type: 'linkobj', text: { link: p.url, title: p.label } },
                { type: 'text', text: ' - ' + this.buffer },
            ]);
        }
        if (line) {
            const rendered = this.lineText(line);
            const expected = (p.label + ' - ' + this.buffer).replace(/\u00a0/g, ' ').trim();
            if (rendered === expected && this.buffer === p.written) {
                this.pending = null;
                this.buffering = false;
                this.buffer = '';
                if (p.ghostEl) p.ghostEl.remove();
                this.clickLineEnd(line);
                this.trace('caret-placed', { text: rendered });
                return;
            }
        }
        setTimeout(() => this.settlePending(p, attempt + 1), 100);
    }

    // Stop intercepting keys and make sure the buffered text ends up in the
    // row (used when the next stamp starts or the user clicks away). The
    // write must happen after the row has rendered, or it gets lost — a
    // detached poller takes care of it.
    finalizePending(why) {
        const p = this.pending;
        this.pending = null;
        this.buffering = false;
        const text = this.buffer;
        this.buffer = '';
        if (!p) return;
        if (p.ghostEl) p.ghostEl.remove();
        this.trace('finalize', { why, text });
        if (!text || text === p.written) return;
        // writes to SDK-created rows are durable even before they render
        p.item.setSegments([
            { type: 'linkobj', text: { link: p.url, title: p.label } },
            { type: 'text', text: ' - ' + text },
        ]);
    }

    // If the row takes noticeably long to render, show the swallowed text in
    // a small ghost near the caret so typing never feels lost.
    renderGhost() {
        const p = this.pending;
        if (!p || !this.buffering) return;
        if (!p.ghostEl) {
            p.ghostEl = document.createElement('div');
            p.ghostEl.style.cssText = 'position:fixed;z-index:99999;padding:3px 10px;'
                + 'background:#1c1c22;color:#cfcfd4;border:1px solid #34343e;border-radius:6px;'
                + 'font:12px/1.4 ui-monospace,Menlo,monospace;pointer-events:none;opacity:.95;';
            document.body.appendChild(p.ghostEl);
        }
        const caretEl = document.querySelector('.listview-caret-self');
        const r = caretEl && caretEl.getBoundingClientRect();
        if (r && r.height > 0) {
            p.ghostEl.style.left = Math.round(r.x + 8) + 'px';
            p.ghostEl.style.top = Math.round(r.y - 4) + 'px';
        } else {
            p.ghostEl.style.left = '50%';
            p.ghostEl.style.top = (window.innerHeight - 70) + 'px';
        }
        p.ghostEl.textContent = p.label + ' - ' + this.buffer + '▏';
    }

    // The editor rejects untrusted keyboard events, but caret placement
    // responds to synthetic PointerEvents — "click" just past the end of
    // the line.
    clickLineEnd(line) {
        line.scrollIntoView({ block: 'nearest' });
        const spans = line.querySelectorAll('.line-div a, .line-div span');
        const last = spans[spans.length - 1];
        if (!last) return;
        const r = last.getBoundingClientRect();
        const x = r.right + 4, y = r.top + r.height / 2;
        const target = document.elementFromPoint(x, y) || line;
        const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true,
                       button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', opts));
    }

    formatTime(secs) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        const ss = String(s).padStart(2, '0');
        return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
    }

    // ---- click-to-seek ---------------------------------------------------

    onClick(e) {
        if (e.metaKey || e.ctrlKey) return; // cmd+click keeps default open-in-browser
        const a = e.target.closest && e.target.closest('a.lineitem-linkobj');
        if (!a) return;
        const t = a.href.match(/[?&]t=(\d+)s?/);
        const v = a.href.match(/[?&]v=([\w-]+)/);
        if (!t || !v) return;
        // find a live embed for this video on the page
        let iframe = null;
        for (const [f, state] of this.players) {
            if (state.videoId === v[1] && f.isConnected) { iframe = f; break; }
        }
        if (!iframe) return; // no player on screen: let the link open normally
        e.preventDefault();
        e.stopPropagation();
        this.sendCommand(iframe, 'seekTo', [parseInt(t[1], 10), true]);
        this.sendCommand(iframe, 'playVideo');
    }
}
