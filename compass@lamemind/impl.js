// impl.js — compass@lamemind (Project Compass) — CODICE REALE (hot-reloadable)
// Caricato da extension.js (stub) via dynamic import cache-busted a ogni enable().
// NON esporta l'Extension: espone `CompassImpl {enable(ext), disable()}`.
// GNOME Shell 45+ (ES modules). Chiave sessione v1 = PTYXIS_PROFILE.
//
// È la RADICE del grafo dei moduli: ciclo di vita e stato dell'istanza, canale
// D-Bus in ingresso, badge/suono/notifica in uscita. I tre fratelli non lo
// importano mai — la dipendenza va in un verso solo:
//
//     impl.js  →  menu.js  →  {model.js, desktop.js}
//
//   model.js    il dato: registri, registro dei processi vivi, stato, rollup
//   desktop.js  le finestre e i processi: match, focus, coalescing, spawn, suono
//   menu.js     i widget: voce di menu, righe-sessione, bottoni surface
//
// Qui resta ciò che non può uscire: dove lo stato dell'istanza vive e dove i tre
// moduli vengono cablati fra loro.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// ── Cache-busting propagato ai moduli locali ─────────────────────────────────
//
// Lo stub importa questo file con una query monotonic (`?v=<N>`), che il module
// loader di GJS include nella chiave di cache → il file viene riletto da disco a
// ogni enable(). La query NON si eredita: un `import './menu.js'` statico da
// `impl.js?v=2` risolve a `menu.js` nudo, che resta in cache per tutta la vita
// del processo gnome-shell. Con quattro file, `compass reload` ne ricaricherebbe
// uno — e il regime che ne esce è peggiore di «l'edit non prende»: impl nuovo che
// parla con menu vecchio, un comportamento che non corrisponde a nessuna delle
// due versioni, senza nessun errore a segnalarlo.
//
// Rimedio: `import.meta.url` porta la query; ogni modulo la riestrae e la
// ri-appende ai propri import locali, fatti come import dinamici in top-level
// await. La promise dell'import dinamico risolve DOPO la TLA, quindi il
// `.then(mod => new mod.CompassImpl())` dello stub continua a ricevere un modulo
// già inizializzato e `extension.js` non va toccato. Stesso token = stesso URL =
// una sola istanza condivisa fra i due importatori.
//
// Le tre righe si ripetono in ogni file che importa un fratello, e la duplicazione
// non si può togliere con un helper: un `boot.js` che offrisse `mod(name)` andrebbe
// importato a sua volta, e sarebbe il primo a restare in cache.
const _Q = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const Model   = await import('./model.js'   + _Q);
const Desktop = await import('./desktop.js' + _Q);
const Menu    = await import('./menu.js'    + _Q);

// ── D-Bus interface ──────────────────────────────────────────────────────────

const DBUS_INTERFACE_XML = `
<node>
  <interface name="org.lamemind.Compass">
    <method name="SetState">
      <arg type="s" name="profile_id" direction="in"/>
      <arg type="s" name="state"      direction="in"/>
    </method>
    <!-- Aggiunto, non sostituito: i chiamanti sono script di shell che vivono
         fuori da questo repo e si aggiornano a mano. Cambiare la firma di
         SetState romperebbe ogni macchina non ancora allineata, e il guasto si
         presenterebbe come stato che smette di arrivare, non come errore. -->
    <method name="SetSessionState">
      <arg type="s" name="profile_id" direction="in"/>
      <arg type="s" name="session_id" direction="in"/>
      <arg type="s" name="state"      direction="in"/>
    </method>
    <method name="SetLabel">
      <arg type="s" name="profile_id" direction="in"/>
      <arg type="s" name="label"      direction="in"/>
    </method>
    <method name="Ping">
      <arg type="b" name="result" direction="out"/>
    </method>
  </interface>
</node>`;

// ── Implementazione servizio D-Bus ───────────────────────────────────────────

