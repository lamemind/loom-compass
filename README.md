# loom-compass

Estensione GNOME Shell: **radar cross-desktop** dei progetti e delle sessioni
[Claude Code](https://claude.com/claude-code) aperte. Vive nella top bar e risponde
alla domanda *«dove sono?»* su tutti i desktop contemporaneamente — con focus
cross-desktop funzionante anche su Wayland.

Membro della famiglia **loom**, insieme a
[`loom-works-plugin`](https://github.com/lamemind/loom-works-plugin) (il plugin
Claude Code che definisce il contratto) e
[`loom-deck`](https://github.com/lamemind/loom-deck) (deck TUI per-progetto).
Il cappello che li aggrega è [`loom-works`](https://github.com/lamemind/loom-works).

## Modello

Ogni progetto è un **cappello** nel menu; sotto vivono le **surface** — i modi di
essere presenti nel progetto:

```
🧵 loom-works                    ← cappello (progetto)
  ├─ claude  #1  🟢 running      ┐ tracked: stato live, match finestra, click→focus
  ├─ claude  #2  🟡 ask          │
  ├─ deck        ○ open          ┘
  └─ codium      (apri)          ← launch: comando arbitrario @project-root
```

Il cappello mostra **un solo** pallino, per **rollup** degli stati figli con
priorità `ask > done > running > idle` — un figlio che ti aspetta vince su tutto.

## Componenti

| Path | Cosa |
| --- | --- |
| `compass@lamemind/` | l'estensione GNOME (UUID dir, installabile via symlink) |
| `compass@lamemind/extension.js` | **stub-loader** sottile: re-importa `impl.js` con cache-busting a ogni `enable()` |
| `compass@lamemind/impl.js` | la logica vera (indicatore, menu, D-Bus, registry) |
| `bin/compass` | bridge CLI: hook di stato Claude → D-Bus + `reload` |

**Perché lo stub-loader**: GNOME Shell tiene `extension.js` in cache nel module
loader e non lo rilegge senza restart dello shell — che su Wayland significa
**relogin**. Lo stub è un guscio che a ogni `enable()` importa `impl.js` con una
query monotonic (`?v=…`): URL nuovo → il loader lo rilegge da disco. Risultato:
si itera sul codice con un `disable && enable`, senza relogin.

## Installazione

```bash
git clone https://github.com/lamemind/loom-compass.git
ln -s "$PWD/loom-compass/compass@lamemind" ~/.local/share/gnome-shell/extensions/compass@lamemind
ln -s "$PWD/loom-compass/bin/compass"      ~/.local/bin/compass
gnome-extensions enable compass@lamemind
```

Il symlink (invece della copia) tiene **una sola** fonte di verità: editi il repo,
`compass reload`, fatto.

### Hook di stato

Il pallino si popola dagli hook di Claude Code (`~/.claude/settings.json`), che
annunciano lo stato della sessione via D-Bus:

```jsonc
{ "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "compass running" }] }],
    "Notification":    [{ "hooks": [{ "type": "command", "command": "compass ask"     }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "compass done"    }] }],
    "SessionEnd":      [{ "hooks": [{ "type": "command", "command": "compass end"     }] }]
}}
```

Lo stato è **keyed su `$PTYXIS_PROFILE`**, non sul titolo della finestra: il
titolo è posseduto da `claude --name`, quindi non può portare anche lo stato →
serve un canale separato. Fuori da Ptyxis la variabile non esiste e l'hook esce
silenzioso, senza rompere la sessione.

## Registry — due layer, in coesistenza

L'estensione legge i progetti da **due** sorgenti, in ordine:

| | `projects.json` (legacy) | registry dconf (loom) |
| --- | --- | --- |
| Dove | `compass@lamemind/projects.json` | `/org/lamemind/loom/projects/<id>/` |
| Chi scrive | `compass add` (rimosso da questo repo) | `loom-works init` (loom-works-plugin) |
| Stato | in dismissione | **corrente** |
| Versionato | ❌ gitignorato (path di lavoro + UUID locali) | — (per-macchina) |

`projects.json` **non è nel repo**: contiene path di lavoro e UUID di profili
Ptyxis, roba per-macchina che non appartiene a un repo pubblico. Il modello è
`compass@lamemind/projects.example.json`.

Il layer loom è la direzione: l'identità del progetto sta in un file committabile
nel repo del progetto (`.claude/loom-works.json`), da cui `loom-works init`
**registra** il progetto nel registry dconf. La `label` di match è **derivata**
(`{emoji} {owner} {name}`), mai scritta a mano in più posti.

### Come compass legge dconf

Via **CLI `dconf dump /org/lamemind/loom/`** (`impl.js`, `_dconfDump`), non via
`DConf.Client`: il typelib GJS di DConf non è installato di default su Fedora
Workstation, quindi l'introspezione non è disponibile. Conseguenza pratica:
**niente `.watch()`** → nessuna notifica live sui cambi. Il registry viene
riletto **all'apertura del menu**, che per un indicatore top-bar è indistinguibile
dal live. Se un giorno il typelib entra tra le dipendenze, `DConf.Client` +
signal `changed` è un drop-in che elimina la rilettura.

> ⚠️ `gsettings` **non** funziona su questi path: sono dconf raw, senza schema
> GSettings installata. Serve `dconf` (CLI) o `DConf.Client` (GJS).

## Storia del repo

Il codice ha vissuto fino al 2026-07 dentro un repo privato di configurazione
macchina, come sottocartella. La migrazione qui è un **import pulito** (nessuna
history riscritta): la storia originale era di poche decine di commit, con
messaggi legati a task di quel repo, e conteneva `projects.json` con path e nomi
di lavoro reali — pubblicarla avrebbe richiesto comunque una riscrittura
espurgante. Il valore archeologico non giustificava il rischio.

## Licenza

MIT — vedi [LICENSE](LICENSE).
