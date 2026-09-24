# Animations — the cookbook

Two primitives, nothing else: the **View Transitions API** for between-page animation (wired once in `src/router/index.ts`) and Vue's **`<Transition>`/`<TransitionGroup>`** for within-page enter/leave. No animation libraries, no GSAP, no scroll-jacking. All tuning CSS lives in `src/assets/css/transitions.css` as numbered recipes.

## 1. Add a hero transition between two pages

The Flutter-`Hero` equivalent. Reference implementation: Triage invoice card → Triage detail image.

1. On the **source** element (a row in a list): `:style="heroStyle('invoice', invoice.id)"`, and arm it on the element that navigates: `@click="armHero('invoice', invoice.id)"` (both from `src/composables/useHero.ts`).
2. On the **target** element (the detail page, one per page): the matching static name, `:style="{ viewTransitionName: 'invoice-' + invoice.id }"`.
3. Done. The browser matches the two names across the navigation and morphs position/size automatically. Timing is tuned globally by Recipe 2.

Give paired text a second name — `heroStyle('invoice', invoice.id, '-title')` on the row, `'invoice-title-' + invoice.id` on the detail — and the title morphs too.

**Why list rows are named on demand:** a view transition snapshots EVERY named element on both pages. Naming every row of a 250-invoice list meant ~500 snapshots per navigation in or out of it — clicks sat for ~2 s before the page changed. `heroStyle()` names only the armed row (the one being opened; it stays armed so the Back navigation morphs into it too).

**Critical rule:** a `view-transition-name` must be unique per page at any moment. Never put a static name inside a `v-for` — use `heroStyle()`.

## 1b. Pages load after the click, never before

Routes use `page(() => import(...))` (`src/router/index.ts`): an async component, so the navigation commits on click and the page shows a skeleton while its code loads. Every page's code is prefetched once the app is idle. Never go back to a bare `component: () => import(...)` — vue-router downloads that BEFORE committing, and the click just hangs.

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
