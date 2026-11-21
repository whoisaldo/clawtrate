// Every word the reading of an action uses (docs/design/conversation.md,
// sections 5, 7 and 8), in one place, so they can be translated later. The
// reading (`actions.ts`) chooses which entry applies and fills in what the
// call acted on; nothing else in the engine writes a word of an action card.
//
// A verb entry is the running, done and failed forms of one operation, in
// that order: "Reading", "Read", "Couldn't read".

export type VerbForms = readonly [running: string, done: string, failed: string];

const v = (running: string, done: string, failed: string): VerbForms => [running, done, failed];

/** The verb of each operation. */
export const VERBS = {
  read: v("Reading", "Read", "Couldn't read"),
  list: v("Looking in", "Looked in", "Couldn't open"),
  edit: v("Editing", "Edited", "Couldn't edit"),
  create: v("Creating", "Created", "Couldn't create"),
  patch: v("Applying", "Applied", "Couldn't apply"),
  memorySave: v("Saving to", "Saved to", "Couldn't save to"),
  memoryRead: v("Reading a note from memory:", "Read from memory:", "Couldn't read from memory:"),
  memorySearch: v("Searching memory for", "Searched memory for", "Couldn't search memory for"),
  run: v("Running", "Ran", "Couldn't run"),
  lookAt: v("Looking at", "Looked at", "Couldn't look at"),
  readTerminal: v("Reading", "Read", "Couldn't read"),
  resize: v("Resizing", "Resized", "Couldn't resize"),
  close: v("Closing", "Closed", "Couldn't close"),
  typeInto: v("Typing into", "Typed into", "Couldn't type into"),
  use: v("Using", "Used", "Couldn't use"),
  webSearch: v("Searching the web for", "Searched the web for", "Couldn't search the web for"),
  xSearch: v(
    "Searching posts on X for",
    "Searched posts on X for",
    "Couldn't search posts on X for",
  ),
  open: v("Opening", "Opened", "Couldn't open"),
  readPage: v("Reading", "Read", "Couldn't use"),
  take: v("Taking", "Took", "Couldn't use"),
  click: v("Clicking", "Clicked", "Couldn't use"),
  upload: v("Uploading", "Uploaded", "Couldn't use"),
  answer: v("Answering", "Answered", "Couldn't use"),
  clickOn: v("Clicking on", "Clicked on", "Couldn't use"),
  doubleClickOn: v("Double-clicking on", "Double-clicked on", "Couldn't use"),
  dragOn: v("Dragging on", "Dragged on", "Couldn't use"),
  type: v("Typing", "Typed", "Couldn't use"),
  press: v("Pressing", "Pressed", "Couldn't use"),
  scroll: v("Scrolling", "Scrolled", "Couldn't use"),
  hand: v("Handing you", "Handed you", "Couldn't use"),
  tapOn: v("Tapping on", "Tapped on", "Couldn't use"),
  enterTextOn: v("Entering text on", "Entered text on", "Couldn't use"),
  swipeOn: v("Swiping on", "Swiped on", "Couldn't use"),
  waitOn: v("Waiting on", "Waited on", "Couldn't use"),
  change: v("Changing", "Changed", "Couldn't change"),
  createRoutine: v("Creating routine", "Created routine", "Couldn't create routine"),
  changeRoutine: v("Changing routine", "Changed routine", "Couldn't change routine"),
  removeRoutine: v("Removing routine", "Removed routine", "Couldn't remove routine"),
  remove: v("Removing", "Removed", "Couldn't remove"),
  runRoutine: v("Running routine", "Ran routine", "Couldn't run routine"),
  propose: v("Proposing", "Proposed", "Couldn't propose"),
  wake: v("Waking", "Woke", "Couldn't wake"),
  lookThrough: v("Looking through", "Looked through", "Couldn't look through"),
  searchTasks: v("Searching tasks for", "Searched tasks for", "Couldn't search tasks for"),
  check: v("Checking", "Checked", "Couldn't check"),
  waitFor: v("Waiting for", "Waited for", "Couldn't wait for"),
  stopHelper: v("Stopping", "Asked to stop", "Couldn't stop"),
  redirect: v("Redirecting", "Redirected", "Couldn't redirect"),
  startHelper: v("Starting", "Started a helper:", "Couldn't start"),
  ask: v("Asking you", "Asked you", "Couldn't ask"),
  set: v("Setting", "Set", "Couldn't set"),
  mark: v("Marking", "Marked", "Couldn't mark"),
  makePlan: v("Making", "Made", "Couldn't save"),
  savePlan: v("Saving", "Saved", "Couldn't save"),
  clearPlan: v("Clearing", "Cleared", "Couldn't clear"),
  message: v("Messaging", "Messaged", "Couldn't message"),
  make: v("Making", "Made", "Couldn't make"),
  send: v("Sending", "Message on", "Couldn't send on"),
} as const;

