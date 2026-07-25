# Visual Verification

Two paths, in order of preference: `dev-browser` (scriptable, batched), then curl-only.

## With dev-browser

Write `dev-browser --headless` scripts per affected route, batching checks into single bash calls. Each script runs in a sandboxed Playwright environment.

Use `snapshotForAI()` for structural checks (element existence, DOM structure, content rendering) and reserve screenshots for visual evaluation. That keeps context usage down.

The heredoc below is unquoted so `$REVIEW_PORT` expands. Do not introduce JS template literals with `${...}` without re-quoting and switching to a pre-computed URL variable.

```bash
dev-browser --headless <<SCRIPT
const page = await browser.getPage("review");
await page.goto("http://localhost:$REVIEW_PORT/{route}");
await page.waitForLoadState("networkidle");

// 1. Desktop screenshot + structural snapshot
const snap = await page.snapshotForAI();
const desktop = await page.screenshot({ fullPage: true });
await saveScreenshot(desktop, "{route}-desktop");

// 2. Console errors
const errors = [];
page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });

// 3. SSR/hydration check
const html = await page.content();
const hasNuxtError = html.includes("nuxt-error");
const hasContent = (await page.locator("#__nuxt").all()).length > 0;

// 4. Interactive elements: click every visible button
const buttons = await page.locator("button:visible").all();
const clickResults = [];
for (const btn of buttons) {
  const text = await btn.textContent();
  await btn.click();
  await page.waitForTimeout(300);
  clickResults.push(text?.trim().slice(0, 30));
}

// 5. Mobile viewport check
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(500);
const mobile = await page.screenshot({ fullPage: true });
await saveScreenshot(mobile, "{route}-mobile");
const overflows = await page.evaluate(() =>
  document.documentElement.scrollWidth > window.innerWidth
);

// 6. Dark mode toggle
await page.evaluate(() => document.documentElement.classList.toggle("dark"));
await page.waitForTimeout(300);
const dark = await page.screenshot({ fullPage: true });
await saveScreenshot(dark, "{route}-dark");

console.log(JSON.stringify({
  hasNuxtError, hasContent,
  consoleErrors: errors,
  buttonsClicked: clickResults,
  mobileOverflows: overflows
}, null, 2));
SCRIPT
```

Adapt per route: forms get `page.fill()` plus a submit click to test validation; navigation gets route-change assertions after link clicks.

Translate `[C1] GIVEN/WHEN/THEN` criteria into assertions where possible. A script that clicks a button and verifies the result is stronger evidence than "I looked at the page."

## Accessibility

```bash
dev-browser --headless <<SCRIPT
const page = await browser.getPage("a11y");
await page.goto("http://localhost:$REVIEW_PORT/{route}");
await page.waitForLoadState("networkidle");
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js" });
const results = await page.evaluate(async () => {
  const r = await window.axe.run();
  return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.length })) };
});
console.log(JSON.stringify(results, null, 2));
SCRIPT
```

Any `critical` or `serious` axe violation is a FAIL.

## Without dev-browser

Maximize what is verifiable:

1. Run all mechanical checks (they need no browser).
2. `curl` each affected route, verify SSR content contains expected elements.
3. Check HTML for structural issues (unclosed tags, empty containers, broken component names).
4. Verify all routes return 200 with project-specific content.

The verdict can never be PASS here. Flag it explicitly in the report:

> Visual verification was limited to HTML/SSR inspection (no browser tools available). UNVERIFIED: interactive behavior, client-side rendering, layout at breakpoints, accessibility (contrast, focus, tab order), mobile responsiveness. Install dev-browser (`npm install -g dev-browser && dev-browser install`) for a complete review.

If the handoff has `has_client_animations: true`, add that client-side animations were flagged but not verified.
