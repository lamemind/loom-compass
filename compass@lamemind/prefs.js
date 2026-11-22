// prefs.js — compass@lamemind — LA FINESTRA DELLE IMPOSTAZIONI
//
// Una pagina, due funzioni sui progetti del registry loom: quali compaiono nel
// menu della top bar, e in che ordine. Una riga per progetto, nell'ordine del
// menu, con un interruttore (acceso = visibile) e due frecce ↑/↓.
//
// L'interruttore scrive la chiave `hidden-projects` dello schema GSettings
// dell'estensione, e lo shell ricostruisce il menu sul `changed::` di quella
// chiave (impl.js) — nessun reload, nessun relogin. Interruttore e non casella:
// le HIG di GNOME danno l'interruttore alle opzioni che si applicano subito.
//
// Le frecce spostano solo le righe. L'ordine nuovo si scrive alla pressione di
// «Applica», nella testata del gruppo e spento finché le righe sono nell'ordine
// salvato: per ogni progetto che cambia numero, la riga `order` del suo
// `.claude/loom-works.json`, la copia nel registry dconf e un commit nel suo
// repo (reorder.js). Un commit per clic sporcherebbe un repo a ogni passo di un
// gesto fatto di più clic; i numeri si calcolano sull'ordine finale, non sulla
// strada dei clic. Il menu legge il registry a ogni apertura: l'ordine nuovo
// compare alla prossima, senza segnali.
//
// Chiudere la finestra con spostamenti non applicati li scarta, senza conferma:
// il servizio che ospita la finestra esce pochi secondi dopo la chiusura, e un
// dialogo aperto in quel momento può sparire col processo.
//
// NON gira dentro gnome-shell. La carica il servizio `org.gnome.Shell.Extensions`
// (`gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions`), un processo a
// parte: qui ci sono GTK4 e libadwaita, non St né i moduli
// `resource:///org/gnome/shell/ui/*`. Per questo non importa impl.js né menu.js,
// ma solo model.js e reorder.js, che usano soltanto GLib e Gio.
//
// Gli import locali sono statici, senza il token di cache-busting dei fratelli
// in impl.js: questo file stesso è importato senza query, quindi il token
// sarebbe vuoto. Non serve comunque: il servizio si chiude pochi secondi dopo
// la chiusura della finestra, e ogni apertura successiva rilegge i file da
// disco.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Model from './model.js';
import * as Reorder from './reorder.js';

const KEY = Model.HIDDEN_PROJECTS_KEY;

export default class CompassPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        // Id passato esplicitamente, come in impl.js: il metadata non è la
        // fonte di cui fidarsi sotto hot-reload.
        const settings = this.getSettings(Model.SETTINGS_SCHEMA_ID);

        const page  = new Adw.PreferencesPage({
            title: 'Progetti',
            icon_name: 'view-list-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Progetti nel menu',
            description: 'Spento: il progetto non ha una riga nel menu della top bar. ' +
                'Badge, suono e notifiche lo trattano come gli altri.\n' +
                'Le frecce spostano le righe; «Applica» scrive il nuovo ordine nel ' +
                'file di ogni progetto che cambia numero e lo committa nel suo repo, senza push.',
        });
        page.add(group);
        window.add(page);

        // id progetto → riga, per riallineare gli interruttori a un cambio
        // arrivato da fuori (un `dconf write`, o la chiave resettata).
        const rows = new Map();

        // Connesso PRIMA di leggere la chiave: GSettings emette `changed::` solo
        // per le chiavi lette almeno una volta con un handler già connesso.
        //
        // Il riallineamento tocca solo le righe che divergono: una riga che
        // cambia stato riscrive la chiave (vedi `setHidden`), e riscrivere un
        // valore identico non serve a niente.
        const changedId = settings.connect(`changed::${KEY}`, () => {
            const hidden = new Set(settings.get_strv(KEY));
            for (const [id, {row}] of rows) {
                const active = !hidden.has(id);
                if (row.active !== active) row.active = active;
            }
        });
        // Il Gio.Settings muore col processo, ma la finestra può chiudersi prima:
        // un handler rimasto appeso scriverebbe su righe già distrutte.
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });

        // Lo stesso lettore del menu, quindi lo stesso ordine: `order` del file
        // di progetto, poi l'id per chi non lo dichiara. I progetti nascosti ci
        // sono: anche un progetto nascosto è un vicino nel calcolo dei numeri.
        const registry = Model.loadLoomRegistry();
        if (registry.length === 0) {
            group.add(new Adw.ActionRow({
                title: 'Nessun progetto registrato',
                subtitle: 'Un progetto entra nel registry con loom-works init.',
            }));
            return;
        }

        const reorder = new ReorderControl(window, group, rows, registry);

        // Un id nascosto che non è più nel registry non ha riga: non ha emoji
        // né nome da mostrare, e resta nella chiave senza effetto.
        const hidden = new Set(settings.get_strv(KEY));
        for (const project of registry) {
            const row = new Adw.SwitchRow({
                title: `${project.emoji} ${project.name}`,
                subtitle: project.dir,
                // Nomi e percorsi sono testo, non markup: con il default
                // (markup attivo) un `&` nel nome svuoterebbe la riga.
                use_markup: false,
                active: !hidden.has(project.id),
            });
            row.connect('notify::active', () => setHidden(settings, project.id, !row.active));
            const up   = arrowButton('go-up-symbolic', 'Sposta su');
            const down = arrowButton('go-down-symbolic', 'Sposta giù');
            up.connect('clicked', () => reorder.move(project.id, -1));
            down.connect('clicked', () => reorder.move(project.id, +1));
            row.add_suffix(up);
            row.add_suffix(down);
            group.add(row);
            rows.set(project.id, {row, up, down, dir: project.dir});
        }
        reorder.refresh();
    }
}

