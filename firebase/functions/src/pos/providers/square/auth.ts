import type { PosAdapter, PosCredentials } from "../../types.js";
import { call } from "./client.js";
import { appId, appSecret, baseUrl, SCOPES } from "./config.js";
import type { TokenResponse } from "./types.js";

/** OAuth connect, token refresh and revoke — Square's per-merchant flow. */

const toCredentials = (r: TokenResponse, previousRefresh?: string): PosCredentials => {
  const expiresAt = Date.parse(r.expires_at);
  return {
    // A refresh may not hand back a new refresh token — keep the one we have.
    secret: { accessToken: r.access_token, refreshToken: r.refresh_token ?? previousRefresh ?? "" },
    // Unparseable/missing → assume a week, so the daily job refreshes it
    // early rather than never (NaN would dodge every comparison).
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 7 * 86_400_000,
  };
};

const tokenRequest = (grant: Record<string, string>) =>
  call<TokenResponse>("/oauth2/token", {
    method: "POST",
    body: { client_id: appId(), client_secret: appSecret(), ...grant },
  });

export const auth: Pick<PosAdapter, "connect" | "refresh" | "revoke"> = {
  connect: {
    kind: "oauth",
    authUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: appId(),
        scope: SCOPES.join(" "),
        // Always show the Square login — a shared tablet may be signed in
        // as someone else's merchant.
        session: "false",
        state,
        redirect_uri: redirectUri,
      });
      return `${baseUrl()}/oauth2/authorize?${q}`;
    },
    async exchangeCode(code, redirectUri) {
      const r = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
      return { merchantId: r.merchant_id, ...toCredentials(r) };
    },
  },

  async refresh(credentials) {
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: credentials.secret.refreshToken });
    return toCredentials(r, credentials.secret.refreshToken);
  },

  async revoke(merchantId) {
    await call("/oauth2/revoke", {
      method: "POST",
      auth: `Client ${appSecret()}`,
      body: { client_id: appId(), merchant_id: merchantId },
    });
  },
};
