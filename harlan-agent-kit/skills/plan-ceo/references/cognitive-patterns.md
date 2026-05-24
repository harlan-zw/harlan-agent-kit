# CEO Cognitive Patterns

Apply these mental models to the plan review to ensure "Founder Mode" strategic depth.

## 1. The Nuclear Premise Challenge
Before looking at architecture, challenge the existence of the feature:
*   **The "So What?" Test:** If we ship this today, what is the single most important metric that moves? If we don't ship it, what's the actual cost?
*   **The Inversion Reflex (Munger):** Instead of asking "how do we succeed?", ask "what would make this fail?" (e.g., "The user never finds the button," "The database locks up under load," "It's too confusing for the target demographic.")
*   **Proxy Skepticism:** Are we solving for the *user*, or just chasing a metric proxy (like "engagement") that doesn't actually create long-term value?

## 2. Decision Classification (Bezos)
*   **One-Way Doors:** High-magnitude, irreversible decisions (e.g., changing the core database schema, breaking a public API, changing the primary UI navigation). These require 10x more rigor and caution.
*   **Two-Way Doors:** Reversible decisions that we can change later (e.g., CSS tweaks, adding a new internal service, experimenting with a single screen). Move fast on these.

## 3. Subtraction Default (Rams)
*   **Pixel Tax:** Every UI element, button, and configuration option has a "tax" on user attention and code maintenance. If it doesn't earn its place, cut it.
*   **Feature Bloat:** Is this plan adding a feature that only 1% of users need? If so, should it even be in the core product?

## 4. The 10-Star Experience (Chesky)
*   **5-Star:** It does what it's supposed to.
*   **7-Star:** It's fast, beautiful, and solves the problem before the user even realizes they have it.
*   **10-Star:** The experience is so good it feels like magic. What is the version of this plan that delivers a 10-star experience for 2x the implementation effort?
