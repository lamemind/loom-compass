// impl.js — compass@lamemind (Project Compass) — CODICE REALE (hot-reloadable)
// Caricato da extension.js (stub) via dynamic import cache-busted a ogni enable().
// NON esporta l'Extension: espone `CompassImpl {enable(ext), disable()}`.
// GNOME Shell 45+ (ES modules). Chiave sessione v1 = PTYXIS_PROFILE.
//
// È la RADICE del grafo dei moduli: ciclo di vita e stato dell'istanza, canale
// D-Bus in ingresso, badge/suono/notifica in uscita. I quattro fratelli non lo
// importano mai — la dipendenza va in un verso solo:
//
//     impl.js  →  {menu.js, dialog.js}  →  {model.js, desktop.js}
//
//   model.js    il dato: registri, registro dei processi vivi, stato, rollup
//   desktop.js  le finestre e i processi: match, focus, coalescing, spawn, suono
//   menu.js     i widget del popup: voce di menu, righe-sessione, bottoni surface
//   dialog.js   il modale sulla conversazione in focus, e la sua risoluzione
//
// Qui resta ciò che non può uscire: dove lo stato dell'istanza vive e dove i
// moduli vengono cablati fra loro.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

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
const Dialog  = await import('./dialog.js'  + _Q);

// ── Scorciatoia globale ──────────────────────────────────────────────────────

// Nome dell'azione, e insieme il nome della chiave nello schema GSettings
// (`schemas/org.gnome.shell.extensions.compass.gschema.xml`): `add_keybinding`
// li vuole uguali — legge la combinazione dalla chiave che porta questo nome.
// Una sola costante perché le due cose non possono divergere senza che la
// registrazione fallisca in silenzio (`add_keybinding` ritorna NONE e non
// solleva).
const KEYBINDING_OPEN_DIALOG = 'open-session-dialog';

