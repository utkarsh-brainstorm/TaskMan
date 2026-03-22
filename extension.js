/**
 * TaskMan — GNOME Shell Extension
 * UUID: taskman@utkarsh-brainstorm.github.io
 *
 * Calendar-integrated task manager + reminder system.
 * Targets GNOME 48/49 — ESM architecture.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { DATA_DIR, DATA_FILE } from './constants.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dateKey(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function todayKey() {
    const n = GLib.DateTime.new_now_local();
    return dateKey(n.get_year(), n.get_month(), n.get_day_of_month());
}
function isPastDate(key) { return key < todayKey(); }
function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
function firstDayOfWeek(yr, mo) { return new Date(yr, mo - 1, 1).getDay(); }

const DAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

// ─── DataManager ─────────────────────────────────────────────────────────────
//
// All I/O is async.  The only blocking call is GLib.mkdir_with_parents (which
// is a single fast kernel syscall with no user data involved).
// save() is debounced: multiple rapid mutations within 50 ms collapse into one
// async write, preventing concurrent write races.

class DataManager {
    constructor(cancellable) {
        this._cancellable = cancellable;
        this._data = {};
        this._dirty = false;
        this._saveTimeout = null;   // debounce ID
    }

    // Async load — calls callback() when done (or on error).
    loadAsync(callback) {
        const file = Gio.File.new_for_path(DATA_FILE);
        file.load_contents_async(this._cancellable, (_file, res) => {
            try {
                const [, bytes] = _file.load_contents_finish(res);
                try {
                    this._data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
                } catch (jsonErr) {
                    // Corrupted JSON — back up and reset gracefully.
                    console.error('[TaskMan] data.json corrupt — resetting', jsonErr);
                    try {
                        Gio.File.new_for_path(DATA_FILE).copy(
                            Gio.File.new_for_path(`${DATA_FILE}.bak`),
                            Gio.FileCopyFlags.OVERWRITE, null, null
                        );
                    } catch (_) { /* best-effort backup */ }
                    this._data = {};
                }
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
                    !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    console.error('[TaskMan] Failed to load data.json', e);
                }
                this._data = {};
            }
            callback?.();
        });
    }

    // 50 ms debounce — collapses rapid mutations into one write.
    save() {
        this._dirty = true;
        if (this._saveTimeout !== null) {
            GLib.source_remove(this._saveTimeout);
        }
        this._saveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._saveTimeout = null;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Flush immediately; called on disable() to ensure nothing is lost.
    flushPending() {
        if (this._saveTimeout !== null) {
            GLib.source_remove(this._saveTimeout);
            this._saveTimeout = null;
        }
        this._flush();
    }

    _flush() {
        if (!this._dirty) return;
        this._dirty = false;
        try {
            const bytes = new GLib.Bytes(
                new TextEncoder().encode(JSON.stringify(this._data, null, 2))
            );
            Gio.File.new_for_path(DATA_FILE).replace_contents_bytes_async(
                bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                this._cancellable,
                (_file, res) => {
                    try { _file.replace_contents_finish(res); }
                    catch (e) {
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            console.error('[TaskMan] Async save failed', e);
                    }
                }
            );
        } catch (e) {
            console.error('[TaskMan] Failed to start async save', e);
        }
    }

    // ── Tasks ──────────────────────────────────────────────────────────────

    getTasksForDate(key) { return this._data[key] ? [...this._data[key]] : []; }

    addTask(key, text) {
        if (!this._data[key]) this._data[key] = [];
        this._data[key].push({ text, done: false });
        this.save();
    }
    toggleTask(key, idx) {
        if (!this._data[key]?.[idx]) return;
        this._data[key][idx].done = !this._data[key][idx].done;
        this.save();
    }
    deleteTask(key, idx) {
        if (!this._data[key]) return;
        this._data[key].splice(idx, 1);
        if (this._data[key].length === 0) delete this._data[key];
        this.save();
    }

    // ── Reminders ──────────────────────────────────────────────────────────

    _rem() {
        if (!this._data._reminders) this._data._reminders = {};
        return this._data._reminders;
    }

    getRemindersForDate(key) {
        const r = this._data._reminders;
        return (r && r[key]) ? [...r[key]] : [];
    }

    getAllPendingReminders() {
        const r = this._data._reminders;
        if (!r) return [];
        const out = [];
        for (const [date, list] of Object.entries(r))
            for (const rem of list)
                if (!rem.dismissed) out.push({ ...rem, date });
        return out;
    }

    addReminder(key, text, time) {
        const r = this._rem();
        if (!r[key]) r[key] = [];
        r[key].push({
            id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text, time, dismissed: false, snoozedUntil: null, firedAt: null,
        });
        this.save();
    }

    // Persist that the reminder fired — prevents re-firing after restart.
    markReminderFired(key, id) {
        const rem = this._data._reminders?.[key]?.find(r => r.id === id);
        if (rem) { rem.firedAt = new Date().toISOString(); this.save(); }
    }

    dismissReminder(key, id) {
        const rem = this._data._reminders?.[key]?.find(r => r.id === id);
        if (rem) { rem.dismissed = true; this.save(); }
    }

    snoozeReminder(key, id, minutes) {
        const rem = this._data._reminders?.[key]?.find(r => r.id === id);
        if (rem) {
            rem.snoozedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
            rem.firedAt = null;  // Clear so it can fire again after snooze expires.
            this.save();
        }
    }
}

