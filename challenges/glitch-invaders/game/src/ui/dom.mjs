/** A tiny element builder, so the UI modules read as structure instead of `createElement` noise. */

/** Create an element with attributes and children. */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) {
      continue;
    }
    element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child !== null && child !== false) {
      element.append(child);
    }
  }

  return element;
}

/** Remove every child of `element` and add `children`. */
export function replaceChildren(element, ...children) {
  element.replaceChildren(...children.filter((child) => Boolean(child)));
}

/** Set `element`'s text only when it changed, so per-frame updates do not churn the DOM. */
export function setText(element, text) {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

/** Add a click handler and return the element, for chaining inside {@link h} calls. */
export function onClick(element, handler) {
  element.addEventListener('click', handler);

  return element;
}

/** The elements inside `root` that can take keyboard focus, in tab order. */
export function focusableElements(root) {
  const selector = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  return [...root.querySelectorAll(selector)].filter(
    (candidate) => !candidate.hasAttribute('hidden'),
  );
}

/** Keep Tab and Shift+Tab inside `container`, as a modal dialog must. */
export function trapFocus(container, event) {
  if (event.key !== 'Tab') {
    return;
  }

  const focusable = focusableElements(container);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) {
    event.preventDefault();

    return;
  }

  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
