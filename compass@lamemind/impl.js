// impl.js — compass@lamemind (Project Compass) — CODICE REALE (hot-reloadable)
// Caricato da extension.js (stub) via dynamic import cache-busted a ogni enable().
// NON esporta l'Extension: espone `CompassImpl {enable(ext), disable()}`.
// GNOME Shell 45+ (ES modules). Chiave di progetto = PTYXIS_PROFILE, che porta
// l'`id` del progetto (vedi Model.projectByStateKey).
//
// È la RADICE del grafo dei moduli: ciclo di vita e stato dell'istanza, canale
// di stato, badge e suono, focus di una conversazione e di un progetto. I
// fratelli non lo importano mai — la dipendenza va in un verso solo:
//
//     impl.js  →  {menu.js, dialog.js}  →  {model.js, desktop.js}
//     menu.js  →  rows.js  →  {model.js, desktop.js}
//     impl.js  →  notify.js  →  desktop.js
//     impl.js  →  {usage.js, focus-wait.js, dbus.js, collaudo.js}
//
//   model.js    il dato: registri, registro dei processi vivi, stato, rollup
//   desktop.js  le finestre e i processi: match, focus, salto di tab,
//               coalescing, spawn, suono
//   menu.js     il popup e la voce di progetto: zona scorrevole, coda
//               «Impostazioni», riga-cappello, rami espandibili
//   rows.js     le righe delle conversazioni sotto il cappello, vive e pinnate
//   dialog.js   il modale sulla conversazione in focus, e la sua risoluzione
//   notify.js   i banner in uscita, dalla sorgente unica di compass
//   usage.js    il consumo dell'account in top bar: livelli, widget, mock
//   focus-wait.js  l'attesa del focus di un progetto (`AwaitProjectFocus`):
//               le attese aperte, la scadenza, l'ascolto del focus
//   dbus.js     il contratto D-Bus in ingresso: l'XML e il servizio che
//               inoltra ogni metodo all'indicatore
//   collaudo.js il collaudo del focus nella sessione reale, da un file
//
// `prefs.js` (la finestra delle impostazioni) NON è nel grafo: la carica un
// altro processo, il servizio `org.gnome.Shell.Extensions`, e importa il solo
// model.js. Con lo shell parla attraverso lo schema GSettings, non per import.
// Fuori dal grafo anche `ptyxis-tab.js`: è un processo `gjs` a sé, che
// desktop.js lancia e non importa.
//
// Qui resta ciò che non può uscire: dove lo stato dell'istanza vive e dove i
// moduli vengono cablati fra loro. I flussi di focus restano qui per questo:
// riassegnano il registry dell'istanza, guardano se l'indicatore è ancora vivo,
// e legano fra loro attese, timer, bus e banner.
//
// Un metodo D-Bus nuovo scrive in tre file: l'XML e il metodo del servizio in
// dbus.js, il corpo sull'indicatore qui, l'eventuale banner in notify.js.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

// ── Cache-busting propagato ai moduli locali ─────────────────────────────────
//
// Lo stub importa questo file con una query monotonic (`?v=<N>`), che il module
// loader di GJS include nella chiave di cache → il file viene riletto da disco a
// ogni enable(). La query NON si eredita: un `import './menu.js'` statico da
// `impl.js?v=2` risolve a `menu.js` nudo, che resta in cache per tutta la vita
// del processo gnome-shell. Con undici file, `compass reload` ne ricaricherebbe
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
const FocusWait = await import('./focus-wait.js' + _Q);
const Notify  = await import('./notify.js'  + _Q);
const Dbus    = await import('./dbus.js'    + _Q);
const Collaudo = await import('./collaudo.js' + _Q);

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

// ── Indicatore panel ─────────────────────────────────────────────────────────

