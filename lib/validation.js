function validateSteps(steps) {
  const issues = [];
  const locatorTypes = new Set(['click', 'input', 'select', 'keydown', 'assert']);
  function locatorSyntaxError(locator) {
    if (typeof document === 'undefined') return null;
    try {
      if (['xpath', 'role'].includes(locator.strategy)) {
        document.evaluate(locator.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      } else if (['css', 'aria', 'test'].includes(locator.strategy)) {
        document.createDocumentFragment().querySelector(locator.value);
      }
    } catch (error) {
      if (error.name === 'SyntaxError' || error.name === 'InvalidExpressionError') {
        return 'Locator syntax is invalid.';
      }
      throw error;
    }
    return null;
  }

  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') {
      issues.push({ severity: 'error', index, message: 'Step must be an object.' });
      return;
    }

    if (locatorTypes.has(step.type)) {
      if (!step.locator || !step.locator.value || !String(step.locator.value).trim()) {
        issues.push({ severity: 'error', index, message: 'This step needs a locator.' });
      } else if (!['id', 'name', 'css', 'xpath', 'aria', 'test', 'role'].includes(step.locator.strategy)) {
        issues.push({ severity: 'error', index, message: 'The locator strategy is not supported.' });
      } else {
        const syntaxError = locatorSyntaxError(step.locator);
        if (syntaxError) {
          issues.push({ severity: 'error', index, message: syntaxError });
        } else if (['css', 'xpath'].includes(step.locator.strategy)) {
          issues.push({ severity: 'warning', index, message: 'CSS/XPath locator may be fragile; consider a stable ID, test attribute, or accessible label.' });
        }
      }
    }

    if (step.type === 'input' && step.value == null) {
      issues.push({ severity: 'error', index, message: 'Text input is missing a value.' });
    }
    if (step.type === 'select' && step.value == null && step.selectedValues == null) {
      issues.push({ severity: 'error', index, message: 'Select step is missing its selected option(s).' });
    }
    if (step.type === 'wait' && (step.value == null || String(step.value).trim() === '' || !Number.isFinite(Number(step.value)) || Number(step.value) < 0)) {
      issues.push({ severity: 'error', index, message: 'Wait duration must be a non-negative number of milliseconds.' });
    }
    if (step.type === 'assert') {
      if (!['present', 'visible', 'text'].includes(step.assertion)) {
        issues.push({ severity: 'error', index, message: 'Choose a supported assertion: present, visible, or text.' });
      } else if (step.assertion === 'text' && !String(step.expectedText || '').trim()) {
        issues.push({ severity: 'error', index, message: 'Text assertion needs expected text.' });
      }
    }
    if (step.type === 'navigate' && !String(step.value || '').trim()) {
      issues.push({ severity: 'error', index, message: 'Navigation step is missing its URL.' });
    }

    if (!['click', 'input', 'select', 'keydown', 'navigate', 'wait', 'scroll', 'section', 'tab_open', 'tab_switch', 'assert'].includes(step.type)) {
      issues.push({ severity: 'error', index, message: `Unsupported step type: ${step.type || '(empty)'}.` });
    }
  });
  return issues;
}

if (typeof module !== 'undefined') module.exports = { validateSteps };
