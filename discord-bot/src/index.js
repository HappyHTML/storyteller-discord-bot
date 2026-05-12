import {
  InteractionType,
  InteractionResponseType,
  InteractionContextType,
  verifyKey,
} from 'discord-interactions';

export default {
  async fetch(request, env) {
    if (request.method === 'POST') {
      const signature = request.headers.get('x-signature-ed25519');
      const timestamp = request.headers.get('x-signature-timestamp');

      if (!signature || !timestamp) {
        return new Response('Missing signature headers', { status: 401 });
      }

      const body = await request.text();
      const isValidRequest = verifyKey(
        body,
        signature,
        timestamp,
        env.DISCORD_PUBLIC_KEY
      );

      if (!isValidRequest) {
        console.error('Invalid request signature');
        return new Response('Bad request signature.', { status: 401 });
      }

      const interaction = JSON.parse(body);
      console.log('Received Interaction Type:', interaction.type);

      if (interaction.type === InteractionType.PING) {
        console.log('Responding to PING with PONG');
        return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        if (interaction.data.name === 'setup-catalog') {
          if (!interaction.member) {
            return new Response(
              JSON.stringify({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: { content: 'This command can only be used in a server.', flags: 64 },
              }),
              { headers: { 'content-type': 'application/json' } }
            );
          }
          // Check for admin permissions (Manage Guild or Administrator)
          const permissions = BigInt(interaction.member.permissions);
          const ADMINISTRATOR = 1n << 3n;
          if (!(permissions & ADMINISTRATOR)) {
            return new Response(
              JSON.stringify({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: { content: 'Only administrators can use this command.', flags: 64 },
              }),
              { headers: { 'content-type': 'application/json' } }
            );
          }

          return await handleSetupCatalog(interaction, env);
        }
      }

      if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
        const customId = interaction.data.custom_id;
        if (customId.startsWith('catalog_')) {
          return await handlePagination(interaction, env);
        }
        if (customId === 'read_story_btn') {
          return new Response(
            JSON.stringify({
              type: InteractionResponseType.MODAL,
              data: {
                custom_id: 'read_story_modal',
                title: 'Read a Story',
                components: [
                  {
                    type: 1,
                    components: [
                      {
                        type: 4,
                        custom_id: 'story_id_input',
                        label: 'Enter Story ID Number',
                        style: 1,
                        min_length: 1,
                        placeholder: 'e.g. 1',
                        required: true,
                      },
                    ],
                  },
                ],
              },
            }),
            { headers: { 'content-type': 'application/json' } }
          );
        }
      }

      if (interaction.type === InteractionType.MODAL_SUBMIT) {
        if (interaction.data.custom_id === 'read_story_modal') {
          const storyId = interaction.data.components[0].components[0].value;
          return await handleReadStory(storyId, env);
        }
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

async function handleSetupCatalog(interaction, env) {
  const channelId = interaction.channel_id;

  // Initial embed
  const { embed, components } = await createCatalogPage(1, env);

  // We need to send the message first, then store its ID.
  // But wait, if we respond to the interaction, we get a message.
  // However, it's easier to send a follow-up or just use the interaction response if we can get the message ID.
  // Actually, for "main embed", we might want it to be a persistent message.

  // Respond to interaction
  const response = {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [embed],
      components: components
    }
  };

  // After responding, we need the message ID.
  // For interaction responses, we can use the interaction token to get the original message.
  // Or we can just send a message via REST API if we want more control.

  // Let's try responding directly and then use a separate mechanism to track the message ID.
  // Actually, Discord doesn't return the message object in the interaction response.
  // We'll have to use the webhooks API to get the message after sending it.

  // BUT, to update it later from the website, we ABSOLUTELY need the message ID.

  // Alternative: Send via REST API to the channel.
  const msgResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      embeds: [embed],
      components: components
    })
  });

  const msgData = await msgResponse.json();
  if (msgResponse.ok) {
    await env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?), (?, ?)')
      .bind('catalog_channel_id', channelId, 'catalog_message_id', msgData.id)
      .run();

    return new Response(
      JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Catalog initialized successfully!', flags: 64 },
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  } else {
    return new Response(
      JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Failed to initialize catalog: ' + JSON.stringify(msgData), flags: 64 },
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  }
}

async function handlePagination(interaction, env) {
  const customId = interaction.data.custom_id;
  const page = parseInt(customId.split('_')[1]);

  const { embed, components } = await createCatalogPage(page, env);

  return new Response(
    JSON.stringify({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        embeds: [embed],
        components: components
      }
    }),
    { headers: { 'content-type': 'application/json' } }
  );
}

async function handleReadStory(storyId, env) {
  const story = await env.DB.prepare('SELECT * FROM stories WHERE id = ?')
    .bind(storyId)
    .first();

  if (!story) {
    return new Response(
      JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `Story with ID ${storyId} not found.`, flags: 64 },
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [{
          title: story.title,
          author: { name: story.author },
          description: story.content,
          footer: { text: `ID: ${story.id}` },
          timestamp: story.created_at
        }],
        flags: 64
      }
    }),
    { headers: { 'content-type': 'application/json' } }
  );
}

async function createCatalogPage(page, env) {
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  const stories = await env.DB.prepare('SELECT id, title, author FROM stories ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(pageSize, offset)
    .all();

  const totalStories = await env.DB.prepare('SELECT COUNT(*) as count FROM stories').first('count');
  const totalPages = Math.ceil(totalStories / pageSize) || 1;

  let description = stories.results.length > 0
    ? stories.results.map(s => `**#${s.id}** - ${s.title} by ${s.author}`).join('\n')
    : 'No stories found.';

  const embed = {
    title: 'Story Catalog',
    description: description,
    color: 0x00ff00,
    footer: { text: `Page ${page} of ${totalPages}` }
  };

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          label: 'Previous',
          style: 1,
          custom_id: `catalog_${Math.max(1, page - 1)}`,
          disabled: page <= 1
        },
        {
          type: 2,
          label: 'Next',
          style: 1,
          custom_id: `catalog_${Math.min(totalPages, page + 1)}`,
          disabled: page >= totalPages
        },
        {
          type: 2,
          label: 'Read Story',
          style: 3,
          custom_id: 'read_story_btn'
        }
      ]
    }
  ];

  return { embed, components };
}

// Export for use in website update logic if needed
export { createCatalogPage };