export type VerbId = keyof typeof VERBS;

/** Objects the reading names in words rather than taking from the call. */
export const OBJECTS = {
  t3Code: "T3 Code",
  anotherBot: "another bot",
  memory: "memory",
  aCommand: "a command",
  code: "code",
  sharedTerminals: "shared terminals",
  aTerminal: "a terminal",
  aSharedTerminal: "a shared terminal",
  thePage: "the page",
  aScreenshot: "a screenshot",
  anElement: "an element",
  aField: "a field",
  aFile: "a file",
  aDialog: "a dialog",
  theBrowser: "the browser",
  theScreen: "the screen",
  theComputer: "the computer",
  aKey: "a key",
  thePhone: "the phone",
  aButton: "a button",
  theControlUi: "the Control UI",
  aRoutine: "a routine",
  routines: "routines",
  theScheduler: "the scheduler",
  tasks: "tasks",
  aTask: "a task",
  bots: "bots",
  thisTaskStatus: "this task's status",
  helpers: "helpers",
  aHelper: "a helper",
  untitled: "untitled",
  aQuestion: "a question",
  aGoal: "a goal",
  theGoal: "the goal",
  aPlan: "a plan",
  thePlan: "the plan",
  aVoiceClip: "a voice clip",
  aConversation: "a conversation",
  aPatch: "a patch",
  aFolder: "a folder",
  result: "result",
} as const;

/** "the next check in 30m". */
export const nextCheck = (when: string) => (when ? `the next check in ${when}` : "the next check");
/** "Otto's task". */
export const someonesTask = (name: string) => `${name}'s task`;
/** "the goal completed". */
export const theGoalStatus = (status: string) => (status ? `the goal ${status}` : "the goal");
/** "image models", "image generation". */
export const mediaModels = (one: string) => `${one} models`;
export const mediaGeneration = (one: string) => `${one} generation`;
/** "an image", "a video", "2 images". */
export const mediaCount = (n: number, one: string, many: string) =>
  n > 1 ? `${n} ${many}` : `${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`;

/** The kinds of generated media: the singular, the plural, and the noun for a call. */
export const MEDIA: Record<string, readonly [one: string, many: string, noun: string]> = {
  image_generate: ["image", "images", "Image"],
  video_generate: ["video", "videos", "Video"],
  music_generate: ["track", "tracks", "Track"],
};

/** Forms for outcomes the verb table does not give. */
export const FORMS = {
  wantsToRun: "Wants to run",
  reviewing: "Reviewing",
  started: "Started",
  startedMaking: "Started making",
  startedHelper: "Started a helper:",
  askedRoutine: "Asked routine",
  toRun: (object: string) => `${object} to run`,
  left: "Left",
  unchanged: (object: string) => `${object} unchanged`,
  foundNo: "Found no",
  foundNoNote: "Found no note",
  inMemory: (object: string) => `${object} in memory`,
  foundNoRoutine: "Found no routine",
  toRemove: (object: string) => `${object} to remove`.trim(),
  didnt: "Didn't",
  didntRun: "Didn't run",
  didntRead: "Didn't read",
  didntSearchTasks: "Didn't search tasks for",
  didntStartHelper: "Didn't start a helper:",
  didntLookAt: "Didn't look at",
  didntSend: "Didn't send a message on",
  didntUse: "Didn't use",
  notRun: "Not run:",
  stopped: "Stopped",
  noResult: "No result:",
  blockedByPolicy: "Blocked by policy",
  blockedByReview: "Blocked by review",
  timedOut: "Timed out:",
  cutOff: "Cut off:",
  itsLimit: (seconds: number | null) => (seconds ? `its ${seconds}s limit` : "its time limit"),
  runLimit: "the run's time limit",
  wouldDo: (effect: string) => `would ${effect}`,
  pagesAsked: (pages: string) => `pages ${pages}`,
  ofDone: (done: number, all: number) => `${done} of ${all} done`,
  exit: (code: number) => `exit ${code}`,
  toWhom: (to: string, text: string) => (to ? `to ${to}: ${text}` : text),
  mayBeStale: "may be out of date",
  httpStatus: (status: number) => `HTTP ${status}`,
  shown: "shown",
  hidden: "hidden",
} as const;

