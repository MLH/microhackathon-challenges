const FIELDS = ['Theme', 'Subject', 'Audience', 'Style'];
const BLANKS = /\[(?:Theme|Subject|Audience|Style)\]/i;
const ATTEMPT = /^\s*Build a\b/i;
const COMPLETE = /^Build a (.+?) about (.+?) for (.+?) in (.+?) style\.$/i;
export const PROMPT = 'Build a [Theme] about [Subject] for [Audience] in [Style] style.';

function sentence(values) {
  return `Build a ${values[0]} about ${values[1]} for ${values[2]} in ${values[3]} style.`;
}

function complete(text) {
  const match = COMPLETE.exec(text.trim());
  return !!match && match.slice(1).every((value) => value.trim() && !BLANKS.test(value));
}

function createForm(kit, tui, theme, done, draft) {
  const inputs = FIELDS.map((_, index) => {
    const input = new kit.Input({ prompt: '', placeholder: `Enter ${FIELDS[index].toLowerCase()}` });
    // Input.setValue() keeps a new input's cursor at column zero. Inserting
    // the saved draft instead puts the cursor after its last character.
    if (draft[index]) input.handleInput(draft[index]);
    return input;
  });
  let focused = 0;
  let active = true;
  let hasFocus = true;
  let error = '';

  function move(to) {
    focused = (to + 5) % 5;
    for (let i = 0; i < inputs.length; i++) inputs[i].focused = hasFocus && focused === i;
    tui.requestRender();
  }

  function close(result) {
    if (!active) return;
    active = false;
    done(result);
  }

  move(0);
  return {
    get focused() { return hasFocus; },
    set focused(value) { hasFocus = value; move(focused); },
    handleInput(key) {
      if (!active) return;
      if (kit.matchesKey(key, 'escape')) return close(null);
      if (kit.matchesKey(key, 'tab')) return move(focused + 1);
      if (kit.matchesKey(key, 'shift+tab')) return move(focused - 1);
      if (kit.matchesKey(key, 'enter') || kit.matchesKey(key, 'return')) {
        if (focused < 4) return move(focused + 1);
        const values = inputs.map((input) => input.getValue().trim());
        const missing = values.findIndex((value) => !value || BLANKS.test(value) || /[\r\n]/.test(value));
        if (missing !== -1) {
          error = `${FIELDS[missing]} is required; replace any bracketed blank.`;
          return move(missing);
        }
        return close(sentence(values));
      }
      if (focused === 4) return;
      inputs[focused].handleInput(key);
      draft[focused] = inputs[focused].getValue();
      error = '';
      tui.requestRender();
    },
    render(width) {
      const w = Math.max(1, width);
      const line = (text) => kit.truncateToWidth(text, w);
      const output = [line(theme.fg('accent', theme.bold('Build your app'))), line('Tab / Shift+Tab: move   Enter: next / Build   Esc: chat')];
      for (let i = 0; i < inputs.length; i++) {
        output.push(line(`${focused === i ? '›' : ' '} ${FIELDS[i]}:`));
        output.push(...inputs[i].render(w).map(line));
      }
      output.push(line(`${focused === 4 ? '›' : ' '} [ Build ]`));
      const values = inputs.map((input, i) => input.getValue().trim() || `[${FIELDS[i]}]`);
      output.push(line('Preview:'));
      const preview = kit.wrapTextWithAnsi(sentence(values), w);
      output.push(...preview.slice(0, 5).map(line));
      if (preview.length > 5) output.push(line('… (preview continues; answers are kept in full)'));
      if (error) output.push(line(theme.fg('warning', error)));
      return output;
    },
    invalidate() { for (const input of inputs) input.invalidate(); },
  };
}

export default function registerPromptFlow(pi, kit) {
  const draft = ['', '', '', ''];
  let awaitingPrompt = false;
  let opening = false;
  let firstTurn = false;
  let autoOpen = false;

  function submitted(ctx) {
    // Pi persists a user message only after prompt preflight succeeds. A
    // fire-and-forget send (or a manual input handler) cannot acknowledge it.
    return ctx.sessionManager.getBranch().some((entry) => entry.type === 'message'
      && entry.message.role === 'user'
      && entry.message.content.some((part) => part.type === 'text' && complete(part.text)));
  }

  async function open(ctx) {
    if (ctx.mode !== 'tui' || opening || !awaitingPrompt || submitted(ctx)) return;
    if (!ctx.isIdle()) {
      ctx.ui.notify('Wait for Pi to finish, then use /mad-libs.', 'warning');
      return;
    }
    opening = true;
    try {
      const text = await ctx.ui.custom((tui, theme, _keybindings, done) => createForm(kit, tui, theme, done, draft));
      if (text && awaitingPrompt && !submitted(ctx)) {
        pi.sendUserMessage(text);
        awaitingPrompt = false;
      }
    } catch {
      ctx.ui.notify(`Form unavailable. Type ${PROMPT} in chat, or try /mad-libs again.`, 'warning');
    } finally {
      opening = false;
    }
  }

  pi.registerCommand('mad-libs', {
    description: 'Open the four-field app idea form',
    handler: async (_args, ctx) => {
      if (submitted(ctx)) {
        ctx.ui.notify('Your idea was sent. Ask Pi for a change to the app instead.', 'info');
        return;
      }
      // A failed prompt preflight leaves no user message in the branch.
      awaitingPrompt = true;
      await open(ctx);
    },
  });

  pi.on('session_start', (event, ctx) => {
    awaitingPrompt = !submitted(ctx);
    firstTurn = ctx.mode === 'tui' && event.reason === 'startup' && awaitingPrompt;
    autoOpen = false;
  });

  pi.on('agent_before_settle', (event) => {
    if (!firstTurn) return;
    firstTurn = false;
    autoOpen = event.outcome === 'completed';
  });

  pi.on('agent_settled', async (_event, ctx) => {
    if (!autoOpen) return;
    autoOpen = false;
    await open(ctx);
  });

  pi.on('input', (event, ctx) => {
    if (event.source !== 'interactive' || /^\s*[!/]/.test(event.text)) {
      return { action: 'continue' };
    }
    if (!awaitingPrompt) awaitingPrompt = !submitted(ctx);
    if (!awaitingPrompt) return { action: 'continue' };
    if (!ATTEMPT.test(event.text)) return { action: 'continue' };
    if (!complete(event.text)) {
      ctx.ui.setEditorText(event.text);
      ctx.ui.notify(`Complete all four answers: ${PROMPT}`, 'warning');
      return { action: 'handled' };
    }
    awaitingPrompt = false;
    return { action: 'continue' };
  });
}
