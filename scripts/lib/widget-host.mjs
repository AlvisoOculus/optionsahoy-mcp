// AlphaLatitude Inc. © 2026
//
// A stand-in for ChatGPT's Apps SDK host: parses the widget's HTML, executes
// its script against a fake DOM, and drives it the way the real host does.
//
// Shared deliberately. tests/chatgpt-widget.test.ts runs it against the
// locally built resource, and scripts/conformance-live.mjs runs it against the
// artifact the live deployment actually serves - so "the widget behaves" is
// asserted about the thing users get, not only about the thing in git.
//
// Everything the real host does that has burned us is modelled here:
//   - openai:set_globals fires at an unbounded rate (observed "more than 12"
//     times for a single answer) for theme and display changes;
//   - one mounted widget can serve several tool calls in a row, because all
//     eight tools share one template URI;
//   - toolOutput can be absent, or present with no next_steps.

/** Executes the widget in a fake DOM. Throws if the emitted JS is malformed. */
export function runWidget(html) {
  const open = html.indexOf('<script>');
  const close = html.lastIndexOf('</script>');
  if (open < 0 || close < 0) throw new Error('widget HTML has no inline <script>');
  const body = html.slice(open + 8, close);

  const els = {};
  for (const id of ['oa', 'oa-title', 'oa-sub', 'oa-cta', 'oa-url']) {
    // Seed with the STATIC text the browser would have parsed. Defaulting
    // these to '' silently makes re-labelling assertions vacuous.
    const m = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html);
    els[id] = {
      hidden: id === 'oa',
      textContent: m ? m[1] : '',
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
    };
  }

  const listeners = [];
  let missing = null;
  const win = { openai: undefined, addEventListener: (_e, fn) => listeners.push(fn) };
  const doc = { getElementById: (id) => (id === missing ? null : (els[id] ?? null)) };

  // Parse-time failure surfaces here rather than shipping a blank card.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', body)(win, doc);

  const api = {
    els,
    /** One openai:set_globals, as the host fires it. */
    fire: () => listeners.forEach((fn) => fn()),
    /** Replace window.openai.toolOutput. Pass null for "no output". */
    setOutput(next) {
      win.openai = { toolOutput: next === null ? null : { next_steps: next } };
      return api;
    },
    /** Simulate a DOM node the host never rendered, to force a mid-render throw. */
    breakDom(id) {
      missing = id;
      return api;
    },
    /** The card as a user would read it. */
    read: () => ({
      visible: els.oa.hidden === false,
      title: String(els['oa-title'].textContent),
      cta: String(els['oa-cta'].textContent),
      href: els['oa-cta'].attrs.href ?? null,
      url: String(els['oa-url'].textContent),
    }),
  };
  return api;
}

/** The href the widget would hand a user for this payload, or null. */
export function hrefFor(html, nextSteps) {
  const w = runWidget(html);
  w.setOutput(nextSteps).fire();
  return w.read().visible ? w.read().href : null;
}