// GTypeName unico per ogni load: il re-import (hot-reload) rieseguirebbe
// registerClass con lo stesso nome → "Type name already registered". Il suffisso
// monotonic rende ogni caricamento un GType distinto.
//
// È l'UNICA registerClass dell'estensione, e resta una anche dopo lo split:
// nessuno dei fratelli importa il sistema di tipi. L'invariante si verifica
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
        this._headlessSessions = []; // T206 — turni `claude -p` in corso, accanto alle tab e mai dentro
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
        // I banner in uscita. Il registry si passa come lambda e non come
        // array: l'indicatore riassegna il campo a ogni rilettura, e un «Vai»
        // cliccato minuti dopo deve vedere quello corrente. `rows.js` ci
        // arriva da `self._notifier` per il banner di una ripresa fallita.
        this._notifier = new Notify.Notifier({
            registry:     () => this._loomRegistry,
            focusSession: (sessionId, origin, project) => this.focusSession(sessionId, origin, project),
        });
        // Falso da `destroy()` in poi: un focus che aspetta l'helper della tab
        // (~0,3 s) può risvegliarsi dopo un disable, e non deve toccare un
        // indicatore distrutto.
        this._alive              = true;
        // T229 — le attese di `AwaitProjectFocus`, aperte dal deck per gli
        // spawn in coda. L'ascolto del focus esiste solo mentre ce n'è almeno
        // una (`onListening`): a zero attese nessun handler sul compositore.
        this._unwatchFocus = null;
        this._focusWaiters = new FocusWait.FocusWaiters({
            outcomeOf:     id => Desktop.projectFocusOutcome(id, this._loomRegistry),
            addTimeout:    (seconds, fn) => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                fn();
                return GLib.SOURCE_REMOVE;
            }),
            removeTimeout: id => GLib.source_remove(id),
            onListening:   on => {
                if (on) {
                    this._unwatchFocus = FocusWait.watchFocus(global.display, () => this._focusWaiters.check());
                } else {
                    this._unwatchFocus?.();
                    this._unwatchFocus = null;
                }
            },
        });

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
        this._loadSessions();
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
            this._loadSessions();
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
    // T206 — tab vive e turni headless dalla stessa lettura del registro: due
    // letture potrebbero vedere lo stesso turno in tutte e due, o in nessuna,
    // se parte o finisce fra l'una e l'altra.
    _loadSessions() {
        ({live: this._liveSessions, headless: this._headlessSessions} = Model.loadRegistry(this._channels));
    }

    _refreshMenu() {
        this._loadSessions();
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
        // finestra col matcher nuovo — vedi `Notifier.ask` in notify.js.
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
                this._notifier.ask(project, loomProject, sessionId);
            }
        }

        this._refreshMenu();
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
    // che non è `tab` o `esatta` arriva anche a schermo (`Notifier.focusOutcome`), tranne
    // su `dbus`: lì l'esito viaggia nella risposta e lo mostra il chiamante, e
    // un banner di compass sarebbe lo stesso avviso due volte.
    //
    // `extraStep` è l'opzione di collaudo dell'oracolo, vedi collaudo.js.
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
            this._notifier.focusOutcome(outcome, project, convo.name || names[0] || `pid ${convo.pid}`);
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
        this._notifier.focusOutcome('sconosciuta', project, sessionId);
        return 'sconosciuta';
    }

    // La finestra in focus è del progetto `projectId`? Il metodo D-Bus
    // `ProjectFocused` (T198), esiti in `Desktop.projectFocusOutcome`.
    //
    // Il registry in memoria si rilegge solo quando non conosce il progetto: è
    // fresco all'ultima apertura del menu, e un progetto registrato dopo
    // risponderebbe `ignoto` fino al prossimo giro di menu. Il `dconf dump`
    // costa un processo, e il caso normale non lo paga.
    projectFocused(projectId) {
        let outcome = Desktop.projectFocusOutcome(projectId, this._loomRegistry);
        if (outcome === 'ignoto') {
            this._loomRegistry = Model.loadLoomRegistry();
            outcome = Desktop.projectFocusOutcome(projectId, this._loomRegistry);
        }
        log(`[Compass] project-focused ${outcome} ${projectId}`);
        return outcome;
    }

    // T229 — aspetta che la finestra in focus diventi del progetto `projectId`
    // e chiama `reply(esito)` una volta sola, anche dopo minuti: il metodo
    // D-Bus `AwaitProjectFocus`, esiti e ascolto in `focus-wait.js`.
    //
    // Il registry si rilegge su `ignoto`, come in `projectFocused`: un progetto
    // registrato dopo l'ultima apertura del menu non deve chiudere l'attesa a
    // torto.
    //
    // Il chiamante si segue sul bus: un deck che si chiude, o che uccide il
    // suo `gdbus call` alla propria scadenza, sparisce dal bus, e l'attesa si
    // chiude con lui (`abbandonata`) invece di restare aperta fino al focus.
    // `bus_watch_name_on_connection` su un nome già sparito chiama subito la
    // funzione di sparizione, quindi nemmeno il caso di un chiamante morto
    // prima di questa riga resta aperto.
    awaitProjectFocus(projectId, notice, deadlineS, connection, sender, reply) {
        if (Desktop.projectFocusOutcome(projectId, this._loomRegistry) === 'ignoto')
            this._loomRegistry = Model.loadLoomRegistry();
        const done = outcome => {
            log(`[Compass] await-focus ${outcome} ${projectId}`);
            reply(outcome);
        };
        const waiter = this._focusWaiters.wait(projectId, deadlineS, done);
        if (!waiter) return;
        log(`[Compass] await-focus attesa ${projectId} ${deadlineS}s «${notice}»`);
        // La notifica dello spawn in attesa, ritirata a fine attesa per
        // qualunque via: vedi `Notifier.focusWait`.
        this._focusWaiters.onEnd(waiter, this._notifier.focusWait(projectId, notice));

        if (connection && sender) {
            const watchId = Gio.bus_watch_name_on_connection(connection, sender,
                Gio.BusNameWatcherFlags.NONE, null,
                () => this._focusWaiters.end(waiter, 'abbandonata'));
            this._focusWaiters.onEnd(waiter, () => Gio.bus_unwatch_name(watchId));
        }
    }

    // Chiude ogni attesa aperta con `interrotta`: compass si spegne o si
    // ricarica, e un deck che aspetta deve saperlo subito — non al timeout del
    // suo `gdbus call`, trenta minuti dopo. Va chiamata PRIMA di togliere il
    // servizio dal bus: la risposta parte sulla connessione dello shell.
    endFocusWaits() {
        this._focusWaiters?.endAll('interrotta');
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
        this._loadSessions();

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
        // Prima di tutto: una risposta e l'ascolto del focus scollegato, anche
        // se `disable` l'ha già fatto (la seconda chiamata non trova attese).
        this.endFocusWaits();
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
        // Dopo `endFocusWaits`: le notifiche delle attese si ritirano da sé, e
        // la sorgente si toglie per ultima.
        this._notifier.destroy();
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
        this._indicator = new CompassIndicator(ext, this._settings);
        Main.panel.addToStatusArea('project-compass', this._indicator);

        // Servizio D-Bus (il contratto in dbus.js)
        this._dbusImpl = Dbus.exportService(this._indicator);

        // Claim del nome sul bus di sessione
        this._ownNameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            Dbus.BUS_NAME,
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

        this._probeIds = Collaudo.collaudoProbe(this._indicator);
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
        // T229 — le attese aperte rispondono `interrotta` prima che il servizio
        // esca dal bus: il deck che aspetta lo sa subito, e non apre la tab.
        this._indicator?.endFocusWaits();
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
