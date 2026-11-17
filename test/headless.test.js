// headless.test.js — collaudo della classe headless del registro in compass
// (T206): `registryClass`, il contatore `◐N` accanto al nome del progetto e la
// pinnata col turno `claude -p` in corso.
//
// Eseguire dalla root del repo:
//
//     gjs -m test/headless.test.js
//
// Nessun framework, come `twin-title.test.js`: il primo caso sbagliato lancia e
// `gjs -m` esce non-zero. Solo funzioni pure di `model.js`: la lettura del
// registro vero resta fuori dal collaudo automatico, e `menu.js` non si importa
// fuori da GNOME Shell (gi://St).

import * as Model from '../compass@lamemind/model.js';

function eq(actual, expected, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${label}: atteso ${e}, ottenuto ${a}`);
    print(`ok - ${label}`);
}

const {registryClass, pinnedForProject} = Model;

eq(registryClass({entrypoint: 'cli', kind: 'interactive'}), 'tab', 'cli interattiva → tab');
eq(registryClass({}), 'tab', 'campi assenti → tab, il menu non si svuota');
eq(registryClass({entrypoint: 'sdk-cli', kind: 'interactive'}), 'headless', 'claude -p → headless');
eq(registryClass({entrypoint: 'cli', kind: 'bg'}), null, 'job in background → fuori, anche con entrypoint cli');
eq(registryClass({entrypoint: 'sdk-cli', kind: 'bg'}), null, 'sdk-cli in background → fuori');
eq(registryClass({entrypoint: 'sdk', kind: 'interactive'}), null, 'subagent SDK → fuori');

const HOME = '/home/u';
const project = {id: 'p', dir: `${HOME}/proj`};
const at = (sessionId, cwd = `${HOME}/proj`) => ({sessionId, cwd, startedAt: 0});
const marks = new Map([
    ['viva',     {pinned: true, pinRank: 3}],
    ['headless', {pinned: true, pinRank: 2}],
    ['morta',    {pinned: true, pinRank: 1}],
    ['entrambe', {pinned: true, pinRank: 0}],
]);
const pinned = pinnedForProject(project, marks,
    [at('viva'), at('entrambe')],
    [at('headless'), at('entrambe'), at('altrove', '/altro')]);
const shape = pinned.map(p => [p.sessionId, Boolean(p.session), Boolean(p.headless)]);
eq(shape, [
    ['viva', true, false],
    ['headless', false, true],
    ['morta', false, false],
    ['entrambe', true, false],
], 'pinnata: viva, headless in corso, morta; la tab vince sul turno headless');
eq(pinnedForProject(project, marks, [], []).every(p => p.headless === null), true,
    'senza turni headless nessuna pinnata porta il campo');
