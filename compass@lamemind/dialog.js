// dialog.js — compass@lamemind — IL MODALE SULLA CONVERSAZIONE IN FOCUS
//
// Risoluzione del bersaglio (finestra in focus → conversazioni candidate) e il
// modale che agisce su di esso: disambiguazione quando le candidate sono più di
// una, pannello di edit di pin, nota e priorità.
//
// Quarto fratello del grafo dei moduli, accanto a menu.js:
//
//     impl.js  →  {menu.js, dialog.js}  →  {model.js, desktop.js}
//
// Sta fuori da menu.js e non dentro per due ragioni indipendenti: menu.js è già
// al limite della soglia di capienza, e il modale non condivide un solo widget
// col popup della top bar — sono due superfici con due cicli di vita.
//
// Come menu.js non importa `gi://GObject`: i widget dello shell si ISTANZIANO,
// e l'unica `GObject.registerClass` dell'estensione resta quella di impl.js, col
// suffisso monotonic nel `GTypeName` che rende ogni hot-reload un tipo distinto.
// Un secondo `registerClass` qui dovrebbe replicare quel trucco per non
// incappare in «Type name already registered» al primo reload.

// Token di cache-busting propagato ai fratelli: `import.meta.url` lo porta, un
// `import './x.js'` statico NO — il figlio resterebbe in cache per tutta la vita
// del processo gnome-shell, e `compass reload` ricaricherebbe un file su cinque
// producendo un grafo misto (impl nuovo + model vecchio) senza nessun errore.
const _Q = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const Model   = await import('./model.js'   + _Q);
const Desktop = await import('./desktop.js' + _Q);

// ── Risoluzione del bersaglio ────────────────────────────────────────────────

// Dalla finestra in focus all'insieme delle conversazioni candidate.
//
// La catena sfrutta un'ASIMMETRIA fra i due versi. Da una conversazione alla sua
// tab non si arriva — nessuna fonte lega le due cose, ed è la ragione per cui le
// righe-sessione del menu sono inerti. Dalla tab in focus alla conversazione sì,
// perché due fatti si incastrano: il titolo della finestra segue la tab davanti,
// e il nome con cui la conversazione è nata compone quel titolo.
//
// Ne discende che un'azione lanciata dal FOCUS può sapere su cosa agisce, mentre
// la stessa azione lanciata da una lista non può raggiungerla: sono due forme che
// abilitano funzioni diverse, non due strade per la stessa funzione.
//
// Composizione e nient'altro: i due pezzi che decidono stanno nei moduli foglia
// (`Desktop.projectForTitle`, `Model.sessionsByName`), che non si importano a
// vicenda e si collaudano ognuno per conto proprio. Qui si tiene solo la lettura
// di `global`, che è ciò che non si può collaudare fuori dallo shell — e anche
// quella entra per parametro, con un default, così la catena intera gira su una
// finestra finta.
//
// TRE esiti, e il chiamante li rende diversi:
//   - `project: null` → nessuna finestra di progetto loom in focus (browser,
//     editor, o nessuna finestra affatto);
//   - `project` valorizzato, `sessions: []` → la finestra è del progetto ma la
//     tab davanti non è una conversazione. Il caso normale è una tab deck o
//     terminal: il titolo porta la chiave del progetto (`🎴 <name> [deck]`), ma
//     nessuna sessione si chiama così. Non si ripiega sull'elenco di tutte le
//     conversazioni del progetto — sarebbe il menu della top bar dentro il
//     modale, e l'azione qui è sulla conversazione DAVANTI a te;
//   - una o N sessioni → il bersaglio, da disambiguare se più di una.
//
// Le conversazioni dei worktree lane restano fuori, e non per una svista del
// filtro: `sessionsForProject` scarta i `cwd` fuori da `project.dir`, e una lane
// è una directory sorella. Anche includendola, il sidecar che il deck di quella
// lane legge sta sotto la root della lane — una scrittura keyed sul progetto
// finirebbe in un file che nessun lettore della lane apre.
export function focusedSessions(
    loomRegistry, liveSessions, win = global.display.get_focus_window()
) {
    const title   = win?.get_title() ?? '';
    const project = title ? Desktop.projectForTitle(title, loomRegistry) : null;
    if (!project) return {title, project: null, sessions: []};
    const sessions = Model.sessionsByName(
        Model.sessionsForProject(project, liveSessions), title
    );
    return {title, project, sessions};
}
