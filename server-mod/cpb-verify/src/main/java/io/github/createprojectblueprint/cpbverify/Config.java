package io.github.createprojectblueprint.cpbverify;

import net.neoforged.neoforge.common.ModConfigSpec;

// Registered as a COMMON config (config/cpbverify-common.toml). Unlike SERVER
// configs, COMMON configs are never synced to clients, so the secret stays on
// the server.
public class Config {
    private static final ModConfigSpec.Builder BUILDER = new ModConfigSpec.Builder();

    public static final ModConfigSpec.ConfigValue<String> ENDPOINT_URL = BUILDER
            .comment("URL of the verify-minecraft Supabase Edge Function")
            .define("endpointUrl", "https://cxwhmzfpdwwpdjogtuwq.supabase.co/functions/v1/verify-minecraft");

    public static final ModConfigSpec.ConfigValue<String> SERVER_SECRET = BUILDER
            .comment("Must match the MINECRAFT_SERVER_WEBHOOK_SECRET Supabase secret. Keep this private.")
            .define("serverSecret", "");

    public static final ModConfigSpec.IntValue COOLDOWN_SECONDS = BUILDER
            .comment("Seconds a player must wait between /verify attempts")
            .defineInRange("cooldownSeconds", 10, 0, 3600);

    static final ModConfigSpec SPEC = BUILDER.build();
}
