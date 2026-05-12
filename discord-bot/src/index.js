import { verifyKey } from 'discord-interactions';

export default {
  async fetch(request, env) {
    try {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const signature = request.headers.get('x-signature-ed25519');
      const timestamp = request.headers.get('x-signature-timestamp');
      const body = await request.text();

      if (!signature || !timestamp || !body) {
        return new Response('Missing required fields', { status: 401 });
      }

      const isValidRequest = verifyKey(
        body,
        signature,
        timestamp,
        (env.DISCORD_PUBLIC_KEY || '').trim()
      );

      if (!isValidRequest) {
        console.error('Invalid request signature');
        return new Response('Bad request signature.', { status: 401 });
      }

      const interaction = JSON.parse(body);

      // Handle PING
      if (interaction.type === 1) {
        return new Response('{"type":1}', {
          headers: { 'content-type': 'application/json' },
        });
      }

      // Handle Slash Commands
      if (interaction.type === 2) {
        if (interaction.data.name === 'setup-catalog') {
          return await handleSetupCatalog(interaction, env);
        }
      }

      // Handle Components
      if (interaction.type === 3) {
        const customId = interaction.data.custom_id;
        if (customId.startsWith('catalog_')) {
          return await handlePagination(interaction, env);
        }
        if (customId === 'read_story_btn') {
          return new Response(JSON.stringify({
            type: 9, // MODAL
            data: {
              custom_id: 'read_story_modal',
              title: 'Read a Story',
              components: [{
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'story_id_input',
                  label: 'Enter Story ID Number',
                  style: 1,
                  min_length: 1,
                  placeholder: 'e.g. 1',
                  required: true,
                }]
              }]
            }
          }), { headers: { 'content-type': 'application/json' } });
        }
      }

      // Handle Modal Submit
      if (interaction.type === 5) {
        if (interaction.data.custom_id === 'read_story_modal') {
          const storyId = interaction.data.components[0].components[0].value;
          return await handleReadStory(storyId, env);
        }
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    }
  },
};

async function handleSetupCatalog(interaction, env) {
  if (!interaction.member) {
    return new Response(JSON.stringify({
      type: 4,
      data: { content: 'This command must be used in a server.', flags: 64 }
    }), { headers: { 'content-type': 'application/json' } });
  }

  const permissions = BigInt(interaction.member.permissions);
  const ADMINISTRATOR = 1n << 3n;
  if (!(permissions & ADMINISTRATOR)) {
    return new Response(JSON.stringify({
      type: 4,
      data: { content: 'Only administrators can use this command.', flags: 64 }
    }), { headers: { 'content-type': 'application/json' } });
  }

  const channelId = interaction.channel_id;
  const { embed, components } = await createCatalogPage(1, env);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
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

  const data = await res.json();
  if (res.ok) {
    await env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?), (?, ?)')
      .bind('catalog_channel_id', channelId, 'catalog_message_id', data.id)
      .run();

    return new Response(JSON.stringify({
      type: 4,
      data: { content: 'Catalog initialized successfully!', flags: 64 },
    }), { headers: { 'content-type': 'application/json' } });
  } else {
    return new Response(JSON.stringify({
      type: 4,
      data: { content: 'Failed to initialize catalog: ' + (data.message || 'Unknown error'), flags: 64 },
    }), { headers: { 'content-type': 'application/json' } });
  }
}

async function handlePagination(interaction, env) {
  const page = parseInt(interaction.data.custom_id.split('_')[1]);
  const { embed, components } = await createCatalogPage(page, env);

  return new Response(JSON.stringify({
    type: 7, // UPDATE_MESSAGE
    data: {
      embeds: [embed],
      components: components
    }
  }), { headers: { 'content-type': 'application/json' } });
}

async function handleReadStory(storyId, env) {
  const story = await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(storyId).first();

  if (!story) {
    return new Response(JSON.stringify({
      type: 4,
      data: { content: `Story with ID ${storyId} not found.`, flags: 64 },
    }), { headers: { 'content-type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    type: 4,
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
  }), { headers: { 'content-type': 'application/json' } });
}

async function createCatalogPage(page, env) {
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  const stories = await env.DB.prepare('SELECT id, title, author FROM stories ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(pageSize, offset)
    .all();

  const totalRes = await env.DB.prepare('SELECT COUNT(*) as count FROM stories').first();
  const total = totalRes ? totalRes.count : 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  const description = (stories && stories.results && stories.results.length > 0)
    ? stories.results.map(s => `**#${s.id}** - ${s.title} by ${s.author}`).join('\n')
    : 'No stories found.';

  return {
    embed: {
      title: 'Story Catalog',
      description: description,
      color: 0x00ff00,
      footer: { text: `Page ${page} of ${totalPages}` }
    },
    components: [{
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
    }]
  };
}

export { createCatalogPage };
