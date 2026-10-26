// impl.js — compass@lamemind (Project Compass) — CODICE REALE (hot-reloadable)
// Caricato da extension.js (stub) via dynamic import cache-busted a ogni enable().
// NON esporta l'Extension: espone `CompassImpl {enable(ext), disable()}`.
// GNOME Shell 45+ (ES modules). Chiave di progetto = PTYXIS_PROFILE, che porta
// l'`id` del progetto (vedi Model.projectByStateKey).
//
// È la RADICE del grafo dei moduli: ciclo di vita e stato dell'istanza, canale
// D-Bus in ingresso, badge/suono/notifica in uscita, focus di una conversazione.
// I cinque fratelli non lo importano mai — la dipendenza va in un verso solo:
//
//     impl.js  →  {menu.js, dialog.js}  →  {model.js, desktop.js}
//     impl.js  →  usage.js
//
//   model.js    il dato: registri, registro dei processi vivi, stato, rollup
//   desktop.js  le finestre e i processi: match, focus, salto di tab,
//               coalescing, spawn, suono
//   menu.js     i widget del popup: voce di menu, righe-sessione, bottoni surface
//   dialog.js   il modale sulla conversazione in focus, e la sua risoluzione
//   usage.js    il consumo dell'account in top bar: livelli, widget, mock
//
// `prefs.js` (la finestra delle impostazioni) NON è nel grafo: la carica un
// altro processo, il servizio `org.gnome.Shell.Extensions`, e importa il solo
// model.js. Con lo shell parla attraverso lo schema GSettings, non per import.
// Fuori dal grafo anche `ptyxis-tab.js`: è un processo `gjs` a sé, che
// desktop.js lancia e non importa.
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
// del processo gnome-shell. Con sei file, `compass reload` ne ricaricherebbe
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
const Usage   = await import('./usage.js'   + _Q);

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
//
// La costante vive in model.js: la legge anche prefs.js, che gira in un altro
// processo e non può importare questo file.
const SETTINGS_SCHEMA_ID = Model.SETTINGS_SCHEMA_ID;

// ── Esiti del focus che non portano alla tab ─────────────────────────────────
//
// Testi di coda@lamemind, da cui il focus della tab è trascritto. `tab` ed
// `esatta` non hanno testo: arrivano solo nel journal. Gli altri arrivano anche
// a schermo, perché chi resta sulla tab sbagliata senza saperlo non rilegge il
// journal.
const FOCUS_NOTICE = {
    ambigua: name => `Più tab si chiamano «${name}»: resto sulla finestra, la tab scegli tu`,
    assente: name => `Nessuna tab si chiama «${name}»: mostro la finestra del progetto`,
    fallita: name => `Il salto alla tab «${name}» non è arrivato`,
    errore:  name => `Tab di «${name}» non raggiungibile: l'helper di accessibilità non ha risposto`,
    nessuna: name => `Nessuna finestra Ptyxis per «${name}»`,
    // Il `sessionId` non è più nel registro vivo: non c'è un nome da dire.
    sconosciuta: () => 'Conversazione non più viva: mostro la finestra del progetto',
};

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
    <!-- Porta davanti la tab della conversazione e risponde con l'esito
         (esatta, tab, ambigua, assente, fallita, errore, nessuna, sconosciuta).
         Lo chiama il deck, che su Wayland non può portare davanti un'altra
         finestra: compass gira dentro Mutter e sì. -->
    <method name="FocusSession">
      <arg type="s" name="session_id" direction="in"/>
      <arg type="s" name="esito"      direction="out"/>
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

    // Risponde DOPO il salto (~0,3 s): GJS manda la risposta al bus quando la
    // Promise ritornata risolve, e un errore D-Bus se rigetta. Il rigetto qui
    // non arriva: un'eccezione si logga e diventa l'esito `errore`, così il
    // chiamante legge sempre una parola dello stesso vocabolario.
    async FocusSession(sessionId) {
        let outcome;
        try {
            outcome = await this._indicator.focusSession(sessionId, 'dbus');
        } catch (e) {
            logError(e, '[Compass] FocusSession');
            outcome = 'errore';
        }
        return new GLib.Variant('(s)', [outcome]);
    }
}

