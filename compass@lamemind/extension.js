// extension.js — compass@lamemind (Project Compass) — STUB LOADER
//
// Questo file resta in cache in GNOME Shell (il module loader non lo rilegge
// senza restart dello shell → su Wayland servirebbe relogin). Perciò è un guscio
// sottile: NON contiene la logica. A ogni enable() carica il codice reale da
// `impl.js` via dynamic import con query cache-busting (`?v=<monotonic>`), così
// il loader lo vede come URL nuovo e lo RILEGGE da disco.
//
// Workflow dev (dopo il primo relogin che installa questo stub):
//   1. edita impl.js
//   2. gnome-extensions disable compass@lamemind && gnome-extensions enable compass@lamemind
//   → codice ricaricato, nessun relogin.

import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class CompassExtension extends Extension {

    enable() {
        this._alive = true;
        // Query monotonic → forza il module loader a rileggere impl.js da disco.
        const uri = `file://${this.path}/impl.js?v=${GLib.get_monotonic_time()}`;
        import(uri)
            .then(mod => {
                if (!this._alive) return; // disable() arrivato prima che risolvesse
                this._impl = new mod.CompassImpl();
                this._impl.enable(this);
            })
            .catch(e => logError(e, '[Compass] stub: import impl.js'));
    }

    disable() {
        this._alive = false;
        if (this._impl) {
            this._impl.disable();
            this._impl = null;
        }
    }
}
