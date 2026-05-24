# Web-Specific Failure Modes (Nuxt, Vue, TypeScript)

Use this checklist for projects using Nuxt, Vue, or TypeScript to ensure production reliability.

## 1. Nuxt SSR & Hydration
*   **Hydration Mismatch:** Are you using browser-only APIs (e.g., `window`, `localStorage`) outside of `onMounted`?
*   **AsyncData Failures:** What happens if `useAsyncData` or `useFetch` fails on the server? Does the user see a 500 error or a gracefully degraded page?
*   **Memory Leaks:** Are you creating global state or event listeners in a way that doesn't clean up during SSR?
*   *CEO Check:* If the server call fails, can the user still interact with the client-side UI?

## 2. Vue & Reactive State
*   **State Race Conditions:** If two API calls update the same Pinia store, which one wins?
*   **Prop Mutation:** Are you accidentally mutating a prop instead of emitting an event?
*   **Watcher Loops:** Do your watchers trigger other watchers, creating a loop?
*   *CEO Check:* Does the UI update immediately (optimistic UI), or is it "stuttery"?

## 3. TypeScript & Type Safety
*   **The `any` Trap:** Are you using `any` as a shortcut? How will that fail 6 months from now?
*   **Unsafe JSON Parsing:** Are you casting `JSON.parse` directly to a type without validation?
*   **Missing Optional Chaining:** Are you assuming a nested object always exists?
*   *CEO Check:* If a "One-Way Door" API change happens, will the types catch the breakage?

## 4. Auth & Security
*   **Client-Side Auth Only:** Are you checking permissions only in the UI and not on the API?
*   **Sensitive Data in Logs:** Are you accidentally logging passwords or tokens in a `console.log`?
*   **CSRF/XSS:** Does the plan include standard protections?
*   *CEO Check:* If a user is logged out mid-session, does the app redirect them cleanly or just "break"?