/** Nouns: a call whose effect leaves the gateway, while open or when its result proves nothing more. */
export const NOUNS = {
  helper: "Helper",
  /** The Messaged cards' words while a call is open (sections 10 and 11). */
  messaging: "Messaging",
  forATask: "for a task",
  waitFor: "Wait for",
  stopFor: "Stop for",
  redirectFor: "Redirect for",
  voiceClip: "Voice clip",
  messageOn: "Message on",
  toolServer: "Tool server",
  callTo: "Call to",
  findNothingWith: "Found nothing with",
} as const;

/** The state word at the right of a card, for each outcome that has one. */
export const STATE_WORDS = {
  /** A read the tool says returned nothing of an empty file. */
  emptyFile: "Empty file",
  /** A read whose image the tool says it left out for the model. */
  omitted: "Omitted",
  /** A command the gateway returned to the background. */
  stillRunning: "Still running",
  /** A message sent whose reply did not come in its time. */
  sentNoReply: "Sent · no reply in time",
  /** A routine that finished with no record of its run to read. */
  finishedOutcomeUnknown: "Finished · outcome not known",
  /** A result whose stored text the gateway cut: what the cut part said is not known. */
  storedCut: "Stored result cut",
  /** A read whose result says it returned no contents of the file. */
  noContents: "No contents",
  callStarted: "Call started",
  waitingForYou: "Waiting for you",
  waitingForApproval: "Waiting for approval",
  lastSeenRunning: "Last seen running",
  lastSeenCallStarted: "Last seen: call started",
  partial: "Partial",
  started: "Started",
  queued: "Queued",
  callMade: "Call made",
  notConfirmed: "Not confirmed",
  noChange: "No change",
  notFound: "Not found",
  notRun: "Not run",
  suppressed: "Suppressed",
  unavailable: "Unavailable",
  failed: "Failed",
  timedOut: "Timed out",
  aborted: "Aborted",
  denied: "Denied",
  expired: "Expired",
  stopped: "Stopped",
  unknown: "Unknown",
  needsConfirmation: "Needs confirmation",
  tooMany: "Too many",
  unsupported: "Unsupported",
  sent: "Sent",
  replied: "Replied",
  answered: "Answered",
} as const;

/** The problem words of a fold's counts and the run line, in their fixed order (7.4). */
export const PROBLEM_WORDS = {
  failed: "failed",
  notRun: "not run",
  unavailable: "unavailable",
  notFound: "not found",
  suppressed: "suppressed",
  stopped: "stopped",
  unknown: "unknown",
} as const;

/** Settled outcomes short of Done, counted after the problems, in their fixed order (7.4). */
export const SHORT_WORDS = {
  started: "started",
  queued: "queued",
  notConfirmed: "not confirmed",
  callMade: "call made",
  noChange: "no change",
  partial: "partial",
} as const;

/** What an opened card says about an outcome short of Done (8.1, "Opened"). */
export const OUTCOME_SENTENCES = {
  started:
    "The gateway admitted this and runs it in the background. What it makes arrives as a later message.",
  queued: "Queued: it runs when its turn comes. Nothing here says it has run.",
  made: "The call returned. Its result does not say whether the work was done.",
  unconfirmed: "The action ran, but its effect was not seen on the screen.",
  suppressed: "The gateway chose not to deliver this message.",
  partial: "Only part of the work was done.",
  unchanged: "The gateway reports that nothing changed.",
  notfound: "What was asked for was not there.",
  refused: "Nothing was done.",
} as const;

