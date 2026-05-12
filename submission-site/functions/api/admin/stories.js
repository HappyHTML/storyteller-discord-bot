export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = request.headers.get('Authorization');

  if (auth !== env.ADMIN_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stories = await env.DB.prepare('SELECT * FROM stories ORDER BY id DESC').all();
  return new Response(JSON.stringify(stories.results), {
    headers: { 'content-type': 'application/json' },
  });
}
