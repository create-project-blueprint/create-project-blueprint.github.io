// ==============================================================================
// Supabase Edge Function: verify-minecraft
// Project: Create: Project Blueprint (CPB) Federal Judiciary
// Description: Secure server-side verification bridge between web sign-in,
//              official Mojang API profile lookup, and in-game token verification.
// ==============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface MojangProfileResponse {
  id: string; // Trimmed UUID without hyphens
  name: string; // Exact case-sensitive in-game name
}

function formatMinecraftUuid(rawUuid: string): string {
  const clean = rawUuid.replace(/-/g, "").toLowerCase();
  if (clean.length !== 32) return rawUuid.toLowerCase();
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

// Constant-time string comparison so the webhook secret can't be guessed via timing
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serverWebhookSecret = Deno.env.get("MINECRAFT_SERVER_WEBHOOK_SECRET") ?? "";

    if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey) {
      throw new Error("Missing Supabase server environment configuration.");
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const action = body.action || "request_link";

    // --------------------------------------------------------------------------
    // ACTION A: In-game server confirmation webhook
    // e.g. when player executes `/verify <token>` on CPB Minecraft Server
    // --------------------------------------------------------------------------
    if (action === "confirm_ingame") {
      const providedSecret = req.headers.get("x-server-secret") || body.server_secret || "";
      if (!serverWebhookSecret || !timingSafeEqual(String(providedSecret), serverWebhookSecret)) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid server webhook secret." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { verification_token, in_game_uuid, in_game_username } = body;
      if (!verification_token || !in_game_uuid || !in_game_username) {
        return new Response(
          JSON.stringify({ error: "Missing required verification parameters (verification_token, in_game_uuid, in_game_username)." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const formattedUuid = formatMinecraftUuid(in_game_uuid);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(formattedUuid)) {
        return new Response(
          JSON.stringify({ error: "Invalid Minecraft UUID format." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Query the isolated profile_verifications table for active matching token
      const { data: verification, error: findError } = await supabaseAdmin
        .from("profile_verifications")
        .select("user_id, target_minecraft_username, target_minecraft_uuid, expires_at")
        .eq("verification_token", verification_token.trim())
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (findError || !verification) {
        return new Response(
          JSON.stringify({ error: "Invalid, expired, or non-existent verification token." }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Check if target UUID was specified and matches in-game UUID
      if (
        verification.target_minecraft_uuid &&
        verification.target_minecraft_uuid !== "00000000-0000-0000-0000-000000000000" &&
        verification.target_minecraft_uuid.toLowerCase() !== formattedUuid
      ) {
        return new Response(
          JSON.stringify({ error: "Mismatched UUID: In-game account does not match the pending request for this token." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Check for UUID conflict against existing verified profiles
      const { data: conflict } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("minecraft_uuid", formattedUuid)
        .eq("verification_status", "verified")
        .neq("id", verification.user_id)
        .maybeSingle();

      if (conflict) {
        return new Response(
          JSON.stringify({ error: "This Minecraft account is already verified by another CPB profile." }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Confirm verification on profile with automated proof method recorded
      const { error: updateError } = await supabaseAdmin
        .from("profiles")
        .update({
          minecraft_username: in_game_username,
          minecraft_uuid: formattedUuid,
          verification_status: "verified",
          verification_method: "automated_ingame",
          verified_by_user_id: null,
          minecraft_verified_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", verification.user_id);

      if (updateError) {
        throw updateError;
      }

      // Remove consumed token
      await supabaseAdmin
        .from("profile_verifications")
        .delete()
        .eq("user_id", verification.user_id);

      return new Response(
        JSON.stringify({
          success: true,
          message: `Successfully verified Minecraft identity ${in_game_username} (${formattedUuid}) for profile ${verification.user_id}.`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --------------------------------------------------------------------------
    // ACTION B: Player requests linking from web portal
    // Authenticated via the player's Firebase ID token
    // --------------------------------------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace(/^Bearer\s+/i, "");

    // User-scoped client: anon key as apikey, player's Firebase token for identity
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    // The database validates the token's issuer/audience and returns the Firebase UID
    const { data: callerId, error: userError } = await userClient.rpc("current_user_id");

    if (userError || !callerId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Invalid or expired session." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { minecraft_username } = body;
    if (!minecraft_username || typeof minecraft_username !== "string") {
      return new Response(
        JSON.stringify({ error: "Invalid minecraft_username provided." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const trimmedUsername = minecraft_username.trim();
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(trimmedUsername)) {
      return new Response(
        JSON.stringify({ error: "Invalid Minecraft username syntax (must be 3-16 alphanumeric or underscore characters)." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Official Mojang API lookup to verify canonical username and UUID
    const mojangRes = await fetch(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(trimmedUsername)}`,
      { headers: { "Accept": "application/json" } }
    );

    if (mojangRes.status === 404 || mojangRes.status === 204) {
      return new Response(
        JSON.stringify({ error: `Minecraft username "${trimmedUsername}" does not exist in the Mojang registry.` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!mojangRes.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to communicate with Mojang profile services. Please try again later." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const mojangData: MojangProfileResponse = await mojangRes.json();
    const canonicalName = mojangData.name;
    const formattedUuid = formatMinecraftUuid(mojangData.id);

    // Call stored procedure to create isolated token in profile_verifications
    const { data: rpcData, error: rpcError } = await userClient.rpc("request_minecraft_linking", {
      p_minecraft_username: canonicalName,
      p_minecraft_uuid: formattedUuid,
    });

    if (rpcError) {
      return new Response(
        JSON.stringify({ error: rpcError.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        canonical_username: canonicalName,
        minecraft_uuid: formattedUuid,
        avatar_head_url: `https://mc-heads.net/avatar/${formattedUuid}/64`,
        verification_status: "pending_verification",
        verification_token: rpcData.verification_token,
        instructions: `Run '/verify ${rpcData.verification_token}' on the CPB server or provide this code to a judicial clerk to complete verification.`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
