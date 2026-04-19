"use strict";

const WORD_LIST = {
  2: [
    "AH", "GO", "NO", "OW",
  ],
  3: [
    "AIM", "BAD", "BOO", "CRY", "CUT", "DIE",
    "DIM", "DOT", "EEK", "FOE", "FOG", "HIT",
    "NIX", "RUN", "SIN", "UGH", "WAR", "ZAP",
  ],
  4: [
    "ARGH", "BANG", "BEEP", "BOOM", "BOOP", "BURN",
    "DARK", "DASH", "DEAD", "DOOM", "EVIL", "FEAR",
    "FIRE", "HUNT", "JOLT", "KILL", "LAMP", "MAIM",
    "OUCH", "RAWR", "SHOT", "SLAY", "VOID",
  ],
  5: [
    "ALARM", "BLAST", "BLEED", "BLOOD", "BRUTE", "DEATH",
    "DECAY", "EXILE", "FIEND", "FIGHT", "FLARE", "HORDE",
    "LIGHT", "NIGHT", "PANIC", "QUAKE", "QUELL", "QUICK",
    "SHOOT", "SKULL", "SWARM", "TORCH",
  ],
  6: [
    "ASSAIL", "ATTACK", "AVENGE", "BATTLE", "DAMAGE", "DANGER",
    "ESCAPE", "MENACE", "SIGNAL", "STRIKE", "TARGET",
  ],
};

function wordsOfLengths(lengths) {
  const out = [];
  for (const L of lengths) if (WORD_LIST[L]) out.push(...WORD_LIST[L]);
  return out;
}

const WORDS_2   = wordsOfLengths([2]);
const WORDS_3_4 = wordsOfLengths([3, 4]);
const WORDS_5_6 = wordsOfLengths([5, 6]);
