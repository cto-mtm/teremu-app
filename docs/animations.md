# Animations — the cookbook

Two primitives, nothing else: the **View Transitions API** for between-page animation (wired once in `src/router/index.ts`) and Vue's **`<Transition>`/`<TransitionGroup>`** for within-page enter/leave. No animation libraries, no GSAP, no scroll-jacking. All tuning CSS lives in `src/assets/css/transitions.css` as numbered recipes.

## 1. Add a hero transition between two pages

The Flutter-`Hero` equivalent. Reference implementation: Triage invoice card → Triage detail image.

1. On the **source** element (in the list/card): `:style="{ viewTransitionName: 'invoice-' + invoice.id }"`
2. On the **target** element (in the detail page): the **same name**, `:style="{ viewTransitionName: 'invoice-' + invoice.id }"`
3. Done. The browser matches the two names across the navigation and morphs position/size automatically. Timing is tuned globally by Recipe 2.

Give paired text the same treatment with a second name (`'invoice-title-' + invoice.id`) and the title morphs too.

**Critical rule:** a `view-transition-name` must be unique per page at any moment. Never put a static name inside a `v-for` — always derive it from the item id.

## 2. Add a custom per-page transition

Worked example — slide the Settings page in from the right:

1. In `SettingsPage.vue`, give the root element `style="view-transition-name: settings-page"`.
2. In `transitions.css`, add:

```css
::view-transition-new(settings-page) {
  animation: slide-in-right 260ms cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes slide-in-right {
  from { transform: translateX(24px); opacity: 0; }
}
```

That's it — the router wrapper already snapshots every navigation; naming an element just gives it its own animatable group.

## 3. Animate a list reorder / insert / remove

Use `<TransitionGroup name="list">` around the `v-for` and the Recipe 4 classes (`.list-enter-*`, `.list-leave-*`, `.list-move`) already defined in `transitions.css`. The Triage inbox uses this: approved invoices animate out of the list. FLIP move animation comes free via `.list-move`.

## 4. The rules

- Animate **only `transform` and `opacity`** (compositor-friendly).
- Durations **200–350ms**, easing `cubic-bezier(0.4, 0, 0.2, 1)`.
- `view-transition-name`s must be **unique per page**.
- Always test with **reduced motion** enabled (the wrapper and Recipe 3 both disable animation).
- Never nest `startViewTransition` calls — the router wrapper is the only call site.
- Every recipe must look acceptable if it simply cross-fades (that's the automatic fallback).

## 5. Platform support

View Transitions: Chromium (incl. Android WebView) since 111, iOS WKWebView since iOS 18. On anything older the router wrapper silently degrades to instant navigation — that's the designed fallback, not a bug.
