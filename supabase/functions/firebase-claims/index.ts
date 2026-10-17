// ==============================================================================
// Supabase Edge Function: firebase-claims
// Project: Create: Project Blueprint (CPB) Federal Judiciary
// Description: Adds the `role: "authenticated"` custom claim that Supabase
//              requires on Firebase ID tokens. Replaces the Firebase Cloud
//              Function from Supabase's docs so the Firebase project can stay
//              on the free Spark plan. The site calls this after sign-in and
//              then force-refreshes the Firebase ID token.
//
// Secrets: FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT (service account JSON)
// Deploy:  npx supabase functions deploy firebase-claims --no-verify-jwt
// ==============================================================================

import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "npm:jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Exchange the service account key for a short-lived Google OAuth access token
async function getGoogleAccessToken(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(serviceAccount.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/identitytoolkit" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccount.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}).`);
  }
  const data = await res.json();
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const projectId = Deno.env.get("FIREBASE_PROJECT_ID") ?? "";
    const serviceAccountJson = Deno.env.get("FIREBASE_SERVICE_ACCOUNT") ?? "";
    if (!projectId || !serviceAccountJson) {
      throw new Error("Missing Firebase server configuration.");
    }

    const idToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!idToken) {
      return json({ error: "Missing Authorization header." }, 401);
    }

    // Verify the Firebase ID token was issued for THIS Firebase project
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
      }));
    } catch (_err) {
      return json({ error: "Unauthorized: Invalid or expired Firebase ID token." }, 401);
    }

    const uid = payload.sub;
    if (!uid) {
      return json({ error: "Unauthorized: Token has no subject." }, 401);
    }

    if (payload.role === "authenticated") {
      return json({ success: true, updated: false });
    }

    const accessToken = await getGoogleAccessToken(JSON.parse(serviceAccountJson));
    const updateRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          localId: uid,
          customAttributes: JSON.stringify({ role: "authenticated" }),
        }),
      },
    );

    if (!updateRes.ok) {
      throw new Error(`Failed to set Firebase custom claims (${updateRes.status}).`);
    }

    // The client must now call getIdToken(true) to receive a token with the claim
    return json({ success: true, updated: true });
  } catch (err: any) {
    return json({ error: err.message || "Internal server error" }, 500);
  }
});
