export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get('Authorization');

  if (auth !== env.ADMIN_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id, title, author, content } = await request.json();

  if (!id || !title || !author || !content) {
    return new Response('Missing fields', { status: 400 });
  }

  await env.DB.prepare('UPDATE stories SET title = ?, author = ?, content = ? WHERE id = ?')
    .bind(title, author, content, id)
    .run();

  // Update Discord Catalog immediately after edit
  const configResults = await env.DB.prepare('SELECT key, value FROM config WHERE key IN (?, ?)')
    .bind('catalog_channel_id', 'catalog_message_id')
    .all();

  const config = {};
  configResults.results.forEach(row => { config[row.key] = row.value; });

  if (config.catalog_channel_id && config.catalog_message_id) {
    const { embed, components } = await createCatalogPage(1, env);
    await fetch(`https://discord.com/api/v10/channels/${config.catalog_channel_id}/messages/${config.catalog_message_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${env.DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed], components: components })
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'content-type': 'application/json' },
  });
}

async function createCatalogPage(page, env) {
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  const stories = await env.DB.prepare('SELECT id, title, author FROM stories ORDER BY id DESC LIMIT ? OFFSET ?').bind(pageSize, offset).all();
  const totalRes = await env.DB.prepare('SELECT COUNT(*) as count FROM stories').first();
  const total = totalRes ? totalRes.count : 0;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const description = (stories && stories.results && stories.results.length > 0)
    ? stories.results.map(s => `**#${s.id}** - ${s.title} by ${s.author}`).join('\n') : 'No stories found.';
  return {
    embed: { title: 'Story Catalog', description, color: 0x00ff00, footer: { text: `Page ${page} of ${totalPages}` } },
    components: [{
      type: 1,
      components: [
        { type: 2, label: 'Previous', style: 1, custom_id: `catalog_prev_${Math.max(1, page - 1)}`, disabled: page <= 1 },
        { type: 2, label: 'Next', style: 1, custom_id: `catalog_next_${Math.min(totalPages, page + 1)}`, disabled: page >= totalPages },
        { type: 2, label: 'Read Story', style: 3, custom_id: 'read_story_btn' }
      ]
    }]
  };
}