// Id dello schema, passato a `getSettings()` ESPLICITAMENTE e non lasciato
// derivare da `metadata['settings-schema']`.
//
// Misurato: `metadata.json` lo legge l'ExtensionManager quando CARICA
// l'estensione, e il nostro hot-reload non lo rilegge — lo stub re-importa
// `impl.js`, non rifà il caricamento dell'estensione. Un campo aggiunto a
// metadata.json resta quindi invisibile fino al relogin, e `getSettings()` senza
// argomento fallisce con «Expected type string for argument 'schema_id' but got
// type undefined» su un file che sul disco è corretto. Il campo resta comunque
// in metadata.json, dove lo cerca chi installa da zero.
const SETTINGS_SCHEMA_ID = 'org.gnome.shell.extensions.compass';

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
        //
        // La decisione sul suono si prende QUI e viaggia giù come parametro,
        // perché questo è l'unico punto che ha il `sessionId` in mano: `setState`
        // riceve il profilo del cappello, e con quello non può sapere QUALE delle
        // N conversazioni del progetto ha cambiato stato. Leggere la marca dove il
        // suono avviene sarebbe impossibile senza cambiare la firma — lì il dato
        // non è mai arrivato.
        if (profileId) {
            this.setState(profileId, state, this._priorityMuted(profileId, sessionId, state));
            return;
        }
        this._refreshMenu();
    }

    // Il suono di PROGETTO va taciuto? Sì solo quando la conversazione che ha
    // cambiato stato è marcata prioritaria: lì il ding lo emette l'hook del
    // plugin, per-conversazione, e quello di compass sarebbe il secondo.
    //
    // Tace il SOLO suono. Il banner di `ask` di compass appare sempre, marca o no:
    // porta il bottone «Vai» che focussa la finestra, e `notify-send` non può
    // offrirlo — nessun processo resta in ascolto del click dopo che l'hook è
    // uscito. Su un `ask` di conversazione marcata i banner sono quindi due per
    // decisione: quello di compass dice dove andare, quello dell'hook quale
    // conversazione è.
    //
    // Il sidecar si legge solo sugli stati che suonano: `running` e `end` non
    // producono audio, e un file aperto per loro sarebbe I/O a vuoto a ogni turno.
    _priorityMuted(profileId, sessionId, state) {
        if (!sessionId) return false;
        if (state !== 'done' && state !== 'ask') return false;
        const project = Model.projectByBinding(this._loomRegistry, profileId);
        if (!project) return false;
        return Model.loadSessionMarks(project.dir).get(sessionId)?.priority === true;
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

    // `muteSound` arriva solo dal canale per-sessione, che sa a quale
    // conversazione appartiene lo stato. Sul canale vecchio (`SetState`, senza
    // `sessionId`) il parametro resta assente e quindi falso: la soppressione non
    // è decidibile, e il suono parte come ha sempre fatto. È una degradazione
    // muta, non un errore — chi ha un bridge più vecchio del plugin sente due
    // ding sulla conversazione marcata, non zero.
    setState(profileId, state, muteSound = false) {
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
                if (!muteSound) Desktop.playSound('complete');
            } else if (state === 'ask' && prevState !== 'ask') {
                if (!muteSound) Desktop.playSound('bell');
                // Fuori dal mute per decisione: il banner con «Vai» appare sempre.
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

    // ── Modale sulla conversazione in focus (T159) ───────────────────────────

    // Chiamata dalla scorciatoia globale, registrata da CompassImpl.
    //
    // Rilegge il registro dei processi vivi da qui e non riusa `_liveSessions`:
    // quel campo è aggiornato all'apertura del menu e a ogni annuncio D-Bus, e
    // la scorciatoia è il solo ingresso che non passa da nessuno dei due — senza
    // la rilettura mostrerebbe l'istantanea di un evento arbitrariamente
    // vecchio, incluse conversazioni già chiuse.
    openSessionDialog() {
        this._loomRegistry = Model.loadLoomRegistry();
        this._liveSessions = Model.loadLiveSessions(this._channels);

        const target = Dialog.focusedSessions(this._loomRegistry, this._liveSessions);

        // Log dell'esito della risoluzione, a ogni pressione: è il collaudo di
        // una catena che non ha nessun altro modo di dichiarare cosa ha visto —
        // zero candidate e una candidata sbagliata si presentano entrambe come
        // un modale che non fa quello che aspetti.
        log(`[Compass] focus → title=${JSON.stringify(target.title)} ` +
            `project=${target.project?.id ?? '(nessuno)'} ` +
            `candidate=${target.sessions.length} ` +
            `[${target.sessions.map(s => `${s.pid}:${JSON.stringify(s.name)}`).join(' ')}]`);
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
        // PRIMA di costruire qualunque cosa: `getSettings()` SOLLEVA se il
        // compilato dello schema non è in `schemas/`, e un throw più in basso
        // lascerebbe l'estensione a metà — indicatore in top bar, nessuna
        // scorciatoia — cioè un regime funzionante per metà che nessun messaggio
        // spiega. Qui invece non nasce niente e lo stub logga l'errore.
        this._settings = ext.getSettings(SETTINGS_SCHEMA_ID);

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

        // Scorciatoia globale → modale sulla conversazione in focus (T159).
        //
        // La combinazione vive nella chiave GSettings, non qui: il codice nomina
        // l'azione, lo schema dice con che tasto si preme. Ne segue che
        // cambiarla non richiede di toccare il codice — basta scrivere la chiave
        // con `dconf write`.
        //
        // ActionMode.NORMAL e nient'altro: il bersaglio del modale è la finestra
        // in focus, e in overview o a schermo bloccato non ce n'è una che voglia
        // dire qualcosa.
        //
        // Il ritorno di `add_keybinding` NON è un booleano ma la `KeyBindingAction`
        // assegnata, e `Meta.KeyBindingAction.NONE` significa registrazione
        // fallita — combinazione già presa da un'altra azione, o chiave assente
        // dallo schema. Va detto nel log: senza, il sintomo è «premo e non
        // succede niente», indistinguibile da una callback rotta.
        const action = Main.wm.addKeybinding(
            KEYBINDING_OPEN_DIALOG,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => this._indicator?.openSessionDialog()
        );
        if (action === Meta.KeyBindingAction.NONE) {
            log(`[Compass] scorciatoia "${KEYBINDING_OPEN_DIALOG}" non registrata: ` +
                `${JSON.stringify(this._settings.get_strv(KEYBINDING_OPEN_DIALOG))} è già presa o la chiave manca`);
            this._keybindingOwned = false;
        } else {
            this._keybindingOwned = true;
        }
    }

    disable() {
        // Prima di tutto il resto: la combinazione è l'unica cosa che l'estensione
        // lascia REGISTRATA NEL COMPOSITORE, quindi l'unica che può sopravvivere
        // al disable e restare appesa a una callback su un oggetto distrutto.
        // Revocata solo se la registrazione era riuscita: `removeKeybinding` su un
        // nome mai registrato riporterebbe `allowKeybinding(nome, NONE)` su
        // un'azione di qualcun altro.
        if (this._keybindingOwned) {
            Main.wm.removeKeybinding(KEYBINDING_OPEN_DIALOG);
            this._keybindingOwned = false;
        }
        this._settings = null;

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