/** "1 file", "2 files". */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Plurals of a fold, and the neutral nouns that claim nothing (7.4). */
export const PLURALS = {
  files: (n: number) => count(n, "file", "files"),
  reads: (n: number) => count(n, "read", "reads"),
  edits: (n: number) => count(n, "edit", "edits"),
  times: (n: number) => count(n, "time", "times"),
  calls: (n: number) => count(n, "call", "calls"),
  actions: (n: number) => count(n, "action", "actions"),
  folders: (n: number) => count(n, "folder", "folders"),
  commands: (n: number) => count(n, "command", "commands"),
  pages: (n: number) => count(n, "page", "pages"),
  notes: (n: number) => count(n, "note", "notes"),
  questions: (n: number) => count(n, "question", "questions"),
  voiceClips: (n: number) => count(n, "voice clip", "voice clips"),
  pdfs: (n: number) => count(n, "PDF", "PDFs"),
  images: (n: number) => count(n, "image", "images"),
  helpers: (n: number) => count(n, "helper", "helpers"),
  tasks: (n: number) => count(n, "task", "tasks"),
  results: (n: number) => count(n, "result", "results"),
  matches: (n: number) => count(n, "match", "matches"),
  sources: (n: number) => count(n, "source", "sources"),
  lines: (n: number) => count(n, "line", "lines"),
  steps: (n: number) => count(n, "step", "steps"),
  hours: (n: number) => count(n, "hour", "hours"),
  minutes: (n: number) => count(n, "minute", "minutes"),
  made: "Made",
  readPdfs: "Read PDFs",
  lookedAtImages: "Looked at images",
  searchedTheWeb: "Searched the web",
  searchedX: "Searched posts on X",
  searchedMemory: "Searched memory",
  readFromMemory: "Read from memory",
  usedTheBrowser: "Used the browser",
  usedTheComputer: "Used the computer",
  usedThePhone: "Used the phone",
  changedTheControlUi: "Changed the Control UI",
  lookedAtRoutines: "Looked at routines",
  usedHelpers: "Used helpers",
  savedThePlan: "Saved the plan",
  messagedOnAChannel: "Messaged on a channel",
  saved: "Saved",
  toMemory: (notes: string) => `${notes} to memory`,
  used: (what: string) => `Used ${what}`,
} as const;

/** Each kind's neutral noun: the operation, claiming no outcome (7.4). */
export const NEUTRAL = {
  read: "File reads",
  list: "Folder listings",
  edit: "File edits",
  memory: "Memory notes",
  memorySearch: "Memory search",
  memoryRead: "Memory reads",
  command: "Commands",
  terminal: "Terminal actions",
  web: "Web search",
  xsearch: "Search on X",
  page: "Page fetches",
  browser: "Browser actions",
  computer: "Computer actions",
  phone: "Phone",
  screen: "Control UI changes",
  routine: "Routine look-ups",
  tasks: "Task look-ups",
  helper: "Helpers",
  question: "Questions",
  plan: "Plan updates",
  speech: "Speech",
  pdf: "PDF reading",
  image: "Image viewing",
  channel: "Messages on channels",
  toolServer: (server: string) => `Tool server ${server}`,
  mediaModels: (noun: string) => `${noun} models`,
  mediaStatus: (noun: string) => `${noun} status`,
  mediaGeneration: (noun: string) => `${noun} generation`,
} as const;

/** The status line's phrases (section 5). */
export const PHRASES = {
  thinking: "Thinking",
  reviewing: "Reviewing a command",
  settingUp: "Setting up the workspace",
  gathering: "Gathering context",
  waitingForYou: "Waiting for you",
  waitingForAnswer: "Waiting for an answer",
  stopping: "Stopping…",
  reconnecting: (last: string) => `Reconnecting. Last seen ${last}`,
  /** The person closed the connection; nothing is coming until they reconnect. */
  disconnected: (last: string) => `Disconnected. Last seen ${last}`,
  /** A reply is streaming and no tool runs. */
  writing: "Writing",
} as const;

