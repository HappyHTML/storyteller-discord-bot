import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET') {
        return new Response('Storyteller Discord Bot is online.', { status: 200 });
      }

      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // Support both root and /interactions path
      if (url.pathname !== '/' && url.pathname !== '/interactions') {
        return new Response('Not Found', { status: 404 });
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
        if (interaction.data.name === 'catalog') {
          const { embed, components } = await createCatalogPage(1, env);
          return new Response(JSON.stringify({
            type: 4,
            data: { embeds: [embed], components: components }
          }), { headers: { 'content-type': 'application/json' } });
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
          ctx.waitUntil(handleReadStory(interaction, storyId, env));
          return new Response(JSON.stringify({ type: 5, data: { flags: 64 } }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (interaction.data.custom_id === 'listen_story_modal') {
          const storyId = interaction.data.components[0].components[0].value;
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

async function handleReadStory(interaction, storyId, env) {
  const followUpUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;

  try {
    const story = await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(storyId).first();
    if (!story) {
      await fetch(`${followUpUrl}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Story not found.' })
      });
      return;
    }

    const embeds = [];
    const maxEmbedSize = 4000;
    let remaining = story.content;

    while (remaining.length > 0) {
      let chunk;
      if (remaining.length <= maxEmbedSize) {
        chunk = remaining;
        remaining = '';
      } else {
        let index = remaining.lastIndexOf(' ', maxEmbedSize);
        if (index === -1) index = maxEmbedSize;
        chunk = remaining.substring(0, index).trim();
        remaining = remaining.substring(index).trim();
      }

      embeds.push({
        description: chunk
      });
    }

    // Apply header/footer only to the bounds
    if (embeds.length > 0) {
      embeds[0].title = story.title;
      embeds[0].author = { name: story.author };
      embeds[embeds.length - 1].footer = { text: `ID: ${story.id}` };
    }

    const messages = [];
    let currentBatch = [];
    let currentTotalLength = 0;

    for (const embed of embeds) {
      if (currentBatch.length >= 10 || (currentTotalLength + embed.description.length) > 5800) {
        messages.push(currentBatch);
        currentBatch = [];
        currentTotalLength = 0;
      }
      currentBatch.push(embed);
      currentTotalLength += embed.description.length;
    }
    if (currentBatch.length > 0) messages.push(currentBatch);

    await fetch(`${followUpUrl}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: messages[0] })
    });

    for (let i = 1; i < messages.length; i++) {
      await fetch(followUpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: messages[i] })
      });
    }

  } catch (err) {
    console.error(err);
    await fetch(`${followUpUrl}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `Error: ${err.message}` })
    });
  }
}

async function handleListenStory(interaction, storyId, env) {
  const followUpUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

  try {
    const story = await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(storyId).first();
    if (!story) {
      await fetch(followUpUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Story not found.' })
      });
      return;
    }

    const cleanContent = story.content
      .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Z}\p{Sm}\p{Sc}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanContent) {
      await fetch(followUpUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Nothing to narrate after cleaning.' })
      });
      return;
    }

    const chunks = [];
    const maxChunkSize = 1000; // Google API limit for long text
    let remaining = cleanContent;

    while (remaining.length > 0) {
      if (remaining.length <= maxChunkSize) {
        chunks.push(remaining);
        break;
      }
      let index = remaining.lastIndexOf(' ', maxChunkSize);
      if (index === -1) index = maxChunkSize;
      chunks.push(remaining.substring(0, index).trim());
      remaining = remaining.substring(index).trim();
    }

    // Using the more stable translate.googleapis.com endpoint
    // Filter out any accidentally empty chunks
    const validChunks = chunks.filter(c => c.length > 0);

    const audioPromises = validChunks.map(chunk =>
      fetch(`https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=en&client=gtx`, {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      })
        .then(async res => {
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`TTS Error ${res.status}: ${errText.substring(0, 100)}`);
          }
          return res.arrayBuffer();
        })
    );

    const audioBuffers = await Promise.all(audioPromises);
    const audioParts = audioBuffers.map(part => new Uint8Array(part));
    const totalLength = audioParts.reduce((acc, val) => acc + val.length, 0);
    const audioBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of audioParts) {
      audioBuffer.set(part, offset);
      offset += part.length;
    }

    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({
      content: `Audio for **${story.title}**:`
    }));
    formData.append('files[0]', new Blob([audioBuffer], { type: 'audio/mpeg' }), `${story.title.replace(/[^\w.-]/g, '_')}.mp3`);

    await fetch(followUpUrl, { method: 'PATCH', body: formData });

  } catch (err) {
    console.error(err);
    await fetch(followUpUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `TTS Failed: ${err.message}` })
    });
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
