// collaudo.js — compass@lamemind — IL COLLAUDO DEL FOCUS NELLA SESSIONE REALE
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
//
// L'indicatore arriva per argomento: il modulo non importa né lo shell né i
// fratelli, e lo chiama `CompassImpl.enable`.

import GLib from 'gi://GLib';

const COLLAUDO_FILE   = 'compass-collaudo.json';
const COLLAUDO_STEP_S = 3;

// → gli id dei timer ancora in attesa, che `disable` toglie.
export function collaudoProbe(indicator) {
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
