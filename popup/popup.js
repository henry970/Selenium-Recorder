let currentState = RECORDER_STATE.IDLE;
let currentSteps = [];
let dragFromIndex = null;

const el = (id) => document.getElementById(id);

function isSensitiveInput(step) {
  return (step.type === 'input' || step.type === 'select') &&
    Boolean(step.isSecret);
}

const ICONS = {
  click: '🖱',
  input: '⌨',
  select: '▾',
  keydown: '⏎',
  navigate: '🌐',
  wait: '⏱',
  scroll: '↕',
  section: '✂',
  tab_open: '↗',
  tab_switch: '⇄',
  assert: '✓'
};
let previewFiles = null;

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  chrome.runtime.sendMessage({ type: MSG.GET_STATE }, (resp) => {
    if (resp) {
      currentState = resp.state;
      currentSteps = resp.steps || [];
      render();
    }
  });
  await loadSavedRecordingsList();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.UPDATE_STEPS) {
    currentSteps = msg.steps;
    currentState = msg.state;
    render();
  }
  if (msg.type === MSG.REPLAY_PROGRESS) {
    showReplayProgress(msg.index, msg.total, msg.step);
  }
  if (msg.type === MSG.REPLAY_DONE) {
    hideReplayProgress();
  }
});

// ---------------------------------------------------------------
// Control buttons
// ---------------------------------------------------------------
el('btnRecord').addEventListener('click', () => {
  el('btnRecord').disabled = true;
  chrome.runtime.sendMessage({ type: MSG.START }, (response) => {
    if (chrome.runtime.lastError) {
      alert(`Recording could not start: ${chrome.runtime.lastError.message}`);
    } else if (!response || !response.ok) {
      alert(response && response.error ? response.error : 'Recording could not start.');
    } else {
      currentState = response.state;
    }
    render();
  });
});
el('btnPause').addEventListener('click', () => chrome.runtime.sendMessage({ type: MSG.PAUSE }, (r) => { currentState = r.state; render(); }));
el('btnResume').addEventListener('click', () => chrome.runtime.sendMessage({ type: MSG.RESUME }, (r) => { currentState = r.state; render(); }));
el('btnStop').addEventListener('click', () => chrome.runtime.sendMessage({ type: MSG.STOP }, (r) => { currentState = r.state; currentSteps = r.steps; render(); }));
el('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
el('btnClear').addEventListener('click', () => {
  if (currentSteps.length && !confirm('Clear all recorded steps?')) return;
  chrome.runtime.sendMessage({ type: MSG.CLEAR }, () => { currentSteps = []; currentState = RECORDER_STATE.IDLE; render(); });
});
el('btnReplay').addEventListener('click', () => {
  if (!currentSteps.length) return;
  const errors = validateSteps(currentSteps).filter((issue) => issue.severity === 'error');
  if (errors.length) {
    alert(errors.map((issue) => `Step ${issue.index + 1}: ${issue.message}`).join('\n'));
    return;
  }
  el('btnReplay').disabled = true;
  chrome.runtime.sendMessage({ type: MSG.REPLAY_START, steps: currentSteps }, (response) => {
    el('btnReplay').disabled = false;
    hideReplayProgress();
    if (chrome.runtime.lastError) alert(`Replay could not start: ${chrome.runtime.lastError.message}`);
    else if (response && !response.ok) alert(`Replay failed: ${response.error}`);
  });
});
el('btnAddSection').addEventListener('click', () => {
  const input = el('sectionLabel');
  const label = input.value.trim();
  if (!label) {
    input.focus();
    return;
  }
  chrome.runtime.sendMessage({
    type: MSG.STEP_RECORDED,
    step: { type: STEP_TYPES.SECTION, label, description: label }
  });
  input.value = '';
});
el('btnAddWait').addEventListener('click', () => {
  const duration = Number(el('waitDuration').value);
  if (!Number.isFinite(duration) || duration < 0) {
    el('waitDuration').focus();
    return;
  }
  addManualStep({ type: STEP_TYPES.WAIT, value: String(duration), description: `${duration} ms` });
});
el('btnAddAssertion').addEventListener('click', () => {
  const selector = el('assertionLocator').value.trim();
  if (!selector) {
    el('assertionLocator').focus();
    return;
  }
  const assertion = el('assertionType').value;
  addManualStep({
    type: STEP_TYPES.ASSERT,
    assertion,
    expectedText: el('assertionText').value,
    locator: { strategy: 'css', value: selector },
    description: assertion === 'text' ? `Text "${el('assertionText').value}"` : `Element ${assertion}`
  });
});
function addManualStep(step) {
  chrome.runtime.sendMessage({ type: MSG.STEP_RECORDED, step });
}

function showReplayProgress(index, total, step) {
  el('replayProgress').classList.remove('hidden');
  const pct = Math.round(((index + 1) / total) * 100);
  el('replayBarFill').style.width = pct + '%';
  el('replayProgressLabel').textContent = `Step ${index + 1}/${total}: ${step.type} ${step.description || step.value || ''}`;
}
function hideReplayProgress() {
  el('replayProgress').classList.add('hidden');
  el('replayBarFill').style.width = '0%';
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------
function render() {
  renderStatus();
  renderButtons();
  renderSteps();
}

function renderStatus() {
  const dot = el('statusDot');
  dot.className = 'dot ' + (currentState === RECORDER_STATE.RECORDING ? 'recording' : currentState === RECORDER_STATE.PAUSED ? 'paused' : '');
  el('statusLabel').textContent = currentState[0].toUpperCase() + currentState.slice(1);
}

function renderButtons() {
  const isRecording = currentState === RECORDER_STATE.RECORDING;
  const isPaused = currentState === RECORDER_STATE.PAUSED;
  const isIdle = currentState === RECORDER_STATE.IDLE;
  el('btnRecord').disabled = isRecording || isPaused;
  el('btnPause').disabled = !isRecording;
  el('btnResume').disabled = !isPaused;
  el('btnStop').disabled = isIdle;
  const hasInvalidSteps = validateSteps(currentSteps).some((issue) => issue.severity === 'error');
  el('btnReplay').disabled = currentSteps.length === 0 || isRecording || hasInvalidSteps;
  el('btnClear').disabled = currentSteps.length === 0;
  el('sectionMarkerRow').classList.toggle('hidden', !isRecording);
}

function renderSteps() {
  const list = el('stepsList');
  list.innerHTML = '';
  el('stepCount').textContent = currentSteps.length;
  el('emptyState').classList.toggle('hidden', currentSteps.length > 0);

  const tpl = el('stepTemplate');
  const issues = validateSteps(currentSteps);
  const issueByIndex = new Map();
  for (const issue of issues) {
    if (!issueByIndex.has(issue.index)) issueByIndex.set(issue.index, []);
    issueByIndex.get(issue.index).push(issue);
  }
  const summary = el('validationSummary');
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  summary.classList.toggle('hidden', issues.length === 0);
  summary.replaceChildren();
  if (issues.length) {
    const line = document.createElement('div');
    line.textContent = `${errors.length} error(s), ${warnings.length} locator warning(s). Fix errors before replay or export.`;
    summary.appendChild(line);
    for (const issue of errors) {
      const detail = document.createElement('div');
      detail.textContent = `Step ${issue.index + 1}: ${issue.message}`;
      summary.appendChild(detail);
    }
  }
  currentSteps.forEach((step, idx) => {
    const node = tpl.content.cloneNode(true);
    const li = node.querySelector('.step-item');
    li.dataset.index = idx;
    const stepIssues = issueByIndex.get(idx) || [];
    if (stepIssues.some((issue) => issue.severity === 'error')) li.classList.add('invalid');
    else if (stepIssues.length) li.classList.add('warning');
    node.querySelector('.step-index').textContent = idx + 1;
    node.querySelector('.step-icon').textContent = ICONS[step.type] || '•';
    node.querySelector('.step-title').textContent = titleFor(step);
    node.querySelector('.step-meta').textContent = metaFor(step);

    const input = node.querySelector('.step-value-input');
    const secretToggle = node.querySelector('.step-secret-toggle');
    const secretCheckbox = node.querySelector('.step-secret-input');
    const sensitiveInput = isSensitiveInput(step);
    input.type = sensitiveInput ? 'password' : 'text';
    input.value = step.type === 'assert'
      ? (step.expectedText || '')
      : (Array.isArray(step.value) ? step.value.join(', ') : (step.value != null ? step.value : ''));
    if (step.type === 'input') {
      secretToggle.classList.remove('hidden');
      secretCheckbox.checked = sensitiveInput;
      secretCheckbox.disabled = false;
      secretCheckbox.title = 'Marked secret values are masked and exported through environment variables. Values remain in the local recording for replay.';
      secretCheckbox.addEventListener('change', () => {
        step.isSecret = secretCheckbox.checked;
        pushStepsUpdate();
        renderSteps();
      });
    }
    input.addEventListener('change', () => {
      if (step.type === 'assert') step.expectedText = input.value;
      else if (Array.isArray(step.value)) {
        step.value = input.value.split(',').map((value) => value.trim()).filter(Boolean);
        step.selectedValues = step.value.slice();
      } else if (step.value != null) step.value = input.value;
      pushStepsUpdate();
      renderSteps();
    });
    const locatorInput = node.querySelector('.step-locator-input');
    locatorInput.value = step.locator ? step.locator.value : '';
    locatorInput.placeholder = `CSS locator (${step.locator ? step.locator.strategy : 'missing'})`;
    locatorInput.classList.add('hidden');
    locatorInput.addEventListener('change', () => {
      if (!step.locator) step.locator = { strategy: 'css', value: locatorInput.value };
      else step.locator.value = locatorInput.value;
      pushStepsUpdate();
      renderSteps();
    });

    node.querySelector('.step-edit').addEventListener('click', () => {
      input.classList.toggle('hidden');
      locatorInput.classList.toggle('hidden');
      if (step.type === 'input') secretToggle.classList.toggle('hidden');
      if (!input.classList.contains('hidden')) input.focus();
    });
    node.querySelector('.step-delete').addEventListener('click', () => {
      currentSteps.splice(idx, 1);
      pushStepsUpdate();
      renderSteps();
      renderButtons();
    });

    li.addEventListener('dragstart', () => { dragFromIndex = idx; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const toIndex = Number(li.dataset.index);
      if (dragFromIndex === null || dragFromIndex === toIndex) return;
      const [moved] = currentSteps.splice(dragFromIndex, 1);
      currentSteps.splice(toIndex, 0, moved);
      dragFromIndex = null;
      pushStepsUpdate();
      renderSteps();
    });

    list.appendChild(node);
  });
}

function titleFor(step) {
  if (step.type === 'navigate') return `Navigate → ${truncate(step.value, 40)}`;
  if (step.type === 'tab_open') return 'Open a new tab';
  if (step.type === 'tab_switch') return 'Switch browser tab';
  if (step.type === 'assert') return `Check ${step.assertion}: "${step.description || ''}"`;
  if (step.type === 'section') return `New section: "${step.label || step.description || ''}"`;
  if (step.type === 'keydown') return `Press ${step.key} on "${step.description || ''}"`;
  if (step.type === 'scroll') return `Scroll ${step.direction || ''} on "${step.description || 'page'}"`;
  const verb = { click: 'Click', input: step.viaPaste ? 'Paste into' : 'Type into', select: 'Select in', wait: 'Wait' }[step.type] || step.type;
  return `${verb} "${step.description || ''}"`;
}
function metaFor(step) {
  const parts = [];
  if (step.type === 'section') return 'starts a new page/class in the export';
  if (step.type === 'scroll') {
    parts.push(`to (${step.scrollX}, ${step.scrollY})`);
    return parts.join('  ·  ');
  }
  if (step.locator) parts.push(`${step.locator.strategy}: ${truncate(step.locator.value, 35)}`);
  if (isSensitiveInput(step)) parts.push('sensitive value hidden');
  else if (step.value != null && step.type !== 'navigate') parts.push(`value: ${truncate(String(step.value), 25)}`);
  return parts.join('  ·  ');
}
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

function pushStepsUpdate() {
  chrome.runtime.sendMessage({ type: MSG.UPDATE_STEPS, steps: currentSteps });
}

// ---------------------------------------------------------------
// Save / Load recordings
// ---------------------------------------------------------------
async function loadSavedRecordingsList() {
  const data = await chrome.storage.local.get(['savedRecordings']);
  const saved = data.savedRecordings || {};
  const select = el('savedRecordings');
  select.innerHTML = '';
  const names = Object.keys(saved);
  if (!names.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No saved recordings';
    opt.disabled = true;
    select.appendChild(opt);
    return;
  }
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (${saved[name].steps.length} steps)`;
    select.appendChild(opt);
  });
}

el('btnSave').addEventListener('click', async () => {
  const name = el('recordingName').value.trim();
  if (!name) return alert('Enter a name for this recording.');
  if (!currentSteps.length) return alert('Nothing to save yet.');
  const data = await chrome.storage.local.get(['savedRecordings']);
  const saved = data.savedRecordings || {};
  saved[name] = { steps: currentSteps, createdAt: Date.now() };
  await chrome.storage.local.set({ savedRecordings: saved });
  el('recordingName').value = '';
  await loadSavedRecordingsList();
});

el('btnLoad').addEventListener('click', async () => {
  const name = el('savedRecordings').value;
  if (!name) return;
  const data = await chrome.storage.local.get(['savedRecordings']);
  const saved = data.savedRecordings || {};
  if (!saved[name]) return;
  currentSteps = JSON.parse(JSON.stringify(saved[name].steps));
  pushStepsUpdate();
  render();
});

el('btnDeleteSaved').addEventListener('click', async () => {
  const name = el('savedRecordings').value;
  if (!name) return;
  if (!confirm(`Delete saved recording "${name}"?`)) return;
  const data = await chrome.storage.local.get(['savedRecordings']);
  const saved = data.savedRecordings || {};
  delete saved[name];
  await chrome.storage.local.set({ savedRecordings: saved });
  await loadSavedRecordingsList();
});

// ---------------------------------------------------------------
// Export
// ---------------------------------------------------------------
el('btnExport').addEventListener('click', async () => {
  if (!currentSteps.length) return alert('Record some steps first.');
  const issues = validateSteps(currentSteps);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length) {
    alert(errors.map((issue) => `Step ${issue.index + 1}: ${issue.message}`).join('\n'));
    return;
  }
  const data = await chrome.storage.local.get(['settings']);
  const settings = data.settings || {};
  const browsers = (settings.browsers && settings.browsers.length) ? settings.browsers : ['chrome', 'edge', 'firefox'];
  const config = {
    projectName: el('projectName').value.trim() || 'recorded_automation',
    baseUrl: (currentSteps.find((s) => s.type === 'navigate') || {}).value,
    initialTabId: (currentSteps.find((s) => s.tabId != null) || {}).tabId,
    browsers,
    testRunner: el('testRunner').value,
    screenshots: settings.screenshots !== false,
    logging: settings.logging !== false
  };
  const style = el('framework').value;
  previewFiles = style === 'linear' ? buildLinearProject(currentSteps, config) : buildPOMProject(currentSteps, config);
  const select = el('previewFiles');
  select.replaceChildren();
  for (const path of Object.keys(previewFiles)) {
    const option = document.createElement('option');
    option.value = path;
    option.textContent = path;
    select.appendChild(option);
  }
  const warningBox = el('previewWarnings');
  warningBox.replaceChildren();
  for (const issue of issues.filter((item) => item.severity === 'warning')) {
    const line = document.createElement('div');
    line.className = 'warning';
    line.textContent = `Step ${issue.index + 1}: ${issue.message}`;
    warningBox.appendChild(line);
  }
  renderPreviewFile();
  el('previewDialog').showModal();
});

el('previewFiles').addEventListener('change', renderPreviewFile);
el('btnClosePreview').addEventListener('click', () => el('previewDialog').close());
function renderPreviewFile() {
  const path = el('previewFiles').value;
  el('previewCode').textContent = previewFiles && path ? previewFiles[path] : '';
}
el('btnDownloadZip').addEventListener('click', () => {
  if (!previewFiles) return;
  const zip = new ZipWriter();
  for (const [path, content] of Object.entries(previewFiles)) zip.addFile(path, content);
  const url = URL.createObjectURL(zip.generateBlob());
  const zipName = slugify(el('projectName').value.trim(), 'recorded_automation');
  chrome.downloads.download({ url, filename: `${zipName}.zip`, saveAs: true }, (downloadId) => {
    if (chrome.runtime.lastError) {
      alert(`Could not download the ZIP: ${chrome.runtime.lastError.message}`);
      URL.revokeObjectURL(url);
      return;
    }
    if (downloadId == null) {
      alert('The ZIP download did not start.');
      URL.revokeObjectURL(url);
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    el('previewDialog').close();
  });
});
