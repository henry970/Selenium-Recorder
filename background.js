importScripts('lib/constants.js');

/**
 * Background service worker — single source of truth for:
 *   - current recorder state (idle / recording / paused)
 *   - the ordered list of recorded steps (works across tabs & reloads)
 *   - replaying a recorded session back to a tab
 *
 * Steps are persisted to chrome.storage.local so a popup close/reopen
 * or an accidental service-worker restart never loses progress.
 */

let state = RECORDER_STATE.IDLE;
let steps = [];
let recordingTabIds = new Set();
let lastKnownUrlByTab = new Map();
let lastActiveTabId = null;

async function persist() {
  await chrome.storage.local.set({ recorderState: state, recorderSteps: steps });
}

async function restore() {
  const data = await chrome.storage.local.get(['recorderState', 'recorderSteps']);
  state = data.recorderState || RECORDER_STATE.IDLE;
  steps = data.recorderSteps || [];
  for (const step of steps) {
    if (step.tabId == null) continue;
    recordingTabIds.add(step.tabId);
    lastActiveTabId = step.tabId;
    if (step.url) lastKnownUrlByTab.set(step.tabId, step.url);
  }
}
const restorationPromise = restore();

function broadcastStateToAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: MSG.STATE_CHANGED, state }, () => void chrome.runtime.lastError);
    }
  });
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: MSG.UPDATE_STEPS, steps, state }, () => void chrome.runtime.lastError);
}

function uid() {
  return 'step_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case MSG.GET_STATE: {
      restorationPromise
        .then(() => sendResponse({ state, steps }))
        .catch((error) => sendResponse({ error: `Recorder state could not be restored: ${error.message}` }));
      return true;
    }
    case MSG.START: {
      restorationPromise
        .then(() => startRecording(sendResponse))
        .catch((error) => sendResponse({ ok: false, error: `Recording could not start: ${error.message}` }));
      return true;
    }
    case MSG.PAUSE: {
      state = RECORDER_STATE.PAUSED;
      persist().then(() => {
        broadcastStateToAllTabs();
        notifyPopup();
      });
      sendResponse({ ok: true, state });
      return false;
    }
    case MSG.RESUME: {
      state = RECORDER_STATE.RECORDING;
      persist().then(() => {
        broadcastStateToAllTabs();
        notifyPopup();
      });
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          const activeTabId = tabs[0].id;
          if (!recordingTabIds.has(activeTabId) && lastActiveTabId != null) {
            recordingTabIds.add(activeTabId);
            addStep({ type: STEP_TYPES.TAB_OPEN, tabId: activeTabId, openerTabId: lastActiveTabId, timestamp: Date.now() });
            lastKnownUrlByTab.delete(activeTabId);
          }
          if (lastActiveTabId != null && lastActiveTabId !== activeTabId) {
            addStep({ type: STEP_TYPES.TAB_SWITCH, tabId: activeTabId, fromTabId: lastActiveTabId, timestamp: Date.now() });
          }
          recordingTabIds.add(activeTabId);
          lastActiveTabId = activeTabId;
        }
      });
      sendResponse({ ok: true, state });
      return false;
    }
    case MSG.STOP: {
      state = RECORDER_STATE.IDLE;
      persist().then(() => {
        broadcastStateToAllTabs();
        notifyPopup();
      });
      sendResponse({ ok: true, state, steps });
      return false;
    }
    case MSG.CLEAR: {
      steps = [];
      state = RECORDER_STATE.IDLE;
      persist().then(() => {
        broadcastStateToAllTabs();
        notifyPopup();
      });
      sendResponse({ ok: true });
      return false;
    }
    case MSG.STEP_RECORDED: {
      const frameId = sender.frameId != null ? sender.frameId : 0;
      const tabId = sender.tab ? sender.tab.id : msg.step.tabId;
      if (state === RECORDER_STATE.RECORDING && sender.tab) {
        if (!recordingTabIds.has(tabId)) {
          recordingTabIds.add(tabId);
          addStep({ type: STEP_TYPES.TAB_OPEN, tabId, openerTabId: lastActiveTabId, timestamp: Date.now() });
          if (lastActiveTabId != null && lastActiveTabId !== tabId) {
            addStep({ type: STEP_TYPES.TAB_SWITCH, tabId, fromTabId: lastActiveTabId, timestamp: Date.now() });
          }
          lastActiveTabId = tabId;
        }
        if (msg.step.url && lastKnownUrlByTab.get(tabId) !== msg.step.url) {
          lastKnownUrlByTab.set(tabId, msg.step.url);
          addStep({
            type: STEP_TYPES.NAVIGATE,
            value: msg.step.url,
            url: msg.step.url,
            pageTitle: msg.step.pageTitle,
            tabId,
            timestamp: Date.now()
          });
        }
      }
      addStep({ ...msg.step, frameId, tabId });
      sendResponse({ ok: true });
      return false;
    }
    case MSG.UPDATE_STEPS: {
      // Popup pushed an edited/reordered step list back to us.
      steps = msg.steps;
      persist().then(() => notifyPopup());
      sendResponse({ ok: true });
      return false;
    }
    case MSG.REPLAY_START: {
      replaySteps(msg.steps || steps)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    default:
      return false;
  }
});

