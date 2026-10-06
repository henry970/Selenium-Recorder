/**
 * Content script — injected into every page.
 * Responsibilities:
 *   1. While recording is active, listen to real user interactions
 *      (click, input, change, keydown) and send structured "step"
 *      objects to the background service worker.
 *   2. On request, execute a single recorded step against the live
 *      DOM for the Replay feature.
 *
 * This script never decides on its own whether recording is active —
 * it always asks the background service worker for the current
 * state (recording survives navigation, so state must live in the
 * background, not in this page's memory).
 */

(function () {
  if (window.__seleniumRecorderInjected) return;
  window.__seleniumRecorderInjected = true;

  let recorderState = RECORDER_STATE.IDLE;
  let lastInputTarget = null; // element currently being typed into
  let lastInputValue = null;
  let lastInputViaPaste = false; // true if the pending value arrived via paste, not typing
  let focusStartTarget = null; // element that most recently gained focus (fallback net)
  let focusStartValue = null; // its value at the moment it gained focus
  let scrollState = null; // { target, startX, startY, lastX, lastY, timer } — one in-flight scroll gesture
  const inputValueSnapshots = new Map();
  const inputCaptureTimers = new Map();
  const recordedInputValues = new WeakMap();
  let inputPollTimer = null;

  // ---------------------------------------------------------------
  // Prefer stable IDs, test attributes, and accessible names before CSS/XPath.
  // ---------------------------------------------------------------
  function getLocator(el) {
    if (el.id && isSafeCssIdent(el.id) && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      return { strategy: 'id', value: el.id };
    }
    const name = el.getAttribute && el.getAttribute('name');
    if (name && document.getElementsByName(name).length === 1) {
      return { strategy: 'name', value: name };
    }
    const testAttr = findTestAttribute(el);
    if (testAttr) {
      return { strategy: 'test', value: `[${testAttr.name}="${cssAttrEscape(testAttr.value)}"]` };
    }
    for (const attr of ['aria-label', 'aria-labelledby', 'title']) {
      const value = el.getAttribute(attr);
      if (value && document.querySelectorAll(`[${attr}="${cssAttrEscape(value)}"]`).length === 1) {
        return { strategy: 'aria', value: `[${attr}="${cssAttrEscape(value)}"]` };
      }
    }
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    if (role && ariaLabel) {
      const selector = `[role="${cssAttrEscape(role)}"][aria-label="${cssAttrEscape(ariaLabel)}"]`;
      if (document.querySelectorAll(selector).length === 1) return { strategy: 'aria', value: selector };
    }
    const tag = el.tagName.toLowerCase();
    const accessibleRole = role || (tag === 'button' ? 'button' : tag === 'a' && el.hasAttribute('href') ? 'link' : null);
    const accessibleName = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (accessibleRole && accessibleName && ['button', 'link'].includes(accessibleRole)) {
      const tagSelector = role ? `//*[@role=${xpathLiteral(role)}]` : (tag === 'a' ? '//a' : '//button');
      const xpath = `${tagSelector}[normalize-space(.)=${xpathLiteral(accessibleName)}]`;
      try {
        const matches = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        if (matches.snapshotLength === 1) return { strategy: 'role', value: xpath };
      } catch (err) {
        if (!(err instanceof DOMException)) throw err;
      }
    }
    const css = buildUniqueCssSelector(el);
    if (css) {
      return { strategy: 'css', value: css };
    }
    return { strategy: 'xpath', value: buildXPath(el) };
  }

  function isSafeCssIdent(id) {
    // Avoid IDs that are dynamically generated / not stable-looking,
    // e.g. purely numeric or containing ":" from frameworks like MUI.
    return /^[a-zA-Z][\w-]*$/.test(id);
  }

  function findTestAttribute(el) {
    if (!el.attributes) return null;
    const preferredNames = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
    for (const name of preferredNames) {
      const value = el.getAttribute(name);
      if (value) return { name, value };
    }
    return null;
  }

  function cssAttrEscape(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\a ')
      .replace(/\r/g, '\\d ');
  }

  function xpathLiteral(value) {
    const text = String(value);
    if (!text.includes("'")) return `'${text}'`;
    if (!text.includes('"')) return `"${text}"`;
    const parts = text.split("'");
    return `concat(${parts.map((part, index) => `${index ? `,"'",` : ''}'${part}'`).join('')})`;
  }

  function buildUniqueCssSelector(el) {
    if (!(el instanceof Element)) return null;
    const path = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === Node.ELEMENT_NODE && depth < 6) {
      let selector = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        const stableClasses = Array.from(node.classList)
          .filter((c) => !/^(active|hover|focus|selected|open|disabled|ng-|css-|_)/.test(c))
          .slice(0, 2);
        if (stableClasses.length) {
          selector += '.' + stableClasses.map((c) => CSS.escape(c)).join('.');
        }
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      path.unshift(selector);
      const candidate = path.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
      node = parent;
      depth += 1;
    }
    const full = path.join(' > ');
    return document.querySelectorAll(full).length === 1 ? full : null;
  }

  function buildXPath(el) {
    if (el.id && isSafeCssIdent(el.id)) return `//*[@id="${el.id}"]`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }

  function isTextEntryElement(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    const nonTextTypes = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'file', 'reset'];
    return !nonTextTypes.includes(el.type);
  }

  function associatedLabelText(el) {
    if (el.labels && el.labels.length) {
      const label = el.labels[0];
      return (label.innerText || label.textContent || '').trim();
    }
    return null;
  }

  function elementDescription(el) {
    if (isTextEntryElement(el)) {
      // Never use the field's live .value here — for a password or
      // any other field, that's the data the user typed, not the
      // field's identity, and it would otherwise leak into locator
      // names, method names, and comments in the generated code.
      const candidates = [el.getAttribute('aria-label'), associatedLabelText(el), el.name, el.id, el.getAttribute('placeholder')];
      const found = candidates.find((c) => c && c.trim());
      return found ? found.replace(/\s+/g, ' ').trim().slice(0, 40) : el.tagName.toLowerCase();
    }
    // Collapse whitespace (not just trim leading/trailing) before
    // truncating — innerText from a loosely-matched click target can
    // span multiple lines/fields (e.g. a whole fieldset's text), and a
    // plain .trim().slice(0, 40) would still leave embedded newlines
    // inside the 40-char window, which breaks the generated Python.
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return text || el.tagName.toLowerCase();
  }

  function classifyElement(el) {
    const tag = el.tagName.toLowerCase();
    if (el.isContentEditable) return 'contenteditable';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') return el.type || 'text';
    if (tag === 'a') return 'link';
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button';
    return tag;
  }

  function sendStep(step) {
    chrome.runtime.sendMessage({
      type: MSG.STEP_RECORDED,
      step: {
        ...step,
        url: location.href,
        pageTitle: document.title,
        timestamp: Date.now()
      }
    });
  }

  function inputValue(el) {
    return el.isContentEditable ? el.innerText : el.value;
  }

  function recordInputValue(el, value, viaPaste = false) {
    if (!value || recordedInputValues.get(el) === value) return;
    recordedInputValues.set(el, value);
    inputValueSnapshots.set(el, value);
    sendStep({
      type: STEP_TYPES.INPUT,
      locator: getLocator(el),
      elementType: classifyElement(el),
      value,
      viaPaste,
      description: elementDescription(el)
    });
  }

  function scheduleInputCapture(el, viaPaste = false) {
    const existingTimer = inputCaptureTimers.get(el);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      inputCaptureTimers.delete(el);
      if (recorderState === RECORDER_STATE.RECORDING && el.isConnected) {
        recordInputValue(el, inputValue(el), viaPaste);
      }
    }, 350);
    inputCaptureTimers.set(el, timer);
  }

  function scanInputValues() {
    if (recorderState !== RECORDER_STATE.RECORDING) return;
    for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) {
      if (!isTextEntryElement(el) && !el.isContentEditable) continue;
      if (['checkbox', 'radio'].includes(el.type)) continue;
      const value = inputValue(el);
      if (inputValueSnapshots.get(el) === value) continue;
      inputValueSnapshots.set(el, value);
      if (value) scheduleInputCapture(el);
      else recordedInputValues.delete(el);
    }
  }

  function startInputPolling() {
    if (inputPollTimer) return;
    scanInputValues();
    inputPollTimer = setInterval(scanInputValues, 250);
  }

  function stopInputPolling() {
    scanInputValues();
    if (inputPollTimer) {
      clearInterval(inputPollTimer);
      inputPollTimer = null;
    }
    for (const [el, timer] of inputCaptureTimers) {
      clearTimeout(timer);
      inputCaptureTimers.delete(el);
      if (el.isConnected) recordInputValue(el, inputValue(el));
    }
  }

  // ---------------------------------------------------------------
  // Scroll gestures: the native 'scroll' event fires continuously
  // while scrolling and doesn't bubble, so it's captured on document
  // in the capturing phase and debounced into a single step per
  // gesture (the final resting position), rather than one step per
  // frame of scroll.
  // ---------------------------------------------------------------
  function getScrollPosition(target) {
    if (target === document) return { x: window.scrollX, y: window.scrollY };
    return { x: target.scrollLeft, y: target.scrollTop };
  }

  function commitScroll() {
    if (!scrollState) return;
    const { target, startX, startY, lastX, lastY, timer } = scrollState;
    clearTimeout(timer);
    scrollState = null;
    if (recorderState !== RECORDER_STATE.RECORDING) return;
    if (startX === lastX && startY === lastY) return; // no net movement — nothing to record
    const direction = lastY !== startY ? (lastY > startY ? 'down' : 'up') : lastX > startX ? 'right' : 'left';
    const isWindow = target === document;
    sendStep({
      type: STEP_TYPES.SCROLL,
      locator: isWindow ? null : getLocator(target),
      elementType: isWindow ? 'window' : classifyElement(target),
      scrollX: lastX,
      scrollY: lastY,
      value: `${lastX},${lastY}`,
      direction,
      description: isWindow ? 'page' : elementDescription(target)
    });
  }

  document.addEventListener(
    'scroll',
    (e) => {
      if (recorderState !== RECORDER_STATE.RECORDING) return;
      const target = e.target === document || e.target === window ? document : e.target;
      if (!(target === document || target instanceof Element)) return;

      if (scrollState && scrollState.target !== target) commitScroll(); // different target scrolled — flush the previous gesture first
      const pos = getScrollPosition(target);
      if (!scrollState) scrollState = { target, startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, timer: null };
      scrollState.lastX = pos.x;
      scrollState.lastY = pos.y;
      clearTimeout(scrollState.timer);
      scrollState.timer = setTimeout(commitScroll, 500);
    },
    true
  );

  // ---------------------------------------------------------------
  // Event listeners (always attached; gated by recorderState)
  // ---------------------------------------------------------------
  document.addEventListener(
    'click',
    (e) => {
      if (recorderState !== RECORDER_STATE.RECORDING) return;
      let el = e.target.closest('button, a, [role="button"], input[type="checkbox"], input[type="radio"], input[type="submit"], input[type="button"], select, li, label') || e.target;
      if (!el || !(el instanceof Element)) return;

      // Clicking a <label> that wraps/targets a form control actually
      // toggles that control natively (and fires its own 'change'
      // event) — resolve to the real control so we don't record two
      // different elements for one interaction.
      if (el.tagName && el.tagName.toLowerCase() === 'label') {
        const control = el.control || (el.htmlFor && document.getElementById(el.htmlFor));
        if (control) el = control;
      }

      commitScroll();
      commitPendingInput();
      const elementType = classifyElement(el);
      // Selects and checkboxes/radios are recorded exclusively via the
      // 'change' listener below (native change semantics), so skip
      // them here to avoid double-recording the same interaction.
      // Text-entry fields (text/email/password/textarea/...) are also
      // skipped — clicking one is just focusing it to type, and the
      // resulting 'input' commit already records the real action.
      if (elementType === 'select' || elementType === 'checkbox' || elementType === 'radio' || isTextEntryElement(el)) return;
      sendStep({
        type: STEP_TYPES.CLICK,
        locator: getLocator(el),
        elementType,
        description: elementDescription(el)
      });
    },
    true
  );

  document.addEventListener(
    'input',
    (e) => {
      if (recorderState !== RECORDER_STATE.RECORDING) return;
      const el = e.target;
      if (!el) return;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const isContentEditable = el.isContentEditable === true;
      if (!['input', 'textarea'].includes(tag) && !isContentEditable) return;
      if (['checkbox', 'radio'].includes(el.type)) return;
      if (lastInputTarget !== el) lastInputViaPaste = false; // new field, clear any stale flag
      lastInputTarget = el;
      lastInputValue = inputValue(el);
      inputValueSnapshots.set(el, lastInputValue);
      if (!lastInputValue) recordedInputValues.delete(el);
      scheduleInputCapture(el);
    },
    true
  );

  // Native paste normally also fires a plain 'input' event once the
  // browser applies it, which the listener above already handles. But
  // some fields (masked inputs, custom formatters, sites that call
  // preventDefault() on 'paste' and set the value manually) apply the
  // pasted text without ever dispatching 'input' — re-reading the
  // field shortly after 'paste' catches those cases too.
  document.addEventListener(
    'paste',
    (e) => {
      if (recorderState !== RECORDER_STATE.RECORDING) return;
      const el = e.target;
      if (!el) return;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const isContentEditable = el.isContentEditable === true;
      if (!['input', 'textarea'].includes(tag) && !isContentEditable) return;
      if (['checkbox', 'radio'].includes(el.type)) return;
      setTimeout(() => {
        lastInputTarget = el;
        lastInputValue = inputValue(el);
        lastInputViaPaste = true;
        inputValueSnapshots.set(el, lastInputValue);
        if (!lastInputValue) recordedInputValues.delete(el);
        scheduleInputCapture(el, true);
      }, 0);
    },
    true
  );

  // Belt-and-suspenders net for text-entry fields: record the value a
  // field had the moment it gained focus, so blur can compare against
  // it directly. This catches paste/autofill/programmatic-value flows
  // that skip 'input' AND happen fast enough to slip past the 'paste'
  // listener's deferred re-read above (e.g. a field whose own script
  // rewrites the value synchronously in a way that never dispatches a
  // standard event) — the value is never silently dropped just because
  // no event fired for it.
  document.addEventListener(
    'focusin',
    (e) => {
      if (recorderState !== RECORDER_STATE.RECORDING) return;
      const el = e.target;
      if (!el) return;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const isContentEditable = el.isContentEditable === true;
      if (!['input', 'textarea'].includes(tag) && !isContentEditable) return;
      if (['checkbox', 'radio'].includes(el.type)) return;
      focusStartTarget = el;
      focusStartValue = isContentEditable ? el.innerText : el.value;
    },
    true
  );

  document.addEventListener(
    'change',
    (e) => {
      if (recorderState !== RECORDER_STATE.RECORDING) return;
      const el = e.target;
      const tag = el.tagName.toLowerCase();
      commitScroll();
      if (tag === 'select') {
        const selectedOptions = Array.from(el.selectedOptions || []);
        const values = el.multiple
          ? selectedOptions.map((option) => option.value)
          : (selectedOptions[0] ? selectedOptions[0].value : el.value);
        const labels = el.multiple
          ? selectedOptions.map((option) => option.text)
          : (selectedOptions[0] ? selectedOptions[0].text : el.value);
        sendStep({
          type: STEP_TYPES.SELECT,
          locator: getLocator(el),
          elementType: 'select',
          value: labels,
          selectedValues: values,
          multiple: Boolean(el.multiple),
          description: elementDescription(el)
        });
      } else if (['checkbox', 'radio'].includes(el.type)) {
        sendStep({
          type: STEP_TYPES.CLICK,
          locator: getLocator(el),
          elementType: el.type,
          description: elementDescription(el)
        });
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (recorderState !== RECORDER_STATE.RECORDING) return;
      if (!['Enter', 'Tab', 'Escape'].includes(e.key)) return;
      const el = e.target;
      if (e.key === 'Enter' || e.key === 'Escape') {
        commitScroll();
        commitPendingInput();
      }
      sendStep({
        type: STEP_TYPES.KEYDOWN,
        locator: el instanceof Element ? getLocator(el) : null,
        elementType: el.tagName ? classifyElement(el) : 'unknown',
        key: e.key,
        description: elementDescription(el)
      });
    },
    true
  );

  // Commit the buffered text-input value as one INPUT step when the
  // field loses focus, instead of emitting a step per keystroke.
  document.addEventListener('blur', (e) => {
    const timer = inputCaptureTimers.get(e.target);
    if (timer) {
      clearTimeout(timer);
      inputCaptureTimers.delete(e.target);
    }
    commitPendingInput(e.target);
  }, true);
  window.addEventListener('beforeunload', () => {
    stopInputPolling();
    commitScroll();
    commitPendingInput();
  });

  function commitPendingInput(targetThatBlurred) {
    // Primary path: an 'input' or 'paste' event was tracked for this
    // exact element.
    if (lastInputTarget && (!targetThatBlurred || targetThatBlurred === lastInputTarget)) {
      if (recorderState === RECORDER_STATE.RECORDING && lastInputTarget.isConnected) {
        recordInputValue(lastInputTarget, inputValue(lastInputTarget), lastInputViaPaste);
      }
      lastInputTarget = null;
      lastInputValue = null;
      lastInputViaPaste = false;
      focusStartTarget = null;
      focusStartValue = null;
      return;
    }

    // Fallback path: no 'input'/'paste' event ever fired for this field
    // (some custom-formatted fields or scripted paste flows skip both),
    // so nothing was tracked above. Compare its value now against what
    // it had when it gained focus, and record it directly if it changed
    // — this is what actually catches the paste, not the primary path.
    if (
      targetThatBlurred &&
      recorderState === RECORDER_STATE.RECORDING &&
      focusStartTarget === targetThatBlurred &&
      (isTextEntryElement(targetThatBlurred) || targetThatBlurred.isContentEditable)
    ) {
      const currentValue = inputValue(targetThatBlurred);
      inputValueSnapshots.set(targetThatBlurred, currentValue);
      if (currentValue && currentValue !== focusStartValue) {
        recordInputValue(targetThatBlurred, currentValue, true);
      }
    }
    if (!targetThatBlurred || targetThatBlurred === focusStartTarget) {
      focusStartTarget = null;
      focusStartValue = null;
    }
  }

  // ---------------------------------------------------------------
  // Messaging with background
  // ---------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === MSG.STATE_CHANGED) {
      if (msg.state !== RECORDER_STATE.RECORDING) {
        stopInputPolling();
        commitScroll();
        commitPendingInput();
        recorderState = msg.state;
      } else {
        recorderState = msg.state;
        startInputPolling();
      }
    }
    if (msg.type === MSG.PING) {
      sendResponse({ ok: true, url: location.href, title: document.title });
    }
    if (msg.type === MSG.REPLAY_STEP) {
      executeReplayStep(msg.step)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true; // async response
    }
  });

  // Ask background for current state on load (handles page navigation
  // mid-recording, and popup re-open after a reload).
  chrome.runtime.sendMessage({ type: MSG.GET_STATE }, (resp) => {
    if (!resp || !resp.state) return;
    recorderState = resp.state;
    if (recorderState === RECORDER_STATE.RECORDING) startInputPolling();
  });

  // ---------------------------------------------------------------
  // Replay execution
  // ---------------------------------------------------------------
  function resolveElement(locator) {
    if (!locator) return null;
    try {
      if (locator.strategy === 'id') return document.getElementById(locator.value);
      if (locator.strategy === 'name') return document.getElementsByName(locator.value)[0] || null;
      if (['css', 'aria', 'test'].includes(locator.strategy)) return document.querySelector(locator.value);
      if (locator.strategy === 'xpath' || locator.strategy === 'role') {
        const result = document.evaluate(locator.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  function waitForElement(locator, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const el = resolveElement(locator);
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) return reject(new Error(`Element not found for locator ${locator.strategy}="${locator.value}"`));
        setTimeout(poll, 150);
      })();
    });
  }

  async function executeReplayStep(step) {
    if (step.type === STEP_TYPES.NAVIGATE) {
      // Navigation is actually performed by the background script via
      // chrome.tabs.update; content script has nothing to do here.
      return 'navigated';
    }
    if (step.type === STEP_TYPES.WAIT) {
      const duration = Number(step.value);
      await new Promise((r) => setTimeout(r, Number.isFinite(duration) && duration >= 0 ? duration : 1000));
      return 'waited';
    }
    if (step.type === STEP_TYPES.ASSERT) {
      const el = await waitForElement(step.locator);
      if (step.assertion === 'visible' && (!el.isConnected || el.getClientRects().length === 0)) {
        throw new Error('Expected element to be visible.');
      }
      if (step.assertion === 'text' && !(el.innerText || el.textContent || '').includes(step.expectedText || '')) {
        throw new Error(`Expected text not found: ${step.expectedText || ''}`);
      }
      return 'asserted';
    }
    if (step.type === STEP_TYPES.SCROLL) {
      if (step.locator) {
        const container = await waitForElement(step.locator);
        container.scrollTop = step.scrollY;
        container.scrollLeft = step.scrollX;
      } else {
        window.scrollTo(step.scrollX, step.scrollY);
      }
      return 'scrolled';
    }
    const el = await waitForElement(step.locator);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });

    if (step.type === STEP_TYPES.CLICK) {
      el.click();
      return 'clicked';
    }
    if (step.type === STEP_TYPES.INPUT) {
      el.focus();
      if (el.isContentEditable) {
        el.innerText = step.value;
      } else {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set || setter;
        if (nativeSetter) nativeSetter.call(el, step.value);
        else el.value = step.value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'typed';
    }
    if (step.type === STEP_TYPES.SELECT) {
      const options = Array.from(el.options || []);
      const selectedValues = step.selectedValues || step.value;
      const values = Array.isArray(selectedValues) ? selectedValues : [selectedValues];
      for (const option of options) option.selected = values.includes(option.value) || values.includes(option.text);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'selected';
    }
    if (step.type === STEP_TYPES.KEYDOWN) {
      const keyMap = { Enter: 13, Tab: 9, Escape: 27 };
      el.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, keyCode: keyMap[step.key], bubbles: true }));
      if (step.key === 'Enter' && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      return 'keypressed';
    }
    return 'noop';
  }
})();
