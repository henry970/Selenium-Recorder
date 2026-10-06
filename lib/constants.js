/**
 * Shared constants for messaging between content script, background
 * service worker, and popup. Kept dependency-free so it can be loaded
 * as a plain <script> in the popup AND copy-referenced (values only)
 * inside content.js, which cannot use ES module imports as a
 * manifest-declared content script.
 */
const MSG = {
  STEP_RECORDED: 'STEP_RECORDED',
  START: 'START_RECORDING',
  PAUSE: 'PAUSE_RECORDING',
  RESUME: 'RESUME_RECORDING',
  STOP: 'STOP_RECORDING',
  CLEAR: 'CLEAR_RECORDING',
  GET_STATE: 'GET_STATE',
  STATE_CHANGED: 'STATE_CHANGED',
  UPDATE_STEPS: 'UPDATE_STEPS',
  REPLAY_START: 'REPLAY_START',
  REPLAY_STEP: 'REPLAY_STEP',
  REPLAY_STEP_RESULT: 'REPLAY_STEP_RESULT',
  REPLAY_PROGRESS: 'REPLAY_PROGRESS',
  REPLAY_DONE: 'REPLAY_DONE',
  PING: 'PING'
};

const RECORDER_STATE = {
  IDLE: 'idle',
  RECORDING: 'recording',
  PAUSED: 'paused'
};

const STEP_TYPES = {
  CLICK: 'click',
  INPUT: 'input',
  SELECT: 'select',
  KEYDOWN: 'keydown',
  NAVIGATE: 'navigate',
  WAIT: 'wait',
  SCROLL: 'scroll',
  SECTION: 'section',
  TAB_OPEN: 'tab_open',
  TAB_SWITCH: 'tab_switch',
  ASSERT: 'assert'
};

// Node-style export guard so the same file works when loaded as a
// plain <script> tag (popup.html) — it just defines globals.
if (typeof module !== 'undefined') {
  module.exports = { MSG, RECORDER_STATE, STEP_TYPES };
}
