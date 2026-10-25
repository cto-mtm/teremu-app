# Ingredient aliases, triage linking, pantry merge

## Context

Invoice lines become pantry ingredients by exact normalized name (`normalizeName`, `shared/src/utils.ts:8`). The only fuzzy step is the OCR model's `match` against the KNOWN INGREDIENTS list; a miss there means "PRK CHOP" and "PORK CHP" become two ingredient docs. Dishes bind by `ingredientId`, so purchases roll onto one doc while recipes cost from the other. There is no alias memory (a correction in triage is forgotten), no way in triage to link a line to an existing ingredient, and no merge tool (docs/architecture.md:92 and docs/product.md:103 list it as missing). `normalizeName` also deletes accents ("jamón" → "jamn" vs "JAMON" → "jamon"), a separate duplicate source for an es-first product.

Outcome: a vendor spelling is corrected once and remembered; triage warns before a line spawns a new ingredient and lets the reviewer link it; existing duplicates can be merged from the pantry with every reference repointed.

Design constraints decided:
- Aliases are **folded keys**, not labels: language-free, never shown, no localization. One flat list per ingredient covers suppliers invoicing in two languages. Only UI strings get es/en keys.
- `normalizeName` and stored `nameKey` are **unchanged** (prod `nameKey`, `tagKey`, vendor-contact keys and invite ids were written with it; changing it needs a migration). A new `foldName` handles accents for aliases and lookups only.
- The OCR prompt / KNOWN INGREDIENTS format is **not** touched (text-path cassettes hash the prompt; changing it forces re-recording). Aliases resolve deterministically at approval, which is what matters.
- Merge **deletes** the loser after repointing every reference (recipes, invoice lines, posDays.applied). Tombstones would count against the `limit(300)` catalog loads and stay "alive" for POS re-projection.

## Steps (shared → functions → app → tests → docs)

Build shared first after A: `npm run build --workspace @teremu/shared` (needed before typechecking app/functions). Do not run other builds.

### A. shared/
1. `shared/src/utils.ts`: add `foldName(s) = normalizeName(s.normalize("NFKD").replace(/\p{M}/gu, ""))`.
2. New `shared/src/similarity.ts`: move `STOPWORDS`, `tokens`, `bigrams`, `dice`, counts helper (as `tokenCounts`) verbatim from `firebase/functions/src/pos/matching.ts:40-70`; `tokens` uses `foldName`. Add `nameSimilarity(a,b)` = 0.6·dice(token counts) + 0.4·dice(bigrams of joined keys), 0 when either key empty. Export from `shared/src/index.ts`.
3. Tests: `utils.test.ts` (`foldName("Jamón Ibérico") === "jamon iberico"`, fold equals normalizeName for ASCII); new `similarity.test.ts` (identical → 1, "Croquetas de jamón" vs "CROQUETAS JAMON" → 1, "PORK CHP" vs "Pork chop" pinned at 0.62, unrelated < 0.3, empty → 0, symmetric). *As built:* the plan originally pinned "PRK CHOP" vs "PORK CHP" ≥ 0.55, but the formula scores two different misspellings of one name 0.23 (no shared token); the test now pins that it stays below the floor — the picker's search covers that case. Do not retune the formula to it: POS dish matching shares it.

