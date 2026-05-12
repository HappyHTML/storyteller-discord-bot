import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const signature = request.headers.get('x-signature-ed25519');
      const timestamp = request.headers.get('x-signature-timestamp');
      const body = await request.text();

      if (!signature || !timestamp || !body) {
        return new Response('Unauthorized', { status: 401 });
      }

      const isValidRequest = await verifyKey(
        body,
        signature,
        timestamp,
        env.DISCORD_PUBLIC_KEY ? env.DISCORD_PUBLIC_KEY.trim() : ''
      );

      if (!isValidRequest) {
        return new Response('Invalid request signature', { status: 401 });
      }

      const interaction = JSON.parse(body);

      if (interaction.type === 1) { // PING
        return new Response(JSON.stringify({ type: 1 }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      if (interaction.type === 2) { // APPLICATION_COMMAND
        if (interaction.data.name === 'setup-catalog') {
          return await handleSetupCatalog(interaction, env);
        }
      }

      if (interaction.type === 3) { // MESSAGE_COMPONENT
        const customId = interaction.data.custom_id;
        if (customId.startsWith('catalog_prev_') || customId.startsWith('catalog_next_')) {
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
        if (customId === 'listen_story_btn') {
          return new Response(JSON.stringify({
            type: 9, // MODAL
            data: {
              custom_id: 'listen_story_modal',
              title: 'Listen to a Story',
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

      if (interaction.type === 5) { // MODAL_SUBMIT
        if (interaction.data.custom_id === 'read_story_modal') {
          const storyId = interaction.data.components[0].components[0].value;
          return await handleReadStory(storyId, env);
        }
        if (interaction.data.custom_id === 'listen_story_modal') {
          const storyId = interaction.data.components[0].components[0].value;
          // Defer and handle in background
          ctx.waitUntil(handleListenStory(interaction, storyId, env));
          return new Response(JSON.stringify({ type: 5, data: { flags: 64 } }), {
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
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
      data: { content: 'Server only.', flags: 64 }
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
    body: JSON.stringify({ embeds: [embed], components: components })
  });

  const data = await res.json();
  if (res.ok) {
    await env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?), (?, ?)')
      .bind('catalog_channel_id', channelId, 'catalog_message_id', data.id)
      .run();
    return new Response(JSON.stringify({ type: 4, data: { content: 'Catalog set!', flags: 64 } }), {
      headers: { 'content-type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ type: 4, data: { content: 'Error: ' + JSON.stringify(data), flags: 64 } }), {
    headers: { 'content-type': 'application/json' }
  });
}

async function handlePagination(interaction, env) {
  const customId = interaction.data.custom_id;
  const page = parseInt(customId.split('_').pop());
  const { embed, components } = await createCatalogPage(page, env);
  return new Response(JSON.stringify({
    type: 7,
    data: { embeds: [embed], components: components }
  }), { headers: { 'content-type': 'application/json' } });
}

async function handleReadStory(storyId, env) {
  const story = await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(storyId).first();
  if (!story) {
    return new Response(JSON.stringify({ type: 4, data: { content: 'Not found.', flags: 64 } }), {
      headers: { 'content-type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({
    type: 4,
    data: {
      embeds: [{
        title: story.title,
        author: { name: story.author },
        description: story.content,
        footer: { text: `ID: ${story.id}` }
      }],
      flags: 64
    }
  }), { headers: { 'content-type': 'application/json' } });
}

async function handleListenStory(interaction, storyId, env) {
  const followUpUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;

  try {
    // 1. Fetch Story
    const story = await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(storyId).first();
    if (!story) {
      await fetch(followUpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Story not found.' })
      });
      return new Response(null, { status: 204 });
    }

    // 3. Clean Text (Rid all emoticons, keep punctuation, math, currency)
    // We keep: Letters, Marks (accents), Numbers, Punctuation, Separators,
    // Math Symbols, Currency Symbols, and standard whitespace.
    const cleanContent = story.content
      .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Z}\p{Sm}\p{Sc}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanContent.length > 4096) {
       await fetch(followUpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'This story is too long for my voice! Please use the Read button instead.' })
      });
      return new Response(null, { status: 204 });
    }

    // 4. Generate Audio
    const audioArrayBuffer = await env.AI.run('@cf/facebook/mms-tts', {
      text: cleanContent
    });

    // 5. Send as Follow-up with FormData
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({
      content: `Here is your audio for **${story.title}** by ${story.author}:`
    }));
    formData.append('file', new Blob([audioArrayBuffer], { type: 'audio/mpeg' }), `${story.title.replace(/\s+/g, '_')}.mp3`);

    await fetch(followUpUrl, {
      method: 'POST',
      body: formData
    });

  } catch (err) {
    console.error(err);
    try {
      await fetch(followUpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Failed to generate audio. Please try again later.' })
      });
    } catch (e) {}
  }
}

async function createCatalogPage(page, env) {
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  const stories = await env.DB.prepare('SELECT id, title, author FROM stories ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(pageSize, offset).all();
  const totalRes = await env.DB.prepare('SELECT COUNT(*) as count FROM stories').first();
  const total = totalRes ? totalRes.count : 0;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const description = (stories && stories.results && stories.results.length)
    ? stories.results.map(s => `**#${s.id}** - ${s.title} by ${s.author}`).join('\n')
    : 'No stories.';

  return {
    embed: { title: 'Catalog', description, color: 0x00ff00, footer: { text: `Page ${page}/${totalPages}` } },
    components: [{
      type: 1,
      components: [
        { type: 2, label: 'Prev', style: 1, custom_id: `catalog_prev_${Math.max(1, page - 1)}`, disabled: page <= 1 },
        { type: 2, label: 'Next', style: 1, custom_id: `catalog_next_${Math.min(totalPages, page + 1)}`, disabled: page >= totalPages },
        { type: 2, label: 'Read', style: 3, custom_id: 'read_story_btn' },
        { type: 2, label: 'Listen', style: 3, custom_id: 'listen_story_btn' }
      ]
    }]
  };
}

export { createCatalogPage };
