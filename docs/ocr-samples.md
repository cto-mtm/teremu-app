# OCR & Vision AI Test Samples

This directory (`docs/samples/dummy/`) contains 12 synthetic, camera-captured sample images designed for testing Teremu's receipt OCR (`ocr.ts`) and menu extraction (`menuscan.ts`) pipelines.

## Document Types in Teremu (`docType`)

Teremu differentiates between two document types:
- **`invoice`**: Standard billing invoice/receipt containing itemized prices and totals. Approving updates pantry stock, rolling ingredient prices, and expenses.
- **`delivery_note` (Albarán / Remisión)**: Goods received confirmation listing items/quantities delivered without billing prices. Approving is for **reconciliation only** and intentionally bypasses pantry stock, price rolls, and expense totals.
- **Non-document rejection (`notDocument`)**: Non-document photos (e.g. food photos) rejected by Vision AI.

---

## Sample Index

| File | Type | Key Features / OCR Test Focus |
|---|---|---|
| [`docs/samples/dummy/delivery-note-albaran.jpg`](samples/dummy/delivery-note-albaran.jpg) | `delivery_note` | **Delivery Note / Albarán**: Goods received with no unit prices (tests reconciliation-only flow) |
| [`docs/samples/dummy/non-document-photo.jpg`](samples/dummy/non-document-photo.jpg) | Non-Document | **Non-Document Photo**: Plated food image (tests `notDocument: true` rejection handling) |
| [`docs/samples/dummy/receipt-handwritten.jpg`](samples/dummy/receipt-handwritten.jpg) | `delivery_note` | **Handwritten Delivery Note**: Pen writing on carbon paper pad |
| [`docs/samples/dummy/receipt-produce.jpg`](samples/dummy/receipt-produce.jpg) | `invoice` | Crinkled paper, top-down angle, mass units (kg/g) |
| [`docs/samples/dummy/receipt-seafood.jpg`](samples/dummy/receipt-seafood.jpg) | `invoice` | Wooden surface, handwritten checkmarks, price totals |
| [`docs/samples/dummy/receipt-meat.jpg`](samples/dummy/receipt-meat.jpg) | `invoice` | Clipboard placement, wholesale meat cuts & weights |
| [`docs/samples/dummy/receipt-spanish-factura.jpg`](samples/dummy/receipt-spanish-factura.jpg) | `invoice` | Multilingual Spanish HORECA invoice, Euro (€) tax (IVA) |
| [`docs/samples/dummy/receipt-thermal-dairy.jpg`](samples/dummy/receipt-thermal-dairy.jpg) | `invoice` | Faded text, curling paper edges, thermal header |
| [`docs/samples/dummy/receipt-bakery.jpg`](samples/dummy/receipt-bakery.jpg) | `invoice` | Clean columnar alignment (QTY, Unit Price, Amount) |
| [`docs/samples/dummy/receipt-beverage.jpg`](samples/dummy/receipt-beverage.jpg) | `invoice` | Wholesale kegs/cases, item discounts, diagonal fold |
| [`docs/samples/dummy/receipt-glare-shadow.jpg`](samples/dummy/receipt-glare-shadow.jpg) | `invoice` | Extreme lighting challenge: harsh camera glare & shadows |
| [`docs/samples/dummy/menu-scan-sample.jpg`](samples/dummy/menu-scan-sample.jpg) | Menu Scan | Restaurant menu photo (for `menuscan.ts` digitization) |

## Usage

### In Local Development / Emulators
- Upload any of these sample images in the **Scan** tab of the web app or Triage flow.
- Without an `NVIDIA_API_KEY`, receipt scanning runs against the built-in (randomized) mock pipeline.
- With an `NVIDIA_API_KEY` set in `firebase/functions/.secret.local`, the vision model (`LLM_MODEL` in `firebase/functions/.env` — production uses `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, see `docs/llm.md`) will parse the image live and extract structured items, unit prices, totals, and document types (`docType`).
