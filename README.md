# Project Setup Guide

This project consists of a Discord Bot (Cloudflare Worker) and a Submission Website (Cloudflare Pages).

## 1. D1 Database Setup
Create a D1 database in your Cloudflare dashboard:
```bash
npx wrangler d1 create stories-db
```
Apply the schema:
```bash
npx wrangler d1 execute stories-db --file=schema.sql
```

## 2. Discord Bot Setup
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a new application.
3. Under **Bot**, get your token.
4. Under **General Information**, get your Application ID and Public Key.
5. In `discord-bot/wrangler.toml`, update `database_id` with your D1 ID.
6. Set the following secrets in Cloudflare:
   ```bash
   npx wrangler secret put DISCORD_TOKEN
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_APPLICATION_ID
   ```
7. Register the slash commands:
   ```bash
   cd discord-bot
   DISCORD_APPLICATION_ID=your_id DISCORD_TOKEN=your_token node src/register.js
   ```
8. Deploy the bot:
   ```bash
   cd discord-bot
   npx wrangler deploy
   ```

## 3. Submission Website Setup
1. Deploy the `submission-site` folder to Cloudflare Pages.
2. In the Pages settings, bind the same D1 database (`DB`) to your project.
3. Set the `DISCORD_TOKEN` environment variable in the Pages dashboard.
4. Deploy:
   ```bash
   cd submission-site
   npx wrangler pages deploy public
   ```

## 4. Usage
1. Invite the bot to your server with `applications.commands` and `bot` (Send Messages) scopes.
2. Run `/setup-catalog` in the channel where you want the story list to appear.
3. Submit stories through the website; the catalog will update automatically!