// ─── ReminderDaemon ──────────────────────────────────────────────────────────
//
// Uses a single shared MessageTray.Source (created in enable(), destroyed in
// disable()).  Fired state is persisted as firedAt on each reminder object in
// data.json — survives shell restarts / extension toggle.

class ReminderDaemon {
    constructor(dataManager, onChanged) {
        this._dm = dataManager;
        this._onChanged = onChanged;
        this._timeout = null;
        this._source = null;
    }

    enable() {
        try {
            this._source = new MessageTray.Source({
                title: 'TaskMan', iconName: 'alarm-symbolic',
            });
            Main.messageTray.add(this._source);
        } catch (e) {
            console.error('[TaskMan] Could not create notification source', e);
        }

        this._check();
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._check();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeout !== null) {
            GLib.source_remove(this._timeout);
            this._timeout = null;
        }
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
    }

    _check() {
        const now = new Date();
        for (const rem of this._dm.getAllPendingReminders()) {
            // Skip if already fired recently — persisted across restarts.
            if (rem.firedAt) {
                const firedTime = new Date(rem.firedAt);
                if (now - firedTime < 5 * 60_000) continue;
            }
            // Respect active snooze.
            if (rem.snoozedUntil && now < new Date(rem.snoozedUntil)) continue;

            const diff = now - new Date(`${rem.date}T${rem.time}:00`);
            if (diff >= 0 && diff < 45_000) {
                this._dm.markReminderFired(rem.date, rem.id);
                this._notify(rem);
            }
        }
    }

    _notify(rem) {
        // Play system alarm sound (non-critical).
        try {
            global.get_sound_player().play_from_theme('alarm-clock-elapsed', 'TaskMan Reminder', null);
        } catch (_) { }

        if (!this._source) {
            Main.notify(`⏰ Reminder: ${rem.text}`, rem.time);
            return;
        }

        try {
            const notification = new MessageTray.Notification({
                source: this._source, title: `⏰  ${rem.time} — Reminder`,
                body: rem.text, isTransient: false, urgency: MessageTray.Urgency.HIGH,
            });
            notification.addAction('Snooze 5 min', () => {
                this._dm.snoozeReminder(rem.date, rem.id, 5);
                this._onChanged();
            });
            notification.addAction('Dismiss', () => {
                this._dm.dismissReminder(rem.date, rem.id);
                this._onChanged();
            });
            // GNOME 48+ uses addNotification.
            this._source.addNotification(notification);
        } catch (e) {
            console.error('[TaskMan] Notification failed', e);
            Main.notify(`⏰ Reminder: ${rem.text}`, rem.time);
        }
    }
}

// ─── CalendarWidget ──────────────────────────────────────────────────────────

