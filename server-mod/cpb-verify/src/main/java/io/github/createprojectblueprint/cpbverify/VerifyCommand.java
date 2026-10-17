package io.github.createprojectblueprint.cpbverify;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.logging.LogUtils;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.slf4j.Logger;

/**
 * /verify <code> — confirms a CPB-XXXXXXXX code from the judiciary website by
 * sending this player's real UUID and name to the verify-minecraft function.
 */
public final class VerifyCommand {
    private static final Logger LOGGER = LogUtils.getLogger();
    private static final Pattern CODE_PATTERN = Pattern.compile("^CPB-[0-9A-F]{8}$");
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private static final Map<UUID, Long> LAST_ATTEMPT = new ConcurrentHashMap<>();

    private VerifyCommand() {}

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("verify")
                .then(Commands.argument("code", StringArgumentType.word())
                        .executes(VerifyCommand::run)));
    }

    private static int run(CommandContext<CommandSourceStack> ctx) throws CommandSyntaxException {
        ServerPlayer player = ctx.getSource().getPlayerOrException();
        String code = StringArgumentType.getString(ctx, "code").trim().toUpperCase();

        if (!CODE_PATTERN.matcher(code).matches()) {
            player.sendSystemMessage(error("That doesn't look like a verification code. It should look like CPB-1A2B3C4D."));
            return 0;
        }

        String secret = Config.SERVER_SECRET.get();
        if (secret.isBlank()) {
            LOGGER.warn("[cpbverify] serverSecret is not set in config/cpbverify-common.toml; /verify is disabled.");
            player.sendSystemMessage(error("Verification isn't set up on this server yet. Please tell an admin."));
            return 0;
        }

        long now = System.currentTimeMillis();
        long cooldownMs = Config.COOLDOWN_SECONDS.get() * 1000L;
        Long last = LAST_ATTEMPT.get(player.getUUID());
        if (last != null && now - last < cooldownMs) {
            long wait = (cooldownMs - (now - last) + 999) / 1000;
            player.sendSystemMessage(error("Please wait " + wait + "s before trying again."));
            return 0;
        }
        LAST_ATTEMPT.put(player.getUUID(), now);

        JsonObject body = new JsonObject();
        body.addProperty("action", "confirm_ingame");
        body.addProperty("verification_token", code);
        body.addProperty("in_game_uuid", player.getUUID().toString());
        body.addProperty("in_game_username", player.getGameProfile().getName());

        HttpRequest request = HttpRequest.newBuilder(URI.create(Config.ENDPOINT_URL.get()))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("x-server-secret", secret)
                .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                .build();

        player.sendSystemMessage(Component.literal("Checking your code...").withStyle(ChatFormatting.GRAY));

        MinecraftServer server = player.getServer();
        UUID playerId = player.getUUID();
        HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .whenComplete((response, failure) -> {
                    Component message = failure != null
                            ? networkError(failure)
                            : resultMessage(response.statusCode(), response.body());
                    // Chat must be sent from the server thread; the player may have logged off meanwhile
                    server.execute(() -> {
                        ServerPlayer online = server.getPlayerList().getPlayer(playerId);
                        if (online != null) {
                            online.sendSystemMessage(message);
                        }
                    });
                });

        return 1;
    }

    private static Component resultMessage(int status, String responseBody) {
        if (status == 200) {
            return Component.literal("Your Minecraft account is now linked to the CPB Judiciary. Reload the website to see it.")
                    .withStyle(ChatFormatting.GREEN);
        }
        String detail = switch (status) {
            case 404 -> "That code is wrong or has expired. Request a new one on the website.";
            case 400 -> "That code was requested for a different Minecraft account.";
            case 409 -> "This Minecraft account is already linked to another CPB profile.";
            case 401 -> {
                LOGGER.error("[cpbverify] Server secret rejected by verify-minecraft. Check serverSecret matches MINECRAFT_SERVER_WEBHOOK_SECRET.");
                yield "Verification isn't set up correctly on this server. Please tell an admin.";
            }
            default -> {
                LOGGER.error("[cpbverify] verify-minecraft returned HTTP {}: {}", status, errorField(responseBody));
                yield "Something went wrong verifying your code. Please try again later.";
            }
        };
        return error(detail);
    }

    private static Component networkError(Throwable failure) {
        LOGGER.error("[cpbverify] Could not reach verify-minecraft", failure);
        return error("Couldn't reach the CPB Judiciary website. Please try again later.");
    }

    private static String errorField(String responseBody) {
        try {
            JsonObject json = JsonParser.parseString(responseBody).getAsJsonObject();
            return json.has("error") ? json.get("error").getAsString() : responseBody;
        } catch (RuntimeException e) {
            return responseBody;
        }
    }

    private static Component error(String text) {
        return Component.literal(text).withStyle(ChatFormatting.RED);
    }
}