/** The run line (7.7). */
export const RUN_LINE = {
  worked: (after: string | null) => (after ? `Worked for ${after}` : "Worked"),
  stopped: (after: string | null) => (after ? `Stopped after ${after}` : "Stopped"),
  failed: (after: string | null) => (after ? `Failed after ${after}` : "Failed"),
  failedCount: (n: number) => `${n} failed`,
  /** The run line's record: the effort the task asks for, or that none is reported. */
  effort: (level: string | null) => (level ? `requested effort ${level}` : "effort not reported"),
  modelNotReported: "model not reported",
  actions: (n: number) => `${n} ${n === 1 ? "action" : "actions"}`,
  /** Of the run's actions, those kept here when some were not. */
  shown: (n: number) => `${n} shown`,
  /** In line, where actions the run reported are not kept here. */
  notKept: (n: number) =>
    `${n} ${n === 1 ? "action" : "actions"} not kept here; the gateway's transcript still has ${n === 1 ? "it" : "them"}`,
  problem: {
    unavailable: (n: number) => `${n} unavailable`,
    suppressed: (n: number) => `${n} not sent`,
    stopped: (n: number) => `${n} stopped`,
    unknown: (n: number) => `${n} unknown`,
  },
} as const;

/** The "Thought" line (7.5). */
export const thoughtFor = (duration: string | null) =>
  duration ? `Thought for ${duration}` : "Thought";

/** "48s", "1m 12s", "1h 04m": a duration the gateway reported (7.7). */
export function durationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 === 0 ? `${minutes}m` : `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "0.6s", "12s": an action's duration on its line. */
export function tookWords(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** "0:42": time elapsed while something runs. */
export function elapsedWords(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "0.6 seconds", for an accessible name. */
export const spokenSeconds = (ms: number) => tookWords(ms).replace(/s$/, " seconds");

/** A routine's schedule (8.2). */
export const SCHEDULE = {
  gatewayTime: "gateway's time",
  every: (hours: number, minutes: number) =>
    hours >= 1 ? `every ${PLURALS.hours(hours)}` : `every ${PLURALS.minutes(minutes)}`,
  weekdays: ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"],
  everyDay: "Every day",
  at: (day: string, time: string) => `${day} at ${time}`,
} as const;

/** Labels of the readable view's rows (8.1, "Opened"). */
export const LABELS = {
  file: "File",
  files: "Files",
  note: "Note",
  folder: "Folder",
  entries: "Entries",
  change: "Change",
  changeLines: (added: number, removed: number) => `${added} lines added, ${removed} removed`,
  added: "Added",
  saved: "Saved",
  query: "Query",
  theNote: "The note",
  matches: "Matches",
  command: "Command",
  runsOn: "Runs on",
  gatewayHost: "the gateway's host",
  output: "Output",
  outputSoFar: "Output so far",
  result: "Result",
  error: "Error",
  exitCode: "Exit code",
  action: "Action",
  terminal: "Terminal",
  results: "Results",
  address: "Address",
  title: "Title",
  status: "Status",
  text: "Text",
  target: "Target",
  typed: "Typed",
  effect: "Effect",
  effects: {
    confirmed: "confirmed",
    unverifiable: "could not be checked",
    suspected_noop: "no change was seen",
  } as Record<string, string>,
  needsConfirmation: "Needs confirmation",
  deviceSaid: "Device said",
  routine: "Routine",
  schedule: "Schedule",
  does: "Does",
  objective: "Objective",
  gatewaySaid: "What the gateway said",
  next: "Next",
  prompt: "Prompt",
  pages: "Pages",
  input: "Input",
  made: "Made",
  channel: "Channel",
  to: "To",
  server: "Server",
  tool: "Tool",
  gatewayCallsIt: "The gateway calls it",
  question: "Question",
  plan: "Plan",
  noResult: "The gateway sent no result for this action.",
  noOutputYet: "No output yet.",
  nothingUntilReturn: "Nothing more is reported until the call returns.",
  unavailableBecause: (why: string) => `${why}`,
  memoryUnavailable: (why: string) => `Memory search is unavailable: ${why}`,
  noReason: "the gateway gave no reason",
  fromHistory: "Rebuilt from the gateway's history, which did not keep this action's details.",
} as const;