const CalendarWidget = GObject.registerClass({
    Signals: { 'day-selected': { param_types: [GObject.TYPE_STRING] } },
}, class CalendarWidget extends St.BoxLayout {

    _init(dataManager) {
        super._init({ orientation: Clutter.Orientation.VERTICAL, style_class: 'taskman-calendar-box', reactive: true });
        this._dm = dataManager;
        const now = GLib.DateTime.new_now_local();
        this._viewYear = now.get_year();
        this._viewMonth = now.get_month();
        this._selectedKey = todayKey();
        this._build();
    }

    _build() {
        this.destroy_all_children();

        // Header
        const header = new St.BoxLayout({ style_class: 'taskman-cal-header', reactive: true });
        const prevBtn = new St.Button({ label: '‹', style_class: 'taskman-cal-nav-btn', reactive: true });
        prevBtn.connect('clicked', () => this._shiftMonth(-1));
        const nextBtn = new St.Button({ label: '›', style_class: 'taskman-cal-nav-btn', reactive: true });
        nextBtn.connect('clicked', () => this._shiftMonth(1));
        header.add_child(prevBtn);
        header.add_child(new St.Label({
            text: `${MONTH_NAMES[this._viewMonth - 1]} ${this._viewYear}`,
            style_class: 'taskman-cal-month-label', x_expand: true, x_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(nextBtn);
        this.add_child(header);

        // DOW row
        const dowRow = new St.BoxLayout({ reactive: false });
        for (const d of DAYS_SHORT)
            dowRow.add_child(new St.Label({ text: d, style_class: 'taskman-cal-dow', x_align: Clutter.ActorAlign.CENTER }));
        this.add_child(dowRow);

        // Day grid
        const grid = new St.Widget({ layout_manager: new Clutter.GridLayout({ orientation: Clutter.Orientation.HORIZONTAL }), reactive: true });
        const gl = grid.layout_manager;
        const yr = this._viewYear, mo = this._viewMonth;
        const today = todayKey(), startDow = firstDayOfWeek(yr, mo);
        const totalDays = daysInMonth(yr, mo);
        const prevDays = daysInMonth(mo === 1 ? yr - 1 : yr, mo === 1 ? 12 : mo - 1);

        let col = startDow, row = 0;
        for (let i = 0; i < startDow; i++) {
            const pm = mo === 1 ? 12 : mo - 1, py = mo === 1 ? yr - 1 : yr;
            gl.attach(this._makeCell(py, pm, prevDays - startDow + 1 + i, true), i, 0, 1, 1);
        }
        for (let d = 1; d <= totalDays; d++) {
            gl.attach(this._makeCell(yr, mo, d, false, dateKey(yr, mo, d), today), col, row, 1, 1);
            if (++col > 6) { col = 0; row++; }
        }
        let nd = 1;
        while (col !== 0) {
            const nm = mo === 12 ? 1 : mo + 1, ny = mo === 12 ? yr + 1 : yr;
            gl.attach(this._makeCell(ny, nm, nd++, true), col, row, 1, 1);
            if (++col > 6) { col = 0; row++; }
        }
        this.add_child(grid);
    }

    _makeCell(yr, mo, day, otherMonth, key = null, today = null) {
        const btn = new St.Button({
            reactive: !otherMonth, can_focus: !otherMonth,
            style_class: 'taskman-cal-day', x_align: Clutter.ActorAlign.CENTER,
        });
        const container = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true });
        const lbl = new St.Label({
            text: String(day), style_class: 'taskman-cal-day-label',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });
        if (otherMonth) lbl.add_style_class_name('taskman-cal-day-other-month');
        container.add_child(lbl);
        btn.set_child(container);
        btn._container = container;
        btn._label = lbl;

        if (otherMonth) { btn.add_style_class_name('taskman-cal-day-other-month'); return btn; }
        if (key === today) { btn.add_style_class_name('taskman-cal-day-today'); lbl.add_style_class_name('taskman-cal-day-today'); }
        if (key === this._selectedKey) btn.add_style_class_name('taskman-cal-day-selected');

        this._applyDayBackground(btn, key);

        if (key) {
            btn.connect('clicked', () => {
                this._selectedKey = key;
                this._build();
                this.emit('day-selected', key);
            });
        }
        return btn;
    }

    _hslToRgbValues(h, s, l) {
        s /= 100; l /= 100;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;
        let r, g, b;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }
    _perceivedLuminance(r, g, b) { return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }

    _applyDayBackground(btn, key) {
        const lbl = btn._label;

        const tasks = this._dm.getTasksForDate(key);
        const total = tasks.length;

        if (total === 0) {
            btn.set_style('border-radius: 6px;');
            if (lbl) lbl.set_style('');   // Let CSS/theme control color.
            return;
        }

        const done = tasks.filter(t => t.done).length;
        const sat = Math.min(total / 10, 1.0) * 100;
        const gV = this._hslToRgbValues(142, sat, 45);
        const rV = this._hslToRgbValues(0, sat, 55);
        const green = `rgb(${gV[0]},${gV[1]},${gV[2]})`;
        const red = `rgb(${rV[0]},${rV[1]},${rV[2]})`;

        const CELL_H = 35;
        const greenH = Math.round((done / total) * CELL_H);
        const redH = CELL_H - greenH;

        // Black/white contrast text against the coloured background.
        if (lbl) {
            const avgLum = (redH * this._perceivedLuminance(...rV) + greenH * this._perceivedLuminance(...gV)) / CELL_H;
            lbl.set_style(`color: ${avgLum > 0.5 ? '#000000' : '#ffffff'};`);
        }

        if (greenH === 0) {
            // NOTE: These hardcoded inset colors encode semantic data (completion %) which
            // varies dynamically, so they intentionally bypass static CSS and theme awareness.
            btn.set_style(`background: ${red}; border-radius: 6px; padding: 0;`);
        } else if (redH === 0) {
            btn.set_style(`background: ${green}; border-radius: 6px; padding: 0;`);
        } else {
            btn.set_style(`background: ${red}; border-radius: 6px; padding: 0;`);
            const overlay = new St.Widget({
                x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.END,
                style: `background: ${green}; min-height: ${greenH}px; max-height: ${greenH}px; border-radius: 3px 3px 6px 6px;`,
            });
            btn._container.insert_child_at_index(overlay, 0);
        }
    }

    _shiftMonth(delta) {
        this._viewMonth += delta;
        if (this._viewMonth > 12) { this._viewMonth = 1; this._viewYear++; }
        if (this._viewMonth < 1) { this._viewMonth = 12; this._viewYear--; }
        this._build();
    }

    refresh() { this._build(); }
    get selectedKey() { return this._selectedKey; }
});

// ─── TaskListWidget ───────────────────────────────────────────────────────────
//
// All GLib timeout IDs are tracked in this._timeouts (a Set) and cleared in
// destroy() so no callback fires against a destroyed actor.

class TaskListWidget {
    constructor(dataManager, onChanged) {
        this._dm = dataManager;
        this._onChanged = onChanged;
        this._currentKey = todayKey();
        this._entryMode = 'task';
        this._animating = false;
        this._timeouts = new Set();

        this.actor = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'taskman-tasklist-container' });

        this._dateLabel = new St.Label({ text: '', style_class: 'taskman-date-label' });
        this._pastBanner = new St.Label({ text: '🔒 Past day — read only', style_class: 'taskman-past-banner', visible: false });
        this.actor.add_child(this._dateLabel);
        this.actor.add_child(this._pastBanner);

        this._scroll = new St.ScrollView({ style_class: 'taskman-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, x_expand: true });
        this._listBox = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        this._scroll.set_child(this._listBox);
        this.actor.add_child(this._scroll);

        // ─ Entry row ─
        this._entryBox = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'taskman-entry-box', x_expand: true });
        this._entry = new St.Entry({ hint_text: 'New task — press Enter or choose ⏰…', style_class: 'taskman-entry', can_focus: true, x_expand: true });
        this._entry.clutter_text.connect('activate', () => this._handleEntryActivate());

        this._taskBtn = new St.Button({ label: '📝', style_class: 'taskman-mode-btn taskman-mode-btn-active', can_focus: true, reactive: true });
        this._taskBtn.connect('clicked', () => this._setEntryMode('task'));
        this._remBtn = new St.Button({ label: '⏰', style_class: 'taskman-mode-btn', can_focus: true, reactive: true });
        this._remBtn.connect('clicked', () => this._setEntryMode('reminder'));
        this._entryBox.add_child(this._entry);
        this._entryBox.add_child(this._taskBtn);
        this._entryBox.add_child(this._remBtn);
        this.actor.add_child(this._entryBox);

        // ─ Time row (reminder mode, vertical stack) ─
        this._timeRow = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'taskman-time-row', x_expand: true, visible: false });

        // Quick-preset buttons (+15m / +30m / +1h / +2h)
        const presetRow = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'taskman-preset-row', x_expand: true });
        for (const { label, mins } of [{ label: '+15m', mins: 15 }, { label: '+30m', mins: 30 }, { label: '+1h', mins: 60 }, { label: '+2h', mins: 120 }]) {
            const btn = new St.Button({ label, style_class: 'taskman-preset-btn', can_focus: true, reactive: true, x_expand: true });
            btn.connect('clicked', () => this._addReminderRelative(mins));
            presetRow.add_child(btn);
        }
        this._timeRow.add_child(presetRow);

        // Custom exact-time entry
        const customRow = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'taskman-custom-row', x_expand: true });
        const customLbl = new St.Label({ text: 'Custom:', style_class: 'taskman-time-label', y_align: Clutter.ActorAlign.CENTER });
        this._timeEntry = new St.Entry({ hint_text: 'HH:MM', style_class: 'taskman-time-entry', can_focus: true, x_expand: true });
        this._timeEntry.clutter_text.connect('activate', () => this._confirmReminder());
        const confirmBtn = new St.Button({ label: '✓', style_class: 'taskman-confirm-btn', can_focus: true, reactive: true });
        confirmBtn.connect('clicked', () => this._confirmReminder());
        customRow.add_child(customLbl);
        customRow.add_child(this._timeEntry);
        customRow.add_child(confirmBtn);
        this._timeRow.add_child(customRow);
        this.actor.add_child(this._timeRow);

        this.showDate(this._currentKey);
    }

    // Tracked timeout helper — always cleared on destroy().
    _addTimeout(ms, fn) {
        let id;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    destroy() {
        for (const id of this._timeouts) GLib.source_remove(id);
        this._timeouts.clear();
        this.actor.destroy();
    }

    // ── Mode ────────────────────────────────────────────────────────────────

    _setEntryMode(mode) {
        this._entryMode = mode;
        const isRem = mode === 'reminder';
        this._taskBtn.set_style_class_name(isRem ? 'taskman-mode-btn' : 'taskman-mode-btn taskman-mode-btn-active');
        this._remBtn.set_style_class_name(isRem ? 'taskman-mode-btn taskman-mode-btn-active' : 'taskman-mode-btn');
        this._timeRow.visible = isRem;
        // Always give keyboard users a defined focus target.
        if (isRem)
            this._timeEntry.grab_key_focus();
        else
            this._entry.grab_key_focus();
    }

    // ── Reminder helpers ─────────────────────────────────────────────────────

    _addReminderRelative(minutes) {
        const text = this._entry.get_text().trim();
        if (text.length === 0) { this._entry.grab_key_focus(); return; }
        const t = new Date(Date.now() + minutes * 60_000);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        this._dm.addReminder(this._currentKey, text, `${hh}:${mm}`);
        this._entry.set_text('');
        this._setEntryMode('task');
        this._renderList();
        this._onChanged();
    }

    _handleEntryActivate() {
        const text = this._entry.get_text().trim();
        if (text.length === 0) return;
        if (this._entryMode === 'task') {
            this._dm.addTask(this._currentKey, text);
            this._entry.set_text('');
            this._renderList();
            this._onChanged();
        } else {
            const t = this._timeEntry.get_text().trim();
            if (t === '') this._timeEntry.grab_key_focus();
            else this._confirmReminder();
        }
    }

    _confirmReminder() {
        const text = this._entry.get_text().trim();
        const time = this._timeEntry.get_text().trim();
        if (text.length === 0 || !this._isValidTime(time)) {
            this._timeEntry.set_style('border-color: rgba(239,68,68,0.8);');
            this._addTimeout(800, () => this._timeEntry.set_style(''));
            return;
        }
        this._dm.addReminder(this._currentKey, text, time);
        this._entry.set_text('');
        this._timeEntry.set_text('');
        this._setEntryMode('task');
        this._renderList();
        this._onChanged();
    }

    _isValidTime(str) {
        if (!/^\d{1,2}:\d{2}$/.test(str)) return false;
        const [h, m] = str.split(':').map(Number);
        return h >= 0 && h <= 23 && m >= 0 && m <= 59;
    }

    // ── Date switching ───────────────────────────────────────────────────────

    showDate(key) {
        this._currentKey = key;
        const past = isPastDate(key);
        const [yr, mo, dy] = key.split('-').map(Number);
        this._dateLabel.set_text(new Date(yr, mo - 1, dy).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
        this._pastBanner.visible = past;
        this._entryBox.visible = !past;
        this._timeRow.visible = !past && this._entryMode === 'reminder';
        this._renderList();
    }

    // ── List rendering ───────────────────────────────────────────────────────

    _renderList() {
        if (this._animating) return;
        this._listBox.destroy_all_children();

        const tasks = this._dm.getTasksForDate(this._currentKey);
        const reminders = this._dm.getRemindersForDate(this._currentKey).filter(r => !r.dismissed);
        const past = isPastDate(this._currentKey);

        const sorted = tasks.map((t, i) => ({ task: t, idx: i })).sort((a, b) => {
            if (a.task.done === b.task.done) return 0;
            return a.task.done ? 1 : -1;
        });

        if (sorted.length === 0 && reminders.length === 0) {
            this._listBox.add_child(new St.Label({
                text: past ? 'No tasks recorded for this day.' : 'No tasks yet. Add one below!',
                style_class: 'taskman-empty-label', x_align: Clutter.ActorAlign.CENTER, x_expand: true,
            }));
        }

        for (const { task, idx } of sorted) this._listBox.add_child(this._makeTaskRow(task, idx, past));

        if (reminders.length > 0) {
            this._listBox.add_child(new St.Label({ text: '── Reminders ──', style_class: 'taskman-reminders-header', x_align: Clutter.ActorAlign.CENTER, x_expand: true }));
            for (const rem of reminders) this._listBox.add_child(this._makeReminderRow(rem, past));
        }
    }

    _makeTaskRow(task, idx, past) {
        const row = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'taskman-task-row', x_expand: true, reactive: !past });
        const checkBtn = new St.Button({ style_class: task.done ? 'taskman-checkbox taskman-checkbox-done' : 'taskman-checkbox', label: task.done ? '✓' : '', reactive: !past, can_focus: !past });

        if (!past) {
            checkBtn.connect('clicked', () => {
                this._dm.toggleTask(this._currentKey, idx);
                const nowDone = !task.done;
                if (nowDone) {
                    this._animating = true;
                    // NOTE: Dynamic animated state.
                    row.set_style('background: rgba(34,197,94,0.22); border-radius: 4px;');
                    this._addTimeout(120, () => {
                        row.ease({
                            opacity: 0, duration: 380, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                            onComplete: () => { this._animating = false; this._renderList(); this._onChanged(); },
                        });
                    });
                } else {
                    this._renderList();
                    this._onChanged();
                }
            });
        }

        let lblClass = 'taskman-task-label';
        if (past) lblClass += ' taskman-task-label-past';
        if (task.done) lblClass += ' taskman-task-label-done';

        const lbl = new St.Label({ text: task.text, style_class: lblClass, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        lbl.clutter_text.line_wrap = true;
        lbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        lbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        row.add_child(checkBtn);
        row.add_child(lbl);

        if (!past) {
            const delBtn = new St.Button({ label: '✕', style_class: 'taskman-delete-btn', reactive: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER });
            delBtn.connect('clicked', () => { this._dm.deleteTask(this._currentKey, idx); this._renderList(); this._onChanged(); });
            row.add_child(delBtn);
        }
        return row;
    }

    _makeReminderRow(rem, past) {
        const row = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'taskman-reminder-row', x_expand: true });
        const bell = new St.Label({ text: '⏰', style_class: 'taskman-reminder-icon', y_align: Clutter.ActorAlign.CENTER });
        const textLbl = new St.Label({ text: rem.text, style_class: 'taskman-reminder-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        textLbl.clutter_text.line_wrap = true;
        textLbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        textLbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const chip = new St.Label({ text: rem.time, style_class: 'taskman-reminder-chip', y_align: Clutter.ActorAlign.CENTER });
        row.add_child(bell);
        row.add_child(textLbl);
        row.add_child(chip);
        if (!past) {
            const delBtn = new St.Button({ label: '✕', style_class: 'taskman-delete-btn', reactive: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER });
            delBtn.connect('clicked', () => { this._dm.dismissReminder(this._currentKey, rem.id); this._renderList(); this._onChanged(); });
            row.add_child(delBtn);
        }
        return row;
    }

    refresh() { this._renderList(); }
    focusEntry() { if (!isPastDate(this._currentKey)) this._entry.grab_key_focus(); }
}

// ─── Panel Indicator ──────────────────────────────────────────────────────────

const TaskManIndicator = GObject.registerClass(
    class TaskManIndicator extends PanelMenu.Button {
        _init(dataManager) {
            super._init(0.5, 'TaskMan', false);
            this._dm = dataManager;
            this._openMenuIdleId = null;  // Tracked so it can be cancelled if menu closes first.

            this.add_child(new St.Icon({ icon_name: 'view-list-symbolic', style_class: 'system-status-icon' }));

            const mainItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false, style_class: 'taskman-popup-content' });
            const vbox = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });

            this._calendar = new CalendarWidget(this._dm);
            vbox.add_child(this._calendar);
            vbox.add_child(new St.Widget({ style: 'height: 1px; margin: 4px 8px;', style_class: 'taskman-separator' }));

            this._taskList = new TaskListWidget(this._dm, () => this._calendar.refresh());
            vbox.add_child(this._taskList.actor);
            mainItem.add_child(vbox);
            this.menu.addMenuItem(mainItem);

            this._calendar.connect('day-selected', (_cal, key) => this._taskList.showDate(key));

            this.menu.connect('open-state-changed', (_menu, isOpen) => {
                if (isOpen) {
                    // Track idle ID so we can cancel if menu closes before it fires.
                    this._openMenuIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._openMenuIdleId = null;
                        this._taskList.showDate(this._calendar.selectedKey);
                        this._taskList.focusEntry();
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    // Menu closed — cancel the pending idle if still waiting.
                    if (this._openMenuIdleId !== null) {
                        GLib.source_remove(this._openMenuIdleId);
                        this._openMenuIdleId = null;
                    }
                }
            });
        }
    });

