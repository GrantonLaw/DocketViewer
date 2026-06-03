export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (!url.searchParams.get('type')) {
    return context.next();
  }
  const workerUrl = context.env.WORKER_URL + url.search;
  return fetch(workerUrl, context.request);
}
