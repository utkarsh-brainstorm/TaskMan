/**
 * TaskMan — Preferences
 * UUID: taskman@utkarsh-brainstorm.github.io
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

// Import the single source of truth for the data path.
// Both extension.js and prefs.js use DATA_FILE so they can never drift.
import { DATA_FILE } from './constants.js';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TaskManPrefs extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        window.set_default_size(480, 420);

        const page = new Adw.PreferencesPage({ title: 'TaskMan', icon_name: 'view-list-symbolic' });
        window.add(page);

        // ─── About ────────────────────────────────────────────────────────
        const aboutGroup = new Adw.PreferencesGroup({ title: 'About' });
        page.add(aboutGroup);

        aboutGroup.add(new Adw.ActionRow({ title: 'Version', subtitle: String(this.metadata.version ?? '1') }));
        aboutGroup.add(new Adw.ActionRow({ title: 'Extension ID', subtitle: this.metadata['uuid'] ?? 'taskman@utkarsh-brainstorm.github.io' }));

        // ─── Data ─────────────────────────────────────────────────────────
        const dataGroup = new Adw.PreferencesGroup({
            title: 'Data',
            description: 'Tasks and reminders are stored in a plain JSON file you can back up or edit.',
        });
        page.add(dataGroup);

        const pathRow = new Adw.ActionRow({ title: 'Data file', subtitle: DATA_FILE, activatable: false });

        const openBtn = new Gtk.Button({ icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Open containing folder' });
        openBtn.connect('clicked', () => {
            const parent = Gio.File.new_for_path(DATA_FILE).get_parent();
            if (parent) Gio.AppInfo.launch_default_for_uri(parent.get_uri(), null);
        });
        pathRow.add_suffix(openBtn);
        dataGroup.add(pathRow);

        // ─── Danger Zone ──────────────────────────────────────────────────
        const dangerGroup = new Adw.PreferencesGroup({ title: 'Danger Zone' });
        page.add(dangerGroup);

        const clearRow = new Adw.ActionRow({
            title: 'Clear all task data',
            subtitle: 'Permanently deletes data.json. Cannot be undone.',
        });
        const clearBtn = new Gtk.Button({ label: 'Clear All', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'] });
        clearBtn.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: 'Clear All Tasks?',
                body: 'Permanently deletes all task and reminder data. This action cannot be undone.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('delete', 'Delete');
            dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.connect('response', (_dialog, response) => {
                if (response === 'delete') {
                    try {
                        const file = Gio.File.new_for_path(DATA_FILE);
                        if (file.query_exists(null)) file.delete(null);
                    } catch (e) {
                        console.error('[TaskMan] Failed to delete data.json', e);
                    }
                }
            });
            dialog.present(window);
        });
        clearRow.add_suffix(clearBtn);
        dangerGroup.add(clearRow);
    }
}
