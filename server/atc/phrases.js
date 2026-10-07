// Recognises the common phrases in tower, ground and approach transmissions
// and says what they mean in plain words. Works on normalised text from
// speech.js ("cleared to land runway 27"). Used as the summary when Claude
// isn't set up, and passed to Claude as hints when it is.

const RWY = '(?:runway|rwy) ([0-3]?\\d[lrc]?)';
// Who a plane is passed on to, in words an onlooker knows (and immune to
// garbled place names: "Edmont and Centre").
const FACILITY_WORDS = {
  tower: 'the tower',
  ground: 'ground control',
  centre: 'the en-route controllers',
  center: 'the en-route controllers',
  departure: 'departure control',
  arrival: 'approach control',
  approach: 'approach control',
  terminal: 'approach control',
};
const feet = (n) => `${Number(n).toLocaleString('en-US')} ft`;

/**
 * Rules in order of how much they tell an onlooker. Each has a pattern and
 * a function from its match to { kind, text } (text = what's happening, said
 * plainly; written for the aircraft, whoever is speaking).
 */
const RULES = [
  [
    /\b(?:go(?:ing)? around|pull up and go around)\b/,
    () => ({ kind: 'go-around', text: 'Going around — aborting the landing' }),
  ],
  [
    new RegExp(`\\bcleared to land(?: ${RWY})?|${RWY},? cleared to land`),
    (m) => ({ kind: 'land', text: `Cleared to land${runway(m[1] ?? m[2])}` }),
  ],
  [
    new RegExp(
      `\\bcleared (?:for )?(?:the )?(?:take ?off|takeoff)(?: ${RWY})?|${RWY},? cleared (?:for )?(?:take ?off|takeoff)`,
    ),
    (m) => ({ kind: 'takeoff', text: `Cleared for take-off${runway(m[1] ?? m[2], 'from')}` }),
  ],
  [
    new RegExp(`\\b(?:line|lie|lined) up and wait(?: ${RWY})?|${RWY},? (?:line|lie) up and wait`),
    (m) => ({ kind: 'line-up', text: `Lining up on the runway${runway(m[1] ?? m[2], 'for')} to wait for take-off` }),
  ],
  [
    new RegExp(
      `\\bcleared (?:for )?(?:the |an? )?(ils|rnav|gnss|visual|localizer|loc|vor|rnp)?\\s?approach(?: ${RWY})?`,
    ),
    (m) => ({
      kind: 'approach',
      text: `Cleared for the ${m[1] ? `${approachName(m[1])} ` : ''}approach${runway(m[2], 'to')}`,
    }),
  ],
  [
    /\b(?:runway (?:vacated|clear)|clear of (?:the )?runway)\b/,
    () => ({ kind: 'vacated', text: 'Landed and turning off the runway' }),
  ],
  [
    new RegExp(`\\bhold short (?:of )?${RWY}`),
    (m) => ({ kind: 'hold-short', text: `Holding short of runway ${m[1].toUpperCase()}` }),
  ],
  [
    new RegExp(`\\btaxi (?:to |via )?(?:${RWY}|(?:the )?(apron|ramp|gate|terminal|hangar|fbo))`),
    (m) => ({
      kind: 'taxi',
      text: m[1] ? `Taxiing out to runway ${m[1].toUpperCase()}` : `Taxiing in to the ${m[2]}`,
    }),
  ],
  [/\brequest(?:ing)? taxi\b/, () => ({ kind: 'taxi-request', text: 'Asking to taxi out for departure' })],
  [/\bready (?:for departure|for take ?off|to go)\b/, () => ({ kind: 'ready', text: 'Ready for take-off' })],
  [
    /\bcontact (?:\w+ ){0,2}?(tower|ground|centre|center|departure|arrival|approach|terminal)\b/,
    (m) => ({ kind: 'handoff', text: `Handed over to ${FACILITY_WORDS[m[1]]}` }),
  ],
  [
    /\b(?:turn (left|right) )?heading (\d{3})\b/,
    (m) => ({ kind: 'heading', text: m[1] ? `Turning ${m[1]} to heading ${m[2]}` : `Flying heading ${m[2]}` }),
  ],
  [
    /\b(climb|descend)(?:ing)?(?: and maintain| to)? (?:flight level (\d{2,3})|(\d{3,5}))\b/,
    (m) => ({
      kind: m[1],
      text: `${m[1] === 'climb' ? 'Climbing' : 'Descending'} to ${m[2] ? `flight level ${m[2]}` : feet(m[3])}`,
    }),
  ],
  [/\b(?:traffic|caution wake turbulence)\b/, () => ({ kind: 'traffic', text: 'Told about other traffic nearby' })],
  [
    /\b(?:radar (?:contact|identified)|identified)\b/,
    () => ({ kind: 'radar-contact', text: 'Picked up on radar by the controller' }),
  ],
  [/\bsquawk (\d{4})\b/, (m) => ({ kind: 'squawk', text: `Given transponder code ${m[1]}` })],
  [
    /\b(\d{1,2}) (?:mile|miles|nm) (final|north|south|east|west|northeast|northwest|southeast|southwest)\b/,
    (m) => ({ kind: 'position', text: m[2] === 'final' ? `${m[1]} miles out on final` : `${m[1]} miles ${m[2]}` }),
  ],
  [
    /\b(left|right) (base|downwind)\b/,
    (m) => ({ kind: 'circuit', text: `Flying the ${m[1]} ${m[2]} leg of the circuit` }),
  ],
  [
    /\b(?:inbound|joining|landing) (?:with|for)\b|\bfor landing\b/,
    () => ({ kind: 'inbound', text: 'Calling in to land' }),
  ],
];

const runway = (r, prep = 'on') => (r ? ` ${prep} runway ${r.toUpperCase()}` : '');
const approachName = (a) => ({ localizer: 'localizer', loc: 'localizer', visual: 'visual' })[a] ?? a.toUpperCase();

/** Everything recognised in one transmission, most telling first. */
export function intents(normalized) {
  const out = [];
  for (const [re, fn] of RULES) {
    const m = re.exec(normalized);
    if (m) out.push(fn(m));
  }
  return out;
}

/**
 * One line for the card from an aircraft's recent transmissions (oldest
 * first): the most telling thing said in the latest exchange.
 */
export function ruleSummary(transmissions) {
  const recent = transmissions
    .slice(-3)
    .reverse()
    .filter((t) => t.intents?.length);
  // The controller's instruction says it best; a readback often drops words.
  const t = recent.find((x) => x.role === 'to') ?? recent[0];
  if (!t) return null;
  const [first, second] = t.intents;
  return second ? `${first.text}, ${second.text[0].toLowerCase()}${second.text.slice(1)}` : first.text;
}
