# CPB Judiciary Verify (NeoForge 1.21.1, server-only)

Adds `/verify <code>` so players can link their Minecraft account to the CPB Federal Judiciary website. The server sends the player's real UUID and name, plus a shared secret, to the `verify-minecraft` Supabase Edge Function.

Install it on the **server only**. Clients don't need it and can join without it.

## Setup

1. Set the shared secret on Supabase (pick a long random value):
   ```
   npx supabase secrets set MINECRAFT_SERVER_WEBHOOK_SECRET=<long random value>
   ```
2. Copy `build/libs/cpbverify-1.0.0.jar` into the server's `mods/` folder and start the server once.
3. Edit `config/cpbverify-common.toml` and set `serverSecret` to the same value. Restart the server.

The secret lives in a COMMON config, which NeoForge never syncs to clients. Don't put it in a modpack you distribute.

## Player flow

1. On the judiciary website: sign in, enter their Minecraft name, and get a code like `CPB-1A2B3C4D` (valid for 2 hours).
2. In-game: `/verify CPB-1A2B3C4D`.

The server must run in **online mode**. Offline-mode UUIDs don't match the Mojang UUID the website looked up, so verification fails.

## Build

```
./gradlew build
```
Requires internet on first build (downloads Gradle, Java 21 and NeoForge). `./gradlew runServer` starts a local test server in `run/`.