function startRecording(sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    const tab = tabs[0];
    if (!tab || tab.id == null || !tab.url) {
      sendResponse({ ok: false, error: 'No active browser page is available to record.' });
      return;
    }
    if (/^(chrome|edge|about|devtools|chrome-extension):/i.test(tab.url)) {
      sendResponse({ ok: false, error: 'This browser page cannot be recorded. Open a website and try again.' });
      return;
    }

    state = RECORDER_STATE.RECORDING;
    recordingTabIds.clear();
    lastKnownUrlByTab.clear();
    recordingTabIds.add(tab.id);
    lastActiveTabId = tab.id;
    lastKnownUrlByTab.set(tab.id, tab.url);
    const initialStep = {
      type: STEP_TYPES.NAVIGATE,
      value: tab.url,
      url: tab.url,
      pageTitle: tab.title,
      tabId: tab.id,
      timestamp: Date.now()
    };
    addStep(initialStep);

    persist().then(() => {
      broadcastStateToAllTabs();
      notifyPopup();
      chrome.tabs.reload(tab.id, {}, () => {
        const reloadError = chrome.runtime.lastError;
        if (reloadError) {
          const errorMessage = reloadError.message;
          state = RECORDER_STATE.IDLE;
          recordingTabIds.clear();
          lastKnownUrlByTab.clear();
          lastActiveTabId = null;
          const stepIndex = steps.findIndex((step) =>
            step.type === initialStep.type &&
            step.tabId === initialStep.tabId &&
            step.timestamp === initialStep.timestamp
          );
          if (stepIndex !== -1) steps.splice(stepIndex, 1);
          persist().then(() => {
            broadcastStateToAllTabs();
            notifyPopup();
            sendResponse({ ok: false, error: `The browser page could not be refreshed: ${errorMessage}` });
          });
          return;
        }
        sendResponse({ ok: true, state });
      });
    }).catch((error) => {
      state = RECORDER_STATE.IDLE;
      recordingTabIds.clear();
      lastKnownUrlByTab.clear();
      lastActiveTabId = null;
      broadcastStateToAllTabs();
      notifyPopup();
      sendResponse({ ok: false, error: `Recording could not start: ${error.message}` });
    });
  });
}

function addStep(partialStep) {
  const last = steps[steps.length - 1];
  if (
    partialStep.type === STEP_TYPES.SELECT &&
    partialStep.multiple &&
    last &&
    last.type === STEP_TYPES.SELECT &&
    last.multiple &&
    JSON.stringify(last.locator) === JSON.stringify(partialStep.locator)
  ) {
    Object.assign(last, partialStep, { _addedAt: Date.now() });
    persist().then(() => notifyPopup());
    return;
  }
  // Deduplicate: skip if identical to the immediately preceding step
  // (e.g. duplicate click events firing from bubbling handlers).
  // Section markers are excluded — they carry no locator/value, so two
  // markers with different labels added close together would otherwise
  // look identical and the second one would be silently dropped.
  if (
    ![STEP_TYPES.SECTION, STEP_TYPES.TAB_OPEN, STEP_TYPES.TAB_SWITCH, STEP_TYPES.ASSERT].includes(partialStep.type) &&
    last &&
    last.type === partialStep.type &&
    JSON.stringify(last.locator) === JSON.stringify(partialStep.locator) &&
    last.value === partialStep.value &&
    Date.now() - (last._addedAt || 0) < 400
  ) {
    return;
  }
  const step = { id: uid(), ...partialStep, _addedAt: Date.now() };
  steps.push(step);
  persist().then(() => notifyPopup());
}