// Il riordino: l'ordine delle righe, quello salvato, il bottone «Applica».
class ReorderControl {
    constructor(window, group, rows, registry) {
        this._window = window;
        this._group  = group;
        this._rows   = rows;
        this._saved  = registry.map(p => p.id);
        this._ids    = [...this._saved];
        this._busy   = false;

        this._apply = new Gtk.Button({
            label: 'Applica',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
            tooltip_text: 'Scrive il nuovo ordine nei file dei progetti e lo committa nei loro repo',
        });
        this._apply.connect('clicked', () => {
            this._applyOrder().catch(e => {
                logError(e, '[Compass] Applica');
                this._toast(`Applica fallito: ${e.message}`);
            });
        });
        group.set_header_suffix(this._apply);
    }

    // Sposta la riga di un posto. AdwPreferencesGroup non sa inserire una riga
    // a una posizione: si tolgono tutte e si rimettono nell'ordine nuovo. Il
    // fuoco torna sulla freccia appena premuta, o sull'altra quando la riga è
    // arrivata in cima o in fondo.
    move(id, delta) {
        if (this._busy) return;
        const i = this._ids.indexOf(id), j = i + delta;
        if (i < 0 || j < 0 || j >= this._ids.length) return;
        [this._ids[i], this._ids[j]] = [this._ids[j], this._ids[i]];
        for (const x of this._ids) this._group.remove(this._rows.get(x).row);
        for (const x of this._ids) this._group.add(this._rows.get(x).row);
        this.refresh();
        const {up, down} = this._rows.get(id);
        const pressed = delta < 0 ? up : down;
        (pressed.sensitive ? pressed : delta < 0 ? down : up).grab_focus();
    }

    refresh() {
        const last = this._ids.length - 1;
        this._ids.forEach((id, i) => {
            const {up, down} = this._rows.get(id);
            up.sensitive   = !this._busy && i > 0;
            down.sensitive = !this._busy && i < last;
        });
        this._apply.sensitive = !this._busy && !sameList(this._ids, this._saved);
    }

    async _applyOrder() {
        this._busy = true;
        this.refresh();
        try {
            // Il registry si rilegge adesso: i numeri si calcolano su quelli di
            // ora, non su quelli dell'apertura della finestra.
            const fresh = Model.loadLoomRegistry();
            if (!sameList([...fresh.map(p => p.id)].sort(), [...this._ids].sort())) {
                this._toast('Il registry è cambiato mentre la finestra era aperta: chiudila e riaprila.');
                return;
            }
            const orders = Reorder.computeOrders(
                fresh.map(p => ({id: p.id, order: p.order})), this._ids);
            if (orders.size > 0) {
                const outcome = await Reorder.applyOrders(fresh, orders);
                this._report(outcome);
            } else {
                this._toast('L\'ordine è già quello salvato: nessun file da scrivere.');
            }
            // L'ordine salvato è quello che il registry dice adesso: dopo
            // un'applicazione riuscita coincide con le righe e «Applica» si
            // spegne; dopo una annullata o interrotta resta acceso, e le righe
            // restano dove l'utente le ha messe.
            this._saved = Model.loadLoomRegistry().map(p => p.id);
        } finally {
            this._busy = false;
            this.refresh();
        }
    }

    // Un toast col riassunto; ogni eccezione resta scritta nel sottotitolo
    // della riga del suo progetto, al posto del percorso, finché la finestra è
    // aperta. Un toast sparisce da sé e se ne vede uno alla volta: da solo non
    // basterebbe a dire quale progetto è rimasto senza commit.
    _report({aborted, results}) {
        // Una riga toccata da questa applicazione riparte dal percorso: la nota
        // di un'applicazione precedente non vale più.
        for (const r of results) {
            const {row, dir} = this._rows.get(r.id);
            row.subtitle = r.error ? `⚠ ${r.error}`
                : r.note ? `ⓘ order ${r.order} — ${r.note}`
                : dir;
        }
        const failed = results.filter(r => r.error);
        if (aborted) {
            const f = failed[0];
            this._toast(`Niente scritto — ${f.name}: ${f.error}`);
            return;
        }
        const written   = results.filter(r => r.written).length;
        const committed = results.filter(r => r.committed).length;
        const noCommit  = results.filter(r => r.note).length;
        let text = `Ordine applicato: ${written} ${written === 1 ? 'progetto' : 'progetti'} ` +
            `con numero nuovo, ${committed} commit`;
        if (noCommit) text += `, ${noCommit} senza commit`;
        if (failed.length) text += ` — ${failed.length} con errore: ${failed.map(r => r.name).join(', ')}`;
        this._toast(text);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, use_markup: false, timeout: 6}));
    }
}

function arrowButton(icon, tooltip) {
    return new Gtk.Button({
        icon_name: icon,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
}

function sameList(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Aggiunge o toglie un id dalla lista dei nascosti, partendo dal valore ATTUALE
// della chiave e non da una copia tenuta dalla finestra: un id scritto da fuori
// mentre la finestra è aperta non va perso alla prima riga toccata.
function setHidden(settings, id, hide) {
    const current = settings.get_strv(KEY);
    if (current.includes(id) === hide) return;
    settings.set_strv(KEY, hide ? [...current, id] : current.filter(x => x !== id));
}
