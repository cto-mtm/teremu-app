import { describe, expect, it } from "vitest";
import { emailQuotaEmail, inviteEmail, orderEmail } from "../src/mail";

/**
 * Hermetic: what every message's footer carries (docs/us-market-readiness.md
 * B4). The builders are pure; the emulator suite only proves the quotas.
 * Without MAIL_POSTAL_ADDRESS the fallback names the entity, which is what
 * the test environment sees.
 */
const ADDRESS = process.env.MAIL_POSTAL_ADDRESS?.trim() || "MTM CYA Corp · United States";

describe("mail footers", () => {
  it("prints the sender's postal address under every message, text and html", () => {
    for (const locale of ["es", "en"] as const) {
      const invite = inviteEmail({ locale, toEmail: "a@b.test", inviterEmail: "o@b.test", restaurantName: "Casa Pepe" });
      expect(invite.text.trimEnd().endsWith(ADDRESS)).toBe(true);
      expect(invite.html).toContain(ADDRESS);
      const order = orderEmail({ locale, vendorName: "Frescos", restaurantName: "Casa Pepe", replyToEmail: "o@b.test", lines: [{ name: "Tomate", qty: 2, unit: "kg" }] });
      expect(order.text).toContain(ADDRESS);
      expect(order.html).toContain(ADDRESS);
    }
  });

  it("gives the upgrade nudge the mailer's one-click unsubscribe, in both parts", () => {
    for (const locale of ["es", "en"] as const) {
      const m = emailQuotaEmail({ locale, waiting: 3, limit: 25, upgradeTo: "pro", senders: [], amountTotal: null });
      expect(m.text).toContain("{{unsubscribeUrl}}");
      expect(m.html).toContain('href="{{unsubscribeUrl}}"');
      expect(m.text).toContain(ADDRESS);
      expect(m.text).toContain("/pricing?reason=email_quota");
    }
    // Transactional mail carries no unsubscribe: a supplier order IS the action.
    const order = orderEmail({ locale: "en", vendorName: "Frescos", restaurantName: "Casa Pepe", replyToEmail: "o@b.test", lines: [{ name: "Tomato", qty: 2, unit: "kg" }] });
    expect(order.text).not.toContain("{{unsubscribeUrl}}");
  });

  it("tells the top plan the invoices wait, with no pricing link and no unsubscribe", () => {
    for (const locale of ["es", "en"] as const) {
      const m = emailQuotaEmail({ locale, waiting: 12, limit: 1500, upgradeTo: null, senders: ["Makro"], amountTotal: null });
      for (const part of [m.text, m.html!]) {
        expect(part).not.toContain("/pricing");
        expect(part).not.toContain("{{unsubscribeUrl}}");
        expect(part).toContain("/settings?card=email");
        expect(part).toContain("1500");
      }
      expect(m.text).toContain(ADDRESS);
    }
  });
});
