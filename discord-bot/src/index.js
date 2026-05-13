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
  const followUpUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

  try {
    // 1. Fetch Story
    const story = await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(storyId).first();
    if (!story) {
      await fetch(followUpUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Story not found.' })
      });
      return;
    }

    // 2. Clean Text (Rid all emoticons, keep punctuation, math, currency)
    const cleanContent = story.content
      .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Z}\p{Sm}\p{Sc}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanContent) {
      await fetch(followUpUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'The story content is empty or contains only emoticons, so there is nothing to narrate!' })
      });
      return;
    }

    if (cleanContent.length > 20000) {
       await fetch(followUpUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'This story is exceptionally long (over 20,000 characters)! Please use the Read button instead.' })
      });
      return;
    }

    // 3. Generate Audio (Chunked to handle limits)
    if (!env.AI) {
      throw new Error("AI binding not found. Ensure '[ai] binding = \"AI\"' is in wrangler.toml and deployed.");
    }

    const chunks = [];
    const chunkSize = 1500; // Aim for 1500 chars
    let remaining = cleanContent;

    while (remaining.length > 0) {
      if (remaining.length <= chunkSize) {
        chunks.push(remaining);
        break;
      }

      // Find the last space within the chunk size
      let index = remaining.lastIndexOf(' ', chunkSize);
      if (index === -1) index = chunkSize; // No space found, fallback to hard cut

      chunks.push(remaining.substring(0, index).trim());
      remaining = remaining.substring(index).trim();
    }

    const audioPromises = chunks.map(chunk =>
      env.AI.run('@cf/deepgram/aura-2-en', {
        text: chunk,
        speaker: 'orion',
        encoding: 'mp3'
      }, {
        returnRawResponse: true
      }).then(async res => {
        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`AI Service Error: ${res.status} - ${errorText}`);
        }
        return res.arrayBuffer();
      })
    );

    const audioBuffers = await Promise.all(audioPromises);
    const audioParts = audioBuffers.map(part => new Uint8Array(part));

    // Concatenate all audio parts
    const totalLength = audioParts.reduce((acc, val) => acc + val.length, 0);
    const audioBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of audioParts) {
      audioBuffer.set(part, offset);
      offset += part.length;
    }

    // 4. Send as Follow-up with FormData (PATCH original message)
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({
      content: `Here is your audio for **${story.title}** by ${story.author}:`
    }));
    formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), `${story.title.replace(/\s+/g, '_')}.mp3`);

    await fetch(followUpUrl, {
      method: 'PATCH',
      body: formData
    });

  } catch (err) {
    console.error(err);
    try {
      await fetch(followUpUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `Failed to generate audio: ${err.message}` })
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
