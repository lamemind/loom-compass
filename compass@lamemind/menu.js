// menu.js — compass@lamemind — I WIDGET
//
// Costruzione della voce di menu per progetto: riga-cappello (dot, bottone-nome,
// bottoni surface, chevron), righe-sessione, sotto-menu launch.
//
// Prende `self` — l'istanza di CompassIndicator — come PRIMO ARGOMENTO ESPLICITO,
// non come `this` implicito, e la ragione è la verificabilità: `grep -o
// 'self\._[a-z_]*' menu.js | sort -u` elenca esattamente i campi dell'indicatore
// su cui questo file poggia, e quella lista È il contratto. Con un mixin sul
// prototype la stessa domanda non avrebbe risposta meccanica, e una dipendenza
// all'indietro esisterebbe senza passare da un `import`.
//
// Non importa GLib né Gio: nessuna funzione di questo file li tocca. Costruire
// St.Button o PopupMenu.PopupBaseMenuItem è ISTANZIARE classi che lo shell ha già
// registrato, non registrarne di nuove → nessun contatto con GObject.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Token di cache-busting propagato ai fratelli: `import.meta.url` lo porta, un
// `import './x.js'` statico NO — il figlio resterebbe in cache per tutta la vita
// del processo gnome-shell, e `compass reload` ricaricherebbe un file su cinque
// producendo un grafo misto (impl nuovo + model vecchio) senza nessun errore.
const _Q = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const Model   = await import('./model.js'   + _Q);
const Desktop = await import('./desktop.js' + _Q);

// Nessun cap sulle righe-sessione: ogni conversazione viva ha la sua riga.
// Il cap a sei (con una riga di riepilogo `+N` in coda) esisteva perché il popup
// non aveva un fondo — dieci conversazioni su un progetto spingevano fuori
// schermo i progetti sotto. Ora il popup si ferma all'altezza dello schermo e il
// contenuto scorre (§mountScroll), quindi il troppo non esce più dal bordo:
// nascondere righe raggiungibili costerebbe solo informazione.

// Stati per cui la riga porta l'età oltre al glifo (D1, T149): condividono lo
// stesso campo (`statusUpdatedAt` via `Model.sessionAges`) — includere
// `running` non costa una riga in più. `idle` resta nudo: lì la cifra
// direbbe solo da quanto non succede niente.
const AGED_STATES = new Set(['running', 'ask', 'done']);

// Glifi dei due toggle per-conversazione (T158): 🚨 priorità, 📌 pin. Il nome
// della chiave È il nome del campo nel sidecar — la stessa stringa viaggia dal
// widget al file, così non esiste una tabella di traduzione da tenere allineata.
const MARK_GLYPH = {priority: '🚨', pinned: '📌'};

// Indentazione della riga-sessione sotto il cappello, in pixel.
//
// Prima erano spazi dentro la stringa dell'etichetta, e non potevano restare: con
// un blocco ancorato a destra l'indentazione deve stare sul CONTENITORE, o i due
// blocchi si spostano insieme. Sta come stile inline e non in `stylesheet.css`
// perché lo stylesheet resta in cache nel loader fino al prossimo relogin: una
// regola nuova lì non si vedrebbe finché non si riavvia la sessione grafica.
const ROW_INDENT_PX = 8;

// Larghezza minima del popup, in pixel.
//
// Il tema dà `.popup-menu {min-width: 15em}`, che è un MINIMO e non un massimo:
// il menu si stringe sul contenuto, e con titoli di conversazione lunghi il
// risultato è una colonna di testo tagliato in un popup che avrebbe spazio per
// allargarsi. Dichiararne uno più grande è quindi lecito e non combatte col
// tema — gli indicatori che sembrano «più larghi» (il gestore degli appunti) lo
// sono per la stessa ragione, hanno contenuto che chiede più spazio.
//
// Va sulla box del contenuto e come stile inline, per la stessa ragione
// dell'indentazione sopra: una regola in `stylesheet.css` non si vedrebbe fino
// al prossimo relogin.
const MENU_MIN_WIDTH_PX = 480;

// Spazio lasciato libero sotto il tetto d'altezza del popup, in pixel logici.
//
// Il tetto vero lo scrive GNOME da sé: `PanelMenu.Button._onOpenStateChanged`
// mette sul menu `max-height: <altezza area di lavoro>px` a ogni apertura. Quel
// vincolo però non basta da solo (§mountScroll), e l'area di lavoro non è lo
// spazio che il CONTENUTO può occupare: il popup ci aggiunge padding, bordo e la
// freccia del BoxPointer. Il margine tiene la zona scorrevole sotto il tetto del
// popup, così a cedere è sempre lei e mai il popup intero.
const MENU_VMARGIN_PX = 48;

// Cap della label di riga: RETE, non il criterio di taglio.
//
// Il taglio vero lo fa Pango, ellipsizzando nello spazio che la riga ha davvero
// (vedi `sessionRow`): un numero fisso non può saperlo, e finché decideva lui
// tagliava a venti caratteri anche quando il popup aveva spazio per il doppio.
//
// Il cap contava CODE UNIT, non caratteri visibili, ed è un secondo motivo per
// non affidargli la decisione: un'emoji fuori dal piano base ne occupa due, così
// `🧵 loom-works · T159 🚀 modale` perdeva quattro posizioni per due glifi. Ora
// il valore serve solo a non passare a Pango una stringa assurda.
const LABEL_MAX = 120;

function truncateLabel(label) {
    if (label.length <= LABEL_MAX) return label;
    return label.slice(0, LABEL_MAX - 1) + '…';
}