### B. firebase/functions/
4. `pos/matching.ts`: import `tokens, bigrams, dice, tokenCounts` from `@teremu/shared`; keep `export { tokens }` (used by `listing/merge.ts:1`, `test/pos-catalog.test.ts:2`). `matchItem` unchanged.
5. `models.ts`: `ingredientDocSchema` add `aliases: z.array(z.string()).optional().catch(undefined)` (approval/usage `safeParse`-skip malformed docs, so `.catch` is mandatory). Add `mergeIngredientSchema = z.object({ into: z.string().min(1) }).strict()` next to `archiveSchema` (~267).
6. `pipeline.ts` `approveInvoice` (~414-505): build `byKey` from `nameKey`, `foldName(name)` and each alias with a `put` that prefers non-archived on collision; also `byId`. Resolution per line: (1) `li.ingredientId` found in `byId` → use it; if `foldName(li.name)` is not the ingredient's nameKey / fold key / alias, add `aliases: FieldValue.arrayUnion(fold)` **into the same `batch.update` object** and `byKey.set(fold, existing)`; line keeps its vendor `name`. (2) else `byKey.get(normalizeName)` ?? `byKey.get(foldName)`. (3) else create as today. Unknown ingredientId → ignored, never 400 (`logger.warn`).
7. `api.ts`: `GET /ingredients` (671) also allowed for `can(member,"triage")`. New route after archive (~732): `POST /ingredients/:id/merge`, pantry edit, parse body, 400 `same_ingredient` if `into === id`, call `mergeIngredients(rid, id, into)`, return `{ id: into, ...merged }`.
8. New `src/merge.ts` `mergeIngredients(rid, loserId, survivorId)`: 
   1. read + `safeParse` both, 404 if missing; `ratio = convertQty(1, loser.unit, survivor.unit)` (shared), null → `RequestError("unit_mismatch", 409)`.
   2. menuItems: rewrite recipe lines loser→survivor; a line **without `unit`** means "loser's stock unit" (models.ts:86-90) so stamp `unit: loser.unit` when units differ; if a recipe ends with two survivor lines of equal effective unit, sum into one. Batches ≤400.
   3. invoices: `select("lineItems")` full scan (arrays of objects aren't queryable), rewrite `lineItems[].ingredientId`, keep `name`. Batches ≤400 (pattern: `demo/index.ts:149`, `pos/days.ts:100`).
   4. posDays: for docs with `applied[loserId]`, `applied[survivorId] += applied[loserId] * ratio`, delete loser key (project.ts:151-192 diffs against this map; skipping it double-counts on re-projection).
   5. final transaction on the two docs (re-read): `theoreticalQty += loser.qty*ratio`; take loser price fields when its `lastPriceAt` is newer, price ÷ratio; take loser count fields if survivor has none (×ratio); `aliases` = union of survivor aliases, `loser.nameKey`, `foldName(loser.name)`, loser aliases, minus survivor's own keys; `archived:false`; delete loser. Return merged doc.
   References are repointed before the loser disappears, so a crash leaves a re-runnable state.

### C. app/
9. `lib/schemas.ts` `ingredientSchema`: `aliases: z.array(z.string()).optional().catch(undefined)`.
10. `lib/domain.ts` (pure; re-export `foldName`, `nameSimilarity` like `normalizeName` at :18): `ingredientKeys(ing)`, `matchIngredientByName(name, ingredients)` (nameKey, then fold vs keys; non-archived wins), `suggestIngredients(name, category, ingredients, floor=0.55, top=3)` (same-category first), `possibleDuplicates(ingredients)` (non-archived, same category, `nameSimilarity ≥ 0.8` as `listing/merge.ts:32`, each pair once, by score). Alias-aware reads: `receiptsForIngredient` fallback (:397-399) also accepts `ingredientKeys(ing).includes(foldName(line.name))`; name-keyed groupings at :359, :616, :801 fall back to `foldName(line.name)` instead of `normalizeName`. Signatures unchanged.
11. `stores/kitchen.ts`: `mergeIngredient(loserId, survivorId)` — capture `generation` before awaiting (as `refresh` does), `POST /ingredients/:id/merge`, drop loser + `replaceById` survivor, then `void refresh(undefined, ['ingredients','menu'])`. Expose it.
12. `components/AppShell.vue:139`: `ingredients: can('pantry') || can('menu') || can('triage')` (`refresh(flags, only)` only narrows `lastFlags`, so the page cannot widen it itself). `TriageDetailPage` adds an `onMounted` fallback `if (!kitchen.ingredients.length && !kitchen.loading) kitchen.refresh({ ingredients: true }, ['ingredients'])`.
13. New `components/LinkToIngredientSheet.vue` (clone sheet markup from `LinkToRecipeSheet.vue:70-127`): props `{ name, category? }`, `defineModel<boolean>`, emit `picked`. Search, "Sugerencias" group via `suggestIngredients`, "Todos" from `kitchen.pantry` filtered by fold-contains.
14. `pages/TriageDetailPage.vue` line editor (634-681): `isNew(line)` = no ingredientId and `matchIngredientByName` misses → "Nuevo" badge button opening the sheet for that index; picked → `line.ingredientId = ing.id`, shown as chip "Vinculado a X" with × to unlink. Stale id shows nothing (server falls back). `lines` already flow into the approve body (stores/invoices.ts:155).
15. `pages/IngredientDetailPage.vue` after archive block (282-297): "Fusionar con…" ghost button (pantry edit, not archived) + new `components/MergeIngredientSheet.vue` (`{ ingredient, preselect? }`): list `kitchen.pantry` minus self with suggestions first; confirm card with used-by count (`recipesUsing`, domain.ts:434) and stock sum; disable + explain when `convertQty(1, loser.unit, survivor.unit) === null`; on success emit → page calls `useInvoicesStore().refresh()` and `router.replace('/pantry/'+survivor.id)`. `route.query.merge` preselects and opens.
16. `pages/PantryPage.vue` above archived block (408): collapsible "Posibles duplicados · N" from `possibleDuplicates(kitchen.pantry)`, rows `RouterLink` to `/pantry/${b.id}?merge=${a.id}`. No `view-transition-name` on these rows (names must stay unique per page).
17. i18n, es + en in the same file: `locales/pages/triage.ts` `detail.link.{newBadge,title,search,suggestions,all,none,linked,unlink}`; `locales/pages/pantry.ts` `merge.{action,title,search,suggestions,all,confirm,usedBy(plural),stock,unitMismatch,failed,cta,dupesTitle,dupesIntro}`.

### D. Tests (docs/testing.md matrix: 401, other restaurant, perm-denied member, happy)
18. `app/src/lib/domain.test.ts`: receipts match by fold and by alias, not by a different id; id-less "Jamón"/"JAMON" group into one spend row; `matchIngredientByName` (nameKey/fold/alias/non-archived preference/miss); `suggestIngredients` (floor, category first, top 3, no archived); `possibleDuplicates` (pair once, category gate, archived excluded, sorted).
19. `firebase/functions/test/invoices.test.ts`: approve matches accented name by fold; matches by alias; honors `ingredientId` and learns the alias (line keeps vendor name, `aliases` contains fold, second approve without id still matches, no duplicate alias); unknown id falls back to name; triage-only member gets 200 on `GET /ingredients`.
20. `firebase/functions/test/pantry.test.ts` merge: 401; 403 `pantry:'read'`; 404 other restaurant; 404 missing `into`; 400 same id; 409 each→kg. Happy path with two ingredients, a recipe holding the loser, a recipe holding both, an approved invoice line on the loser, a `posDays` doc with `applied[loser]`: loser gone, qty summed (plus a g→kg case with price re-based), archived survivor un-archived, newer price wins, aliases ⊇ loser keys and exclude survivor's, recipe lines repointed with `unit` stamped when units differ and summed when equal, invoice line repointed with name intact, posDay key moved and converted, response is survivor with its id.
21. `test/pos-catalog.test.ts` must still pass unchanged (step 4). Check `seed.ts` and demo profiles for ingredient pairs ≥ 0.8 that would newly surface in the pantry duplicates section (e2e row counts; Harbor Bistro numbers are pinned).

### F. Gap fixes folded in (from review)
23. **Alias management**: `PUT /ingredients/:id/aliases` body `{ aliases: string[] }` (pantry edit; values re-folded server-side, deduped, survivor's own keys dropped; 404 matrix tests). Store action `setAliases`. `IngredientDetailPage.vue`: "También aparece como" card listing aliases as chips with × (pantry edit) — the only way to undo a wrong triage link. i18n `pantry.aliases.{title,intro,remove,empty}`.
24. **Collision guard** (step 6): before `arrayUnion`, if `byKey.get(fold)` resolves to a *different* ingredient, do not learn the alias (`logger.info`); the line still uses the explicit id. Test: alias not learned when the key is another ingredient's nameKey.
25. **Demo engine parity**: `demo/engine.ts:711-713` afterApproval matching mirrors the pipeline (nameKey → fold → alias); `demo-profiles.test.ts` must stay green.
26. **Picker unit warning** (step 13): each row shows the unit; rows whose unit is a different dimension from the line's (`convertQty(1, line.unit, ing.unit) === null`, containers excepted when `packUnit` converts) show an inline warning and need a second tap to confirm.
27. **Lazy duplicates** (step 16): `possibleDuplicates` runs only once the section is expanded (`computed` behind `showDupes`), cached per `kitchen.pantry` identity.
28. **Quieter badge** (step 14): badge is solid/colored only when `suggestIngredients` returns ≥1; otherwise a subtle outline "Nuevo" so a first invoice isn't a wall of warnings.
29. **OCR prompt sees aliases** (ocr.ts:259-279, 183-188): `extractionContext` (pipeline.ts:224-235) passes `knownIngredients` as today plus each ingredient's aliases as extra strings in the same flat array (format unchanged); `sanitize`'s `canonical` map gains alias → canonical name so a `match` on an alias renames the line to the ingredient. Archived and merged-away docs: exclude archived from the hint list (merged ones are deleted). Recordings: text-path cassettes only change for restaurants that have aliases (none in the fixtures); note in docs/real-samples.md.
30. **Menu-scan alias awareness**: `menuscan.ts:254` `byName` keyed by lowercase name **and** fold key **and** aliases (catalog entries from api.ts:810 carry `aliases`); `MenuScanWizard.vue:211` seeds `created` with `ingredientKeys(i)` (fold + aliases) and looks up by `foldName(line.name)` so a dish draft never recreates an aliased ingredient. **Assistant `searchIngredients` stays nameKey-prefix only**: its query is declarative (tools.ts:211-218) and Firestore cannot OR a prefix range with `array-contains`; documented as a known limit.
31. Permission note in docs: triage members may now read the ingredient catalog (names, units, stock), needed for the picker.

### G. As built (after code review)
32. Lookup is **tiered** (`IngredientIndex`, `shared/src/identity.ts`): nameKey beats folded name beats alias, so step 6's single first-wins `byKey` map is gone — it let an alias shadow another ingredient's exact name by read order. Every consumer (approval, OCR hints, demo engine, menu scan, app) uses it.
33. `cleanAliases` (shared) also drops keys any *other* ingredient answers to — for merge and `PUT /aliases`, not just approval (step 24).
34. Merge rewrites recipes as stored (no whole-array validation) and repoints a second time after the delete transaction.
35. Renaming a linked triage line clears its `ingredientId`.

### E. Docs
22. `docs/architecture.md:92`: replace the "no merge tool" bullet with an "Ingredient identity" section (nameKey unchanged + aliases as fold keys learned at approval and merge, lookup order, merge steps, OCR list still speaks names). `docs/product.md:103`: drop "ingredient merge tool" from the not-yet list.

## Verification
- `npm run build --workspace @teremu/shared`, then `tsc --noEmit` in `firebase/functions` and the app typecheck (en typed from es catches missing keys).
- `npm test` (shared + domain unit tests), `npm run test:integration:exec` (invoices + pantry + pos-catalog suites; Node 22 per memory).
- Manual with user's dev server + emulators (`npm run seed`): scan/approve an invoice whose line is spelled differently from a seeded ingredient → "Nuevo" badge, link it, approve, confirm the ingredient doc gained the alias and a second invoice with the same spelling matches silently. In the pantry, the duplicates section lists a seeded near-pair; merge from the detail page; dish costs on the menu page unchanged, loser gone, survivor stock summed.