// Track full-page navigations (address bar, links causing full loads,
// history API) while recording, so the generated script reflects real
// page transitions instead of only clicks.
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (state !== RECORDER_STATE.RECORDING) return;
  const previous = lastKnownUrlByTab.get(details.tabId);
  lastKnownUrlByTab.set(details.tabId, details.url);
  if (details.url !== 'about:blank' && previous !== details.url && (previous || recordingTabIds.has(details.tabId))) {
    addStep({ type: STEP_TYPES.NAVIGATE, value: details.url, url: details.url, tabId: details.tabId, timestamp: Date.now() });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (state !== RECORDER_STATE.RECORDING) return;
  if (tab.openerTabId != null && recordingTabIds.has(tab.openerTabId)) {
    recordingTabIds.add(tab.id);
    addStep({ type: STEP_TYPES.TAB_OPEN, tabId: tab.id, openerTabId: tab.openerTabId, timestamp: Date.now() });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (state === RECORDER_STATE.RECORDING && tabId !== lastActiveTabId) {
    if (lastActiveTabId != null && (recordingTabIds.has(lastActiveTabId) || recordingTabIds.has(tabId))) {
      if (!recordingTabIds.has(tabId)) {
        recordingTabIds.add(tabId);
        addStep({ type: STEP_TYPES.TAB_OPEN, tabId, openerTabId: lastActiveTabId, timestamp: Date.now() });
        lastKnownUrlByTab.delete(tabId);
      }
      recordingTabIds.add(tabId);
      addStep({ type: STEP_TYPES.TAB_SWITCH, tabId, fromTabId: lastActiveTabId, timestamp: Date.now() });
    }
    lastActiveTabId = tabId;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  recordingTabIds.delete(tabId);
  lastKnownUrlByTab.delete(tabId);
});

// ---------------------------------------------------------------
// Replay orchestration: walks the step list, driving whichever tab
// is currently active. Navigation steps are executed via
// chrome.tabs.update (content script can't navigate itself).
// ---------------------------------------------------------------
async function replaySteps(stepList) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab to replay into.');
  const firstRecordedTabId = stepList.find((step) => step.tabId != null)?.tabId;
  const tabMap = new Map();
  if (firstRecordedTabId != null) tabMap.set(firstRecordedTabId, tab.id);
  const fallbackTabId = tab.id;

  for (let i = 0; i < stepList.length; i++) {
    const step = stepList[i];
    chrome.runtime.sendMessage({ type: MSG.REPLAY_PROGRESS, index: i, total: stepList.length, step }, () => void chrome.runtime.lastError);

    if (step.type === STEP_TYPES.TAB_OPEN) {
      let openedTab = null;
      if (step.openerTabId != null && tabMap.has(step.openerTabId)) {
        const candidates = await chrome.tabs.query({});
        openedTab = candidates.find((candidate) =>
          candidate.openerTabId === tabMap.get(step.openerTabId) &&
          !Array.from(tabMap.values()).includes(candidate.id)
        ) || null;
      }
      if (!openedTab) openedTab = await chrome.tabs.create({ active: false });
      tabMap.set(step.tabId, openedTab.id);
      continue;
    }
    if (step.type === STEP_TYPES.TAB_SWITCH) {
      const targetTabId = tabMap.get(step.tabId);
      if (targetTabId != null) await activateTab(targetTabId);
      continue;
    }

    const tabId = step.tabId != null ? (tabMap.get(step.tabId) || fallbackTabId) : fallbackTabId;
    if (step.type === STEP_TYPES.NAVIGATE) {
      await navigateAndWait(tabId, step.value);
      continue;
    }
    if (step.type === STEP_TYPES.SECTION) {
      continue; // codegen-only marker, nothing to replay in the page
    }
    await sendReplayStepWithRetry(tabId, step);
  }
  chrome.runtime.sendMessage({ type: MSG.REPLAY_DONE }, () => void chrome.runtime.lastError);
}

function activateTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { active: true }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 300); // let content script finish attaching
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function sendReplayStepWithRetry(tabId, step, attempt = 1) {
  const frameId = step.frameId != null ? step.frameId : 0;
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: MSG.REPLAY_STEP, step }, { frameId }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        if (attempt < 3) {
          setTimeout(() => sendReplayStepWithRetry(tabId, step, attempt + 1).then(resolve, reject), 500);
        } else {
          reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No response from page'));
        }
        return;
      }
      if (!resp.ok) {
        reject(new Error(resp.error || 'Replay step failed'));
        return;
      }
      resolve(resp.result);
    });
  });
}
