# Assay cell

Assay cell is the mark of the Service's GitHub App.
It is one cell of a 45° halftone screen, struck like a hallmark.
Its two neighbours on the screen angle bite the top right and bottom left corners.

## What the centre means

The centre of the cell shows the verdict.

| Centre | Meaning | Stamp |
| --- | --- | --- |
| Punched | READY | `1d-stamp-20-ready.svg` |
| Orange dot in the punch | A person decides | `1d-stamp-20-blocked.svg` |
| Filled, with no punch | Merged | `1d-stamp-20-merged.svg` |

Orange means one thing: a person decides.
For this reason, the avatar has no orange.

## Colours

| Role | Hex |
| --- | --- |
| Tile | `#0c1f14` |
| Stamp | `#ece6d8` |
| Verdict grey | `#7d8590` |
| Verdict orange | `#e2691f` |

The avatar and the favicons use the tile and the stamp colours.
The 20px stamps use verdict grey for the cell.
Verdict orange fills only the dot in the punch.
The `-mono` stamps use `#111111` for every part.

## Files

| File | Use |
| --- | --- |
| `github-app-avatar.png` | GitHub App avatar at 512 × 512, rendered from `1d-avatar.svg` |
| `1d-avatar.svg` | Avatar master on a 256 grid |
| `1d-symbol-black.svg` | The cell alone in black, cropped to the cell |
| `1d-symbol-white-on-black.svg` | The cell in white on a black tile |
| `1d-favicon-32.svg`, `1d-favicon-16.svg` | Favicons drawn on whole pixels at 32px and 16px |
| `1d-stamp-20-*.svg` | Verdict stamps drawn on whole pixels at 20px |

## Change the GitHub App avatar

A person does this step by hand.

1. If you changed `1d-avatar.svg`, render it again to `github-app-avatar.png`.
   Use 512 × 512 CSS pixels at a device pixel ratio of 1.
2. Open the GitHub App settings.
3. Upload `github-app-avatar.png` as the App logo.
