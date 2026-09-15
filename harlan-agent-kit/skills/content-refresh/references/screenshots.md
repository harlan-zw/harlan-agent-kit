# Article screenshots

Use real UI pixels. Never generate or reconstruct interface screenshots with an image model.
Choose an image only when it helps the reader perform or interpret a task.

## Choose the image

| Type | Use | Evidence requirement |
| --- | --- | --- |
| Control detail | Find a menu or setting | Visible selected and disabled states |
| Numbered steps | Locate controls in order | Numbers match visible HTML instructions |
| Before and after | Explain a changed result | Matched account, filters, period, and metrics |
| Annotated result | Interpret a chart or table | Preserve axes, units, dates, and relevant legends |

Record missing account features as unavailable in that inspection. Never fabricate a screen.
If the user or brief requires a screenshot, capture failure leaves that requirement outstanding.
Record the blocker and next action. Do not silently replace the required screenshot with prose.
Capture with one browser operator; other agents use the sanitized evidence.
Inspect the signed-in page before interacting. Use only authorized accounts and actions.
Prefer opening controls and cancelling forms when submitting data is unnecessary.

## Capture and sharpness

Inspect available browser tools and sessions before declaring capture unavailable.
When the user specifies Chrome or its extension, use that connection first if available.
In Codex, check the exposed browser control tools and follow their connection instructions.
If that connection is unavailable, use dev-browser as a supported fallback. Read dev-browser --help before connecting.
Use a unique task page name and the intended signed-in browser when needed.
If DISPLAY is empty, pass --headless only when launching a browser.
After the user restarts or reconnects the browser, recheck availability before retaining an earlier blocker.
Record locale, account type, report, filters, period, selected metrics, and capture date.
Wait for loading and animation. Bring the page to the foreground when capture stalls.
Use native PNG capture with device scaling.

Require at least two captured pixels per intended CSS display pixel.
Measure decoded file dimensions against the captured CSS region; zoom and DPR alone prove nothing.
Check actual file format. A PNG filename can contain JPEG bytes or previously compressed pixels.
Do not enlarge or sharpen a blurry capture to claim higher resolution. Recapture it.
Inspect text and thin lines at the intended display width.

## Annotation and privacy

Use a deterministic crop and SVG overlay compositor, preserving source pixels.
Reuse a verified project renderer when available; otherwise choose an available lossless compositor and verify its output.
Keep crop, density, source dimensions, canvas, offsets, markers, and outlines in an editable private manifest.
Render overlays directly into the final PNG; do not screenshot a preview to create publication assets.
Compare an untouched decoded region with the source to detect unintended resizing.

Add only numbers, arrows, and highlight outlines.
Keep explanations, editorial headings, and captions as indexable article text.
Preserve original UI text. Point arrows at control edges without covering labels or selected states.
Use high contrast and readable numbers. Never rely on color alone.
Start with one to three callouts. Split crowded images or add a tighter detail crop.

Keep raw captures and manifests in private scratch storage outside Git and public assets.
Prefer cropping identifiers away. Otherwise flatten opaque redactions into exported pixels.
Inspect account names, avatars, URLs, queries, private metrics, metadata, and embedded image sources.
CSS concealment does not remove private pixels. Publish only reviewed sanitized exports.
Do not replace private data with plausible invented values.

## Article integration

Use native figure, img, and figcaption elements supported by the renderer.
Center images and captions. Give captions small, muted text through the article stylesheet.
Use 14px as a starting point; check contrast and readability in both themes when supported.
Provide image dimensions and responsive width caps that retain the measured source density.

Use concise alt text for purpose and relevant state; do not duplicate the caption.
Put capture dates, limitations, redaction context, and optional full-size links in the caption.
Keep all required steps and interpretation in ordinary visible article text.
The reader must be able to complete the task without seeing the image.

Verify loading, arrow targets, numbers, privacy, intended-width sharpness, and mobile overflow.
Check keyboard access for enlarged-image controls.
A before/after image does not establish causation or API parity.
Close task-owned named pages afterward. Never run dev-browser stop.