// ─── Extension Class ──────────────────────────────────────────────────────────

export default class TaskManExtension {
    constructor(metadata) { this._metadata = metadata; }

    enable() {
        // Create data directory (GLib mkdir is a fast single syscall — no user data read).
        GLib.mkdir_with_parents(DATA_DIR, 0o755);

        this._cancellable = new Gio.Cancellable();
        this._dm = new DataManager(this._cancellable);

        // Load data asynchronously, then display the UI.
        this._dm.loadAsync(() => {
            if (this._cancellable?.is_cancelled()) return;
            this._startExtension();
        });
    }

    _startExtension() {
        this._reminderDaemon = new ReminderDaemon(this._dm, () => {
            this._indicator?._taskList?.refresh();
        });
        this._reminderDaemon.enable();

        this._indicator = new TaskManIndicator(this._dm);
        Main.panel.addToStatusArea('taskman', this._indicator);
    }

    disable() {
        // Flush any debounced save that is still pending immediately.
        this._dm?.flushPending();
        this._dm = null;

        // Cancel any in-flight async I/O *after* the flush has initiated.
        this._cancellable?.cancel();
        this._cancellable = null;

        if (this._reminderDaemon) {
            this._reminderDaemon.disable();
            this._reminderDaemon = null;
        }
        if (this._indicator) {
            // Destroy TaskListWidget first — flushes all tracked timeouts.
            this._indicator._taskList?.destroy();
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
