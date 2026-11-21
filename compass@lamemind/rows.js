// rows.js — compass@lamemind — LE RIGHE DELLE CONVERSAZIONI
//
// Lo strato foglia dei widget del popup: la riga di una conversazione viva
// (`sessionRow`) e quella di una conversazione pinnata (`pinnedRow`), con i loro
// pezzi — il titolo come bottone (`labelButton`), i toggle 🚨 📌 (`markToggle`),
// le etichette (`sessionLabel`, `pinnedLabel`) e il contatore dei turni
// headless (`headlessCounter`). menu.js costruisce il popup e la riga del
// cappello, e chiede qui le righe che stanno sotto il cappello.
//
// Come menu.js, prende `self` — l'istanza di CompassIndicator — come PRIMO
// ARGOMENTO ESPLICITO: `grep -o 'self\.[a-z_]*' rows.js | sort -u` elenca i
// campi dell'indicatore su cui questo file poggia, e quella lista È il
// contratto.
//
// La dipendenza va in un verso solo: menu.js importa questo file, questo file
// non importa menu.js né impl.js. Per questo `hideOrnament`, `MARK_GLYPH` e
// `projectWindowResolver`, che servono anche al cappello, stanno qui.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Cache-busting propagato: vedi la testata di impl.js.
const _Q = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const Model   = await import('./model.js'   + _Q);
const Desktop = await import('./desktop.js' + _Q);

// Stati per cui la riga porta l'età oltre al glifo (D1, T149): condividono lo
// stesso campo (`statusUpdatedAt` via `Model.sessionAges`) — includere
// `running` non costa una riga in più. `idle` resta nudo: lì la cifra
// direbbe solo da quanto non succede niente.
const AGED_STATES = new Set(['running', 'ask', 'done']);

// Glifi dei due toggle per-conversazione (T158): 🚨 priorità, 📌 pin. Il nome
// della chiave È il nome del campo nel sidecar — la stessa stringa viaggia dal
// widget al file, così non esiste una tabella di traduzione da tenere allineata.
export const MARK_GLYPH = {priority: '🚨', pinned: '📌'};

// Indentazione della riga-sessione sotto il cappello, in pixel.
//
// Prima erano spazi dentro la stringa dell'etichetta, e non potevano restare: con
// un blocco ancorato a destra l'indentazione deve stare sul CONTENITORE, o i due
// blocchi si spostano insieme. Sta come stile inline e non in `stylesheet.css`
// perché lo stylesheet resta in cache nel loader fino al prossimo relogin: una
// regola nuova lì non si vedrebbe finché non si riavvia la sessione grafica.
const ROW_INDENT_PX = 8;

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
export function hideOrnament(item) {
    item.setOrnament(PopupMenu.Ornament.HIDDEN);
}

/**
 * La lambda che risolve la finestra del progetto AL CLICK, non adesso.
 *
 * Chi apre una tab o focussa una finestra deve vedere lo stato reale
 * nell'istante dell'azione, non l'istantanea della costruzione del menu: fra le
 * due possono passare minuti, e il menu si ricostruisce da sé a ogni annuncio
 * di stato. Sta in una funzione perché la chiedono DUE posti — il cappello e
 * ogni riga pinnata — e una seconda copia della formula divergerebbe al primo
 * aggiustamento del matcher. Sta in questo file e non in menu.js perché la
 * dipendenza va in un verso solo: menu.js importa le righe, non il contrario.
 */
