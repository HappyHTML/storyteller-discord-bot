export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get('Authorization');

  if (!auth || auth.trim() !== (env.ADMIN_PASSWORD || "").trim()) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = await request.json();

  if (!id) {
    return new Response('Missing ID', { status: 400 });
  }

  // Delete and then re-index ALL stories to ensure no gaps
  // Use the same subquery logic as submit.js for consistency
  await env.DB.batch([
    env.DB.prepare('DELETE FROM stories WHERE id = ?').bind(id),
    env.DB.prepare('UPDATE stories SET id = id + 1000000'),
    env.DB.prepare('UPDATE stories SET id = (SELECT COUNT(*) FROM (SELECT id FROM stories ORDER BY id ASC) AS s2 WHERE s2.id <= stories.id)'),
    env.DB.prepare("UPDATE sqlite_sequence SET seq = (SELECT COUNT(*) FROM stories) WHERE name = 'stories'")
  ]);

  // Update Discord Catalog
  const configResults = await env.DB.prepare('SELECT key, value FROM config WHERE key IN (?, ?)')
    .bind('catalog_channel_id', 'catalog_message_id')
    .all();

  const config = {};
  configResults.results.forEach(row => { config[row.key] = row.value; });

  if (config.catalog_channel_id && config.catalog_message_id) {
    const updatePromise = (async () => {
      try {
        const { embed, components } = await createCatalogPage(1, env);
        await fetch(`https://discord.com/api/v10/channels/${config.catalog_channel_id}/messages/${config.catalog_message_id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bot ${env.DISCORD_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ embeds: [embed], components: components })
        });
      } catch (e) {
        console.error('Discord update error:', e);
      }
    })();
    if (context.waitUntil) context.waitUntil(updatePromise);
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'content-type': 'application/json' },
  });
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
