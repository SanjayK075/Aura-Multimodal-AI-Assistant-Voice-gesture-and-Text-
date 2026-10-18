/**
 * Spoken commands that control the interface itself.
 *
 * These are matched in the browser and never reach the language model, so
 * "close that" is instant and costs no quota. A phrase only counts as a
 * command when the *whole* utterance matches; "close that" is a command but
 * "close that chapter of history for me" is a question for the model.
 */

export type DrawerName = "history" | "activity" | "settings" | "help";
export type Direction = "left" | "right" | "up" | "down";
export type QuickName = "weather" | "github" | "news" | "wikipedia" | "space";

export type VoiceCommand =
  | { type: "close" }
  | { type: "closeAll" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "bigger" }
  | { type: "smaller" }
  | { type: "move"; direction: Direction }
  | { type: "pin" }
  | { type: "unpin" }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "stop" }
  | { type: "openDrawer"; drawer: DrawerName }
  | { type: "closeDrawer" }
  | { type: "camera"; on: boolean }
  | { type: "stopListening" }
  | { type: "newConversation" }
  | { type: "quick"; action: QuickName };

const IT = "(?:it|that|this|the panel|that panel|this panel)";
// Words people put in front of a command: "no, I need to open the GitHub panel".
const LEAD = "(?:(?:no|yes|yeah|so|just|ok|okay|please|can you|could you|i need to|i want to|i would like to|i'd like to|let me|let's) )*";
const QUICK = "(weather|github|news|wikipedia|space)";

const RULES: [RegExp, (match: RegExpMatchArray) => VoiceCommand][] = [
  [/^(?:clear|close|dismiss|remove|hide) (?:all|everything|all panels|all the panels|the screen|them all)$/, () => ({ type: "closeAll" })],
  [/^clear (?:all )?(?:the )?(?:screen|panels)$/, () => ({ type: "closeAll" })],
  [new RegExp(`^(?:close|dismiss|hide|remove) ${IT}$`), () => ({ type: "close" })],
  [/^(?:next|next page|page down|scroll down|show more)$/, () => ({ type: "next" })],
  [/^(?:previous|previous page|page up|scroll up|back|go back)$/, () => ({ type: "previous" })],
  [new RegExp(`^(?:make ${IT} )?(?:bigger|larger)$|^(?:enlarge|zoom in)(?: (?:on )?${IT})?$`), () => ({ type: "bigger" })],
  [new RegExp(`^(?:make ${IT} )?smaller$|^(?:shrink|zoom out)(?: (?:of )?${IT})?$`), () => ({ type: "smaller" })],
  [
    new RegExp(`^move (?:${IT} )?(?:to the )?(left|right|up|down)$`),
    (m) => ({ type: "move", direction: m[1] as Direction }),
  ],
  [new RegExp(`^pin ${IT}$`), () => ({ type: "pin" })],
  [new RegExp(`^unpin ${IT}$`), () => ({ type: "unpin" })],
  [/^(?:mute|be quiet|quiet|silence)$/, () => ({ type: "mute" })],
  [/^(?:unmute|speak again|you can speak)$/, () => ({ type: "unmute" })],
  [
    /^(?:stop|stop talking|stop speaking|stop it|stop that|stop now|ok stop|okay stop|enough|that's enough|that is enough|cancel|never mind|hold on|wait|pause)$/,
    () => ({ type: "stop" }),
  ],
  // Panel shortcuts. "open the github panel" runs the GitHub button. A bare "show me the news" is
  // deliberately not here: that is a question for the model.
  [
    new RegExp(`^${LEAD}(?:open|launch|bring up|go to|switch to)(?: me)?(?: the| my)? ${QUICK}(?: panel| button| tab| widget)?$`),
    (m) => ({ type: "quick", action: m[1] as QuickName }),
  ],
  [
    new RegExp(`^${LEAD}(?:show|display)(?: me)?(?: the| my)? ${QUICK} (?:panel|button|tab|widget)$`),
    (m) => ({ type: "quick", action: m[1] as QuickName }),
  ],
  [new RegExp(`^${LEAD}(?:the )?${QUICK} (?:panel|button)$`), (m) => ({ type: "quick", action: m[1] as QuickName })],
  [
    /^(?:open|show)(?: me)?(?: the| my)? (history|activity|activity log|settings|help)$/,
    (m) => ({ type: "openDrawer", drawer: (m[1] === "activity log" ? "activity" : m[1]) as DrawerName }),
  ],
  [/^close(?: the)? (?:drawer|history|activity|activity log|settings|help)$/, () => ({ type: "closeDrawer" })],
  [/^(?:turn |switch )?(?:the )?camera (on|off)$/, (m) => ({ type: "camera", on: m[1] === "on" })],
  [/^(?:turn|switch) (on|off) (?:the )?camera$/, (m) => ({ type: "camera", on: m[1] === "on" })],
  [/^(?:stop listening|mic off|microphone off|turn off the (?:mic|microphone))$/, () => ({ type: "stopListening" })],
  [/^(?:new chat|new conversation|start over|start a new conversation)$/, () => ({ type: "newConversation" })],
];

/** Lower-case, strip punctuation and a leading "please" or "hey Aura". */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:hey|ok|okay) )?(?:aura|ora) /, "")
    .replace(/^please /, "")
    .replace(/ please$/, "")
    .trim();
}

export function parseVoiceCommand(text: string): VoiceCommand | null {
  const phrase = normalise(text);
  if (!phrase) return null;
  for (const [pattern, build] of RULES) {
    const match = phrase.match(pattern);
    if (match) return build(match);
  }
  return null;
}

/** True for phrases that should interrupt Aura while it is talking: stop, mute and mic off. */
export function isStopPhrase(text: string): boolean {
  const type = parseVoiceCommand(text)?.type;
  return type === "stop" || type === "mute" || type === "stopListening";
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Is this just the microphone picking up Aura's own voice? While and just after Aura
 * speaks, a transcript made mostly of words from the reply is the reply, not a request.
 */
export function isEcho(heard: string, spoken: string): boolean {
  const heardWords = words(heard);
  if (heardWords.length < 2 || !spoken) return false;
  const known = new Set(words(spoken));
  const shared = heardWords.filter((word) => known.has(word)).length;
  return shared / heardWords.length >= 0.7;
}

/**
 * In hands-free mode the microphone hears everything, including throat
 * clearing transcribed as "uh". Only send something to the model if it looks
 * like a deliberate request.
 */
export function looksLikeRequest(text: string, confidence: number): boolean {
  const words = normalise(text).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  if (confidence > 0 && confidence < 0.45) return false;
  if (words.length === 1) return /^(?:weather|news|headlines|time|date|help)$/.test(words[0]!);
  return true;
}