// Toglie lo spazio dell'ornament da una voce di menu.
//
// Ogni `PopupBaseMenuItem` porta una `St.Icon` con classe `popup-menu-ornament`,
// che il tema dimensiona a `width: 1.091em` — lo spazio del pallino o della
// spunta a sinistra di una voce. Nelle voci di compass quell'ornament non è mai
// valorizzato (lo stato sta in un glifo nostro, il dot del cappello), quindi
// l'icona resta invisibile e occupa comunque la sua larghezza: sono ~16px
// sottratti al testo su OGNI riga, cappello e conversazioni.
//
// `Ornament.HIDDEN` è il solo valore che la rende `visible = false`, e un attore
// invisibile non chiede larghezza; `Ornament.NONE` si limita a svuotare il nome
// dell'icona, lasciando lo spazio prenotato — è il valore di default, cioè
// esattamente il regime da cui si parte.
function hideOrnament(item) {
    item.setOrnament(PopupMenu.Ornament.HIDDEN);
}

// ── Sotto-menu costruiti a mano ──────────────────────────────────────────────
//
// Il cappello di un progetto porta DUE sotto-menu — le conversazioni pinnate e
// le voci launch — e nessuno dei due può essere una `PopupSubMenuMenuItem`: ne
// servirebbero due, cioè due righe in più per ogni progetto, quando la riga del
// cappello esiste già e ha spazio per due chevron.
//
// Un `PopupSubMenu` si costruisce quindi a mano, e lo shell allora non fa più
// tre cose che per una `PopupSubMenuMenuItem` fa da sé:
//
//  ① `addMenuItem` inserisce l'attore del sotto-menu nel box subito dopo la
//     riga e chiama `_setParent`. A mano: `box.add_child(sub.actor)` nell'ordine
//     giusto e `sub._setParent(self.menu)` — senza il parent, `_getTopMenu()`
//     torna il sotto-menu stesso e il calcolo del tetto d'altezza legge il tema
//     dell'attore sbagliato.
//  ② `removeAll()` distrugge solo i figli il cui `_delegate` è una
//     `PopupBaseMenuItem` o una `PopupMenuSection`. L'attore di un
//     `PopupSubMenu` non è nessuna delle due, quindi sopravvivrebbe a ogni
//     ricostruzione del menu accumulandosi nel box. Rimedio: il sotto-menu
//     muore col suo item (`item.connect('destroy', …)`), che `removeAll()`
//     distrugge — lo stesso cablaggio che `PopupSubMenuMenuItem` si fa nel
//     costruttore.
//  ③ `_setOpenedSubMenu` — la regola «uno aperto alla volta» — scatta dal
//     `_subMenuOpenStateChanged` di una `PopupSubMenuMenuItem`, mai da un
//     `PopupSubMenu` nudo. La tiene quindi compass, in `self._openSub`.
//
// La freccia passata al costruttore è OBBLIGATORIA e deve essere un attore
// reale: `open`/`close` ne animano `rotation_angle_z` senza controllare che
// esista. È anche l'unico indicatore di stato del chevron — nessuno scambio di
// `icon_name`: `pan-end-symbolic` ruotata di 90° è già la freccia in giù, ed è
// come lo shell disegna le proprie.

/** Pivot della rotazione della freccia, come nei sotto-menu dello shell: senza,
 *  la rotazione avviene attorno all'angolo in alto a sinistra e la freccia
 *  scappa fuori dal bottone. */
const ARROW_PIVOT = new Graphene.Point({x: 0.5, y: 0.6});

/**
 * Costruisce un chevron e il suo sotto-menu, e li aggancia alla riga.
 *
 * `label` non vuota → il bottone porta testo davanti alla freccia (`📌 5`);
 * vuota → la sola freccia, come il chevron delle launch.
 *
 * Il chevron va aggiunto SOLO se il sotto-menu avrà delle righe: `open()`
 * rifiuta un sotto-menu vuoto, e un bottone che non fa niente è peggio di un
 * bottone assente. Il chiamante lo sa prima di costruire — decide lui.
 */
