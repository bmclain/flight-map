#!/usr/bin/env node
// Makes a pretend air traffic control recording about the planes Look Up can
// see right now, and drops it into the radio inbox, to try out the radio
// feature without a receiver (works with the simulator too).
//
// Needs espeak-ng and ffmpeg; scripts/atc-test-calls.sh runs it in a throwaway
// Docker container that has both.
//
//   node scripts/atc-test-calls.js [look-up URL] [inbox folder] [how many planes]
//   node scripts/atc-test-calls.js http://localhost:8095 /opt/usenet/config/look-up/atc/inbox 3
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url = 'http://localhost:8080', inbox = 'data/atc/inbox', howMany = '3'] = process.argv.slice(2);

const DIGIT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const NATO = {
  A: 'Alpha',
  B: 'Bravo',
  C: 'Charlie',
  D: 'Delta',
  E: 'Echo',
  F: 'Foxtrot',
  G: 'Golf',
  H: 'Hotel',
  I: 'India',
  J: 'Juliett',
  K: 'Kilo',
  L: 'Lima',
  M: 'Mike',
  N: 'November',
  O: 'Oscar',
  P: 'Papa',
  Q: 'Quebec',
  R: 'Romeo',
  S: 'Sierra',
  T: 'Tango',
  U: 'Uniform',
  V: 'Victor',
  W: 'Whiskey',
  X: 'X-ray',
  Y: 'Yankee',
  Z: 'Zulu',
};
const digits = (s) => [...String(s)].map((c) => DIGIT[c] ?? NATO[c] ?? c).join(' ');
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** How the plane is called on the radio, or null if we can't say. */
function callsignWords(ac) {
  const flight = /^([A-Z]{3})(\d+[A-Z]?)$/.exec(ac.callsign ?? '');
  if (flight && ac.airline?.radio) return `${titleCase(ac.airline.radio)} ${digits(flight[2])}`;
  const reg = (ac.reg ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (/^C[FG][A-Z]{3}$/.test(reg)) return digits(reg.slice(1)); // Canadian: Foxtrot Alpha Romeo Charlie
  if (reg.length >= 3) return digits(reg);
  return null;
}

/** A short exchange that fits what the plane is doing. */
function exchange(ac, facility) {
  const cs = callsignWords(ac);
  const alt = ac.altFt ?? 10000;
  const heading = String((Math.round(((ac.trackDeg ?? 270) + 20) / 10) * 10) % 360).padStart(3, '0');
  if ((ac.vertRateFpm ?? 0) < -300 && alt < 6000) {
    return [
      `${cs}, ${facility} tower, wind two seven zero at eight, runway two seven, cleared to land.`,
      `Cleared to land runway two seven, ${cs}.`,
    ];
  }
  if ((ac.vertRateFpm ?? 0) > 300 && alt < 15000) {
    return [`${cs}, contact Edmonton centre one three two decimal five, good day.`, `Over to centre, good day, ${cs}.`];
  }
  const target = Math.max(3000, Math.round((alt - 4000) / 1000) * 1000);
  return [
    `${cs}, ${facility} terminal, turn left heading ${digits(heading)}, descend and maintain ${digits(target / 1000)} thousand.`,
    `Left heading ${digits(heading)}, down to ${digits(target / 1000)} thousand, ${cs}.`,
  ];
}

const config = (await (await fetch(`${url}/api/config`)).json()).config;
const facility = config.atc?.facility || 'Saskatoon';
const { aircraft } = await (await fetch(`${url}/api/aircraft`)).json();
const picked = aircraft
  .filter((a) => !a.onGround && a.distanceKm <= config.display.cycleRangeKm && callsignWords(a))
  .slice(0, Number(howMany));
if (!picked.length) {
  console.error('No planes in range with a callsign the radio would use. Try again in a minute.');
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-test-'));
const parts = [];
for (const ac of picked) {
  for (const line of exchange(ac, facility)) {
    const wav = path.join(work, `${parts.length}.wav`);
    execFileSync('espeak-ng', ['-v', 'en-us', '-s', '165', '-w', wav, line]);
    parts.push(wav);
    console.log(`${ac.flight || ac.callsign}: ${line}`);
  }
}
// Two seconds of quiet between calls, then a radio-ish sound: narrow band and a little hiss.
const gap = path.join(work, 'gap.wav');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-t', '2', '-i', 'anullsrc=r=22050:cl=mono', gap]);
const list = path.join(work, 'list.txt');
fs.writeFileSync(list, parts.flatMap((p) => [`file '${p}'`, `file '${gap}'`]).join('\n'));
const out = path.join(work, 'calls.mp3');
execFileSync('ffmpeg', [
  '-loglevel',
  'error',
  '-y',
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  list,
  '-f',
  'lavfi',
  '-i',
  'anoisesrc=color=pink:amplitude=0.01',
  '-filter_complex',
  '[0:a]highpass=f=300,lowpass=f=3000,volume=2[v];[v][1:a]amix=inputs=2:duration=first',
  '-ar',
  '16000',
  '-ac',
  '1',
  '-b:a',
  '32k',
  out,
]);
// Copy in under a temporary name and rename, so Look Up never reads half a file.
fs.mkdirSync(inbox, { recursive: true });
const name = `test-calls-${Date.now()}.mp3`;
fs.copyFileSync(out, path.join(inbox, `.${name}.part`));
fs.renameSync(path.join(inbox, `.${name}.part`), path.join(inbox, name));
console.log(`\nDropped ${name} into ${inbox}. The calls show up on those planes' cards in about 10–20 seconds.`);
