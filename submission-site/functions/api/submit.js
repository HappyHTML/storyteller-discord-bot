export async function onRequestPost(context) {
  const { request, env } = context;
  console.log('Submit API called');

  try {
    const { title, author, content } = await request.json();

    if (!title || !author || !content) {
      return new Response(JSON.stringify({ error: 'Title, Author, and Content are required.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (title.length > 100 || author.length > 100) {
      return new Response(JSON.stringify({ error: 'Title and Author must be 100 characters or less.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (content.length > 4000) {
      return new Response(JSON.stringify({ error: 'Story content must be 4000 characters or less.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (!env.DB) {
      console.error('D1 DB binding missing');
      throw new Error('Database binding not found. Please check your Pages settings.');
    }

    // 1. Insert into D1 and ensure no gaps
    console.log('Re-indexing and inserting into D1...');
    await env.DB.batch([
      // Re-index existing to close any gaps
      env.DB.prepare('UPDATE stories SET id = id + 1000000'),
      env.DB.prepare('UPDATE stories SET id = (SELECT COUNT(*) FROM stories s2 WHERE s2.id <= stories.id)'),
      // Insert new story
      env.DB.prepare('INSERT INTO stories (title, author, content) VALUES (?, ?, ?)').bind(title, author, content),
      // Final re-index to ensure the new one is also correctly numbered and seq is reset
      env.DB.prepare('UPDATE stories SET id = id + 1000000'),
      env.DB.prepare('UPDATE stories SET id = (SELECT COUNT(*) FROM stories s2 WHERE s2.id <= stories.id)'),
      env.DB.prepare("UPDATE sqlite_sequence SET seq = (SELECT COUNT(*) FROM stories) WHERE name = 'stories'")
    ]);
    console.log('Insert and re-index successful');

    // 2. Get Catalog Config
    const configResults = await env.DB.prepare('SELECT key, value FROM config WHERE key IN (?, ?)')
      .bind('catalog_channel_id', 'catalog_message_id')
      .all();

    const config = {};
    configResults.results.forEach(row => {
      config[row.key] = row.value;
    });

    if (config.catalog_channel_id && config.catalog_message_id) {
      console.log('Found Discord catalog config, triggering background update...');
      const updatePromise = (async () => {
        try {
          const { embed, components } = await createCatalogPage(1, env);
          console.log(`Patching Discord message ${config.catalog_message_id} in channel ${config.catalog_channel_id}`);
          const dRes = await fetch(`https://discord.com/api/v10/channels/${config.catalog_channel_id}/messages/${config.catalog_message_id}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bot ${env.DISCORD_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              embeds: [embed],
              components: components
            })
          });
          console.log(`Discord PATCH response: ${dRes.status}`);
          if (!dRes.ok) console.error(await dRes.text());
        } catch (discordErr) {
          console.error('Discord update failed:', discordErr);
        }
      })();

      if (context.waitUntil) {
        context.waitUntil(updatePromise);
      }
    }

    return new Response(JSON.stringify({ message: 'Story submitted successfully and catalog updated!' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    console.error('Submit API error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
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