function attachSubMenu(self, item, row, key, label) {
    const arrow = new St.Icon({
        icon_name: 'pan-end-symbolic',
        style_class: 'popup-menu-arrow',
    });
    arrow.pivot_point = ARROW_PIVOT;

    const box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
    if (label) {
        box.add_child(new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    box.add_child(arrow);

    const chevron = new St.Button({
        style_class: 'compass-chevron',
        child: box,
        can_focus: true, track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const sub = new PopupMenu.PopupSubMenu(item, arrow);
    sub._setParent(self.menu); // ① senza questo `_getTopMenu()` torna `sub`
    // NIENTE animazione slide, come già per le launch: `open`/`close` animano
    // quando `animate` è truthy, e `toggle()` ne passa uno. L'override è
    // sull'ISTANZA e dipende dal solo contratto stabile «animate falsy →
    // nessun ease», non dai rami interni della classe.
    const _open  = sub.open.bind(sub);
    const _close = sub.close.bind(sub);
    sub.open  = () => _open(false);
    sub.close = () => _close(false);
    // ② il sotto-menu muore col suo item, o `removeAll()` lo lascia nel box
    item.connect('destroy', () => sub.destroy());

    self._subs.set(key, sub);
    chevron.connect('clicked', () => toggleSubMenu(self, key));
    row.add_child(chevron);
    return sub;
}

/**
 * ③ «Uno aperto alla volta, e sopravvive alla ricostruzione».
 *
 * Lo stato sta in UNA chiave dell'indicatore (`self._openSub`,
 * `<projectId>:<pinned|launch>`) e non nei widget, perché i widget non
 * sopravvivono: `buildMenu` parte da `removeAll()` e gira a ogni annuncio di
 * stato di qualunque conversazione, anche mentre il popup è aperto e sotto il
 * puntatore. Un sotto-menu espanso sparirebbe al primo `Stop` di un'altra
 * sessione.
 *
 * Aprire chiude quello aperto, di qualunque progetto e tipo. La chiave si
 * scrive solo se il sotto-menu si è davvero aperto: `open()` rifiuta un
 * sotto-menu vuoto, e registrare una chiave per un sotto-menu chiuso
 * lascerebbe il popup convinto di avere qualcosa di aperto.
 */
function toggleSubMenu(self, key) {
    const aperto = self._openSub;
    if (aperto && aperto !== key) self._subs.get(aperto)?.close();
    if (aperto === key) {
        self._subs.get(key)?.close();
        self._openSub = null;
        return;
    }
    const sub = self._subs.get(key);
    if (!sub) return;
    sub.open();
    self._openSub = sub.isOpen ? key : null;
}

// Riapre il sotto-menu che la chiave nomina, dopo che `buildMenu` ha ricostruito
// i widget. Chiave che non trova più un sotto-menu (progetto sparito dal
// registry, pinnate finite) → si dimentica, invece di restare appesa a indicare
// qualcosa che non esiste.
function restoreOpenSubMenu(self) {
    if (!self._openSub) return;
    const sub = self._subs.get(self._openSub);
    if (!sub) {
        self._openSub = null;
        return;
    }
    sub.open();
    if (!sub.isOpen) self._openSub = null;
}

/**
 * La lambda che risolve la finestra del progetto AL CLICK, non adesso.
 *
 * Chi apre una tab o focussa una finestra deve vedere lo stato reale
 * nell'istante dell'azione, non l'istantanea della costruzione del menu: fra le
 * due possono passare minuti, e il menu si ricostruisce da sé a ogni annuncio
 * di stato. Sta in una funzione perché la chiedono DUE posti — il cappello e
 * ogni riga pinnata — e una seconda copia della formula divergerebbe al primo
 * aggiustamento del matcher.
 */
function projectWindowResolver(self, project) {
    return () => Desktop.resolveLoomWindows(self._loomRegistry).get(project.id)?.win ?? null;
}

// ── Etichetta di sessione ────────────────────────────────────────────────────

// Identificativo mostrato nella riga-sessione.
//
// Il `name` del registro è il titolo della tab (`🧵 loom-works · T119`): porta
// già emoji di progetto e task attiva, cioè le due cose che servono. Sotto la
// riga del progetto però emoji e nome sono ridondanti — restano solo se il
// titolo non è quello atteso (sessione titolata a mano). Senza titolo affatto
// (claude lanciato senza --name) resta il pid, che almeno è univoco.
export function sessionLabel(session, project) {
    const raw = (session.name ?? '').trim();
    let label = `pid ${session.pid}`;
    if (raw) {
        const m = raw.match(Desktop.titleKeyRe(project.name));
        if (!m) {
            label = raw;
        } else {
            const rest = raw.slice(m[0].length).replace(/^[\s·:—-]+/, '').trim();
            if (rest) label = rest;
        }
    }
    return truncateLabel(label);
}

// ── La zona scorrevole ───────────────────────────────────────────────────────

// Monta la zona scorrevole che ospita TUTTE le voci, e va chiamata UNA volta
// sola prima del primo `buildMenu`: sopravvive alle ricostruzioni del menu, che
// sono tante — ogni annuncio D-Bus ne fa una, e ricostruire anche il contenitore
// significherebbe perdere la posizione di scorrimento a ogni cambio di stato.
//
// Serve perché il menu cresce col numero di progetti e di conversazioni vive, e
// oltre l'altezza dello schermo le voci in fondo restano irraggiungibili: il
// popup non si ferma al bordo, ci esce.
//
// Metà del meccanismo ce l'ha già GNOME: `PanelMenu.Button`, a ogni apertura,
// scrive sul menu un `max-height` pari all'area di lavoro del monitor primario.
// Quel tetto non morde su una `St.BoxLayout`, che chiede sempre tutta l'altezza
// dei propri figli e quindi ha un'altezza MINIMA pari alla sua altezza naturale
// — il commento upstream sopra quella riga lo dice esplicitamente: «won't do any
// good ... it's useful if part of the menu is scrollable». Una `St.ScrollView`
// è quella parte: la sua altezza minima è indipendente dal contenuto, perché a
// scorrere è il contenuto dentro la finestrella.
//
// Struttura, presa dal pattern che lo shell usa per i propri sotto-menu e che
// clipboard-indicator usa per la history:
//
//     menu
//      └─ wrapper (PopupMenuSection)   ← aggiunta al menu, così il menu la conosce
//          └─ St.ScrollView            ← il tetto morde qui
//              └─ self._section        ← le voci, ricostruite a ogni giro
//
// Il wrapper non è decorativo: una `St.ScrollView` appesa a `menu.box` a mano
// resterebbe fuori dall'elenco delle voci del menu (`_getMenuItems` tiene solo i
// figli con un `_delegate`), e la navigazione da tastiera del popup non vedrebbe
// più niente.
//
// `overlay_scrollbars` perché una ScrollView in policy AUTOMATIC prenota
// larghezza per la barra anche quando la barra non serve: in overlay la barra si
// disegna sopra il contenuto, e comparire non sposta più le righe.
export function mountScroll(self) {
    const wrapper = new PopupMenu.PopupMenuSection();

    self._scroll = new St.ScrollView({
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
        x_expand: true,
    });
    self._section = new PopupMenu.PopupMenuSection();
    self._scroll.set_child(self._section.actor);

    wrapper.actor.add_child(self._scroll);
    self.menu.addMenuItem(wrapper);
}

// Tetto d'altezza della zona scorrevole, in pixel logici.
//
// Ricalcolato a ogni ricostruzione invece che fissato una volta: il monitor
// primario può cambiare (dock agganciato, proiettore) e con lui l'area di
// lavoro. L'area di lavoro è in pixel FISICI, il CSS misura in pixel logici →
// va divisa per il fattore di scala, o su uno schermo HiDPI il tetto risulta il
// doppio dello spazio che c'è davvero.
function scrollMaxHeight() {
    const workArea    = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    return Math.max(120, Math.round(workArea.height / scaleFactor) - MENU_VMARGIN_PX);
}

// ── Costruzione del menu ─────────────────────────────────────────────────────

// NON chiude più con `updateBadge()`: il badge è la coda del canale D-Bus, non un
// widget del popup, e resta nella classe. Farlo richiamare da qui sarebbe una
// freccia all'indietro senza import, cioè invisibile a grep. La chiamata è salita
// nei due orchestratori (`_init` e `_refreshMenu`), che chiamano buildMenu e poi
// `this._updateBadge()` — stesso ordine di prima, stessa doppia esecuzione
// all'apertura del menu (l'handler `open-state-changed` lo chiama già da sé).
export function buildMenu(self) {
    // Si svuota la SEZIONE, non il menu: `menu.removeAll()` distruggerebbe anche
    // il contenitore scorrevole montato una volta sola da mountScroll, e da lì in
    // poi le voci tornerebbero a impilarsi fuori schermo.
    self._section.removeAll();
    // I sotto-menu del giro precedente sono morti coi loro item: il registro
    // riparte vuoto, o `toggleSubMenu` aprirebbe un attore distrutto.
    self._subs = new Map();
    self.menu.box.style = `min-width: ${MENU_MIN_WIDTH_PX}px;`;
    self._scroll.style  = `max-height: ${scrollMaxHeight()}px;`;
    // cache usata anche da findNotificationWindow via self._winMap
    self._winMap = Desktop.resolveWindowMap(self._registry);

    // Il blocco legacy (projects.json) NON viene più renderizzato: le sue voci
    // duplicavano i cappelli loom. `_registry` resta caricato perché serve
    // ancora a risolvere finestre/sessioni per profilo (resolveWindowMap,
    // hook D-Bus keyed su PTYXIS_PROFILE).

    // ── Registry loom (dconf) — unica sorgente del menu ───────────────────
    self._loomWins = Desktop.resolveLoomWindows(self._loomRegistry);
    for (const project of self._loomRegistry) addLoomProject(self, project);

    if (self._loomRegistry.length === 0) {
        const empty = new PopupMenu.PopupMenuItem('— registry vuoto —');
        empty.setSensitive(false);
        self._section.addMenuItem(empty);
    }

    // Ultimo passo, e per forza: riapre sui widget appena costruiti.
    restoreOpenSubMenu(self);
}

// Voce progetto loom = UNA riga self-contained (merge vecchio+nuovo), non più
// header di sotto-menu con figli esplosi. Layout:
//
//   [⚙️]  [🧵 loom-works ──]  [🤖] [🎴] [🖥️]  [📌 5 ▸]  [▸]
//   dot   surface default      always-launch   pinnate   launch
//
//  - dot           = STATO del progetto, per rollup dei figli (loomRollupState).
//                    La presenza non è più il suo colore ma la sua OPACITÀ, vedi
//                    il fade più sotto: due assi distinti sullo stesso glifo.
//  - name btn      = emoji+nome → focus del progetto se aperto, altrimenti lancia
//                    la surface default. L'UNICO focus-or-launch della riga.
//  - deck btn      = emoji fissa 🎴 (solo se surface deck abilitata) → always-launch.
//  - chevron 📌 N  = SOLO se il progetto ha conversazioni pinnate; il sotto-menu
//                    ne contiene una riga ciascuna.
//  - chevron ▸     = SOLO se ci sono launch custom; il sotto-menu contiene
//                    unicamente le voci launch (codium/idea/…).
//
// Entrambi i sotto-menu sono costruiti a mano (§Sotto-menu costruiti a mano) e
// la riga è sempre una `PopupBaseMenuItem`: due `PopupSubMenuMenuItem` per
// progetto vorrebbero dire due righe in più per ognuno, quando la riga del
// cappello ha già spazio per due chevron.
//
// Le surface tracked si aprono SENZA passare dai sotto-menu (bottoni inline).
// Il fade (opacity 110, ripristino su hover) è di PROGETTO, non per-surface: sta
// su dot e bottone-nome, e solo quando il progetto non ha nessuna finestra aperta.
export function addLoomProject(self, project) {
    const wins     = self._loomWins.get(project.id) ?? {win: null};
    const sessions = Model.sessionsForProject(project, self._liveSessions);

    // Le marche si leggono UNA volta per progetto, non una per riga: il sidecar è
    // un file solo, e un lettore per riga lo riaprirebbe N volte a ogni giro di
    // menu — e i giri sono tanti, perché ogni annuncio D-Bus ricostruisce. Le
    // leggono due blocchi (i toggle delle righe-sessione e le pinnate), che è
    // una ragione in più per leggerle qui e passarle giù.
    const marks  = Model.loadSessionMarks(project.dir);
    const pinned = Model.pinnedForProject(project, marks, self._liveSessions);

    const item = new PopupMenu.PopupBaseMenuItem({activate: false});
    hideOrnament(item);
    const row = fillLoomHeader(self, item, project, wins, sessions);

    // I due chevron dentro `row` (non nell'item) per stare sulla stessa riga,
    // all'estrema destra — lo spacer di `fillLoomHeader` li spinge lì. Ognuno
    // compare solo se il suo sotto-menu avrà righe: `open()` rifiuta un
    // sotto-menu vuoto, quindi un chevron senza contenuto sarebbe inerte.
    const pinnedSub = pinned.length > 0
        ? attachSubMenu(self, item, row, `${project.id}:pinned`, `${MARK_GLYPH.pinned} ${pinned.length}`)
        : null;
    const launchSub = project.launch.length > 0
        ? attachSubMenu(self, item, row, `${project.id}:launch`, '')
        : null;

    self._section.addMenuItem(item);

    // Gli attori dei sotto-menu vanno nel box SUBITO DOPO la riga, nell'ordine
    // dei chevron: è ciò che `addMenuItem` fa da sé per una
    // `PopupSubMenuMenuItem` e che qui tocca a noi (① di §Sotto-menu).
    if (pinnedSub) {
        self._section.box.add_child(pinnedSub.actor);
        for (const p of pinned)
            pinnedSub.addMenuItem(pinnedRow(self, project, p));
    }
    if (launchSub) {
        self._section.box.add_child(launchSub.actor);
        // voci launch (custom) → command @project-root, fire-once
        for (const launch of project.launch) {
            const label = launch.label || launch.command;
            const li    = new PopupMenu.PopupMenuItem(`${launch.emoji} ${label}`);
            li.connect('activate', () => { Desktop.runLaunch(project, launch); self.menu.close(); });
            launchSub.addMenuItem(li);
        }
    }

    // Righe-sessione: una per sessione viva, subito sotto il cappello e nel
    // menu principale (non dietro un chevron, che chiederebbe un click in più
    // per una cosa che si guarda a colpo d'occhio).
    for (const s of sessions)
        self._section.addMenuItem(sessionRow(self, s, project, marks));
}

// ── Righe delle conversazioni pinnate ────────────────────────────────────────

/** Glifo di una pinnata che non è (più) un processo vivo. Non è nessuno degli
 *  `STATE_EMOJI`: quelli dicono cosa sta facendo una conversazione viva, e qui
 *  non ce n'è una. Il cerchio vuoto dice «c'è, ma non sta girando». */
const PINNED_DEAD_GLYPH = '○';

/** Quanti caratteri di `sessionId` bastano a distinguere una conversazione
 *  quando non ha né nota né titolo. Sono UUID: otto cifre esadecimali sono già
 *  più di quante ne servano dentro un progetto solo, e la riga non deve
 *  diventare una colonna di id. */
const SHORT_ID_LEN = 8;

/**
 * Etichetta di una riga pinnata, in cascata.
 *
 * Ordine: **task id** davanti quando c'è, poi la **nota**, poi il **titolo** se
 * dice qualcosa in più della nota, e l'**id corto** solo quando nota e titolo
 * sono entrambi vuoti — così nessuna riga è muta.
 *
 * La nota precede il titolo perché è la parte scelta da un umano per dire cosa
 * è quella conversazione, mentre il titolo è derivato; è anche l'ordine che la
 * riga del deck usa sulle stesse due stringhe. Il titolo si mostra solo se
 * DIFFERISCE dalla nota: la nota di spawn finisce nel titolo della tab, quindi
 * su una conversazione aperta dal deck le due coincidono spesso, e ripeterla
 * occuperebbe la riga senza aggiungere niente.
 */
export function pinnedLabel(sessionId, mark) {
    const parti = [];
    if (mark.taskId) parti.push(mark.taskId);
    const nota   = (mark.note  ?? '').trim();
    const titolo = (mark.title ?? '').trim();
    if (nota) parti.push(nota);
    if (titolo && titolo !== nota) parti.push(titolo);
    if (!nota && !titolo) parti.push(sessionId.slice(0, SHORT_ID_LEN));
    return truncateLabel(parti.join(' · '));
}

/**
 * Riga di una conversazione pinnata: `glifo etichetta` a sinistra, il toggle
 * 📌 a destra.
 *
 * Due assi distinti sullo stesso significato, come sulla riga del cappello:
 *  - il GLIFO dice se la conversazione sta girando (lo stato, se viva) o no
 *    (`○`);
 *  - l'OPACITÀ dice la presenza sulla scala già in uso nel menu — 255 viva,
 *    110 con ripristino su hover per una morta, che è esattamente il «assente
 *    ma raggiungibile, il click la apre» del bottone-nome.
 *
 * Il toggle è 📌 e non 🚨: spinnare è l'unica azione che ha senso su una riga
 * che potrebbe essere morta, e senza il toggle qui l'unico modo di spinnare una
 * conversazione chiusa sarebbe aprire il deck. Una marca di priorità su una
 * morta non avrebbe effetto — l'hook che la consuma scatta solo su sessioni
 * vive.
 */
export function pinnedRow(self, project, entry) {
    const {sessionId, mark, session} = entry;
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, reactive: false});
    hideOrnament(item);
    const row = new St.BoxLayout({
        style_class: 'compass-session-row',
        x_expand: true, x_align: Clutter.ActorAlign.FILL,
    });

    const glyph = session
        ? (Model.STATE_EMOJI[Model.sessionState(session, self._channels)] ?? '⚪')
        : PINNED_DEAD_GLYPH;

    const label = new St.Label({
        text: `${glyph}  ${pinnedLabel(sessionId, mark)}`,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

    // L'etichetta dentro un BOTTONE, non nuda: è l'azione della riga (focus se
    // viva, ripresa se morta), e un `St.Button` reattivo figlio di una riga
    // `reactive: false` riceve il click — la non-reattività del padre toglie dal
    // pick il solo padre, non il sottoalbero (misurato per i toggle di T158).
    //
    // La label va in una `St.BoxLayout` dentro il bottone, non come figlia
    // diretta: `St.Button` è un `St.Bin` e CENTRA il proprio figlio quando ha
    // spazio extra, ignorando l'allineamento chiesto — il titolo finirebbe in
    // mezzo alla riga. Una box invece rispetta l'espansione, quindi la label
    // riempie da sinistra e si ellipsizza sulla larghezza vera.
    const box = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.FILL});
    box.add_child(label);
    const openBtn = new St.Button({
        style_class: 'compass-surface-btn',
        // Il padding della classe è tarato sui bottoni del cappello: su una riga
        // di conversazione sfonderebbe l'altezza. Lo stile inline batte quello
        // della classe sulla sola proprietà che nomina, quindi l'evidenziazione
        // su hover resta.
        style: 'padding: 1px 4px;',
        child: box,
        x_expand: true,
        can_focus: true, track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    // Fade di PRESENZA, la stessa scala del resto del menu: 255 = la
    // conversazione sta girando, 110 con ripristino su hover = non c'è ma il
    // click la riapre. È esattamente la semantica che il bottone-nome del
    // cappello dà a quei due valori.
    if (!session) {
        openBtn.opacity = 110;
        openBtn.connect('notify::hover', () => { openBtn.opacity = openBtn.hover ? 255 : 110; });
    }

    const findProjectWindow = projectWindowResolver(self, project);
    openBtn.connect('clicked', () => {
        // Il ts del click va catturato PRIMA di chiudere il menu: la chiusura
        // rilascia il grab e rifocussa la finestra pre-menu, e senza il
        // timestamp di un evento valido Mutter ignora l'activate che segue.
        const ts = global.get_current_time();
        self.menu.close();
        if (session) {
            // Viva → si va dove è, e nessuna tab nuova: una seconda `claude
            // --resume` sullo stesso id aprirebbe un secondo scrittore sul
            // medesimo transcript. La tab esatta non è raggiungibile — Ptyxis
            // non espone targeting per-tab — quindi si consegna la finestra del
            // progetto e la tab la scegli tu.
            const win = findProjectWindow();
            if (win) Desktop.focusWindow(win, ts);
            else log(`[Compass] conversazione viva senza finestra del progetto: ${sessionId}`);
            return;
        }
        Desktop.launchResume(
            project,
            {sessionId, taskId: mark.taskId, model: mark.model},
            ts,
            findProjectWindow
        );
    });
    row.add_child(openBtn);

    // Il toggle chiede la `dir` del progetto (dove sta il sidecar): senza, la
    // riga resta di sola lettura invece di offrire un bottone che non può
    // scrivere niente. Il `sessionId` c'è per costruzione — è la chiave della
    // marca che ha messo questa riga in lista.
    if (project.dir)
        row.add_child(markToggle(project, sessionId, 'pinned', true));

    item.add_child(row);
    return item;
}

// Riga-sessione, a due ancoraggi: `glifo titolo` a sinistra, `età toggle` a
// destra. Come la riga del cappello, il contenuto sta in una St.BoxLayout propria
// e non in figli diretti dell'item — la PopupBaseMenuItem centra i figli diretti
// e non rispetta la loro richiesta di espansione, quindi senza il contenitore il
// blocco destro non arriverebbe a destra.
//
// La riga resta INERTE per decisione (D2): il focus è già mestiere del
// bottone-nome del cappello, e la mappatura conversazione → tab Ptyxis non è
// ottenibile da nessuna fonte disponibile — il registro non la porta e Ptyxis non
// espone targeting per-finestra. Una riga che al click focussa la finestra
// duplicherebbe il bottone-nome su N righe.
//
// Quella decisione copre il focus, non ogni interazione: un toggle ha bisogno del
// solo `sessionId`, che la riga possiede già. La forma che rispetta entrambe le
// cose è un BOTTONE dentro la riga, non la riga resa reattiva — vedi markToggle.
export function sessionRow(self, session, project, marks) {
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, reactive: false});
    hideOrnament(item);
    const row  = new St.BoxLayout({
        style_class: 'compass-session-row',
        x_expand: true, x_align: Clutter.ActorAlign.FILL,
    });

    row.style = `padding-left: ${ROW_INDENT_PX}px;`;

    const state = Model.sessionState(session, self._channels);
    const glyph = Model.STATE_EMOJI[state] ?? '⚪';

    // L'etichetta ESPANDE e si ellipsizza da sé, e con questo fa anche il mestiere
    // dello spacer che stava qui: prendendosi lo spazio in mezzo, spinge età e
    // toggle a destra senza un attore vuoto che li separi.
    //
    // Il taglio passa così a Pango, che lo decide sulla larghezza REALE della
    // riga. Prima lo decideva un cap di venti code unit, quindi tagliava anche
    // quando il popup aveva spazio, e tagliava di più sui titoli con emoji —
    // che è il caso normale, dato che ogni titolo di tab ne porta almeno una.
    const label = new St.Label({
        text: `${glyph}  ${sessionLabel(session, project)}`,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(label);

    if (AGED_STATES.has(state))
        row.add_child(new St.Label({
            text: Model.ageText(session),
            y_align: Clutter.ActorAlign.CENTER,
        }));

    // I toggle chiedono due cose che possono mancare: il `sessionId` (la chiave
    // della marca) e la `dir` del progetto (dove sta il sidecar). Senza una delle
    // due la riga resta di sola lettura, invece di offrire un bottone che non può
    // scrivere niente.
    if (session.sessionId && project.dir) {
        const mark = marks.get(session.sessionId) ?? {};
        row.add_child(markToggle(project, session.sessionId, 'priority', mark.priority === true));
        row.add_child(markToggle(project, session.sessionId, 'pinned',   mark.pinned   === true));
    }

    item.add_child(row);
    return item;
}

// Toggle di una marca per-conversazione — 🚨 priorità, 📌 pin — come bottone
// dentro la riga inerte.
//
// Misurato, non dedotto: un `St.Button` reattivo figlio di una riga
// `reactive: false` RICEVE il click. La non-reattività del padre toglie dal pick
// il solo padre, non il sottoalbero — quindi non serve rendere reattiva la riga
// con l'attivazione neutralizzata, e non si rimette in piedi l'aspettativa di
// focus che la riga inerte esiste per non creare.
//
// Lo stato acceso/spento è l'OPACITÀ, sulla scala già in uso nel resto del menu:
// 255 = marca accesa, 110 = spenta ma azionabile, con ripristino su hover.
function markToggle(project, sessionId, field, initial) {
    const btn = new St.Button({
        style_class: 'compass-surface-btn',
        // Il padding della classe è tarato sui bottoni del cappello: su una riga
        // di conversazione sfonderebbe l'altezza. Lo stile inline batte quello
        // della classe sulla sola proprietà che nomina, quindi l'evidenziazione
        // su hover della classe resta.
        style: 'padding: 1px 4px;',
        label: MARK_GLYPH[field],
        can_focus: true, track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    let on = initial;
    const paint = () => { btn.opacity = (on || btn.hover) ? 255 : 110; };
    paint();
    btn.connect('notify::hover', paint);

    // Il menu NON si ricostruisce dopo il toggle: si ridipinge il solo bottone.
    // Una ricostruzione distruggerebbe l'attore dentro il suo stesso handler, e
    // farebbe sparire da sotto il puntatore la riga di chi sta per premere anche
    // l'altro toggle. Il giro di menu successivo rilegge il file e conferma.
    //
    // La UI si muove solo se la scrittura è andata a segno: `writeSessionMark`
    // ritorna false su sidecar non scrivibile, e lì il bottone non deve mentire.
    btn.connect('clicked', () => {
        if (!Model.writeSessionMark(project.dir, sessionId, field, !on)) return;
        on = !on;
        paint();
    });

    return btn;
}

// Popola l'header di una voce loom coi child inline: dot presenza + bottone
// claude (emoji+nome, espande) + bottone deck (emoji fissa, se abilitato).
// I child NON vanno diretti nell'item: la PopupBaseMenuItem CENTRA il gruppo
// (non rispetta l'x_expand dei bottoni). Vanno in un mio St.BoxLayout `row`
// che riempie l'item (x_expand FILL) e impacchetta a sinistra di default →
// contenuto ancorato a sinistra. Ritorna `row` così il caller può appendere
// il chevron dentro la stessa riga.
export function fillLoomHeader(self, item, project, wins, sessions = []) {
    const row = new St.BoxLayout({
        style_class: 'compass-loom-row',
        x_expand: true, x_align: Clutter.ActorAlign.FILL,
        y_expand: true, y_align: Clutter.ActorAlign.FILL,
    });

    const findProjectWindow = projectWindowResolver(self, project);

    // dot — STATO via rollup delle surface tracked (ask>done>running>idle),
    // come le voci vecchie: STATE_EMOJI keyed su _sessions[bindingUUID]. Lo
    // stato arriva via D-Bus (hook claude → SetState su PTYXIS_PROFILE, che è
    // esattamente bindings.claude del cappello).
    //
    // FADE DI PRESENZA (stessa regola dei bottoni surface e del blocco vecchio):
    // il pallino segue lo stato aperto/chiuso del progetto. Nessuna finestra col
    // match nome (`wins.win == null`, cioè nessun titolo con una chiave dell'emoji-set)
    // → dot attenuato (opacity 110); finestra aperta → pieno (255). Ripristino su
    // hover della riga — `item.hover` è true anche col puntatore sopra i bottoni
    // figli (niente flicker). Lo STATO (emoji del rollup) NON cambia: varia solo
    // l'alpha, a segnalare "progetto non presente".
    const rollup = Model.loomRollupState(project, sessions, self._channels);
    const dot = new St.Label({
        text: Model.STATE_EMOJI[rollup] ?? '⚪',
        style_class: 'compass-dot',
        y_align: Clutter.ActorAlign.CENTER,
    });
    dot.opacity = wins.win ? 255 : 110;
    if (!wins.win)
        item.connect('notify::hover', () => { dot.opacity = item.hover ? 255 : 110; });
    row.add_child(dot);

    // bottone-nome (emoji + nome) — apre la SURFACE DEFAULT del progetto, non
    // più claude hardcoded: la sceglie `defaultSurface` in .claude/loom-works.json
    // (vedi resolveDefaultSurface). Il bottone NON deve espandersi: St.Button
    // (St.Bin) CENTRA la label interna se ha spazio extra (ignora x_align START)
    // → col bottone che avvolge la label, il testo resta ancorato a sinistra,
    // subito dopo il dot. Lo spazio verso i bottoni destri lo mangia uno spacer.
    const nameLabel = new St.Label({
        text: `${project.emoji} ${project.name}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const nameBtn = new St.Button({
        style_class: 'compass-surface-btn',
        child: nameLabel,
        y_expand: true, y_align: Clutter.ActorAlign.FILL,
        can_focus: true, track_hover: true,
    });
    // FOCUS-OR-LAUNCH a livello PROGETTO, non per-surface. La presenza è
    // `wins.win` (match sull'emoji-set + `name` → intercetta la finestra
    // qualunque tab sia attiva): se il progetto ha una finestra aperta il click
    // la focussa, A PRESCINDERE da quale surface ci sia dentro. Solo se non c'è
    // NIENTE aperto il click lancia la surface default (e solo lì il bottone fada).
    //
    // Il bug che questo sostituisce: il bottone veniva wirato su `wins.deck`
    // quando defaultSurface=deck, ma `wins.deck` è valorizzata SOLO se la tab
    // ATTIVA è il deck → col claude in primo piano il progetto risultava assente
    // (faded) e il click apriva un deck NUOVO invece di focussare la finestra.
    // Stesso difetto in specchio sul ramo terminal: sempre launch, mai focus.
    const defKind = Desktop.resolveDefaultSurface(project);
    wireSurfaceButton(self, nameBtn, project, defKind, wins.win, findProjectWindow);
    row.add_child(nameBtn);

    // spacer — St.Widget vuoto che espande e mangia lo spazio tra il nome e il
    // gruppo destro. NON è un bottone → non centra nulla, non intercetta click:
    // dot+nome restano a sinistra, 🤖/🎴/🖥️+chevron finiscono a destra.
    row.add_child(new St.Widget({x_expand: true}));

    // claude 🤖 — bottone solo-emoji. FORZA l'apertura di una nuova tab claude
    // ANCHE se claude è già aperto: dove il bottone-nome (se il default è claude)
    // focussa la finestra esistente, questo chiama SEMPRE launchTracked → nuova
    // tab nella project-window (coalescing), o nuova finestra se nessuna. La
    // distinzione focus-or-launch / always-launch resta anche ora che l'icona è
    // identitaria (🤖) e non più un modificatore (➕). Mostrato solo dove claude
    // è abilitato E bound (serve un profilo UUID da lanciare).
    if (project.surfaces.includes('claude') && project.bindings?.claude) {
        const newClaudeBtn = new St.Button({
            style_class: 'compass-surface-btn',
            label: '🤖',
            can_focus: true, track_hover: true,
            y_expand: true, y_align: Clutter.ActorAlign.FILL,
        });
        newClaudeBtn.connect('clicked', () => {
            // Cattura il ts del click (evento valido), CHIUDI il menu (rilascia il
            // grab), poi launchTracked che attiva projWin dopo la chiusura col ts
            // catturato → focus davvero consegnato a Ptyxis (vedi launchTracked).
            const ts = global.get_current_time();
            self.menu.close();
            Desktop.launchTracked(project, 'claude', ts, findProjectWindow);
        });
        row.add_child(newClaudeBtn);
    }

    // deck 🎴 — reso per OGNI progetto con la surface `deck` abilitata (non
    // gated sul profilo bound): T25 fatta, loom-deck è GLOBALE (npm
    // @lamemind/loom-deck, comando `loom-deck` nel PATH) → lanciabile ovunque.
    // ALWAYS-LAUNCH, come 🤖: il click apre sempre un deck NUOVO, mai focus di
    // uno esistente. Ne segue che non fada mai (il fade a 110 significava "non
    // presente, il click lancia" — distinzione che qui non esiste più: il click
    // lancia in ogni caso). Per il focus c'è il bottone-nome, che consegna la
    // finestra del progetto qualunque surface sia in primo piano.
    if (project.surfaces.includes('deck')) {
        const deckBtn = new St.Button({
            style_class: 'compass-surface-btn',
            label: Desktop.SURFACE_EMOJI.deck,
            can_focus: true, track_hover: true,
            y_expand: true, y_align: Clutter.ActorAlign.FILL,
        });
        deckBtn.connect('clicked', () => {
            const ts = global.get_current_time();
            self.menu.close();
            Desktop.launchTracked(project, 'deck', ts, findProjectWindow);
        });
        row.add_child(deckBtn);
    }

    // terminal — surface STANDARD LAUNCH: built-in e universale (ogni progetto
    // loom ce l'ha, senza dichiararla in `launch[]`), ma di natura launch —
    // fire-once, nessuno stato, nessun contributo al rollup del pallino.
    // Sempre presente e sempre piena opacità: non è una presenza da fotografare,
    // è un'azione ("apri un terminale qui"), quindi niente fade.
    const termBtn = new St.Button({
        style_class: 'compass-surface-btn',
        label: Desktop.SURFACE_EMOJI.terminal,
        can_focus: true, track_hover: true,
        y_expand: true, y_align: Clutter.ActorAlign.FILL,
    });
    termBtn.connect('clicked', () => {
        const ts = global.get_current_time();
        self.menu.close();
        Desktop.launchTracked(project, 'terminal', ts, findProjectWindow);
    });
    row.add_child(termBtn);

    item.add_child(row);
    return row;
}

// Aggancia l'azione FOCUS-OR-LAUNCH al bottone-nome del cappello:
//  - `win` (finestra del PROGETTO, qualunque surface ci sia dentro) → click =
//    focus, opacità piena.
//  - nessuna finestra → click = lancia `kind`; fade a 110 + ripristino su hover,
//    a segnalare "progetto non presente, il click lo apre".
// `win` è la presenza del progetto, MAI quella della singola surface: focussare
// ciò che è aperto vale anche quando la surface dentro non è `kind`. `kind` conta
// solo nel ramo launch, ed è già risolto da resolveDefaultSurface → garantito
// lanciabile (abilitato, e bound se claude), `terminal` incluso.
// Unico chiamante: il bottone-nome. I bottoni-emoji 🤖/🎴/🖥️ NON passano di qui:
// sono always-launch.
export function wireSurfaceButton(self, btn, project, kind, win, findProjectWindow) {
    if (win) {
        btn.connect('clicked', () => { Desktop.focusWindow(win); self.menu.close(); });
        return;
    }
    btn.opacity = 110;
    btn.connect('notify::hover', () => { btn.opacity = btn.hover ? 255 : 110; });
    btn.connect('clicked', () => {
        const ts = global.get_current_time();
        self.menu.close();
        Desktop.launchTracked(project, kind, ts, findProjectWindow);
    });
}
