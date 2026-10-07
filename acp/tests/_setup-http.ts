// For E2E files that spawn their own server against their own isolated state dir: confirm every
// agent through the wizard API, the way a user would.
//
// issue #7 made "detected" insufficient — nothing is routable until it is confirmed — so a test
// that dispatches a prompt has to establish that precondition. Doing it through POST /api/setup
// (rather than poking the config file) also exercises the endpoint the wizard uses.
export async function confirmAllViaHttp(base: string): Promise<string[]> {
  const view = (await (await fetch(`${base}/api/setup`)).json()) as any;
  const agents: Record<string, { confirm: boolean }> = {};
  for (const c of view.candidates ?? []) agents[c.id] = { confirm: true };
  const r = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agents }),
  });
  if (!r.ok) throw new Error(`confirmAllViaHttp failed: ${r.status} ${await r.text()}`);
  return Object.keys(agents);
}
