"use strict";

const WORD_LIST = {
  2: [
    "OW", "AH", "GO", "NO",
  ],
  3: [
    "HIT", "RUN", "DIE", "CRY", "BAD", "ROT", "UGH",
    "AIM", "FOG", "WAR", "NIX", "SIN", "DIM", "BOO",
    "EEK", "CUT", "FOE", "ZAP", "DOT",
  ],
  4: [
    "KILL", "SHOT", "DEAD", "RAWR", "OUCH", "SLAY",
    "MAIM", "DARK", "LAMP", "FIRE", "BURN", "ARGH",
    "DOOM", "HUNT", "FEAR", "BOOM", "BANG", "JOLT",
    "BEEP", "BOOP", "DASH", "EVIL", "VOID"
  ],
  5: [
    "FIEND", "BRUTE", "HORDE", "BLOOD", "DECAY",
    "SHOOT", "BLAST", "TORCH", "FLARE", "FIGHT",
    "NIGHT", "LIGHT", "SKULL", "CURSE", "DEATH",
    "SWARM", "ALARM", "BLEED", "PANIC", "SLAIN",
    "QUAKE", "QUELL", "QUICK", "EXILE"
  ],
  6: [
    "SIGNAL", "STRIKE", "ATTACK", "ESCAPE", "BATTLE",
    "DAMAGE", "DANGER", "TARGET", "ASSAIL", "BEHEAD",
    "MENACE", "AVENGE",
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