// ── Indicatore panel ─────────────────────────────────────────────────────────

// GTypeName unico per ogni load: il re-import (hot-reload) rieseguirebbe
// registerClass con lo stesso nome → "Type name already registered". Il suffisso
// monotonic rende ogni caricamento un GType distinto.
//
// È l'UNICA registerClass dell'estensione, e resta una anche dopo lo split:
// nessuno dei quattro moduli importa il sistema di tipi. L'invariante si verifica
// con `grep -l '^import GObject' *.js`, che deve nominare solo questo file —
// ancorato a inizio riga sulla forma dell'import, perché un grep sul nome nudo
// aggancia anche la prosa dei commenti che l'invariante la dichiarano.
const CompassIndicator = GObject.registerClass(
{GTypeName: 'CompassIndicator_' + GLib.get_monotonic_time()},
class CompassIndicator extends PanelMenu.Button {

    _init(extensionObj, settings) {
        super._init(0.0, 'Project Compass');
        this._ext       = extensionObj;
        // Le preferenze dell'estensione (Gio.Settings), di proprietà di
        // CompassImpl: l'indicatore le legge e ne ascolta i cambi, non le crea.
        this._settings  = settings;
        this._sessions  = new Map(); // chiave di stato (id progetto) → {state, seen}
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
        this._loomWins           = null; // cache window-map (project-level) progetti loom
        this._scroll             = null; // St.ScrollView del popup — montata una volta (Menu.mountScroll)
        this._section            = null; // PopupMenuSection dentro la scroll: qui buildMenu costruisce
        this._footer             = null; // coda fissa «Impostazioni», fuori dalla scroll (Menu.mountFooter)
        // Rami espandibili del giro corrente, `<projectId>:<pinned|launch>` →
        // `{section, arrow}`. Ricostruita da `buildMenu` insieme ai widget che
        // indicizza.
        this._subs               = new Map();
        // L'UNICO ramo aperto, come chiave — non come widget: `buildMenu`
        // parte da `removeAll()` e gira a ogni annuncio di stato, quindi ciò che
        // deve sopravvivere a una ricostruzione non può vivere in un attore.
        this._openSub            = null;
        this._notificationSource = null;
        // Falso da `destroy()` in poi: un focus che aspetta l'helper della tab
        // (~0,3 s) può risvegliarsi dopo un disable, e non deve toccare un
        // indicatore distrutto.
        this._alive              = true;

        // ── Layout top-bar: [icona] [badge] [consumo account] ───────────────
        //
        // Il consumo sta in coda e non fra icona e badge: il badge è contestuale
        // (compare solo su ask/done) e va tenuto incollato all'icona, o a ogni
        // comparsa sposterebbe di lato le due percentuali, che invece sono
        // sempre presenti e devono stare ferme.
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

        // Consumo dell'account (5h e settimanale). Il poller si tiene da sé il
        // proprio timer e la propria richiesta in volo: qui resta solo la
        // maniglia per fermarlo.
        this._usage = Usage.buildUsage();
        this._usagePoll = Usage.startPolling(this._usage);

        box.add_child(this._icon);
        box.add_child(this._badge);
        box.add_child(this._usage.actor);
        this.add_child(box);

        // ── Bootstrap ────────────────────────────────────────────────────────
        // ORDINE VINCOLANTE: i registri prima del registro vivo, il registro vivo
        // prima del menu. Costruire il menu su un registro non ancora letto
        // produce una riga di progetto in meno, una volta sola, all'avvio.
        this._registry     = Model.loadLegacyRegistry(this._ext.path);
        this._loomRegistry = Model.loadLoomRegistry();
        this._liveSessions = Model.loadLiveSessions(this._channels);
        // La zona scorrevole prima del primo menu, e mai più: `buildMenu` ci
        // costruisce dentro e la dà per montata (`this._section`). La coda
        // «Impostazioni» subito dopo, e anche lei una volta sola: `buildMenu`
        // ne misura l'altezza per il tetto della zona scorrevole.
        Menu.mountScroll(this);
        Menu.mountFooter(this);

        // Progetti nascosti cambiati dalla finestra delle impostazioni → il
        // menu si ricostruisce subito, senza reload dell'estensione. Il registry
        // non ha un watch (si rilegge all'apertura del menu), questa chiave sì.
        //
        // Connesso PRIMA del primo `buildMenu`, che legge la chiave: GSettings
        // emette `changed::<chiave>` solo per le chiavi lette almeno una volta
        // con un handler già connesso. Connesso dopo, il primo cambio andrebbe
        // perso fino al prossimo giro di menu.
        this._hiddenChangedId = this._settings.connect(
            `changed::${Model.HIDDEN_PROJECTS_KEY}`, () => this._refreshMenu());

        Menu.buildMenu(this);
        this._updateBadge();

        // Apertura menu → segna tutto visto + ricostruisce
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open) {
                // Il popup che si chiude dimentica quale sotto-menu era aperto:
                // la memoria di `_openSub` esiste per sopravvivere alle
                // RICOSTRUZIONI del menu (che avvengono a popup aperto, a ogni
                // annuncio di stato), non alla chiusura — riaprire il menu
                // ricostruisce tutto da zero, e trovare un ramo già espanso da
                // una sessione precedente sarebbe uno stato che l'utente non
                // ricorda di aver lasciato.
                this._openSub = null;
                return;
            }
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
    // click che il badge dovrebbe risparmiare. `Set` deduplica per emoji: due
    // progetti con la stessa emoji in attesa insieme contano una volta sola.
    _updateBadge() {
        const emojis = new Set();
        for (const [profileId, s] of this._sessions) {
            if (s.seen || (s.state !== 'ask' && s.state !== 'done')) continue;
            const project = Model.projectByStateKey(this._loomRegistry, profileId);
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
        // non è mai arrivato. Per la stessa ragione scende anche il `sessionId`:
        // il «Vai» della notifica porta alla tab di QUELLA conversazione.
        if (profileId) {
            this.setState(profileId, state, this._priorityMuted(profileId, sessionId, state), sessionId);
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
        const project = Model.projectByStateKey(this._loomRegistry, profileId);
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
    //
    // `sessionId` segue lo stesso schema: assente sul canale vecchio, e lì il
    // «Vai» della notifica porta alla finestra del progetto invece che alla tab.
    setState(profileId, state, muteSound = false, sessionId = null) {
        const project = this._registry.find(p => p.profile === profileId);
        // La chiave è "conosciuta" se è il profilo UUID di un progetto del registry
        // vecchio (projects.json) OPPURE l'`id` di un cappello loom (dconf). I due
        // spazi non si toccano: un UUID Ptyxis non è mai un id di progetto.
        // _sessions resta keyed sulla chiave così come arriva.
        // Il cappello loom si tiene come OGGETTO, non come bool: oltre a decidere se
        // la chiave è conosciuta serve a notificare (displayName) e a risolvere la
        // finestra col matcher nuovo — vedi _showNotification.
        const loomProject = Model.projectByStateKey(this._loomRegistry, profileId);
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
                this._showNotification(project, loomProject, sessionId);
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

    // Una notifica della sorgente di compass, non ancora consegnata: chi la
    // chiede può aggiungerle un'azione prima di `addNotification`.
    //
    // `transient` = sparisce dal centro notifiche dopo il banner. Lo vuole un
    // avviso che riguarda un clic appena fatto; non lo vuole «chiede
    // conferma», che porta un «Vai» da usare anche minuti dopo.
    _newNotification(title, body, transient = false) {
        const source = this._getOrCreateSource();
        let notification;
        try {
            // GNOME 45+ object-init API
            notification = new MessageTray.Notification({source, title, body, isTransient: transient});
        } catch (_e) {
            // Fallback GNOME 44 string API
            notification = new MessageTray.Notification(source, title, body);
            notification.setTransient?.(transient);
        }
        return notification;
    }

    // «Vai» porta alla tab della conversazione che chiede, quando il
    // `sessionId` è arrivato (`SetSessionState`); sul canale vecchio
    // (`SetState`) porta alla finestra del progetto, come prima della tab.
    _showNotification(project, loomProject, sessionId = null) {
        const source       = this._getOrCreateSource();
        const displayName  = loomProject?.label ?? project.display ?? project.label;
        const notification = this._newNotification(displayName, 'chiede conferma');

        try {
            notification.addAction('Vai', () => {
                if (sessionId) {
                    this.focusSession(sessionId, 'vai', loomProject)
                        .catch(e => logError(e, '[Compass] "Vai"'));
                    return;
                }
                // `ts` catturato QUI, non dentro focusWindow: la chiusura del banner
                // può far arrivare l'activate fuori dal contesto dell'evento, e con un
                // timestamp corrente/0 la focus-stealing-prevention di Mutter lo scarta
                // (stesso vincolo del click sul bottone-nome, §Coalescing).
                const ts  = global.get_current_time();
                const win = Desktop.findNotificationWindow(this._loomRegistry, loomProject);
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

    // ── Focus di una conversazione (T183) ────────────────────────────────────

    // Porta davanti la tab della conversazione, poi la sua finestra. Trascritto
    // da coda@lamemind, dove è collaudato nella sessione reale.
    //
    // Prima la tab, poi la finestra: l'helper cambia tab dove la trova, in
    // qualunque finestra, e dice quale finestra la tiene; compass porta davanti
    // quella. Senza la finestra dall'helper si ripiega su
    // `Desktop.windowForSession`: la finestra che ha già la conversazione
    // davanti, o quella del progetto, come il bottone-nome.
    //
    // `convo` = `{name, pid}` come li porta il registro vivo; `project` = il
    // cappello del ripiego, o null. `origin` = l'ingresso che chiede il focus
    // (`riga`, `pinnata`, `vai`, `dbus`, `collaudo`).
    //
    // Una riga di journal per focus, `[Compass] focus <esito> <origine>`:
    // l'esito dell'helper, `errore` se l'helper non ha risposto, `nessuna` se
    // non c'è nessuna finestra da mostrare. L'origine attribuisce un esito al
    // suo ingresso, e le righe del collaudo si escludono per parola. Tutto ciò
    // che non è `tab` o `esatta` arriva anche a schermo (`FOCUS_NOTICE`), tranne
    // su `dbus`: lì l'esito viaggia nella risposta e lo mostra il chiamante, e
    // un banner di compass sarebbe lo stesso avviso due volte.
    //
    // `extraStep` è l'opzione di collaudo dell'oracolo, vedi `collaudoProbe`.
    _focus(convo, project, origin, opts = {}) {
        this._focusTab(convo, project, origin, opts).catch(e => logError(e, '[Compass] focus'));
    }

    // → Promise dell'esito, per chi deve rispondere con quello (`FocusSession`).
    async _focusTab(convo, project, origin, {extraStep = false, ts = global.get_current_time()} = {}) {
        // `ts` nel default dei parametri: si valuta alla chiamata, cioè dentro
        // l'evento del clic e PRIMA dell'attesa dell'helper. Dopo l'attesa
        // l'evento è finito, e Mutter scarta un activate senza il timestamp di
        // un input valido (focus-stealing-prevention).
        //
        // Due nomi perché il CLI rinomina una sessione in collisione, ma il
        // titolo della tab resta il nome chiesto con `--name`.
        const requested = convo.pid ? Model.procRequestedName(convo.pid) : null;
        const names = [...new Set([convo.name, requested].map(n => (n ?? '').trim()).filter(Boolean))];
        this.menu.close();

        let {outcome, title} = await Desktop.switchPtyxisTab(names, {extraStep});
        if (!this._alive) return outcome;
        let win = title ? await Desktop.windowWithTitle(title) : null;
        if (!this._alive) return outcome;
        // La tab è davanti ma la sua finestra non si trova: chi ha cliccato non
        // arriva alla conversazione.
        if (!win && (outcome === 'tab' || outcome === 'esatta')) outcome = 'fallita';
        win ??= Desktop.windowForSession(names, project, this._loomRegistry);
        if (!win) outcome = 'nessuna';

        log(`[Compass] focus ${outcome} ${origin}`);
        if (win) Desktop.focusWindow(win, ts);
        if (origin !== 'dbus')
            this._focusNotice(outcome, project, convo.name || names[0] || `pid ${convo.pid}`);
        return outcome;
    }

    // Il focus di una conversazione nota solo per `sessionId`: il «Vai» della
    // notifica e il metodo D-Bus `FocusSession`. → Promise dell'esito.
    //
    // Il registro vivo si rilegge qui: fra l'annuncio e l'azione possono passare
    // minuti (un banner resta nel centro notifiche finché non lo chiudi, il deck
    // chiama dal suo ultimo tick), e la conversazione può essere finita nel
    // frattempo. Fuori dal registro l'esito è `sconosciuta` e l'helper non
    // parte: non è un fallimento del salto, e chi chiama deve poter dire
    // «riprendila» invece di «non c'è la tab». Il «Vai» ripiega allora sulla
    // finestra del progetto, come prima della tab.
    //
    // `project` = il cappello già noto al chiamante (la notifica lo porta);
    // senza, si risale dal `cwd` della sessione.
    async focusSession(sessionId, origin, project = null) {
        // Prima di ogni attesa, come in `_focusTab`.
        const ts = global.get_current_time();
        const session = Model.loadLiveSessions(this._channels).find(s => s.sessionId === sessionId);
        project ??= session ? Model.projectForSession(this._loomRegistry, session) : null;
        if (session) return this._focusTab(session, project, origin, {ts});

        log(`[Compass] focus sconosciuta ${origin}`);
        if (origin === 'dbus') return 'sconosciuta';
        const win = Desktop.findNotificationWindow(this._loomRegistry, project);
        if (win) Desktop.focusWindow(win, ts);
        this._focusNotice('sconosciuta', project, sessionId);
        return 'sconosciuta';
    }

    // Banner della sorgente di compass, la stessa di «chiede conferma»: la
    // stessa estensione resta una voce sola nel centro notifiche.
    _focusNotice(outcome, project, name) {
        const notice = FOCUS_NOTICE[outcome];
        if (!notice) return;
        const notification = this._newNotification(project?.label ?? 'Project Compass', notice(name), true);
        this._getOrCreateSource().addNotification(notification);
    }

    // Banner di una pinnata che non si è riaperta (`Desktop.launchResume`):
    // transient come `_focusNotice`, perché riguarda il clic appena fatto.
    _resumeNotice(project, reason) {
        const notification = this._newNotification(
            project?.label ?? 'Project Compass', `ripresa non riuscita — ${reason}`, true);
        this._getOrCreateSource().addNotification(notification);
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

        // Il writer viaggia come argomento perché il modale non deve sapere dove
        // finisce la conferma — e perché è il writer di T158, non uno nuovo: pin
        // e priorità li scrivono già i toggle del popup con la stessa funzione,
        // sullo stesso file e con gli stessi nomi di campo. Un secondo percorso
        // di scrittura significherebbe due formati da tenere allineati su un file
        // che leggono tre repo.
        Dialog.openSessionDialog(
            this._loomRegistry, this._liveSessions, this._channels,
            Model.writeSessionMarks
        );
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    destroy() {
        this._alive = false;
        // Il Gio.Settings sopravvive all'indicatore (lo tiene CompassImpl fino
        // al disable): senza disconnect, un cambio dalla finestra delle
        // impostazioni ricostruirebbe il menu di un attore già distrutto.
        if (this._hiddenChangedId) {
            this._settings.disconnect(this._hiddenChangedId);
            this._hiddenChangedId = null;
        }
        // Prima di distruggere gli attori: il timer del poller e la sua
        // richiesta HTTP in volo sopravvivono entrambi all'attore e al
        // `compass reload`, e al giro dopo scriverebbero su label già morte —
        // più un timer in più a ogni ricarica, che nessuno ferma fino al relogin.
        if (this._usagePoll) {
            this._usagePoll.stop();
            this._usagePoll = null;
        }
        if (this._notificationSource) {
            this._notificationSource.destroy();
            this._notificationSource = null;
        }
        super.destroy();
    }
});

// ── Collaudo del focus nella sessione reale ──────────────────────────────────
//
// Trascritto da coda@lamemind. La nested shell non ha finestre Ptyxis, e nella
// sessione reale l'ambiente di gnome-shell non si cambia: il collaudo del focus
// passa da un file. Se a enable() esiste `$XDG_RUNTIME_DIR/compass-collaudo.json`,
// compass lo legge, lo cancella e chiama `_focus` una volta per voce, a
// `COLLAUDO_STEP_S` secondi l'una dall'altra, con una conversazione finta che
// porta il nome e, se detto, il progetto (id del registry) — senza progetto un
// nome che nessuna tab porta non ha finestra di ripiego, e l'esito è `nessuna`
// invece di `assente`:
//
//   [{"nome": "sonda-C"}, {"nome": "sonda-B", "salto_in_piu": true},
//    {"nome": "sonda-Z", "progetto": "loom-works"}]
//
// Il ciclo: scrivi il file, `gnome-extensions disable compass@lamemind &&
// gnome-extensions enable compass@lamemind`, leggi `[Compass]` nel journal. Le
// righe di focus portano l'origine `collaudo`, e si escludono per parola dalla
// misura d'uso. Il file cancellato alla lettura non riparte al login dopo.
const COLLAUDO_FILE   = 'compass-collaudo.json';
const COLLAUDO_STEP_S = 3;

function collaudoProbe(indicator) {
    const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), COLLAUDO_FILE]);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return [];
    let steps = [];
    try {
        const [, bytes] = GLib.file_get_contents(path);
        steps = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        logError(e, `[Compass][collaudo] ${path}`);
    }
    GLib.unlink(path);
    if (!Array.isArray(steps)) return [];

    // Solo i timer ancora in attesa: `source_remove` su un timer già scattato
    // scrive un critical nel journal, e `disable` li toglie tutti.
    const pending = new Set();
    steps.forEach((step, i) => {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, (i + 1) * COLLAUDO_STEP_S, () => {
            pending.delete(id);
            collaudoStep(indicator, step, i, steps.length);
            return GLib.SOURCE_REMOVE;
        });
        pending.add(id);
    });
    return pending;
}

function collaudoStep(indicator, step, i, total) {
    const extraStep = Boolean(step.salto_in_piu);
    const project = indicator._loomRegistry.find(p => p.id === step.progetto) ?? null;
    log(`[Compass][collaudo] passo ${i + 1}/${total} nome=«${step.nome}» ` +
        `progetto=${project?.id ?? '-'} salto_in_piu=${extraStep}`);
    indicator._focus({name: step.nome, pid: 0}, project, 'collaudo', {extraStep});
    // Cosa è davanti dopo il focus: l'evidenza che la finestra è arrivata.
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        log(`[Compass][collaudo] davanti «${global.display.focus_window?.get_title() ?? ''}»`);
        return GLib.SOURCE_REMOVE;
    });
}

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
        this._indicator = new CompassIndicator(ext, this._settings);
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

        this._probeIds = collaudoProbe(this._indicator);
    }

    disable() {
        for (const id of this._probeIds ?? []) GLib.source_remove(id);
        this._probeIds = [];

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
