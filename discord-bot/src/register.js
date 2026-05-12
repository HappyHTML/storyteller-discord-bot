import fetch from 'node-fetch';

const appId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const token = process.env.DISCORD_TOKEN;

if (!appId || !token) {
  console.error('Missing DISCORD_APPLICATION_ID or DISCORD_TOKEN');
  process.exit(1);
}

const commands = [
  {
    name: 'setup-catalog',
    description: 'Initializes the story catalog embed in the current channel',
    type: 1, // CHAT_INPUT
    default_member_permissions: "8" // Administrator
  },
];

async function registerCommands() {
  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (response.ok) {
    console.log('Successfully registered commands');
  } else {
    const error = await response.json();
    console.error('Error registering commands:', error);
  }
}

registerCommands();
