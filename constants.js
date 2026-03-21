// constants.js — safe to import from both extension.js and prefs.js
import GLib from 'gi://GLib';

export const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'taskman-utkarsh-brainstorm.github.io']);
export const DATA_FILE = GLib.build_filenamev([DATA_DIR, 'data.json']);