export function projectWindowResolver(self, project) {
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

// ── Righe delle conversazioni pinnate ────────────────────────────────────────

/** Glifo di una pinnata che non è (più) un processo vivo. Non è nessuno degli
 *  `STATE_EMOJI`: quelli dicono cosa sta facendo una conversazione viva, e qui
 *  non ce n'è una. Il cerchio vuoto dice «c'è, ma non sta girando». */
const PINNED_DEAD_GLYPH = '○';

/** T206 — un turno headless (`claude -p`) in corso: lo stesso glifo del deck
 *  (`LIVE_HEADLESS` in `loom-deck/src/glyphs.ts`), per la stessa cosa. Sta nel
 *  contatore accanto al nome del progetto e sulla pinnata il cui turno gira. */
export const HEADLESS_GLYPH = '◐';

/** T206/D1 — il contatore dei turni headless in corso di un progetto, `◐2`, o
 *  stringa vuota a zero: nessun turno, nessun segno. */
export function headlessCounter(count) {
    return count > 0 ? `${HEADLESS_GLYPH}${count}` : '';
}

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
 * Il glifo porta lo stato: quello della conversazione se è viva, `○` se non
 * sta girando. È l'unico asse, e la presenza NON la ridice anche l'opacità:
 * queste righe stanno già dentro `.compass-session-row`, che le tiene a 0.85,
 * e un secondo fader in serie (110/255 ≈ 0.43) le porta a un terzo
 * dell'opacità piena — testo che non si legge, invece di testo attenuato.
 *
 * Il clic sul titolo va a QUELLA conversazione, con due azioni secondo il
 * glifo: una viva porta davanti la sua tab, come la riga-sessione; una morta si
 * riprende in una tab nuova della finestra del progetto (`Desktop.launchResume`).
 * T206/P10 — una terza forma, `◐`: un turno headless in corso. Nessun clic: non
 * c'è una tab, e la ripresa aprirebbe un secondo processo sul transcript.
 *
 * Una viva non si riprende mai, e il rischio che questo chiude non è estetico:
 * una conversazione viva ripresa una seconda volta sono due processi `claude`
 * che scrivono lo stesso transcript, due scrittori sullo stesso file.
 *
 * Il toggle è 📌 e non 🚨: spinnare è l'unica azione che ha senso su una riga
 * che potrebbe essere morta, e senza il toggle qui l'unico modo di spinnare una
 * conversazione chiusa sarebbe aprire il deck. Una marca di priorità su una
 * morta non avrebbe effetto — l'hook che la consuma scatta solo su sessioni
 * vive.
 */
export function pinnedRow(self, project, entry) {
    const {sessionId, mark, session, headless} = entry;
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, reactive: false});
    hideOrnament(item);
    const row = new St.BoxLayout({
        style_class: 'compass-session-row',
        x_expand: true, x_align: Clutter.ActorAlign.FILL,
    });

    const glyph = session
        ? (Model.STATE_EMOJI[Model.sessionState(session, self._channels)] ?? '⚪')
        : headless ? HEADLESS_GLYPH : PINNED_DEAD_GLYPH;

    const label = new St.Label({
        text: `${glyph}  ${pinnedLabel(sessionId, mark)}`,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

    if (session) {
        // Viva → la sua tab davanti, come il clic sulla riga-sessione.
        row.add_child(labelButton(label, () => self._focus(session, project, 'pinnata')));
    } else if (headless) {
        // T206/P10 — turno headless in corso: nessuna tab da portare davanti, e
        // la ripresa sarebbe il secondo scrittore sullo stesso transcript.
        // Etichetta nuda, non cliccabile, finché il turno non finisce.
        row.add_child(label);
    } else {
        const findProjectWindow = projectWindowResolver(self, project);
        row.add_child(labelButton(label, () => {
            // Il ts del click va catturato PRIMA di chiudere il menu: la
            // chiusura rilascia il grab e rifocussa la finestra pre-menu, e
            // senza il timestamp di un evento valido Mutter ignora l'activate
            // che segue.
            const ts = global.get_current_time();
            self.menu.close();
            Desktop.launchResume(
                project,
                {
                    sessionId,
                    taskId: mark.taskId,
                    model: mark.model,
                    // La maniglia per il titolo della tab: senza, le tab di più
                    // pinnate dello stesso progetto nascono omonime.
                    note: mark.note,
                    title: mark.title,
                },
                ts,
                findProjectWindow,
                (reason) => self._notifier.resumeFailed(project, reason)
            );
        }));
    }

    // Il toggle chiede la `dir` del progetto (dove sta il sidecar): senza, la
    // riga resta di sola lettura invece di offrire un bottone che non può
    // scrivere niente. Il `sessionId` c'è per costruzione — è la chiave della
    // marca che ha messo questa riga in lista.
    if (project.dir)
        row.add_child(markToggle(project, sessionId, 'pinned', true));

    item.add_child(row);
    return item;
}

// L'etichetta di una riga di conversazione come BOTTONE: clic sul titolo = vai a
// quella conversazione. È la forma dell'azione principale nelle righe-sessione e
// nelle pinnate; i toggle 🚨 📌 sono l'altra forma, il glifo (markToggle).
//
// Un `St.Button` reattivo figlio di una riga `reactive: false` riceve il click —
// la non-reattività del padre toglie dal pick il solo padre, non il sottoalbero
// (misurato per i toggle di T158).
//
// La label va in una `St.BoxLayout` dentro il bottone, non come figlia diretta:
// `St.Button` è un `St.Bin` e CENTRA il proprio figlio quando ha spazio extra,
// ignorando l'allineamento chiesto — il titolo finirebbe in mezzo alla riga. Una
// box invece rispetta l'espansione, quindi la label riempie da sinistra e si
// ellipsizza sulla larghezza vera.
//
// Il bottone espande, e con questo fa anche il mestiere dello spacer: prendendosi
// lo spazio in mezzo, spinge a destra ciò che la riga aggiunge dopo.
function labelButton(label, onClick) {
    const box = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.FILL});
    box.add_child(label);
    const btn = new St.Button({
        style_class: 'compass-surface-btn',
        // Il padding della classe è tarato sui bottoni del cappello: su una riga
        // di conversazione sfonderebbe l'altezza. Lo stile inline batte quello
        // della classe sulla sola proprietà che nomina, quindi l'evidenziazione
        // su hover resta — ed è quella, non un'opacità, a dire che la riga è
        // azionabile.
        style: 'padding: 1px 4px;',
        child: box,
        x_expand: true,
        can_focus: true, track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    btn.connect('clicked', onClick);
    return btn;
}

// Riga-sessione, a due ancoraggi: `glifo titolo` a sinistra, `età toggle` a
// destra. Come la riga del cappello, il contenuto sta in una St.BoxLayout propria
// e non in figli diretti dell'item — la PopupBaseMenuItem centra i figli diretti
// e non rispetta la loro richiesta di espansione, quindi senza il contenitore il
// blocco destro non arriverebbe a destra.
//
// Il clic sul titolo porta davanti la tab di QUESTA conversazione, nella sua
// finestra. La mappatura conversazione → tab passa dal titolo della tab, che è
// il `--name` passato a `claude`; il cambio di tab passa da AT-SPI, nel processo
// a sé `ptyxis-tab.js` (vedi `Desktop.switchPtyxisTab`). La riga non duplica il
// bottone-nome del cappello: quello porta alla finestra del progetto, questa
// alla tab della conversazione — due bersagli diversi.
//
// Età e toggle stanno fuori dal bottone del titolo, e la riga resta inerte: ogni
// azione è un BOTTONE dentro la riga, non la riga resa reattiva — vedi
// labelButton e markToggle.
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

    // L'etichetta ESPANDE dentro il suo bottone e si ellipsizza da sé: il taglio
    // lo decide Pango sulla larghezza REALE della riga. Prima lo decideva un cap
    // di venti code unit, quindi tagliava anche quando il popup aveva spazio, e
    // tagliava di più sui titoli con emoji — che è il caso normale, dato che ogni
    // titolo di tab ne porta almeno una.
    const label = new St.Label({
        text: `${glyph}  ${sessionLabel(session, project)}`,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(labelButton(label, () => self._focus(session, project, 'riga')));

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
// con l'attivazione neutralizzata: ogni azione della riga è un bottone suo, e il
// clic su un toggle non porta a nessuna tab.
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
