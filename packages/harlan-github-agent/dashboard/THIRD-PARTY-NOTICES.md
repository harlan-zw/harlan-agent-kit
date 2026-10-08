# KiroCrew adaptations

KiroCrew is copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
KiroCrew includes software developed at Amazon.com, Inc. (https://www.amazon.com/).

The adapted code uses the Apache License, Version 2.0.
The full license is [KiroCrew-Apache-2.0.txt](licenses/KiroCrew-Apache-2.0.txt).

Source: [kirodotdev/KiroCrew](https://github.com/kirodotdev/KiroCrew), commit `5dbde278a1a62eb212cd117959776a232725b031`.

| Original source | Adapted file | Changes |
| --- | --- | --- |
| `website/src/hooks/virtualizer/FollowController.ts` | `app/utils/session-scroll.ts` | Keep geometry and self-scroll rules. Use a small functional follow policy. |
| `website/src/pages/chat/rowDisclosure.tsx` | `app/utils/session-disclosure.ts` | Replace the React provider and class with a functional store. Vue owns subscriptions. |
| `website/src/hooks/useImeGuard.ts` | `app/utils/session-ime.ts` | Keep native composition handling. Remove React synthetic event handling. |

The latest-message control adapts `website/src/app-sdk/ChatScrollChrome.tsx` to Nuxt UI tokens and Octicons.
The control uses an outlined button with an accessible label.

Nuxt SEO's chat examples informed the composer and settled activity grouping.
No Nuxt SEO source is copied into this dashboard.