// Resta qui, accanto al suo XML e al suo unico istanziatore (CompassImpl.enable,
// poche righe più in basso). I nomi dei suoi metodi SONO il contratto D-Bus e
// vivono in due posti che devono restare allineati — il corpo della classe e
// DBUS_INTERFACE_XML: tenerli a venti righe di distanza è l'unico presidio che
// c'è. Non è GObject: `Gio.DBusExportedObject.wrapJSObject` la ispeziona per nome
// di metodo.
class CompassService {
    constructor(indicator) {
        this._indicator = indicator;
    }

    SetState(profileId, state) {
        this._indicator.setState(profileId, state);
    }

    SetSessionState(profileId, sessionId, state) {
        this._indicator.setSessionState(profileId, sessionId, state);
    }

    SetLabel(_profileId, _label) {
        // v1: no-op — SetLabel dinamica è Fase 6
    }

    Ping() {
        return new GLib.Variant('(b)', [true]);
    }
}

// ── Indicatore panel ─────────────────────────────────────────────────────────

// GTypeName unico per ogni load: il re-import (hot-reload) rieseguirebbe
// registerClass con lo stesso nome → "Type name already registered". Il suffisso
// monotonic rende ogni caricamento un GType distinto.
//
// È l'UNICA registerClass dell'estensione, e resta una anche dopo lo split:
// nessuno dei tre moduli importa `gi://GObject` (invariante verificabile a grep).
const CompassIndicator = GObject.registerClass(
{GTypeName: 'CompassIndicator_' + GLib.get_monotonic_time()},
class CompassIndicator extends PanelMenu.Button {

    _init(extensionObj) {
        super._init(0.0, 'Project Compass');
        this._ext       = extensionObj;
        this._sessions  = new Map(); // profileId → {state, seen}
        this._sessionStates = new Map(); // sessionId → {state} — canale per-sessione (T119)
        // I due canali di stato in un oggetto solo, passato alle funzioni di
        // model.js. Alias dei campi sopra, costruito una volta: nessun rename,
        // nessuna allocazione per chiamata, e la firma di chi lo riceve insegna
        // il modello (due chiavi, due semantiche di `end`) invece di nasconderlo
        // dietro argomenti posizionali.
        this._channels  = {profiles: this._sessions, sessions: this._sessionStates};
        this._registry  = [];
        this._loomRegistry = []; // registry dconf loom (T34) — cappelli + surface
        this._liveSessions = []; // registro ~/.claude/sessions filtrato sui vivi (T119)
        this._winMap             = null; // cache aggiornata a ogni buildMenu
        this._loomWins           = null; // cache window-map (project-level) progetti loom
        this._notificationSource = null;

        // ── Layout top-bar: [icona] [badge] ─────────────────────────────────
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        this._icon = new St.Label({
            text: '🖥',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._badge = new St.Label({
            text:        '',
            visible:     false,
            y_expand:    true,
            y_align:     Clutter.ActorAlign.CENTER,
            style_class: 'ws-badge',
        });

        box.add_child(this._icon);
        box.add_child(this._badge);
        this.add_child(box);

        // ── Bootstrap ────────────────────────────────────────────────────────
        // ORDINE VINCOLANTE: i registri prima del registro vivo, il registro vivo
        // prima del menu. Costruire il menu su un registro non ancora letto
        // produce una riga di progetto in meno, una volta sola, all'avvio.
        this._registry     = Model.loadLegacyRegistry(this._ext.path);
        this._loomRegistry = Model.loadLoomRegistry();
        this._liveSessions = Model.loadLiveSessions(this._channels);
        Menu.buildMenu(this);
        this._updateBadge();

        // Apertura menu → segna tutto visto + ricostruisce
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open) return;
            this._markAllSeen();
            this._updateBadge();
            this._loomRegistry = Model.loadLoomRegistry(); // niente watch dconf (no typelib) → refresh su apertura
            // Niente cache sul registro vivo: `status` cambia a ogni turno, e una
            // cache mostrerebbe idle su una sessione che sta lavorando — cioè il
            // difetto esatto che la vista esiste per non avere.
            this._liveSessions = Model.loadLiveSessions(this._channels);
            Menu.buildMenu(this);
            this._updateBadge();
        });
    }

    // ── Badge ────────────────────────────────────────────────────────────────

    _markAllSeen() {
        for (const s of this._sessions.values()) s.seen = true;
    }

    // Concatenazione delle emoji dei progetti in attesa (D3), non un conteggio:
    // un `2` non dice quali due, e aprire il menu per saperlo è esattamente il
    // click che il badge dovrebbe risparmiare. `Set` deduplica per progetto —
    // due surface dello stesso cappello (`claude` e `deck`) in attesa insieme
    // risolvono allo stesso `project.emoji` e contano una volta sola (T149).
    _updateBadge() {
        const emojis = new Set();
        for (const [profileId, s] of this._sessions) {
            if (s.seen || (s.state !== 'ask' && s.state !== 'done')) continue;
            const project = Model.projectByBinding(this._loomRegistry, profileId);
            if (project) emojis.add(project.emoji);
        }
        if (emojis.size > 0) {
            this._badge.text    = [...emojis].join('');
            this._badge.visible = true;
        } else {
            this._badge.text    = '';
            this._badge.visible = false;
        }
    }

    // ── setState / setSessionState (chiamati dal servizio D-Bus) ─────────────

    // Canale per-sessione. `end` qui NON significa più «riporta a idle» come sul
    // canale vecchio: significa «togli questa sessione», perché la mappa è keyed
    // sulla conversazione e non sul profilo del terminale. Se restasse la
    // semantica vecchia, una sessione chiusa resterebbe elencata a idle finché
    // dura la sessione di GNOME.
    //
    // `profileId` può arrivare vuoto: una sessione lanciata fuori da Ptyxis non
    // ha un profilo da annunciare, ma ha comunque un `sessionId`. Lo stato
    // per-sessione entra lo stesso; salta solo il canale vecchio, che senza
    // profilo non ha una chiave.
    setSessionState(profileId, sessionId, state) {
        if (sessionId) {
            if (state === 'end') this._sessionStates.delete(sessionId);
            else                 this._sessionStates.set(sessionId, {state});
        }
        // Il canale vecchio resta alimentato: tiene il badge, il suono, la
        // notifica di `ask` e il rollup delle surface non-claude.
        if (profileId) { this.setState(profileId, state); return; }
        this._refreshMenu();
    }

    // Ricostruzione a seguito di un annuncio D-Bus: il registro dei processi va
    // riletto qui, non solo all'apertura del menu, o col menu tenuto aperto le
    // righe resterebbero ferme sull'istantanea del momento in cui è stato aperto.
    // Costa la lettura di una manciata di file piccoli.
    _refreshMenu() {
        this._liveSessions = Model.loadLiveSessions(this._channels);
        Menu.buildMenu(this);
        this._updateBadge();
    }

    setState(profileId, state) {
        const project = this._registry.find(p => p.profile === profileId);
        // Il profilo è "conosciuto" se è nel registry vecchio (projects.json) OPPURE
        // se è un binding di un cappello loom (dconf). Così lo stato via D-Bus popola
        // _sessions anche per i progetti loom-only (non più in projects.json) → il
        // loro pallino segue lo stato reale. _sessions resta keyed su profile UUID.
        // Il cappello loom si tiene come OGGETTO, non come bool: oltre a decidere se
        // il profilo è conosciuto serve a notificare (displayName) e a risolvere la
        // finestra col matcher nuovo — vedi _showNotification.
        const loomProject = Model.projectByBinding(this._loomRegistry, profileId);
        if (!project && !loomProject) return; // sconosciuto a entrambi → ignora

        const prev      = this._sessions.get(profileId) ?? {state: 'idle', seen: true};
        const prevState = prev.state;

        if (state === 'end') {
            // sessione terminata: ripristina idle silenzioso
            prev.state = 'idle';
            prev.seen  = true;
            this._sessions.set(profileId, prev);
            this._refreshMenu();
            return;
        }

        prev.state = state;
        // stato notevole → da vedere; altri stati → visti (es. running)
        prev.seen  = !(state === 'ask' || state === 'done');
        this._sessions.set(profileId, prev);

        // Suono + notifica (solo su transizione, non su ripetizione). Vale per
        // ENTRAMBI i registry: prima era ristretta a projects.json, quindi un
        // progetto loom-only (registrato in dconf, uscito dal file legacy) su `ask`
        // non riceveva né bell né notifica — restava il solo pallino nel menu, che
        // però lo vedi solo se il menu lo apri.
        if (project || loomProject) {
            if (state === 'done' && prevState !== 'done') {
                Desktop.playSound('complete');
            } else if (state === 'ask' && prevState !== 'ask') {
                Desktop.playSound('bell');
                this._showNotification(project, loomProject);
            }
        }

        this._refreshMenu();
    }

    // ── Notifiche ─────────────────────────────────────────────────────────────

    _getOrCreateSource() {
        if (this._notificationSource) return this._notificationSource;

        try {
            // GNOME 45+ object-init API
            this._notificationSource = new MessageTray.Source({
                title:    'Project Compass',
                iconName: 'utilities-terminal',
            });
        } catch (_e) {
            // Fallback GNOME 44 string API
            this._notificationSource = new MessageTray.Source(
                'Project Compass', 'utilities-terminal'
            );
        }

        this._notificationSource.connect('destroy', () => {
            this._notificationSource = null;
        });
        Main.messageTray.add(this._notificationSource);
        return this._notificationSource;
    }

    _showNotification(project, loomProject) {
        const source      = this._getOrCreateSource();
        const displayName = loomProject?.label ?? project.display ?? project.label;

        let notification;
        try {
            // GNOME 45+ object-init API
            notification = new MessageTray.Notification({
                source,
                title: displayName,
                body:  'chiede conferma',
            });
        } catch (_e) {
            // Fallback GNOME 44 string API
            notification = new MessageTray.Notification(source, displayName, 'chiede conferma');
        }

        try {
            notification.addAction('Vai', () => {
                // `ts` catturato QUI, non dentro focusWindow: la chiusura del banner
                // può far arrivare l'activate fuori dal contesto dell'evento, e con un
                // timestamp corrente/0 la focus-stealing-prevention di Mutter lo scarta
                // (stesso vincolo del click sul bottone-nome, §Coalescing).
                const ts  = global.get_current_time();
                const win = Desktop.findNotificationWindow(
                    {
                        loomRegistry:   this._loomRegistry,
                        legacyRegistry: this._registry,
                        winMap:         this._winMap,
                    },
                    project, loomProject
                );
                // Log sul MISS: senza, un matcher che non aggancia più è indistinguibile
                // da un bottone che non fa niente — è esattamente così che il difetto
                // sopra è passato inosservato.
                if (!win) {
                    log(`[Compass] "Vai": nessuna finestra per ${displayName}`);
                    return;
                }
                Desktop.focusWindow(win, ts);
            });
        } catch (_e) {}

        source.addNotification(notification);
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    destroy() {
        if (this._notificationSource) {
            this._notificationSource.destroy();
            this._notificationSource = null;
        }
        super.destroy();
    }
});

// ── Impl entry point (istanziata dallo stub extension.js) ────────────────────

export class CompassImpl {

    enable(ext) {
        // Indicatore panel — `ext` = l'oggetto Extension (per ext.path, ecc.)
        this._indicator = new CompassIndicator(ext);
        Main.panel.addToStatusArea('project-compass', this._indicator);

        // Servizio D-Bus
        const service = new CompassService(this._indicator);
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE_XML, service);
        this._dbusImpl.export(Gio.DBus.session, '/org/lamemind/Compass');

        // Claim del nome sul bus di sessione
        this._ownNameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.lamemind.Compass',
            Gio.BusNameOwnerFlags.NONE,
            null, null, null
        );
    }

    disable() {
        if (this._ownNameId) {
            Gio.bus_unown_name(this._ownNameId);
            this._ownNameId = null;
        }
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
